CREATE TABLE "plugin_operation_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_operation_runs_key_unique" UNIQUE("plugin_id","scope","scope_id","operation_key"),
	CONSTRAINT "plugin_operation_runs_scope_check" CHECK ("plugin_operation_runs"."scope" in ('global', 'session', 'sender')),
	CONSTRAINT "plugin_operation_runs_status_check" CHECK ("plugin_operation_runs"."status" in ('running', 'succeeded', 'failed'))
);
