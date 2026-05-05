import http from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { PluginAdminError, PluginAdminService } from "../plugins/plugin-admin-service.js";
import type { HealthSnapshot } from "../types.js";

export interface GatewayHttpRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  match: RegExpMatchArray;
  sendJson(statusCode: number, body: unknown): void;
}

export interface GatewayHttpRoute {
  method: string;
  pathPattern: RegExp;
  handle(context: GatewayHttpRouteContext): Promise<void>;
}

/**
 * GatewayHttpServer 承担网关自己的 HTTP 控制面。
 *
 * 当前公开两类路由：
 * - GET /health：探活和运行快照，不鉴权
 * - /admin/*：管理 API，必须配置并携带 GATEWAY_ADMIN_TOKEN
 */
export class GatewayHttpServer {
  private server?: http.Server;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly getSnapshot: () => Promise<HealthSnapshot>,
    private readonly pluginAdmin: PluginAdminService,
    private readonly extraRoutes: GatewayHttpRoute[] = [],
  ) {}

  public async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.gatewayPort, this.config.gatewayHost, () => {
        resolve();
      });
    });

    this.logger.info(
      {
        host: this.config.gatewayHost,
        port: this.config.gatewayPort,
        adminApiEnabled: Boolean(this.config.gatewayAdminToken),
      },
      "Gateway HTTP 服务已启动，可通过 /health 查看状态",
    );
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? this.config.gatewayHost}`);

      if (req.method === "GET" && url.pathname === "/health") {
        await this.handleHealth(res);
        return;
      }

      const extraRouteHandled = await this.tryHandleExtraRoute(req, res, url);
      if (extraRouteHandled) {
        return;
      }

      if (url.pathname.startsWith("/admin/")) {
        await this.handleAdmin(req, res, url);
        return;
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (error) {
      if (error instanceof PluginAdminError) {
        sendJson(res, error.statusCode, { error: error.message });
        return;
      }

      this.logger.error({ err: error }, "Gateway HTTP 请求处理失败");
      sendJson(res, 500, { error: "Internal Server Error" });
    }
  }

  private async tryHandleExtraRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = req.method?.toUpperCase() ?? "";
    for (const route of this.extraRoutes) {
      if (method !== route.method.toUpperCase()) {
        continue;
      }

      const match = url.pathname.match(route.pathPattern);
      if (!match) {
        continue;
      }

      await route.handle({
        req,
        res,
        url,
        match,
        sendJson: (statusCode, body) => sendJson(res, statusCode, body),
      });
      return true;
    }

    return false;
  }

  private async handleHealth(res: http.ServerResponse): Promise<void> {
    const snapshot = await this.getSnapshot();
    sendJson(res, 200, snapshot);
  }

  private async handleAdmin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.config.gatewayAdminToken) {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }

    if (!this.isAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/plugins") {
      sendJson(res, 200, {
        plugins: this.pluginAdmin.listPlugins(),
      });
      return;
    }

    const sessionPluginsMatch = matchPath(
      url.pathname,
      /^\/admin\/sessions\/([^/]+)\/plugins$/,
    );
    if (req.method === "GET" && sessionPluginsMatch) {
      const sessionId = decodePathSegment(sessionPluginsMatch[1]!);
      sendJson(res, 200, {
        sessionId,
        plugins: await this.pluginAdmin.listSessionPluginStates(sessionId),
      });
      return;
    }

    const pluginMutationMatch = matchPath(
      url.pathname,
      /^\/admin\/sessions\/([^/]+)\/plugins\/([^/]+)\/(enable|disable)$/,
    );
    if (req.method === "POST" && pluginMutationMatch) {
      const sessionId = decodePathSegment(pluginMutationMatch[1]!);
      const pluginId = decodePathSegment(pluginMutationMatch[2]!);
      const enabled = pluginMutationMatch[3] === "enable";
      const plugin = await this.pluginAdmin.setPluginEnabled(sessionId, pluginId, enabled);
      sendJson(res, 200, {
        sessionId,
        plugin,
      });
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const expected = this.config.gatewayAdminToken;
    if (!expected) {
      return false;
    }

    return req.headers.authorization === `Bearer ${expected}`;
  }
}

function matchPath(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PluginAdminError(`Invalid path segment: ${value}`, 400);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
