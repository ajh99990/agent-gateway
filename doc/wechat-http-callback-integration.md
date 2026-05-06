# 微信机器人 HTTP 回调对接说明

这份文档给 `wechat-robot-client` / 机器人服务端部署同事使用，目标是让机器人服务端把消息同步回调直接打到 `agent-gateway`。

## agent-gateway 已完成的准备

`agent-gateway` 已经支持一个新的消息源模式：

```env
MESSAGE_SOURCE=wechat-http
```

开启后，gateway 会通过自己的 HTTP 服务接收机器人服务端回调，并把消息归一化后交给现有插件系统处理。

已支持的回调接口：

```text
POST /api/v1/wechat-client/:wechatID/sync-message
POST /api/v1/wechat-client/:wechatID/logout
```

其中 `sync-message` 已支持两种请求体：

```json
{
  "Data": {
    "AddMsgs": []
  }
}
```

或者直接传原始 `SyncMessage`：

```json
{
  "AddMsgs": []
}
```

消息进入 gateway 后会做这些处理：

- 将机器人原始消息归一化成 gateway 内部统一消息格式。
- 支持群消息里的真实发送人解析，例如 `sender_wxid:\n消息内容`。
- 过滤初始化消息、未知消息、部分系统消息和上传中的附件消息。
- 解析 `MsgSource` 里的 `atuserlist`，用于判断是否 @ 机器人。
- 写入 `inbound_messages` 表，并通过唯一键去重，避免回调重试导致重复处理。
- 只有新入库的消息会继续触发插件链路。
- 机器人服务端启动或重连时推送的历史消息仍会入库，但不会触发插件和 agent。

## agent-gateway 侧配置

局域网对接时，gateway 不能只监听 `127.0.0.1`，需要监听所有网卡：

```env
MESSAGE_SOURCE=wechat-http
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=3400
ENABLE_HEALTH_SERVER=true
WECHAT_ROBOT_WXID=这里填写当前机器人wxid
WECHAT_CALLBACK_TOKEN=
WECHAT_HTTP_REALTIME_LOOKBACK_MS=30000
```

说明：

- `WECHAT_ROBOT_WXID` 建议填写。gateway 会用它校验 path 里的 `wechatID`，不匹配的回调会被忽略。
- `WECHAT_CALLBACK_TOKEN` 先留空。当前机器人服务端直连回调通常只配置 `WECHAT_CLIENT_HOST`，未确认是否能给回调追加自定义 header 或 query token。
- `WECHAT_HTTP_REALTIME_LOOKBACK_MS` 用来防启动风暴。默认只派发“gateway 启动前 30 秒以内或启动后的消息”；更旧的消息只入库，不会触发插件回复。
- 如果后续机器人服务端支持自定义鉴权，gateway 已支持三种 token 传法：
  - `x-gateway-callback-token: <token>`
  - `Authorization: Bearer <token>`
  - `?token=<token>`

启动前需要确保数据库迁移已经执行：

```bash
pnpm run gateway:db:migrate
```

## 机器人服务端 Docker 配置

机器人服务端需要把 `WECHAT_CLIENT_HOST` 指向 `agent-gateway` 所在机器的局域网地址和端口。

两个项目通过局域网连接时，示例：

```yaml
services:
  ipad-test:
    image: registry.cn-shenzhen.aliyuncs.com/houhou/wechat-ipad:latest
    environment:
      WECHAT_PORT: 9000
      REDIS_HOST: wechat-admin-redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: 123456
      REDIS_DB: 0
      WECHAT_CLIENT_HOST: 192.168.1.23:3400
```

注意：

- `WECHAT_CLIENT_HOST` 保持当前机器人服务端约定的格式：`host:port`，不需要写协议和 path。
- 不要写 `127.0.0.1:3400`。在 Docker 容器里，`127.0.0.1` 指的是容器自己，不是运行 gateway 的机器。
- 如果 gateway 和机器人服务端在同一个 Docker network，可以写 gateway 的服务名，例如 `agent-gateway:3400`。
- 如果机器人服务端运行在 Docker Desktop，并且要访问宿主机，也可以尝试 `host.docker.internal:3400`。但本次两个项目走局域网，更推荐直接使用 gateway 机器的局域网 IP。

机器人服务端会把消息同步回调发送到：

```text
http://{WECHAT_CLIENT_HOST}/api/v1/wechat-client/{wxid}/sync-message
```

掉线/登出回调会发送到：

```text
http://{WECHAT_CLIENT_HOST}/api/v1/wechat-client/{wxid}/logout
```

## 联调检查

在机器人服务端所在机器或容器网络里，先确认能访问 gateway：

```bash
curl "http://192.168.1.23:3400/health"
```

再手动打一个空消息同步回调：

```bash
curl -X POST "http://192.168.1.23:3400/api/v1/wechat-client/<机器人wxid>/sync-message" \
  -H "Content-Type: application/json" \
  -d '{"Data":{"AddMsgs":[]}}'
```

期望返回：

```json
{
  "success": true,
  "received": 0,
  "inserted": 0,
  "duplicated": 0,
  "historical": 0,
  "dispatched": 0
}
```

如果返回 404，优先检查 `MESSAGE_SOURCE` 是否为 `wechat-http`，以及 `ENABLE_HEALTH_SERVER` 是否为 `true`。

如果连接不上，优先检查：

- gateway 是否使用 `GATEWAY_HOST=0.0.0.0` 启动。
- `GATEWAY_PORT` 是否和 `WECHAT_CLIENT_HOST` 端口一致。
- 两台机器是否处在同一局域网。
- 本机防火墙是否允许访问 gateway 端口。

## 启动自动同步

机器人登录后，机器人服务端的自动心跳/同步仍按原流程开启：

```bash
curl -X POST "http://<机器人服务端地址>/api/Login/AutoHeartBeat?wxid=<机器人wxid>"
```

`AutoHeartBeat` 请求只带 `wxid`，不携带 callback URL。真正的回调地址由机器人服务端 Docker 环境变量 `WECHAT_CLIENT_HOST` 决定。
