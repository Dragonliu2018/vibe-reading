---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Overview"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "LangGraph", "Agent", "ByteDance"]
description: "ByteDance 开源的 super agent harness——基于 LangGraph 编排 sub-agents、memory、sandboxes 与 extensible skills 的端到端架构解读。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v2.0.0 · **协议** MIT · **语言** Python ≥ 3.12 / Node.js ≥ 22 · **代码量** ~190,000 行（harness 100k + gateway 32k + frontend 58k）· **仓库** [GitHub](https://github.com/bytedance/deer-flow)
>
> 本文基于 `main` 分支 commit `88252e9b`（v2.0.0 发布后的持续开发版本，pyproject 声明 2.1.0）。DeerFlow 2.0 是全面重写，与 v1 无共享代码。

---

## 总览

### 项目简介

DeerFlow（**D**eep **E**xploration and **E**fficient **R**esearch **Flow**）是 ByteDance 开源的 **super agent harness**——一个编排 **sub-agents**、**long-term memory**、**sandboxes** 与 **extensible skills** 来"几乎做任何事"的 agent 运行框架。它不只是一个 agent，而是一套让 agent 能被装配、运行、记忆、扩展、接入多种入口（HTTP / IM / 终端）的完整 harness。

核心价值：用 **LangGraph 图**（非线性 chain）装配 agent，用 **15+ 中间件洋葱栈**解耦横切关注点（循环检测/上下文压缩/技能激活/错误重试/安全终止），用 **可插拔 provider** 适配多家 LLM 与沙箱后端，用 **SKILL.md 声明式技能包**实现"powered by extensible skills"。

**项目边界**：DeerFlow 是 agent harness（负责 agent 的装配、运行、状态、扩展），不是 LLM 本身、不是训练框架、不是向量数据库。它的"智能"来自配置接入的 LLM（Doubao/DeepSeek/Kimi/Claude/Gemini/vLLM 等），harness 提供的是把这些 LLM 变成可用 super agent 的基础设施。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| Agent 图装配 | `agents/lead_agent/agent.py` | `make_lead_agent` + LangGraph `create_agent` |
| 中间件栈 | `agents/middlewares/` | 15+ 中间件洋葱模型，`build_middlewares` 装配 |
| 子代理 | `subagents/executor.py` | `SubagentExecutor` 隔离执行 + `SubagentLimitMiddleware` 限流 |
| 长期记忆 | `agents/memory/` | 多后端（DeerMem/Honcho/OpenViking/mem0/noop），FTS5 检索 |
| Run 生命周期 | `runtime/runs/` | `RunManager` + `run_agent` worker + lease/heartbeat |
| 技能系统 | `skills/` | SKILL.md frontmatter + SkillScan 安全扫描 + 多用户隔离 |
| 沙箱执行 | `sandbox/` + `community/*_sandbox/` | 可插拔 provider（local/AIO/E2B/Boxlite/Tenki）+ warm-pool |
| 工具聚合 | `tools/tools.py` | `get_available_tools` 统一内置+MCP+skill+ACP |
| MCP 集成 | `mcp/` | 持久 session pool + OAuth + stdio/sse/http |
| 扩展系统 | `extensions/` | `PlacementAnchor` 语义注入 + `IsolatedMiddleware` 隔离 |
| HTTP 网关 | `backend/app/gateway/` | FastAPI + 24 router + LangGraph Platform API 兼容 |
| IM 渠道 | `backend/app/channels/` | 飞书/钉钉/Discord/Buzz/GitHub 等 |
| 终端工作台 | `tui/` | Textual App，`deerflow` console script |
| 配置中枢 | `config/app_config.py` | `AppConfig`（#1 god node 152 edges）热重载 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| LangGraph | 核心 | agent 图编排、`create_agent`、`AgentMiddleware`、checkpoint |
| LangChain | 核心 | `BaseChatModel`/`BaseTool`、callback 体系 |
| FastAPI | 核心 | HTTP gateway、SSE 流式 |
| SQLAlchemy 2.0 async | 核心 | persistence（postgres/sqlite）、`async_sessionmaker` |
| Alembic | 核心 | DB schema 迁移 |
| Pydantic v2 | 核心 | 全部配置/数据模型 |
| Textual | 可选 | TUI 终端 UI |
| Redis | 可选 | 跨进程 StreamBridge / 沙箱 ownership store |
| asyncpg / aiosqlite | 可选 | Postgres / SQLite 驱动 |
| Playwright | 可选 | browser_automation 社区 provider |
| E2B / Docker | 可选 | 云沙箱 / AIO 容器沙箱 |

---

## 快速上手

```bash
# 最简启动（Docker，推荐）
make docker-init && make docker-start

# 或本地开发
make setup          # 交互式配置向导
make dev            # 启动 backend + frontend

# 验证：浏览器打开 http://localhost:3000 发起一次对话
# 端到端验证（终端）
uv run deerflow --print "用一句话介绍你自己"
```

---

## 架构设计解析

### 系统架构

DeerFlow 采用**五层分层**，依赖方向自上而下——上层依赖下层，下层不感知上层：

![DeerFlow 分层架构](/vibe-reading/images/articles/deerflow-2.0.0/architecture.svg)

- **接口层**隔离外部协议：Gateway（HTTP/SSE）、Channels（IM 协议适配）、TUI（终端）是三种对等入口，共享同一 harness 核心。
- **编排与运行时层**是 harness 心脏：Lead Agent 装配图、Middlewares 解耦横切关注点、Runtime 管理 run 生命周期、Models 适配多 LLM、Memory 提供长期记忆。
- **能力层**是 agent 的"手和眼"：Skills（声明式能力包）、Tools/Extensions/MCP（工具聚合与扩展）、Sandbox（代码执行隔离）、Community（外部搜索/爬虫/浏览器）。
- **基础设施层**是支撑：Config（`AppConfig` 全局配置中枢）、Persistence（SQLAlchemy 数据层）、Tracing（Monocle/Langfuse 可观测）、Authz（RBAC 授权）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接口层 | `backend/app/gateway/`、`backend/app/channels/`、`tui/` | 隔离外部协议，保护核心不受入口变化影响 |
| 编排与运行时 | `agents/`、`runtime/`、`models/` | 承载 agent 装配与执行逻辑，不依赖任何外部实现 |
| 能力层 | `skills/`、`tools/`、`extensions/`、`mcp/`、`sandbox/`、`community/` | 可插拔能力，按配置组合 |
| 基础设施 | `config/`、`persistence/`、`tracing/`、`authz/`、`utils/` | 适配外部资源，对上提供语义接口 |

> harness 核心包是 `backend/packages/harness/deerflow/`（即 `deerflow-harness` 依赖），gateway 在 `backend/app/`。两者通过 `client.py` 的 `DeerFlowClient` 和 `make_lead_agent` factory 衔接。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 中间件/洋葱模型 | `agents/middlewares/` + `build_middlewares` | 横切关注点解耦，按配置动态启停，顺序可控 |
| 工厂方法 | `make_lead_agent`、`create_chat_model`、`get_available_tools` | 按配置动态创建，签名兼容 LangGraph Server |
| Facade | `DeerFlowClient` | 同步嵌入式入口，屏蔽 asyncio/StreamBridge |
| 策略 | `create_chat_model` 的 `resolve_class`、`SandboxProvider`、`MemoryManager` 多后端 | 可插拔 provider，配置驱动切换 |
| 责任链 | 中间件 wrap hooks | 所有中间件都有机会处理 |
| 仓库 | `persistence/*/sql.py` | 封装 SQL，上层依赖 `RunStore` 抽象 |
| 事件溯源 | `RunJournal` + `RunEventStore` | run 历史可重放，token 统计 |
| 注册表 | `ExtensionRegistry`、`BUILTIN_SUBAGENTS`、`BUILTIN_COMMANDS` | 单一数据源驱动 help/palette/dispatch |
| 哨兵 | `_AutoSentinel` (AUTO) | user_id 三态语义，零 boilerplate |
| 租约/心跳 | `RunManager` lease + `SandboxOwnershipStore` | 多 worker 故障恢复，fence 防 zombie |

### 核心概念

#### 核心对象

| 对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `RunRecord` | 一次 agent run 的可变状态 | run 创建→终态 | 归属 `RunManager`，持久化到 `RunStore` |
| `AgentState` | LangGraph 图状态（messages/title/artifacts/goal） | run 期间，checkpointer 持久化 | 中间件读写，工具通过 `ToolRuntime` 访问 |
| `Skill` | 技能实体（frozen dataclass） | 进程期，磁盘 SKILL.md 驱动 | `SkillStorage` 加载，`SkillActivationMiddleware` 激活 |
| `Sandbox` | 代码执行沙箱抽象 | thread 期，warm-pool 复用 | `SandboxProvider` 创建，`SandboxState` 挂到 agent |
| `AppConfig` | 全局配置根 | 进程期单例 + 热重载 | 几乎所有模块 import |

#### 核心抽象

| 抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `SandboxProvider` (ABC) | `sandbox/sandbox_provider.py` | `LocalSandboxProvider`/`AioSandboxProvider`/`E2BSandboxProvider`/`BoxliteProvider`/`TenkiSandboxProvider` | `config.sandbox.use` + `resolve_class` 动态导入 |
| `MemoryManager` (pydantic ABC) | `agents/memory/manager.py` | `DeerMem`/`HonchoMemoryManager`/`OpenVikingMemoryManager`/`mem0`/`noop` | `config.memory.manager_class` + `_scan_backends` |
| `AgentMiddleware` (LangChain) | langchain | 15+ 内置 + 扩展贡献 | `build_middlewares` 装配 + `compose_with_extensions` |
| `SkillStorage` (ABC) | `skills/storage/skill_storage.py` | `LocalSkillStorage`/`UserScopedSkillStorage` | `config.skills.use` + `resolve_class` |

---

## 代码目录

```
deer-flow/
├── backend/
│   ├── app/                          # FastAPI 网关层（32k 行）
│   │   ├── gateway/                  # HTTP API + auth + 24 routers
│   │   ├── channels/                # IM 渠道适配（飞书/钉钉/Discord/Buzz/GitHub）
│   │   ├── scheduler/、mcp_tasks/    # 定时任务 / MCP 长任务
│   ├── packages/
│   │   ├── harness/deerflow/         # 核心 harness 包（100k 行，即 deerflow-harness）
│   │   └── extension-api/            # 扩展契约包（第三方插件依赖）
│   ├── pyproject.toml                # [project.scripts] deerflow = tui.cli:main
│   └── tests/                        # 测试
├── frontend/                         # Next.js chat UI（58k 行）
├── skills/public/                    # 内置公共技能包
├── contracts/                        # skill_review 契约（review-facts.v1）
├── deploy/helm/、docker/             # 部署
└── docs/                             # RFC / plans / superpowers
```

harness 包 `deerflow/` 内部 22 个一级子目录，按关注点分：`agents/`（lead_agent + memory + middlewares）、`runtime/`、`persistence/`、`skills/`、`sandbox/`、`community/`、`config/`、`subagents/`、`mcp/`、`tools/`、`extensions/`、`tui/`、`models/` 等。

---

## 模块地图

DeerFlow 是大型项目，按根号原则（M=13 有效模块 → K=⌈√13⌉=4 子系统）组织为**两层结构**。下图展示模块间依赖方向（向下依赖）：

![模块依赖关系](/vibe-reading/images/articles/deerflow-2.0.0/module-dependencies.svg)

| 子系统 | 职责 | 挂载模块数 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| A · Agent 编排与运行时 | agent 装配、中间件、run 执行 | 3 | harness 心脏，决定 agent 怎么跑 | [→ 子系统](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration) |
| B · 记忆与持久化 | 长期记忆 + 应用数据 | 2 | 状态与数据的归落地 | [→ 子系统](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/02-memory-persistence) |
| C · 能力扩展与沙箱 | 技能/工具/扩展/MCP/沙箱/社区工具 | 4 | agent 的"手和眼"，可插拔 | [→ 子系统](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox) |
| D · 接口与配置 | HTTP/IM/终端入口 + 配置中枢 | 4 | 外部接入口 + 全局配置 | [→ 子系统](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/04-interface-config) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

Gateway 的 `lifespan`（`backend/app/gateway/app.py`）是一次性启动入口：

```
lifespan(app)
  ├─ get_app_config() → configure_logging() → ensure_browser_runtime_available()
  ├─ ensure_public_skill_projection()         # 公共技能投影到 sandbox 视图
  ├─ setup_monocle_tracing_if_enabled()        # 可观测性（失败不阻断）
  ├─ _warm_memory_retrieval(manager)          # 后台重建 memory FTS5 index
  ├─ cleanup_stale_upload_staging_files()
  ├─ async with langgraph_runtime(app, config):  # 核心：装配所有运行时单例
  │    ├─ make_stream_bridge(config)           → app.state.stream_bridge
  │    ├─ init_engine_from_config(database)    → SQLAlchemy engine
  │    ├─ make_checkpointer / make_store       → LangGraph checkpoint/store
  │    ├─ RunRepository / FeedbackRepository    → app.state.run_store / feedback_repo
  │    ├─ make_thread_store / make_run_event_store
  │    ├─ RunManager(store, event_store, ...)   → run 生命周期 + orphan recovery
  │    └─ start_heartbeat()                     # 多 worker lease 心跳
  ├─ _ensure_admin_user() / start_channel_service() / ScheduledTaskService.start()
  └─ yield  # 请求服务期；shutdown 时按逆序 drain + close
```

对象装配：`langgraph_runtime`（`deps.py`）用 `AsyncExitStack` 把 StreamBridge + checkpointer + store + 7 个 repository + RunManager 的创建/销毁打包。router 通过 `Depends(get_stream_bridge)` 等 DI 工厂取单例，缺失返回 503。`AppConfig` 不缓存到 `app.state`，router 通过 `get_app_config()` mtime 热重载。

### 核心运行流程

三条入口链路在 `make_lead_agent` + `build_middlewares` + `agent.stream()/astream()` 处汇聚，共享相同的 agent 构建逻辑和 15+ 中间件栈，差异仅在执行/消费/持久化方式：

#### HTTP API：前端对话主链路

业务流程：用户发消息 → Gateway 鉴权 → 创建 RunRecord → 后台 worker 执行 agent → SSE 流式返回

![HTTP API 数据流](/vibe-reading/images/articles/deerflow-2.0.0/data-flow.svg)

文字解读：`POST /api/threads/{id}/runs/stream` 穿过 TraceMiddleware→AuthMiddleware→CSRFMiddleware 三层 ASGI 中间件到 `thread_runs.router`，`@require_permission` 做 owner 校验后调 `services.start_run()`。`start_run` 解析 `agent_factory`（`make_lead_agent`）、构建 `RunnableConfig`、`run_mgr.create_orject` 创建 `RunRecord`（pending）并 `asyncio.create_task(run_agent(...))` 立即返回。`sse_consumer` 订阅 `StreamBridge` 把事件转 SSE 帧。后台 `run_agent` worker（`runtime/runs/worker.py`）等前序 run 收尾、`try_start`（pending→running CAS）、调 `agent_factory(config)` 装配图、`agent.astream()` 三模式流式消费，每 chunk 经 `serialize()` + `bridge.publish()` 推给 SSE。run 结束 finally 块刷 `RunJournal`、持久化 delivery 收据、`set_status` 终态。

#### TUI：终端直连链路

`deerflow` console script → `cli.main` → `plan_launch`（纯决策，无 I/O）→ `open_session` 构造 `DeerFlowClient` + checkpointer → `client.stream()`（**同步 generator**，`agent.stream()` 非 async）直接 yield `StreamEvent`，不经 StreamBridge。与 HTTP 路径走相同 `build_middlewares` 装配，但无 RunJournal/RunStore（仅 checkpointer）。

#### IM Channel：飞书 webhook 链路

IM WebSocket 消息 → `FeishuChannel._on_message` 解析 → `MessageBus.publish_inbound` → `ChannelManager._dispatch_loop` 取出 → 去重 → `_handle_chat_on_thread` → 用 `langgraph_sdk` client **HTTP 回环到 gateway** 的 `POST /api/threads/{id}/runs/stream`（带 `X-DeerFlow-Internal-Auth` header）→ 进入 HTTP 主链路。`CHANNEL_RUN_POLICY` 按平台控制串行/交互/流式策略；流式 channel 累积 AI 文本定期回写飞书 card。

### 状态流

Run 有明确的状态机，`RunManager` 集中管理状态转换：

![Run 状态机](/vibe-reading/images/articles/deerflow-2.0.0/state-flow.svg)

状态枚举定义在 `runtime/runs/schemas.py`：`pending`→`running`→`success`/`error`/`interrupted`。`try_start` 用 `start_lock` 串行化 + `store.start_run()` CAS；`cancel(action=interrupt)` 设 `abort_event` + `task.cancel()`；`cancel(action=rollback)` 回滚到 pre-run checkpoint。多 worker 部署下每个 run 持有 lease，过期被 `reconcile_orphaned_inflight_runs` 接管，`ownership_lost` fence 防止 zombie worker 写终态。

---

## 典型修改场景

#### 场景 1：新增一家 LLM Provider

新建 `models/xxx_provider.py`（子类化 `BaseChatModel`，必要时重写 `_get_request_payload`），`config.yaml` 加 `models` 条目 `use: deerflow.models.xxx_provider:XxxChatModel`。`create_chat_model` 通过 `resolve_class` 动态导入，本身不需改。

#### 场景 2：新增一个技能

在 `skills/public/<name>/` 下放 `SKILL.md`（frontmatter 含 name + description），辅助文件放 `references/`/`scripts/`。`LocalSkillStorage._iter_skill_files` 自动发现，无需改代码。需限制工具集则在 frontmatter 加 `allowed-tools`。

#### 场景 3：接入一家 MCP Server

在 `extensions_config.json` 的 `mcpServers` 加条目（type/command/args/oauth）。`get_cached_mcp_tools` 自动发现、`_make_session_pool_tool` 包装为持久 session、`make_sync_tool_wrapper` 打 sync func、`tag_mcp_tool` 标记。无需改代码。

---

## 测试体系

```
backend/tests/
├── unit/            # 单元测试（middleware/state schema/factory）
├── integration/     # 集成测试（run 生命周期/persistence）
├── blocking_io/     # Blockbuster 门控（防阻塞 IO 卡 event loop）
└── skills/          # 技能契约测试
```

| 代码层 | 测试类型 |
| --- | --- |
| Middlewares / Agent 装配 | Unit（`test_middleware_ordering` 等） |
| Runtime / RunManager | Integration（run 状态机 + orphan recovery） |
| Persistence / Repository | Integration（SQLite + Postgres） |
| Gateway routers | E2E（FastAPI TestClient） |

`make detect-thread-boundaries` / `make detect-blocking-io` 用 Blockbuster 防 event loop 阻塞——这是 DeerFlow 作为异步服务的独特测试门控。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `backend/app/gateway/app.py` 的 lifespan → `services.py` 的 `start_run()` → `runtime/runs/worker.py` 的 `run_agent()` → `agents/lead_agent/agent.py` 的 `make_lead_agent()` → `client.py` 的 `DeerFlowClient.stream()`
- **第二遍：理解中间件栈**
  `agents/lead_agent/agent.py` 的 `build_middlewares()` → `agents/middlewares/tool_error_handling_middleware.py` 的 `_build_runtime_middlewares()` → `loop_detection_middleware.py` → `summarization_middleware.py` → `extensions/isolation.py` 的 `IsolatedMiddleware`
- **第三遍：理解可插拔能力**
  `tools/tools.py` 的 `get_available_tools()` → `skills/storage/skill_storage.py` 的 `SkillStorage` → `sandbox/sandbox_provider.py` → `community/aio_sandbox/aio_sandbox_provider.py`（warm-pool + ownership）→ `agents/memory/manager.py` 的 `MemoryManager` 三层契约
- **第四遍：选择子系统深入**
  从「模块地图」表进入任一子系统概览，再进挂载模块文件。核心推荐：[Agent 编排与运行时](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration)（harness 心脏）。

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| harness | agent 运行框架——装配、运行、扩展 agent 的基础设施 |
| lead agent | 主 agent 图，用 LangGraph `create_agent` 装配，区别于子代理 |
| super-step | LangGraph 图的一个执行步，受 `recursion_limit` 约束 |
| SkillScan | 技能上架前的确定性安全扫描（30+ RuleSpec，CRITICAL 阻断） |
| warm-pool | 沙箱对象池，release 不销毁，下次 acquire 跳过冷启动 |
| lease / fence | run/沙箱的租约与防 zombie 标记，多 worker 故障恢复 |
| StreamBridge | 解耦 run worker（producer）与 SSE endpoint（consumer）的事件总线 |

### 参考资料

- [DeerFlow GitHub](https://github.com/bytedance/deer-flow) · [官方站](https://deerflow.tech)
- [LangGraph 文档](https://langchain-ai.github.io/langgraph/)（`create_agent` / `AgentMiddleware` / checkpoint）
- [LLM Space 姊妹项目](https://github.com/deer-flow/llm-space)（调试 agent harness 的桌面工具）
- 姊妹方法论：[deepwiki-rs](https://github.com/sopaco/deepwiki-rs)、[CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)
