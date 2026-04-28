# event-gateway

`event-gateway` 是一个跑在 Windows 宿主机上的轻量 Node.js 服务，用来把 `WeFlow` 的 SSE 事件整理成适合 `agent-runtime` 消费的批量输入。

## 做什么

- 订阅 `WeFlow` 的 `message.new` SSE
- 按 `messageKey` 去重
- 按群聚合，并应用 quiet window
- quiet window 到期后调用 `WeFlow /api/v1/messages` 拉最近消息
- 组装 `AgentRunInput` 并调用 `agent-runtime`
- 异步把新消息写入 Graphiti MCP 的 `add_memory`
- 暴露一个简单的 `/health`

## 运行

1. 复制 `.env.example` 为 `.env`
2. 配置 `WEFLOW_ACCESS_TOKEN`
3. 配置 `AGENT_RUNTIME_URL`
4. 可选配置 `GRAPHITI_MCP_URL`
5. 安装依赖并启动

```bash
pnpm install
pnpm dev
```

## 当前默认约定

- 只处理群聊，会忽略非 `@chatroom` 会话
- 第一次处理某个群时，不回放历史；只取本轮 SSE 事件数量对应的最新几条入站消息
- Graphiti 写入失败不会阻塞回复链路
- 如果 `AGENT_RUNTIME_URL` 为空，网关会退化为只记录日志，不真正发起 agent run

## Agent Runtime 请求体

```json
{
  "runId": "uuid",
  "sessionId": "123@chatroom",
  "groupName": "项目群",
  "triggerReason": "mention",
  "triggerEventCount": 2,
  "gapDetected": false,
  "newMessages": [],
  "recentMessages": [],
  "botProfile": {
    "name": "bot",
    "aliases": ["bot", "机器人"],
    "wechatIds": []
  },
  "metadata": {
    "source": "weflow",
    "oldestFetchedLocalId": 100,
    "newestFetchedLocalId": 120
  }
}
```

## Graphiti 写入

当配置了 `GRAPHITI_MCP_URL` 时，网关会连接 Graphiti 的 MCP HTTP 入口，例如：

- `http://127.0.0.1:8000/mcp/`

然后调用 MCP 工具：

- `add_memory`

当前写入策略是：

- 每个 quiet window 的 `newMessages` 会聚合成一个 Graphiti episode
- `group_id` 由 `GRAPHITI_GROUP_PREFIX + sessionId` 规范化而来，例如 `wechat:56594698995@chatroom` 会变成 `wechat_56594698995_chatroom`
- `source` 使用精简 `json`，只保留 `sessionId`、`groupName` 和每条消息的 `sender` / `timestamp` / `content`
- 如果配置了 `GRAPHITI_MCP_URL`，网关会在启动阶段先连上 Graphiti；连不上就直接启动失败
