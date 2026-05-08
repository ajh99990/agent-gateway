import type http from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "../../config.js";
import {
  type InboundMessageRecord,
  inboundRecordToNormalizedMessage,
  InboundMessageStore,
} from "../../db/stores/index.js";
import type { GatewayHttpRoute } from "../../http/gateway-http-server.js";
import type { ChatRoomMemberNameResolver } from "../member-name-resolver.js";
import type {
  InboundMessageEvent,
  MessageHistoryPage,
  MessageHistoryProvider,
  MessageHistoryRequest,
  MessageSource,
  MessageSourceStatusSnapshot,
} from "../../types.js";
import {
  extractWechatRobotSyncMessage,
  normalizeWechatRobotSyncMessage,
} from "./wechat-robot-normalizer.js";

const CALLBACK_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export class WechatHttpMessageSource implements MessageSource, MessageHistoryProvider {
  public readonly id = "wechat-http";

  private onEvent?: (event: InboundMessageEvent) => Promise<void>;
  private readonly status: MessageSourceStatusSnapshot = {
    id: this.id,
    connected: false,
    reconnectCount: 0,
  };
  private dispatchAfterUnixMs = Date.now();

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly inboundMessages: InboundMessageStore,
    private readonly memberNameResolver: ChatRoomMemberNameResolver,
  ) {}

  public getRoutes(): GatewayHttpRoute[] {
    return [
      {
        method: "POST",
        pathPattern: /^\/api\/v1\/wechat-client\/([^/]+)\/sync-message$/,
        handle: async ({ req, url, match, sendJson }) => {
          await this.handleSyncMessageCallback(req, url, match, sendJson);
        },
      },
      {
        method: "POST",
        pathPattern: /^\/api\/v1\/wechat-client\/([^/]+)\/logout$/,
        handle: async ({ req, url, match, sendJson }) => {
          await this.handleLogoutCallback(req, url, match, sendJson);
        },
      },
    ];
  }

  public async start(
    onEvent: (event: InboundMessageEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();

    this.onEvent = onEvent;
    this.status.connected = true;
    this.status.lastReadyAt = new Date(startedAt).toISOString();
    this.dispatchAfterUnixMs = startedAt - this.config.wechatHttpRealtimeLookbackMs;

    this.logger.info(
      {
        dispatchAfter: new Date(this.dispatchAfterUnixMs).toISOString(),
        realtimeLookbackMs: this.config.wechatHttpRealtimeLookbackMs,
      },
      "微信 HTTP 消息源已启动，历史消息将只入库不触发处理",
    );

    signal.addEventListener(
      "abort",
      () => {
        this.status.connected = false;
      },
      { once: true },
    );
  }

  public getStatusSnapshot(): MessageSourceStatusSnapshot {
    return { ...this.status };
  }

  public async getRecentMessages(request: MessageHistoryRequest): Promise<MessageHistoryPage> {
    const limit = Math.min(request.limit, this.config.wechatHttpHistoryLimit);
    const result = await this.inboundMessages.listRecentBySession(
      request.sessionId,
      limit,
    );

    return {
      source: this.id,
      hasMore: result.hasMore,
      messages: result.records.map(inboundRecordToNormalizedMessage),
    };
  }

  private async handleSyncMessageCallback(
    req: http.IncomingMessage,
    url: URL,
    match: RegExpMatchArray,
    sendJson: (statusCode: number, body: unknown) => void,
  ): Promise<void> {
    try {
      this.assertAuthorized(req, url);

      if (!this.onEvent) {
        sendJson(503, { error: "Message source is not ready" });
        return;
      }

      const wechatId = decodePathSegment(match[1] ?? "");
      const robotWxid = this.config.wechatRobotWxid || wechatId;
      if (this.config.wechatRobotWxid && wechatId !== this.config.wechatRobotWxid) {
        this.logger.warn(
          { wechatId, expectedWechatId: this.config.wechatRobotWxid },
          "收到非当前机器人 wxid 的回调，已忽略",
        );
        sendJson(202, { success: true, ignored: true, reason: "wechat_id_mismatch" });
        return;
      }

      this.status.connected = true;
      const body = await readJsonBody(req);
      const syncMessage = extractWechatRobotSyncMessage(body);
      if (!syncMessage) {
        sendJson(400, { error: "Invalid SyncMessage callback payload" });
        return;
      }

      const inputs = normalizeWechatRobotSyncMessage({
        source: this.id,
        robotWxid,
        wechatId,
        payload: syncMessage,
        botProfile: this.config.botProfile,
      });

      let insertedCount = 0;
      let duplicateCount = 0;
      let historicalCount = 0;
      let dispatchedCount = 0;
      for (const input of inputs) {
        const result = await this.inboundMessages.insertIfNew(input);
        if (!result.inserted) {
          duplicateCount += 1;
          continue;
        }

        insertedCount += 1;
        if (result.record.createdAtUnixMs < this.dispatchAfterUnixMs) {
          historicalCount += 1;
          continue;
        }

        const resolvedRecord = await this.resolveSenderName(result.record);
        const message = inboundRecordToNormalizedMessage(resolvedRecord);
        dispatchedCount += 1;
        await this.onEvent({
          source: this.id,
          event: "message.new",
          sessionId: message.sessionId,
          messageKey: resolvedRecord.messageKey,
          groupName: message.groupName,
          content: message.content,
          sourceName: message.senderName,
          receivedAtUnixMs: Date.now(),
          normalizedMessage: message,
          raw: resolvedRecord.rawPayload,
        });
      }

      if (historicalCount > 0) {
        this.logger.info(
          {
            received: inputs.length,
            inserted: insertedCount,
            historical: historicalCount,
            dispatchAfter: new Date(this.dispatchAfterUnixMs).toISOString(),
          },
          "微信 HTTP 回调包含历史消息，已跳过业务派发",
        );
      }

      this.status.lastMessageAt = new Date().toISOString();
      sendJson(200, {
        success: true,
        received: inputs.length,
        inserted: insertedCount,
        duplicated: duplicateCount,
        historical: historicalCount,
        dispatched: dispatchedCount,
      });
    } catch (error) {
      if (error instanceof CallbackHttpError) {
        sendJson(error.statusCode, { error: error.message });
        return;
      }

      this.logger.error({ err: error }, "处理微信机器人 HTTP 回调失败");
      sendJson(500, { error: "Internal Server Error" });
    }
  }

  private async handleLogoutCallback(
    req: http.IncomingMessage,
    url: URL,
    match: RegExpMatchArray,
    sendJson: (statusCode: number, body: unknown) => void,
  ): Promise<void> {
    try {
      this.assertAuthorized(req, url);

      const wechatId = decodePathSegment(match[1] ?? "");
      const robotWxid = this.config.wechatRobotWxid || wechatId;
      if (this.config.wechatRobotWxid && wechatId !== this.config.wechatRobotWxid) {
        this.logger.warn(
          { wechatId, expectedWechatId: this.config.wechatRobotWxid },
          "收到非当前机器人 wxid 的登出回调，已忽略",
        );
        sendJson(202, { success: true, ignored: true, reason: "wechat_id_mismatch" });
        return;
      }

      const body = await readOptionalJsonBody(req);
      const bodyWxid = readStringField(body, "wxid") ?? readStringField(body, "WxID");
      if (bodyWxid && bodyWxid !== robotWxid) {
        this.logger.warn(
          { wechatId, robotWxid, bodyWxid },
          "登出回调 body wxid 与当前机器人不一致，已忽略",
        );
        sendJson(202, { success: true, ignored: true, reason: "body_wxid_mismatch" });
        return;
      }

      const logoutType = readStringField(body, "type");
      const logoutStatus = readStringField(body, "status");
      if (!logoutType || logoutType === "offline") {
        this.status.connected = false;
      }

      this.logger.warn(
        { wechatId, wxid: bodyWxid, type: logoutType, status: logoutStatus },
        "收到微信机器人登出回调",
      );
      sendJson(200, { success: true });
    } catch (error) {
      if (error instanceof CallbackHttpError) {
        sendJson(error.statusCode, { error: error.message });
        return;
      }

      this.logger.error({ err: error }, "处理微信机器人登出回调失败");
      sendJson(500, { error: "Internal Server Error" });
    }
  }

  private assertAuthorized(req: http.IncomingMessage, url: URL): void {
    const expected = this.config.wechatCallbackToken;
    if (!expected) {
      return;
    }

    const headerToken = headerValue(req.headers["x-gateway-callback-token"]);
    const queryToken = url.searchParams.get("token") ?? undefined;
    const bearerToken = parseBearerToken(req.headers.authorization);
    if ([headerToken, queryToken, bearerToken].includes(expected)) {
      return;
    }

    throw new CallbackHttpError(401, "Unauthorized");
  }

  private async resolveSenderName(
    record: InboundMessageRecord,
  ): Promise<InboundMessageRecord> {
    if (!record.isGroup || record.isFromBot || record.isSelfSent) {
      return record;
    }

    const senderName = await this.memberNameResolver.resolveSenderName({
      sessionId: record.sessionId,
      senderId: record.senderId,
      currentSenderName: record.senderName,
    });
    if (senderName === record.senderName) {
      return record;
    }

    return this.inboundMessages.updateSenderName(record.id, senderName);
  }
}

class CallbackHttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBodyText(req);
  if (!raw.trim()) {
    throw new CallbackHttpError(400, "Request body is empty");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CallbackHttpError(400, "Request body is not valid JSON");
  }
}

async function readOptionalJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBodyText(req);
  if (!raw.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CallbackHttpError(400, "Request body is not valid JSON");
  }
}

async function readBodyText(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > CALLBACK_BODY_LIMIT_BYTES) {
      throw new CallbackHttpError(413, "Request body too large");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CallbackHttpError(400, "Invalid wechatID path segment");
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function parseBearerToken(value: string | undefined): string | undefined {
  if (!value?.startsWith("Bearer ")) {
    return undefined;
  }
  return value.slice("Bearer ".length).trim() || undefined;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
