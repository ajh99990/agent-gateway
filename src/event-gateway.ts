import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { AgentRuntimeClient } from "./agent-runtime-client.js";
import { GraphitiClient } from "./graphiti-client.js";
import { RedisStore } from "./redis-store.js";
import { TaskQueue } from "./task-queue.js";
import type {
  AgentRunInput,
  GraphitiWriteBatch,
  HealthSnapshot,
  NormalizedMessage,
  SessionAccumulator,
  TriggerReason,
  WeFlowApiMessage,
  WeFlowMessagesResponse,
  WeFlowSseMessageEvent,
} from "./types.js";
import { WeFlowClient } from "./weflow-client.js";
import {
  chooseTriggerReason,
  createRunId,
  detectMention,
  inferContentType,
  isBotSourceName,
  isGroupSession,
  normalizeCreateTime,
} from "./utils.js";

const MAX_CONTEXT_MESSAGE_CHARS = 100;

/**
 * EventGateway 是整个宿主机侧的调度中枢。
 * 它不做 LLM 推理，只负责把 WeFlow 的实时事件整理成“适合 agent-runtime 判断”的批输入。
 *
 * 可以把它想成 5 个阶段串起来的总控：
 * 1. 收 SSE 事件
 * 2. 先做早期过滤和去重
 * 3. 按群放进 quiet window 聚合
 * 4. quiet window 到期后补拉 /messages
 * 5. 调 agent-runtime，并异步写 Graphiti
 */
export class EventGateway {
  // sessions 是“每个群当前正在积攒的那一小段消息状态”。
  private readonly sessions = new Map<string, SessionAccumulator>();

  // Graphiti 是旁路任务，所以单独走后台队列。
  private readonly graphitiQueue: TaskQueue;
  private readonly abortController = new AbortController();
  private streamPromise?: Promise<void>;
  private readonly startedAt = Date.now();

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly redis: RedisStore,
    private readonly weflowClient: WeFlowClient,
    private readonly agentRuntimeClient: AgentRuntimeClient,
    private readonly graphitiClient: GraphitiClient,
  ) {
    this.graphitiQueue = new TaskQueue(2, logger, "graphiti");
  }

  /**
   * start 会在进程启动时被 main() 调用一次。
   *
   * 它做的事情很少，但都很关键：
   * - 先确认 Redis 可用
   * - 如果启用了 Graphiti，就先把 Graphiti MCP 连好
   * - 然后启动 WeFlow SSE 常驻订阅
   *
   * 从这一刻开始，event-gateway 才算真正进入“监听微信消息”的状态。
   */
  public async start(): Promise<void> {
    // 启动前先探一下 Redis，避免服务看起来起来了，但实际上状态层不可用。
    await this.redis.ping();
    await this.graphitiClient.start();
    this.streamPromise = this.weflowClient.streamMessages(
      async (event) => this.handleIncomingEvent(event),
      this.abortController.signal,
    );
  }

  /**
   * stop 在优雅退出时调用。
   *
   * 顺序上会先中断 SSE，再清定时器，再停掉后台队列。
   * 这样做的目的，是尽量让“新的消息不再进来”，然后把本地状态收干净。
   */
  public async stop(): Promise<void> {
    this.abortController.abort();

    for (const session of this.sessions.values()) {
      if (session.timer) {
        clearTimeout(session.timer);
      }
    }

    this.graphitiQueue.stop();
    await this.graphitiClient.stop();
    if (this.streamPromise) {
      await this.streamPromise;
    }
  }

  /**
   * 给 /health 生成运行快照。
   *
   * 它不会改变业务状态，只负责把“当前进程活得怎么样”组织成一段可观察的信息。
   */
  public async getHealthSnapshot(): Promise<HealthSnapshot> {
    let redisStatus: "ok" | "error" = "ok";
    try {
      await this.redis.ping();
    } catch {
      redisStatus = "error";
    }

    return {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      redis: redisStatus,
      sse: this.weflowClient.getStatusSnapshot(),
      sessions: {
        active: this.sessions.size,
      },
      queues: {
        graphiti: this.graphitiQueue.snapshot(),
      },
    };
  }

  /**
   * handleIncomingEvent 是整个消息处理链路的第一站。
   *
   * 每当 WeFlow SSE 推来一条 `message.new`，都会先进入这里。
   * 这里不做上下文补拉，也不直接调 agent-runtime，只做入口阶段的 4 件事：
   *
   * 1. 过滤掉当前不关心的会话
   * 2. 用 Redis 按 messageKey 去重
   * 3. 把事件塞进对应群的内存 accumulator
   * 4. 为这个群安排或重置 quiet window
   */
  private async handleIncomingEvent(event: WeFlowSseMessageEvent): Promise<void> {
    console.log("收到了吗？", event);
    if (this.config.groupOnly && !isGroupSession(event.sessionId)) {
      return;
    }

    if (!event.messageKey) {
      return;
    }

    if (isBotSourceName(event.sourceName, this.config.botProfile)) {
      this.logger.debug({ event }, "忽略机器人自己发出的 SSE 事件，避免自触发");
      return;
    }

    const isFirstSeen = await this.redis.claimSseMessageKey(event.messageKey);
    if (!isFirstSeen) {
      this.logger.debug({ messageKey: event.messageKey }, "忽略重复 SSE 事件");
      return;
    }

    const session = this.ensureSession(event.sessionId);
    session.groupName = event.groupName ?? session.groupName;

    // pendingEvents 里放的是“这一个 quiet window 内收到的所有摘要事件”。
    session.pendingEvents.push(event);
    session.triggerReason = chooseTriggerReason(session.pendingEvents, this.config.botProfile);

    if (session.running) {
      // 如果同一个群已经在跑 agent run，就只标记 dirty。
      // 当前这批跑完后会再补一轮，避免并发多次回复。
      session.dirtyWhileRunning = true;
      return;
    }

    const delayMs =
      session.triggerReason === "mention"
        ? this.config.mentionQuietWindowMs
        : this.config.quietWindowMs;

    this.scheduleFlush(session, delayMs);
    this.logger.info(
      {
        sessionId: event.sessionId,
        groupName: session.groupName,
        sourceName: event.sourceName,
        contentPreview: event.content,
        messageKey: event.messageKey,
        triggerReason: session.triggerReason,
        pendingCount: session.pendingEvents.length,
      },
      "收到新群消息事件，已放入静默窗口等待聚合",
    );
  }

  /**
   * ensureSession 的作用是“按群拿到那份内存状态”。
   *
   * 第一次见到某个群时会新建一份；
   * 后面同一个群再来消息时，就会继续复用之前那份 accumulator。
   */
  private ensureSession(sessionId: string): SessionAccumulator {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: SessionAccumulator = {
      sessionId,
      pendingEvents: [],
      triggerReason: "quiet_window",
      running: false,
      dirtyWhileRunning: false,
    };

    this.sessions.set(sessionId, created);
    return created;
  }

  /**
   * scheduleFlush 可以理解成“为这个群重新预约一次处理时间”。
   *
   * quiet window 的核心就体现在这里：
   * 每来一条新消息，就取消旧定时器，再重新开始计时。
   * 只有安静了一段时间，flushSession 才真正执行。
   */
  private scheduleFlush(session: SessionAccumulator, delayMs: number): void {
    if (session.timer) {
      clearTimeout(session.timer);
    }

    // quiet window 是“静默一段时间后再批量判断”，所以每来一条新消息都要重置定时器。
    session.timer = setTimeout(() => {
      void this.flushSession(session.sessionId);
    }, delayMs);
  }

  /**
   * flushSession 是整个网关最核心的一步。
   *
   * 某个群 quiet window 到期后，真正开始处理这批消息时，就会进入这里。
   * 你可以把它理解成“把这个群攒起来的一小批消息正式出队”。
   *
   * 它内部的顺序是：
   * 1. 抢群级锁，避免并发 flush
   * 2. 冻结当前 pendingEvents，避免边处理边混入新事件
   * 3. 调 prepareRunInput，把 SSE 摘要补成完整输入
   * 4. 调 agent-runtime
   * 5. 成功后推进 committedLocalId
   * 6. 如果处理中间又来了新消息，再预约下一轮 flush
   */
  private async flushSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.running || session.pendingEvents.length === 0) {
      return;
    }

    const lockToken = await this.redis.acquireRunLock(sessionId);
    if (!lockToken) {
      session.dirtyWhileRunning = true;
      this.scheduleFlush(session, this.config.errorRetryDelayMs);
      return;
    }

    // 从这里开始，这个群进入“正在处理”的状态。
    session.running = true;
    session.dirtyWhileRunning = false;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }

    // 把当前窗口内的事件整体摘出来，后续就按这批固定输入处理。
    const pendingEvents = session.pendingEvents;
    const triggerReason = session.triggerReason;
    session.pendingEvents = [];
    session.triggerReason = "quiet_window";

    this.logger.info(
      {
        sessionId,
        groupName: session.groupName,
        triggerReason,
        pendingEventCount: pendingEvents.length,
      },
      "静默窗口到期，开始整理这一批群消息",
    );

    try {
      const result = await this.prepareRunInput(session, pendingEvents, triggerReason);
      if (!result) {
        this.logger.warn({ sessionId, groupName: session.groupName }, "本轮没有拉到可处理的消息，跳过调用 agent-runtime");
        return;
      }

      const { input, commitLocalId, newMessages } = result;

      if (this.graphitiClient.isEnabled() && newMessages.length > 0) {
        const graphitiBatch: GraphitiWriteBatch = {
          runId: input.runId,
          sessionId,
          groupName: session.groupName,
          triggerReason: input.triggerReason,
          messages: newMessages,
        };

        // 记忆写入放到队列里做，不阻塞 agent-runtime 的主链路。
        this.graphitiQueue.enqueue(async () => {
          await this.graphitiClient.addMessages(graphitiBatch);
        });
      }

      this.logger.info(
        {
          runId: input.runId,
          sessionId,
          newMessageCount: input.newMessages.length,
          recentMessageCount: input.recentMessages.length,
          triggerReason: input.triggerReason,
          gapDetected: input.gapDetected,
        },
        "批处理输入已准备好，开始调用 agent-runtime",
      );
      const response = await this.agentRuntimeClient.invoke(input);
      this.logger.info(
        {
          runId: input.runId,
          sessionId,
          shouldReply: response.shouldReply,
          reason: response.reason,
        },
        "agent-runtime 调用完成",
      );

      if (commitLocalId !== null) {
        await this.redis.setCommittedLocalId(sessionId, commitLocalId);
      }
    } catch (error) {
      // 如果主链路失败，就把这批事件塞回去，等待下一轮重试。
      session.pendingEvents.unshift(...pendingEvents);
      session.triggerReason = mergeTriggerReason(session.triggerReason, triggerReason);
      this.scheduleFlush(session, this.config.errorRetryDelayMs);
      this.logger.error({ err: error, sessionId }, "处理这一批群消息失败，稍后会自动重试");
    } finally {
      session.running = false;
      await this.redis.releaseRunLock(sessionId, lockToken);

      if (session.pendingEvents.length > 0 || session.dirtyWhileRunning) {
        // flush 期间如果又来了新消息，不立刻重入，而是重新走一轮 quiet window。
        const delayMs =
          session.triggerReason === "mention"
            ? this.config.mentionQuietWindowMs
            : this.config.quietWindowMs;
        this.scheduleFlush(session, delayMs);
      }
    }
  }

  /**
   * prepareRunInput 是“从摘要事件走向完整批输入”的转换阶段。
   *
   * flushSession 已经知道某个群该处理了，但还不能直接调用 agent-runtime，
   * 因为手里只有 pendingEvents 这种 SSE 摘要。
   *
   * 这个方法会补做几件关键工作：
   * 1. 读取上次处理到哪一条 localId
   * 2. 调 WeFlow /messages 拉最近消息
   * 3. 必要时扩大窗口做 catch-up
   * 4. 判断有没有 gap
   * 5. 区分出 newMessages 和 recentMessages
   * 6. 组装最终 AgentRunInput
   */
  private async prepareRunInput(
    session: SessionAccumulator,
    pendingEvents: WeFlowSseMessageEvent[],
    triggerReason: TriggerReason,
  ): Promise<{
    input: AgentRunInput;
    commitLocalId: number | null;
    newMessages: NormalizedMessage[];
  } | null> {
    const lastCommittedLocalId = await this.redis.getCommittedLocalId(session.sessionId);

    // 第一次先用较小窗口补拉最近消息；如果发现可能越过了上次高水位，
    // 再扩大窗口做一次 catch-up，尽量把本轮上下文补齐。
    let response = await this.weflowClient.getMessages(session.sessionId, this.config.weflowFetchLimit);
    let recentMessages = this.normalizeMessages(session.sessionId, session.groupName, response.messages);

    this.logger.debug(
      {
        sessionId: session.sessionId,
        fetchedCount: recentMessages.length,
        fetchLimit: this.config.weflowFetchLimit,
        hasMore: response.hasMore,
        lastCommittedLocalId,
      },
      "已从 WeFlow 拉取最近一批消息，准备整理上下文",
    );

    const needsCatchup =
      lastCommittedLocalId !== null &&
      response.hasMore &&
      recentMessages.length > 0 &&
      recentMessages[0]!.localId > lastCommittedLocalId &&
      this.config.weflowCatchupFetchLimit > this.config.weflowFetchLimit;

    if (needsCatchup) {
      this.logger.info(
        {
          sessionId: session.sessionId,
          lastCommittedLocalId,
          fetchLimit: this.config.weflowCatchupFetchLimit,
        },
        "检测到可能跨过上次处理位置，扩大窗口重新补拉消息",
      );
      response = await this.weflowClient.getMessages(
        session.sessionId,
        this.config.weflowCatchupFetchLimit,
      );
      recentMessages = this.normalizeMessages(session.sessionId, session.groupName, response.messages);
    }

    if (recentMessages.length === 0) {
      return null;
    }

    // WeFlow 的 SSE 只有摘要，没有 messageKey -> /messages 的一一映射，
    // 所以首轮没有 committedLocalId 时，我们只能用“本轮收到了几条 SSE 事件，
    // 就取最近几条入站消息”这个启发式来避免误回放整段历史。
    const gapDetected = this.detectGap(lastCommittedLocalId, response, recentMessages);
    const newMessages = this.selectNewMessages(lastCommittedLocalId, pendingEvents.length, recentMessages);
    const commitLocalId = this.computeCommitLocalId(
      lastCommittedLocalId,
      gapDetected,
      recentMessages,
      newMessages,
    );

    this.logger.debug(
      {
        sessionId: session.sessionId,
        triggerReason,
        newMessageCount: newMessages.length,
        recentMessageCount: recentMessages.length,
        gapDetected,
        commitLocalId,
      },
      "已完成批处理输入整理",
    );

    return {
      input: this.buildRunInput(
        session,
        triggerReason,
        pendingEvents.length,
        gapDetected,
        newMessages,
        recentMessages,
      ),
      commitLocalId,
      newMessages,
    };
  }

  /**
   * buildRunInput 把 event-gateway 内部整理好的数据，打包成发给 agent-runtime 的请求体。
   *
   * 这是边界很重要的一步：
   * 走出这个函数以后，下游就不需要知道 quiet window、Redis 高水位这些内部细节了。
   */
  private buildRunInput(
    session: SessionAccumulator,
    triggerReason: TriggerReason,
    triggerEventCount: number,
    gapDetected: boolean,
    newMessages: NormalizedMessage[],
    recentMessages: NormalizedMessage[],
  ): AgentRunInput {
    const orderedRecent = [...recentMessages].sort(sortByLocalId);
    const contextMessages = this.buildContextMessages(orderedRecent);

    // newMessages 是“这次真正触发判断的增量消息”，
    // recentMessages 是“提供给 agent-runtime 做判断的上下文窗口”。
    return {
      runId: createRunId(),
      sessionId: session.sessionId,
      groupName: session.groupName,
      triggerReason,
      triggerEventCount,
      gapDetected,
      newMessages,
      recentMessages: contextMessages,
      botProfile: this.config.botProfile,
      metadata: {
        source: "weflow",
        oldestFetchedLocalId: orderedRecent[0]?.localId,
        newestFetchedLocalId: orderedRecent.at(-1)?.localId,
      },
    };
  }

  /**
   * normalizeMessages 会在刚拿到 WeFlow /messages 响应时执行。
   *
   * 它的目标不是“尽可能保留 WeFlow 原始字段”，
   * 而是把数据统一成 event-gateway 自己稳定使用的 NormalizedMessage。
   *
   * 后面无论是挑选 newMessages、写 Graphiti，还是传给 agent-runtime，
   * 都基于这个统一结构继续工作。
   */
  /**
   * buildContextMessages 会在真正把 recentMessages 交给 agent-runtime 之前，
   * 再做一层“上下文瘦身”。
   *
   * 当前规则分成两层：
   * 1. 先保留最近的 N 条候选消息，N 由 AGENT_CONTEXT_LIMIT 控制
   * 2. 再按总字符预算筛选，预算由 AGENT_CONTEXT_CHAR_LIMIT 控制
   *
   * 同时，单条消息如果太长，会先被截断到 100 字以内，
   * 避免一条广告或机器人长消息直接挤爆整段上下文。
   */
  private buildContextMessages(recentMessages: NormalizedMessage[]): NormalizedMessage[] {
    if (this.config.agentContextLimit <= 0 || this.config.agentContextCharLimit <= 0) {
      return [];
    }

    const candidateMessages = recentMessages.slice(-this.config.agentContextLimit);
    const selectedMessages: NormalizedMessage[] = [];
    let usedChars = 0;

    for (let index = candidateMessages.length - 1; index >= 0; index -= 1) {
      const candidate = this.truncateContextMessage(candidateMessages[index]!);
      const candidateChars = candidate.content.length;

      if (candidateChars === 0) {
        continue;
      }

      // 如果加上这条就会超过总字符预算，就直接跳过这条。
      if (usedChars + candidateChars > this.config.agentContextCharLimit) {
        continue;
      }

      selectedMessages.push(candidate);
      usedChars += candidateChars;
    }

    return selectedMessages.sort(sortByLocalId);
  }

  /**
   * truncateContextMessage 只用于 recentMessages，不影响 newMessages。
   * 这样主触发消息仍然保留原样，而短上下文会更可控。
   */
  private truncateContextMessage(message: NormalizedMessage): NormalizedMessage {
    const content = truncateText(message.content, MAX_CONTEXT_MESSAGE_CHARS);
    const rawContent = truncateText(message.rawContent, MAX_CONTEXT_MESSAGE_CHARS);

    if (content === message.content && rawContent === message.rawContent) {
      return message;
    }

    return {
      ...message,
      content,
      rawContent,
    };
  }

  private normalizeMessages(
    sessionId: string,
    groupName: string | undefined,
    messages: WeFlowApiMessage[],
  ): NormalizedMessage[] {
    return [...messages]
      .sort(sortByLocalId)
      .map((message) => {
        const createdAtUnixMs = normalizeCreateTime(message.createTime);
        const senderId =
          message.senderUsername?.trim() ||
          (message.isSend ? this.config.botProfile.wechatIds[0] || this.config.botProfile.name : "unknown");
        const content =
          message.parsedContent ||
          message.content ||
          message.rawContent ||
          `[${message.mediaType || "message"}]`;
        const isSelfSent = message.isSend === 1;
        const isFromBot = isSelfSent || this.config.botProfile.wechatIds.includes(senderId);

        return {
          sessionId,
          groupName,
          localId: message.localId,
          serverId: message.serverId,
          senderId,
          senderName: senderId,
          timestamp: new Date(createdAtUnixMs).toISOString(),
          createdAtUnixMs,
          content,
          rawContent: message.rawContent || content,
          contentType: inferContentType(message),
          isGroup: isGroupSession(sessionId),
          isSelfSent,
          isFromBot,
          isMentionBot: detectMention(content, this.config.botProfile),
          fingerprint: `${sessionId}:${message.localId}`,
        };
      });
  }

  /**
   * detectGap 用来判断这次补拉是不是可能“没有拉到足够早”。
   *
   * 典型场景是：
   * 上次处理到了 localId=100
   * 这次只拉最近 80 条，但最早一条已经是 localId=150
   * 这中间 101~149 可能就丢在窗口外了
   *
   * 这时就会把 gapDetected 标成 true，提醒下游“这次上下文不一定完整”。
   */
  private detectGap(
    lastCommittedLocalId: number | null,
    response: WeFlowMessagesResponse,
    recentMessages: NormalizedMessage[],
  ): boolean {
    if (lastCommittedLocalId === null) {
      return response.hasMore;
    }

    const oldestLocalId = recentMessages[0]?.localId;
    if (!oldestLocalId) {
      return false;
    }

    return response.hasMore && oldestLocalId > lastCommittedLocalId;
  }

  /**
   * selectNewMessages 的作用，是从 recentMessages 里挑出
   * “这次真正应该触发机器人判断的那几条增量消息”。
   *
   * 它和 recentMessages 的区别是：
   * - recentMessages：上下文窗口
   * - newMessages：本轮触发源
   */
  private selectNewMessages(
    lastCommittedLocalId: number | null,
    pendingEventCount: number,
    recentMessages: NormalizedMessage[],
  ): NormalizedMessage[] {
    const inboundMessages = recentMessages.filter((message) => !message.isSelfSent && !message.isFromBot);

    if (lastCommittedLocalId === null) {
      // 首次处理某个群时，不应该把历史消息全当成“新消息”。
      // 这里只取本轮 SSE 事件数量对应的最新入站消息，作为 MVP 的启动锚点。
      const takeCount = Math.max(1, Math.min(pendingEventCount || 1, inboundMessages.length));
      return inboundMessages.slice(-takeCount);
    }

    // 正常情况下，有了 committedLocalId 以后，localId 更大的入站消息就都算新消息。
    return inboundMessages.filter((message) => message.localId > lastCommittedLocalId);
  }

  /**
   * computeCommitLocalId 决定这轮成功后要把“高水位”推进到哪里。
   *
   * 为什么单独拿出来？
   * 因为高水位推进错了，后面就可能重复处理或漏处理。
   *
   * 当前策略是：
   * - 首次处理某群：直接把窗口尾部作为起点
   * - 如果检测到 gap：宁可不推进，也不冒险跳过中间可能没处理到的消息
   * - 否则：推进到本轮最新的 newMessage
   */
  private computeCommitLocalId(
    lastCommittedLocalId: number | null,
    gapDetected: boolean,
    recentMessages: NormalizedMessage[],
    newMessages: NormalizedMessage[],
  ): number | null {
    if (recentMessages.length === 0) {
      return lastCommittedLocalId;
    }

    if (lastCommittedLocalId === null) {
      return recentMessages.at(-1)?.localId ?? null;
    }

    if (gapDetected) {
      return lastCommittedLocalId;
    }

    return newMessages.at(-1)?.localId ?? lastCommittedLocalId;
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 3) {
    return text.slice(0, Math.max(0, maxChars));
  }

  return `${text.slice(0, maxChars - 3)}...`;
}

function sortByLocalId(left: { localId: number }, right: { localId: number }): number {
  return left.localId - right.localId;
}

/**
 * mention 的优先级高于普通 quiet window。
 * 所以两批状态合并时，只要有一边是 mention，结果就保持 mention。
 */
function mergeTriggerReason(current: TriggerReason, next: TriggerReason): TriggerReason {
  return current === "mention" || next === "mention" ? "mention" : "quiet_window";
}
