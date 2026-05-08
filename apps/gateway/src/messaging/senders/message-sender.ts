import type { Logger } from "pino";
import type { AppConfig } from "../../config.js";
import type { WechatAdminClient } from "../../integrations/wechat-admin-client.js";
import type { OutboundMessageSender, SendMessageInput } from "../../plugins/types.js";

export function createMessageSender(
  config: AppConfig,
  logger: Logger,
  wechatAdminClient: WechatAdminClient,
): OutboundMessageSender {
  if (config.messageSender === "log") {
    return new LogMessageSender(logger);
  }

  if (!wechatAdminClient.isConfigured()) {
    throw new Error(
      `MESSAGE_SENDER=wechat-admin 需要配置：${wechatAdminClient.getMissingConfigKeys().join(", ")}`,
    );
  }

  return new WechatAdminMessageSender(
    wechatAdminClient,
    config.wechatAdminSendMinIntervalMs,
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
    private readonly wechatAdminClient: WechatAdminClient,
    private readonly minIntervalMs: number,
    private readonly logger: Logger,
  ) {}

  public async sendMessage(input: SendMessageInput): Promise<void> {
    const sendTask = this.pendingSend.then(() => this.sendWithThrottle(input));
    this.pendingSend = sendTask.catch(() => undefined);
    await sendTask;
  }

  private async sendWithThrottle(input: SendMessageInput): Promise<void> {
    await this.waitForTurn();

    const atWxids = this.resolveAtWxids(input);
    await this.wechatAdminClient.sendTextMessage({
      toWxid: input.sessionId,
      content: input.text,
      at: atWxids,
    });

    this.logger.info(
      {
        sessionId: input.sessionId,
        groupName: input.groupName,
        atCount: atWxids.length,
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
    this.nextSendAt = Date.now() + this.minIntervalMs;
  }
}
