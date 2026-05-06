# Gateway DB Layer

这个目录是 gateway 的 PostgreSQL/Drizzle 数据层。它的职责不是给业务代码暴露一个裸数据库连接，而是把长期数据能力整理成可迁移、可注入、可被插件复用的 Store 系统。

当前已经落了通用插件 KV Store、插件按群启停状态、会话登记和积分系统。操作日志、媒体队列、群聊记录等能力会在这个基础上继续扩展。

## 目录结构

```text
src/db/
  README.md
  client.ts
  index.ts
  json.ts
  schema/
    index.ts
    gateway-sessions.ts
    plugin-data.ts
    points.ts
  services/
    index.ts
    points-service.ts
  stores/
    gateway-session-store.ts
    index.ts
    plugin-data-store.ts
    points-store.ts
```

## 文件说明

### `client.ts`

PostgreSQL 运行时入口。

它负责：

- 创建 `pg.Pool` 连接池。
- 创建 Drizzle `db` 实例。
- 暴露 `ping()` 给启动检查和 `/health` 使用。
- 暴露 `disconnect()` 给进程优雅退出使用。

`PostgresStore` 会在 `src/index.ts` 里实例化。gateway 启动时会先执行 `postgresStore.ping()`，如果 PostgreSQL 不可用，进程会直接启动失败。

### `json.ts`

定义通用 JSON 类型：

- `JsonPrimitive`
- `JsonValue`

这些类型用于插件 KV 这类 `jsonb` 字段，避免到处使用 `unknown` 或 `any`。

### `schema/`

Drizzle 表结构定义目录，类似 Sequelize 里的 model 定义，但它本身不会在运行时自动建表。

#### `schema/plugin-data.ts`

定义 `plugin_kv` 表。

这张表是通用插件 KV Store 的底层表，主键是：

```text
plugin_id + session_id + key
```

含义：

- `plugin_id`：插件 ID。
- `session_id`：群会话 ID，用于多群隔离。
- `key`：插件自己的数据 key。
- `value_json`：插件保存的 JSON 数据。
- `created_at`：首次创建时间。
- `updated_at`：最近更新时间。

这张表适合保存轻量插件状态，例如配置、小型进度、最近一次查询结果等。复杂插件如果有大量数据、复杂查询或事务要求，应该创建自己的 typed tables，而不是把所有东西都塞进 `plugin_kv`。

#### `schema/gateway-sessions.ts`

定义 gateway 会话登记和插件按群启停状态：

- `gateway_sessions`：保存 gateway 已见过的群会话，包括 `session_id`、最近群名和最近活跃时间。
- `plugin_session_states`：保存某个插件在某个群里的显式启停状态。

这两张表支持纯定时插件查询目标群，例如“每天给所有开启天气插件的群发天气预报”。

#### `schema/points.ts`

定义积分系统的两张表：

- `points_accounts`：保存某个群里某个用户的当前积分余额。
- `points_ledger`：保存每一次积分变化流水。

积分账户按 `session_id + sender_id` 隔离，同一个用户在不同群里的积分互不影响。

第一版积分余额使用 `integer`，账户和流水主键使用 `bigserial`。

#### `schema/index.ts`

统一导出所有 schema。

Drizzle client 和 `drizzle-kit` 都通过这个文件看到完整 schema。以后新增核心表或插件表时，需要从这里导出。

### `stores/`

Store 层负责直接读写数据库。业务代码和插件不应该散落着写 Drizzle 查询，而是优先通过 Store 或 Service 使用数据库能力。

#### `stores/plugin-data-store.ts`

`PluginDataStore` 的 PostgreSQL 实现。

它提供：

- `getValue(pluginId, sessionId, key)`
- `setValue(pluginId, sessionId, key, value)`
- `deleteValue(pluginId, sessionId, key)`
- `listKeys(pluginId, sessionId, keyPrefix?)`

这个实现读写 `plugin_kv` 表，并在 `setValue` 时使用 upsert：

```text
不存在则插入，存在则更新 value_json 和 updated_at
```

#### `stores/gateway-session-store.ts`

`GatewaySessionStore` 负责登记 gateway 已见过的群会话。

`EventGateway` 收到有效群消息后会调用 `upsertSeen()`，更新：

- `session_id`
- `group_name`
- `last_seen_at`

插件启停状态目前由 `PostgresPluginStateStore` 读写 `plugin_session_states`，并通过 `PluginStateStore` 接口暴露给插件和管理 API。

#### `stores/points-store.ts`

积分系统的数据库读写层。

它负责：

- 查找积分账户。
- 懒创建初始积分账户。
- 写入初始积分流水。
- 在事务中更新账户余额并写入积分流水。

业务校验不放在 store 里，优先由 `PointsService` 处理。

#### `stores/index.ts`

统一导出 Store 实现，方便外部从 `src/db/index.ts` 一次性导入。

### `services/`

Service 层负责业务语义。插件和后台能力应该优先依赖 service，而不是直接操作 store。

#### `services/points-service.ts`

积分系统的公共 service。

它提供：

- `getBalance(sessionId, senderId)`
- `earn(input)`
- `spend(input)`
- `adjust(input)`

它负责：

- 保证账户懒创建。
- 初始账户创建时写入 `initial_grant` 流水。
- 校验积分变化量必须是整数。
- 校验 `description` 必填。
- 拒绝余额不足的消耗或负向调整。

第一版暂不实现流水列表查询，后续 Web 后台需要时再补。

#### `services/index.ts`

统一导出 Service 实现和接口。

### `index.ts`

`src/db` 的统一导出口。

目前导出：

- PostgreSQL client。
- JSON 类型。
- Service 实现和接口。
- Store 实现。

其他模块通常应该从这里导入 DB 能力，而不是直接深层引用多个文件。

## Migration 如何运转

数据库结构不在 gateway 运行时自动同步。

流程是：

```text
schema/*.ts 描述目标表结构
        ↓
pnpm gateway:db:generate 生成 SQL migration
        ↓
pnpm gateway:db:migrate 执行 migration
        ↓
gateway 启动并使用这些表
```

相关文件：

```text
apps/gateway/drizzle.config.ts
apps/gateway/drizzle/
```

`drizzle.config.ts` 告诉 Drizzle：

- schema 入口是 `./src/db/schema/index.ts`
- migration 输出目录是 `./drizzle`
- 数据库连接来自 `DATABASE_URL`

`apps/gateway/drizzle/` 里的 SQL 和 meta 文件需要提交到版本控制。它们是数据库结构演进记录。

常用命令：

```bash
# 根据 src/db/schema/*.ts 生成新的 SQL migration
pnpm gateway:db:generate

# 把 apps/gateway/drizzle/ 里的 migration 应用到 DATABASE_URL 指向的数据库
pnpm gateway:db:migrate

# 只检查 gateway TypeScript 类型，不写 dist
corepack pnpm --filter @agent-gateway/gateway exec tsc -p tsconfig.json --noEmit
```

常见开发顺序：

```text
1. 修改或新增 src/db/schema/*.ts
2. 运行 pnpm gateway:db:generate
3. 检查生成的 apps/gateway/drizzle/*.sql
4. 运行 pnpm gateway:db:migrate
5. 运行 TypeScript 类型检查
```

## Store 系统如何接入 gateway

启动链路在 `src/index.ts`：

```text
loadConfig()
createLogger()
new PostgresStore(config, logger)
new PostgresPluginDataStore(postgresStore.db)
new PointsStore(postgresStore.db)
new DefaultPointsService(pointsStore)
new PluginRouter({ pluginData: pluginDataStore, points: pointsService, ... })
```

也就是说：

1. `PostgresStore` 负责连接数据库。
2. `PostgresPluginDataStore` 负责实现插件 KV Store。
3. `PointsStore` 和 `DefaultPointsService` 负责实现积分能力。
4. `PluginRouter` 把 `pluginData` 和 `points` 注入到 `PluginServices`。
5. 插件 command 在 `handle(context)` 里通过 `context.services.pluginData` 和 `context.services.points` 使用它们。

示例：

```ts
const value = await context.services.pluginData.getValue(
  "some-plugin",
  context.sessionId,
  "some-key",
);

await context.services.pluginData.setValue(
  "some-plugin",
  context.sessionId,
  "some-key",
  { enabledAt: new Date().toISOString() },
);
```

插件应始终传自己的 `pluginId`，并使用 `context.sessionId` 做群级隔离。

## Health 和生命周期

`/health` 会额外返回：

```json
{
  "postgres": "ok"
}
```

这个状态来自 `postgresStore.ping()`。

进程退出时，`src/index.ts` 会调用：

```text
postgresStore.disconnect()
```

以关闭 PostgreSQL 连接池。

## 设计边界

PostgreSQL 用于长期事实数据，例如插件状态、会话登记、积分流水、操作日志、媒体链接、文本记录等。

Redis 仍然用于短期运行状态，例如：

- SSE 去重。
- quiet window 状态。
- 群级运行锁。
- 热点缓存。

后续新增能力时，优先按这个边界判断数据应该放在哪里。
