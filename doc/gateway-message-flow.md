# Gateway Message Flow

这份文档只解释 gateway 当前消息链路。

它不重复插件开发、数据库表设计、调度系统和机器人 HTTP 部署细节；这些内容只在必要位置给出跳转。

## 核心抽象

gateway 不让主链路依赖某个具体消息上游，而是依赖两个抽象。

### `MessageSource`

定义“消息从哪里来”。

```ts
interface MessageSource {
  id: string;
  start(onEvent, signal): Promise<void>;
  getStatusSnapshot(): MessageSourceStatusSnapshot;
}
```

任何消息源只要能把外部消息转换成 `InboundMessageEvent`，就可以接入 `EventGateway`。

当前实现：

- `WeFlowMessageSource`
- `WechatHttpMessageSource`

### `MessageHistoryProvider`

定义“如何为某个群补拉最近消息”。

```ts
interface MessageHistoryProvider {
  getRecentMessages(request): Promise<MessageHistoryPage>;
}
```

`EventGateway` 在 quiet window 到期后，不直接关心历史消息来自 WeFlow API 还是本地数据库，只调用这个接口。

当前实现方式：

- WeFlow 模式：调用 WeFlow `/messages`。
- WeChat HTTP 模式：读取 `inbound_messages` 表。

## 当前消息源

### WeFlow SSE

配置：

```env
MESSAGE_SOURCE=weflow
```

链路：

```text
WeFlow SSE /api/v1/push/messages
-> WeFlowMessageSource
-> InboundMessageEvent
-> EventGateway
```

WeFlow SSE 推来的事件是摘要，通常不足以构造完整上下文。因此 quiet window 到期后，gateway 会通过 `WeFlowClient` 调 `/api/v1/messages` 补拉最近消息。

### 微信机器人 HTTP 回调

配置：

```env
MESSAGE_SOURCE=wechat-http
```

链路：

```text
机器人服务端 HTTP callback
-> GatewayHttpServer extra route
-> WechatHttpMessageSource
-> WechatRobotNormalizer
-> inbound_messages
-> InboundMessageEvent
-> EventGateway
```

HTTP 回调路由：

```text
POST /api/v1/wechat-client/:wechatID/sync-message
POST /api/v1/wechat-client/:wechatID/logout
```

机器人 HTTP 对接和局域网部署看 `doc/wechat-http-callback-integration.md`。

## 统一消息事件

所有消息源进入主链路前，都会转换成：

```text
InboundMessageEvent
```

关键字段：

- `source`：消息源 ID，例如 `weflow`、`wechat-http`。
- `sessionId`：群聊或单聊会话 ID。
- `messageKey`：跨重试去重用的消息键。
- `content`：摘要内容。
- `normalizedMessage`：如果消息源已经能提供完整消息，就放这里。
- `raw`：原始上游 payload，主要用于排查。

主链路内部使用：

```text
NormalizedMessage
```

它是 agent-runtime、Graphiti、插件上下文共用的标准消息格式。

## 主链路总览

`EventGateway` 是消息处理的中枢。

一条消息进入后的顺序：

```text
MessageSource
-> EventGateway.handleIncomingEvent()
-> 群聊过滤
-> 机器人自发消息过滤
-> Redis messageKey 去重
-> PluginRouter.tryHandle()
   -> 命中插件：插件处理并结束
   -> 未命中插件：进入 quiet window
-> 按 sessionId 聚合 pendingEvents
-> quiet window 到期
-> flushSession()
-> getRecentMessages()
-> 选择 newMessages / recentMessages
-> 调用 agent-runtime
-> 异步写 Graphiti
-> 推进 committedLocalId
```

## 入口过滤和去重

`EventGateway.handleIncomingEvent()` 会先做轻量过滤：

1. 如果 `GROUP_ONLY=true`，非 `@chatroom` 会话会被忽略。
2. 没有 `messageKey` 的事件会被忽略。
3. 机器人自己发出的消息会被忽略，避免自触发。
4. 通过 Redis `claimInboundMessageKey(source, messageKey)` 做去重。

去重 key 带上 `source`，所以不同消息源不会互相污染。

## 插件短路

通过早期过滤和去重后，消息会先进入：

```text
PluginRouter.tryHandle(event)
```

插件路由规则：

- 系统插件优先。
- 普通插件只有在当前群启用时才会处理。
- 命中插件后，不再进入 quiet window，也不会调用 agent-runtime。
- 插件失败后不 fallback 到 agent-runtime。
- 普通插件关闭后，它的关键词不再拦截，会继续走聊天主链路。

插件开发细节看 `doc/gateway-plugin-development.md`。

## Quiet Window

未被插件处理的消息，会按 `sessionId` 放进内存 accumulator。

每个群有自己的一份状态：

```text
SessionAccumulator
```

它记录：

- 当前窗口内的 `pendingEvents`
- 当前触发原因 `triggerReason`
- 是否正在运行 agent run
- flush 期间是否又来了新消息

quiet window 的规则：

- 普通消息使用 `QUIET_WINDOW_MS`。
- @ 机器人消息使用更短的 `MENTION_QUIET_WINDOW_MS`。
- 同一个群每来一条新消息，都会重置这个群的定时器。
- 定时器到期后，`flushSession()` 才真正开始处理。

## Flush 和上下文整理

`flushSession()` 是 quiet window 到期后的正式处理阶段。

它会：

1. 用 Redis 抢群级运行锁，避免多实例或并发 flush。
2. 冻结当前 `pendingEvents`。
3. 调 `prepareRunInput()` 整理 agent-runtime 输入。
4. 调 agent-runtime。
5. 成功后推进 Redis 里的 `committedLocalId`。
6. 如果处理期间又有新消息，重新安排下一轮 quiet window。

如果主链路失败，当前这批事件会塞回 `pendingEvents`，稍后自动重试。

## `newMessages` 和 `recentMessages`

发给 agent-runtime 的请求里有两组消息：

```text
newMessages
recentMessages
```

含义：

- `newMessages`：这次真正触发判断的增量消息。
- `recentMessages`：提供给 agent-runtime 判断的上下文窗口。

选择规则：

- 如果这个群从未处理过，gateway 不会把整段历史都当作新消息，只取本轮事件数量对应的最近入站消息。
- 如果已经有 `committedLocalId`，则 localId 更大的入站消息才算新消息。
- 如果发现补拉窗口可能跨过上次处理位置，会标记 `gapDetected`。
- 如果 `gapDetected=true`，成功后不会冒险推进高水位。

## Agent Runtime

最终发给 agent-runtime 的结构是：

```text
AgentRunInput
```

它包括：

- `runId`
- `sessionId`
- `groupName`
- `triggerReason`
- `triggerEventCount`
- `gapDetected`
- `newMessages`
- `recentMessages`
- `botProfile`
- `metadata`

如果 `AGENT_RUNTIME_URL` 为空，当前实现会退化为记录日志，不真正发起外部调用。

## Graphiti 写入

如果配置了 `GRAPHITI_MCP_URL`，gateway 会把本轮 `newMessages` 异步写入 Graphiti。

Graphiti 写入走后台 `TaskQueue`，不阻塞 agent-runtime 主链路。

Graphiti 对接细节看 `apps/gateway/README.md` 里的 Graphiti 部分。

## 发送消息

插件回复通过 `MessageSender` 抽象发送。

当前 `MessageSender` 只是日志占位：

```text
插件发送消息占位：真实微信发送逻辑尚未实现
```

后续接入真实微信发送能力时，应替换 `src/messaging/senders/message-sender.ts` 或增加新的发送实现，再从 `src/index.ts` 注入给插件公共服务。

插件不应该直接依赖某个具体发送上游。

## 切换消息源

通过环境变量切换：

```env
MESSAGE_SOURCE=weflow
```

或：

```env
MESSAGE_SOURCE=wechat-http
```

切换到 `wechat-http` 时还需要：

```env
GATEWAY_HOST=0.0.0.0
ENABLE_HEALTH_SERVER=true
WECHAT_ROBOT_WXID=当前机器人wxid
```

并确保 `inbound_messages` 表已经通过 migration 创建。

## 新增消息源的最小 checklist

1. 在 `src/messaging/sources/` 新增 source 实现。
2. 把外部消息转换成 `InboundMessageEvent`。
3. 如果需要上下文补拉，实现 `MessageHistoryProvider`。
4. 在 `src/config.ts` 增加 `MESSAGE_SOURCE` 枚举和配置。
5. 在 `src/index.ts` 根据配置装配新消息源。
6. 更新本文档的“当前消息源”部分。

如果新消息源需要 HTTP 路由，可以像 `WechatHttpMessageSource.getRoutes()` 一样向 `GatewayHttpServer` 提供 extra routes。
