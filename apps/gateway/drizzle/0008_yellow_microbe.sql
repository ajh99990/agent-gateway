ALTER TABLE "expedition_entries" ADD COLUMN "boosted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expedition_entries" ADD COLUMN "boost_stake" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expedition_entries" ADD COLUMN "boosted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expedition_reports" ADD COLUMN "boosted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expedition_reports" ADD COLUMN "boost_stake" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expedition_entries" ADD CONSTRAINT "expedition_entries_boost_stake_non_negative" CHECK ("expedition_entries"."boost_stake" >= 0);--> statement-breakpoint
ALTER TABLE "expedition_reports" ADD CONSTRAINT "expedition_reports_boost_stake_non_negative" CHECK ("expedition_reports"."boost_stake" >= 0);