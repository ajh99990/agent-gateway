CREATE TABLE "expedition_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"group_name" text,
	"sender_id" text NOT NULL,
	"sender_name" text NOT NULL,
	"date_key" text NOT NULL,
	"strategy" text NOT NULL,
	"stake" integer NOT NULL,
	"all_in" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "expedition_entries_daily_sender_unique" UNIQUE("session_id","date_key","sender_id"),
	CONSTRAINT "expedition_entries_stake_positive" CHECK ("expedition_entries"."stake" > 0),
	CONSTRAINT "expedition_entries_revision_positive" CHECK ("expedition_entries"."revision" > 0),
	CONSTRAINT "expedition_entries_strategy_check" CHECK ("expedition_entries"."strategy" in ('steady', 'adventure', 'crazy')),
	CONSTRAINT "expedition_entries_status_check" CHECK ("expedition_entries"."status" in ('registered', 'cancelled', 'settled'))
);
--> statement-breakpoint
CREATE TABLE "expedition_players" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"sender_name" text NOT NULL,
	"current_depth" integer DEFAULT 0 NOT NULL,
	"run_high_depth" integer DEFAULT 0 NOT NULL,
	"total_purification" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expedition_players_session_sender_unique" UNIQUE("session_id","sender_id"),
	CONSTRAINT "expedition_players_current_depth_non_negative" CHECK ("expedition_players"."current_depth" >= 0),
	CONSTRAINT "expedition_players_run_high_depth_non_negative" CHECK ("expedition_players"."run_high_depth" >= 0),
	CONSTRAINT "expedition_players_total_purification_non_negative" CHECK ("expedition_players"."total_purification" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expedition_relics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"name" text NOT NULL,
	"rarity" text NOT NULL,
	"effect_type" text NOT NULL,
	"effect_value" jsonb NOT NULL,
	"description" text NOT NULL,
	"acquired_date_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expedition_relics_rarity_check" CHECK ("expedition_relics"."rarity" in ('common', 'rare', 'epic', 'legendary')),
	CONSTRAINT "expedition_relics_effect_type_check" CHECK ("expedition_relics"."effect_type" in ('survival', 'greed', 'dive', 'luck', 'purification', 'curse'))
);
--> statement-breakpoint
CREATE TABLE "expedition_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"group_name" text,
	"date_key" text NOT NULL,
	"sender_id" text NOT NULL,
	"sender_name" text NOT NULL,
	"strategy" text NOT NULL,
	"stake" integer NOT NULL,
	"outcome" text NOT NULL,
	"start_depth" integer NOT NULL,
	"target_depth" integer NOT NULL,
	"final_depth" integer NOT NULL,
	"survival_rate_basis_points" integer NOT NULL,
	"multiplier_basis_points" integer NOT NULL,
	"reward_points" integer DEFAULT 0 NOT NULL,
	"lost_points" integer DEFAULT 0 NOT NULL,
	"purification" integer DEFAULT 0 NOT NULL,
	"death_reason" text,
	"relic_name" text,
	"relic_rarity" text,
	"special_event_text" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expedition_reports_daily_sender_unique" UNIQUE("session_id","date_key","sender_id"),
	CONSTRAINT "expedition_reports_stake_positive" CHECK ("expedition_reports"."stake" > 0),
	CONSTRAINT "expedition_reports_outcome_check" CHECK ("expedition_reports"."outcome" in ('survived', 'dead')),
	CONSTRAINT "expedition_reports_strategy_check" CHECK ("expedition_reports"."strategy" in ('steady', 'adventure', 'crazy'))
);
--> statement-breakpoint
CREATE TABLE "expedition_worlds" (
	"session_id" text PRIMARY KEY NOT NULL,
	"group_name" text,
	"boss_name" text NOT NULL,
	"boss_max_pollution" bigint NOT NULL,
	"boss_pollution" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expedition_worlds_boss_max_pollution_positive" CHECK ("expedition_worlds"."boss_max_pollution" > 0),
	CONSTRAINT "expedition_worlds_boss_pollution_non_negative" CHECK ("expedition_worlds"."boss_pollution" >= 0)
);
