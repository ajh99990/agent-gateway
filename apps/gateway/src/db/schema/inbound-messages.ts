import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../json.js";

export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: text("source").notNull(),
    messageKey: text("message_key").notNull(),
    sessionId: text("session_id").notNull(),
    groupName: text("group_name"),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name").notNull(),
    receiverId: text("receiver_id"),
    robotWxid: text("robot_wxid"),
    content: text("content").notNull(),
    rawContent: text("raw_content").notNull(),
    contentType: text("content_type").notNull(),
    isGroup: boolean("is_group").default(false).notNull(),
    isSelfSent: boolean("is_self_sent").default(false).notNull(),
    isFromBot: boolean("is_from_bot").default(false).notNull(),
    isMentionBot: boolean("is_mention_bot").default(false).notNull(),
    createdAtUnixMs: bigint("created_at_unix_ms", { mode: "number" }).notNull(),
    rawPayload: jsonb("raw_payload").$type<JsonValue>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("inbound_messages_source_message_key_unique").on(table.source, table.messageKey),
    index("inbound_messages_session_id_idx").on(table.sessionId, table.id),
    check(
      "inbound_messages_content_type_check",
      sql`${table.contentType} in ('text', 'image', 'voice', 'video', 'emoji', 'unknown')`,
    ),
  ],
);
