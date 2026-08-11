---
source:
  type: "源码解读"
  project: "multica"
  url: "https://github.com/multica-ai/multica"
title: "Overview"
date: "2026-08-11T20:31:27+08:00"
category: [AI, Agent, Team, Multica, CodeWiki, "0.3.28"]
tags: ["multica", "Go", "TypeScript", "Agent Platform", "Coding Agent", "WebSocket", "PostgreSQL"]
description: "Multica 是开源的托管编码智能体平台——把 Claude Code、Codex 等 CLI 变成真正的团队成员。本文全面解读 v0.3.28 的架构、任务生命周期与核心模块。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.3.28 · **协议** Apache 2.0 (modified) · **语言** Go 1.26 + TypeScript · **代码量** ~230k 行 Go + ~190k 行 TS · **仓库** [GitHub](https://github.com/multica-ai/multica)

---

## 总览

### 项目简介

Multica 是一个开源的托管编码智能体平台（managed agents platform），核心使命是把编码智能体变成真正的团队成员。像给同事分配任务一样，把一个 issue 指派给一个 agent，它会自己认领、写代码、汇报进度、更新状态——不需要人一直盯着终端。

它解决的传统 AI coding agent 痛点是：每次都要复制粘贴 prompt、必须守着终端看它跑、没有跨任务记忆、每次从零开始。Multica 的方案是**多路复用（multiplexing）**——名字 Multica 即 **Mul**tiplexed **I**nformation and **C**omputing **A**gent，致敬 1960 年代引入分时操作系统的 Multics。对于编码智能体而言，"分时"意味着一个小团队加一支 agent 舰队可以打出大团队的产出。

核心使用场景：在看板上创建 issue → 分配给 agent → agent 在用户的 runtime 上自动执行编码 CLI → 进度实时流式上报 → 结果沉淀为可复用 skill。支持 **Claude Code**、**Codex**、**GitHub Copilot CLI**、**Cursor Agent**、**Gemini**、**Hermes**、**Kimi**、**Kiro CLI** 等 14 种编码 CLI。

**项目边界**：负责 agent 的任务编排、生命周期管理、进度推送、skill 沉淀与多租户隔离；**不负责**实际调用 LLM、执行工具调用——这些由各编码 CLI 子进程完成，Multica 通过 `pkg/agent` 抽象层统一调度但不介入 CLI 内部逻辑。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| Agent 作为团队成员 | `handler/` + `service/` | 分配 issue、发评论、创建 issue、报阻塞，与人对等 |
| Task 生命周期 | `service/task.go` | enqueue → claim → start → complete/fail，队列化执行 |
| 多 CLI 统一调度 | `pkg/agent/` | 14 种编码 CLI 的 Backend 接口抽象 |
| 本地 Daemon 执行 | `internal/daemon/` | 轮询/唤醒领取 task，调用 CLI 子进程，流式上报 |
| 实时进度推送 | `internal/realtime/` | WebSocket hub + Redis 分片中继，多节点 fanout |
| Autopilot 定时调度 | `internal/scheduler/` | DB-backed cron，自动创建 issue 派给 agent |
| Squad 小队路由 | `service/` + migration 084 | leader agent 委派给成员，`@FrontendTeam` 而非 `@alice-or-bob` |
| Skill 技能复用 | `internal/skill/` + `pkg/skillbundle/` | 工作区级可复用说明，注入 agent 工作目录 |
| 集成（飞书/GitHub） | `internal/integrations/` + `handler/github.go` | Lark WS 长连接、GitHub webhook |
| 多工作区隔离 | `handler/` + `middleware/` | workspace 级 issue/agent/skill 隔离 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Go 1.26 | 核心 | 后端语言 |
| Chi v5 | 核心 | HTTP router |
| gorilla/websocket | 核心 | WebSocket（前端实时 + daemon 连接） |
| pgx/v5 + sqlc | 核心 | PostgreSQL 驱动 + 类型安全 SQL 代码生成 |
| PostgreSQL 17 + pgvector | 核心 | 持久化 + 向量检索 |
| Redis | 核心 | 实时分片中继 + 负缓存 + skill 存储 |
| spf13/cobra | 核心 | CLI 框架（`multica` 命令） |
| robfig/cron/v3 | 核心 | Autopilot cron 表达式解析 |
| Next.js 16 (App Router) | 前端 | Web 应用 |
| Electron | 前端 | 桌面客户端 |
| TanStack Query + Zustand | 前端 | 服务器状态缓存 + 客户端状态 |
| Prometheus | 可选 | 指标暴露 |
| Resend / SMTP | 可选 | 邮件验证码 |

### 版本历史

Multica 处于快速迭代期（v0.3.x），本文解读的 v0.3.28 是截至解读时的最新 tag（HEAD 已领先 17 个 commit）。关键演进：v0.2 引入 agent_runtime 表分离 runtime 与 agent；v0.3 引入 Squad（084）、Autopilot DB-backed scheduler（MUL-2957）、Lark `lark_*`→`channel_*` 表迁移（MUL-3515，migration 124 过渡期）、realtime Redis 分片中继（MUL-1138）替代 per-scope stream。

---

## 快速上手

```bash
# 安装 CLI（macOS/Linux）
brew install multica-ai/tap/multica

# 一键配置 + 登录 + 启动 daemon
multica setup

# 自托管：加 --with-server 部署完整 server
curl -fsSL https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh | bash -s -- --with-server
multica setup self-host
```

`multica setup` 后 daemon 在后台运行，自动探测 PATH 上的 agent CLI（`claude`、`codex`、`copilot` 等）。打开 Web 应用的 **Settings → Runtimes** 应看到本机列为 active Runtime。创建 agent、分配 issue，agent 自动认领执行。

开发者本地构建：

```bash title="开发环境"
make dev    # 自动检测环境、装依赖、建库、跑 migration、启全部服务
```

依赖：Node.js v20+、pnpm v10.28+、Go v1.26+、Docker。

---

## 架构设计解析

### 系统架构

Multica 的架构思想是**计算与编排分离**：Server 不直接执行 agent、不调 LLM，只负责任务编排、持久化、权限、事件广播；Daemon 跑在用户机器上，负责探测并启动 CLI 子进程、管理工作目录、流式上报。这种分离让 Server 可以无状态横向扩展（配合 Redis 中继），而执行能力按需分布在用户机器或云端。

![Multica 分层架构](/vibe-reading/images/articles/multica-internals/architecture.svg)

系统分四层：客户端层（Next.js Web / Electron / CLI）通过 HTTP + WebSocket 连接 Go Backend；Backend 内部分 API 层（Chi Router + Handler）、服务层（TaskService / AutopilotService + Events Bus）、实时层（Realtime Hub + Daemon WS Hub）、调度层（Scheduler）；数据层是 PostgreSQL + Redis。Daemon 作为独立进程跑在用户机器上，通过 WebSocket 接收 task 唤醒、HTTP 认领/上报任务，调用 `pkg/agent` 启动编码 CLI 子进程。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|--------------------------|
| 客户端层 | `apps/web`、`apps/desktop`、`cmd/multica` | UI 渲染、本地状态、服务器状态缓存；不含业务规则 |
| API 层 | `internal/handler/` | 隔离 HTTP 协议，鉴权、解析、响应组装，保护核心业务 |
| 服务层 | `internal/service/` | 编排用例流程、事务管理、事件广播，协调领域对象协作 |
| 实时层 | `internal/realtime/`、`internal/daemonws/` | WebSocket 连接管理与事件 fanout，解耦生产者与消费者 |
| 调度层 | `internal/scheduler/` | DB-backed 分布式定时任务，租约 + 审计 |
| 执行层 | `internal/daemon/`、`pkg/agent/` | 探测启动 CLI、管理工作目录、流式 drain；不感知业务模型 |
| 数据层 | `pkg/db/`、`migrations/` | sqlc 生成的类型安全查询，封装持久化细节 |
| 集成层 | `internal/integrations/` | 适配外部 IM 平台（飞书/Lark），平台无关契约 + 具体适配器 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 策略 + 工厂 | `pkg/agent/agent.go` `New()` + `Backend` interface | 14 种 CLI 统一调度，运行时按 provider 选择策略 |
| 适配器 | 每个 provider 文件（`claude.go` 等） | 把 CLI 私有协议（stream-json/JSON-RPC/JSONL/ACP）翻译为统一 Message/Result |
| 发布-订阅 | `internal/events/bus.go` + `listeners.go` | Service 层 emit 事件解耦 UI 推送，panic 隔离不互相影响 |
| 租约 | `scheduler/db_ops.go` + `service/task.go` | 分布式 claim 防重复执行，crash 后自动回收 |
| 桥接 | `realtime.DualWriteBroadcaster` | 本地立即投递 + Redis 跨节点中继两个维度组合 |
| 注册表 | `integrations/channel/registry.go` | 新增 IM 平台只需 Register factory，不改 core |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|----------|----------|
| **Workspace** | 一切资源的容器，多租户边界 | 长期 | 包含 issue/agent/skill/project |
| **Issue** | 工作单元（任务/bug/feature），最核心产品对象 | 创建→分配→执行→完成 | 分配给 member/agent/squad |
| **Agent** | 可被指派任务的 AI 工作者，有 profile | 创建→配置→（归档） | 绑定 runtime + provider |
| **Runtime** | agent 实际跑在哪里的执行环境 | 注册→online→offline→GC | 一个 runtime = 一台可跑 agent 的机器 |
| **Task** | agent 执行一次 issue 产生的一次运行 | queued→dispatched→running→completed/failed | 队列化，属于 agent + runtime |
| **Autopilot** | 定时/触发自动化规则 | active→paused→(archived) | cron 触发创建 issue 派给 agent |
| **Squad** | leader agent 带队的小队 | 创建→(归档) | leader 委派给成员 |
| **Skill** | 工作区级可复用说明文档 | 创建→更新→(删除) | agent 开跑时注入工作目录 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
|-----------|----------|--------|----------|
| `agent.Backend` | `pkg/agent/agent.go:16` | `claudeBackend`、`codexBackend` 等 14 个 | `agent.New(provider, cfg)` 工厂 switch |
| `realtime.Broadcaster` | `realtime/broadcaster.go:23` | `*Hub`、`*RedisRelay`、`*ShardedStreamRelay`、`*DualWriteBroadcaster` | main.go 按 `REDIS_URL` 选择 |
| `scheduler.JobSpec` | `scheduler/spec.go` | `TaskUsageHourlyJob`、`AutopilotScheduleDispatchJob` | `Manager.Register(job)` |
| `channel.Channel` | `integrations/channel/channel.go` | `lark/` 包 | `Registry.Register(type, factory)` |
| `service.TaskWakeupNotifier` | `service/task.go:48` | `daemonws.Hub`、`daemonws.RelayNotifier` | main.go 注入 |
| `daemon.taskRunner` | `internal/daemon/daemon.go:71` | `taskRunnerFunc(d.runTask)` | Daemon 构造时赋值，测试可替换 |

> **Polymorphic Actor 设计范式**：几乎所有"谁做了什么"的字段都是 `actor_type`（`member`/`agent`）+ `actor_id`。这就是为什么 agent 能像人一样创建 issue、发评论、被订阅——贯穿所有表的多态行动者设计。

---

## 代码目录

```
multica/
├── apps/                          # 前端应用
│   ├── web/                       #   Next.js 16 Web（~16k 行）
│   ├── desktop/                   #   Electron 桌面（~13k 行）
│   ├── mobile/                    #   iOS 客户端
│   └── docs/                      #   文档站
├── packages/                      # 共享 TS 包
│   ├── core/                      #   领域逻辑 + React Query hooks（~31k 行）
│   ├── views/                     #   共享视图组件（~121k 行）
│   └── ui/                        #   UI 基础组件（~10k 行）
├── server/                        # Go 后端（~230k 行）
│   ├── cmd/
│   │   ├── server/                #   HTTP server 入口 + 装配（main.go/router.go/listeners.go）
│   │   ├── multica/               #   用户 CLI（~20k 行）
│   │   ├── migrate/               #   数据库迁移工具
│   │   └── backfill_*/            #   数据回填工具
│   ├── internal/
│   │   ├── handler/               #   HTTP API（147 文件，~79k 行）
│   │   ├── daemon/                #   本地执行守护进程（~41k 行）
│   │   ├── integrations/          #   IM 集成（channel 抽象 + lark 适配器，~23k 行）
│   │   ├── service/               #   业务编排（task/autopilot/issue，~8k 行）
│   │   ├── realtime/              #   WebSocket hub + Redis 中继（~3k 行）
│   │   ├── daemonws/              #   daemon WS hub（~1.4k 行）
│   │   ├── scheduler/             #   DB-backed cron 调度（~2.9k 行）
│   │   ├── auth/                  #   JWT + PAT 认证
│   │   ├── middleware/            #   HTTP 中间件
│   │   ├── metrics/               #   Prometheus 指标
│   │   └── events/                #   进程内事件总线
│   ├── pkg/
│   │   ├── agent/                 #   多 CLI 抽象层（~30k 行，14 providers）
│   │   ├── db/                    #   sqlc 生成查询 + 原始 SQL（~19k 行）
│   │   ├── protocol/              #   共享事件类型常量
│   │   ├── featureflag/           #   特性开关
│   │   ├── taskfailure/           #   失败原因分类
│   │   └── skillbundle/           #   skill 打包
│   └── migrations/                #   125+ SQL migrations
├── deploy/                        # Helm chart + Docker
└── e2e/                           # 端到端测试
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/multica-internals/module-dependencies.svg)

模块间依赖方向：**Task API & Service** 是中枢——向上通过 events bus 驱动 Realtime 广播、通过 Wakeup 接口唤醒 Daemon，向下访问 DB。**Daemon** 是独立的执行进程（用户机器上），import `pkg/agent` 启动 CLI 子进程，通过 HTTP/WS 与 Server 交互（虚线表示跨进程）。**Scheduler** 的 AutopilotService 委托 TaskService 入队。**Integrations** 通过 IssueService/TaskService 接口创建 issue 和入队 task。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|------------|----------|
| Agent Runtime | 统一 14 种编码 CLI 的执行抽象 | `agent.New()` | 每种 CLI 协议差异大，需适配器层隔离；纯标准库无内部依赖 | [01-agent-runtime](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/01-agent-runtime) |
| Daemon 执行引擎 | 本地领取 task、执行 CLI、流式上报 | `Daemon.Run()` | 执行逻辑跑在用户机器上，与 Server 分离；管理 worktree/缓存/心跳 | [02-daemon-engine](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/02-daemon-engine) |
| Task API & Service | REST API + task 生命周期编排 | `TaskService` | 业务编排与 HTTP 传输分离；claim/lease/retry 是核心业务规则 | [03-task-api](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/03-task-api) |
| Realtime 实时推送 | WebSocket 事件 fanout + 多节点中继 | `realtime.Hub` | 实时推送是独立关注点；多节点扩展需 Redis 中继抽象 | [04-realtime](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/04-realtime) |
| Scheduler & Autopilot | DB-backed 定时调度 + 自动派活 | `scheduler.Manager` | 分布式定时需 DB 租约防重复；Autopilot 是独立业务场景 | [05-scheduler-autopilot](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/05-scheduler-autopilot) |
| Integrations | IM 平台集成（飞书/Lark） | `lark.Hub` | 平台无关契约 + 具体适配器；WS 长连接 lease 独立于 HTTP | [06-integrations](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/06-integrations) |

---

## 运行时行为

### 启动流程

`main()` in `server/cmd/server/main.go:123` 的启动链：

```
logger.Init()                                    # 结构化日志
featureflag.NewServiceFromEnv()                  # 特性开关（YAML + env 覆盖）
newDBPool(ctx, dbURL)                            # pgx 连接池 → Ping
events.New()                  → bus              # 进程内同步事件总线
realtime.NewHub()             → hub, go hub.Run()# 前端 WS hub
daemonws.NewHub()             → daemonHub        # daemon WS hub
[REDIS_URL?] → ShardedStreamRelay / DualWrite    # Redis 分片中继（多节点 fanout）
registerListeners(bus, broadcaster)              # events.Bus → realtime.Broadcaster 桥接
db.New(pool)                                     # sqlc 查询对象
registerSubscriberListeners / ActivityListeners / NotificationListeners  # 事件监听器
NewRouterWithOptions(pool, hub, bus, ...)        # Chi 路由 + Handler 装配
service.NewTaskService(queries, pool, hub, bus, daemonWakeup)
service.NewAutopilotService(queries, pool, bus, taskSvc)
registerAutopilotListeners(bus, autopilotSvc)
go runRuntimeSweeper(...)                        # 标记 stale runtime offline
go heartbeatScheduler.Run(...)                   # 批量心跳刷新
go runAutopilotFailureMonitor(...)               # 自动暂停失控 autopilot
scheduler.NewManager(pool) → Register(jobs) → go Run()  # DB-backed cron
srv.ListenAndServe()                             # HTTP :8080
```

对象装配顺序有依赖关系：`broadcaster` 必须在 `registerListeners` 前确定（单节点 Hub 或 Redis DualWrite）；`TaskService` 必须在 `AutopilotService` 前构造（AutopilotService 持有 TaskService 引用）；`scheduler` 的 job 在 `Manager.Run` 前注册。依赖注入方式是手动构造 + 构造函数传参（无 DI 容器），`Handler` struct 持有所有 service。

### 核心运行流程

Multica 有两条核心业务链路：**agent task 执行**（用户分配 issue → agent 执行 → 完成）和 **autopilot 定时触发**（cron → 自动创建 issue → 派给 agent）。两者在 task 入队后汇合到同一条执行链路。

#### 主链路：Agent Task 端到端执行

业务流程：用户分配 issue → TaskService 入队（queued）→ daemon 被唤醒 → HTTP claim（dispatched）→ StartTask（running）→ agent CLI 执行 → 流式上报进度 → Complete/Fail（终态）→ 前端实时收到。

![Agent Task 端到端数据流](/vibe-reading/images/articles/multica-internals/data-flow.svg)

文字解读：`IssueService.Create` 创建 issue 后调 `TaskService.EnqueueTaskForIssue`（`task.go:435`）——先 `CreateAgentTask` 写 `agent_task_queue`（status=queued），再 `broadcastTaskEvent(EventTaskQueued)` 通过同步事件总线推前端 WS，最后 `notifyTaskAvailable` 通过 `Wakeup.NotifyTaskAvailable` 唤醒 daemon。顺序很重要：先广播再唤醒，保证 UI 先看到 queued 再看到 dispatch，避免状态跳变。

Daemon 的 `runRuntimePoller`（`daemon.go:2498`）被 WS 唤醒或定时触发后，先 `waitForTaskSlot` 获取并发槽位（`max_concurrent_tasks`），再 HTTP `ClaimTask`。Server 侧 `ClaimTaskForRuntime`（`task.go:1040`）用 `ClaimAgentTask` SQL——`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` 原子认领，per-(issue, agent) 序列化防止同一 agent 重复跑同一 issue。Claim 返回 task + `mat_` task-scoped token。Daemon 调 `StartTask` 转 running，再 `agent.New(provider).Execute()` 启动 CLI 子进程，drain `Session.Messages` channel 流式上报 `ReportProgress`。执行完 `CompleteTask`/`FailTask` 回写终态。

关键数据结构变化：`db.Issue` → `db.AgentTaskQueue`（queued）→（dispatched）→（running）→ `agent.Message` 流 → `agent.Result` → `db.AgentTaskQueue`（completed/failed）。

#### 副链路：Autopilot 定时触发

业务流程：scheduler tick → cron 表达式算 plan_time → DB lease claim → `DispatchAutopilotForPlan` → 准入检查（runtime 在线？）→ create_issue 模式创建 issue 并入队 / run_only 模式直接建 task → 唤醒 daemon → 汇入主链路执行。

文字解读：`scheduler.Manager.Run`（`manager.go:95`）每 `TickInterval`（默认 30s）调 `runJob`，`autopilotPlansForScope`（`jobs_autopilot.go:227`）用 `service.NextOccurrencesUTC` 从 cron 表达式算出 plan_time。`tryClaim`（`db_ops.go:57`）在 `sys_cron_executions` 表 `INSERT ON CONFLICT DO NOTHING` 获取分布式 lease。Lease 赢家调 `autopilotHandler` → `AutopilotService.DispatchAutopilotForPlan`（`autopilot.go:97`），先幂等查 `autopilot_run` 表（partial unique index `uq_autopilot_run_trigger_planned`），再 `shouldSkipDispatch` 准入检查（runtime 离线则记 `skipped` 不入队），最后 `dispatchCreateIssue` 或 `dispatchRunOnly` 入队 task——汇入主链路。

### 状态流

![agent_task_queue 状态机](/vibe-reading/images/articles/multica-internals/state-flow.svg)

Task 状态机定义在 `protocol/events.go` 的事件注释中，状态枚举在 `migrations/001_init.up.sql` 的 CHECK constraint：`queued`、`dispatched`、`running`、`waiting_local_directory`、`completed`、`failed`、`cancelled`。

- `∅ → queued`：`EnqueueTaskForIssue` / retry create
- `queued → dispatched`：`ClaimAgentTask`（`FOR UPDATE SKIP LOCKED`）
- `dispatched → running`：`StartTask`（daemon 确认开始执行）
- `dispatched → waiting_local_directory`：daemon 发现 `local_directory` 路径被占，parked 等路径释放后回 `dispatched`
- `running → completed/failed`：`CompleteTask`/`FailTask`
- `* → cancelled`：用户取消
- `failed → queued`（retry）：infra 类失败（`runtime_offline`/`timeout` 等）且 `attempt < max_attempts` 时 `CreateRetryTask` 继承 `session_id`

崩溃恢复三层兜底：`prepare_lease`（45s，claim→start 间租约）、`claimResponseRecoveryWindow`（90s，claim 响应丢失恢复）、`RecoverOrphanedTasks`（daemon 启动时原子 fail 该 runtime 的 dispatched/running 任务）。

---

## 典型修改场景

#### 场景 1：新增一种编码代理 CLI（如 Windsurf）

- 新建 `server/pkg/agent/windsurf.go`：实现 `Backend` interface（`Execute` 返回 `*Session`）+ `windsurfBlockedArgs` + `buildWindsurfArgs` + `discoverWindsurfModels`
- `server/pkg/agent/agent.go`：`New()` switch（`:177`）加 case；`SupportedTypes`（`:144`）加 "windsurf"（须与 DB `runtime_profile.protocol_family` CHECK 同步）
- `server/pkg/agent/models.go`：`ListModels` switch 加分支
- 对应测试：`server/pkg/agent/windsurf_test.go`

#### 场景 2：新增一种 task 状态（如 paused）

- DB migration：修改 `agent_task_queue.status` CHECK constraint
- `pkg/db/queries/`：新增 `PauseAgentTask` 查询，重新生成 sqlc
- `service/task.go`：新增 `PauseTask()` + `broadcastTaskEvent`
- `handler/daemon.go`：新增 `PauseTask` handler
- `cmd/server/router.go`：daemon route group 加 `r.Post("/tasks/{taskId}/pause", h.PauseTask)`
- `pkg/protocol/events.go`：新增 `EventTaskPaused` 常量

#### 场景 3：新增一个 Autopilot 定时 job

- 新建 `server/internal/scheduler/jobs_xxx.go`：定义 `XxxJob(pool) JobSpec`（参照 `jobs_task_usage.go:36`）
- `cmd/server/main.go:417` 附近加 `schedulerMgr.Register(scheduler.XxxJob(pool))`
- 不需改 `manager.go`/`spec.go`/`db_ops.go`——scheduler 框架是通用骨架

---

## 测试体系

```
server/
├── internal/*/          # 各包内 *_test.go（单元测试）
├── cmd/server/*_test.go # 装配层测试（listeners、sweeper、scope authorizer）
└── e2e/                 # 端到端测试
```

| 代码层 | 测试类型 | 示例 |
|--------|----------|------|
| `pkg/agent` | 单元测试（协议解析） | `claude_test.go`、`codex_test.go`——每种 provider 的 stream-json/JSONL 解析 |
| `internal/service` | 单元测试（业务逻辑） | `task_notify_test.go`、`autopilot_test.go` |
| `internal/realtime` | 单元测试（hub/relay） | `hub_test.go`、`sharded_stream_relay_test.go` |
| `internal/scheduler` | 集成测试（lease/recovery） | `migrate_concurrent_test.go` |
| `cmd/server` | 集成测试（装配） | `integration_test.go`、`listeners_frame_test.go` |

测试特点：`pkg/agent` 用 `taskRunner` interface 注入 fake，无需启动真实 CLI 子进程；`scheduler` 用 `RunOnce` 单 tick 测试 lease 竞争；handler 层有 `comment_attachment_integration_test.go` 等跨模块集成测试。理解某个模块时优先读对应 `_test.go`——它们是可执行的文档。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `server/cmd/server/main.go:123`（启动装配）→ `server/cmd/server/listeners.go:24`（事件桥接）→ `server/internal/service/task.go:435`（`EnqueueTaskForIssue`）→ `server/internal/service/task.go:965`（`ClaimTask`）→ `server/internal/daemon/daemon.go:2498`（`runRuntimePoller`）→ `server/pkg/agent/agent.go:16`（`Backend` interface）

- **第二遍：理解核心数据结构**
  `server/migrations/001_init.up.sql`（`agent_task_queue` 表）→ `server/migrations/004_agent_runtime_loop.up.sql`（`agent_runtime` + claim 索引）→ `server/migrations/022_task_lifecycle_guards.up.sql`（one-pending-task-per-issue）→ `server/pkg/protocol/events.go`（事件类型 + 状态机注释）

- **第三遍：理解 claim 机制与并发控制**
  `server/pkg/db/queries/agent.sql:267`（`ClaimAgentTask` 的 `FOR UPDATE SKIP LOCKED`）→ `server/internal/service/empty_claim_cache.go`（负缓存 + 版本化失效）→ `server/internal/service/task.go:1584`（`MaybeRetryFailedTask` 自动重试）→ `server/internal/scheduler/db_ops.go:57`（`tryClaim` 分布式 lease）

- **第四遍：选择重点模块深入阅读**
  [Agent Runtime](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/01-agent-runtime)（多 CLI 适配）→ [Daemon 执行引擎](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/02-daemon-engine)（执行守护进程）→ [Task API](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/03-task-api)（生命周期）→ [Realtime](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/04-realtime)（实时推送）→ [Scheduler](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/05-scheduler-autopilot)（定时调度）→ [Integrations](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/06-integrations)（IM 集成）

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| **Runtime** | agent 的执行环境（本地机器 via daemon，或云端实例） |
| **Daemon** | 用户机器上的后台进程，轮询/唤醒领取 task，执行 CLI 子进程 |
| **Provider** | 编码 CLI 类型（claude/codex/copilot 等），`pkg/agent` 的 `Backend` 实现 |
| **Session Resumption** | 同一对 (agent, issue) 复用上次 Claude Code 的 `session_id` 和 `work_dir` |
| **Handoff** | agent 替换/squad leader 提升时传递的上下文 note |
| **Polymorphic Actor** | `actor_type`（member/agent）+ `actor_id` 范式，agent 与人对等 |
| **mat_ token** | task-scoped 凭证，agent 子进程只拿到单 task 权限 |
| **Scope** | realtime 路由域（workspace/user/task/chat/daemon_runtime） |

### 参考资料

- [Multica GitHub](https://github.com/multica-ai/multica) · [官网](https://multica.ai) · [Discord](https://discord.gg/W8gYBn226t)
- [Self-Hosting Guide](https://github.com/multica-ai/multica/blob/main/SELF_HOSTING.md)
- 内部文档：`docs/product-overview.md`（产品全景）、`docs/feature-flags.md`（特性开关）
