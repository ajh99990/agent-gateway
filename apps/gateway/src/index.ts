import { loadConfig } from "./config.js";
import {
  DefaultPointsService,
  GatewaySessionStore,
  InboundMessageStore,
  PostgresPluginOperationRunStore,
  PointsStore,
  PostgresPluginDataStore,
  PostgresStore,
} from "./db/index.js";
import { GatewayHttpServer } from "./http/gateway-http-server.js";
import { createLogger } from "./infra/logger.js";
import { RedisStore } from "./infra/redis-store.js";
import { AgentRuntimeClient } from "./integrations/agent-runtime-client.js";
import { GraphitiClient } from "./integrations/graphiti-client.js";
import { EventGateway } from "./messaging/event-gateway.js";
import { createMessageSender } from "./messaging/senders/message-sender.js";
import { WechatHttpMessageSource } from "./messaging/sources/wechat-http-message-source.js";
import { WeFlowClient } from "./messaging/sources/weflow-client.js";
import { WeFlowMessageSource } from "./messaging/sources/weflow-message-source.js";
import { createGatewayPlugins } from "./plugins/index.js";
import { PluginAdminService } from "./plugins/plugin-admin-service.js";
import { PluginRouter } from "./plugins/plugin-router.js";
import { PostgresPluginStateStore } from "./plugins/plugin-state-store.js";
import type { PluginCommonServices } from "./plugins/types.js";
import { BullMqScheduler } from "./scheduler/index.js";

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
  if (config.messageSource === "wechat-http" && !config.enableHealthServer) {
    throw new Error("MESSAGE_SOURCE=wechat-http 需要启用 Gateway HTTP 服务");
  }

  // 下面这几步是在做依赖装配：先把各个组件实例化，再交给 EventGateway 协作。
  const redisStore = new RedisStore(config, logger);
  const postgresStore = new PostgresStore(config, logger);
  const inboundMessageStore = new InboundMessageStore(postgresStore.db);
  const gatewaySessionStore = new GatewaySessionStore(postgresStore.db);
  const weflowMessageSource = new WeFlowMessageSource(new WeFlowClient(config, logger), config);
  const wechatHttpMessageSource = new WechatHttpMessageSource(
    config,
    logger,
    inboundMessageStore,
  );
  const messageSource =
    config.messageSource === "wechat-http" ? wechatHttpMessageSource : weflowMessageSource;
  const messageRoutes =
    config.messageSource === "wechat-http" ? wechatHttpMessageSource.getRoutes() : [];
  const agentRuntimeClient = new AgentRuntimeClient(config, logger);
  const graphitiClient = new GraphitiClient(config, logger);
  const pluginStateStore = new PostgresPluginStateStore(postgresStore.db);
  const pluginDataStore = new PostgresPluginDataStore(postgresStore.db);
  const operationRunStore = new PostgresPluginOperationRunStore(postgresStore.db);
  const pointsStore = new PointsStore(postgresStore.db);
  const pointsService = new DefaultPointsService(pointsStore);
  const messageSender = createMessageSender(config, logger);
  const scheduler = new BullMqScheduler(config, logger);
  const pluginServices: PluginCommonServices = {
    sendMessage: (input) => messageSender.sendMessage(input),
    pluginState: pluginStateStore,
    pluginData: pluginDataStore,
    operationRuns: operationRunStore,
    points: pointsService,
    scheduler,
    logger,
    adminWechatIds: config.pluginAdminWechatIds,
  };
  const gatewayPlugins = createGatewayPlugins({
    config,
    db: postgresStore.db,
    services: pluginServices,
  });
  let scheduledJobCount = 0;
  for (const plugin of gatewayPlugins) {
    for (const job of plugin.scheduledJobs ?? []) {
      scheduler.registerJob(job);
      scheduledJobCount += 1;
    }
  }

  const pluginRouter = new PluginRouter({
    config,
    historyProvider: messageSource,
    services: pluginServices,
    plugins: gatewayPlugins,
  });
  const pluginAdminService = new PluginAdminService(
    gatewayPlugins,
    pluginStateStore,
    pluginRouter.getServices(),
  );
  const gateway = new EventGateway(
    config,
    logger,
    redisStore,
    messageSource,
    messageSource,
    agentRuntimeClient,
    graphitiClient,
    pluginRouter,
    gatewaySessionStore,
  );

  const httpServer = config.enableHealthServer
    ? new GatewayHttpServer(
        config,
        logger,
        async () => {
          const snapshot = await gateway.getHealthSnapshot();
          let postgresStatus: "ok" | "error" = "ok";

          try {
            await postgresStore.ping();
          } catch {
            postgresStatus = "error";
          }

          return {
            ...snapshot,
            postgres: postgresStatus,
            scheduler: await scheduler.getSnapshot(),
          };
        },
        pluginAdminService,
        messageRoutes,
      )
    : undefined;

  // 启动顺序上，先让后台调度和消息入口工作起来，再开放健康检查。
  await postgresStore.ping();
  await scheduler.start();
  await gateway.start();
  if (httpServer) {
    await httpServer.start();
  }

  logger.info(
    {
      weflowBaseUrl: config.weflowBaseUrl,
      messageSource: config.messageSource,
      messageSender: config.messageSender,
      agentRuntimeUrl: config.agentRuntimeUrl,
      graphitiEnabled: graphitiClient.isEnabled(),
      groupOnly: config.groupOnly,
      pluginCount: gatewayPlugins.length,
      scheduledJobCount,
      postgresEnabled: true,
    },
    "网关启动完成，开始监听消息源",
  );

  let shuttingDown = false;

  /**
   * shutdown 会在收到 Ctrl+C 或进程终止信号时执行。
   *
   * 顺序上先停 HTTP server，再停 gateway 和 scheduler，再断 Redis，
   * 这样能尽量避免“外部还在探活，但内部其实已经开始收尾”的混乱状态。
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "收到退出信号，开始关闭 event-gateway");
    await httpServer?.stop();
    await gateway.stop();
    await scheduler.stop();
    await postgresStore.disconnect();
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
