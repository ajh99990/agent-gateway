import { AgentRuntimeClient } from "./agent-runtime-client.js";
import { loadConfig } from "./config.js";
import { EventGateway } from "./event-gateway.js";
import { GraphitiClient } from "./graphiti-client.js";
import { HealthServer } from "./health-server.js";
import { createLogger } from "./logger.js";
import { RedisStore } from "./redis-store.js";
import { WeFlowClient } from "./weflow-client.js";

/**
 * 进程入口只负责装配依赖和生命周期，不放业务逻辑。
 * 这样后面要换 HTTP 框架、加监控或者拆测试都比较容易。
 *
 * 你可以把 main() 看成整个服务的“接线台”：
 * 它负责把配置、日志、Redis、WeFlow、Graphiti、EventGateway 这些部件接起来，
 * 但不直接参与单条消息的处理判断。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // 下面这几步是在做依赖装配：先把各个组件实例化，再交给 EventGateway 协作。
  const redisStore = new RedisStore(config, logger);
  const weflowClient = new WeFlowClient(config, logger);
  const agentRuntimeClient = new AgentRuntimeClient(config, logger);
  const graphitiClient = new GraphitiClient(config, logger);
  const gateway = new EventGateway(
    config,
    logger,
    redisStore,
    weflowClient,
    agentRuntimeClient,
    graphitiClient,
  );

  const healthServer = config.enableHealthServer
    ? new HealthServer(config, logger, async () => gateway.getHealthSnapshot())
    : undefined;

  // 启动顺序上，先让真正的消息入口工作起来，再开放健康检查。
  await gateway.start();
  if (healthServer) {
    await healthServer.start();
  }

  logger.info(
    {
      weflowBaseUrl: config.weflowBaseUrl,
      agentRuntimeUrl: config.agentRuntimeUrl,
      graphitiEnabled: graphitiClient.isEnabled(),
      groupOnly: config.groupOnly,
    },
    "网关启动完成，开始监听 WeFlow 消息",
  );

  let shuttingDown = false;

  /**
   * shutdown 会在收到 Ctrl+C 或进程终止信号时执行。
   *
   * 顺序上先停 health server，再停 gateway，再断 Redis，
   * 这样能尽量避免“外部还在探活，但内部其实已经开始收尾”的混乱状态。
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "收到退出信号，开始关闭 event-gateway");
    await healthServer?.stop();
    await gateway.stop();
    await redisStore.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
