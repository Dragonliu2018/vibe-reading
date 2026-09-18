---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "Overview"
date: "2026-09-18T17:20:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "Python", "AI Workspace", "FastAPI", "Self-Hosted"]
description: "Odysseus 是自托管 AI workspace：聊天 agent、本地模型管理、深度研究、邮件、日历、记忆 RAG 塞进一个 FastAPI 单进程。本文是 dev-2026-09 快照的源码架构总览——五层分层、12 个模块、SSE detached run 与 owner 多租户隔离。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** dev-2026-09 · **解读基线** commit [`3b6c1691`](https://github.com/odysseus-dev/odysseus/commit/3b6c169162330cd35c4ce6d14949ef15fd3208a2)（2026-09-14，开发分支快照，无 release tag）· **协议** AGPL-3.0 · **语言** Python ≥ 3.11 + JavaScript（无构建）· **代码量** 后端 ~13.7 万行 + 前端 ~16.5 万行 + 测试 ~11 万行 · **仓库** [GitHub](https://github.com/odysseus-dev/odysseus)

---

## 总览

### 项目简介

Odysseus 是 [odysseus-dev](https://github.com/odysseus-dev/odysseus) 开发的**自托管 AI workspace**——把聊天 + agent、本地模型管理（Cookbook）、深度研究、文档、邮件、笔记/任务/日历、图库放进一个 FastAPI 后端 + 无构建前端的单进程应用，用 `docker compose up -d --build` 一键拉起（伴生 chromadb / searxng / ntfy 三个容器）。README 对它的定位是"A self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows"。

它要解决的问题是：把"围绕个人 AI 的一堆零散工具"（聊天客户端、模型下载器、知识库、邮箱助手、提醒）收进一个**本地优先**的进程。核心价值有三块：**一是模型自由**——本地 llama.cpp / Ollama / vLLM / LM Studio 与云端 API 统一成 OpenAI-compatible 接入，`LLM_HOSTS` 环境变量 + Tailscale peer 表自动扫描发现端点（`ModelDiscovery._get_hosts()` in `src/model_discovery.py`），Cookbook 还能按你的显卡推荐并一键拉起模型；**二是 agent 能力内建**——工具循环、审批卡片、MCP 生态、深度研究、定时 agent 任务全部在一个进程里；**三是数据自治**——SQLite + JSON 文件落本地，凭据 Fernet 加密，多用户靠 owner 列隔离但面向的是个人/家庭自托管而非 SaaS。

**项目边界**：Odysseus 不是模型推理引擎——推理由外部服务器（本地或 API）承担，Cookbook 只负责推荐、下载（tmux + `hf download`）与 serve 生命周期；它也不是多租户云服务——`THREAT_MODEL.md` 明确威胁模型是"被偷的 SQLite 备份"而非进程沦陷。默认分支是 `dev`（最新变化先进 dev，`main` 是策展分支），本解读基于 dev 快照。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| Chat + Agents | `routes/chat_routes.py`, `src/agent_loop.py` | SSE 流式 agent 循环（≤50 轮），工具调用、审批卡片、模型 fallback |
| 工具系统 | `src/tools/`, `src/agent_tools/`, `src/tool_execution.py` | bash/python/文件/日历/邮件等工具，能力矩阵 + 审批门控 |
| Deep Research | `src/deep_research.py`, `src/research_handler.py`, `routes/research/` | IterResearch 风格多轮搜索-抓取-综合（`DeepResearcher`） |
| Compare | `routes/compare/` | 盲测多模型并排对比 + 综合 |
| Documents | `routes/document/`, `src/document_processor.py`, `src/pdf_forms.py` | 写作优先编辑器、AI 编辑、PDF 表单 |
| Email | `routes/email_routes.py`, `mcp_servers/email_server.py` | IMAP/SMTP 收件、LLM 分诊/摘要/回复草稿、CalDAV 联动 |
| Notes / Tasks / Calendar | `routes/note/`, `routes/task/`, `routes/calendar_routes.py`, `src/caldav_sync.py` | 提醒（browser/email/ntfy/webhook 四通道）、定时 agent 任务、CalDAV 同步 |
| Cookbook | `routes/cookbook_routes.py`, `services/hwfit/` | 硬件指纹 + VRAM 估算 → 模型推荐 → 下载 → serve → 端点自动注册 |
| MCP | `src/mcp_manager.py`, `src/builtin_mcp.py`, `mcp_servers/` | 外部 MCP server 注册（stdio/SSE/HTTP+OAuth），内置 email/memory/rag/image_gen/browser 五个 |
| Memory / RAG | `src/memory.py`, `src/rag_vector.py`, `services/memory/` | 长期记忆（JSON 权威 + 向量加速）、个人文档 RAG、fastembed 本地 embedding |
| 2FA / API Token | `routes/auth_routes.py`, `routes/api_token_routes.py` | TOTP + backup codes、scoped API token（`ody_` 前缀） |
| 管理CLI | `scripts/odysseus-*`（20 个） | mail/tasks/docs/backup 等域级 CLI，cron 驱动 |
| Companion | `companion/routes.py`, `companion/pairing.py` | LAN 客户端（手机）配对桥：discovery + 一次性 pairing token |
| 前端 | `static/js/`（96 模块） | 无构建 vanilla ES modules、sw.js PWA、自制窗口管理 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| FastAPI / Starlette / uvicorn | 核心 | HTTP 服务、中间件链、`StreamingResponse` SSE |
| SQLAlchemy（SQLite） | 核心 | 25 张表 ORM，migrate-on-boot 幂等迁移（`init_db()` in `core/database.py`） |
| httpx | 核心 | LLM 端点调用、SSRF 防护 pin transport（`_PinnedTransport`） |
| pydantic ≥ 2.13 | 核心 | 请求 DTO（`ChatRequest` in `src/request_models.py`）与设置 |
| chromadb-client + fastembed | 核心 | 独立 ChromaDB 容器（HTTP 8100）+ 本地 ONNX embedding（all-MiniLM-L6-v2） |
| mcp（<2，SDK v1） | 核心 | MCP 客户端与内置 server（v2 是 breaking rewrite，requirements.txt 明确 pin） |
| bcrypt / pyotp / cryptography | 核心 | 密码哈希、TOTP、Fernet 凭据加密（`src/secret_storage.py`） |
| croniter | 核心 | 定时任务 CRON 解析（`compute_next_run()` in `src/task_scheduler.py`） |
| tmux | 可选 | Cookbook 模型下载/serve 的后台会话载体 |
| ntfy / SearXNG / ChromaDB（容器） | 可选 | 推送、元搜索、向量库（docker-compose.yml 三伴生服务） |

### 版本历史

项目无 release tag、以 `dev` 分支持续滚动（README 自述"dev is the default branch and gets the newest changes first"），无版本里程碑可考，故本解读以 commit 基线（`3b6c1691`，2026-09-14）锁定快照。代码里可见明显的演进轨迹：`routes/` 下 18 行的"壳文件"（如 `routes/note_routes.py`）执行 `sys.modules[__name__] = _canonical` 替换自身，是 issue #4082/#4071 的渐进式路由重构切片；`src/search/` 是转发到 `services/search` 的兼容垫片；`services/research/research_handler.py` 是 `src/research_handler.py` 的精简旧版副本。

---

## 快速上手

Docker 一键起（README Quick Start）：

```bash
git clone https://github.com/odysseus-dev/odysseus.git
cd odysseus
cp .env.example .env
docker compose up -d --build
```

容器 healthy 后打开 `http://localhost:7000`，首个 admin 密码打印在 `docker compose logs odysseus` 里。原生安装（Python 3.11+）：

```bash
python setup.py            # 建目录、初始化数据库、创建 admin（幂等可重跑）
python -m uvicorn app:app --host 127.0.0.1 --port 7000
```

> macOS 注意：AirPlay Receiver 常占用 7000 端口，官方 start 脚本默认改用 `7860`（`website/setup.md`）。Cookbook 下载/serve 还需要 `tmux`。

端到端验证：登录后在聊天框选一个已发现的模型（Settings → 扫描到本机 Ollama/LM Studio 端口即可）发一条消息，能看到 token 级流式输出即证明主链路（`/api/chat_stream` → `stream_agent_loop()`）跑通。

---

## 架构设计解析

### 系统架构

Odysseus 的架构思想可以概括成三句话。**第一，装配显式化**：`app.py` 自称"slim orchestrator"（1306 行只做装配），全部 manager 单例在 `initialize_managers()`（`src/app_initializer.py:63`，模块导入期执行）创建，46 个路由模块经 `setup_xxx_routes(deps...)` 工厂函数注入依赖——依赖图在一个文件里看全，测试可整体替换组件。**第二，本地优先、处处降级**：向量库挂了退 BM25 关键词（`_hybrid_retrieve()` in `src/chat_processor.py`），MCP 断连走 `_direct_fallback()`（`src/tool_execution.py:690`），研究引擎失败退 legacy 再退综合搜索（`_fallback_research()` in `src/research_handler.py:861`），embedding 端点死了降级本地 ONNX（`FastEmbedClient` in `src/embeddings.py`）——单机自托管没有运维兜底，降级路径就是可用性本身。**第三，安全内建在数据流里**：owner 列多租户隔离（`owner_filter()` in `src/auth_helpers.py:191`）、工具能力矩阵 + 审批门（`src/tool_capabilities.py`）、网页/工具结果一律按 untrusted 内容包裹（`untrusted_context_message()` in `src/prompt_security.py:64`）、外呼 SSRF 双重防护（DNS 解析 + 连接期 IP pin，`src/outbound_fetch.py`）。

![Odysseus 分层架构](/vibe-reading/images/articles/odysseus-codewiki-dev-2026-09/architecture.svg)

五层自上而下：**前端 UI 层**（`static/js/`，无构建 ES modules + sw.js PWA）只经 HTTP/SSE 与后端交互；**Web 服务与路由层**（`app.py` + `routes/`，46 个路由模块）持认证中间件链与 SSE detach 机制；**智能体执行层**（`src/` 的 agent_loop / 工具系统 / llm_core / deep_research / task_scheduler / memory）是进程大脑；**领域服务层**（`services/` + `mcp_servers/`）承载硬件适配、搜索提供链与四个 MCP server；**数据与安全基座**（`core/`）是全库扇入最高的层（`core.database` 被 import 37 次）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 前端 UI 层 | `static/js/`、`static/sw.js` | 把全部功能呈现给浏览器；无构建直发，随 git 部署零管线 |
| Web 服务与路由层 | `app.py`、`routes/`、`core/middleware.py` | 隔离 HTTP 协议与装配编排，保护 src 服务层不感知请求细节 |
| 智能体执行层 | `src/agent_loop.py`、`src/tools/`、`src/agent_tools/`、`src/llm_core.py`、`src/deep_research.py`、`src/task_scheduler.py`、`src/memory.py` 等 | 承载 agent 循环、工具安全、模型接入、研究、调度等核心智能逻辑 |
| 领域服务层 | `services/hwfit/`、`services/search/`、`services/memory/`、`mcp_servers/` | 纯领域算法与可独立子进程化的 MCP server，供执行层组合调用 |
| 数据与安全基座 | `core/`、SQLite、ChromaDB 容器 | 持久化、认证、多租户隔离、原子 IO，全模块共同依赖 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂函数依赖注入 | `initialize_managers()` in `src/app_initializer.py`；`setup_chat_routes(...)` in `routes/chat_routes.py` | 取代 FastAPI 全局 router，路由层无全局单例依赖、可被测试注入 |
| 生成器流水线（流式） | `stream_agent_loop()` in `src/agent_loop.py:3418`（`AsyncGenerator[str, None]` yield SSE 帧） | 单向流 + 断连语义天然匹配 async generator，`finally` 中 cancel 孤儿工具 task 防 subprocess 泄漏 |
| 注册表 + 门面 | `TOOL_HANDLERS` in `src/agent_tools/__init__.py:37`；`BUILTIN_ACTIONS` in `src/builtin_actions.py:3394`；`_MCP_TOOL_MAP` in `src/tool_execution.py:563` | 工具/动作按名注册，执行器只查表分派，新增实现零侵入执行器 |
| 策略枚举矩阵 | `ToolEffect`（12 种）× `ResultIntegrity`（3 级）in `src/tool_capabilities.py:21-42` | 把"这个工具危险吗"从散落的 if 变成静态声明的矩阵，门控逻辑只看矩阵不看实现 |
| 多级 fallback 链 | `stream_llm_with_fallback()` in `src/llm_core.py:3511`；`_fallback_research()` in `src/research_handler.py:861`；记忆检索向量→关键词降级 | 本地模型服务不可靠是常态，宁可换候选也不让请求失败 |
| migrate-on-boot | `init_db()` 跑 ~50 个 `_migrate_*()` 幂等函数 in `core/database.py` | 自托管单文件 SQLite 不值得引 Alembic，重启即迁移 |
| 单例服务定位器 | `get_mcp_manager()` in `src/tool_utils.py:23`；`set_session_manager()` in `src/ai_interaction.py:45` | src 内部回调路由能力（如 agent 工具 loopback 调 /api）需全局句柄 |
| 事件总线 | `fire_event()` in `src/event_bus.py:33` | `email_received`/`research_completed`/`memory_added` 解耦生产者与调度器触发器 |
| detached run（订阅扇出） | `agent_runs.start()/subscribe()` in `src/agent_runs.py` | 关标签页只断开一个订阅者，agent 继续跑完并落库 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `ToolBlock` | 工具调用统一表示（namedtuple：tool_type + content）in `src/agent_tools/__init__.py:116` | 单次工具调用 | 由 `parse_tool_blocks()` 解析产出，流向审批与执行 |
| `ChatRequest` | `/api/chat` 入口 DTO in `src/request_models.py:7` | 单次请求 | 驱动 `ChatHandler` 预处理 |
| `ChatContext` | 一次聊天的完整上下文（preface/messages/rag_sources/web_sources）由 `build_chat_context()` in `routes/chat_helpers.py:605` 组装 | 单次请求 | 聚合记忆/RAG/搜索三类前奏 |
| `ModelCapabilityRecord` | 模型能力记录（vendor/能力断言/确定性控制）in `src/model_capability_readers/base.py:37` | 会话期缓存 | 由七个 provider reader 产出 |
| `ScheduledTask` / `TaskRun` | 定时任务与执行记录 ORM in `core/database.py:730/810` | 持久化 | TaskRun 是 Task 的执行历史 |
| `MemoryManager` | 长期记忆 JSON 权威 in `src/memory.py:47` | 进程单例 | 向量层 `MemoryVectorStore` 是其加速缓存 |
| `VectorRAG` | 文档 RAG 引擎 in `src/rag_vector.py:75` | 惰性单例 | 持 `EmbeddingLane` 列表 |
| `McpManager` | MCP 客户端管理器 in `src/mcp_manager.py:135` | 进程单例 | 托管 `_connections/_tools/_sessions/_stacks` 四张表 |
| `EmailAccount` | 邮箱账户 ORM（IMAP/SMTP/OAuth）in `core/database.py:386` | 持久化 | 每 owner 多账户，唯一默认账户由锁表互斥 |
| `_Run`（agent_runs） | detached 流式运行的 replay buffer + 订阅者集合 in `src/agent_runs.py` | 单次 agent 运行 | SSE 响应只是其订阅者 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `CapabilityReader` 协议 | `src/model_capability_readers/__init__.py` | `generic_openai/openai/openrouter/google/llamacpp/lmstudio/ollama` 七个 reader | `READER_MODULES` 注册表，`reader_for_vendor()` 按 vendor 查表 |
| `MemoryProvider` ABC | `src/memory_provider.py` | `NativeMemoryProvider` 及外部记忆系统 | `MemoryProviderRegistry` 注册 + 工具名冲突检测 |
| `EmbeddingLane` dataclass | `src/embedding_lanes.py` | custom HTTP / fastembed 两条 lane | `build_embedding_lanes()` 顺序构建 |
| `Tool().execute(content, ctx)` 鸭子类型 | `src/agent_tools/` 各工具类 | `BashTool`/`PythonTool`/`ReadFileTool`… | `TOOL_HANDLERS` dict（注意：无基类，仅签名约定） |
| `setup_xxx_routes(deps) -> APIRouter` 工厂约定 | `routes/` 全部路由模块 | 46 个路由模块 | `app.py` 显式调用并传 manager |

```
前端 chat.js ──SSE──▶ chat_routes ──▶ ChatHandler ──▶ ChatProcessor ──▶ MemoryManager
                        │                │                                ▲
                        ▼                ▼                                │
                   agent_runs        ResearchHandler              MemoryVectorStore
                        ▲                │        │                      ▲
                        │                ▼        ▼                      │
                 stream_agent_loop  DeepResearcher  ←── VectorRAG ◀── EmbeddingLane
                        │        │
              ┌─────────┘        └──────────┐
              ▼                              ▼
     TOOL_HANDLERS 注册表            stream_llm_with_fallback
              │                              │
              ▼                              ▼
     _MCP_TOOL_MAP → McpManager        _stream_llm_inner → 模型端点
```

---

## 代码目录

```shell
odysseus/
├── app.py                 # FastAPI 装配（"slim orchestrator"，1306 行：中间件/路由/lifespan）
├── setup.py               # 首次安装脚本（建目录、初始化库、创建 admin，幂等）
├── core/                  # 数据与安全基座：database(2.7k)/session_manager/auth/middleware/platform_compat
├── src/                   # 智能体执行层（~62k 行）：agent_loop(6.4k)/llm_core(3.7k)/builtin_actions(3.4k)
│   ├── tools/             #   do_* 函数式工具实现（旧层）
│   ├── agent_tools/       #   类封装工具 + TOOL_HANDLERS 注册表（新层）
│   ├── model_capability_readers/  # 七个 provider 能力读取器
│   └── search/            #   转发到 services/search 的 sys.modules 垫片
├── routes/                # HTTP 路由（~48k 行）：email(6.2k)/cookbook(4.6k)/chat(2.8k)/model(2.7k)…
│   ├── note/ task/ mcp/ research/ …  # 已切片重构的子目录（canonical 实现）
│   └── note_routes.py 等  # 18 行壳文件（sys.modules 替换自身，迁移跳板）
├── services/              # 领域服务：hwfit(3.2k)/memory(2.8k)/search(2.2k)/research/tts/stt
├── mcp_servers/           # 四个内置 MCP server：email(2.9k)/image_gen/memory/rag
├── companion/             # LAN 客户端配对桥（pairing token + 能力发现）
├── integrations/          # Claude skills / Codex 插件集成点
├── swift/                 # odysseus-mlx-image-bridge（macOS MLX 图像桥，198 行）
├── scripts/               # 20 个 odysseus-* 域级 CLI + GPU 诊断 + 迁移脚本
├── static/                # 前端（~165k 行 JS）：96 个 ES modules + sw.js + 1.2MB style.css
├── tests/                 # 测试（~110k 行，803 个测试文件 + area_* 分类标记体系）
├── specs/model-providers/ # ~20 个模型 provider 规格 markdown
├── docker/                # Dockerfile 与 compose 变体（gpu-nvidia/gpu-amd）
└── website/               # 文档站（setup.md 等）
```

`licenses/`、`assets/`、`config/searxng`（SearXNG 配置覆盖）为资源目录；`docker-compose.yml` 定义 odysseus + chromadb + searxng + ntfy 四服务（外加两个 data 卷容器）。

---

## 模块地图

12 个模块按四信号（重目录 + 高扇入 + 入口可达 + graphify god nodes/社区）识别，全部单层并列——项目客观职责分化的结果。模块间动态调用顺序见「运行时行为 > 核心运行流程」。

![模块依赖图](/vibe-reading/images/articles/odysseus-codewiki-dev-2026-09/module-dependencies.svg)

依赖方向自上而下：前端只认 HTTP；路由层经工厂注入拿 manager；执行层内部 agent_loop 调 llm_core 与工具系统，工具系统把 MCP 工具经 `_MCP_TOOL_MAP` 转给 `McpManager`；任务调度反过来驱动 agent 循环（后台跑 agent）；`core/database` 是全库扇入之最（37 次 import）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Agent 执行引擎 | 聊天→agent 循环编排、上下文压缩、SSE 生成 | `stream_agent_loop()` in `src/agent_loop.py:3418` | 全库连接数第一的 god node（69 edges），所有智能行为的汇合点 | [01](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/01-agent-engine) |
| 工具系统 | 工具定义/解析/审批/执行全管线 | `execute_tool_block()` in `src/tool_execution.py:810` | 安全设计密度最高：能力矩阵、审批三档、sandboxing 都在这里 | [02](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/02-tool-system) |
| LLM 接入与模型能力 | 统一 LLM 调用、端点发现、能力探测 | `llm_call_async()` / `_stream_llm_inner()` in `src/llm_core.py` | 第二 god node（56 edges），本地/云端全部模型的单一咽喉 | [03](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/03-llm-access) |
| 深度研究 | 多轮搜索-抓取-综合研究报告 | `DeepResearcher.research()` in `src/deep_research.py:252` | 独立的 LLM-in-the-loop 迭代引擎 + 自带 SSRF 防护栈 | [04](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/04-deep-research) |
| 任务调度与后台作业 | 定时/事件/webhook 触发 agent 任务 | `TaskScheduler._loop()` in `src/task_scheduler.py:673` | 与前台互斥的独立调度域（信号量=1 硬并发约束） | [05](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/05-task-scheduler) |
| 记忆与 RAG | 长期记忆 + 个人文档向量检索 | `build_context_preface()` in `src/chat_processor.py` | JSON 权威 + 向量加速的双层存储独立于聊天主链 | [06](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/06-memory-rag) |
| 邮件系统 | IMAP/SMTP 集成、分诊、摘要、回复草稿 | `setup_email_routes()` in `routes/email_routes.py:1513` | 全库最大路由文件（6.2k 行）+ 独立 2.9k 行 MCP server，管理面/agent 面分离 | [07](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/07-email) |
| Cookbook 硬件适配 | 硬件指纹→模型推荐→下载→serve | `detect_system()` in `services/hwfit/hardware.py` | 纯算法域（VRAM 估算/探测），且自带 tmux 生命周期管理 | [08](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/08-cookbook) |
| MCP 生态 | MCP 客户端、内置 server、OAuth | `McpManager.connect_server()` in `src/mcp_manager.py` | 扩展协议域：进程托管、transport 抽象、schema 注入 agent | [09](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/09-mcp) |
| Web 服务与路由层 | FastAPI 装配、46 路由模块、SSE detach、上传文档 | `initialize_managers()` in `src/app_initializer.py:63` | 装配与协议层，全库 ~50k 行路由的组织者 | [10](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/10-web-routes) |
| 数据与安全基座 | ORM 25 表、认证、多租户、原子 IO | `init_db()` in `core/database.py` | 全库最高扇入（37 次），一切持久化的地基 | [11](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/11-core-security) |
| 前端 UI | 96 个无构建 ES modules、PWA、窗口管理 | `handleChatSubmit()` in `static/js/chat.js` | 16.5 万行独立技术栈（vanilla JS），与后端仅靠 HTTP/SSE 契约耦合 | [12](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/12-frontend) |

---

## 运行时行为

### 启动流程

配置来自 `.env`（`load_dotenv(encoding="utf-8-sig")` 容忍 Windows BOM，issue #142）→ 环境变量（`LLM_HOSTS`、`APP_PORT`）→ DB 内 settings（`get_setting()` in `src/settings.py`，运行时可改）。装配分两阶段：

```
① 模块导入期（python -m uvicorn app:app）
   app.py
   ├─ Windows 事件循环策略 + MIME 修正（ProactorEventLoop / .js Content-Type）
   ├─ load_dotenv(encoding="utf-8-sig")
   ├─ initialize_managers() in src/app_initializer.py:63     ← 全部单例在此创建
   │    SessionManager / MemoryManager / SkillsManager / UploadHandler /
   │    PersonalDocsManager / APIKeyManager / PresetManager / ChatProcessor /
   │    ChatHandler / ResearchHandler / ModelDiscovery / MemoryVectorStore
   │    （MemoryVectorStore 失败时 DEGRADED 降级，向量检索退关键词）
   └─ 46 × app.include_router(setup_xxx_routes(<manager 闭包注入>))
        注册顺序非随意：email 先于 codex（borrow email helper，app.py:871 注释）

② lifespan 启动期（_startup_event() in app.py:1021）
   ├─ 清残留 incognito 会话
   ├─ 启动 upload 清理协程（引用计数防误删）
   ├─ start_bg_monitor()                # `#!bg` 后台命令完成后自动唤起 agent
   ├─ 后台异步连 MCP：register_builtin_servers() + connect_all_enabled()
   │    （刻意放在 web server 就绪之后，MCP 启动慢不拖首屏，app.py:1068）
   ├─ task_scheduler.start()           # 轮询循环 + 60s note ping 循环
   └─ hourly _null_owner_sweep_loop() / nightly _skill_audit_nightly_loop()
```

中间件栈（Starlette 后注册者在外层）：CORS → GZip（SSE 的 `text/event-stream` 默认排除，不缓冲）→ `SecurityHeadersMiddleware`（CSP nonce）→ `_RequestTimeoutMiddleware`（45s 硬超时 + 流式路径豁免）→ `_InteractiveActivityMiddleware`（前台请求抢占后台任务）→ `_SlowRequestLogMiddleware` → `AuthMiddleware`（最外层，三条认证路径：internal-tool loopback token / `Bearer ody_` API token / cookie session）。

### 核心运行流程

以下三条链路覆盖了 Odysseus 的主要运行模式：交互式 agent 对话（用户主入口）、后台定时 agent（无人值守）、深度研究（长任务）。上传→文档→RAG 索引等次级链路在各模块文档展开。

#### 交互链路：聊天消息 → agent 循环 → 流式回复

业务流程：用户提交消息（可带附件/开关）→ 鉴权与意图分级 → 上下文前奏构建（记忆/RAG/搜索）→ agent 多轮循环（LLM 流式 + 工具执行）→ SSE 推回前端增量渲染 → 落库。

![聊天主链路](/vibe-reading/images/articles/odysseus-codewiki-dev-2026-09/data-flow.svg)

文字描述：`handleChatSubmit()` in `static/js/chat.js` 以 FormData POST `/api/chat_stream`（同时收 FormData 和 JSON，issue #3229）；`chat_stream()` in `routes/chat_routes.py:963` 经 `_classify_tool_intent()` 判断是否把普通 chat 升级为 agent 模式，`build_chat_context()` in `routes/chat_helpers.py:605` 组装 `ChatContext`（含 `ChatProcessor.build_context_preface()` 的记忆/RAG/搜索前奏——注入 user 而非 system 消息，保本地后端 KV-cache 前缀命中）。agent 模式进入 `stream_agent_loop()`（`src/agent_loop.py:3418`）：每轮 `stream_llm_with_fallback()`（`src/llm_core.py:3511`，本地模型先过 `_local_model_slot()` 并发闸门）→ `_resolve_tool_blocks()` 把 fenced/native 输出归一化为 `ToolBlock` → `execute_tool_block()` 以 `asyncio.create_task` + Queue 推进度 → `_append_tool_results()` 回写进入下一轮。响应不是直连生成器，而是 `agent_runs.start(session, _safe_stream())`（`src/agent_runs.py`）包成 detached task，SSE 只是订阅者——关标签页 agent 照跑、落库，重连走 `GET /api/chat/resume/{session_id}` 回放 replay buffer。前端 `createStreamRenderer()` in `static/js/streamingRenderer.js` 用"冻结块 + 活跃尾块"结构做增量渲染。

#### 后台链路：定时任务触发 → agent 执行 → 结果投递

业务流程：cron/事件/webhook 到期 → 抢占调度 → 按 task_type 分派（llm/action/research）→ 执行 → 结果按 output_target 投递（session/email/通知）。

`TaskScheduler._loop()`（`src/task_scheduler.py:673`）每 tick 查 `next_run` 最小值把睡眠 clamp 到 [1s, 60s]（保证分钟级 cron 不迟到），`_check_due_tasks()` 在 `_executing_lock` 下快照到期任务并 `asyncio.create_task(self._execute_task(id))`。`_execute_task()` 先写 `status="queued"` 的 TaskRun 行**再**等 `asyncio.Semaphore(1)`（硬编码并发 1，注释明示"not configurable"）。`_execute_task_locked()` 按 `task_type` 分派：`_execute_llm_task()` → `_run_agent_loop()` 消费 `stream_agent_loop()` 的 SSE 事件流（失败回退 `task_llm_call_async` 单次调用；跑满步数做 grace summarization 兜底）；`_execute_action()` 查 `BUILTIN_ACTIONS` 注册表；`_execute_research_task()` 跑 `DeepResearcher`。成功后 `_deliver_task_result()` 按 `output_target` 投递——写 ChatMessage / 走 `_deliver_via_email()`（复用 `routes/email_helpers` 的 `_send_smtp_message`）/ `add_notification()` 进通知队列由前端轮询弹出。前台优先：`_check_due_tasks()` 检测到 `has_foreground_activity()` 把到期任务推后 15 分钟，执行中由 `_cancel_if_foreground_active()` 每 0.25s 检查并 cancel——本地单 GPU 被前台聊天独占时后台任务必须让路。事件触发（`fire_event()` in `src/event_bus.py:33`）经 `_handle_event()` 累加 `trigger_counter`，达阈值时写 `next_run = utcnow()` 折叠进同一条调度通道。

#### 研究链路：深度研究任务 → 迭代报告

业务流程：用户在聊天或 research 面板提交问题 → 查询合成 → 后台任务（hard timeout）→ 每轮（计划→查询→搜索→抓取→综合）→ LLM 判停 → 最终报告落盘 + 事件通知 → 可视化报告 / spinoff 会话。

链路细节与 SVG 见[深度研究模块文档](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/04-deep-research)（`synthesize_query()` in `src/research_handler.py:92` → `start_research()` 包 `asyncio.wait_for` → `DeepResearcher.research()` 主循环 → `_save_result()` 落 `DEEP_RESEARCH_DIR/{session_id}.json` + `fire_event("research_completed")`）。降级链完整：引擎失败退 legacy `ResearchOrchestrator`，再退 `comprehensive_web_search()`，超时也保留 `evolving_report` 部分结果（issue #1551）。

### 状态流

![运行时状态流](/vibe-reading/images/articles/odysseus-codewiki-dev-2026-09/state-flow.svg)

**TaskRun 状态机**（`core/database.py:810` 定义 ORM，`src/task_scheduler.py` 驱动转换）：`queued`（先落库再等信号量，`:738`）→ `running`（`:886`）→ 终态 `success`（`:924`，`success if success else error`）/ `error` / `skipped`（`:834` 过期 stale、`:994` action 无事可做）/ `aborted`（用户 `stop_task()`、前台抢占 `_cancel_if_foreground_active()`、重启遗留僵尸统一标 aborted 而非 error——避免 Activity 把基础设施事件算成任务失败）。**工具审批生命周期**（`src/tool_approvals.py`）：`create()` 产出 `PendingToolApproval`（digest 封印 content）→ 前端 `peek()` 展示（`:476`）→ 用户批准后 `consume()` 以 `ExactToolApproval` 一次性 digest 匹配消费（`:426`，destructive 动作防重放）→ 会话结束 `retire_for_session()` 清理（`:482`）。审批范围三档 `ToolApprovalScope`（`src/tool_approval_scopes.py:149`）：`SINGLE_ACTION` / `TASK` / `CHAT_SESSION`（后者 HMAC 签名 grant 写入 transcript，防 fork 会话继承授权）。

---

## 典型修改场景

#### 场景 1：新增一个 agent 工具

- `src/tools/<域>.py`：写 `do_xxx()` 实现（或加新域文件）
- `src/tool_schemas.py`：`FUNCTION_TOOL_SCHEMAS` 加 OpenAI function-calling 条目
- `src/agent_tools/__init__.py`：`TOOL_TAGS` 集合加名字（漏了会导致 fence 解析静默失败——cookbook 工具曾中招）
- `src/tool_execution.py`：`_execute_tool_block_impl()` elif 链加分派（或注册进 `TOOL_HANDLERS`）
- `src/tool_capabilities.py`：`_register()` 声明 effects/integrity（不声明则按未知能力 fail high 被门控）
- `src/tool_index.py`：`BUILTIN_TOOL_DESCRIPTIONS` 加检索描述（RAG 工具选择用）
- 对应测试：`tests/` 下按 `area_routes` / `area_services` 分类新增

#### 场景 2：新增一个功能页签（前后端贯通）

- `index.html`：加 DOM 骨架（modal 容器 + icon-rail 按钮）
- `app.js`：import 新模块、pathname 路由表加 deep-link opener
- `static/js/xxx.js`：自取数自渲染（参照 `emailInbox.js` 模式）
- `routes/<domain>/<domain>_routes.py`：写 `setup_<domain>_routes(deps) -> APIRouter`
- `app.py`：INCLUDE ROUTERS 区 import 并传 manager；旧路径按 `note_routes.py` 模式写 `sys.modules` 兼容壳
- 离线需求则更新 `sw.js` 的 `PRECACHE` 并 bump `CACHE_NAME`

#### 场景 3：新增一个内置 MCP server

- `mcp_servers/` 新建脚本：`Server("xxx")` + `@server.list_tools()` / `@server.call_tool()` + `run()`（参照 `rag_server.py`，160 行即可）
- `src/builtin_mcp.py`：`_BUILTIN_SERVERS` 注册 `(script_rel, name)`，自动获得 stdio 启动与崩溃自动重连
- 走 code-block 工具格式需在 `agent_loop.py` 的 prompt 工具文档补条目；走 function calling 则调整 `get_all_openai_schemas()` 的 `is_builtin()` 跳过逻辑
- 对应测试：`tests/test_companion_*.py` 同款的 owner 隔离测试模式

---

## 测试体系

```
tests/
├── conftest.py / _taxonomy.py   # 收集期按文件名自动打 area_*/sub_* 标记
├── helpers/                      # 共享测试工厂（TESTING_STANDARD.md 规范）
├── cli/ streaming/ tools/       # CLI / SSE 流 / 工具域分组
├── run_focus.py                  # 按 taxonomy 跑子集 + durations 证据
└── test_*.py × 803               # 平铺命名（按 LAYOUT_INVENTORY.md 渐进重组）
```

分类标记在 `pyproject.toml` 声明：`area_security`（auth/owner-scope/SSRF/XSS/redaction）、`area_routes`、`area_services`、`area_cli`、`area_js`（Node 支撑的 JS 测试）、`area_helpers`、`area_unit`、`area_uncategorized`，另加 `slow` fast-lane 标记（issue #3443，只对有 duration 证据的测试打）。`sub_*` 细粒度标记由 `tests/conftest.py` 在 `pytest_configure` 动态注册。

| 代码层 | 测试类型 | 代表 |
| --- | --- | --- |
| 工具安全/门控 | `area_security` 单测 | `test_agent_state_dir_confinement.py`、`test_tool_approval_scopes.py` |
| HTTP 路由 | `area_routes` | `test_admin_wipe_routes_shim.py` |
| 服务层（llm/email/cookbook） | `area_services` | `test_agent_loop.py` 等 |
| 前端 JS | `area_js`（Node 驱动） | `live_thinking_scheduler.test.mjs`、`test_startup_shell_js.py` |
| CLI 脚本 | `area_cli` | `tests/cli/` |

想理解某个类，优先读它对应的测试——例如 `stream_agent_loop()` 的轮次耗尽语义看 `test_agent_rounds_exhausted.py`，上传清理的 fail-closed 看 `UploadCleanupSafetyError` 相关测试。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `app.py`（装配与中间件）→ `src/app_initializer.py` 的 `initialize_managers()` → `routes/chat_routes.py` 的 `chat_stream()`（:963）→ `src/agent_loop.py` 的 `stream_agent_loop()`（:3418，只看主循环骨架）→ `src/llm_core.py` 的 `_stream_llm_inner()`（:2582）
- **第二遍：理解核心数据结构**
  `src/agent_tools/__init__.py` 的 `ToolBlock`（:116）→ `src/request_models.py` 的 `ChatRequest` → `core/database.py` 的 ORM 清单（`Session`/`ChatMessage`/`ScheduledTask`/`ModelEndpoint`）→ `src/tool_capabilities.py` 的 `ToolEffect` × `ResultIntegrity` 矩阵
- **第三遍：理解安全与多租户**
  `app.py` 的 `AuthMiddleware`（:364）→ `src/auth_helpers.py` 的 `owner_filter()`（:191）→ `src/tool_security.py` / `src/tool_approvals.py` / `src/outbound_fetch.py`（SSRF pin transport）
- **第四遍：按模块深入**
  从模块地图选读 12 个模块文档；agent 循环的轮次语义（`01`）、工具审批（`02`）、llm 多 provider（`03`）是理解扩展方式的钥匙

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| owner scope | 多租户隔离：每行数据带 `owner` 列，`owner_filter()` 统一过滤（`owner == user OR owner IS NULL` 兼容 legacy 共享行） |
| detached run | SSE 生成器包成后台 task（`agent_runs.start()`），客户端断开不影响 agent 跑完 |
| exact approval | 工具审批的一次性精确匹配：digest 封印工具 content，用户点批准后以 `ExactToolApproval` 重入 agent 循环回放 |
| `#!bg` | bash 工具首行标记，命令 detach 为后台 job（`src/bg_jobs.py`），完成后 `bg_monitor` 重新唤起 agent |
| hwfit | hardware fitness：硬件指纹探测 + VRAM 估算 + 模型推荐打分（`services/hwfit/`） |
| lane | embedding 泳道：不同 embedding 模型各占一个 ChromaDB collection（维度互斥），`EmbeddingLane` 统一抽象 |
| DSML | 模型输出里泄漏的工具调用标记语法（fenced/`[TOOL_CALL]`/XML 等多方言），`parse_tool_blocks()` 负责归一化 |
| internal-tool | 进程内 loopback 调用 `/api` 的服务账号（`X-Odysseus-Internal-Token`），被 `RESERVED_USERNAMES` 封堵为真人用户名 |
| spinoff | 从研究报告预填新聊天会话（`research_spinoff()`，刻意不注入 sources 省 token） |

### 参考资料

- 仓库自带文档：`website/setup.md`（安装/GPU/HTTPS）、`THREAT_MODEL.md`（威胁模型与 known gaps）、`ROADMAP.md`、`tests/TESTING_STANDARD.md`（测试标准）、`static/js/MODULE_SUMMARY.md`（前端模块自述）、`specs/model-providers/`（~20 个 provider 规格）
- 关键设计来源：`src/agent_loop.py` 内引用的 issue 注释（#3222 native/fenced 双通道、#2927 prompt cache 一致性、#4277 注册表迁移计划）
