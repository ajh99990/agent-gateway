import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const checkinRecords = pgTable(
  "checkin_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name").notNull(),
    dateKey: text("date_key").notNull(),
    reward: integer("reward").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("checkin_records_daily_sender_unique").on(
      table.sessionId,
      table.senderId,
      table.dateKey,
    ),
    check("checkin_records_reward_positive", sql`${table.reward} > 0`),
  ],
);
