# Gateway Plugin Development

这个目录放 gateway 的插件系统代码。

插件系统的核心原则是：

```text
公共能力进 PluginServices
插件私有能力通过插件 factory 注入
```

也就是说，`PluginServices` 不应该变成所有插件专属 service 的大杂货铺。只有多个插件都会用到的能力，才应该放进 `PluginServices`。

当前插件的定义是：

```text
插件是可按群启停的功能模块。
commands、scheduledJobs 是插件可以声明的触发方式。
```

因此插件不一定要处理消息。纯定时推送、每日总结、后台维护任务这类插件，可以没有 `commands`，只声明 `scheduledJobs`。

插件可以通过 `defaultEnabled` 控制未显式配置时的默认启用状态。命令类插件通常默认开启；主动推送类插件建议设置 `defaultEnabled: false`，避免一上线就在所有群主动发消息。

## 当前目录结构

```text
src/plugins/
  index.ts
  types.ts
  plugin-router.ts
  plugin-admin-service.ts
  plugin-state-store.ts
  checkin/
    checkin-plugin.ts
  expedition/
    expedition-plugin.ts
  system/
    plugin-manager-plugin.ts
```

## 核心文件

### `types.ts`

定义插件系统的公共契约。

重点类型：

- `GatewayPlugin`：单个插件需要实现的接口。
- `PluginCommand`：插件的消息命令触发器，负责声明关键词、参数化匹配和命令处理函数。
- `PluginBootstrapContext`：插件初始化时拿到的上下文，适合构造插件内部 store、service 和 job。
- `PluginContext`：插件处理消息时拿到的上下文。
- `PluginServices`：插件可使用的公共服务集合。
- `PluginCommonServices`：初始化和运行时都可复用的公共服务集合，不包含插件 catalog。
- `PluginDataStore`：通用插件 KV Store 接口。

### `plugin-router.ts`

负责插件路由。

它会：

1. 根据消息内容匹配插件的 command。
2. 判断业务插件在当前群是否开启。
3. 补拉完整消息。
4. 构造 `PluginContext`。
5. 调用 command 的 `handle(context)`。
6. 如果 command 返回 `replyText`，通过 `MessageSender` 发送回复。

命中插件后，即使插件处理失败，当前消息也不会 fallback 到聊天 agent。

插件匹配顺序是：

```text
1. 系统插件 command 优先，支持 keywords 精确命中和 matches(content)
2. 业务插件 command 精确 keywords 命中
3. 业务插件 command 的 matches(content) 命中
```

这意味着固定指令可以只写 `keywords`，参数化指令需要实现 `matches(content)`。

例如：

```ts
commands: [
  {
    keywords: ["远征", "取消远征"],
    matches(content) {
      return content === "远征" || content.startsWith("远征 ");
    },
    async handle(context) {
      return service.handleMessage(context);
    },
  },
];
```

command 的 `keywords` 仍然会做启动期冲突检查。`matches(content)` 是函数逻辑，第一版不做静态冲突检查；如果多个业务插件 command 的 `matches` 都能命中同一条消息，会按插件注册顺序选择第一个。

### `plugin-state-store.ts`

当前用于保存插件在某个群里的启停状态。

它使用 PostgreSQL 的 `plugin_session_states` 表。启停状态是长期配置，需要被 Web 后台、定时插件和管理命令稳定查询。

未写入启停状态时，`pluginState.isEnabled(sessionId, pluginId, plugin.defaultEnabled)` 会使用插件自己的 `defaultEnabled`；如果插件没有声明，则默认开启。

定时类插件可以通过 `pluginState.listEnabledSessions(pluginId, plugin.defaultEnabled)` 找到所有开启该插件的群。

### `message-sender.ts`

插件发送消息的抽象。

当前实现位于 `src/messaging/senders/message-sender.ts`，只是日志占位。后续接入真实微信发送链路时，应优先替换这里，而不是让插件自己直接调用外部发送 API。

### `index.ts`

统一创建 gateway 当前安装的插件。

简单插件可以直接在这里注册。

复杂插件如果需要自己的 store/service，应通过 factory 参数注入。

当前推荐让所有插件 factory 都接收 `PluginBootstrapContext`：

```ts
export function createGatewayPlugins(context: PluginBootstrapContext): GatewayPlugin[] {
  return [
    createPluginManagerPlugin(context),
    createCheckinPlugin(context),
  ];
}
```

## 什么时候使用 `PluginServices`

`PluginServices` 适合放所有插件都可能用到的公共能力。

适合加入 `PluginServices` 的例子：

- `sendMessage`
- `pluginState`
- `pluginData`
- `operationRuns`
- `points`
- `scheduler`
- 未来的 `mediaQueue`
- 未来的 `operationLog`

不适合加入 `PluginServices` 的例子：

- `expeditionService`
- `imageLotteryService`
- `weatherPluginStore`
- 某个插件自己的报名、结算、排行、图片游标 service

判断标准：

```text
如果这个能力只有一个插件知道它的业务含义，就不要放进 PluginServices。
如果多个插件都能复用它，而且语义足够通用，才放进 PluginServices。
```

## 插件定时任务

gateway 的定时任务基建看 `doc/gateway-scheduler.md`。

插件需要定时执行后台逻辑时，可以声明 `scheduledJobs`。复杂插件建议通过 factory 注入自己的 service，然后让 job processor 闭包持有这些 service：

```ts
export function createSomePlugin({ someService }: SomePluginDeps): GatewayPlugin {
  return {
    id: "some-plugin",
    name: "某插件",
    commands: [
      {
        keywords: ["某指令"],
        async handle(context) {
          // 处理群聊指令
          return {};
        },
      },
    ],
    scheduledJobs: [
      {
        id: "some-plugin.daily-job",
        name: "某插件每日任务",
        schedule: {
          cron: "0 0 * * *",
          timezone: "Asia/Shanghai",
        },
        async process() {
          await someService.runDailyJob();
        },
      },
    ],
  };
}
```

插件关闭或开启是按群维度的业务状态，不会删除 BullMQ scheduler。定时任务如果要处理群维度业务，应在执行时检查 `pluginState.isEnabled(sessionId, pluginId, plugin.defaultEnabled)`。

如果插件关闭前需要取消未完成业务、返还资源或写操作日志，可以实现 `beforeDisable(context)` hook。hook 只处理插件自己的业务状态，不负责管理 BullMQ scheduler。

## 什么时候使用 `pluginData`

`context.services.pluginData` 是通用插件 KV Store。

它适合保存轻量、低查询复杂度的数据，例如：

- 插件配置。
- 小型状态。
- 最近一次处理结果。
- 某个群的简单开关或偏好。

示例：

```ts
const pluginId = "some-plugin";

const value = await context.services.pluginData.getValue(
  pluginId,
  context.sessionId,
  "some-key",
);

await context.services.pluginData.setValue(
  pluginId,
  context.sessionId,
  "some-key",
  {
    updatedAt: new Date().toISOString(),
  },
);
```

不要把大量业务数据都塞进 `pluginData`。

如果插件需要复杂查询、事务、排行、批量扫描、大量链接、大段文本或长期流水，就应该创建自己的 typed tables。

## 插件操作运行记录

`context.services.operationRuns` 用来记录插件的一次业务操作是否已经开始、成功或失败。

它是通用基础设施，不包含任何具体插件业务含义。

典型用途：

- 每日任务是否已经执行。
- 群级定时结算是否正在运行。
- BullMQ 重试时避免重复执行同一个业务操作。
- 用户查询时判断某个操作是否处于 `running`。

示例：

```ts
const dateKey = getBusinessDateKey(new Date(), "Asia/Shanghai");
const start = await context.services.operationRuns.tryStart({
  pluginId: "some-plugin",
  scope: "session",
  scopeId: sessionId,
  operationKey: `daily:${dateKey}`,
});

if (!start.started) {
  return;
}

try {
  await runDailyOperation();
  await context.services.operationRuns.markSucceeded(start.run.id);
} catch (error) {
  await context.services.operationRuns.markFailed(start.run.id, error);
  throw error;
}
```

`scope` 的含义：

- `global`：整个 gateway 只有一份操作记录。
- `session`：每个群一份操作记录。
- `sender`：每个用户一份操作记录。

如果失败后允许再次执行，可以在 `tryStart` 里传入 `retryFailed: true`。是否允许重试由插件业务自己判断。

## 业务日期工具

插件做每日任务、截止时间、报名窗口时，优先使用 `src/time.ts` 中的通用工具。

当前提供：

- `getBusinessDateKey`：按指定时区得到 `YYYY-MM-DD` 业务日期。
- `getDailyCutoffAt`：得到某个业务日期的截止时刻。
- `isBeforeDailyCutoff`：判断某个时间是否早于当天截止时间。

这些工具只负责通用日期判断，不包含任何插件业务规则。

## 插件需要自建表时的推荐流程

假设要新增一个复杂插件 `expedition`。

推荐目录：

```text
src/plugins/expedition/
  expedition-plugin.ts
  expedition-schema.ts
  expedition-store.ts
  expedition-service.ts
  expedition-types.ts
  expedition-content.ts
```

### 1. 写插件 schema

插件私有表可以放在插件目录内，例如：

```text
src/plugins/expedition/expedition-schema.ts
```

然后在 DB schema 入口中导出：

```ts
// src/db/schema/index.ts
export * from "./plugin-data.js";
export * from "../../plugins/expedition/expedition-schema.js";
```

Drizzle 和 migration 工具只看 `src/db/schema/index.ts`，所以新增表后必须从这里导出。

### 2. 生成 migration

修改 schema 后运行：

```bash
pnpm gateway:db:generate
```

然后检查生成的 SQL：

```text
apps/gateway/drizzle/*.sql
```

确认表名、主键、索引、字段类型符合预期后，再执行：

```bash
pnpm gateway:db:migrate
```

数据库表属于安装和部署状态，不属于群内插件启用状态。

也就是说：

```text
插件是否开启，只影响是否响应群消息。
插件依赖的表，应该在部署或启动前通过 migration 准备好。
```

不要在插件的 `handle()` 里临时建表。

### 3. 写插件 store

`expedition-store.ts` 负责直接读写数据库。

它可以依赖 gateway 的 Drizzle db：

```ts
import type { GatewayDatabase } from "../../db/index.js";

export class ExpeditionStore {
  public constructor(private readonly db: GatewayDatabase) {}

  // 在这里写 Drizzle 查询
}
```

Store 层只负责数据访问，不应该塞太多游戏规则。

### 4. 写插件 service

`expedition-service.ts` 负责业务语义。

例如：

- 报名。
- 修改报名。
- 取消报名。
- 每日结算。
- 查询战报。
- 查询排行。

Service 可以组合多个 store 或公共 service。

插件 command 代码应该优先调用 service，而不是直接把复杂业务逻辑写在 `handle(context)` 里。

### 5. 通过插件 factory 注入

复杂插件不要把自己的 service 加进 `PluginServices`。

推荐做法：

```ts
// src/plugins/expedition/expedition-plugin.ts
export function createExpeditionPlugin(context: PluginBootstrapContext): GatewayPlugin {
  const store = new ExpeditionStore(context.db);
  const service = new ExpeditionService({
    store,
    points: context.services.points,
    logger: context.services.logger.child({ pluginId: "expedition" }),
  });

  return {
    id: "expedition",
    name: "远征",
    commands: [
      {
        keywords: ["远征", "取消远征", "我的战报", "我的遗物", "远征排行"],
        matches(content) {
          return content === "远征" || content.startsWith("远征 ");
        },
        async handle(context) {
          return service.handleCommand(context);
        },
      },
    ],
  };
}
```

然后在 gateway 装配阶段创建依赖：

```ts
const pluginServices: PluginCommonServices = {
  sendMessage: (input) => messageSender.sendMessage(input),
  pluginState: pluginStateStore,
  pluginData: pluginDataStore,
  points: pointsService,
  scheduler,
  logger,
  adminWechatIds: config.pluginAdminWechatIds,
};

const gatewayPlugins = createGatewayPlugins({
  config,
  db: postgresStore.db,
  services: pluginServices,
});
```

`PluginBootstrapContext` 用于初始化阶段，不包含当前消息的 `sessionId`、`message`、`content` 等信息。

`PluginContext` 用于消息处理阶段，会在每次命中插件时由 `PluginRouter` 创建。

`PluginServices` 比 `PluginCommonServices` 多一个 `plugins` catalog。catalog 依赖完整插件列表，因此只能在插件列表创建完成后由 `PluginRouter` 补上。

`createGatewayPlugins` 的形态：

```ts
export function createGatewayPlugins(context: PluginBootstrapContext): GatewayPlugin[] {
  return [
    createPluginManagerPlugin(context),
    createCheckinPlugin(context),
    createExpeditionPlugin(context),
  ];
}
```

这样插件私有能力只暴露给自己的插件，不污染全局 `PluginServices`。

## 简单插件的推荐结构

如果插件只是 command 关键词回复，或只使用 `pluginData` 保存少量状态，可以只建一个文件：

```text
src/plugins/some-plugin/some-plugin.ts
```

不需要私有 schema、store、service。

示例：

```ts
export function createSomePlugin(): GatewayPlugin {
  return {
    id: "some-plugin",
    name: "某插件",
    commands: [
      {
        keywords: ["某指令"],
        async handle(context) {
          await context.services.pluginData.setValue(
            "some-plugin",
            context.sessionId,
            "last-used-at",
            new Date().toISOString(),
          );

          return {
            replyText: "处理完成。",
          };
        },
      },
    ],
  };
}
```

## 表命名建议

插件私有表建议使用插件 ID 作为前缀：

```text
expedition_players
expedition_entries
expedition_relics
expedition_reports
image_queue_items
image_queue_cursors
```

这样可以避免不同插件之间表名冲突，也方便排查数据库。

## 数据边界

PostgreSQL 适合保存长期事实数据：

- 积分流水。
- 用户操作日志。
- 插件业务数据。
- 插件按群启停状态。
- Gateway 已见过的群会话。
- 图片链接元数据。
- 群聊记录。
- 大段文本。
- 每日结算结果。

Redis 继续负责短期运行状态：

- SSE 去重。
- quiet window。
- 群级运行锁。
- 热点缓存。

## 开发 checklist

新增复杂插件时，建议按这个顺序做：

```text
1. 创建插件目录
2. 写 schema
3. 从 src/db/schema/index.ts 导出 schema
4. 运行 pnpm gateway:db:generate
5. 检查 migration SQL
6. 写 store
7. 写 service
8. 写 plugin factory
9. 在 src/plugins/index.ts 注册插件
10. 在 src/index.ts 装配插件依赖
11. 运行 TypeScript 类型检查
```

类型检查命令：

```bash
corepack pnpm --filter @agent-gateway/gateway exec tsc -p tsconfig.json --noEmit
```

## 一句话总结

```text
通用能力进 PluginServices。
插件私有表从 db/schema/index.ts 汇总导出。
插件私有 store/service 留在插件目录。
复杂插件通过 factory 注入自己的 service。
```
