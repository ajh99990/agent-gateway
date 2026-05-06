# Gateway 插件系统设计草案

这份文档是给当前项目的维护者和 Codex 后续实现时看的。它记录我们已经确认的插件系统需求，以及第一版实现应该遵守的边界。仓库的 monorepo 布局和运行命令看 `doc/monorepo-layout.md`，这里不重复说明。

当前 `event-gateway` 的主链路是：

```text
WeFlow SSE
-> 基础过滤和 Redis 去重
-> quiet window 聚合
-> 拉取 /messages 上下文
-> 调用 agent-runtime
-> 异步写 Graphiti
```

插件系统的目标不是替代聊天 agent，而是在进入 quiet window 之前增加一层确定性分流。像 `签到` 这种明确命令，不需要交给聊天 agent 判断，可以直接由对应插件的 command 处理并发送回复。

当前实现里，插件已经不再等同于“关键词处理器”。更准确的定义是：

```text
插件是可按群启停的功能模块。
commands、scheduledJobs 是插件可以声明的触发方式。
```

## 已确认需求

1. 插件分流发生在 `EventGateway.handleIncomingEvent()` 的早期阶段。

   具体位置是在完成以下步骤之后：

   - 已过滤非群聊消息
   - 已过滤机器人自己发送的消息
   - 已通过 Redis `messageKey` 去重

   如果插件命中并完成处理，本条消息不再进入现有的 quiet window 和 agent-runtime 链路。

2. 插件可以声明 commands，每个 command 可以有自己的关键词数组。

   一个 command 可以声明多个完全匹配关键词，例如：

   ```ts
   commands: [
     {
       keywords: ["签到", "打卡"],
       async handle(context) {
         return checkin(context);
       },
     },
   ]
   ```

   第一版只做 `content.trim()` 后的完全匹配，不做模糊匹配、正则匹配或 LLM 判断。

3. 一条消息最多只由一个插件处理。

   启动时需要检查 command 关键词冲突。如果两个普通插件声明了同一个关键词，服务应该启动失败，而不是依赖注册顺序决定优先级。

4. 普通插件默认启用，且启停状态按群维度保存。

   例如 A 群关闭了 `签到` 插件，不影响 B 群继续使用 `签到` 插件。

5. 插件启停状态需要持久化到 PostgreSQL。

   未设置状态时使用插件自己的 `defaultEnabled`。如果插件没有声明，则默认启用。当前使用 `plugin_session_states` 表保存显式启停状态：

   ```text
   plugin_id + session_id -> enabled
   ```

   PostgreSQL 存储让 Web 后台和纯定时插件都可以查询“哪些群开启了某个插件”。

6. 插件命中且启用后，由插件处理消息，然后调用统一的发送消息接口。

   当前阶段不实现真实发微信逻辑，只保留一个空函数或占位客户端，后续再接真实发送链路。

7. 插件执行失败后不 fallback 到聊天 agent。

   原因是插件命中代表这条消息已经被识别为确定性业务命令。失败时应该记录错误，必要时通过发送接口返回通用失败提示，但不再交给 agent-runtime 继续猜测。

8. 普通插件被关闭后，它的 commands 不再拦截消息。

   例如当前群关闭了 `签到` 插件后，用户发送：

   ```text
   签到
   ```

   网关应当把它当作没有命中插件，继续走原有聊天 agent 流程。

9. 第一版不做运行时代码热加载。

   “增减插件方便”的含义是开发时新增或移除插件文件后，只需要在一个清晰的插件列表中注册或删除即可。新增插件代码后允许重启服务。

## 管理插件

系统需要内置一个永远参与消息路由的管理插件。

管理插件负责在群聊中开启、关闭和查看插件状态。它不是普通业务插件，群聊命令不能关闭它。未来可以在 Web 控制台中提供关闭管理插件的能力，但第一版不需要实现。

### 支持的管理命令

第一版只支持三类命令：

```text
插件列表
开启插件 {插件名}
关闭插件 {插件名}
```

示例：

```text
插件列表
开启插件 签到
关闭插件 签到
```

管理命令使用中文插件名，不要求用户记住内部 `id`。

### 管理插件的处理规则

当用户发送：

```text
关闭插件 签到
```

流程是：

```text
消息命中管理插件
-> 管理插件校验管理员权限
-> 管理插件查找中文名为“签到”的插件
-> 如果目标插件不存在，回复不存在
-> 如果目标插件已经关闭，回复已经是关闭状态
-> 如果目标插件仍启用，写 PostgreSQL 关闭它并回复成功
-> 结束，不进入聊天 agent
```

这条消息从头到尾都由管理插件处理，和 `签到` 插件自身是否启用没有关系。

同理，当用户发送：

```text
签到
```

流程是：

```text
尝试命中签到插件
-> 如果签到插件启用，执行签到插件并结束
-> 如果签到插件关闭，当作没有插件命中，继续走聊天 agent
```

## 权限模型

管理插件需要管理员权限。

推荐新增配置项：

```env
PLUGIN_ADMIN_WECHAT_IDS=wxid_xxx,wxid_yyy
```

只有发送者微信 ID 在该列表中，才允许执行：

```text
开启插件 {插件名}
关闭插件 {插件名}
```

`插件列表` 是否需要管理员权限可以在实现时保守处理。第一版建议同样要求管理员权限，避免暴露当前系统能力。

如果 `PLUGIN_ADMIN_WECHAT_IDS` 为空，第一版建议拒绝所有管理命令，而不是默认允许所有人。

## 发送者身份获取

插件分流的 command 判断发生在消息入口，但摘要事件里未必包含稳定的发送者微信 ID。

因此第一版采用两阶段策略：

1. 在消息入口先用 `event.content?.trim()` 做 command 匹配。
2. 如果命中了系统插件，或者命中了当前群启用中的普通插件，就调用 WeFlow `/messages` 补拉最近消息，定位对应的完整消息，获得 `senderId`、`localId` 等字段。

这样插件路径仍然绕过聊天 agent，但插件执行时默认可以获得比 SSE 摘要更可靠的身份信息。这个选择会让插件路径多一次 WeFlow API 请求，但可以避免绝大多数插件各自重复处理 senderId 问题。

后续实现时需要专门设计“根据 SSE event 定位完整消息”的函数。优先可使用：

- `messageKey` 中可解析出的 localId 或 senderUsername
- `/messages` 返回的最近消息
- `content`、`createTime`、`senderUsername` 等辅助字段

如果无法稳定定位完整消息，涉及权限的管理命令应拒绝执行。

## 推荐接口形态

第一版可以先定义轻量的本地插件接口，避免过早引入复杂插件框架。

示意：

```ts
export interface GatewayPlugin {
  id: string;
  name: string;
  defaultEnabled?: boolean;
  system?: boolean;
  commands?: PluginCommand[];
  scheduledJobs?: ScheduledJobDefinition[];
}

export interface PluginCommand {
  keywords?: string[];
  matches?(content: string): boolean;
  handle(context: PluginContext): Promise<PluginHandleResult>;
}

export interface PluginContext {
  sessionId: string;
  groupName?: string;
  event: WeFlowSseMessageEvent;
  message?: NormalizedMessage;
  services: PluginServices;
}

export interface PluginHandleResult {
  handled: true;
  replyText?: string;
}

export interface PluginServices {
  sendMessage(input: SendMessageInput): Promise<void>;
  pluginState: PluginStateStore;
  logger: Logger;
}
```

其中 `sendMessage()` 第一版只做空实现或日志占位，不真实发送微信消息。

## Gateway 内部目录结构

插件系统当前落在 gateway 服务内部，也就是 `apps/gateway/src/plugins`：

```text
apps/gateway/src/plugins/
  index.ts
  types.ts
  plugin-router.ts
  plugin-state-store.ts
  message-sender.ts
  system/
    plugin-manager-plugin.ts
  checkin/
    checkin-plugin.ts
```

职责建议：

- `types.ts` 定义插件接口和上下文类型。
- `index.ts` 维护插件注册列表。
- `plugin-router.ts` 负责 command 关键词索引、冲突检查、插件启停判断和路由。
- `plugin-state-store.ts` 通过 PostgreSQL 保存按群插件状态。
- `message-sender.ts` 提供发送消息占位接口。
- `system/plugin-manager-plugin.ts` 实现管理插件。
- `checkin/checkin-plugin.ts` 作为第一个业务插件示例。

## 路由流程

第一版插件路由建议插入到 `handleIncomingEvent()` 中 Redis 去重之后：

```text
handleIncomingEvent(event)
-> groupOnly 过滤
-> messageKey 存在性检查
-> 机器人自发消息过滤
-> Redis claimSseMessageKey
-> pluginRouter.tryHandle(event)
   -> handled: return
   -> not handled: 继续原有 ensureSession + quiet window
```

插件路由内部流程：

```text
读取 event.content?.trim()
-> 检查是否命中管理插件命令
-> 检查是否命中普通插件 command
-> 如果未命中，返回 not handled
-> 如果命中普通插件但当前群已禁用，返回 not handled
-> 补拉 /messages 定位完整消息
-> 执行 command handle()
-> 如果返回 replyText，调用 sendMessage()
-> 返回 handled
```

## 与现有 agent 链路的关系

插件系统只在早期做确定性分流，不改变现有聊天 agent 的主流程。

未命中插件的消息仍然按原逻辑处理：

```text
quiet window
-> prepareRunInput
-> agent-runtime
-> Graphiti
```

命中并启用普通插件的消息不进入 agent-runtime，也不进入 quiet window。

普通插件关闭后，它的 command 不再拦截消息，因此会继续进入现有 agent 链路。

管理插件命令永远由管理插件处理，处理完成后不进入 agent-runtime。

## 后续实现顺序建议

1. 增加插件相关类型和目录结构。
2. 增加 PostgreSQL 插件状态存储。
3. 增加发送消息占位客户端。
4. 实现插件注册表和启动时 command 关键词冲突检查。
5. 实现管理插件。
6. 实现一个最小 `签到` 插件作为验证样例。
7. 在 `EventGateway.handleIncomingEvent()` 的 Redis 去重之后接入插件路由。
8. 补充 `apps/gateway/.env.example` 中的 `PLUGIN_ADMIN_WECHAT_IDS`。
9. 运行 TypeScript build，确保现有链路仍可编译。

## 暂不处理的范围

第一版不处理以下事项：

- 不实现真实微信发送逻辑。
- 不做插件代码热加载。
- 不做 Web 控制台。
- 不做插件市场或 npm 包安装。
- 不做多个插件共同处理同一条消息。
- 不做插件处理后继续交给 agent-runtime。
- 不做模糊匹配、正则匹配或 LLM 命令识别。
