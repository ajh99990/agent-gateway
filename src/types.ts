/**
 * TriggerReason 表示“这一次为什么要触发 agent run”。
 *
 * 当前只有两类：
 * - quiet_window：普通静默窗口到期
 * - mention：检测到消息里提到了机器人，所以用更短的窗口
 */
export type TriggerReason = "quiet_window" | "mention";

/**
 * BotProfile 是机器人自己的身份信息。
 *
 * 这份信息会在多个环节用到：
 * - 判断别人有没有 @机器人
 * - 判断某条消息是不是机器人自己发的
 * - 原样传给 agent-runtime，方便下游 prompt / tool 使用
 */
export interface BotProfile {
  name: string;
  aliases: string[];
  wechatIds: string[];
}

/**
 * 这是 WeFlow SSE 推过来的摘要事件。
 *
 * 它的特点是“够触发，但不够判断”：
 * 知道哪个群有新消息了，也有 messageKey 可以去重，
 * 但没有完整上下文，所以后面还得再调 /messages 补拉。
 */
export interface WeFlowSseMessageEvent {
  event: "message.new";
  sessionId: string;
  messageKey: string;
  avatarUrl?: string;
  sourceName?: string;
  groupName?: string;
  content?: string;
}

/**
 * 这是 WeFlow /api/v1/messages 返回的单条消息结构。
 *
 * 它比 SSE 更完整，是 event-gateway 真正构建上下文时依赖的数据来源。
 */
export interface WeFlowApiMessage {
  localId: number;
  serverId?: string | number;
  localType: number;
  createTime: number;
  isSend: number;
  senderUsername?: string;
  content?: string;
  rawContent?: string;
  parsedContent?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  mediaLocalPath?: string;
}

/**
 * /messages 的顶层响应结构。
 *
 * hasMore 很关键，因为它会帮助我们判断：
 * 当前这次补拉是不是可能仍然没覆盖到上次处理过的位置。
 */
export interface WeFlowMessagesResponse {
  success: boolean;
  talker: string;
  count: number;
  hasMore: boolean;
  messages: WeFlowApiMessage[];
}

/**
 * event-gateway 内部统一后的消息类型。
 *
 * 这里可以理解成“交给 agent-runtime 之前的内部标准消息格式”。
 * SSE、WeFlow API、Graphiti 都有各自的字段名字，
 * 统一成这个结构之后，后续逻辑就不需要关心上游细节了。
 */
export type MessageContentType =
  | "text"
  | "image"
  | "voice"
  | "video"
  | "emoji"
  | "unknown";

export interface NormalizedMessage {
  sessionId: string;
  groupName?: string;
  localId: number;
  serverId?: string | number;
  senderId: string;
  senderName: string;
  timestamp: string;
  createdAtUnixMs: number;
  content: string;
  rawContent: string;
  contentType: MessageContentType;
  isGroup: boolean;
  isSelfSent: boolean;
  isFromBot: boolean;
  isMentionBot: boolean;
  fingerprint: string;
}

/**
 * 这是 event-gateway 发给 agent-runtime 的核心请求体。
 *
 * 其中最重要的两个数组：
 * - newMessages：这次真正触发机器人判断的增量消息
 * - recentMessages：提供给下游判断的上下文窗口
 */
export interface AgentRunInput {
  runId: string;
  sessionId: string;
  groupName?: string;
  triggerReason: TriggerReason;
  triggerEventCount: number;
  gapDetected: boolean;
  newMessages: NormalizedMessage[];
  recentMessages: NormalizedMessage[];
  botProfile: BotProfile;
  metadata: {
    source: "weflow";
    oldestFetchedLocalId?: number;
    newestFetchedLocalId?: number;
  };
}

/**
 * AgentRuntimeResponse 故意设计得比较宽松。
 *
 * 因为当前 event-gateway 只关心少数字段，
 * 不想把 agent-runtime 的具体实现反过来强耦合到这里。
 */
export interface AgentRuntimeResponse {
  success?: boolean;
  shouldReply?: boolean;
  reason?: string;
  replyText?: string;
  [key: string]: unknown;
}

/**
 * GraphitiWriteBatch 是 event-gateway 写入长期记忆时使用的内部批次结构。
 *
 * 它出现在主链路“已经决定这批消息值得交给下游处理”之后：
 * flushSession 整理出本轮 newMessages，
 * 然后把这批消息连同 runId / triggerReason 一起交给 GraphitiClient。
 *
 * 对 Graphiti 来说，这一批数据最终会被序列化成一个 episode，
 * 表示“这一小段微信群对话”。
 */
export interface GraphitiWriteBatch {
  runId: string;
  sessionId: string;
  groupName?: string;
  triggerReason: TriggerReason;
  messages: NormalizedMessage[];
}

/**
 * SessionAccumulator 是 event-gateway 的“群级内存状态”。
 *
 * 每个群会在内存里对应一份这样的对象，
 * 用来保存本轮 quiet window 内累计到的 SSE 事件和当前运行状态。
 */
export interface SessionAccumulator {
  sessionId: string;
  groupName?: string;
  pendingEvents: WeFlowSseMessageEvent[];
  triggerReason: TriggerReason;
  running: boolean;
  dirtyWhileRunning: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * 这些结构都是给 /health 暴露运行状态用的。
 *
 * 它们不参与主业务判断，但对排查运行问题很有帮助。
 */
export interface SseStatusSnapshot {
  connected: boolean;
  lastReadyAt?: string;
  lastMessageAt?: string;
  reconnectCount: number;
}

export interface QueueSnapshot {
  pending: number;
  running: number;
}

export interface HealthSnapshot {
  status: "ok";
  uptimeSeconds: number;
  redis: "ok" | "error";
  sse: SseStatusSnapshot;
  sessions: {
    active: number;
  };
  queues: {
    graphiti: QueueSnapshot;
  };
}
