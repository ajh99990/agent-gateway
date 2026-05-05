# Monorepo 布局说明

这份文档记录当前仓库从单一 gateway 项目改成 pnpm workspace 后的约定。它只解释仓库结构和运行入口，不重复插件系统的业务设计；插件分流、管理插件、按群启停等规则看 `doc/plugin-system-design.md`。

## 为什么改成 monorepo

当前系统不只是一个长期运行的 Node 网关。现在已经有 Web 控制台，以及可能被 gateway 和 Web 同时使用的共享类型、插件接口。

如果拆成多个独立仓库，`gateway`、`web`、共享契约和插件接口很容易各改各的。monorepo 的目标是让这些部分在一个工作区里一起演进：

- `gateway` 和 `web` 是两个独立启动、独立部署的服务。
- 共享类型和插件接口可以放在 `packages/*`，由多个 app 共同依赖。
- 改接口后可以在同一个仓库里跑构建，及时发现不兼容。

第一版只使用 pnpm workspace，不使用 Turborepo 或 Nx。等 app/package 数量变多、构建变慢、需要任务缓存时再考虑引入。

## 当前目录结构

```text
agent-gateway/
  apps/
    gateway/
      src/
      package.json
      tsconfig.json
      .env.example
      README.md
      AGENT_RUNTIME_CONTRACT.md
      note.md
    web/
      app/
      components/
      lib/
      package.json
      .env.example
  packages/
    shared/
      src/
      package.json
      tsconfig.json
    plugin-sdk/
      src/
      package.json
      tsconfig.json
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  README.md
  doc/
```

根目录现在是 workspace 管理层，不再是 gateway 服务本身。

`apps/gateway` 是当前真正运行的 Node 网关服务。以前根目录下的 `src`、`.env.example`、`AGENT_RUNTIME_CONTRACT.md`、服务 README 等都已经迁入这里。

`apps/web` 是 Next.js Web 控制台。它不直接连接 Redis、WeFlow 或 Graphiti，只通过 gateway admin API 读写管理状态。

`packages/shared` 是共享契约占位包。未来可以放 gateway 和 web 都要使用的 DTO、schema、API response 类型等。现在先不强行抽代码。

`packages/plugin-sdk` 是插件接口占位包。未来如果插件变成更独立的模块，可以把 `GatewayPlugin`、`PluginContext`、`PluginHandleResult` 等公共接口搬到这里。当前插件接口仍然在 gateway 内部。

`doc` 目录仍然是本地设计文档目录，并且会被 `.gitignore` 忽略。

## 包名和启动关系

workspace 内部包名：

```text
@agent-gateway/gateway
@agent-gateway/web
@agent-gateway/shared
@agent-gateway/plugin-sdk
```

这些名字是 pnpm workspace 的内部定位名，不表示要发布 npm 包。所有包都保持 `private: true`。

`apps/web` 和 `apps/gateway` 一样，是独立启动、独立部署的 app，而不是 gateway 的子页面。

## 常用命令

在仓库根目录运行：

```bash
pnpm install
pnpm gateway:dev
pnpm gateway:build
pnpm gateway:start
pnpm web:dev
pnpm web:build
pnpm web:start
pnpm web:hash-password -- <password>
pnpm build
```

等价的 pnpm filter 命令：

```bash
pnpm --filter @agent-gateway/gateway dev
pnpm --filter @agent-gateway/gateway build
pnpm --filter @agent-gateway/gateway start
pnpm --filter @agent-gateway/web dev
pnpm --filter @agent-gateway/web build
```

导入脚本：

```bash
pnpm gateway:import:history
pnpm gateway:import:persona-seed
```

## 环境文件位置

gateway 的配置示例在：

```text
apps/gateway/.env.example
```

web 的配置示例在：

```text
apps/web/.env.example
```

实际运行时，如果继续使用 `dotenv/config` 默认加载规则，需要从 `apps/gateway` 目录启动，或者确保运行环境能让 gateway 读到正确的 `.env`。

推荐开发时使用：

```bash
pnpm gateway:dev
```

如果未来希望从仓库根目录放统一 `.env`，需要再显式设计配置加载规则。

## 什么时候抽 shared 或 plugin-sdk

当前不要为了“看起来像 monorepo”而提前抽代码。

建议等出现明确需求再移动：

- Web 控制台和 gateway 需要共享 API 类型时，把相关 DTO/schema 抽到 `packages/shared`。
- 多个插件都需要稳定公共接口，或者插件希望脱离 gateway 目录组织时，把插件接口抽到 `packages/plugin-sdk`。
- 只有 gateway 自己使用的运行时细节，例如 Redis、logger、WeFlow client、Graphiti client，继续留在 `apps/gateway`。

## 与插件系统文档的关系

`doc/plugin-system-design.md` 负责描述插件系统的业务和运行规则。

这份文档只描述 monorepo 结构：

- gateway 服务在哪里
- workspace 怎么运行
- shared/plugin-sdk 什么时候使用
- web 服务在哪里

两份文档的交集只有路径约定：插件系统当前落在 `apps/gateway/src/plugins`。
