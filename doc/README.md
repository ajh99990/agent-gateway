# agent-gateway 文档入口

这份文档是项目文档的入口。新同事或 AI 接手任务时，建议先读这里，再根据任务类型跳到对应子文档。

## 项目结构与启动

### [monorepo-layout.md](./monorepo-layout.md)

介绍 monorepo 的目录职责、workspace 边界和常用命令。

适合在这些场景阅读：

- 第一次了解项目结构。
- 不确定某个功能应该放在 `apps/gateway`、`apps/web` 还是 `packages`。
- 需要理解根目录脚本和 workspace 包之间的关系。

## Gateway

### [gateway-overview.md](./gateway-overview.md)

介绍 gateway 当前的整体定位、运行时依赖和 `apps/gateway/src` 模块地图。

适合在这些场景阅读：

- 第一次接手 gateway 代码。
- 想知道消息源、插件、数据库、调度、外部集成分别放在哪里。
- 不确定某个改动应该从哪个模块开始看。

### [gateway-message-flow.md](./gateway-message-flow.md)

介绍 gateway 当前的消息处理链路，包括：

- `MessageSource` 和 `MessageHistoryProvider` 抽象。
- `weflow` 和 `wechat-http` 两种消息源如何进入主链路。
- `EventGateway` 的过滤、去重、插件短路、quiet window 和 agent-runtime 调用顺序。
- `newMessages`、`recentMessages`、`committedLocalId`、`gapDetected` 的含义。

适合在这些场景阅读：

- 要新增或切换消息源。
- 要排查消息为什么没有触发插件或 agent-runtime。
- 要理解一条微信消息从入口到处理完成的完整路径。

### [gateway-db-layer.md](./gateway-db-layer.md)

介绍 gateway 的 PostgreSQL/Drizzle 数据层，包括：

- `PostgresStore`
- schema 目录
- store/service 分层
- migration 流程
- 通用插件 KV Store
- 积分系统当前接入方式

适合在这些场景阅读：

- 要新增或修改数据库表。
- 要写新的 Store 或 Service。
- 要理解 `pnpm gateway:db:generate` 和 `pnpm gateway:db:migrate` 怎么用。
- 要判断某个数据应该放 PostgreSQL 还是 Redis。

### [points-system-design.md](./points-system-design.md)

介绍积分系统第一版设计，包括：

- 每群独立积分账户。
- 初始积分和懒创建规则。
- `points_accounts`、`points_ledger` 表结构。
- 积分流水字段和语义。
- `PointsService` 接口草案。
- 第一版暂不实现的能力。

适合在这些场景阅读：

- 要实现或修改积分系统。
- 要让插件消耗或发放积分。
- 要设计 Web 后台里的积分查询、调整、流水功能。

### [gateway-plugin-development.md](./gateway-plugin-development.md)

介绍 gateway 插件开发约定，包括：

- `PluginServices` 应该放什么。
- 插件私有 store/service 应该如何注入。
- command 触发器和参数化指令如何用 `matches(content)` 匹配。
- 插件自建表时的 schema/migration/store/service 流程。
- 简单插件和复杂插件的推荐结构。

适合在这些场景阅读：

- 要新增插件。
- 要给插件加私有表。
- 要判断能力应该放进 `PluginServices` 还是插件自己的 service。
- 要实现类似 `远征 冒险 50` 这种参数化指令。

### [gateway-scheduler.md](./gateway-scheduler.md)

介绍 gateway 的 BullMQ 定时任务系统，包括：

- Job Scheduler / Queue / Worker 分层。
- 插件如何声明定时任务。
- 插件按群启停时，定时任务应该如何处理。
- 任务幂等、失败重试和优雅停止边界。

适合在这些场景阅读：

- 要新增定时任务。
- 要让插件定期执行后台逻辑。
- 要判断任务是否需要补偿、重试或幂等状态。
- 要理解插件关闭后定时任务为什么不能直接删除。

### [wechat-http-callback-integration.md](./wechat-http-callback-integration.md)

介绍微信机器人服务端通过 HTTP 回调接入 gateway 的部署约定，包括：

- gateway 侧 `wechat-http` 消息源配置。
- 机器人服务端 Docker 里的 `WECHAT_CLIENT_HOST` 应该如何填写。
- 局域网联调时如何验证 `/health` 和 `sync-message` 回调。
- 为什么不能把容器里的回调地址写成 `127.0.0.1`。

适合在这些场景阅读：

- 要把消息源从 WeFlow SSE 切换到机器人服务端 HTTP 回调。
- 要和 `wechat-robot-client` / 机器人服务端部署同事对接。
- 要排查局域网回调不通、404、wxid 不匹配等问题。

### [plugin-system-design.md](./plugin-system-design.md)

介绍插件系统的整体设计背景和产品侧目标。

适合在这些场景阅读：

- 要理解为什么 gateway 需要插件系统。
- 要调整插件管理、插件启停、控制台管理能力。
- 要从产品/架构角度评估插件系统方向。

## Web Console

### [web-console-design.md](./web-console-design.md)

介绍 Web 控制台设计。

适合在这些场景阅读：

- 要修改 `apps/web`。
- 要新增后台管理页面。
- 要让 Web 控制台调用 gateway 管理接口。

## 推荐阅读路径

### 第一次接触项目

```text
README.md
doc/README.md
doc/monorepo-layout.md
doc/gateway-overview.md
doc/gateway-message-flow.md
```

### 修改消息接入或主链路

```text
doc/gateway-overview.md
doc/gateway-message-flow.md
doc/wechat-http-callback-integration.md
apps/gateway/src/index.ts
apps/gateway/src/messaging/event-gateway.ts
apps/gateway/src/messaging/sources/
```

### 新增一个普通插件

```text
doc/gateway-plugin-development.md
apps/gateway/src/plugins/types.ts
apps/gateway/src/plugins/plugin-router.ts
```

### 新增一个需要数据库的复杂插件

```text
doc/gateway-plugin-development.md
doc/gateway-db-layer.md
doc/gateway-scheduler.md
apps/gateway/src/db/schema/index.ts
```

### 修改积分能力

```text
doc/points-system-design.md
doc/gateway-db-layer.md
apps/gateway/src/db/services/points-service.ts
apps/gateway/src/db/stores/points-store.ts
```

### 修改 Web 后台

```text
doc/web-console-design.md
doc/plugin-system-design.md
```

## 文档维护约定

- 架构和跨模块约定放在 `doc/`。
- 代码目录里尽量只放源码和必要的轻量注释。
- 如果实现和文档不一致，优先更新文档入口和对应子文档，避免后来的人读到过期路径。
- 新增重要能力时，优先判断是否需要在本入口文档里加一条索引。
