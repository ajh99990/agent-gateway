CREATE TABLE "gateway_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"group_name" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_session_states" (
	"plugin_id" text NOT NULL,
	"session_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_session_states_pk" PRIMARY KEY("plugin_id","session_id")
);
--> statement-breakpoint
CREATE INDEX "gateway_sessions_last_seen_at_idx" ON "gateway_sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "plugin_session_states_session_id_idx" ON "plugin_session_states" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "plugin_session_states_enabled_idx" ON "plugin_session_states" USING btree ("plugin_id","enabled");--> statement-breakpoint
COMMENT ON TABLE "gateway_sessions" IS 'Gateway 已见过的会话登记表，用于按群启停和定时插件查找目标群';--> statement-breakpoint
COMMENT ON COLUMN "gateway_sessions"."session_id" IS '会话 ID，群聊通常以 @chatroom 结尾';--> statement-breakpoint
COMMENT ON COLUMN "gateway_sessions"."group_name" IS '最近一次看到的群名或会话展示名';--> statement-breakpoint
COMMENT ON COLUMN "gateway_sessions"."last_seen_at" IS '最近一次从该会话收到有效入站消息的时间';--> statement-breakpoint
COMMENT ON COLUMN "gateway_sessions"."created_at" IS '记录创建时间';--> statement-breakpoint
COMMENT ON COLUMN "gateway_sessions"."updated_at" IS '记录更新时间';--> statement-breakpoint
COMMENT ON TABLE "plugin_session_states" IS '插件在单个会话内的显式启停状态';--> statement-breakpoint
COMMENT ON COLUMN "plugin_session_states"."plugin_id" IS '插件 ID';--> statement-breakpoint
COMMENT ON COLUMN "plugin_session_states"."session_id" IS '会话 ID';--> statement-breakpoint
COMMENT ON COLUMN "plugin_session_states"."enabled" IS '插件是否在该会话内启用';--> statement-breakpoint
COMMENT ON COLUMN "plugin_session_states"."created_at" IS '记录创建时间';--> statement-breakpoint
COMMENT ON COLUMN "plugin_session_states"."updated_at" IS '记录更新时间';
