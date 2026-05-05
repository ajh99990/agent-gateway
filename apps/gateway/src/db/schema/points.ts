import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../json.js";

export const pointsAccounts = pgTable(
  "points_accounts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    balance: integer("balance").default(20).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("points_accounts_session_sender_unique").on(table.sessionId, table.senderId),
    check("points_accounts_balance_non_negative", sql`${table.balance} >= 0`),
  ],
);

export const pointsLedger = pgTable(
  "points_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    delta: integer("delta").notNull(),
    balanceBefore: integer("balance_before").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    source: text("source").notNull(),
    description: text("description").notNull(),
    operatorId: text("operator_id"),
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata").$type<JsonValue>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("points_ledger_idempotency_key_unique").on(table.idempotencyKey),
  ],
);
