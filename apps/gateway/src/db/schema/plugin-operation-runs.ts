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

export const pluginOperationRuns = pgTable(
  "plugin_operation_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pluginId: text("plugin_id").notNull(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    operationKey: text("operation_key").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").default(1).notNull(),
    metadata: jsonb("metadata").$type<JsonValue>(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("plugin_operation_runs_key_unique").on(
      table.pluginId,
      table.scope,
      table.scopeId,
      table.operationKey,
    ),
    check(
      "plugin_operation_runs_scope_check",
      sql`${table.scope} in ('global', 'session', 'sender')`,
    ),
    check(
      "plugin_operation_runs_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed')`,
    ),
  ],
);
