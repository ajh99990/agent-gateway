import { sql } from "drizzle-orm";
import {
  bigserial,
  bigint,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../../db/json.js";

export const expeditionEntries = pgTable(
  "expedition_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    groupName: text("group_name"),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name").notNull(),
    dateKey: text("date_key").notNull(),
    strategy: text("strategy").notNull(),
    stake: integer("stake").notNull(),
    allIn: boolean("all_in").default(false).notNull(),
    status: text("status").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    unique("expedition_entries_daily_sender_unique").on(
      table.sessionId,
      table.dateKey,
      table.senderId,
    ),
    check("expedition_entries_stake_positive", sql`${table.stake} > 0`),
    check("expedition_entries_revision_positive", sql`${table.revision} > 0`),
    check(
      "expedition_entries_strategy_check",
      sql`${table.strategy} in ('steady', 'adventure', 'crazy')`,
    ),
    check(
      "expedition_entries_status_check",
      sql`${table.status} in ('registered', 'cancelled', 'settled')`,
    ),
  ],
);

export const expeditionPlayers = pgTable(
  "expedition_players",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name").notNull(),
    currentDepth: integer("current_depth").default(0).notNull(),
    runHighDepth: integer("run_high_depth").default(0).notNull(),
    totalPurification: integer("total_purification").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("expedition_players_session_sender_unique").on(table.sessionId, table.senderId),
    check("expedition_players_current_depth_non_negative", sql`${table.currentDepth} >= 0`),
    check("expedition_players_run_high_depth_non_negative", sql`${table.runHighDepth} >= 0`),
    check(
      "expedition_players_total_purification_non_negative",
      sql`${table.totalPurification} >= 0`,
    ),
  ],
);

export const expeditionRelics = pgTable(
  "expedition_relics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    name: text("name").notNull(),
    rarity: text("rarity").notNull(),
    effectType: text("effect_type").notNull(),
    effectValue: jsonb("effect_value").$type<JsonValue>().notNull(),
    description: text("description").notNull(),
    acquiredDateKey: text("acquired_date_key").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "expedition_relics_rarity_check",
      sql`${table.rarity} in ('common', 'rare', 'epic', 'legendary')`,
    ),
    check(
      "expedition_relics_effect_type_check",
      sql`${table.effectType} in ('survival', 'greed', 'dive', 'luck', 'purification', 'curse')`,
    ),
  ],
);

export const expeditionWorlds = pgTable(
  "expedition_worlds",
  {
    sessionId: text("session_id").primaryKey(),
    groupName: text("group_name"),
    bossName: text("boss_name").notNull(),
    bossMaxPollution: bigint("boss_max_pollution", { mode: "number" }).notNull(),
    bossPollution: bigint("boss_pollution", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("expedition_worlds_boss_max_pollution_positive", sql`${table.bossMaxPollution} > 0`),
    check("expedition_worlds_boss_pollution_non_negative", sql`${table.bossPollution} >= 0`),
  ],
);

export const expeditionReports = pgTable(
  "expedition_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    groupName: text("group_name"),
    dateKey: text("date_key").notNull(),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name").notNull(),
    strategy: text("strategy").notNull(),
    stake: integer("stake").notNull(),
    outcome: text("outcome").notNull(),
    startDepth: integer("start_depth").notNull(),
    targetDepth: integer("target_depth").notNull(),
    finalDepth: integer("final_depth").notNull(),
    survivalRateBasisPoints: integer("survival_rate_basis_points").notNull(),
    multiplierBasisPoints: integer("multiplier_basis_points").notNull(),
    rewardPoints: integer("reward_points").default(0).notNull(),
    lostPoints: integer("lost_points").default(0).notNull(),
    purification: integer("purification").default(0).notNull(),
    deathReason: text("death_reason"),
    relicName: text("relic_name"),
    relicRarity: text("relic_rarity"),
    specialEventText: text("special_event_text"),
    details: jsonb("details").$type<JsonValue>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("expedition_reports_daily_sender_unique").on(
      table.sessionId,
      table.dateKey,
      table.senderId,
    ),
    check("expedition_reports_stake_positive", sql`${table.stake} > 0`),
    check(
      "expedition_reports_outcome_check",
      sql`${table.outcome} in ('survived', 'dead')`,
    ),
    check(
      "expedition_reports_strategy_check",
      sql`${table.strategy} in ('steady', 'adventure', 'crazy')`,
    ),
  ],
);
