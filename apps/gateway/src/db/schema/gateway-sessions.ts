import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const gatewaySessions = pgTable(
  "gateway_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    groupName: text("group_name"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("gateway_sessions_last_seen_at_idx").on(table.lastSeenAt),
  ],
);

export const pluginSessionStates = pgTable(
  "plugin_session_states",
  {
    pluginId: text("plugin_id").notNull(),
    sessionId: text("session_id").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.pluginId, table.sessionId],
      name: "plugin_session_states_pk",
    }),
    index("plugin_session_states_session_id_idx").on(table.sessionId),
    index("plugin_session_states_enabled_idx").on(table.pluginId, table.enabled),
  ],
);
