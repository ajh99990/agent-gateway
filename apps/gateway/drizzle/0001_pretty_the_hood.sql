CREATE TABLE "points_accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"balance" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_accounts_session_sender_unique" UNIQUE("session_id","sender_id"),
	CONSTRAINT "points_accounts_balance_non_negative" CHECK ("points_accounts"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "points_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_before" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"source" text NOT NULL,
	"description" text NOT NULL,
	"operator_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
