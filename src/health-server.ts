import http from "node:http";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { HealthSnapshot } from "./types.js";

/**
 * HealthServer 是一个可选的极简 HTTP 服务。
 *
 * 它不参与消息处理主流程，主要用于：
 * - 确认进程是不是还活着
 * - 看 Redis / SSE / Graphiti 队列的当前状态
 * - 本地联调时快速观察运行情况
 */
export class HealthServer {
  private server?: http.Server;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly getSnapshot: () => Promise<HealthSnapshot>,
  ) {}

  /**
   * start 通常在 main() 里、gateway.start() 之后调用。
   *
   * 也就是说，正常顺序是：
   * 1. 先把真正的消息订阅和调度器启动起来
   * 2. 再开放 /health 给外部检查
   */
  public async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? this.config.gatewayHost}`);

      if (req.method !== "GET" || url.pathname !== "/health") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }

      const snapshot = await this.getSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot));
    });

    // 这里封成 Promise，是为了让 main() 可以按“先启动、再继续”这种顺序书写。
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.gatewayPort, this.config.gatewayHost, () => {
        resolve();
      });
    });

    this.logger.info(
      { host: this.config.gatewayHost, port: this.config.gatewayPort },
      "健康检查服务已启动，可通过 /health 查看运行状态",
    );
  }

  /**
   * stop 在优雅退出时调用。
   *
   * 它的作用很单纯：先停止接受新的 health 请求，
   * 再让进程继续完成后面的网关清理动作。
   */
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
}
