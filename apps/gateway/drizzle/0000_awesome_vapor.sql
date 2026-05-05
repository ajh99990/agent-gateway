CREATE TABLE "plugin_kv" (
	"plugin_id" text NOT NULL,
	"session_id" text NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_kv_pk" PRIMARY KEY("plugin_id","session_id","key")
);
