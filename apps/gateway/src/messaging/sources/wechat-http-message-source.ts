import type http from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "../../config.js";
import {
  inboundRecordToNormalizedMessage,
  InboundMessageStore,
} from "../../db/stores/index.js";
import type { GatewayHttpRoute } from "../../http/gateway-http-server.js";
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

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly inboundMessages: InboundMessageStore,
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
    ];
  }

  public async start(
    onEvent: (event: InboundMessageEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    this.onEvent = onEvent;
    this.status.connected = true;
    this.status.lastReadyAt = new Date().toISOString();

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
      for (const input of inputs) {
        const result = await this.inboundMessages.insertIfNew(input);
        if (!result.inserted) {
          duplicateCount += 1;
          continue;
        }

        insertedCount += 1;
        const message = inboundRecordToNormalizedMessage(result.record);
        await this.onEvent({
          source: this.id,
          event: "message.new",
          sessionId: message.sessionId,
          messageKey: result.record.messageKey,
          groupName: message.groupName,
          content: message.content,
          sourceName: message.senderName,
          receivedAtUnixMs: Date.now(),
          normalizedMessage: message,
          raw: result.record.rawPayload,
        });
      }

      this.status.lastMessageAt = new Date().toISOString();
      sendJson(200, {
        success: true,
        received: inputs.length,
        inserted: insertedCount,
        duplicated: duplicateCount,
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

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    throw new CallbackHttpError(400, "Request body is empty");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CallbackHttpError(400, "Request body is not valid JSON");
  }
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
