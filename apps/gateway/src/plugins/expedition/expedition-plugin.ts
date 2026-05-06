import type { GatewayPlugin, PluginBootstrapContext } from "../types.js";
import { ExpeditionService } from "./expedition-service.js";
import { ExpeditionStore } from "./expedition-store.js";
import {
  EXPEDITION_PLUGIN_ID,
  EXPEDITION_TIMEZONE,
} from "./expedition-types.js";

const EXPEDITION_KEYWORDS = [
  "远征",
  "加码",
  "取消远征",
  "我的战报",
  "我的遗物",
  "远征排行",
];

export function createExpeditionPlugin(context: PluginBootstrapContext): GatewayPlugin {
  const store = new ExpeditionStore(context.db);
  const service = new ExpeditionService({
    db: context.db,
    store,
    points: context.services.points,
    pluginState: context.services.pluginState,
    operationRuns: context.services.operationRuns,
    sendMessage: context.services.sendMessage,
    logger: context.services.logger.child({ pluginId: EXPEDITION_PLUGIN_ID }),
  });

  return {
    id: EXPEDITION_PLUGIN_ID,
    name: "远征",
    commands: [
      {
        keywords: EXPEDITION_KEYWORDS,
        matches(content) {
          return content === "远征" || content === "加码" || content.startsWith("远征 ");
        },
        async handle(pluginContext) {
          return service.handleMessage(pluginContext);
        },
      },
    ],
    scheduledJobs: [
      {
        id: "expedition.boost-reminder",
        name: "远征加码开放提醒",
        description: "每天 17:40 向开启远征插件的群发布加码开放提醒",
        schedule: {
          cron: "40 17 * * *",
          timezone: EXPEDITION_TIMEZONE,
        },
        options: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 60_000,
          },
        },
        async process(jobContext) {
          await service.runBoostReminder(jobContext.execution.timestamp);
        },
      },
      {
        id: "expedition.daily-settlement",
        name: "每日远征结算",
        description: "每天 17:50 结算所有群的远征报名",
        schedule: {
          cron: "50 17 * * *",
          timezone: EXPEDITION_TIMEZONE,
        },
        options: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 60_000,
          },
        },
        async process(jobContext) {
          await service.runDailySettlement(jobContext.execution.timestamp);
        },
      },
    ],
    async beforeDisable(toggleContext) {
      const replyText = await service.beforeDisable(
        toggleContext.sessionId,
        toggleContext.groupName,
      );
      return { replyText };
    },
  };
}
