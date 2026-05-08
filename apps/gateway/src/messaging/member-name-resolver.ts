import type { Logger } from "pino";
import type {
  WechatAdminChatRoomMember,
  WechatAdminClient,
} from "../integrations/wechat-admin-client.js";
import { isGroupSession } from "./message-utils.js";

export interface ResolveSenderNameInput {
  sessionId: string;
  senderId: string;
  currentSenderName?: string;
}

export class ChatRoomMemberNameResolver {
  public constructor(
    private readonly wechatAdminClient: WechatAdminClient,
    private readonly logger: Logger,
  ) {}

  public async resolveSenderName(input: ResolveSenderNameInput): Promise<string> {
    const fallback = normalizeDisplayName(input.currentSenderName) || input.senderId;
    if (!isGroupSession(input.sessionId) || !input.senderId.trim()) {
      return fallback;
    }

    if (!this.wechatAdminClient.isConfigured()) {
      this.logger.debug(
        {
          sessionId: input.sessionId,
          senderId: input.senderId,
          missingConfig: this.wechatAdminClient.getMissingConfigKeys(),
        },
        "微信后台群成员查询未配置，senderName 回退为现有值",
      );
      return fallback;
    }

    try {
      const member = await this.wechatAdminClient.getChatRoomMember({
        chatRoomId: input.sessionId,
        wechatId: input.senderId,
      });
      return resolveChatRoomMemberDisplayName(member) || fallback;
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          senderId: input.senderId,
        },
        "查询微信群成员展示名失败，senderName 回退为现有值",
      );
      return fallback;
    }
  }
}

export function resolveChatRoomMemberDisplayName(
  member: WechatAdminChatRoomMember | null | undefined,
): string | undefined {
  if (!member) {
    return undefined;
  }

  return (
    normalizeDisplayName(member.remark) ||
    normalizeDisplayName(member.nickname) ||
    normalizeDisplayName(member.alias) ||
    normalizeDisplayName(member.wechat_id)
  );
}

function normalizeDisplayName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
