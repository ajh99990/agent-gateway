# Gateway 定时任务系统设计

这份文档描述 gateway 的定时任务基础设施。它只讨论调度系统本身，不绑定具体业务插件。

## 目标

gateway 需要一套可靠的后台调度能力，用来承载固定时间、固定间隔和异步后台任务。

第一版目标：

- 使用成熟调度和队列库，不自行实现 cron 解析。
- 支持 cron 定时任务和延迟任务。
- 支持失败重试、并发控制和优雅停止。
- 支持多 gateway 实例时同一个任务只被一个 worker 消费。
- 允许插件声明自己的定时任务。
- 插件按群开启或关闭时，定时任务有清晰的处理边界。

## 技术选型

gateway 使用 BullMQ 作为定时任务和后台队列基建。

选择 BullMQ 的原因：

- 基于 Redis，和 gateway 当前基础设施一致。
- 支持 Job Scheduler，可以用 cron 或固定间隔产生任务。
- 支持 worker 并发、失败重试、backoff、stalled job 恢复。
- 支持 graceful shutdown，进程退出时可以等待正在执行的任务结束。
- 天然适合后续拆出独立 worker 进程。

项目内不直接暴露 BullMQ 给业务代码使用，而是封装一层 `Scheduler` 接口。这样以后要调整队列名、默认重试策略、观测字段或 worker 部署方式，不需要每个插件跟着改。

## 核心模型

定时任务系统分三层：

```text
SchedulerService
-> BullMQ Queue / Job Scheduler / Worker
-> 插件或 gateway 注册的 job processor
```

### Job Scheduler

Job Scheduler 负责按时间产生 job。

常见形态：

```text
每天 00:00 触发一次
每 5 分钟触发一次
延迟 30 秒执行一次
```

同一个 scheduler 使用稳定的 `id` upsert。服务重启或多次部署时，重复注册同一个 scheduler 不会创建多份调度器。

### Queue

Queue 负责保存待执行 job。

所有 gateway 定时任务第一版共用一个 BullMQ queue：

```text
gateway-scheduler
```

队列名可以通过环境变量调整。

### Worker

Worker 负责消费 job。

第一版 worker 仍然运行在 gateway 进程内。后续如果定时任务变重，可以把相同代码拆成单独 worker 进程，只保留 gateway 主进程负责接收消息。

## 任务声明

插件或 gateway 模块通过声明式结构注册任务：

```ts
{
  id: "some-plugin.daily-job",
  name: "每日任务",
  schedule: {
    cron: "0 0 * * *",
    timezone: "Asia/Shanghai",
  },
  async process(context) {
    // 执行业务逻辑
  },
}
```

固定间隔任务使用：

```ts
{
  id: "some-plugin.polling-job",
  schedule: {
    everyMs: 5 * 60 * 1000,
  },
  async process(context) {
    // 执行业务逻辑
  },
}
```

任务 `id` 必须全局唯一。插件任务建议用插件 id 做前缀：

```text
{pluginId}.{jobName}
```

## 插件接入方式

插件可以声明 `scheduledJobs`：

```ts
export interface GatewayPlugin {
  id: string;
  name: string;
  commands?: PluginCommand[];
  scheduledJobs?: ScheduledJobDefinition[];
}
```

复杂插件需要数据库或业务 service 时，推荐通过插件 factory 注入依赖，然后让 job processor 闭包持有自己的 service：

```ts
createSomePlugin({ someService }) {
  return {
    id: "some-plugin",
    name: "某插件",
    commands: [
      {
        keywords: ["某指令"],
        async handle(context) {
          return someService.handleCommand(context);
        },
      },
    ],
    scheduledJobs: [
      {
        id: "some-plugin.daily-job",
        schedule: { cron: "0 0 * * *" },
        async process() {
          await someService.runDailyJob();
        },
      },
    ],
  };
}
```

不要把插件私有 service 塞进 `PluginServices`。`PluginServices.scheduler` 只提供通用调度能力，例如主动 enqueue 一个已注册 job。

## 插件启停与定时任务

插件启停是按群维度的业务状态，BullMQ scheduler 是进程级基础设施。两者不要直接绑定。

也就是说：

```text
关闭某个群的插件，不删除 BullMQ scheduler。
开启某个群的插件，也不重新创建 BullMQ scheduler。
```

原因：

- 同一个插件可能在 A 群关闭、B 群开启。
- BullMQ scheduler 是全局调度器，不适合为每个群频繁创建和删除。
- 删除 scheduler 容易造成重启、并发管理和补偿逻辑复杂化。

推荐规则：

```text
Scheduler 只负责按时间触发。
PluginState 负责判断某个群是否启用插件。
业务 service 负责处理启停时自己的待处理状态。
```

定时任务执行时，如果任务要处理群维度业务，必须检查该群插件状态：

```text
job 触发
-> 找到需要处理的 session
-> 检查 pluginState.isEnabled(sessionId, pluginId, plugin.defaultEnabled)
-> 启用则处理
-> 关闭则跳过或执行业务定义的清理逻辑
```

纯定时插件如果要找出所有已开启的群，可以通过 `pluginState.listEnabledSessions(pluginId, plugin.defaultEnabled)` 读取 PostgreSQL 中的会话登记和插件状态。主动推送类插件建议设置 `defaultEnabled: false`，避免未配置的群被自动纳入定时任务。

插件还可以实现启停 hook：

```ts
beforeDisable(context) {
  // 插件关闭前清理或结算自己的待处理状态
}
```

hook 的职责是处理插件私有业务语义，例如取消未完成的申请、释放锁定资源、写操作日志等。调度系统本身不理解这些业务含义。

## 幂等要求

BullMQ 可以减少重复执行，但业务代码不能假设 job 永远只执行一次。

这些情况都可能导致重复消费或重试：

- worker 执行中进程崩溃。
- Redis 认为 job stalled 后重新入队。
- job 失败后按 `attempts` 重试。
- 部署多个 gateway 实例。

因此所有会改变业务状态的 job 都必须在业务层保证幂等。

推荐做法：

- 给每个业务周期建立唯一 key，例如 `{jobId}:{date}:{sessionId}`。
- 在 Postgres 中保存状态，例如 `pending`、`running`、`completed`、`cancelled`。
- 在事务里从 `pending` 推进到最终状态。
- 已完成或已取消的任务再次执行时直接 no-op。
- 积分、库存、结算这类操作必须写流水或唯一业务记录。

原则：

```text
BullMQ 负责可靠触发和重试。
Postgres 负责业务状态和幂等。
```

## 启动和停止

gateway 启动时：

```text
创建 SchedulerService
-> 注册 gateway 和插件声明的 jobs
-> upsert BullMQ Job Schedulers
-> 启动 BullMQ Worker
```

gateway 退出时：

```text
停止 HTTP 控制面
-> 停止消息入口
-> 停止 SchedulerService
-> 断开 Postgres 和 Redis
```

SchedulerService 停止时应等待正在执行的 job 收尾，不再拉取新 job。

## 配置

第一版配置项：

```env
SCHEDULER_QUEUE_NAME=gateway-scheduler
SCHEDULER_WORKER_CONCURRENCY=4
SCHEDULER_DEFAULT_TIMEZONE=Asia/Shanghai
```

`SCHEDULER_DEFAULT_TIMEZONE` 只作为 job 未显式设置时的默认时区。具体业务需要其他时区时，应在自己的 job schedule 中声明。

## 第一版暂不处理

第一版不做以下能力：

- 不做 Web 控制台里的任务管理页面。
- 不支持运行时从数据库动态新增任意 cron。
- 不做复杂补偿系统。
- 不做每个群独立创建 BullMQ scheduler。
- 不把插件启停状态和 BullMQ scheduler 生命周期直接绑定。
- 不把所有后台任务迁出 gateway 进程。

这些能力可以在任务数量、任务耗时或运维需求变复杂后再扩展。
