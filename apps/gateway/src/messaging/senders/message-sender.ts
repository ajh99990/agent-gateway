import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { Logger } from "pino";
import type { AppConfig } from "../../config.js";
import type { OutboundMessageSender, SendMessageInput } from "../../plugins/types.js";

interface JsonResponse {
  statusCode: number;
  bodyText: string;
  body: unknown;
}

interface WechatAdminSendTextPayload {
  id: number;
  to_wxid: string;
  content: string;
  at: string[];
}

interface WechatAdminMessageSenderOptions {
  baseUrl: string;
  apiToken: string;
  robotId: number;
  timeoutMs: number;
  minIntervalMs: number;
  tlsRejectUnauthorized: boolean;
}

export function createMessageSender(config: AppConfig, logger: Logger): OutboundMessageSender {
  if (config.messageSender === "log") {
    return new LogMessageSender(logger);
  }

  if (!config.wechatAdminBaseUrl) {
    throw new Error("MESSAGE_SENDER=wechat-admin 需要配置 WECHAT_ADMIN_BASE_URL");
  }
  if (!config.wechatAdminApiToken) {
    throw new Error("MESSAGE_SENDER=wechat-admin 需要配置 WECHAT_ADMIN_API_TOKEN");
  }
  if (!config.wechatAdminRobotId || config.wechatAdminRobotId <= 0) {
    throw new Error("MESSAGE_SENDER=wechat-admin 需要配置有效的 WECHAT_ADMIN_ROBOT_ID");
  }

  return new WechatAdminMessageSender(
    {
      baseUrl: config.wechatAdminBaseUrl,
      apiToken: config.wechatAdminApiToken,
      robotId: config.wechatAdminRobotId,
      timeoutMs: config.wechatAdminSendTimeoutMs,
      minIntervalMs: config.wechatAdminSendMinIntervalMs,
      tlsRejectUnauthorized: config.wechatAdminTlsRejectUnauthorized,
    },
    logger,
  );
}

export class LogMessageSender implements OutboundMessageSender {
  public constructor(private readonly logger: Logger) {}

  public async sendMessage(input: SendMessageInput): Promise<void> {
    this.logger.info(
      {
        sessionId: input.sessionId,
        groupName: input.groupName,
        replyToFingerprint: input.replyToMessage?.fingerprint,
        atSender: input.atSender,
        atWxids: input.atWxids,
        text: input.text,
      },
      "插件发送消息占位：真实微信发送逻辑尚未启用",
    );
  }
}

export class WechatAdminMessageSender implements OutboundMessageSender {
  private pendingSend: Promise<void> = Promise.resolve();
  private nextSendAt = 0;

  public constructor(
    private readonly options: WechatAdminMessageSenderOptions,
    private readonly logger: Logger,
  ) {}

  public async sendMessage(input: SendMessageInput): Promise<void> {
    const sendTask = this.pendingSend.then(() => this.sendWithThrottle(input));
    this.pendingSend = sendTask.catch(() => undefined);
    await sendTask;
  }

  private async sendWithThrottle(input: SendMessageInput): Promise<void> {
    await this.waitForTurn();

    const payload: WechatAdminSendTextPayload = {
      id: this.options.robotId,
      to_wxid: input.sessionId,
      content: input.text,
      at: this.resolveAtWxids(input),
    };
    const endpoint = this.buildSendTextEndpoint();

    const response = await this.postJson(endpoint, payload);
    this.assertSuccessfulResponse(response);

    this.logger.info(
      {
        sessionId: input.sessionId,
        groupName: input.groupName,
        robotId: this.options.robotId,
        atCount: payload.at.length,
        replyToFingerprint: input.replyToMessage?.fingerprint,
      },
      "微信后台发送文本消息成功",
    );
  }

  private resolveAtWxids(input: SendMessageInput): string[] {
    const wxids = new Set<string>();
    for (const wxid of input.atWxids ?? []) {
      const trimmed = wxid.trim();
      if (trimmed) {
        wxids.add(trimmed);
      }
    }

    if (input.atSender && input.replyToMessage && !input.replyToMessage.isFromBot) {
      const senderId = input.replyToMessage.senderId.trim();
      if (senderId) {
        wxids.add(senderId);
      }
    }

    return [...wxids];
  }

  private async waitForTurn(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextSendAt - now);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.nextSendAt = Date.now() + this.options.minIntervalMs;
  }

  private buildSendTextEndpoint(): URL {
    const endpoint = new URL("/api/v1/message/send/text", this.options.baseUrl);
    endpoint.searchParams.set("id", String(this.options.robotId));
    return endpoint;
  }

  private async postJson(endpoint: URL, payload: WechatAdminSendTextPayload): Promise<JsonResponse> {
    const bodyText = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(bodyText)),
      "X-API-Token": this.options.apiToken,
    };

    const requestOptions: HttpRequestOptions & HttpsRequestOptions = {
      method: "POST",
      headers,
    };

    if (endpoint.protocol === "https:") {
      requestOptions.rejectUnauthorized = this.options.tlsRejectUnauthorized;
    }

    const transport = endpoint.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<JsonResponse>((resolve, reject) => {
      const request = transport(endpoint, requestOptions, (response) => {
        collectResponseBody(response)
          .then((responseBodyText) => {
            resolve({
              statusCode: response.statusCode ?? 0,
              bodyText: responseBodyText,
              body: parseJsonOrUndefined(responseBodyText),
            });
          })
          .catch(reject);
      });

      request.setTimeout(this.options.timeoutMs, () => {
        request.destroy(new Error(`微信后台发送文本消息超时：${this.options.timeoutMs}ms`));
      });
      request.on("error", reject);
      request.write(bodyText);
      request.end();
    });
  }

  private assertSuccessfulResponse(response: JsonResponse): void {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `微信后台发送文本消息失败，HTTP ${response.statusCode}: ${trimResponse(response.bodyText)}`,
      );
    }

    if (!isRecord(response.body)) {
      return;
    }

    const success = readBoolean(response.body, "success") ?? readBoolean(response.body, "Success");
    if (success === false) {
      throw new Error(`微信后台发送文本消息失败：${readMessage(response.body)}`);
    }

    const code = readNumber(response.body, "code") ?? readNumber(response.body, "Code");
    if (code !== undefined && code !== 0 && code !== 200) {
      throw new Error(`微信后台发送文本消息失败，code=${code}：${readMessage(response.body)}`);
    }
  }
}

async function collectResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonOrUndefined(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readMessage(record: Record<string, unknown>): string {
  const message = record.message ?? record.Message ?? record.error ?? record.Error;
  return typeof message === "string" && message.trim() ? message : JSON.stringify(record);
}

function trimResponse(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}
