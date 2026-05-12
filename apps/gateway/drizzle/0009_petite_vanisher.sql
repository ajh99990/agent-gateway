ALTER TABLE "inbound_messages" ADD COLUMN "mentioned_wxids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "inbound_messages"."mentioned_wxids" IS '消息中被 @ 的微信用户 wxid 列表，来自微信 MsgSource.atuserlist；没有结构化 @ 信息时为空数组';
