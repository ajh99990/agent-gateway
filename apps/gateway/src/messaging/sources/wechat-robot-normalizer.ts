import type { BotProfile, MessageContentType } from "../../types.js";
import type { CreateInboundMessageInput } from "../../db/stores/index.js";
import type { JsonValue } from "../../db/json.js";
import {
  detectMention,
  isGroupSession,
  normalizeCreateTime,
} from "../message-utils.js";
import type {
  WechatRobotBuiltinString,
  WechatRobotClientResponse,
  WechatRobotRawMessage,
  WechatRobotSyncMessage,
} from "./wechat-robot-types.js";

const MSG_TYPE_TEXT = 1;
const MSG_TYPE_IMAGE = 3;
const MSG_TYPE_VOICE = 34;
const MSG_TYPE_VIDEO = 43;
const MSG_TYPE_EMOJI = 47;
const MSG_TYPE_APP = 49;
const MSG_TYPE_INIT = 51;
const MSG_TYPE_MICRO_VIDEO = 62;
const MSG_TYPE_UNKNOWN = 9999;
const MSG_TYPE_SYSTEM = 10002;
const APP_MSG_TYPE_ATTACH_UPLOADING = 74;

export interface NormalizeWechatRobotSyncMessageInput {
  source: string;
  robotWxid: string;
  wechatId: string;
  payload: WechatRobotSyncMessage;
  botProfile: BotProfile;
}

export function extractWechatRobotSyncMessage(body: unknown): WechatRobotSyncMessage | null {
  if (!isObject(body)) {
    return null;
  }

  if (Array.isArray(body.AddMsgs)) {
    return body as WechatRobotSyncMessage;
  }

  const response = body as WechatRobotClientResponse<WechatRobotSyncMessage>;
  if (isObject(response.Data) && Array.isArray(response.Data.AddMsgs)) {
    return response.Data;
  }

  return null;
}

export function normalizeWechatRobotSyncMessage(
  input: NormalizeWechatRobotSyncMessageInput,
): CreateInboundMessageInput[] {
  const messages = input.payload.AddMsgs ?? [];
  const botWechatIds = new Set([
    input.robotWxid,
    input.wechatId,
    ...input.botProfile.wechatIds,
  ].filter(Boolean));

  return messages.flatMap((message) => {
    const normalized = normalizeWechatRobotMessage({
      source: input.source,
      robotWxid: input.robotWxid,
      botWechatIds,
      botProfile: input.botProfile,
      message,
    });
    return normalized ? [normalized] : [];
  });
}

interface NormalizeWechatRobotMessageInput {
  source: string;
  robotWxid: string;
  botWechatIds: Set<string>;
  botProfile: BotProfile;
  message: WechatRobotRawMessage;
}

function normalizeWechatRobotMessage(
  input: NormalizeWechatRobotMessageInput,
): CreateInboundMessageInput | null {
  const rawMsgType = toNumber(input.message.MsgType, MSG_TYPE_UNKNOWN);
  const originalContent = readBuiltinString(input.message.Content);
  const fromWxid = readBuiltinString(input.message.FromUserName);
  const toWxid = readBuiltinString(input.message.ToUserName);
  const createTime = toNumber(input.message.CreateTime, Math.floor(Date.now() / 1000));
  const createdAtUnixMs = normalizeCreateTime(createTime);

  let sessionId = fromWxid;
  let receiverId = toWxid;
  let content = originalContent;
  let senderId = fromWxid;
  let isSelfSent = false;

  if (fromWxid === input.robotWxid && isGroupSession(toWxid)) {
    sessionId = toWxid;
    receiverId = fromWxid;
  }

  const isGroup = isGroupSession(sessionId);
  if (isGroup) {
    const splitContent = splitGroupSenderContent(content);
    if (splitContent) {
      senderId = splitContent.senderId;
      content = splitContent.content;
    } else {
      senderId = input.robotWxid;
      isSelfSent = true;
    }
  } else {
    senderId = fromWxid;
    if (input.botWechatIds.has(fromWxid)) {
      sessionId = toWxid;
      receiverId = fromWxid;
      isSelfSent = true;
    }
  }

  if (!sessionId || !senderId) {
    return null;
  }

  const isFromBot = isSelfSent || input.botWechatIds.has(senderId);
  const messageForFilter = {
    type: rawMsgType,
    senderId,
    content,
  };
  if (!shouldKeepMessage(messageForFilter)) {
    return null;
  }

  const rawMessageKey = buildMessageKey(input.robotWxid, input.message);
  const contentType = inferWechatRobotContentType(rawMsgType);
  const mentionedWxids = parseWechatRobotMentionedWxids(input.message.MsgSource);
  const isMentionBot =
    mentionedWxids.some((wxid) => input.botWechatIds.has(wxid)) ||
    detectMention(content, input.botProfile);

  return {
    source: input.source,
    messageKey: rawMessageKey,
    sessionId,
    senderId,
    senderName: senderId,
    receiverId,
    robotWxid: input.robotWxid,
    content: content || fallbackContent(contentType),
    rawContent: originalContent || content,
    contentType,
    isGroup,
    isSelfSent,
    isFromBot,
    isMentionBot,
    mentionedWxids,
    createdAtUnixMs,
    rawPayload: toJsonValue(input.message),
  };
}

function shouldKeepMessage(message: {
  type: number;
  senderId: string;
  content: string;
}): boolean {
  if (message.type === MSG_TYPE_INIT || message.type === MSG_TYPE_UNKNOWN) {
    return false;
  }

  if (message.type === MSG_TYPE_SYSTEM && message.senderId === "weixin") {
    return false;
  }

  if (message.type === MSG_TYPE_APP) {
    const subtype = toNumber(readXmlTag(message.content, "type"), 0);
    return subtype !== APP_MSG_TYPE_ATTACH_UPLOADING;
  }

  return true;
}

function inferWechatRobotContentType(msgType: number): MessageContentType {
  if (msgType === MSG_TYPE_IMAGE) return "image";
  if (msgType === MSG_TYPE_VOICE) return "voice";
  if (msgType === MSG_TYPE_VIDEO || msgType === MSG_TYPE_MICRO_VIDEO) return "video";
  if (msgType === MSG_TYPE_EMOJI) return "emoji";
  if (msgType === MSG_TYPE_TEXT) return "text";
  return "unknown";
}

function splitGroupSenderContent(content: string): { senderId: string; content: string } | null {
  const markerIndex = content.indexOf(":\n");
  if (markerIndex <= 0) {
    return null;
  }

  return {
    senderId: content.slice(0, markerIndex),
    content: content.slice(markerIndex + 2),
  };
}

function buildMessageKey(robotWxid: string, message: WechatRobotRawMessage): string {
  const newMsgId = stringifyId(message.NewMsgId);
  const msgId = stringifyId(message.MsgId);
  const msgSeq = stringifyId(message.MsgSeq);
  const createTime = stringifyId(message.CreateTime);

  return [
    robotWxid || "unknown-robot",
    newMsgId || msgId || "unknown-message",
    msgSeq || "0",
    createTime || "0",
  ].join(":");
}

function parseWechatRobotMentionedWxids(msgSource: string | undefined): string[] {
  const atUserList = readXmlTag(msgSource ?? "", "atuserlist");
  if (!atUserList) {
    return [];
  }

  return Array.from(
    new Set(
      atUserList
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function readXmlTag(xml: string, tagName: string): string {
  if (!xml || !tagName) {
    return "";
  }

  const escapedTag = escapeRegExp(tagName);
  const match = xml.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)</${escapedTag}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function readBuiltinString(value: WechatRobotBuiltinString | undefined): string {
  return value?.string ?? value?.String ?? "";
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function stringifyId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  return "";
}

function fallbackContent(contentType: MessageContentType): string {
  return contentType === "text" ? "" : `[${contentType}]`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
