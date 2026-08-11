---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Overview"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 是开源的 AI agent 编排控制平面——用组织架构图、目标、预算、治理把一组 agent 运营成一家公司"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.3.1 (canary/v2026.624.0) · **协议** MIT · **语言** TypeScript (Node.js ≥ 20) · **代码量** ~400,000 行 · **仓库** [GitHub](https://github.com/paperclipai/paperclip)

---

## 总览

### 项目简介

Paperclip 是一个开源的 AI agent 编排控制平面（control plane）。它把一群异构 AI agent（Claude Code、Codex、Cursor、HTTP bot 等）组织成一家"公司"——用 org chart、目标（goal）、预算（budget）、治理（governance）和审计（audit）来管理它们协同完成业务目标。

如果说 OpenClaw 是一个"员工"，Paperclip 就是这家"公司"。它看起来像一个任务管理器，但底层是完整的组织运营系统：org chart 与汇报线、目标对齐、心跳调度、原子任务领取、成本控制、审批门、插件扩展、多公司隔离与可移植性。

**项目边界**：Paperclip 负责组织、调度、治理 agent，**不负责** agent 本身的构建（不告诉你怎么写 prompt、怎么训练模型），也不是工作流拖拽器或聊天机器人。它管理的是 agent 工作其中的"组织"，而非 agent 自身。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| Bring Your Own Agent | `server/src/adapters/` + `packages/adapters/*` | 任何能接收心跳的 runtime 都可接入（Claude/Codex/Cursor/HTTP） |
| 目标对齐 | `services/issues.ts` goal ancestry + `services/projects.ts` | 每个任务携带完整公司/项目/目标谱系 |
| 心跳执行 | `services/heartbeat.ts` (12,338 行) | DB-backed 唤醒队列 + coalescing + 原子 checkout |
| 成本控制 | `services/budgets.ts` + `services/costs.ts` | 按 company/agent/project 维度的预算硬停 |
| 多公司隔离 | 全表 `companyId` scope + `services/authorization.ts` | 单实例跑多家公司，完整数据隔离 |
| 票据系统 | `services/issues.ts` + `issue-tree-control.ts` | 原子 checkout、blocker 依赖、评论、文档、work products |
| 治理与审批 | `services/issue-execution-policy.ts` + `approvals.ts` | review/approval 阶段门、决策追踪 |
| Org Chart | `services/agents.ts` | 角色、title、汇报线、权限、预算 |
| 插件系统 | `services/plugin-*.ts` (12 文件) | out-of-process worker、capability-gated host service |
| 可移植性 | `services/company-portability.ts` | 导出/导入整个组织（secret scrubbing） |
| 周期任务 | `services/routines.ts` | cron/webhook/API 触发，catch-up 策略 |
| 审计日志 | `services/activity-log.ts` | 不可变 activity log + 实时事件推送 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Node.js ≥ 20 + TypeScript 5.7 | 核心 | 运行时 + 类型系统 |
| pnpm 9.15+ workspace | 核心 | monorepo 包管理（server/ui/cli/packages） |
| Express | 核心 | HTTP API 框架 |
| Drizzle ORM | 核心 | PostgreSQL 数据访问层（`@paperclipai/db`） |
| Embedded PostgreSQL | 核心 | 本地零配置数据库（生产可换外部 PG） |
| Better-Auth | 可选 | authenticated 部署模式的 session 管理 |
| React + Vite | 核心 | UI 前端（`@paperclipai/ui`） |
| OpenTelemetry | 可选 | 服务端 tracing（opt-in） |
| Vitest + Playwright | 开发 | 单元/集成测试 + E2E 浏览器测试 |

### 顶层上下文图

Paperclip 的外部交互方：人类 operator（通过 React UI / CLI / 手机）、被编排的 agent runtime（Claude Code/Codex 等）、以及可选的云上游（cloud sandbox providers）。所有 mutating request 都追溯到一个 actor（board user / agent / 短生命周期 run JWT）。

---

## 快速上手

```bash
# 最简启动（trusted local loopback 模式，嵌入式 PG 自动创建）
npx paperclipai onboard --yes
```

API server 启动于 `http://localhost:3100`，嵌入式 PostgreSQL 自动创建——无需任何外部依赖。

```bash
# 手动开发
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install && pnpm dev    # API + UI watch 模式
```

**端到端验证**：`pnpm dev` 后访问 `http://localhost:3100`，UI 引导创建第一家公司、添加 agent、设定目标，agent 在心跳触发后开始执行 issue 并产生 cost event。

---

## 架构设计解析

### 系统架构

Paperclip 的核心设计思想是**"编排而非实现"**——把 agent 的执行细节交给可插拔的 adapter，自己专注做组织协调：谁（agent）在什么时间（heartbeat）做什么（issue）、在哪做（workspace/environment）、花多少钱（budget）、受谁监督（governance/approval）。这种分层让 agent runtime 可以自由替换而不影响组织逻辑。

![Paperclip 分层架构](/vibe-reading/images/articles/paperclip-codewiki/architecture.svg)

系统分四层：**接口层**（React UI / CLI / HTTP API + WebSocket）负责人机交互；**编排核心**（`server/src/services/`）是控制平面本体，按职责分为四个子系统；**基础设施层**（Embedded PostgreSQL / shared types / object storage / agent adapters）提供持久化与 runtime 接入。编排核心是整个系统的心脏——所有业务逻辑都在这里，上下层都是相对薄的接入层。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|------------------------|
| 接口层 | `ui/src/` · `cli/src/` · `server/src/routes/` | 隔离外部协议（HTTP/CLI/UI），保护核心不受接口变化影响 |
| 编排核心 | `server/src/services/` | 承载全部组织运营逻辑，编排 agent 协同工作 |
| Adapter 层 | `server/src/adapters/` · `packages/adapters/*` | 适配异构 agent runtime，解耦 agent 数据模型与执行细节 |
| 基础设施 | `packages/db/` · `packages/shared/` · `server/src/storage/` | 持久化、类型契约、对象存储，可替换实现 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 工厂 + 闭包 | 所有 `xxxService(db)` 工厂（`heartbeat.ts:3385` 等） | 以 `db` 注入创建服务实例，便于事务内传 tx；闭包共享状态 |
| 队列消费者 | `enqueueWakeup` → `startNextQueuedRunForAgent` (`heartbeat.ts`) | DB-backed 唤醒队列，coalescing + 原子 claim，无内存队列丢数据风险 |
| 策略 | `getServerAdapter(adapterType)` · driver 抽象 · budget scope 矩阵 | 同一接口多实现可替换（adapter/runtime/storage/secret provider） |
| Capability Gate | `host-client-factory.ts` METHOD_CAPABILITY_MAP | 插件最小权限——manifest 声明能力，每次 RPC 调用前校验 |
| 钩子注入 | `budgetService(db, {cancelWorkForScope})` | 解耦 budget 与 heartbeat：budget 不 import heartbeat，仅依赖钩子回调 |
| 原子 CAS | `checkout` 单条 `UPDATE ... WHERE` (`issues.ts:5575`) | 无应用锁防双工，数据库行锁保证只有一个 run 成功 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|----------|
| Company | 一家公司（多租户隔离单位） | 实例级持久 | 1 → N Agent/Issue/Project/Goal |
| Agent | 一个被编排的 AI 员工 | 持久 + 可 pause/terminate | N → 1 Company，1 → N HeartbeatRun |
| Issue | 一个任务票据（ticket） | backlog → done | 携带 goal ancestry，1 → 1 Agent checkout |
| HeartbeatRun | 一次 agent 执行 | queued → terminal | N → 1 Agent + 1 Issue |
| Routine | 周期性任务定义 | 持久 | 触发创建 Issue + 唤醒 Agent |
| Goal | 公司目标（战略意图） | 持久 | 1 → N Project → N Issue |
| Plugin | 扩展插件（out-of-process） | installed → ready → enabled | 贡献 tool/UI/job/driver |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|----------|
| `ServerAdapterModule` | `adapters/types.ts` | claude-local/codex-local/cursor-cloud 等 | `adapters/registry.ts` BUILTIN_ADAPTER_TYPES + 插件 |
| `EnvironmentRuntimeDriver` | `environment-runtime.ts:175` | local/ssh/sandbox/plugin | `environmentRuntimeService` Map 注册 |
| `StorageProvider` | `storage/types.ts:35` | local-disk/s3 | `storage/provider-registry.ts` |
| `SecretProviderModule` | `secrets/provider-registry.ts` | localEncrypted/aws/gcp-stub | `providers` 数组注册 |

---

## 代码目录

```
paperclip/
├── server/                  # 控制平面核心（Node.js + Express）
│   └── src/
│       ├── services/         # 98,000 行 · 全部业务逻辑（12 个子系统模块）
│       ├── routes/           # 36,000 行 · HTTP API 路由（40+ 路由文件）
│       ├── adapters/         # agent runtime 适配器注册表
│       ├── auth/             # Better-Auth 认证
│       ├── middleware/       # Express 中间件（actor/error/log）
│       ├── storage/          # 对象存储 provider（local-disk/s3）
│       ├── realtime/         # WebSocket 实时事件
│       └── app.ts / index.ts # 应用装配 + 进程启动
├── ui/                       # 218,000 行 · React 前端
├── cli/                      # 33,000 行 · paperclipai CLI（onboard/configure）
├── packages/
│   ├── db/                   # 9,000 行 · Drizzle schema（90 张表）+ 迁移
│   ├── shared/               # 20,000 行 · 共享类型与常量
│   ├── adapters/             # 10 个 agent adapter 实现（claude/codex/cursor/...）
│   ├── plugins/              # 插件 SDK + 示例插件
│   ├── mcp-server/          # MCP server 集成
│   ├── skills-catalog/       # 技能目录
│   └── teams-catalog/       # 组织模板目录
├── skills/                   # 内置 paperclip 技能（AGENTS.md 等）
└── tests/                    # E2E + release-smoke 测试
```

---

## 模块地图

Paperclip 的编排核心（`server/src/services/`）含 153 个文件、98,000 行代码。基于 graphify 知识图谱分析（2777 节点、6313 边、112 社区），god node 是 `heartbeatService()`（172 边）——它是整个系统的编排枢纽，内部装配了 issues/budgets/recovery/secrets/environments 等全部子服务。

按根号原则（M=12 → K=⌈√12⌉=4），12 个有效模块归入 4 个子系统，采用两层结构：

![模块依赖关系图](/vibe-reading/images/articles/paperclip-codewiki/module-dependencies.svg)

Heartbeat Engine 是中央枢纽：它被 Routines（enqueueWakeup）和 Identity（run JWT）调用，自身编排 Issues（checkout）、Budget（硬停）、Secrets（注入）、Environments（租约）、Workspace（git worktree）、Plugins（host service）等全部子服务。Recovery 与 Heartbeat 形成回调闭环——recovery 持有 `enqueueWakeup` 引用来触发恢复 run。

| 子系统 | 职责 | 挂载模块数 | 为什么独立 | 深入阅读 |
|--------|------|-----------|-----------|----------|
| 工作执行引擎 | 唤醒、领取、执行、恢复 agent 工作 | 3 | 专注"让 agent 跑起来"的运行时编排 | [→ 子系统](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/01-work-execution) |
| 组织与治理 | 身份、权限、预算、审批 | 3 | 专注"谁能在什么约束下做什么"的治理 | [→ 子系统](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/02-organization-governance) |
| 工作区与运行时 | 执行环境、工作区、项目文档 | 3 | 专注"agent 在哪、用什么资源工作" | [→ 子系统](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/03-workspace-runtime) |
| 平台扩展与可移植 | 插件、公司导入导出、密钥存储 | 3 | 专注"扩展与迁移整个组织" | [→ 子系统](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/04-platform-portability) |

---

## 运行时行为

### 启动流程

```
startServer()                                     index.ts:103
├─ instrumentationReady · loadConfig · initTelemetry     (OTel + 配置)
├─ ensurePostgresDatabase + applyPendingMigrations       (嵌入式 PG / 外部 PG)
├─ ensureLocalTrustedBoardPrincipal · backfillPrincipalAccess  (本地模式 actor)
├─ createBetterAuthInstance · createStorageServiceFromConfig   (认证 + 存储)
├─ createPluginWorkerManager                              (插件子进程管理)
├─ createApp(db, {...})                                   app.ts:129
│   ├─ applyTrustProxy · httpLogger · privateHostnameGuard
│   ├─ actorMiddleware(db) · boardMutationGuard()
│   ├─ 挂载 40+ 路由（health/company/agent/issue/...）
│   ├─ 插件生态：eventBus/jobStore/scheduler/toolDispatcher
│   └─ errorHandler                                       (middleware/error-handler.ts:36)
├─ setupLiveEventsWebSocketServer                         (实时事件 WS)
├─ reconcile* (cloudUpstream/runtimeServices/codexHomes)  (启动对账)
├─ heartbeatService(db, {pluginWorkerManager})            heartbeat.ts:3385
├─ routineService(db, {pluginWorkerManager})
└─ setInterval → tickTimers · reapOrphanedRuns · promoteDueScheduledRetries · reconcile*  (周期 tick)
```

**对象装配**：`heartbeatService(db)` 工厂内部 `new` 出全部子服务并注入依赖（`heartbeat.ts:3386-3418`）——issuesSvc、budgets（注入 `cancelWorkForScope` 钩子）、recovery（注入 `enqueueWakeup` 形成回调闭环）、secrets、environments、executionWorkspaces、companySkills。依赖注入方式是手动构造 + 钩子回调，无 DI 容器。单例在 `index.ts:777` 创建后由 `setInterval` 周期驱动。

### 核心运行流程

下面是 Paperclip 最重要的三条业务链路，覆盖了从触发到执行再到恢复的完整运行模式。

#### 主链路：Heartbeat Run 执行

业务流程：触发（定时器/routine/分配）→ 唤醒入队 → 原子 claim + 守卫校验 → 工作区/密钥/环境准备 → adapter 执行 → 终态 + 释放 + 恢复

![Heartbeat Run 数据流](/vibe-reading/images/articles/paperclip-codewiki/data-flow.svg)

文字描述：`tickTimers`（`heartbeat.ts:12238`）周期扫描到期 agent 调 `enqueueWakeup`（`:10743`），在 DB 事务内 `SELECT ... FOR UPDATE` 锁 agent 行防并发，插入 `heartbeatRuns(status=queued)`。随后 `startNextQueuedRunForAgent`（`:8195`）用 `withAgentStartLock` 串行化，`claimQueuedRun`（`:7247`）串联守卫链——budget 硬停 → pause hold → blocker 依赖 → staleness——通过后原子 `UPDATE ... WHERE status='queued'` 置 running。`executeRun`（`:8273`）准备执行上下文：`issuesSvc.checkout` 原子领取 issue、`resolveWorkspaceForRun` 创建 git worktree、`secretsSvc` 注入 secret、`envOrchestrator.acquireForRun` 申请环境租约，最后 `getServerAdapter(agent.adapterType).execute()` 调用 Claude/Codex 等 adapter。执行结果经 `setRunStatus` 持久化、`releaseIssueExecutionAndPromote`（`:10170`）释放 issue 锁并唤醒 blocked 依赖的后续 run，形成恢复闭环。

#### 治理链路：预算超支自动停摆

业务流程：cost event 入库 → 扫描匹配 policy → 阈值检查 → hard stop → pause agent + cancel 排队 work + 创建审批

文字描述：`costService.createEvent`（`costs.ts:54`）写入 cost event 后调 `budgets.evaluateCostEvent`（`budgets.ts:648`）。该函数按 `scopeType × windowKind` 聚合 cost，达 warn 阈值建 soft incident，达 hard 阈值时 `pauseAndCancelScopeForBudget`（`:252`）——调 `pauseScopeForBudget` 暂停 agent/project，并经注入的 `cancelWorkForScope` 钩子回调 heartbeat 的 `cancelActiveForAgentInternal` + `cancelPendingWakeupsForBudgetScope`，同时创建 `budget_override_required` 审批强制人工决策才能恢复。run 前 `getInvocationBlock`（`:717`）逐层检查 company→agent→project 是否被硬停，任一被阻断即拦截。

#### 触发链路：Routine 周期执行

业务流程：cron 到期 → tickScheduledTriggers 扫描 → CAS claim → dispatchRoutineRun → 创建 tracked issue → 唤醒指派 agent

文字描述：`index.ts:854` 的 `setInterval` 调 `routines.tickScheduledTriggers`（`routines.ts:2601`），扫描 due 的 schedule trigger 用 `WHERE nextRunAt=原值` 条件 update 抢占（CAS 防多实例重复）。`dispatchRoutineRun`（`:1373`）事务内锁 routine、计算 dispatchFingerprint（sha256 幂等去重）、按 `concurrencyPolicy`（always_enqueue/skip_if_active/coalesce）决定是否创建 issue，最终调 `issueSvc.create` 建 tracked issue 并 `queueIssueAssignmentWakeup` 唤醒指派 agent。

### 状态流

Paperclip 有两个核心状态机：heartbeat run 的执行状态机和 issue 的票据状态机。

![状态流转图](/vibe-reading/images/articles/paperclip-codewiki/state-flow.svg)

**heartbeat_runs 状态机**（`heartbeat.ts:238-285`）：`queued` → `running`（claimQueuedRun 原子 CAS）→ 终态 `succeeded`/`failed`/`cancelled`/`timed_out`（setRunStatus）。瞬态失败走 `scheduled_retry`（有界退避 `[2m,10m,30m,2h]`，最多 4 次），由 `promoteDueScheduledRetries` 提升回 `queued`。状态枚举定义在 `heartbeat.ts:240` 的 `HEARTBEAT_RUN_TERMINAL_STATUSES`，转换方法 `setRunStatus`（`:4936`），`reapOrphanedRuns`（`:7940`）检测进程丢失的 running run。

**issues 状态机**（`issues.ts:96-116`）：`backlog` → `todo` → `in_progress`（checkout）→ `in_review` → `done`（approve）；`blocked`（blocker 未解决）可回 `in_progress`（resolve）；任意状态可 `cancelled`。`assertTransition`（`:109`）校验合法性，`applyStatusSideEffects`（`:116`）自动设 startedAt/completedAt。issue execution policy（`issue-execution-policy.ts:612`）在 status 之上叠加 review/approval stage 状态机（idle → pending → completed/changes_requested）。

---

## 典型修改场景

#### 场景 1：新增一种 agent runtime adapter

新增一个 agent runtime（如 Novita cloud agent）需改：`packages/adapters/` 下新建 adapter 包实现 `ServerAdapterModule` 接口（`execute`/`sessionCodec`/`testEnvironment`）；`server/src/adapters/registry.ts` 的 `BUILTIN_ADAPTER_TYPES` 注册（或通过插件 `environment.drivers` 声明）；`server/src/adapters/builtin-adapter-types.ts` 加 type 常量。agent 行只存 `adapterType` 字符串，schema 不变。对应测试：`packages/adapters/<name>/test/`。

#### 场景 2：新增预算 scope 维度（如按 goal 维度限费）

需改：`budgets.ts` 的 `BudgetScopeType` 类型加 `goal`；`resolveScopeRecord`（`:82`）加 goal 分支；`computeObservedAmount`（`:143`）加 `costEvents.goalId` 过滤；`evaluateCostEvent`（`:648`）的 candidate filter 扩展；`getInvocationBlock`（`:717`）加 goal 层级检查。对应测试：`server/src/services/__tests__/budgets.test.ts`。

#### 场景 3：新增插件 host capability（如 notifications.send）

需改：`packages/plugins/sdk/src/host-client-factory.ts` 的 `METHOD_CAPABILITY_MAP`（`:354`）加映射；`plugin-capability-validator.ts` 的 `OPERATION_CAPABILITIES`（`:36``）加项；`plugin-host-services.ts` 的 `buildHostServices()`（`:490`）加 service adapter；SDK `types.ts` 加方法签名。对应测试：`packages/plugins/sdk/__tests__/`。

---

## 测试体系

```
server/src/__tests__/          # 服务层单元 + 集成测试（Vitest）
server/src/__tests__/fixtures/ # 测试夹具
tests/e2e/                    # Playwright 浏览器端到端测试
tests/release-smoke/          # 发布前冒烟测试
packages/*/__tests__/          # 各包单元测试
evals/promptfoo/              # prompt 评测
```

| 代码层 | 测试类型 |
|--------|----------|
| services/* | 单元 + 集成（Vitest，`pnpm test:run`） |
| routes/* | 集成（通过 service 层） |
| adapters/* | 各 adapter 包自带测试 |
| UI | E2E（Playwright，`pnpm test:e2e`） |

`pnpm test` 只跑 Vitest（cheap default），不跑 Playwright——浏览器套件独立运行。若想理解某 service，优先看 `server/src/__tests__/` 下对应测试。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `server/src/index.ts` 的 `startServer()` → `server/src/app.ts` 的 `createApp()` → `server/src/services/heartbeat.ts:3385` 的 `heartbeatService(db)` 工厂 → `enqueueWakeup`（`:10743`）→ `claimQueuedRun`（`:7247`）→ `executeRun`（`:8273`）→ `releaseIssueExecutionAndPromote`（`:10170`）
- **第二遍：理解核心数据结构**
  `packages/db/src/schema/heartbeat_runs.ts` + `issues.ts` + `agents.ts` 的表定义 → `heartbeat.ts:238-285` 的状态枚举 → `issues.ts:96-116` 的 issue status 状态机
- **第三遍：理解扩展机制**
  `server/src/adapters/registry.ts` 的 `getServerAdapter`（Bring Your Own Agent）→ `services/plugin-loader.ts:2074` 的 `activatePlugin`（插件激活）→ `host-client-factory.ts:354` 的 `METHOD_CAPABILITY_MAP`（capability gate）
- **第四遍：选择子系统深入阅读**
  从下方的子系统导航进入任一子系统概览，再进模块文件

---

## 附录

### 术语表

| 术语 | 解释 |
|------|------|
| Heartbeat | agent 的周期性唤醒机制，类似员工"打卡上班" |
| Issue | 任务票据，agent 工作的基本单位 |
| Run | 一次 heartbeat 执行的实例（heartbeatRuns 表） |
| Checkout | agent 原子领取 issue 的动作（执行锁） |
| Coalescing | 同一 task scope 的多次唤醒合并为一个 run |
| Org Chart | agent 的组织架构（汇报线 reportsTo） |
| Goal ancestry | issue 携带的公司→项目→目标→父任务谱系 |
| Board | 公司的治理者（人类 operator） |
| Adapter | agent runtime 的可插拔适配器 |
| Capability Gate | 插件调用 host service 前的最小权限校验 |

### 参考资料

- [Paperclip 官方文档](https://paperclip.ing/docs)
- [GitHub 仓库](https://github.com/paperclipai/paperclip)
- [awesome-paperclip 插件目录](https://github.com/gsxdsm/awesome-paperclip)
