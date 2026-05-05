CREATE TABLE "inbound_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"message_key" text NOT NULL,
	"session_id" text NOT NULL,
	"group_name" text,
	"sender_id" text NOT NULL,
	"sender_name" text NOT NULL,
	"receiver_id" text,
	"robot_wxid" text,
	"content" text NOT NULL,
	"raw_content" text NOT NULL,
	"content_type" text NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"is_self_sent" boolean DEFAULT false NOT NULL,
	"is_from_bot" boolean DEFAULT false NOT NULL,
	"is_mention_bot" boolean DEFAULT false NOT NULL,
	"created_at_unix_ms" bigint NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_source_message_key_unique" UNIQUE("source","message_key"),
	CONSTRAINT "inbound_messages_content_type_check" CHECK ("inbound_messages"."content_type" in ('text', 'image', 'voice', 'video', 'emoji', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX "inbound_messages_session_id_idx" ON "inbound_messages" USING btree ("session_id","id");
--> statement-breakpoint
COMMENT ON TABLE "inbound_messages" IS '网关统一入站消息表，用于保存来自 WeFlow、微信机器人 HTTP 回调等消息源的标准化消息，并作为消息历史查询来源';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."id" IS '网关内部自增主键，同时作为 NormalizedMessage.localId 使用，用于同一会话内的消息排序和高水位推进';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."source" IS '消息来源标识，例如 wechat-http、weflow，用于区分不同接入源';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."message_key" IS '来源内幂等键，例如 robot_wxid:NewMsgId，用于避免 HTTP 重放、重试或重复推送导致重复处理';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."session_id" IS '会话 ID；群聊通常是 chatroom wxid，私聊通常是对话方 wxid';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."group_name" IS '群名称或会话展示名；上游没有提供时为空';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."sender_id" IS '实际发送者 ID；群聊时是群成员 wxid，私聊时是消息发送方 wxid';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."sender_name" IS '实际发送者展示名；当前通常先保存 sender_id，后续可接联系人资料补全';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."receiver_id" IS '消息接收方 ID，通常是机器人 wxid；自己发到群里的消息会按归一化后的方向保存';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."robot_wxid" IS '当前机器人 wxid，用于识别自发消息和解析 @ 机器人';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."content" IS '归一化后的消息正文；群聊消息会去掉 sender_wxid 换行前缀';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."raw_content" IS '上游原始消息正文，尽量保留未归一化前的 Content.string';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."content_type" IS '归一化后的消息类型：text、image、voice、video、emoji、unknown';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."is_group" IS '是否群聊消息';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."is_self_sent" IS '是否机器人自己发出的消息';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."is_from_bot" IS '是否来自机器人账号；包含自发消息和 sender_id 命中机器人 wxid 的情况';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."is_mention_bot" IS '是否 @ 当前机器人；优先根据 MsgSource.atuserlist 判断，必要时回退到文本别名匹配';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."created_at_unix_ms" IS '消息创建时间，Unix 毫秒时间戳，由上游 CreateTime 归一化得到';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."raw_payload" IS '原始上游消息 JSON，用于排查解析问题和后续补充字段';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."created_at" IS '记录创建时间';
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."updated_at" IS '记录更新时间';
