import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { AgentRunInput, AgentRuntimeResponse } from "./types.js";

/**
 * 这里故意只实现成一个简单 webhook 客户端。
 * event-gateway 不关心 agent-runtime 内部是不是 LangGraph、Express 还是别的框架。
 *
 * 在整条流程里的时机是：
 * 1. event-gateway 已经完成 quiet window 聚合
 * 2. 也已经从 WeFlow 补拉完最近消息
 * 3. 这时才会调用这里，把整理好的 AgentRunInput 发给下游
 */
export class AgentRuntimeClient {
  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * invoke 是“主链路真正把判断工作交棒给 agent-runtime”的那一步。
   *
   * 它不会自己做任何业务决策，只负责：
   * - 发 HTTP POST
   * - 带上超时控制
   * - 把返回结果解析出来交回给 event-gateway 记录日志
   */
  public async invoke(input: AgentRunInput): Promise<AgentRuntimeResponse> {
    if (!this.config.agentRuntimeUrl) {
      // 这样本地联调时可以先只观察 event-gateway 的行为，不会因为下游还没做好就完全跑不起来。
      this.logger.warn(
        { runId: input.runId, sessionId: input.sessionId },
        "未配置 AGENT_RUNTIME_URL，当前仅观察网关行为，不会真正调用 agent-runtime",
      );
      return {
        success: true,
        reason: "agent-runtime-disabled",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.agentRuntimeTimeoutMs);

    try {
      // 这里发送的是 event-gateway 已经整理好的“批处理输入”，
      // 而不是原始 SSE 事件流。
      const response = await fetch(this.config.agentRuntimeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.agentRuntimeBearerToken
            ? { Authorization: `Bearer ${this.config.agentRuntimeBearerToken}` }
            : {}),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Agent runtime request failed: ${response.status} ${response.statusText} ${raw}`);
      }

      // 某些早期调试阶段，下游可能先只返回 200 不返回 body，
      // 这里保留一个宽松兜底，避免联调初期太脆弱。
      if (!raw.trim()) {
        return { success: true };
      }

      return JSON.parse(raw) as AgentRuntimeResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
