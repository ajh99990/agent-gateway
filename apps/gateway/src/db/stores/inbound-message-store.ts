import { and, desc, eq } from "drizzle-orm";
import type { MessageContentType, NormalizedMessage } from "../../types.js";
import type { GatewayDatabase } from "../client.js";
import type { JsonValue } from "../json.js";
import { inboundMessages } from "../schema/index.js";

export interface InboundMessageRecord {
  id: number;
  source: string;
  messageKey: string;
  sessionId: string;
  groupName?: string;
  senderId: string;
  senderName: string;
  receiverId?: string;
  robotWxid?: string;
  content: string;
  rawContent: string;
  contentType: MessageContentType;
  isGroup: boolean;
  isSelfSent: boolean;
  isFromBot: boolean;
  isMentionBot: boolean;
  createdAtUnixMs: number;
  rawPayload?: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInboundMessageInput {
  source: string;
  messageKey: string;
  sessionId: string;
  groupName?: string;
  senderId: string;
  senderName: string;
  receiverId?: string;
  robotWxid?: string;
  content: string;
  rawContent: string;
  contentType: MessageContentType;
  isGroup: boolean;
  isSelfSent: boolean;
  isFromBot: boolean;
  isMentionBot: boolean;
  createdAtUnixMs: number;
  rawPayload?: JsonValue;
}

export interface InsertInboundMessageResult {
  inserted: boolean;
  record: InboundMessageRecord;
}

export interface RecentInboundMessagesResult {
  hasMore: boolean;
  records: InboundMessageRecord[];
}

export class InboundMessageStore {
  public constructor(private readonly db: GatewayDatabase) {}

  public async insertIfNew(input: CreateInboundMessageInput): Promise<InsertInboundMessageResult> {
    const now = new Date();
    const insertedRows = await this.db
      .insert(inboundMessages)
      .values({
        source: input.source,
        messageKey: input.messageKey,
        sessionId: input.sessionId,
        groupName: input.groupName,
        senderId: input.senderId,
        senderName: input.senderName,
        receiverId: input.receiverId,
        robotWxid: input.robotWxid,
        content: input.content,
        rawContent: input.rawContent,
        contentType: input.contentType,
        isGroup: input.isGroup,
        isSelfSent: input.isSelfSent,
        isFromBot: input.isFromBot,
        isMentionBot: input.isMentionBot,
        createdAtUnixMs: input.createdAtUnixMs,
        rawPayload: input.rawPayload,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [inboundMessages.source, inboundMessages.messageKey],
      })
      .returning();

    const inserted = insertedRows[0];
    if (inserted) {
      return {
        inserted: true,
        record: toRecord(inserted),
      };
    }

    const existing = await this.findBySourceMessageKey(input.source, input.messageKey);
    if (!existing) {
      throw new Error(`入站消息写入失败，且未找到已有消息：${input.source}:${input.messageKey}`);
    }

    return {
      inserted: false,
      record: existing,
    };
  }

  public async findBySourceMessageKey(
    source: string,
    messageKey: string,
  ): Promise<InboundMessageRecord | null> {
    const rows = await this.db
      .select()
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.source, source),
          eq(inboundMessages.messageKey, messageKey),
        ),
      )
      .limit(1);

    return rows[0] ? toRecord(rows[0]) : null;
  }

  public async listRecentBySession(
    sessionId: string,
    limit: number,
  ): Promise<RecentInboundMessagesResult> {
    const safeLimit = Math.max(1, limit);
    const rows = await this.db
      .select()
      .from(inboundMessages)
      .where(eq(inboundMessages.sessionId, sessionId))
      .orderBy(desc(inboundMessages.id))
      .limit(safeLimit + 1);

    return {
      hasMore: rows.length > safeLimit,
      records: rows.slice(0, safeLimit).reverse().map(toRecord),
    };
  }
}

export function inboundRecordToNormalizedMessage(record: InboundMessageRecord): NormalizedMessage {
  return {
    sessionId: record.sessionId,
    groupName: record.groupName,
    localId: record.id,
    serverId: record.messageKey,
    senderId: record.senderId,
    senderName: record.senderName,
    timestamp: new Date(record.createdAtUnixMs).toISOString(),
    createdAtUnixMs: record.createdAtUnixMs,
    content: record.content,
    rawContent: record.rawContent,
    contentType: record.contentType,
    isGroup: record.isGroup,
    isSelfSent: record.isSelfSent,
    isFromBot: record.isFromBot,
    isMentionBot: record.isMentionBot,
    fingerprint: `${record.source}:${record.id}`,
  };
}

function toRecord(row: typeof inboundMessages.$inferSelect): InboundMessageRecord {
  return {
    id: row.id,
    source: row.source,
    messageKey: row.messageKey,
    sessionId: row.sessionId,
    groupName: row.groupName ?? undefined,
    senderId: row.senderId,
    senderName: row.senderName,
    receiverId: row.receiverId ?? undefined,
    robotWxid: row.robotWxid ?? undefined,
    content: row.content,
    rawContent: row.rawContent,
    contentType: row.contentType as MessageContentType,
    isGroup: row.isGroup,
    isSelfSent: row.isSelfSent,
    isFromBot: row.isFromBot,
    isMentionBot: row.isMentionBot,
    createdAtUnixMs: row.createdAtUnixMs,
    rawPayload: row.rawPayload ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
