# Web 控制台设计草案

这份文档记录 `apps/web` 控制台的第一版设计。它只描述 Web 控制台和 gateway admin API 的关系，不重复 monorepo 目录说明，也不重复插件系统内部规则。

## 定位

Web 控制台是 gateway 的管理界面，不是聊天入口。

第一版目标很克制：

- 查看 gateway 运行状态。
- 查看插件列表。
- 按群查看插件开启状态。
- 按群开启或关闭业务插件。

Web 控制台和 gateway 是两个独立启动、独立部署的服务：

```text
Browser
-> apps/web
-> gateway admin API
-> gateway 内部状态 / Redis / 插件系统
```

Web 不直接连 Redis，不直接操作 WeFlow，不直接操作 Graphiti，也不直接修改插件状态。所有副作用都通过 gateway admin API 完成。

## 为什么先做 gateway admin API

在写 Next.js 页面前，先让 gateway 暴露一组稳定的管理 API。

这样 Web 只是这组 API 的客户端，不需要知道 gateway 内部怎么存插件状态，也不需要复用 gateway 运行时对象。

当前第一版 admin API 只覆盖插件管理：

```text
GET  /health
GET  /admin/plugins
GET  /admin/sessions/{sessionId}/plugins
POST /admin/sessions/{sessionId}/plugins/{pluginId}/enable
POST /admin/sessions/{sessionId}/plugins/{pluginId}/disable
```

暂不做：

```text
GET /admin/sessions
GET /admin/events
```

原因是 gateway 现在还没有持久化的 session registry 和事件记录。后续如果 Web 需要列出所有群或查看最近处理记录，需要先在 gateway 中补状态索引。

## Gateway admin API 鉴权

gateway 侧只做机器 token 鉴权，不处理人类登录。

配置项：

```env
GATEWAY_ADMIN_TOKEN=
```

规则：

- `/health` 不鉴权，继续用于探活。
- `/admin/*` 必须带 `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`。
- 如果 `GATEWAY_ADMIN_TOKEN` 为空，`/admin/*` 直接禁用。

示例：

```bash
curl \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  http://127.0.0.1:3400/admin/plugins
```

sessionId 放在 URL path 中时必须使用 `encodeURIComponent`：

```text
/admin/sessions/56594698995%40chatroom/plugins
```

## Web 登录方案

第一版不接数据库，不做多用户。

Web 自己处理单用户登录：

```env
WEB_ADMIN_PASSWORD_HASH=
WEB_SESSION_SECRET=
GATEWAY_ADMIN_BASE_URL=http://127.0.0.1:3400
GATEWAY_ADMIN_TOKEN=
```

推荐使用密码哈希，而不是明文密码。

`apps/web` 提供了密码哈希脚本：

```bash
pnpm --filter @agent-gateway/web hash-password
```

脚本输出：

```text
WEB_ADMIN_PASSWORD_HASH=...
```

登录流程：

```text
访问 apps/web
-> 未登录，显示登录页
-> 输入管理员密码
-> Web 服务端校验 WEB_ADMIN_PASSWORD_HASH
-> 校验成功后写入签名 cookie
-> 后续页面和 mutation 检查 cookie session
-> Web 服务端用 GATEWAY_ADMIN_TOKEN 调 gateway admin API
```

Cookie 要求：

- `httpOnly`
- `sameSite=strict`
- 生产环境 `secure`
- 默认有效期 365 天
- 使用 `WEB_SESSION_SECRET` 签名

浏览器端不应该拿到 `GATEWAY_ADMIN_TOKEN`。

## 权限边界

系统里会有两套权限：

1. 群聊里的插件管理权限。

   由 gateway 的 `PLUGIN_ADMIN_WECHAT_IDS` 控制。它决定谁能在群里发送：

   ```text
   插件列表
   开启插件 签到
   关闭插件 签到
   ```

2. Web 控制台登录权限。

   由 `WEB_ADMIN_PASSWORD_HASH` 和 cookie session 控制。它决定谁能进入控制台。

这两套权限互不替代。

即使 Web 登录通过，Web 调 gateway admin API 时仍然必须带 `GATEWAY_ADMIN_TOKEN`。

即使某人有 `PLUGIN_ADMIN_WECHAT_IDS`，也不代表他能登录 Web 控制台。

## Next.js 技术选择

`apps/web` 使用 Next.js App Router。

数据读取：

- 优先在 Server Components 中调用 gateway admin API。
- 这样 gateway token 留在服务端，不进入浏览器 bundle。

状态修改：

- 第一版可以用 Server Actions 调 gateway admin API。
- 每个 Server Action 都必须检查 cookie session。

如果未来有移动端或第三方客户端也要复用 Web 层 API，再考虑把 mutation 改成 Route Handlers。

## 第一版页面建议

第一版页面按实际 API 能力收敛：

```text
/login
/
/plugins
```

`/` dashboard：

- gateway `/health`
- Redis 状态
- SSE 状态
- Graphiti 队列
- uptime

`/plugins`：

- 插件列表
- 手动输入或选择 sessionId
- 查看该 session 的插件状态
- 开启/关闭业务插件

后续等 gateway 有 session registry 后，再加：

```text
/sessions
/events
```

## 暂不处理

第一版 Web 不处理：

- 多用户系统
- 用户注册
- 数据库登录
- RBAC 权限模型
- OAuth / Auth.js
- Web 直连 Redis
- Web 直连 WeFlow 或 Graphiti
- Web 直接访问浏览器端暴露 gateway admin token
