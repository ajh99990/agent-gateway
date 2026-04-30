# agent-runtime 对接说明

这份文档是写给“负责编写 agent / agent-runtime 的 AI”看的。

目标只有一个：让你在**不阅读 event-gateway 源码**的前提下，也能明白上游将如何调用你、会给你什么输入、希望你返回什么结果、有哪些地方不能想当然。

这里的 `agent-runtime` 指的是：

- 一个对外暴露 HTTP 接口的服务
- 内部可以是 LangGraph、LangChain、Express、Fastify，或者别的框架
- 但对 `event-gateway` 来说，它只是一个同步 HTTP webhook 目标

---

## 1. 你在整个系统里的位置

系统里大致有这几个角色：

1. `WeFlow`
   监听微信数据库变化，对外提供 SSE 和 `/api/v1/messages`
2. `event-gateway`
   接 SSE、做去重、按群聚合、quiet window、补拉最近消息，然后调用你
3. `agent-runtime`
   也就是你要实现的部分。负责判断“这批群消息值不值得回、该怎么回”
4. `Graphiti`
   长期记忆。`event-gateway` 会异步把入站消息写进去；你也可以自行查询它
5. `pywechat-mcp`
   未来真实发微信消息的执行器

一句话概括：

**你不是直接面对 WeFlow，也不是自己维护 SSE 长连接。你接收的是 event-gateway 整理好的批处理输入。**

---

## 2. event-gateway 会在什么时候调用你

默认情况下，`event-gateway` 只处理群聊消息。

它的触发节奏不是“每来一条消息就立刻调你”，而是：

1. WeFlow 推来一条 `message.new`
2. event-gateway 按群缓存这条事件
3. 如果该群在 quiet window 内又来了新消息，就继续累计
4. quiet window 到期后，event-gateway 再去补拉最近消息
5. 然后把整理好的 `AgentRunInput` 一次性发给你

当前默认 quiet window：

- 普通群消息：8 秒
- 命中 `@机器人`：2 秒

所以你看到的一次调用，往往对应的是：

- 一个群里刚刚连续发生的一小批消息
- 而不是单条消息

---

## 3. event-gateway 对你的调用方式

### 3.1 HTTP 方法

```http
POST {AGENT_RUNTIME_URL}
```

### 3.2 请求头

固定会带：

```http
Content-Type: application/json
```

如果配置了 `AGENT_RUNTIME_BEARER_TOKEN`，还会带：

```http
Authorization: Bearer <token>
```

### 3.3 超时

当前默认超时是：

- `AGENT_RUNTIME_TIMEOUT_MS=30000`

也就是说，你最好在 30 秒内完成一次判断并返回响应。

如果超时或返回非 2xx，event-gateway 会认为这次调用失败，并在后续重试该批消息。

---

## 4. 你会收到的 JSON 结构

上游发给你的请求体类型是 `AgentRunInput`。

当前结构如下：

```json
{
  "runId": "73ee37ef-ea37-449d-81c2-9732832bc38a",
  "sessionId": "56755024355@chatroom",
  "groupName": "56755024355@chatroom",
  "triggerReason": "mention",
  "triggerEventCount": 1,
  "gapDetected": false,
  "newMessages": [
    {
      "sessionId": "56755024355@chatroom",
      "groupName": "56755024355@chatroom",
      "localId": 11,
      "serverId": 6757213343634029000,
      "senderId": "yang_guang_",
      "senderName": "yang_guang_",
      "timestamp": "2026-04-11T08:10:50.000Z",
      "createdAtUnixMs": 1775895050000,
      "content": "@漫漫 你好啊",
      "rawContent": "yang_guang_:\n@漫漫 你好啊",
      "contentType": "text",
      "isGroup": true,
      "isSelfSent": false,
      "isFromBot": false,
      "isMentionBot": true,
      "fingerprint": "56755024355@chatroom:11"
    }
  ],
  "recentMessages": [
    {
      "sessionId": "56755024355@chatroom",
      "groupName": "56755024355@chatroom",
      "localId": 1,
      "senderId": "unknown",
      "senderName": "unknown",
      "timestamp": "2026-04-11T07:55:29.000Z",
      "createdAtUnixMs": 1775894129000,
      "content": "\"光光\"邀请你和\"满满\"加入了群聊",
      "rawContent": "\"光光\"邀请你和\"满满\"加入了群聊",
      "contentType": "text",
      "isGroup": true,
      "isSelfSent": false,
      "isFromBot": false,
      "isMentionBot": false,
      "fingerprint": "56755024355@chatroom:1"
    }
  ],
  "botProfile": {
    "name": "漫漫",
    "aliases": ["漫漫", "Teacher_manman"],
    "wechatIds": []
  },
  "metadata": {
    "source": "weflow",
    "oldestFetchedLocalId": 1,
    "newestFetchedLocalId": 11
  }
}
```

补充说明：

- 上面示例更贴近当前真实运行结果，而不是理想化示例
- `groupName` 当前**可能只是 `sessionId` 本身**
- `serverId` 当前运行时**可能是字符串，也可能是数字**
- `recentMessages` 当前实现里**可能包含 `newMessages` 本身**，不要假设两者互斥

---

## 5. 各字段的真正含义

### 5.1 `runId`

- 这是本次调用的唯一编号
- 主要用于日志追踪
- **不要把它当成消息幂等键**

原因：

- 如果上游重试同一批消息，新的调用可能会有新的 `runId`
- 所以它适合追踪一次请求，不适合判断“这是不是同一批消息”

### 5.2 `sessionId`

- 群会话 ID
- 群聊通常以 `@chatroom` 结尾
- 这是一个非常重要的稳定标识

建议你在 agent 里把它用作：

- 当前群的会话主键
- 日志关联键

如果你后面要查 Graphiti，不要直接把 `sessionId` 原样当作 `group_id`。

当前上游写入 Graphiti 时，会先把：

- `GRAPHITI_GROUP_PREFIX + sessionId`

做一层规范化，只保留：

- 字母
- 数字
- 下划线 `_`
- 短横线 `-`

例如：

- 原始：`wechat:56594698995@chatroom`
- 实际写入 Graphiti 的 group_id：`wechat_56594698995_chatroom`

### 5.3 `groupName`

- 群名称或群标识的展示值
- 当前运行时它**不一定是人类可读群名**
- 在很多情况下，它可能直接等于 `sessionId`
- 仅作展示辅助
- **不应作为唯一标识**

因为：

- 群名可能会变
- 当前上游未必总能拿到真实群名
- 某些情况下这里只是一个回退值

### 5.4 `triggerReason`

当前只会有两种：

- `quiet_window`
- `mention`

含义：

- `quiet_window`：普通静默窗口到期触发
- `mention`：本轮聚合里检测到了“有人在文本里 @机器人”

注意：

- `mention` 是基于 `BOT_NAME / BOT_ALIASES` 的启发式文本匹配
- 它不是微信协议层的严格 mention 标记

所以你可以把它当成一个**强提示**，但不要把它当成绝对真相。

### 5.5 `triggerEventCount`

- 这是本轮 quiet window 里累计到的 SSE 摘要事件数量
- 它表示“这次触发大概是由几条新事件引起的”

它主要是辅助信息，通常不必直接作为 prompt 主输入。

### 5.6 `gapDetected`

这个字段非常重要。

如果它是 `true`，表示：

- event-gateway 怀疑自己这次补拉最近消息时，窗口可能不够大
- 也就是说，`recentMessages` 可能不是完整连续上下文

你应该这样理解：

- `gapDetected=false`：当前上下文相对可信
- `gapDetected=true`：当前上下文可能有缺口，请谨慎决策

建议：

- 如果 `gapDetected=true`，避免基于强上下文做高置信回答
- 更保守地判断是否值得回复
- 如必须回复，尽量回复通用、低风险内容

### 5.7 `newMessages`

这是本次调用里最重要的字段。

含义：

- 真正触发这次 agent run 的“增量消息”
- 你应该优先围绕它们做判断

不要误解成：

- 整个群的完整历史
- 唯一上下文

### 5.8 `recentMessages`

这是给你做判断时使用的上下文窗口。

它的作用是：

- 给你看最近一小段群聊
- 帮助你理解 `newMessages` 发生在什么语境里

不要误解成：

- 完整会话历史
- 权威记忆源
- 与 `newMessages` 完全不重叠的独立集合

当前实现里，`recentMessages` 是“最近一段窗口消息”，而 `newMessages` 是“其中真正触发本次判断的增量消息”。

这意味着：

- `recentMessages` 里**可能包含** `newMessages`
- 你不能假设两者互斥
- 如果你需要“纯增量集合”，请优先看 `newMessages`

如果你需要更长时段的相关信息，应该自行查询 Graphiti。

补充说明：当前上游不会把 `recentMessages` 原封不动全部塞给你，而是会先做一层上下文瘦身。

- 先按 `AGENT_CONTEXT_LIMIT` 限制候选条数，默认最多保留最近 `30` 条候选消息
- 再按 `AGENT_CONTEXT_CHAR_LIMIT` 限制总字符数，默认最多保留 `600` 个字符
- `recentMessages` 里的单条消息如果超过 `100` 个字符，会先被截断后再参与预算
- 如果某条消息加入后会让总字符数超过 `AGENT_CONTEXT_CHAR_LIMIT`，这条消息会被直接丢弃

所以更准确地说，`recentMessages` 是：
- 最近消息窗口的“瘦身版上下文”
- 不是最近若干条原始消息的完整无损回放

### 5.9 `botProfile`

这是机器人自己的身份配置。

用途包括：

- 帮助你知道当前机器人叫什么
- 辅助判断别人是不是在呼叫机器人
- 辅助生成更贴合身份的回复

### 5.10 `metadata`

当前上游会提供：

- `source`：固定是 `weflow`
- `oldestFetchedLocalId`
- `newestFetchedLocalId`

这部分主要是调试和观测用途。

---

## 6. `NormalizedMessage` 字段说明

每条 `newMessages` / `recentMessages` 都是 `NormalizedMessage`。

### 核心字段

- `localId`
  - 来自 WeFlow `/messages`
  - 当前上游内部最稳定的“消息顺序锚点”
- `serverId`
  - 当前运行时可能是 `string`、`number` 或缺失
  - 不要在 agent 里假设它一定是字符串
- `timestamp`
  - ISO 字符串，UTC 时区
- `content`
  - 优先级通常是 `parsedContent > content > rawContent`
- `rawContent`
  - 可能包含 WeFlow 的原始前缀信息
  - 例如群聊里常见的 `senderId:\n消息正文`
- `contentType`
  - 当前可能是：`text | image | voice | video | emoji | unknown`

### 身份相关字段

- `senderId`
  - 当前通常等于 WeFlow 的 `senderUsername`
- `senderName`
  - **当前版本里基本上和 `senderId` 相同**
  - 还没有做群成员昵称映射
  - 也可能出现 `unknown`

所以如果你在 prompt 里直接把 `senderName` 当成自然人昵称，可能会看到 `wxid_xxx` 这种值。

### 机器人相关字段

- `isSelfSent`
  - 这条消息是不是微信账号自己发出的
- `isFromBot`
  - 当前是不是被上游认定为机器人自己
- `isMentionBot`
  - 基于文本内容和 `botProfile.aliases` 的启发式 mention 判断

### 幂等相关字段

- `fingerprint`
  - 当前格式是：`{sessionId}:{localId}`

如果你要在 agent 侧做自己的副作用幂等控制，这个字段很有用。

---

## 7. 你必须知道的当前限制

这是当前 event-gateway 的真实行为，不要在实现 agent 时想当然：

### 7.1 首次处理某个群时，不是严格增量同步

如果某个群第一次进入网关处理，而 Redis 里还没有 `committedLocalId`，上游会使用一个启发式：

- 如果 quiet window 里收到了 `N` 条 SSE 事件
- 就从最近入站消息里取最新的 `N` 条作为 `newMessages`

这意味着：

- 首次处理时，`newMessages` 是一个合理近似
- 但不是绝对严格的微信底层增量流

### 7.2 `recentMessages` 不是完整历史

它只是最近一段窗口。

### 7.3 上游不会帮你做 Graphiti 检索

上游只会异步把入站消息写进 Graphiti。

如果你要在 agent 里用记忆，请自行：

- 根据 `sessionId`
- 根据 `newMessages / recentMessages`
- 去调用 Graphiti 检索接口

### 7.4 上游当前不会把 group member 昵称补齐

当前 `senderName` 大概率还是 `senderId`。

### 7.5 上游当前给出的 `groupName` 不一定是真实群名

当前运行结果里，`groupName` 可能直接等于 `sessionId`。

### 7.6 上游当前不会把媒体二进制内容传给你

你拿到的通常只是：

- 文本
- 或类似 `[图片]` 这种摘要

---

## 8. 你应该如何使用这些输入

如果你要写 LangGraph / LangChain agent，建议遵守下面这套思路：

### 8.1 把 `newMessages` 当成主触发源

优先回答：

- 这次为什么轮到机器人判断？
- 哪几条新消息最值得关注？
- 有没有明显的 @机器人、提问、点名、任务、需要协助的信号？

### 8.2 把 `recentMessages` 当成短上下文

它适合回答：

- 这几条新消息是在接什么话题？
- 机器人是否刚刚已经回过类似内容？
- 当前语气、任务和上下文是什么？

### 8.3 不要把 `recentMessages` 当成长记忆

更远的事实或历史关系，应优先从 Graphiti 取。

### 8.4 `gapDetected=true` 时更保守

建议：

- 降低自动回复倾向
- 避免依赖“之前肯定说过 X”这种推断
- 如果回复，尽量用低风险表达

### 8.5 不要假设一次调用只有一条新消息

这在本项目里非常重要。

上游的 quiet window 设计，本来就是为了把一串连续发言压成一次判断。

所以你应该支持：

- `newMessages.length === 0`
- `newMessages.length === 1`
- `newMessages.length > 1`

尤其当 `newMessages > 1` 时，你需要理解为：

- 这是一轮“批判断”
- 不是单条 webhook

---

## 9. 你返回什么给上游

当前 event-gateway 期望你返回 HTTP 200，并且 body 可以是：

### 9.1 最小可用响应

```json
{
  "success": true,
  "shouldReply": false,
  "reason": "no-direct-address"
}
```

### 9.2 如果决定回复

```json
{
  "success": true,
  "shouldReply": true,
  "reason": "explicit-mention",
  "replyText": "收到，我来帮你看一下。"
}
```

### 9.3 当前上游实际会读取哪些字段

目前 event-gateway 只会显式读取并记录：

- `shouldReply`
- `reason`

但我强烈建议你仍然返回：

- `success`
- `shouldReply`
- `reason`
- `replyText`

因为后续接真实发送链路时，`replyText` 很可能会变成正式字段。

### 9.4 空响应也能被接受

当前上游实现里，如果你返回：

- HTTP 200
- 空 body

也不会报错。

但这只适合早期联调，不适合作为正式契约。

---

## 10. 非 2xx / 超时 会发生什么

如果你：

- 返回非 2xx
- 请求超时
- 连接异常
- 返回无法解析的异常内容

event-gateway 会认为这次调用失败，并：

- 把这批 pending events 放回队列
- 稍后重试

所以你必须知道一件事：

**同一批消息未来可能再次触发你。**

这意味着你的 agent 实现最好具备幂等意识。

---

## 11. 关于幂等：不要只靠 `runId`

再次强调：

- `runId` 更像一次 HTTP 调用的追踪号
- 不可靠地代表“唯一业务批次”

如果你后续会做副作用，比如：

- 真发微信消息
- 写数据库
- 记录任务

建议你在 agent 侧自行构造幂等键，例如：

```text
sessionId + newMessages[].fingerprint
```

或：

```text
sessionId + newest(newMessages.localId)
```

具体实现由你决定，但不要把 `runId` 当唯一业务主键。

---

## 12. 建议的 agent-runtime 内部实现方式

如果你要写 LangGraph agent，建议分两层：

### 12.1 HTTP 壳层

职责：

- 接收 `AgentRunInput`
- 做基础校验
- 调用图
- 返回结构化 JSON

### 12.2 图内部

建议最少做这些节点：

1. `fastFilter`
   - 看 `newMessages`
   - 看 `triggerReason`
   - 看 `gapDetected`
   - 初步判断是否值得进入更贵的推理

2. `retrieveContext`
   - 按 `sessionId`
   - 用 `newMessages + recentMessages` 组合查询 Graphiti

3. `decideReply`
   - 最终决定 `shouldReply`
   - 如果回复，给出 `replyText`

4. `sendWechat`
   - 未来接 pywechat MCP
   - 当前可先做假发送

5. `recordOutbound`
   - 把出站消息记入记忆系统

---

## 13. 推荐的 prompt 使用方式

建议在主 prompt 里显式告诉模型：

- `newMessages` 是触发源
- `recentMessages` 是短上下文
- `gapDetected=true` 时上下文可能不完整
- 机器人只在“值得回复”时才回复
- 如果不回复，也要输出明确理由

同时，不要把 `senderName` 当成总是可读昵称。

当前更可靠的是：

- `senderId`
- `sessionId`
- `content`

---

## 14. 对 future AI 的一句话建议

如果你正在实现 agent，不要把自己想象成“直接监听微信消息的机器人”。

你真正扮演的是：

**一个接收批处理输入、基于短上下文和长期记忆做决策的 group-chat runtime。**

上游已经帮你做了：

- SSE 接入
- 去重
- quiet window 聚合
- 最近消息补拉

你需要专注的是：

- 如何理解 `newMessages`
- 如何利用 `recentMessages`
- 是否查询 Graphiti
- 是否值得回复
- 如果回复，回复什么

---

## 15. 当前源码参考

如果你需要从代码侧验证这份文档，优先看：

- `src/types.ts`
- `src/event-gateway.ts`
- `src/agent-runtime-client.ts`
- `ARCHITECTURE.md`

这几处已经和当前实现保持一致。
