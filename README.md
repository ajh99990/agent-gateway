# agent-gateway

这是一个 pnpm workspace monorepo。根目录主要负责统一安装依赖和调度命令，真正可独立启动的服务在 `apps/*` 下面。

## 目录结构

```text
apps/gateway        Node.js 网关服务，监听 WeFlow，处理插件和 agent-runtime 调用
apps/web            Next.js 控制台，用来查看状态和管理插件
packages/shared     共享类型/契约占位包
packages/plugin-sdk 插件 SDK 占位包
```

## 准备环境

建议使用 Node 22：

```bash
nvm use 22.22.2
```

安装所有 workspace 依赖：

```bash
pnpm install
```

## 配置环境变量

首次使用建议运行初始化脚本：

```bash
pnpm init:env
```

脚本会生成：

```text
apps/gateway/.env
apps/web/.env
```

脚本会自动生成：

- `GATEWAY_ADMIN_TOKEN`
- `WEB_SESSION_SECRET`
- `WEB_ADMIN_PASSWORD_HASH`

脚本只会询问必须人工确认的内容，例如：

- Web 控制台登录密码
- WeFlow Base URL
- WeFlow Access Token
- 机器人名称和别名
- 插件管理员微信 ID
- 可选的 Agent Runtime URL
- 可选的 Graphiti MCP URL

如果 `.env` 已经存在，脚本会询问是否覆盖。

配置示例文件仍然保留。gateway 配置示例在：

```text
apps/gateway/.env.example
```

web 配置示例在：

```text
apps/web/.env.example
```

如果你想手动配置，也可以复制示例文件：

```bash
cp apps/gateway/.env.example apps/gateway/.env
cp apps/web/.env.example apps/web/.env
```

手动配置时，如果要让 web 控制台管理 gateway 插件，两个 `.env` 里需要配置同一个 token：

```env
GATEWAY_ADMIN_TOKEN=一段足够长的随机字符串
```

web 侧还需要：

```env
GATEWAY_ADMIN_BASE_URL=http://127.0.0.1:3400
WEB_SESSION_SECRET=一段足够长的随机字符串
WEB_ADMIN_PASSWORD_HASH=密码哈希
```

手动生成密码哈希：

```bash
pnpm web:hash-password -- 你的登录密码
```

把输出的 `WEB_ADMIN_PASSWORD_HASH=...` 写入 `apps/web/.env`。

## 初始化脚本会写入哪些默认值

`pnpm init:env` 会把大多数首次使用不需要关心的配置写成默认值，例如：

```env
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=3400
REDIS_URL=redis://127.0.0.1:6479
QUIET_WINDOW_MS=8000
MENTION_QUIET_WINDOW_MS=2000
```

`AGENT_RUNTIME_URL` 和 `GRAPHITI_MCP_URL` 可以在初始化时留空。留空时 gateway 可以先跑起来观察消息，不会强制连接这些下游服务。

## 常用启动命令

在根目录启动 gateway：

```bash
pnpm gateway:dev
```

gateway 默认监听：

```text
http://127.0.0.1:3400
```

健康检查：

```bash
curl http://127.0.0.1:3400/health
```

在根目录启动 web 控制台：

```bash
pnpm web:dev
```

web 默认监听：

```text
http://127.0.0.1:3000
```

推荐开发时开两个终端：

```bash
# 终端 1
pnpm gateway:dev

# 终端 2
pnpm web:dev
```

## 构建

构建全部 workspace：

```bash
pnpm build
```

只构建 gateway：

```bash
pnpm gateway:build
```

只构建 web：

```bash
pnpm web:build
```

## 生产启动

先构建：

```bash
pnpm build
```

启动 gateway：

```bash
pnpm gateway:start
```

启动 web：

```bash
pnpm web:start
```

gateway 和 web 是两个独立服务，可以分开部署、分开启动。

## 运行某个 workspace 的命令

根目录脚本本质上是 pnpm filter 的快捷方式。

例如：

```bash
pnpm --filter @agent-gateway/gateway dev
pnpm --filter @agent-gateway/web dev
```

如果要给某个 app 安装依赖，不要直接装到根目录。使用 `--filter`：

```bash
pnpm add --filter @agent-gateway/web lucide-react
pnpm add -D --filter @agent-gateway/web tailwindcss
pnpm add --filter @agent-gateway/gateway zod
```

根目录 `package.json` 只放 workspace 调度脚本，业务依赖应放在对应 app/package 里。

## 插件管理 API 调试

开启 gateway 后，如果配置了 `GATEWAY_ADMIN_TOKEN`，可以直接调用 admin API：

```bash
curl \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  http://127.0.0.1:3400/admin/plugins
```

查看某个群的插件状态时，`sessionId` 要 URL encode：

```bash
curl \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "http://127.0.0.1:3400/admin/sessions/56594698995%40chatroom/plugins"
```

关闭某个群的签到插件：

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "http://127.0.0.1:3400/admin/sessions/56594698995%40chatroom/plugins/checkin/disable"
```

重新开启：

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "http://127.0.0.1:3400/admin/sessions/56594698995%40chatroom/plugins/checkin/enable"
```

## 离线导入脚本

导入历史聊天：

```bash
pnpm gateway:import:history
```

导入 persona seed memory：

```bash
pnpm gateway:import:persona-seed
```

这两个脚本属于 gateway，配置也从 `apps/gateway/.env` 读取。

## 常见问题

### pnpm 报 `URL.canParse is not a function`

通常是当前 Node 版本太旧。先切到 Node 22：

```bash
nvm use 22.22.2
pnpm install
```

### web 登录失败

检查：

- `apps/web/.env` 是否配置了 `WEB_ADMIN_PASSWORD_HASH`
- 是否用 `pnpm web:hash-password -- 密码` 生成 hash
- `WEB_SESSION_SECRET` 是否存在

### web 插件页面无法连接 gateway

检查：

- gateway 是否正在运行
- `apps/web/.env` 的 `GATEWAY_ADMIN_BASE_URL` 是否正确
- `apps/web/.env` 的 `GATEWAY_ADMIN_TOKEN` 是否和 `apps/gateway/.env` 一致
- gateway 是否配置了 `GATEWAY_ADMIN_TOKEN`

### admin API 返回 404

如果 `/admin/*` 返回 404，通常说明 gateway 没有配置 `GATEWAY_ADMIN_TOKEN`。这是预期的安全行为。

### 不确定命令该在哪个目录跑

优先在仓库根目录跑本文档里的命令。根目录脚本会用 pnpm workspace 自动进入对应 app。
