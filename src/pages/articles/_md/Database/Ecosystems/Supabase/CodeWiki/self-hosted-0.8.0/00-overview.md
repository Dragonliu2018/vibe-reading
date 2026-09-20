---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "Overview"
date: "2026-09-20T18:00:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "TypeScript", "PostgreSQL", "BaaS", "Monorepo"]
description: "Supabase 主仓库（Postgres 开发平台）self-hosted/v0.8.0 源码解读概览：monorepo 分层架构、模块地图、Table Editor 数据流与自托管部署栈。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** self-hosted/v0.8.0（tag [`241bb11c06`](https://github.com/supabase/supabase/commit/241bb11c06)，2026-08-11）· **协议** Apache-2.0 · **语言** TypeScript（React 19）+ Shell/SQL · **代码量** 手写 TS ~81.5 万行 + docker 编排脚本 ~5.8k 行 · **仓库** [GitHub](https://github.com/supabase/supabase)

---

## 总览

### 项目简介

Supabase 是「Postgres 开发平台」——用企业级开源工具组合出 Firebase 式的开发者体验。它的核心理念写在 README 里：*如果工具已存在且有宽松开源协议，就用它；不存在就自己造并开源*。因此 Supabase 是一个**编排型产品**：Postgres（数据库本体）、PostgREST（自动 REST API）、GoTrue（JWT 认证）、Realtime（WebSocket 实时）、Supavisor（连接池化）全部是独立仓库的开源项目，Supabase 把它们组装成一个带 Dashboard、自动 API、认证、存储、Edge Functions 的完整平台。

本仓库（supabase/supabase）是这个产品的**前端 + 平台界面 + 自托管编排**部分：7 个 apps（Dashboard/官网/文档站等）、15 个 packages（共享库）、一套 docker 自托管栈（12 服务）。数据库引擎、认证服务等后端**不在本仓库**——它们以 Docker 镜像引用接入。**项目边界**：本仓库负责 Studio 控制台、官方网站、文档、组件库与部署编排；不负责 Postgres 扩展、后端服务实现、CLI（均为独立仓库）。

解读版本 self-hosted/v0.8.0 的两个突出特征：

1. **Studio 正处于 Next.js → TanStack Start 双框架并行迁移期**——`pages/`（Next 旧路由）与 `routes/`（TanStack 路由树）同时出货，`STUDIO_FRAMEWORK` 环境变量切换运行时，E2E 每次 PR 跑双轨 matrix。
2. **LLM-first 内容分发**——官网与文档站同时输出 markdown 变体（`Accept: text/markdown` 内容协商）、`llms.txt`、`docs.tar.gz`、`.well-known/agent-skills`，官方站既是人类站点也是 agent 可读站点。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| Dashboard 控制台 | `apps/studio`（~587k 行） | Table Editor、SQL Editor、Auth/Storage/Edge Functions 管理 |
| 官网 | `apps/www`（~128k 行） | 博客 421 篇、客户案例、定价、llms.txt |
| 文档站 | `apps/docs`（~46k 行） | spec 生成的 API reference + 手写 guides |
| 自托管栈 | `docker/` | 12 服务 docker-compose + setup/update 生命周期 |
| Postgres 元数据引擎 | `packages/pg-meta` | pg_catalog 内省 + DDL 生成的纯 TS 库 |
| 平台 API 类型 | `packages/api-types` | openapi-typescript 从 Management API spec 生成 |
| 共享 UI | `packages/ui` + `ui-patterns` | 原语层 + 业务组件层，对外发 shadcn registry |
| 平台基础 | `packages/common` | 三层 feature flag、consent-first 遥测 |
| 组件 registry | `apps/ui-library` | `npx shadcn add @supabase/xxx` 第三方安装 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| React 19 + TypeScript | 核心 | 全部 apps 共用（catalog 锁 `^19.2.6`） |
| Next.js 15/16 | 核心 | www/docs 用 App Router；studio 用 pages router（迁移中） |
| TanStack Start + Vite 8 | 核心 | studio 迁移目标运行时（`STUDIO_FRAMEWORK=tanstack`） |
| TypeScript 6.0 + 7 native | 核心 | 双轨：6.0 兼容包供 eslint/Next 用，7（Go 原生）供 typecheck 提速 |
| pnpm catalog + Turborepo | 核心 | 版本单一真源 + 任务拓扑编排 |
| valtio / nuqs / react-hook-form + zod | 核心 | studio 状态三约定：全局状态 / URL 状态 / 表单 |
| react-query（TanStack Query） | 核心 | 服务器状态与缓存（query key 工厂体系） |
| openapi-fetch + openapi-typescript | 核心 | 类型安全平台 API 客户端 |
| react-data-grid | 可选 | Table Editor 渲染层（已 patch：`patches/react-data-grid.patch`） |
| ConfigCat / PostHog / Usercentrics | 可选 | 动态 flag / 实验 / GDPR consent |

### 版本历史

- 2026-06：self-hosted 默认 PG 15 → **PG 17**（`upgrades.json` 以 `breaking: true` + `utils/upgrade-pg17.sh` gate 强制交互确认）
- 2026-08（v0.8.0，本解读版本）：API 网关从 **Kong 切换为 Envoy 默认**（服务统一命名 `api-gw` + `envoy`/`kong` 双网络别名保证旧配置零修改）
- 持续演进：Studio 自 Next pages router 向 **TanStack Start** 迁移（`TANSTACK_MIGRATION.md` 逐路由 checklist）

## 快速上手

**本地开发（Studio Dashboard）**：

```bash
git clone https://github.com/supabase/supabase
cd supabase && pnpm install
pnpm dev:studio          # → http://localhost:8082
```

启动后浏览器访问 `localhost:8082`，自托管模式下自动重定向到 `/project/default`（`IS_PLATFORM=false` 时 `withAuth` 直接放行）。

**自托管完整栈**（Linux，一条 `curl | sh` 引导）：

```bash
curl -fsSL https://supabase.com/docs/guides/self-hosting/linux/setup.sh | sh
cd supabase && docker compose up -d
```

访问 `http://<host>:8000`（Envoy 网关默认端口）即得完整平台：Dashboard、Auth、REST、Realtime、Storage、Edge Functions。`docker compose ps` 应看到 12 个服务全部 healthy（`supabase-envoy`、`supabase-db` 等 container name）。

## 架构设计解析

### 系统架构

本仓库的设计思想是**「薄前端 + 可插拔编排」**：应用层只做界面与 SQL 生成，一切重活交给可替换的独立服务；部署层用统一的 `api-gw` 服务名加双网络别名，把网关（kong/envoy）、存储后端（file/s3/rustfs）、PG 版本都做成 override 文件级别的可插拔件。

![Supabase monorepo 分层架构](/vibe-reading/images/articles/supabase-internals/architecture.svg)

自上而下：**应用层**（7 个可部署站点）通过 `workspace:*` 依赖**共享包层**（15 个库）；**工程化基建**横跨全部（pnpm catalog 版本真源、turbo 任务图、44 个 CI workflows）；**自托管部署栈**把 studio 构建成镜像、以镜像引用拉起全部后端服务。层与层之间只有一个方向的依赖：apps → packages，packages 不反向依赖任何 app（`packages/pg-meta` 是唯一例外形态——它的 `sql/studio/` 目录长着 Studio 专属业务 SQL，`src/index.ts` 注释自嘲"如果变臃肿可拆 path export"）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 应用层 | `apps/studio` `apps/www` `apps/docs` 等 7 个 | 面向各自受众的可部署站点，消费共享包 |
| 共享包层 | `packages/ui` `pg-meta` `common` `api-types` 等 | 沉淀跨 app 复用的组件、SQL 生成、类型与平台基础 |
| 工程化基建 | 根 `pnpm-workspace.yaml` `turbo.jsonc` `.github/workflows/` | 保证 7 app 15 pkg 一致的版本、类型检查与测试 |
| 部署编排层 | `docker/` | 把 apps 产物与外部后端镜像组装成完整平台 |

![模块依赖关系](/vibe-reading/images/articles/supabase-internals/module-dependencies.svg)

依赖方向上有一个值得注意的**构建期跨 app 依赖**：www 的 `prebuild` 显式依赖 docs 的 `build:federated-content` 与 `build:guides-markdown`——因为 `llms-full.txt` 要在运行时递归读 docs 的 markdown 产物（`next.config.mjs` 为此配置了 `outputFileTracingIncludes` 把兄弟 app 目录打进 serverless bundle）。这是 LLM 内容分发矩阵带来的独特耦合。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Branded type + 单一准入函数 | `SafeSqlFragment` in `packages/pg-meta/src/pg-format/index.ts` | 把 SQL 注入防护编码进类型系统：普通 string 无法赋值，只有 `ident()/literal()/keyword()` 能产出 |
| Strangler Fig（绞杀者迁移） | `routes/` re-export `pages/` in `apps/studio` | 双运行时并存，逐路由迁移、可随时 bisect 回退 |
| Shim 适配层 | `compat/next/` + `vite.config.ts` alias 表 | 让 `next/*` import 在 Vite 下重定向到 TanStack 实现，旧页面零改动 |
| Query key factory | 各资源目录 `keys.ts` | 嵌套数组 key + `.filter(Boolean)` 保证未就绪时 key 稳定可比 |
| Scheduler / Mechanism 分层 | `state/sql-editor/sql-editor-save-scheduler.ts` / `sql-editor-save.ts` | 「何时保存」与「怎么保存」正交，manual save 特性只改 policy 不动 persistence |
| Override 文件组合 | `docker/docker-compose.{kong,s3,pg17,caddy}.yml` | 网关/存储/TLS/PG 版本全部可插拔，`.env` 的 `COMPOSE_FILE` 变量拼接 |
| 3-way merge | `docker/update.sh` 的 `merge_one_file()` | 部署目录混合 vendor 文件与用户状态，覆盖会毁本地定制 |
| Spec-as-single-source | `apps/docs/spec/` + `packages/api-types` | Management API spec 一处变更，文档与 TS 类型同时更新 |
| 棘轮（ratchet） | `studio-lint-ratchet.yml` + `eslint-rule-baselines.json` | lint 存量债务只减不增，周日 cron 自动收缩基线 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `SafeSqlFragment` | 品牌类型的安全 SQL 片段 | 编译期类型，运行时退化为 string | 由 `ident()/literal()/safeSql` 产出，`executeSql` 强制收参 |
| `Snippet` + `SnippetStatus` | SQL Editor 代码片段及其保存状态机 | 编辑会话，`new→saving→saved/unsaved` | valtio 持久化域，react-query 管服务端态 |
| `SupaTable` / `SupaColumn` / `SupaRow` | Grid 的表/列/行数据模型 | 单表编辑会话 | 由 pg-meta `Entity` 经 `parseSupaTable` 裁剪 |
| `operationQueue` | Table Editor 待提交操作队列 | 会话内（可 undo），事务性提交 | 冲突解决规则在 `queueConflictResolution.ts` |
| `ResponseError` | 统一 API 错误对象 | 请求期 | 中间件注入 `code/requestId/retryAfter`，`handleError` 分类抛出 |
| `TelemetryEvent` | 数百成员的可辨识联合事件类型 | 常驻（`telemetry-constants.ts` 3876 行） | `sendTelemetryEvent` 编译期校验完整 payload |

#### 核心抽象

| 抽象 | 定义位置 | 实现类/产出 | 注册方式 |
| --- | --- | --- | --- |
| `acceptUntrustedSql()` | `pg-format/index.ts` | Untrusted→Safe 唯一提升通道 | 纪律约束：仅用户手势事件处理器内调用 |
| `executeSql()` | `apps/studio/data/sql/execute-sql-mutation.ts` | 全 Studio 数据库 I/O 总线（148 文件引用） | react-query mutation 封装 `useExecuteSqlMutation` |
| `PgMetaClient`（聚合对象） | `packages/pg-meta/src/index.ts` | 18 个对象类型模块（tables/roles/policies…） | 每对象一个 `pg-meta-<type>.ts`，index 聚合 |
| `FeatureFlagProvider` | `packages/common/feature-flags.tsx` | ConfigCat + PostHog 双源 | 挂各 app 根部（7 处） |
| `withAuth()` | `apps/studio/hooks/misc/withAuth.tsx` | 认证 HOC | `IS_PLATFORM=false` 时直接返回原组件 |
| `SHORTCUT_DEFINITIONS` | `apps/studio/state/shortcuts/registry.ts` | ~40 个分组文件 | `useShortcut(SHORTCUT_IDS.X, handler)` |

## 代码目录

```
supabase/
├── apps/
│   ├── studio/            # Dashboard 控制台（~587k 行，本仓库主体）
│   │   ├── routes/        # TanStack 路由树（迁移目标）
│   │   ├── pages/         # Next 旧路由（迁移期 load-bearing，禁止删）
│   │   ├── compat/next/   # next/* → TanStack shim 层
│   │   ├── state/         # valtio 全局状态（sql-editor/table-editor…）
│   │   ├── data/          # fetcher + query key 工厂（80+ 资源目录）
│   │   ├── components/grid/ # SupabaseGrid（Table Editor 渲染）
│   │   └── hooks/         # useSelectedProject / useCheckPermissions…
│   ├── www/               # 官网（_blog/_customers/_go 内容集合）
│   ├── docs/              # 文档站（spec/ + content/guides + federated）
│   ├── design-system/     # 对内设计系统文档站
│   ├── ui-library/        # 对外 shadcn registry 站
│   └── learn/ + lite-studio/
├── packages/
│   ├── pg-meta/           # SQL 生成引擎（SafeSqlFragment DSL）
│   ├── api-types/          # OpenAPI 生成类型（~45k 行）
│   ├── ui/ + ui-patterns/  # 组件两层
│   └── common/             # flags/遥测/consent（含 shared-data 等）
├── docker/                # 自托管：compose + setup/update + volumes init SQL
├── e2e/                   # Playwright（studio 27 spec / docs）
├── examples/              # 用户示例（被 docs 构建期拷贝）
├── blocks/vue/            # Vue registry blocks（Nuxt 技术栈孤岛）
└── pnpm-workspace.yaml    # catalog 版本真源 + 供应链规则
```

## 模块地图

单层结构，11 个模块全部独立成文。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Studio 应用骨架 | 双框架路由、认证、全局状态 | `routes/__root.tsx` | 迁移期架构自成一体，compat 层是本仓库独有形态 | [01](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/01-studio-app-skeleton) |
| Studio 数据层 | typed fetch + query key + 权限 | `data/fetchers.ts` | 全部 app 数据访问的唯一通道约定 | [02](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/02-studio-data-layer) |
| SQL 执行与编辑器 | executeSql 总线 + snippet 保存链 | `data/sql/execute-sql-mutation.ts` | Dashboard 的数据库 I/O 核心链路 | [03](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/03-sql-editor) |
| Table Editor 与 Grid | 电子表格式表格编辑 | `components/grid/SupabaseGrid.tsx` | Studio 最重的业务组件群 | [04](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/04-table-editor-grid) |
| pg-meta 元数据引擎 | pg_catalog 内省 + DDL 生成 | `packages/pg-meta/src/index.ts` | 独立 npm 包，SQL 生成的单一真源 | [05](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/05-pg-meta) |
| docker 自托管编排 | 12 服务部署 + 生命周期 | `docker/docker-compose.yml` | 与 apps 代码完全不同的部署域 | [06](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/06-docker-self-hosted) |
| www 官网 | 营销内容 + LLM 分发 | `apps/www/lib/posts.tsx` | 内容集合与构建流水线独立演进 | [07](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/07-www-website) |
| docs 文档站 | spec 驱动文档生成 | `apps/docs/internals/` | 8 步 codegen 流水线自成体系 | [08](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/08-docs-site) |
| 共享组件层 | ui / ui-patterns / registry | `packages/ui-patterns/src/` | 组件生态与分发渠道的完整链路 | [09](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/09-shared-ui) |
| common 平台基础 | flags / 遥测 / consent | `packages/common/index.tsx` | 跨 app 平台语义的物理单点 | [10](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/10-common-platform) |
| Monorepo 工程化 | catalog / turbo / CI / e2e | `pnpm-workspace.yaml` | 支撑 7 app 15 pkg 的工程基座 | [11](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/11-monorepo-engineering) |

## 运行时行为

### 启动流程

Studio 的启动由 `scripts/dispatch.js` 分流（64 行 ESM）：

```
pnpm dev / build / start
└─ dispatch.js: readEnvFiles(['.env', '.env.local'])
    ├─ STUDIO_FRAMEWORK !== 'tanstack'（默认 next）
    │    └─ spawn pnpm run dev:next → next dev -p 8082 → pages/ 路由
    └─ STUDIO_FRAMEWORK === 'tanstack'
         └─ spawn pnpm run dev:tanstack → vite dev
              → routes/ 路由树（routeTree.gen.ts 插件生成）
              → next/* import 经 vite alias → compat/next shim
```

关键装配点：

- **配置优先级**：dispatch.js 故意不把整个 `.env` 注入子进程 env——`scripts/serve.js` / vite 自己做 .env 加载且拒绝覆盖 dispatcher 已设值（e2e 的 `.env.test` 需要翻转 `NEXT_PUBLIC_IS_PLATFORM`）。
- **`IS_PLATFORM` 编译期内联**（`lib/constants/index.ts`，`process.env.NEXT_PUBLIC_IS_PLATFORM === 'true'`）：它是全 Studio 的平台/自托管分流开关——`withAuth` 短路、`AuthProviderInternal alwaysLoggedIn`、`/` 路由重定向目标（平台 `/org` vs 自托管 `/project/default`）、`platformApiGuard` 404 门控。
- **Provider 链**：`routes/__root.tsx` 的 `RootComponent` 是约 18 层 Provider 嵌套（ErrorBoundary → NuqsAdapter → AuthProvider → FeatureFlagProvider → ProfileProvider → … → Outlet），react-query 经 `setupRouterSsrQueryIntegration` 与 router 贯通。

### 核心运行流程

以下链路覆盖 Studio 两大编辑器与自托管部署三条主链，前两条是「浏览器内」，第三条是「服务器侧」。

#### 数据查询：Table Editor 打开一张表

业务流程：URL `/project/{ref}/editor/{id}` → 鉴权 → 三个并行查询（表结构/行数据/行数）→ SQL 生成 → pg-meta 服务执行 → Grid 渲染。

![Table Editor 查询数据流](/vibe-reading/images/articles/supabase-internals/data-flow.svg)

文字解读：路由层经 Path A re-export 复用 `pages/` 页面，`withAuth` 在自托管下零开销放行。数据侧的关键分野是**平台 API 与用户数据库是两条通道**：项目元数据走 openapi-fetch typed REST；数据库对象全部在前端用 pg-meta 生成 SQL，经 `executeSql`（强制 `SafeSqlFragment` 参数 + EXPLAIN preflight 成本闸门 + 角色扮演包裹）POST 到 `/platform/pg-meta/{ref}/query`，由 pg-meta 服务解密 `x-connection-encrypted` 头直连目标库。行数据查询用 CTE 两段式：先 `_base_query` 收敛行集（过滤+排序+分页），外层仅对当页数据做 10KB/50 元素截断，避免全表物化。错误行号经 `-11` 偏移还原角色扮演前缀。

#### 编辑保存：SQL Editor 的双轨保存

业务流程：Monaco onChange → `setSql`（untrusted 打标 + status→unsaved）→ needsSaving 脏队列 → SaveScheduler（WHEN）→ SaveMechanism（HOW：1s debounce）→ PUT /platform/content → react-query 失效。

![SQL Editor 保存链](/vibe-reading/images/articles/supabase-internals/sql-editor-save-pipeline.svg)

文字解读：scheduler 只管「何时」（auto 模式随脏队列排空；manual 模式扣住直到 `Cmd+S` 的 `requestSave`），mechanism 只管「怎么存」（`sql-editor-save.ts` 顶部注释明言 "It does NOT decide *when* to save"）。两层均为无 React 依赖的工厂函数（结构化 deps 接口），可纯函数级测试。用户 SQL 在编辑器中永远以 `UntrustedSqlFragment` 存在，只有 Run 按钮等用户手势现场才经 `acceptUntrustedSql` 晋升——URL 参数或 AI 输出预填的 SQL 无法被静默执行。

#### 部署更新：自托管栈的 3-way merge

业务流程：`sh update.sh` → 解析 base（`.supabase-version`）与 target（最新 tag）双快照 → breaking 变更 gate 确认 → 备份（排除 `volumes/db/data`）→ 逐文件 3-way merge → `.env` 只追加缺失 key → 写新版本戳。

文字解读：部署目录是「vendor 文件 + 用户状态」混合体。`merge_one_file()`（`docker/update.sh`）按 `u==b`（用户没改过→直接覆盖）与 `u≠b≠t`（真冲突→git merge-file 标记）区分处理；`.env` 的 `env_has_key` 连注释掉的 `#GOOGLE_ENABLED=` 也算存在，避免重加用户故意禁用的项。冲突时退出码 2 且不推进版本戳。

## 典型修改场景

#### 场景 1：新增一个平台 API 资源的查询 hook

官方路径即 `data/__templates/`（含 README 四步）：后端更新 OpenAPI spec → `packages/api-types` 跑 `pnpm codegen` → `data/<new-resource>/keys.ts` 建 query key 工厂 → 复制 `__templates/resource-query.ts` 实现 `getNewResource()`（端点不在 spec 里直接编译报错）→ `useNewResourceQuery` 包装。对应测试：同资源目录 `*.test.ts`（vitest + MSW，`addAPIMock`）。

#### 场景 2：新增一个 SQL Editor 快捷操作

`state/shortcuts/registry.ts` 的 `SHORTCUT_IDS` 加 ID → `useSqlEditorShortcuts.ts` 里 `useShortcut(SHORTCUT_IDS.XXX, handler, { registerInCommandMenu: true })` → 命令菜单自动获得入口。涉及执行 SQL 时沿用 `readEditorSql() + acceptUntrustedSql()` 晋升模式。对应测试：`state/shortcuts/` 与 `state/sql-editor/*.test.ts`。

#### 场景 3：新增一个 self-hosted 服务

写 `docker-compose.<name>.yml`（附加型参考 `docker-compose.s3.yml` 的 one-shot 建桶容器 + `service_completed_successfully` 门控；替换型用 `!override` 原地改写，参考 `docker-compose.kong.yml`）→ 新 env key 加进 `.env.example`（`update.sh` 的 `merge_env_file` 自动追加到老部署）→ 需要 DB schema/角色的在 `volumes/db/` 加 SQL（编号排 97-99 段）→ 网关路由改 `volumes/api/envoy/cds.yaml` + `lds.template.yaml`。对应测试：`.github/workflows/self-host-tests-smoke.yml` 的 5 组合 smoke matrix。

## 测试体系

```
e2e/                      # 独立 workspace，与 app 代码物理隔离
├── studio/features/      # 27 个 Playwright spec（sql-editor、table-editor、rls…）
└── docs/
apps/studio/tests/        # 组件测试（vitest + MSW，customRender + addAPIMock）
packages/pg-meta/test/    # 集成测试：docker-compose 起真实 PG（run-tests.sh）
docker/tests/             # 自托管 smoke（5 种 compose 组合）
```

| 代码层 | 测试类型 |
| --- | --- |
| state/ 纯函数（lifecycle、scheduler、queue 冲突解决） | vitest 单测（同目录 `*.test.ts`） |
| hooks / 组件 | vitest + MSW（未处理网络请求即失败，禁止 `vi.mock('@/data/...')`） |
| pg-meta SQL 生成 | 真实 PG 集成测试（`createTestDatabase` 每用例建随机库） |
| 全链路 | Playwright E2E（next × tanstack 双轨 × 2 分片） |
| 部署 | docker smoke + 3-way merge 的 shell 测试 |

理解某个类的最快路径是先读它同目录的测试——`sql-editor-save-scheduler.test.ts`、`queueConflictResolution` 相关测试实际是这些机制的「可执行文档」。

## 阅读源码推荐路线

- 第一遍：理解 Studio 主干
  `apps/studio/scripts/dispatch.js` → `routes/__root.tsx`（Provider 链）→ `hooks/misc/withAuth.tsx`（`IS_PLATFORM` 短路）→ `state/app-state.ts`（valtio 最小样板）
- 第二遍：理解数据层与 SQL 安全
  `apps/studio/data/fetchers.ts`（407 行全文）→ `data/sql/execute-sql-mutation.ts` → `packages/pg-meta/src/pg-format/index.ts`（410 行核心 DSL）→ `packages/api-types/redocly.yaml`
- 第三遍：理解两大编辑器
  `components/grid/SupabaseGrid.tsx` → `components/interfaces/TableGridEditor/TableGridEditor.tsx` → `components/interfaces/SQLEditor/` 的 `SQLEditorControllers.tsx` 与 `useSqlEditorExecution.ts` → `state/sql-editor/sql-editor-save-scheduler.ts`
- 第四遍：选择重点模块深入（模块文档）
  自托管栈从 `docker/docker-compose.yml` + `docker/setup.sh` 头部注释读起；工程化从 `pnpm-workspace.yaml` 的 catalog 块读起；各有独立模块文档（见模块地图）。

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| `IS_PLATFORM` | 编译期内联的平台/自托管分流开关，决定认证、路由、API 基址等行为 |
| Path A / Path B | TanStack 迁移的两种 route 形态：re-export pages 默认导出 / 直接 import 组件 |
| `x-connection-encrypted` | 传递加密数据库连接串的 HTTP 头，pg-meta 服务解密后连库 |
| role impersonation | `set local role` + `request.jwt.claims` GUC 注入，在 PostgREST 视角预览 RLS 效果 |
| preflightCheck | 执行前先 EXPLAIN，total cost ≥ 200,000 拒绝执行 |
| federated content | docs 构建期从 5 个外部仓库（wrappers 等）拉取的文档 |
| ratchet | ESLint 基线棘轮：存量豁免、增量冻结、每周自动收缩 |
| catalog | pnpm 的版本单一真源机制，全部子包用 `"catalog:"` 引用 |
| api-gw | 自托管网关服务的统一名（envoy 默认，带 kong 网络别名） |
| supavisor | Elixir 连接池化服务，session（:5432）/ transaction（:6543）两种模式 |
