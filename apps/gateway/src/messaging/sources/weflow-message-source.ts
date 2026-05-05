import type { AppConfig } from "../../config.js";
import type {
  InboundMessageEvent,
  MessageHistoryPage,
  MessageHistoryProvider,
  MessageHistoryRequest,
  MessageSource,
  MessageSourceStatusSnapshot,
  WeFlowSseMessageEvent,
} from "../../types.js";
import { normalizeWeFlowApiMessages } from "../message-utils.js";
import { WeFlowClient } from "./weflow-client.js";

/**
 * WeFlowMessageSource 把 WeFlow 的 SSE 和 /messages 适配成网关内部通用口。
 *
 * WeFlowClient 仍然只负责跟 WeFlow 通信；从这里开始，上层不再需要知道
 * 当前消息是通过 SSE 进来的，还是后续通过别的消息源进来的。
 */
export class WeFlowMessageSource implements MessageSource, MessageHistoryProvider {
  public readonly id = "weflow";

  public constructor(
    private readonly weflowClient: WeFlowClient,
    private readonly config: AppConfig,
  ) {}

  public async start(
    onEvent: (event: InboundMessageEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.weflowClient.streamMessages(
      async (event) => onEvent(this.toInboundEvent(event)),
      signal,
    );
  }

  public getStatusSnapshot(): MessageSourceStatusSnapshot {
    return {
      id: this.id,
      ...this.weflowClient.getStatusSnapshot(),
    };
  }

  public async getRecentMessages(request: MessageHistoryRequest): Promise<MessageHistoryPage> {
    const response = await this.weflowClient.getMessages(request.sessionId, request.limit);

    return {
      source: this.id,
      hasMore: response.hasMore,
      messages: normalizeWeFlowApiMessages(
        request.sessionId,
        request.groupName,
        response.messages,
        this.config.botProfile,
      ),
    };
  }

  private toInboundEvent(event: WeFlowSseMessageEvent): InboundMessageEvent {
    return {
      source: this.id,
      event: event.event,
      sessionId: event.sessionId,
      messageKey: event.messageKey,
      avatarUrl: event.avatarUrl,
      sourceName: event.sourceName,
      groupName: event.groupName,
      content: event.content,
      receivedAtUnixMs: Date.now(),
      raw: event,
    };
  }
}
