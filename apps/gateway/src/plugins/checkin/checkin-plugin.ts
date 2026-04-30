import type { GatewayPlugin } from "../types.js";

export function createCheckinPlugin(): GatewayPlugin {
  return {
    id: "checkin",
    name: "签到",
    keywords: ["签到"],
    async handle(context) {
      context.services.logger.info(
        {
          sessionId: context.sessionId,
          senderId: context.message.senderId,
          messageFingerprint: context.message.fingerprint,
        },
        "签到插件已收到签到消息",
      );

      return {
        replyText: "签到成功。",
      };
    },
  };
}

