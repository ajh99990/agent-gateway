import type { GatewayPlugin, PluginBootstrapContext } from "../types.js";
import { getBusinessDateKey } from "../../time.js";
import { formatCheckinSuccessText, formatDuplicateCheckinText } from "./checkin-content.js";
import { CheckinStore } from "./checkin-store.js";

const CHECKIN_PLUGIN_ID = "checkin";
const CHECKIN_REWARD = 10;
const CHECKIN_TIMEZONE = "Asia/Shanghai";
const CHECKIN_KEYWORDS = ["签到", "上班"];

export function createCheckinPlugin(context: PluginBootstrapContext): GatewayPlugin {
  const logger = context.services.logger.child({ pluginId: CHECKIN_PLUGIN_ID });
  const store = new CheckinStore(context.db);

  return {
    id: CHECKIN_PLUGIN_ID,
    name: "签到",
    commands: [
      {
        keywords: CHECKIN_KEYWORDS,
        async handle(pluginContext) {
          const dateKey = getBusinessDateKey(
            pluginContext.message.createdAtUnixMs,
            CHECKIN_TIMEZONE,
          );
          const senderName = pluginContext.message.senderName.trim() || pluginContext.message.senderId;

          const result = await context.db.transaction(async (tx) => {
            const checkins = store.withTransaction(tx);
            const points = context.services.points.withTransaction(tx);
            const checkin = await checkins.createDailyCheckin({
              sessionId: pluginContext.sessionId,
              senderId: pluginContext.message.senderId,
              senderName,
              dateKey,
              reward: CHECKIN_REWARD,
            });

            if (!checkin.created) {
              const balance = await points.getBalance(
                pluginContext.sessionId,
                pluginContext.message.senderId,
              );
              return {
                created: false as const,
                balanceAfter: balance.balance,
              };
            }

            const ledger = await points.earn({
              sessionId: pluginContext.sessionId,
              senderId: pluginContext.message.senderId,
              amount: CHECKIN_REWARD,
              source: CHECKIN_PLUGIN_ID,
              description: "每日签到",
              operatorId: pluginContext.message.senderId,
              idempotencyKey: [
                CHECKIN_PLUGIN_ID,
                dateKey,
                pluginContext.sessionId,
                pluginContext.message.senderId,
              ].join(":"),
              metadata: {
                pluginId: CHECKIN_PLUGIN_ID,
                action: "daily_checkin",
                dateKey,
                checkinRecordId: checkin.record.id,
              },
            });

            return {
              created: true as const,
              balanceAfter: ledger.balanceAfter,
            };
          });

          if (!result.created) {
            logger.info(
              {
                sessionId: pluginContext.sessionId,
                senderId: pluginContext.message.senderId,
                dateKey,
                messageFingerprint: pluginContext.message.fingerprint,
              },
              "用户今日已签到，跳过积分发放",
            );

            return {
              replyText: formatDuplicateCheckinText(result.balanceAfter),
            };
          }

          logger.info(
            {
              sessionId: pluginContext.sessionId,
              senderId: pluginContext.message.senderId,
              dateKey,
              reward: CHECKIN_REWARD,
              balanceAfter: result.balanceAfter,
              messageFingerprint: pluginContext.message.fingerprint,
            },
            "签到成功，已发放积分",
          );

          return {
            replyText: formatCheckinSuccessText(CHECKIN_REWARD, result.balanceAfter),
          };
        },
      },
    ],
  };
}
