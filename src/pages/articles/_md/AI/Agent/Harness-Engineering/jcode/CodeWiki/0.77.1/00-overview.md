---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Overview"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Agent Harness", "TUI", "Memory", "Swarm", "多模型"]
description: "jcode v0.77.1 源码解读——Rust 编写的极致内存效率编码 agent harness，三层 re-export 架构、84 crate 编译隔离、agent turn 循环、passive 记忆系统、swarm 协作与 ambient 后台整合"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.77.1 · **协议** MIT · **语言** Rust (edition 2024) · **代码量** ~712,000 行 / 84 crate · **仓库** [GitHub](https://github.com/1jehuang/jcode)

---

## 总览

### 项目简介

jcode 是一个用 Rust 编写的终端编码 agent harness——即驱动 LLM 自主完成编码任务的"外壳"框架，与 Claude Code、Codex CLI、Cursor Agent 同类。它的核心定位是两条：**最省内存的 harness**（单会话 27.8 MB，比 Claude Code 低 13.9×）和**最智能的 harness**（passive 记忆系统 + ambient 后台整合 + swarm 多 agent 协作）。

jcode 解决的核心问题是：现有编码 agent 普遍臃肿——单会话占数百 MB 内存、首帧渲染需数秒、无跨会话记忆、多 agent 无法协作。jcode 从 allocator 层开始系统性优化内存，用自定义 TUI 渲染管线实现 14ms 首帧，用 embedding 语义检索实现"像人一样自动回忆"的 passive 记忆，用 daemon 架构 + 文件冲突检测实现 swarm 多 agent 在同一仓库协作。

核心使用场景：交互式 TUI 编码（`jcode`）、非交互单次执行（`jcode run`）、持久 daemon + 多客户端（`jcode serve` / `jcode connect`）、自我开发模式（agent 修改 jcode 自身源码并热重载）。**项目边界**：jcode 是 harness 框架，不训练模型、不提供模型推理——它通过 30+ provider 适配器接入用户已有的 OAuth 订阅或 API key。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| 交互式 TUI | `crates/jcode-tui/src/tui/` | 14ms 首帧、千 fps 渲染、StreamBuffer 流式平滑 |
| Agent turn 循环 | `crates/jcode-app-core/src/agent/` | provider 流式 → tool 执行 → 中断检查循环 |
| 多模型 Provider | `crates/jcode-base/src/provider/` + 11 个 runtime crate | 8 类 provider 槽、两级 failover、30+ 登录流程 |
| Passive 记忆 | `crates/jcode-base/src/memory*.rs` | embedding 检索 + LLM judge 重排 + 自动注入 |
| Swarm 协作 | `crates/jcode-app-core/src/server/swarm.rs` | 文件冲突双向通知、spawn 树、DAG 任务图 |
| Tool 系统 | `crates/jcode-app-core/src/tool/` | 30+ 工具、destructive gate、MCP 适配 |
| Ambient 后台 | `crates/jcode-app-core/src/ambient/` | 自适应调度、memory gardening、proactive work |
| Self-Dev 热重载 | `src/cli/selfdev.rs` + `server/reload.rs` | exec 热重载不丢会话 |
| Info Widget | `crates/jcode-tui/src/tui/info_widget*.rs` | 负空间利用、不抢响应区 |
| Mermaid 渲染 | `crates/jcode-tui-mermaid/` | 纯 Rust mermaid-rs-renderer，无浏览器依赖 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Rust (edition 2024) | 核心 | 系统语言，零成本抽象 + 内存安全 |
| tokio | 核心 | 异步运行时（multi_thread runtime） |
| clap | 核心 | CLI 参数解析（Args / Command 枚举） |
| ratatui + crossterm | 核心 | TUI 渲染框架 + 终端抽象 |
| tikv-jemallocator | 可选 | 内存分配器（`jemalloc` feature，长驻进程 RSS 优化） |
| tract (ONNX) | 核心 | 本地 embedding 推理（all-MiniLM-L6-v2，384 维） |
| serde / serde_json | 核心 | 序列化（配置、会话、wire 协议全用 JSON） |
| anyhow | 核心 | 错误处理（全链路 `?` 传播） |
| rustls | 核心 | TLS（provider HTTPS 连接） |
| tokenizers | 核心 | embedding 分词器 |

### 版本历史

jcode 的版本演进围绕两条主线：**性能压榨**（allocator 调优 → 三层 crate 拆分 → StreamBuffer 流式平滑）和**智能化**（基础工具 → passive 记忆 → ambient 后台 → swarm 协作）。changelog 目录保留 60 个版本（v0.34.0 → v0.77.1）。v0.77.1 是当前最新稳定版，此时 84 crate 的编译隔离重构已基本完成（见 `docs/COMPILE_TIME_ISOLATION_REFACTOR.md`），三层 re-export 架构（`jcode → jcode-tui → jcode-app-core → jcode-base`）稳定，ambient mode 已标记 Implemented（2026-08-16）。

---

## 快速上手

```bash title="快速上手"
# 安装（macOS & Linux）
curl -fsSL https://jcode.sh/install | bash

# 启动 TUI（默认子命令）
jcode

# 非交互单次执行
jcode run "say hello"

# 持久 daemon + 多客户端
jcode serve    # 启动后台 server
jcode connect  # 连接到已有 server

# 恢复历史会话
jcode --resume fox
```

验证：`jcode run "say hello"` 应在终端输出模型响应。首次使用需 `jcode login --provider claude`（或其他 provider）完成 OAuth 登录。构建源码用 `cargo build --profile selfdev`（见 `AGENTS.md` 的 runtime 验证说明——`cargo build` 证明不了行为，需 repoint shared-server daemon）。

---

## 架构设计解析

### 系统架构

jcode 的架构设计有两个核心思想：**编译时隔离**和**依赖反转组合根**。

**编译时隔离**——84 个 crate 不是过度工程，而是为了缩小重编译面。关键瓶颈是 `jcode-base(~108K 行) → jcode-app-core(~134K 行) → jcode-tui(~204K 行) → jcode lib → jcode bin` 这条线性串行栈，rustc 前端串行编译占 12s+。拆出 `*-types` crate（`jcode-message-types`、`jcode-protocol`、`jcode-config-types` 等）持有稳定数据契约，改一个 provider 字段只需重编该 type crate + 焦点依赖，不重编整条 spine。provider runtime crate（`jcode-provider-anthropic-runtime` 等）移到 base 下游，编辑 provider 只重编该 crate + binary relink。

**依赖反转组合根**——base 层无法命名下游 provider runtime 的具体类型（否则反向依赖）。解法是在 `src/cli/startup.rs` 的 `run()` 中集中注册：`register_external_provider_runtimes()` 把 9 个 provider 工厂闭包注入 base 的全局 `OnceLock` 注册表；`register_permission_notifier` 让 safety 层回调 notifications；`register_synthetic_entry_provider` 让 memory 层回调 skill。所有跨层依赖在启动时一次性 wiring，base 保持零向上依赖。

![jcode 分层架构](/vibe-reading/images/articles/jcode-codewiki-0771/architecture.svg)

三层 re-export（`pub use jcode_tui::*` → `pub use jcode_app_core::*` → `pub use jcode_base::*`）让旧代码的 `crate::config`、`crate::server`、`crate::tui` 路径在拆 crate 后继续生效，迁移零成本。类型契约 crate（右侧旁路）被各层共享依赖，不拉入 runtime/TUI/provider 重图。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|----------------------|
| 进程入口 | `src/main.rs` | allocator 调优、tokio runtime、multicall 拦截——把"进程怎么启动"与业务彻底隔离 |
| CLI 层 | `src/cli/` | 参数解析、命令分发、依赖反转组合根——唯一允许跨层 wiring 的地方 |
| 表示层 | `crates/jcode-tui/` | TUI 渲染、StreamBuffer、InfoWidget——隔离终端 UI 变化不影响核心 |
| 应用核心 | `crates/jcode-app-core/` | server/agent/tool/ambient——编排用例流程，协调领域对象 |
| 基础设施 | `crates/jcode-base/` | provider/memory/config/session/bus——承载业务规则与外部适配，不依赖上层 |
| 类型契约 | `crates/jcode-*-types/` | 稳定数据契约（serde），无 FS/网络/进程依赖，编译快、重编面小 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 依赖反转 / 组合根 | `register_*` in `src/cli/startup.rs` | base 不能命名下游类型；集中 wiring 保持层间无环 |
| 三层 re-export | `lib.rs` 各 crate | 拆 crate 编译隔离但路径不变，迁移零成本 |
| 事件总线 | `Bus::global()` in `crates/jcode-base/src/bus.rs` | tokio broadcast channel(256) 解耦 server/agent/provider/TUI |
| 注册表 | `Registry` in `tool/mod.rs`、`ServerRegistry` | 工具/MCP/server 动态注册与查找 |
| Sideagent | `MemoryAgent` in `memory_agent.rs` | 独立 tokio task，不阻塞主对话流 |
| 策略 + Failover 链 | `MultiProvider` / `fallback_sequence` | 多 provider 槽 + 两级 failover（同 provider 账号 → 跨 provider） |
| 自适应调度器 | `AdaptiveScheduler` in `ambient/scheduler.rs` | 按 rate limit headroom 动态计算 ambient 触发间隔 |
| 热重载 (exec-based) | `reload.rs` | `exec` 新二进制 + socket fd 跨 exec，不丢会话 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `Agent` | agent 运行时，驱动 turn 循环 | per-session（`Arc<Mutex<Agent>>`） | 持有 Provider/Registry/Session |
| `Server` | daemon 服务器，管理所有会话 | 进程级单例（daemon lock） | 持有 sessions map/SwarmState/FileTouchService |
| `Session` | 会话状态与消息历史 | 持久化到 `~/.jcode/sessions/` | journal + snapshot 双重持久化 |
| `SwarmMember` | swarm 成员 | spawn → ready → running → terminal | `report_back_to_session_id` 构成 spawn 树 |
| `MemoryEntry` | 记忆条目 | 持久化到 memory graph JSON | confidence 衰减 + reinforcement 增强 |
| `MemoryGraph` | 记忆图 | 进程级 + 磁盘持久化 | memories + tags + clusters + edges |
| `Registry` | 工具注册表 | per-session（Arc 共享无状态工具） | 持有 tools/skills/compaction |
| `MultiProvider` | 多 provider 管理器 | 进程级 | 8 个 provider 槽 + failover 链 |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `Provider` | `jcode-provider-core/src/lib.rs:75` | AnthropicProvider/OpenAIProvider/GeminiProvider/CopilotApiProvider/... | `register_external_provider_runtimes` 工厂闭包 |
| `Tool` | `jcode-tool-core/src/lib.rs:144` | BashTool/EditTool/ReadTool/CommunicateTool/McpProxy/... | `Registry::base_tools()` + `insert_tool_timed` |
| `EmbeddingBackend` | `jcode-base/src/embedding_backend.rs:33` | LocalOnnxBackend(MiniLM) / OpenAiEmbeddingBackend | `active_backend()` 按 config 选择 |
| `BusEvent` | `jcode-base/src/bus.rs:395` | 30+ 事件变体 | `Bus::global().publish()` |

---

## 代码目录

```
jcode/
├── src/                          # 根 crate（CLI 入口层）
│   ├── main.rs                   # 进程入口：allocator 调优、tokio runtime、multicall 拦截
│   ├── lib.rs                    # 三层 re-export 根：pub use jcode_tui::* + pub mod cli
│   ├── bin/                      # 辅助二进制：harness / test_api / tui_bench / memory_bench
│   └── cli/                      # CLI 层：startup / dispatch / args / commands / provider_init / login
│
├── crates/
│   ├── jcode-base/               # 基础设施层（~108K 行）：provider / memory / config / session / bus / safety / mcp / skill
│   ├── jcode-app-core/           # 应用核心层（~134K 行）：server / agent / tool / ambient
│   ├── jcode-tui/                # 表示层（~204K 行）：tui 渲染 / video_export
│   ├── jcode-tool-core/          # Tool trait 定义
│   ├── jcode-provider-core/      # Provider trait + failover/selection
│   ├── jcode-message-types/      # Message / StreamEvent / ContentBlock / ToolCall 数据契约
│   ├── jcode-protocol/           # Request / ServerEvent wire 协议
│   ├── jcode-harness-api/        # 稳定版本化客户端 API（NDJSON）
│   ├── jcode-embedding/          # 本地 ONNX embedding（all-MiniLM-L6-v2 + tract）
│   ├── jcode-provider-*-runtime/ # 11 个 provider runtime 叶子 crate（anthropic/openai/gemini/copilot/bedrock/...）
│   ├── jcode-tui-mermaid/        # 纯 Rust mermaid 渲染器
│   ├── jcode-swarm-core/         # swarm 核心类型
│   └── jcode-*-types/            # 各领域稳定数据契约 crate（session/config/tool/background/...）
│
├── docs/                         # 架构设计文档（AMBIENT_MODE / SWARM_ARCHITECTURE / SERVER_ARCHITECTURE / ...）
├── tests/                        # 集成测试（auth_login_flow / provider_matrix / e2e / desktop-gallery-golden）
├── changelog/                    # 60 个版本 JSON
├── scripts/                      # 构建/发布/依赖边界检查脚本
├── telemetry-worker/             # 遥测数据处理 worker
├── sdk/                          # TypeScript SDK
└── ios/                          # iOS 应用（开发中）
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/jcode-codewiki-0771/module-dependencies.svg)

jcode 的 9 个核心模块按职责分化自然形成。依赖方向整体自上而下：CLI 层 wiring → 表示层/应用核心 → 基础设施。Agent 运行时是中枢，向下依赖 Provider/Tool/Memory/Config，被 Server 驱动。模块间的动态调用顺序见运行时行为 > 核心运行流程。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| CLI 入口与分发 | 进程入口、依赖反转组合根、命令分发 | `startup::run()` | 唯一允许跨层 wiring 的层，隔离进程启动与业务 | [CLI 入口](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/01-cli-entry) |
| Agent 运行时 | agent turn 循环、流式、中断、压缩 | `run_once_streaming_mpsc()` | 编码 agent 的核心循环，自成一域 | [Agent 运行时](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/02-agent-runtime) |
| Server 与 Swarm | daemon、多会话、swarm 协作、热重载 | `Server::run()` | 多会话与多 agent 协作是独立复杂域 | [Server 与 Swarm](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/03-server-swarm) |
| Provider 多模型 | LLM 路由、failover、30+ provider | `MultiProvider::complete_with_failover()` | provider 适配与 failover 策略自成一域 | [Provider 多模型](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/04-provider) |
| Memory 记忆系统 | embedding 检索、LLM judge 重排、提取 | `MemoryAgent::process_context()` | passive 记忆是 jcode 智能化的核心差异化 | [Memory 记忆](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/05-memory) |
| Tool 工具系统 | 30+ 工具、注册表、destructive gate、MCP | `Registry::execute()` | 工具执行与安全门控独立于 agent 循环 | [Tool 系统](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/06-tool-system) |
| TUI 渲染引擎 | 终端 UI、StreamBuffer、InfoWidget、mermaid | `App::run()` | 渲染管线与帧调度独立于业务逻辑 | [TUI 引擎](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/07-tui-engine) |
| Ambient 后台 | 自适应调度、memory gardening、proactive | `AmbientRunnerHandle` | 后台整合是独立运行模式 | [Ambient 后台](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/08-ambient) |
| Config 与基础设施 | 配置热重载、会话持久化、事件总线、安全 | `config()` / `Bus::global()` | 被所有模块依赖的底座 | [Config 基础设施](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/09-config-infra) |

---

## 运行时行为

### 启动流程

```
main()                                    src/main.rs:101
  ├─ configure_system_allocator()         jemalloc(glibc mallopt) RSS 调优
  ├─ rustls crypto provider install
  ├─ tokio multi_thread runtime
  └─ jcode::run()                         src/lib.rs:29
       └─ cli::startup::run()             src/cli/startup.rs:18
            ├─ install_panic_hook / logging::init
            ├─ spawn 后台清理线程（memlog / session .bak）
            ├─ 依赖反转注册（6 个 register_*）     ← 组合根
            │    ├─ register_external_provider_runtimes()   9 provider 工厂
            │    ├─ register_api_key_fallback_resolver()     auth 凭据
            │    ├─ register_permission_notifier()           safety → notifications
            │    ├─ register_synthetic_entry_provider()      memory → skill
            │    ├─ session_list_cache::register_invalidator()
            │    └─ register_default_server_spawner()        tui → cli
            ├─ parse_and_prepare_args() → Args::parse()
            └─ dispatch::run_main(args)
                 ├─ Command::Serve → Server::new().run()
                 ├─ Command::Run → run_single_message_command
                 └─ None → run_default_command() → spawn_server + run_tui_client()
```

对象装配的关键在依赖反转注册：base 层的 `provider::external` 模块持有一个 process-global `OnceLock<RwLock<HashMap<&str, Factory>>>`，`register_external_provider_runtimes`（`startup.rs:183`）把 9 个 provider runtime 的工厂闭包注入其中。base 通过 `instantiate_expected_external_provider` 拿 `Arc<dyn Provider>` trait object，不命名下游具体类型。这样 `MultiProvider` 从多处构造（startup / post-auth / TUI onboarding / overnight）时不需要每处都穿完整 provider 集——工厂闭包集中注册一次。

### 核心运行流程

jcode 运行时有三条最核心的业务链路：交互式 TUI 对话、工具执行循环、swarm 文件冲突通知。

#### 交互对话：TUI → Server → Agent → Provider

业务流程：用户输入 → TUI 序列化 Request → socket 传输 → Server 分发 → Agent turn 循环 → Provider 流式 → StreamEvent 转 ServerEvent → 回写 TUI → 渲染。

![端到端请求数据流](/vibe-reading/images/articles/jcode-codewiki-0771/data-flow.svg)

文字描述：TUI 的 `backend.send_message()` 把用户输入序列化为 `Request::Message` JSON 写入 Unix socket。Server 的 accept loop（`runtime.rs:156`）接受连接后 `handle_client()`（`client_lifecycle.rs:363`）解码请求，`tokio::spawn` 一个 `process_message_streaming_mpsc` task 持有 `Arc<Mutex<Agent>>` 和 `mpsc::UnboundedSender<ServerEvent>`。Agent 的 `run_once_streaming_mpsc()`（`turn_execution.rs:48`）追加用户消息后进入 `run_turn` 循环（`turn_streaming_mpsc.rs:79`）：构建 messages + tools + system_prompt → `provider.complete_split()` 返回 `EventStream<StreamEvent>` → 逐事件 match（TextDelta/ToolUseStart/...）→ 转换为 `ServerEvent` 通过 mpsc 回写 → 若有 tool_calls 执行后继续循环，无则 break。数据类型在边界变化：`Request::Message`（wire）→ `&str` + Agent → `Vec<Message>`/`Vec<ToolDefinition>`（provider 输入）→ `EventStream<StreamEvent>`（provider 输出）→ `ServerEvent`（wire 回写）。

#### 工具执行：Registry → Tool → Safety

Agent turn 循环中 provider 产出 `ToolCall` 后，`Registry::execute()`（`tool/mod.rs:645`）查找工具 → `SessionToolPolicy` 白名单检查 → `pre_tool` hook → `tool.execute(input, ctx)` → `post_tool` hook → `guard_context_overflow` 裁剪。bash 工具额外经 `destructive_command_refusal()`（`bash_destructive_gate.rs`）两阶段门控：Stage 1 blast-radius 评估（`/`、`$HOME` 直接 Deny）→ Stage 2 justification 反思（模型须解释为何该命令服务用户请求）。工具输出超 90% context budget 默认拒绝而非截断——截断是更坏的失败（caller 付全价 context 却只得无答案前缀）。

#### Swarm 协作：文件冲突双向通知

Agent 工具调用 edit/write 时 `Bus::global().publish(BusEvent::FileTouch)`。Server 的 bus monitor（`server.rs:1942`）消费事件 → `FileTouchService` 双索引记录 → 仅 `is_modification` 时查 `latest_peer_touches()`（同 swarm 其他 session 是否动过该文件）→ 双向通知：修改者得知之前谁动过，之前的修改者得知有人刚动了。通过 `soft_interrupt_queues` 注入软中断，agent 在当前 turn 结束后看到通知。这是 swarm 的核心价值——多 agent 同仓库协作时自动检测冲突，不需主动轮询。

### 状态流

![状态流转](/vibe-reading/images/articles/jcode-codewiki-0771/state-flow.svg)

Swarm 成员状态机（左）：`Spawning`（`spawn_swarm_agent()`）→ `Ready`（注册到 `SwarmState`）→ `Running`（agent turn 执行）→ terminal（`Completed`/`Failed`/`Stopped`）。terminal 状态由 `prune_expired_terminal_swarm_members()`（默认 24h）和 `reap_idle_spawned_workers()`（默认 30min）GC 回收。会话状态（右）：`Active`（有活跃 client）→ `Idle`（client 断开但 session 保留）→ `Crashed`（panic_hook 标记）→ `Resumed`（`--resume` 恢复）或 `Closed`（journal 持久化）。相关代码：`SwarmMember.status` 在 `state.rs:188`，状态转换在 `swarm.rs:1291 update_member_status`；`SessionStatus` 在 `session.rs`，crash 标记在 `terminal.rs:184 panic_hook`。

---

## 典型修改场景

#### 场景 1：新增一个 Provider runtime

1. 新建 `crates/jcode-provider-xxx-runtime/`，实现 `Provider` trait（参考 `jcode-provider-anthropic-runtime/src/lib.rs`）。
2. 在 `crates/jcode-base/src/provider/external.rs` 加 `pub const XXX_RUNTIME: &str = "xxx";` 常量。
3. 在 `src/cli/startup.rs:183` 的 `register_external_provider_runtimes` 加 `register_external_provider(XXX_RUNTIME, || Arc::new(XxxProvider::new()))`。
4. 若需新 `ActiveProvider` 变体，改 `jcode-provider-core/src/selection.rs:4` 的 enum + 所有 match 分支（成本较高，通常复用 `OpenRouter` 槽或 OpenAI-compatible profile 更划算）。
5. 在 `startup.rs:85` 的 `new_with_auth_status` 加凭据 probe + 实例化分支。

对应测试：`tests/provider_matrix.rs`、`src/cli/provider_init_tests.rs`。

#### 场景 2：新增一个 native 工具

1. 在 `crates/jcode-app-core/src/tool/` 下新建 `xxx.rs`，实现 `Tool` trait（`name()`/`description()`/`parameters_schema()`/`execute()`）。
2. 在 `tool/mod.rs` 顶部 `mod xxx;` 声明模块。
3. 在 `base_tools()`（`mod.rs:191`）中 `insert_tool_timed(&mut m, "xxx", xxx::XxxTool::new)`。
4. 若工具需 session 级依赖，在 `Registry::new()`（`mod.rs:309`）的 session_tools 段添加。

对应测试：`tool/*_tests.rs`、`src/cli/commands_tests.rs`。

#### 场景 3：新增 BusEvent 变体

1. 在 `crates/jcode-base/src/bus.rs` 定义事件 payload struct。
2. 在 `BusEvent` enum（`bus.rs:395`）添加变体。
3. 发布方调用 `Bus::global().publish(BusEvent::Xxx(...))`。
4. 订阅方在 `match event { BusEvent::Xxx(e) => ... }` 处理。

对应测试：`bus.rs` 内联测试。

---

## 测试体系

```
tests/
├── auth_login_flow.rs           # OAuth 登录流程集成测试
├── provider_matrix.rs           # 多 provider 矩阵测试（33K 行）
├── context_window_matrix.rs     # 上下文窗口矩阵
├── e2e/                         # 端到端测试
├── fixtures/                    # 测试夹具
├── desktop-gallery-golden/      # 桌面 UI 黄金图对比
└── test_*.py                    # 注入/自修复 Python 测试脚本
```

| 代码层 | 测试类型 | 位置 |
|--------|---------|------|
| Provider 适配 | 集成矩阵 | `tests/provider_matrix.rs` |
| Agent turn / Tool | 内联单元 | `agent_tests.rs`、`tool/*_tests.rs`、`commands_tests.rs` |
| Server / Swarm | 内联集成 | `server/*_tests.rs`、`client_lifecycle_tests.rs` |
| TUI 渲染 | 黄金图 + 内联 | `desktop-gallery-golden/`、`tui/info_widget_*_tests.rs` |
| Auth 登录 | 端到端 | `tests/auth_login_flow.rs` |

jcode 的测试以 crate 内联测试为主（`*_tests.rs` 文件与源码平级），`tests/` 目录持有跨 crate 集成测试。`AGENTS.md` 的 dependency-boundaries 文档记录了精确测试 filter（避免 broad filter 选到不相关 stateful 测试）。想理解某个模块，优先读其对应的 `*_tests.rs`——它们是可执行文档。

---

## 阅读源码推荐路线

- **第一遍：理解启动与主流程**
  `src/main.rs`（allocator + runtime）→ `src/lib.rs`（三层 re-export）→ `src/cli/startup.rs` 的 `run()`（6 个 register_* 组合根）→ `src/cli/dispatch.rs` 的 `run_main()`（命令分发）→ `crates/jcode-app-core/src/server/client_lifecycle.rs` 的 `handle_client()`（接受连接）→ `crates/jcode-app-core/src/agent/turn_execution.rs` 的 `run_once_streaming_mpsc()`（turn 入口）

- **第二遍：理解 Agent turn 循环**
  `crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs` 的 `run_turn_streaming_mpsc()`（循环主体）→ `agent/streaming.rs`（keepalive）→ `agent/interrupts.rs`（soft interrupt 注入）→ `agent/prompting.rs`（system prompt split）→ `agent/response_recovery.rs`（文本包裹 tool call 恢复）

- **第三遍：理解多模型与记忆**
  `crates/jcode-base/src/provider/multi_provider.rs`（failover 链）→ `provider/failover.rs`（错误分类）→ `provider/dispatch.rs`（分发）→ `crates/jcode-base/src/memory_agent.rs` 的 `process_context()`（召回流程）→ `memory.rs` 的 `find_similar_hybrid()`（hybrid 检索）→ `memory_rerank.rs`（consensus 重排）

- **第四遍：选择重点模块深入阅读**（模块文档）
  Server/Swarm 的文件冲突通知（`server.rs:1942` bus monitor）→ TUI 的 StreamBuffer（`jcode-tui-core/src/stream_buffer.rs`）→ Tool 的 destructive gate（`tool/bash_destructive_gate.rs`）→ Ambient 的自适应调度（`ambient/scheduler.rs`）

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| harness | 驱动 LLM 自主完成任务的"外壳"框架，管理 tool 执行、上下文、记忆 |
| turn | agent 的一次完整循环：provider 请求 → 流式响应 → 工具执行 → 中断检查 |
| passive memory | 不作为 tool 暴露，每轮自动检索注入对话的记忆系统 |
| swarm | 多 agent 在同一仓库协作，server 自动检测文件冲突 |
| ambient | 后台自主模式，像睡眠时整理记忆一样做 memory gardening + proactive work |
| self-dev | agent 修改 jcode 自身源码并热重载的开发模式 |
| KV cache | provider 端的 prompt 前缀缓存，jcode 追踪其冷热状态避免 cache miss |
| re-export | `pub use crate_a::*` 让拆 crate 后旧路径继续生效 |
| composition root | 集中做依赖反转注册的地方（`startup::run()`） |

### 参考资料

- [jcode.sh/docs](https://jcode.sh/docs) — 官方文档站
- [jcode.sh/bench](https://jcode.sh/bench) — benchmark 方法论与结果
- [Ambient Mode 设计](https://github.com/1jehuang/jcode/blob/main/docs/AMBIENT_MODE.md)
- [Swarm Architecture](https://github.com/1jehuang/jcode/blob/main/docs/SWARM_ARCHITECTURE.md)
- [Server Architecture](https://github.com/1jehuang/jcode/blob/main/docs/SERVER_ARCHITECTURE.md)
- [Crate Ownership Boundaries](https://github.com/1jehuang/jcode/blob/main/docs/CRATE_OWNERSHIP_BOUNDARIES.md)
- [Compile-Time Isolation Refactor](https://github.com/1jehuang/jcode/blob/main/docs/COMPILE_TIME_ISOLATION_REFACTOR.md)
- [mermaid-rs-renderer](https://github.com/1jehuang/mermaid-rs-renderer) — 纯 Rust mermaid 渲染库
