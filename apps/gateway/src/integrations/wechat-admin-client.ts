import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { AppConfig } from "../config.js";

interface JsonResponse {
  statusCode: number;
  bodyText: string;
  body: unknown;
}

export interface WechatAdminClientOptions {
  baseUrl?: string;
  apiToken?: string;
  robotId?: number;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
}

export interface WechatAdminSendTextInput {
  toWxid: string;
  content: string;
  at: string[];
}

interface WechatAdminSendTextPayload {
  id: number;
  to_wxid: string;
  content: string;
  at: string[];
}

export interface WechatAdminChatRoomMember {
  id?: number;
  chat_room_id?: string;
  wechat_id?: string;
  alias?: string;
  nickname?: string;
  remark?: string;
  avatar?: string;
  [key: string]: unknown;
}

export class WechatAdminClient {
  public static fromConfig(config: AppConfig): WechatAdminClient {
    return new WechatAdminClient({
      baseUrl: config.wechatAdminBaseUrl,
      apiToken: config.wechatAdminApiToken,
      robotId: config.wechatAdminRobotId,
      timeoutMs: config.wechatAdminSendTimeoutMs,
      tlsRejectUnauthorized: config.wechatAdminTlsRejectUnauthorized,
    });
  }

  public constructor(private readonly options: WechatAdminClientOptions) {}

  public isConfigured(): boolean {
    return Boolean(
      this.options.baseUrl &&
        this.options.apiToken &&
        this.options.robotId &&
        this.options.robotId > 0,
    );
  }

  public getMissingConfigKeys(): string[] {
    const missing: string[] = [];
    if (!this.options.baseUrl) missing.push("WECHAT_ADMIN_BASE_URL");
    if (!this.options.apiToken) missing.push("WECHAT_ADMIN_API_TOKEN");
    if (!this.options.robotId || this.options.robotId <= 0) {
      missing.push("WECHAT_ADMIN_ROBOT_ID");
    }
    return missing;
  }

  public async sendTextMessage(input: WechatAdminSendTextInput): Promise<void> {
    this.assertConfigured("发送文本消息");

    const robotId = this.requireRobotId();
    const payload: WechatAdminSendTextPayload = {
      id: robotId,
      to_wxid: input.toWxid,
      content: input.content,
      at: input.at,
    };
    const endpoint = this.buildEndpoint("/api/v1/message/send/text");
    endpoint.searchParams.set("id", String(robotId));

    const response = await this.postJson(endpoint, payload);
    this.assertSuccessfulResponse(response, "发送文本消息");
  }

  public async getChatRoomMember(input: {
    chatRoomId: string;
    wechatId: string;
  }): Promise<WechatAdminChatRoomMember | null> {
    this.assertConfigured("获取群成员信息");

    const endpoint = this.buildEndpoint("/api/v1/chat-room/member");
    endpoint.searchParams.set("id", String(this.requireRobotId()));
    endpoint.searchParams.set("chat_room_id", input.chatRoomId);
    endpoint.searchParams.set("wechat_id", input.wechatId);

    const response = await this.getJson(endpoint);
    this.assertSuccessfulResponse(response, "获取群成员信息");

    const body = response.body;
    if (!isRecord(body)) {
      return null;
    }

    const data = body.data ?? body.Data;
    return isRecord(data) ? (data as WechatAdminChatRoomMember) : null;
  }

  private assertConfigured(action: string): void {
    const missing = this.getMissingConfigKeys();
    if (missing.length > 0) {
      throw new Error(`微信后台${action}需要配置：${missing.join(", ")}`);
    }
  }

  private requireRobotId(): number {
    const robotId = this.options.robotId;
    if (!robotId || robotId <= 0) {
      throw new Error("缺少有效的 WECHAT_ADMIN_ROBOT_ID");
    }
    return robotId;
  }

  private buildEndpoint(pathname: string): URL {
    if (!this.options.baseUrl) {
      throw new Error("缺少 WECHAT_ADMIN_BASE_URL");
    }
    return new URL(pathname, this.options.baseUrl);
  }

  private async getJson(endpoint: URL): Promise<JsonResponse> {
    return this.requestJson("GET", endpoint);
  }

  private async postJson(endpoint: URL, payload: unknown): Promise<JsonResponse> {
    return this.requestJson("POST", endpoint, payload);
  }

  private async requestJson(
    method: "GET" | "POST",
    endpoint: URL,
    payload?: unknown,
  ): Promise<JsonResponse> {
    const bodyText = payload === undefined ? undefined : JSON.stringify(payload);
    const headers: Record<string, string> = {
      "X-API-Token": this.options.apiToken ?? "",
    };

    if (bodyText !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(bodyText));
    }

    const requestOptions: HttpRequestOptions & HttpsRequestOptions = {
      method,
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
        request.destroy(new Error(`微信后台请求超时：${this.options.timeoutMs}ms`));
      });
      request.on("error", reject);
      if (bodyText !== undefined) {
        request.write(bodyText);
      }
      request.end();
    });
  }

  private assertSuccessfulResponse(response: JsonResponse, action: string): void {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `微信后台${action}失败，HTTP ${response.statusCode}: ${trimResponse(response.bodyText)}`,
      );
    }

    if (!isRecord(response.body)) {
      return;
    }

    const success = readBoolean(response.body, "success") ?? readBoolean(response.body, "Success");
    if (success === false) {
      throw new Error(`微信后台${action}失败：${readMessage(response.body)}`);
    }

    const code = readNumber(response.body, "code") ?? readNumber(response.body, "Code");
    if (code !== undefined && code !== 0 && code !== 200) {
      throw new Error(`微信后台${action}失败，code=${code}：${readMessage(response.body)}`);
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
    return JSON.parse(trimmed) as unknown;
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
