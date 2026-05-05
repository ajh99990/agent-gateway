# Gateway Overview

这份文档帮助新的维护者或 AI 快速理解当前 gateway 是什么、怎么启动、核心模块分别负责什么。

它只做总览，不展开数据库、插件、调度和具体部署细节。细节请跳到对应专项文档。

## 项目定位

`agent-gateway` 是微信消息和业务插件之间的运行网关。

它负责把外部微信消息源统一成内部消息事件，然后按确定性插件、quiet window、agent-runtime 和长期记忆写入这几条链路协作处理。

当前 gateway 的主要职责：

- 接入消息源：支持 `weflow` 和 `wechat-http` 两种入口。
- 统一消息格式：把不同上游消息归一化成 `InboundMessageEvent` / `NormalizedMessage`。
- 早期过滤和去重：过滤非群聊、机器人自发消息和重复消息。
- 插件分流：明确命令优先交给插件处理，例如签到、插件管理、远征。
- 聚合聊天消息：未命中插件的消息进入 quiet window，按群批量整理上下文。
- 调用 agent-runtime：把 `newMessages` 和 `recentMessages` 组装成统一请求体。
- 写入 Graphiti：把新消息异步写入长期记忆。
- 提供公共基础设施：PostgreSQL、Redis、积分、调度、插件 KV、操作运行记录。

## 运行时依赖

gateway 运行时依赖这些外部组件：

- PostgreSQL：保存长期数据，例如积分、插件业务表、入站消息、操作运行记录。
- Redis：保存短期运行状态，例如消息去重、quiet window 锁、插件启停、BullMQ 队列。
- BullMQ：基于 Redis 的定时任务和后台队列基础设施。
- Agent Runtime：未被插件处理的聊天消息会被整理后发给它。
- Graphiti MCP：可选，用于写入长期记忆。
- 消息上游：`WeFlow` 或微信机器人服务端 HTTP 回调。

## 启动装配入口

gateway 的主入口是：

```text
apps/gateway/src/index.ts
```

它只负责装配依赖和生命周期，不应该放具体业务逻辑。

启动时大致顺序：

```text
loadConfig()
-> createLogger()
-> 创建 Redis / PostgreSQL / Scheduler
-> 根据 MESSAGE_SOURCE 选择消息源
-> 创建 AgentRuntimeClient / GraphitiClient
-> 创建插件公共服务和插件列表
-> 创建 PluginRouter / EventGateway / GatewayHttpServer
-> ping PostgreSQL 和 Redis
-> 启动 Scheduler
-> 启动 EventGateway
-> 启动 HTTP 控制面
```

如果要理解“某个能力是怎么被注入进去的”，优先读 `src/index.ts`。

## 目录地图

### `src/config.ts`

负责读取、校验和转换环境变量。

业务代码应该依赖 `AppConfig`，不要散落读取 `process.env`。

### `src/types.ts`

跨模块共享的核心运行时类型。

重点关注：

- `InboundMessageEvent`
- `NormalizedMessage`
- `MessageSource`
- `MessageHistoryProvider`
- `AgentRunInput`
- `HealthSnapshot`

这些类型定义了消息源、主链路和 agent-runtime 之间的边界。

### `src/messaging/`

消息入口和主处理链路。

```text
messaging/
  event-gateway.ts
  message-utils.ts
  sources/
  senders/
```

- `event-gateway.ts`：主链路中枢，负责过滤、去重、插件短路、quiet window、调用 agent-runtime、写 Graphiti。
- `message-utils.ts`：消息格式、时间、@ 判断、WeFlow 消息归一化等通用工具。
- `sources/`：不同消息源实现。
- `senders/`：发送消息抽象，目前真实微信发送能力尚未接入。

消息链路细节看 `doc/gateway-message-flow.md`。

### `src/messaging/sources/`

消息源适配层。

当前实现：

- `weflow-message-source.ts`：通过 WeFlow SSE 接收摘要事件，通过 WeFlow `/messages` 补拉历史。
- `wechat-http-message-source.ts`：通过 gateway HTTP 服务接收微信机器人服务端回调，并从 `inbound_messages` 表提供历史上下文。
- `wechat-robot-normalizer.ts`：把机器人服务端原始 `SyncMessage` 归一化成 gateway 标准消息。
- `weflow-client.ts`：WeFlow HTTP/SSE 客户端。

新增消息源时，应实现 `MessageSource`，如果它能提供历史上下文，也实现 `MessageHistoryProvider`。

### `src/http/`

gateway 自己的 HTTP 控制面。

当前入口：

- `GET /health`
- `/admin/*` 插件管理 API
- 当 `MESSAGE_SOURCE=wechat-http` 时，挂载微信机器人 HTTP 回调路由

HTTP 回调对接看 `doc/wechat-http-callback-integration.md`。

### `src/plugins/`

插件系统和具体插件。

公共插件契约在：

```text
src/plugins/types.ts
src/plugins/plugin-router.ts
```

具体插件在各自目录里，例如：

```text
src/plugins/checkin/
src/plugins/expedition/
src/plugins/system/
```

插件开发细节看 `doc/gateway-plugin-development.md`，插件系统产品和路由规则背景看 `doc/plugin-system-design.md`。

### `src/db/`

PostgreSQL / Drizzle 数据层。

```text
db/
  client.ts
  schema/
  stores/
  services/
```

- `schema/` 定义表结构。
- `stores/` 负责直接读写数据库。
- `services/` 负责通用业务语义，例如积分。
- 插件私有复杂表可以放在插件目录，但必须从 `src/db/schema/index.ts` 汇总导出。

数据库和 migration 细节看 `doc/gateway-db-layer.md`。

### `src/scheduler/`

BullMQ 定时任务基础设施。

插件可以声明 `scheduledJobs`，但插件按群启停不直接创建或删除 BullMQ scheduler。

调度系统细节看 `doc/gateway-scheduler.md`。

### `src/infra/`

通用基础设施封装。

当前包括：

- logger
- RedisStore
- TaskQueue

这里放“和具体业务无关、多个模块会复用”的运行时能力。

### `src/integrations/`

外部服务适配层。

当前包括：

- `agent-runtime-client.ts`
- `graphiti-client.ts`

这类模块负责封装外部协议细节，主链路不要直接散落 `fetch` 到外部服务。

### `src/time.ts`

通用日期工具。

插件做业务日期、每日任务、截止时间时，优先使用这里的工具。

## 常见修改入口

新增或切换消息源：

```text
src/types.ts
src/messaging/sources/
src/index.ts
doc/gateway-message-flow.md
```

新增插件：

```text
src/plugins/
src/plugins/index.ts
doc/gateway-plugin-development.md
```

新增数据库表：

```text
src/db/schema/index.ts
src/db/stores/
apps/gateway/drizzle/
doc/gateway-db-layer.md
```

新增定时任务：

```text
src/scheduler/
src/plugins/{plugin}/
doc/gateway-scheduler.md
```

调整 HTTP 管理或回调接口：

```text
src/http/gateway-http-server.ts
src/messaging/sources/wechat-http-message-source.ts
doc/wechat-http-callback-integration.md
```

## 推荐阅读顺序

第一次接手 gateway，建议按这个顺序读：

```text
doc/README.md
doc/monorepo-layout.md
doc/gateway-overview.md
doc/gateway-message-flow.md
```

然后根据任务跳转：

- 改插件：`doc/gateway-plugin-development.md`
- 改 DB：`doc/gateway-db-layer.md`
- 改积分：`doc/points-system-design.md`
- 改调度：`doc/gateway-scheduler.md`
- 改微信 HTTP 回调：`doc/wechat-http-callback-integration.md`
- 改 Web 控制台：`doc/web-console-design.md`
