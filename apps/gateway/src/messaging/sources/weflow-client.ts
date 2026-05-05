import type { Logger } from "pino";
import type { AppConfig } from "../../config.js";
import type { SseStatusSnapshot, WeFlowMessagesResponse, WeFlowSseMessageEvent } from "../../types.js";
import { isAbortError, sleep } from "../message-utils.js";

/**
 * WeFlowClient 只做两件事：
 * 1. 订阅 SSE，当作“有新消息值得看了”的触发器。
 * 2. 调 /messages 补拉最近消息，把摘要事件变成完整上下文。
 *
 * 它刻意不做聚合、不做 quiet window、不做业务判断。
 * 这些都属于 EventGateway 的职责。
 */
export class WeFlowClient {
  private readonly status: SseStatusSnapshot = {
    connected: false,
    reconnectCount: 0,
  };

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * 这个快照会被 /health 拿去展示当前 SSE 连接状态。
   * 它不影响业务逻辑，只是为了观测性。
   */
  public getStatusSnapshot(): SseStatusSnapshot {
    return { ...this.status };
  }

  /**
   * getMessages 会在 quiet window 到期后被 EventGateway 调用。
   *
   * 也就是说，SSE 只负责“提醒有新消息了”，
   * 真正构造上下文时依赖的是这里返回的完整消息列表。
   */
  public async getMessages(sessionId: string, limit: number): Promise<WeFlowMessagesResponse> {
    const url = new URL(this.config.weflowMessagesPath, this.config.weflowBaseUrl);
    url.searchParams.set("talker", sessionId);
    url.searchParams.set("limit", String(limit));

    const response = await this.fetchWithTimeout(url, {
      headers: this.authHeaders(),
    });

    if (!response.ok) {
      throw new Error(`WeFlow messages request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as WeFlowMessagesResponse;
    if (!payload.success) {
      throw new Error("WeFlow returned success=false for /messages");
    }

    return payload;
  }

  /**
   * streamMessages 是常驻的 SSE 消费循环。
   *
   * EventGateway 启动后，会把一个 onEvent 回调交给这里。
   * 从这个时刻开始，只要 WeFlow 一直有新消息推过来，
   * 它们就会被逐条喂回 EventGateway。
   */
  public async streamMessages(
    onEvent: (event: WeFlowSseMessageEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.consumeSseStream(onEvent, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          break;
        }

        // 这里故意不立即疯狂重连，避免 WeFlow 临时异常时把日志刷爆。
        this.status.connected = false;
        this.status.reconnectCount += 1;
        this.logger.error(
          { err: error, reconnectCount: this.status.reconnectCount },
          "WeFlow SSE 连接失败，稍后会自动重连",
        );
        await sleep(2000);
      }
    }
  }


  private async consumeSseStream(
    onEvent: (event: WeFlowSseMessageEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    // 这里拼出 WeFlow SSE 的完整地址。
    // 例如：http://127.0.0.1:5031/api/v1/push/messages?access_token=xxx
    const url = new URL(this.config.weflowSsePath, this.config.weflowBaseUrl);
    if (this.config.weflowAccessToken) {
      url.searchParams.set("access_token", this.config.weflowAccessToken);
    }

    // 真正发起 HTTP 请求。
    // 虽然这里也是 fetch，但和普通 REST 请求不同：
    // 这个请求一旦成功，response.body 会保持打开状态，持续吐出 SSE 文本流。
    const response = await this.fetchWithTimeout(url, {
      headers: this.authHeaders(),
      signal,
    });

    // SSE 要能真正工作，必须同时满足两个条件：
    // 1. HTTP 状态码是成功的
    // 2. 服务端真的提供了可持续读取的 body 流
    if (!response.ok || !response.body) {
      throw new Error(`WeFlow SSE request failed: ${response.status} ${response.statusText}`);
    }

    // 走到这里说明“连接已经建立成功”，后面进入持续读流阶段。
    this.status.connected = true;

    // TextDecoder 负责把网络字节流转成字符串。
    // SSE 本质是文本协议，所以后面所有解析都建立在字符串之上。
    const decoder = new TextDecoder();

    // buffer：保存“还没处理完的残余文本”。
    // 因为 chunk 边界和换行边界不一定一致，所以经常会出现：
    // - 上一个 chunk 只收到半行
    // - 下一块 chunk 才把这一行补全
    // 这时就需要先临时堆在 buffer 里，等下一块再一起解析。
    let buffer = "";

    // currentEvent：当前正在拼装的 SSE 事件名。
    // 如果服务端这一段文本里出现了 `event: ready`，
    // 那 currentEvent 就会先被设成 "ready"，
    // 直到遇到空行，才会真正完成这一条事件。
    let currentEvent = "message";

    // dataLines：当前这条 SSE 事件累计到的所有 data 行。
    // 按 SSE 协议，一条事件允许出现多行 `data:`，
    // 最终需要把这些 data 行用换行拼起来。
    let dataLines: string[] = [];

    const flushEvent = async (): Promise<void> => {
      // flushEvent 只在“遇到空行”时调用。
      // 在 SSE 协议里，空行表示：前面那条事件已经完整结束，可以开始结算了。
      //
      // 换句话说：
      // - 读取普通行时，我们只是不断把 event/data 暂存起来
      // - 只有遇到空行，才真正知道“一条完整事件收齐了”
      if (dataLines.length === 0) {
        // 如果连一行 data 都没有，说明这次 flush 没有真正拼出业务事件。
        // 这里顺手把 event 名重置成默认值，避免把上一次状态带到下一条事件里。
        currentEvent = "message";
        return;
      }

      // 把同一条 SSE 事件里累计到的多行 data 拼回完整文本。
      const data = dataLines.join("\n");

      // 把当前 event 名暂存出来，随后立刻重置内部状态，
      // 这样下一条事件可以从干净状态重新开始解析。
      const eventName = currentEvent;
      currentEvent = "message";
      dataLines = [];

      if (eventName === "ready") {
        // ready 是 WeFlow SSE 刚连上时发来的握手事件。
        this.status.lastReadyAt = new Date().toISOString();
        this.logger.info({ url: url.toString() }, "已成功连上 WeFlow SSE，正在等待新消息事件");
        return;
      }

      // 当前网关真正关心的业务事件只有 message.new。
      // 其他事件如果未来出现，暂时一律忽略，不往上游传。
      if (eventName !== "message.new") {
        return;
      }

      // WeFlow 的 data 是 JSON 字符串，这里把它反序列化成结构化对象。
      const payload = JSON.parse(data) as WeFlowSseMessageEvent;
      this.status.lastMessageAt = new Date().toISOString();

      // 到这里为止，WeFlowClient 的职责就结束了。
      // 后面这条事件该不该丢、该不该聚合、要不要触发 agent run，
      // 都交回 EventGateway 去决定。
      await onEvent(payload);
    };

    // for await ... of response.body 的意思是：
    // 只要服务端继续往这个长连接里推数据，我们就一直循环读取。
    //
    // 这里每次拿到的 chunk 只是“网络流的一小段”，它可能：
    // - 恰好是一整条事件
    // - 只是半条事件
    // - 甚至只是半行文本
    for await (const chunk of response.body) {
      // 先把当前 chunk 解码成字符串，并拼接到 buffer 后面。
      // { stream: true } 表示这是流式解码，允许跨 chunk 保持解码状态。
      buffer += decoder.decode(chunk, { stream: true });

      // 接下来开始从 buffer 里按“行”解析。
      // 只要还能找到换行符，就说明至少能完整取出一行文本。
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        // 取出当前这一行，并把它从 buffer 里移除。
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        // 兼容 CRLF（Windows 风格换行）。
        // SSE 实际上传过来的行，可能以 \r\n 结束，所以这里要把结尾的 \r 去掉。
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }

        if (line === "") {
          // 空行是 SSE 事件分隔符：表示前面那条事件已经结束。
          await flushEvent();
          continue;
        }

        if (line.startsWith(":")) {
          // 冒号开头的是 SSE 心跳注释，比如 ": ping"。
          continue;
        }

        // SSE 每一行一般长这样：
        // event: message.new
        // data: {"foo":"bar"}
        //
        // 冒号左边是字段名，右边是字段值。
        // 如果没有冒号，也按“只有字段名，没有值”来处理。
        const separatorIndex = line.indexOf(":");
        const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
        const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trimStart() : "";

        if (field === "event") {
          // 记录当前正在组装的事件名，但先不立刻触发处理。
          // 要等后面遇到空行，才能说明整条事件真的结束了。
          currentEvent = value;
        } else if (field === "data") {
          // data 行可能有多行，所以先暂存到数组里，等待 flushEvent 统一合并。
          dataLines.push(value);
        }
      }
    }

    // for-await 循环退出，说明连接已经结束。
    // 这里通常意味着：
    // - WeFlow 主动断开
    // - 网络中断
    // - 或者外部 signal 触发了中止
    //
    // 后续是否重连，不在这里决定，而是在上一层 streamMessages 里统一处理。
    this.status.connected = false;
  }

  private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    // /messages 是短请求，超时后直接失败即可；SSE 自己会在外层循环里重连。
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.weflowTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * WeFlow 所有 /api/v1/* 请求都需要 token。
   * SSE 场景通常通过 query string 带 token，但普通 HTTP 请求这里还是顺手加上 Bearer header。
   */
  private authHeaders(): HeadersInit {
    if (!this.config.weflowAccessToken) {
      return {};
    }

    return {
      Authorization: `Bearer ${this.config.weflowAccessToken}`,
    };
  }
}
