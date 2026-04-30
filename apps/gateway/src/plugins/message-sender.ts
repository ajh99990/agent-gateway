import type { Logger } from "pino";
import type { SendMessageInput } from "./types.js";

export class MessageSender {
  public constructor(private readonly logger: Logger) {}

  public async sendMessage(input: SendMessageInput): Promise<void> {
    this.logger.info(
      {
        sessionId: input.sessionId,
        groupName: input.groupName,
        replyToFingerprint: input.replyToMessage?.fingerprint,
        text: input.text,
      },
      "插件发送消息占位：真实微信发送逻辑尚未实现",
    );
  }
}

