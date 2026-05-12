CREATE TABLE "expedition_casts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"group_name" text,
	"date_key" text NOT NULL,
	"caster_id" text NOT NULL,
	"caster_name" text NOT NULL,
	"target_id" text NOT NULL,
	"target_name" text NOT NULL,
	"cast_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expedition_casts_daily_caster_target_unique" UNIQUE("session_id","date_key","caster_id","target_id"),
	CONSTRAINT "expedition_casts_type_check" CHECK ("expedition_casts"."cast_type" in ('blessing', 'jinx'))
);
--> statement-breakpoint
CREATE TABLE "expedition_random_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"group_name" text,
	"date_key" text NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"title" text NOT NULL,
	"message_text" text NOT NULL,
	"target_sender_id" text,
	"target_sender_name" text,
	"effect_value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expedition_random_events_target_unique" UNIQUE("session_id","date_key","event_key","target_sender_id"),
	CONSTRAINT "expedition_random_events_type_check" CHECK ("expedition_random_events"."event_type" in ('flavor', 'global', 'targeted', 'tradeoff', 'idle'))
);
--> statement-breakpoint
CREATE INDEX "expedition_casts_target_idx" ON "expedition_casts" USING btree ("session_id","date_key","target_id");--> statement-breakpoint
CREATE INDEX "expedition_casts_caster_idx" ON "expedition_casts" USING btree ("session_id","date_key","caster_id");--> statement-breakpoint
CREATE INDEX "expedition_random_events_session_date_idx" ON "expedition_random_events" USING btree ("session_id","date_key");--> statement-breakpoint
CREATE INDEX "expedition_random_events_target_idx" ON "expedition_random_events" USING btree ("session_id","date_key","target_sender_id");