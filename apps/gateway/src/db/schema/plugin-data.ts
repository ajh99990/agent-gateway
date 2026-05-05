import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { JsonValue } from "../json.js";

export const pluginKv = pgTable(
  "plugin_kv",
  {
    pluginId: text("plugin_id").notNull(),
    sessionId: text("session_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value_json").$type<JsonValue>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.pluginId, table.sessionId, table.key],
      name: "plugin_kv_pk",
    }),
  ],
);
