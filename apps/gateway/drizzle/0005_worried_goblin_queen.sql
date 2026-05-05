CREATE TABLE "checkin_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"sender_name" text NOT NULL,
	"date_key" text NOT NULL,
	"reward" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkin_records_daily_sender_unique" UNIQUE("session_id","sender_id","date_key"),
	CONSTRAINT "checkin_records_reward_positive" CHECK ("checkin_records"."reward" > 0)
);
