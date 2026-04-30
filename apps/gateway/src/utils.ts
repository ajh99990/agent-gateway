import crypto from "node:crypto";
import type {
  BotProfile,
  MessageContentType,
  NormalizedMessage,
  TriggerReason,
  WeFlowApiMessage,
  WeFlowSseMessageEvent,
} from "./types.js";

/**
 * sleep 只用于“失败后稍等一下再重试”这种节奏控制。
 * 当前主要出现在 SSE 重连场景里。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * runId 是给每一次 agent-runtime 调用生成的唯一编号。
 *
 * 它不是业务主键，更像一次调用链的追踪号，
 * 用来把 event-gateway 的日志和下游处理记录串起来。
 */
export function createRunId(): string {
  return crypto.randomUUID();
}

/**
 * fetch 超时后在 Node 里会抛 AbortError。
 * 单独包一层判断，是为了在 SSE 重连逻辑里区分：
 * - 这是正常中断
 * - 还是确实发生了异常
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * WeFlow 的 createTime 可能是秒，也可能已经是毫秒。
 * 这里统一归一成毫秒，后面构造 ISO 时间戳时就不会乱。
 */
export function normalizeCreateTime(value: number): number {
  return value > 1_000_000_000_000 ? value : value * 1000;
}

/**
 * inferContentType 的作用不是做精确媒体解析，
 * 而是给 agent-runtime 一个足够实用的“消息大类”提示。
 *
 * 它会在 normalizeMessages 阶段被调用，也就是：
 * WeFlow 原始消息被转换成 NormalizedMessage 的那个时刻。
 */
export function inferContentType(message: WeFlowApiMessage): MessageContentType {
  const mediaType = message.mediaType?.toLowerCase();
  if (mediaType === "image") return "image";
  if (mediaType === "voice") return "voice";
  if (mediaType === "video") return "video";
  if (mediaType === "emoji") return "emoji";
  if (message.localType === 3) return "image";
  if (message.localType === 34) return "voice";
  if (message.localType === 43) return "video";
  if (message.localType === 47) return "emoji";
  return "text";
}

/**
 * 当前 MVP 只关心群消息，所以 sessionId 是否以 @chatroom 结尾很重要。
 * 这个判断会在最早接到 SSE 事件时就先执行，尽快过滤掉无关会话。
 */
export function isGroupSession(sessionId: string): boolean {
  return sessionId.endsWith("@chatroom");
}

/**
 * detectMention 是 quiet window 分流的关键步骤。
 *
 * 如果一条消息里出现了 @机器人，就会把当前群的触发原因标成 mention，
 * 后面这个群会用更短的 quiet window，更快触发一次判断。
 */
export function detectMention(text: string | undefined, botProfile: BotProfile): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();
  return botProfile.aliases.some((alias) => {
    const candidate = alias.trim().toLowerCase();
    return candidate !== "" && normalized.includes(`@${candidate}`);
  });
}

/**
 * 这是一个很粗粒度的“是不是机器人本人发言”判断。
 *
 * 它发生在 SSE 入口的早期阶段，用来快速丢掉明显的自发消息，
 * 避免机器人自己触发自己。
 */
export function isBotSourceName(sourceName: string | undefined, botProfile: BotProfile): boolean {
  if (!sourceName) {
    return false;
  }

  const normalized = sourceName.trim().toLowerCase();
  return botProfile.aliases.some((alias) => alias.trim().toLowerCase() === normalized);
}

/**
 * 当一个群的 quiet window 里累计了多条事件时，
 * 只要其中有任何一条命中了 @机器人，本轮就按 mention 处理。
 *
 * 也就是说，mention 的优先级高于普通 quiet_window。
 */
export function chooseTriggerReason(events: WeFlowSseMessageEvent[], botProfile: BotProfile): TriggerReason {
  return events.some((event) => detectMention(event.content, botProfile)) ? "mention" : "quiet_window";
}

export function normalizeWeFlowApiMessage(
  sessionId: string,
  groupName: string | undefined,
  message: WeFlowApiMessage,
  botProfile: BotProfile,
): NormalizedMessage {
  const createdAtUnixMs = normalizeCreateTime(message.createTime);
  const senderId =
    message.senderUsername?.trim() ||
    (message.isSend ? botProfile.wechatIds[0] || botProfile.name : "unknown");
  const content =
    message.parsedContent ||
    message.content ||
    message.rawContent ||
    `[${message.mediaType || "message"}]`;
  const isSelfSent = message.isSend === 1;
  const isFromBot = isSelfSent || botProfile.wechatIds.includes(senderId);

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
    isMentionBot: detectMention(content, botProfile),
    fingerprint: `${sessionId}:${message.localId}`,
  };
}

export function normalizeWeFlowApiMessages(
  sessionId: string,
  groupName: string | undefined,
  messages: WeFlowApiMessage[],
  botProfile: BotProfile,
): NormalizedMessage[] {
  return [...messages]
    .sort((left, right) => left.localId - right.localId)
    .map((message) => normalizeWeFlowApiMessage(sessionId, groupName, message, botProfile));
}
