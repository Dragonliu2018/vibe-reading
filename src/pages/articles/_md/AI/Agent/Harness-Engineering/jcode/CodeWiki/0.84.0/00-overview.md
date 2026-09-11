---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Overview"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "Agent Harness", "TUI", "Memory", "Swarm", "多模型"]
description: "jcode v0.84.0 源码解读——Rust 编写的极致内存效率编码 agent harness，三层 re-export + 82 crate 编译隔离、agent turn 循环、passive 记忆系统（hybrid 检索 + consensus LLM rerank）、swarm Plan DAG、原生 SSH 远程会话与 harness API/SDK"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.84.0（2026-09-06）· **协议** MIT · **语言** Rust (edition 2024) · **代码量** ~682,000 行 Rust / 82 crate · **仓库** [GitHub](https://github.com/1jehuang/jcode)

---

## 总览

### 项目简介

jcode 是一个用 Rust 编写的终端编码 agent harness——即驱动 LLM 自主完成编码任务的"外壳"框架，与 Claude Code、Codex CLI、Cursor Agent 同类。它的核心定位是两条：**最省内存的 harness**（单会话 27.8 MB PSS，比 Claude Code 低 13.9×；每加一个会话仅 ~10.4 MB，Claude Code 是 ~212.7 MB）和**最智能的 harness**（passive 记忆系统 + ambient 后台整合 + swarm 多 agent 协作）。

jcode 解决的核心问题是：现有编码 agent 普遍臃肿——单会话占数百 MB 内存、首帧渲染需数秒、无跨会话记忆、多 agent 无法协作。jcode 从 allocator 层开始系统性优化内存（jemalloc `dirty_decay_ms:1000` 调优、glibc `mallopt(M_MMAP_THRESHOLD, 256KiB)` pin 住 mmap 阈值），用自定义 TUI 渲染管线实现 14.0 ms 首帧与 48.7 ms 首输入（Claude Code 分别为 3436.9 ms / 3512.8 ms，慢 245.5× / 72.2×），用本地 ONNX embedding 语义检索实现"像人一样自动回忆"的 passive 记忆，用 daemon 架构 + 文件冲突双向通知实现 swarm 多 agent 在同一仓库协作。

核心使用场景：交互式 TUI 编码（`jcode`）、非交互单次执行（`jcode run`）、持久 daemon + 多客户端（`jcode serve` / `jcode connect`）、**远程 SSH 会话**（v0.83.0 起 `jcode --ssh dev --remote-working-dir /srv/jcode`，本地 TUI + 远程执行）、SDK 驱动（Rust `jcode-sdk` / TypeScript `@1jehuang/jcode-sdk`）、自我开发模式（agent 修改 jcode 自身源码并热重载）。**项目边界**：jcode 是 harness 框架，不训练模型、不提供模型推理——它通过 8 个 provider 槽位 + OpenRouter 聚合器 + 42 个内置 OpenAI-compatible profile 接入用户已有的 OAuth 订阅或 API key。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| TUI 交互编码 | `crates/jcode-tui/src/tui/` | ratatui 客户端，App + TuiState(114 方法) + StreamBuffer 平滑 |
| 多 provider 接入 | `crates/jcode-base/src/provider/` + 9 个 `jcode-provider-*-runtime` | 8 槽位 + failover 链 + 42 内置 profile + config 自定义 |
| Passive 记忆 | `crates/jcode-base/src/memory_agent.rs` | 每轮自动检索注入，无需模型主动调用 |
| Swarm 多 agent | `crates/jcode-app-core/src/server/` + `jcode-plan`/`jcode-swarm-core` | 文件冲突检测 + Plan DAG + DM/子树广播 |
| Ambient 后台 | `crates/jcode-app-core/src/ambient/` | memory gardening + 侦察 + 主动干活，自适应调度 |
| MCP 工具 | `crates/jcode-base/src/mcp/` | 共享进程池 + auto/deferred 暴露策略 + schema cache 预注册 |
| 安全门控 | `crates/jcode-command-risk/` + `safety.rs` | bash 两阶段 destructive gate + ambient 权限审批 |
| 上下文压缩 | `crates/jcode-compaction-core/` + `compaction.rs` | 80% 阈值后台压缩 / 95% 硬压缩 / emergency 截断 |
| 热重载 | `server/reload.rs` + `hot_exec.rs` | exec 替换进程镜像，会话与输入行保留 |
| 远程 SSH | `src/cli/ssh.rs` + `tui/app/remote.rs` | 本地 TUI + 远程 daemon，v0.83.0 |
| Harness API / SDK | `jcode-harness-api` + `jcode-sdk` + `sdk/typescript` | NDJSON v1 稳定协议，双语言 SDK parity |
| ACP 适配 | `src/cli/acp.rs` | JSON-RPC over stdio，可被 Zed 等 ACP 编辑器驱动 |
| Mermaid 渲染 | `crates/jcode-tui-mermaid/` | 纯 Rust 渲染器（无浏览器/TS 依赖）+ Kitty/Sixel/iTerm2 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| ratatui + crossterm | 核心 | 终端 UI 框架与事件流 |
| tokio | 核心 | 多线程 async runtime（server/agent/tool 全异步） |
| reqwest (rustls) | 核心 | provider HTTP/SSE/WebSocket 客户端（纯 Rust TLS，无 OpenSSL） |
| tract + tokenizers | 核心 | 本地 ONNX 推理 all-MiniLM-L6-v2 embedding（384 维） |
| tikv-jemallocator | 可选 | 长 running server 的 RSS 调优（feature gate） |
| clap | 核心 | CLI 参数（derive 模式，~40 个 provider 枚举） |
| serde/serde_json | 核心 | wire 协议 + 配置 + session journal 全序列化 |
| pulldown_cmark + syntect | 核心 | TUI markdown 渲染与语法高亮 |
| mermaid-rs-renderer | 核心 | 纯 Rust mermaid → SVG → resvg PNG |
| petgraph 之外手写 HashMap 图 | — | MemoryGraph 用 HashMap 双向边表（文档曾写 petgraph，已改） |

### 版本历史

jcode 于 2026-01-05 首次提交，两个月内 7400+ commit、78 个 release（v0.34.0 起有 changelog）。演进两条主线：**性能压榨**（allocator 调优 → 82 crate 编译隔离 → StreamBuffer 流式平滑）和**智能化**（基础工具 → passive 记忆 → ambient 后台 → swarm Plan DAG）。相对本博客已解读的 v0.77.1，v0.78.0–v0.84.0 的关键增量：harness API 支持图片（v0.78）、大 MCP 工具目录自动 deferred（v0.79）、集成发现与子 agent 模型选择（v0.80）、embedder 外部唤醒控制（v0.81）、OpenAI Responses WebSocket 预热 + SDK 图片中断（v0.82）、**原生 SSH 远程会话与远程登录**（v0.83）、远程登录 onboarding 改进（v0.84）。swarm 侧正在从 agent-first 转向 **task DAG-first**（`docs/SWARM_TASK_GRAPH.md`，DAG 引擎与 deep/light 模式已上线，channel 迁移进行中）。

---

## 快速上手

```bash title="快速上手"
# 安装（macOS & Linux）
curl -fsSL https://jcode.sh/install | bash

# 启动 TUI（默认子命令，自动拉起后台 daemon）
jcode

# 非交互单次执行（不经过 server，进程内直跑）
jcode run "say hello"

# 持久 daemon + 多客户端
jcode serve
jcode connect

# 恢复历史会话（按动物名）
jcode --resume fox

# 远程 SSH 会话（本地 TUI + 远程执行）
jcode --ssh dev --remote-working-dir /srv/jcode
```

验证：`jcode run "say hello"` 应在终端输出模型响应。首次使用需 `jcode login --provider claude`（或其他 provider）完成 OAuth 登录。构建源码用 `cargo build --profile selfdev`——注意 `AGENTS.md` 的警告：`cargo build` 证明不了行为，运行时服务由 `~/.jcode/builds/shared-server/` 的长驻 daemon 提供，测试改动要用 `./target/selfdev/jcode run --no-update --socket /run/user/1000/jcode-mytest.sock '<prompt>'` 起独立 socket。

---

## 架构设计解析

### 系统架构

jcode 的架构设计有两个核心思想：**编译时隔离**和**依赖反转组合根**。

**编译时隔离**——82 个 crate 不是过度工程，而是为了缩小重编译面。关键瓶颈是 `jcode-base(~112K 行) → jcode-app-core(~139K 行) → jcode-tui(~211K 行) → jcode lib → jcode bin` 这条线性串行栈。拆出 `*-types` crate（`jcode-message-types`、`jcode-protocol`、`jcode-config-types` 等）持有稳定数据契约，改一个 provider 字段只需重编该 type crate + 焦点依赖。provider runtime crate（`jcode-provider-anthropic-runtime` 等 9 个）移到 base 下游且强制 `default-features = false`（防 feature unification 重新打开 base 的重依赖），编辑 provider 只重编该 crate + binary relink。`docs/CRATE_OWNERSHIP_BOUNDARIES.md` 明确了归属规则：`*-types` crate 只放纯数据契约（无 FS/网络/进程），需要 runtime 行为的类型留在 base。

**依赖反转组合根**——base 层无法命名下游 provider runtime 的具体类型（否则反向依赖）。解法是在 `src/cli/startup.rs` 的 `run()` 中集中注册：`register_external_provider_runtimes()` 把 9 个 provider 工厂闭包注入 base 的进程级 `OnceLock` 注册表（`external.rs`）；`register_permission_notifier` 让 safety 层回调 notifications；`register_synthetic_entry_provider` 让 memory 层回调 skill；`register_api_key_fallback_resolver`、`register_openrouter_factory`（4 种 spec）等同理。选进程级全局注册而非构造注入的原因：`MultiProvider` 构造点太多（startup、post-auth 热初始化、TUI onboarding），registry 启动时写一次、之后只读。

![jcode 分层架构](/vibe-reading/images/articles/jcode-codewiki-0840/architecture.svg)

三层 re-export（`pub use jcode_tui::*` → `pub use jcode_app_core::*` → `pub use jcode_base::*`）让旧代码的 `crate::config`、`crate::server`、`crate::tui` 路径在拆 crate 后继续生效，迁移零成本。类型契约 crate（右侧旁路）被各层共享依赖，不拉入 runtime/TUI/provider 重图。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|----------------------|
| 进程入口 | `src/main.rs` | allocator 调优、tokio runtime、multicall 拦截——把"进程怎么启动"与业务彻底隔离 |
| CLI 层 | `src/cli/` | 参数解析、命令分发、依赖反转组合根——唯一允许跨层 wiring 的地方 |
| 表示层 | `crates/jcode-tui/` | TUI 渲染、StreamBuffer、InfoWidget、远程 attach——隔离终端 UI 变化不影响核心 |
| 应用核心 | `crates/jcode-app-core/` | server/agent/tool/ambient/plan——编排用例流程，协调领域对象 |
| 基础设施 | `crates/jcode-base/` | provider/memory/config/session/bus/safety/mcp——承载业务规则与外部适配 |
| 类型契约 | `crates/jcode-*-types/` | 稳定数据契约（serde），无 FS/网络/进程依赖，编译快、重编面小 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 依赖反转 / 组合根 | `register_*` in `src/cli/startup.rs` | base 不能命名下游类型；集中 wiring 保持层间无环 |
| 三层 re-export | `lib.rs` 各 crate | 拆 crate 编译隔离但路径不变，迁移零成本 |
| 事件总线 | `Bus::global()` in `crates/jcode-base/src/bus.rs` | tokio broadcast(256) 解耦 server/agent/provider/TUI（进程内） |
| 注册表 | `Registry` in `tool/mod.rs`、`ProviderRegistry` | 工具/MCP/provider 动态注册与查找 |
| Sideagent | `MemoryAgent` in `memory_agent.rs` | 独立 tokio task 常驻 actor，主 agent 从不等待记忆 |
| 策略 + Failover 链 | `MultiProvider` / `fallback_sequence` | 两级 failover：同 provider 账号 → 跨 provider 候选表 |
| RAII guard | `StreamingGuard` / `_turn_cancel_guard` / `inflight` | presence 标记、turn 取消注册、工具飞行计数自动清理 |
| Multicall 拦截（BusyBox 风格） | `is_macos_hotkey_listener_invocation` in `main.rs` | 同一 universal binary 按 argv 充当热键监听/通知 broker 等不同进程 |
| 热重载 (exec-based) | `reload.rs` / `hot_exec.rs` | `platform::replace_process` exec 新二进制 + 客户端自动重连，不丢会话 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `Agent` | agent 运行时，驱动 turn 循环 | per-session（`Arc<Mutex<Agent>>`，tokio Mutex） | 持有 Provider/Registry/Session |
| `Server` | daemon 服务器，管理所有会话 | 进程级（socket 单实例） | 持有 sessions/SwarmState/FileTouchService |
| `Session` | 会话状态与消息历史 | journal + snapshot 双持久化到 `~/.jcode/sessions/` | torn-line 修复 + crash 恢复 |
| `SwarmMember` | swarm 成员 | Spawning → Ready → Running → terminal | `report_back_to_session_id` 构成 spawn 树 |
| `VersionedPlan` | swarm 共享任务图 | server 持有 + 崩溃恢复持久化 | `PlanItem.blocked_by` 即 DAG 依赖边 |
| `MemoryEntry` | 记忆条目 | confidence 按类别半衰期衰减 | reinforcement 增强 + superseded_by 淘汰 |
| `MemoryGraph` | 记忆图（memories + tags + clusters + edges） | project/global 双 scope 持久化 JSON | `cascade_retrieve` BFS 遍历 |
| `Registry` | 工具注册表 | per-session（无状态工具经 OnceLock 全局共享） | 持有 tools/skills/compaction |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `Provider` | `jcode-provider-core/src/lib.rs:76` | Anthropic/OpenAI/OpenRouter/Gemini/Copilot/Cursor/Bedrock/Antigravity/GrokBuild 等 | `register_external_provider_runtimes` 工厂闭包 |
| `Tool` | `jcode-tool-core/src/lib.rs:145` | Read/Bash/Edit/Batch/Communicate/McpProxy/... 30+ | `Registry::base_tools()` OnceLock + per-session |
| `TuiState` | `jcode-tui/src/tui/mod.rs:270` | `App`（生产）/ `TestState`（测试） | 直接 impl（114 方法展示接口） |
| `EmbeddingBackend` | `jcode-base/src/embedding_backend.rs:33` | 本地 MiniLM (tract ONNX) / OpenAI 远程 | `active_backend()` 按 config 选择 |
| `BusEvent` | `jcode-base/src/bus.rs:395` | 32 个事件变体 | `Bus::global().publish()` |

---

## 代码目录

```
jcode/
├── src/                          # 根 crate（CLI 入口层，~34K 行）
│   ├── main.rs                   # 进程入口：allocator 调优、Windows 8MiB 栈、multicall 拦截
│   ├── lib.rs                    # 三层 re-export 根：pub use jcode_tui::* + pub mod cli
│   ├── bin/                      # 辅助二进制：tui_bench / memory_recall_bench / session_memory_bench
│   └── cli/                      # CLI 层：startup(组合根) / dispatch / args / commands / login
│       │                         #   / provider_init / acp(74K) / ssh / hot_exec / tui_launch
│
├── crates/
│   ├── jcode-base/               # 基础设施层（~112K 行）：provider / auth / memory / config
│   │                             #   / session / bus / safety / mcp / skill / usage / storage
│   ├── jcode-app-core/           # 应用核心层（~139K 行）：server / agent / tool / ambient / replay
│   ├── jcode-tui/                # 表示层（~211K 行）：tui 渲染 / info_widget / 远程 attach
│   ├── jcode-provider-core/      # Provider trait + failover/selection/pricing（纯逻辑）
│   ├── jcode-provider-metadata/ # 42 个内置 OpenAI-compatible profile 定义
│   ├── jcode-provider-*-runtime/ # 9 个 provider runtime 叶子 crate（anthropic/openai/...）
│   ├── jcode-tool-core/-types/   # Tool trait / ToolOutput + resolve_tool_name 别名映射
│   ├── jcode-message-types/      # Message / StreamEvent / ContentBlock / ToolCall 数据契约
│   ├── jcode-protocol/           # Request / ServerEvent wire 协议（内部）
│   ├── jcode-harness-api/        # 公开稳定 API 类型 + NDJSON 帧（v1）
│   ├── jcode-harness-api-server/ # bridge 进程：公开 API → 内部协议纯 JSON 翻译
│   ├── jcode-sdk/                # Rust SDK（Desktop2 日常使用）
│   ├── jcode-embedding/          # 本地 ONNX embedding（all-MiniLM-L6-v2 + tract）
│   ├── jcode-memory-types/       # MemoryEntry / MemoryGraph / PipelineState 契约
│   ├── jcode-compaction-core/     # 压缩常量与纯函数层
│   ├── jcode-swarm-core/         # swarm 共享类型（SwarmMemberRecord / ChannelIndex）
│   ├── jcode-plan/               # PlanItem DAG + VersionedPlan + mermaid 导出
│   ├── jcode-transport/          # Unix socket / Windows named pipe 统一抽象
│   ├── jcode-tui-mermaid/        # mermaid → PNG 终端渲染（Kitty/Sixel/iTerm2）
│   ├── jcode-tui-markdown/       # markdown → ratatui Line（pulldown_cmark + syntect）
│   ├── jcode-render-core/         # 后端中立渲染模型（TUI/桌面 GPU UI 共享）
│   └── jcode-*-types/            # 其余各领域稳定数据契约 crate
│
├── docs/                         # 68 篇架构文档（SERVER/SWARM/MEMORY/AMBIENT/...）
├── tests/                        # 集成测试：provider_matrix / e2e/ (15 文件) / auth_login_flow
├── changelog/                    # 78 个版本 JSON（v0.34.0 → v0.84.0）
├── sdk/typescript/               # TypeScript SDK（@1jehuang/jcode-sdk）
├── telemetry-worker/             # 遥测数据处理 Cloudflare Worker
├── scripts/                      # 构建/基准/发布脚本
└── ios/                          # iOS 远控 App（纯 Swift，~4.8K 行）
```

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/jcode-codewiki-0840/module-dependencies.svg)

jcode 的 10 个核心模块按职责分化自然形成。依赖方向整体自上而下：CLI 层 wiring → 表示层/应用核心 → 基础设施。Agent 运行时是中枢，向下依赖 Provider/Tool/Memory/Config，被 Server 驱动。模块间的动态调用顺序见运行时行为 > 核心运行流程。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| CLI 入口与分发 | 进程入口、依赖反转组合根、命令分发 | `startup::run()` | 唯一允许跨层 wiring 的层，隔离进程启动与业务 | [CLI 入口](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/01-cli-entry) |
| Agent 运行时 | turn 循环、流式、中断、压缩 | `run_turn_streaming_mpsc()` | 编码 agent 的核心循环，自成一域 | [Agent 运行时](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/02-agent-runtime) |
| Server 与 Swarm | daemon、多会话、Plan DAG、热重载 | `Server::run()` | 多会话与多 agent 协作是独立复杂域 | [Server 与 Swarm](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/03-server-swarm) |
| Provider 多模型 | LLM 路由、failover、模型目录 | `complete_with_failover()` | provider 适配与 failover 策略自成一域 | [Provider 多模型](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/04-provider) |
| Memory 记忆系统 | hybrid 检索、consensus rerank、提取 | `process_context()` | passive 记忆是 jcode 智能化的核心差异化 | [Memory 记忆](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/05-memory) |
| Tool 工具系统 | 30+ 工具、destructive gate、MCP 池 | `Registry::execute()` | 工具执行与安全门控独立于 agent 循环 | [Tool 系统](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/06-tool-system) |
| TUI 渲染引擎 | 终端 UI、StreamBuffer、InfoWidget、SSH | `App::run_remote()` | 渲染管线与帧调度独立于业务逻辑 | [TUI 引擎](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/07-tui-engine) |
| Ambient 后台 | 调度、memory gardening、proactive | `AmbientRunnerHandle::run_loop()` | 后台整合是独立运行模式 | [Ambient 后台](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/08-ambient) |
| Config 与基础设施 | 配置热重载、session journal、Bus、压缩 | `config()` / `Bus::global()` | 被所有模块依赖的底座 | [Config 基础设施](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/09-config-infra) |
| Harness API 与 SDK | NDJSON 稳定协议、双语言 SDK、ACP | `run_bridge_stream()` | 公开边界与内部协议分离，独立演进 | [Harness API](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/10-harness-api-sdk) |

---

## 运行时行为

### 启动流程

```
main()                                    src/main.rs:81
  ├─ Windows：8 MiB 专用线程（STATUS_STACK_OVERFLOW 防护）
  ├─ configure_system_allocator()         jemalloc malloc_conf / glibc mallopt
  ├─ 三条 pre-Tokio multicall 拦截        热键监听 / launch hint / 通知 broker
  ├─ rustls crypto provider + tokio runtime
  └─ jcode::run()                         src/lib.rs:29
       └─ cli::startup::run()            src/cli/startup.rs:18
            ├─ Args::parse() 先于一切副作用（--help 不创建 telemetry 状态）
            ├─ 依赖反转注册（6 类 register_*）   ← 组合根
            │    ├─ register_external_provider_runtimes()   9 provider 工厂
            │    ├─ register_api_key_fallback_resolver()     auth 凭据
            │    ├─ register_permission_notifier()           safety → notifications
            │    ├─ register_synthetic_entry_provider()     memory → skill
            │    ├─ session_list_cache::register_invalidator()
            │    └─ register_default_server_spawner()        tui → cli
            ├─ parse_and_prepare_args() / spawn_background_update_check()
            └─ dispatch::run_main(args)
                 ├─ Command::Serve → Server::new_with_name(provider).run()
                 │    ├─ load_persisted_swarm_runtime_state()   崩溃恢复
                 │    ├─ monitor_bus() / ambient runner / MCP 池
                 │    ├─ accept loop → handle_client() 每连接一 task
                 │    └─ 全部客户端断开 5 分钟空闲超时 → exit(44)
                 └─ None → run_default_command() → spawn_server() → run_tui_client()
```

对象装配的关键在依赖反转注册：base 层的 `provider::external` 模块持有进程级 `OnceLock<RwLock<HashMap<&str, Factory>>>`，`register_external_provider_runtimes`（`startup.rs:204`）注入 9 个 provider 工厂（6 个零参 + OpenRouter 参数化 4-spec + OpenAI/Copilot 可失败）。spawn server 时 `Server::new_with_name` 还会 `set_active_provider` 全局注册 live provider——否则 memory sidecar 只在 OpenAI/Claude OAuth 下可用，Copilot/Gemini 等会静默降级。TUI 默认是**纯远程客户端**：`run_default_command` 先确保 daemon 存在（无则 detached spawn `jcode serve`，子进程设 `JCODE_DEFERRED_AUTH_BOOTSTRAP=1` 以支持 TUI 内 `/login`），再 `run_tui_client` 走 socket。

### 核心运行流程

jcode 运行时有三条最核心的业务链路：交互式 TUI 对话、工具执行循环、swarm 文件冲突通知。

#### 交互对话：TUI → Server → Agent → Provider

业务流程：用户输入 → TUI 序列化 Request::Message → socket 传输 → Server 分发 → Agent turn 循环 → Provider 流式 → StreamEvent 转 ServerEvent → 回写 TUI → 渲染。

![端到端请求数据流](/vibe-reading/images/articles/jcode-codewiki-0840/data-flow.svg)

文字描述：TUI 的 `send_message_with_images_reminder_and_skill()`（`backend.rs:598`）把用户输入序列化为 `Request::Message` JSON 行写入 socket。Server 的 accept loop（`runtime.rs:156`）spawn 每连接 task，`handle_client()`（`client_lifecycle.rs:435`）解码请求后 `tokio::spawn` `process_message_streaming_mpsc`——该 task 持有 `Arc<Mutex<Agent>>`（整个 turn 期间持锁）和 fanout mpsc。Agent 的 `run_once_streaming_mpsc()`（`turn_execution.rs:48`）追加用户消息后进入 `run_turn_streaming_mpsc` 循环：构建 messages + tools + split prompt → `provider.complete_split()` 返回 `EventStream<StreamEvent>` → 逐事件转译 `ServerEvent` 回写 → 若有 tool_calls 执行后继续循环。数据类型在边界变化：`String` → `Request::Message`（wire JSON）→ `&[Message]` + `&[ToolDefinition]`（provider 输入）→ `EventStream<StreamEvent>` → `ServerEvent`（wire JSON）→ StreamBuffer ops → ratatui Buffer。取消与软中断不走 agent 锁——`SessionControlHandle` 的 lock-free `InterruptSignal` 注册在 `shutdown_signals` map，客户端 Esc 才能 turn 进行中立即生效。

#### 工具执行：Registry → Tool → Safety

Agent turn 循环中 provider 产出 `ToolCall` 后，`Registry::execute()`（`tool/mod.rs:766`）执行完整安全管线：`inflight` RAII 标记（防 missing-output 修复误判进行中工具）→ `SessionToolPolicy` 白名单 → 未知工具恢复（Levenshtein "Did you mean"）→ `pre_tool` hook → `tool.execute(input, ctx)` → telemetry + `post_tool` hook → `guard_context_overflow` 裁剪。bash 工具额外经 `destructive_command_refusal()`（`bash_destructive_gate.rs`）两阶段门控：Stage 1 blast-radius 确定性评估（`/`、`$HOME`、`~/.ssh` 等 Catastrophic 目标直接 Deny）→ Stage 2 justification 反思（≥25 字符实质说明，盲重试必再败）。工具输出超 90% context budget 默认**拒绝而非截断**——拒绝只花几十 token 并给出收窄建议，模型可用 `accept_large_output: true` 明确付费重试。

#### Swarm 协作：文件冲突双向通知

Agent 工具调用 edit/write 时 `Bus::global().publish(BusEvent::FileTouch)`。Server 的 bus monitor（`server.rs:1957` `monitor_bus`）消费事件 → `FileTouchService` 双索引记录（path→accesses 前向 + session_id→paths 反向，30 分钟过期）→ 仅 `op.is_modification()` 时调 `latest_peer_touches()` 查同 swarm 其他 session 是否动过该文件 → **双向通知**：修改者得知之前谁动过，之前的修改者得知有人刚动了。通知经 `queue_soft_interrupt_for_session()`（三级 fallback：注册表 queue → agent.try_lock → 磁盘持久化延迟投递）注入软中断，agent 在安全点看到。这是 swarm 的核心价值——多 agent 同仓库协作时自动检测冲突，乐观无锁，冲突靠 DM 沟通解决。

### 状态流

![状态流转](/vibe-reading/images/articles/jcode-codewiki-0840/state-flow.svg)

Swarm 成员状态机（左）：`Spawning`（`spawn_swarm_agent()` in `comm_session.rs:574`）→ `Ready`（注册到 SwarmState）→ `Running`（agent turn 执行）→ terminal（`Completed`/`Failed`/`Stopped`）。terminal 状态由 `prune_expired_terminal_swarm_members()`（24h）和 `reap_idle_spawned_workers()`（30min）GC 回收。会话状态（右）：`Active`（有活跃 client）→ `Idle`（client 断开但 session 保留）→ `Crashed`（`detect_crash()` in `session.rs:1075` 检查 `last_pid` 存活）→ `Resumed`（`--resume`）或 `Closed`（journal 持久化）。相关代码：`SwarmMember.status` 在 `state.rs:188`，状态转换在 `swarm.rs:1291 update_member_status`；crash 恢复建 `session_recovery_<id>` 新会话只保留 Text block。

---

## 典型修改场景

#### 场景 1：新增一个 Provider runtime

独立协议路径：新建 `crates/jcode-provider-xxx-runtime/`（依赖 `jcode-base` 时必须 `default-features = false`），实现 `Provider` trait；在 `crates/jcode-base/src/provider/external.rs` 加 runtime key 常量；在 `src/cli/startup.rs:204` 的 `register_external_provider_runtimes` 注册工厂（凭据可能缺失用 `register_external_provider_fallible`）。若要进 failover 链还需改 `jcode-provider-core/src/selection.rs` 的 `ActiveProvider` enum。**OpenAI 兼容协议零新 crate**：在 `jcode-provider-metadata/src/catalog.rs` 加一个 `pub const XXX_PROFILE: OpenAiCompatibleProfile` 即可（已有 42 个先例）。对应测试：`tests/provider_matrix.rs`、`src/cli/provider_init_tests.rs`。

#### 场景 2：新增一个 native 工具

在 `crates/jcode-app-core/src/tool/` 下新建 `xxx.rs`，实现 `Tool` trait 四要素（`to_definition()` 默认实现自动获得 intent 注入）；`tool/mod.rs` 顶部 `mod xxx;`；无状态工具进 `base_tools()` 的 OnceLock 缓存，需要 session 级依赖（registry/compaction/skills）进 `Registry::new()` per-session 段（需 registry 自身则经 `registry.downgrade()` 拿 `WeakRegistry` 防 Arc 环）。模型可能用旧名调用 → 在 `jcode-tool-types/src/lib.rs::resolve_tool_name()` 加别名映射。对应测试：`tool/*_tests.rs`。

#### 场景 3：新增 BusEvent 变体

`crates/jcode-base/src/bus.rs` 定义 payload struct + `BusEvent` 变体（`bus.rs:395`）→ 发布方 `Bus::global().publish()` → 订阅方 match 加臂。注意 broadcast(256) 是 lossy（lagged），事件须可丢弃/可重建。若需到达远程客户端，还要在 `jcode-protocol/src/wire.rs` 的 `ServerEvent` 加 wire 变体并在服务端转译。对应测试：`bus.rs` 内联测试。

---

## 测试体系

```
tests/
├── provider_matrix.rs           # 多 provider 矩阵集成测试
├── context_window_matrix.rs    # 上下文窗口矩阵
├── auth_login_flow.rs           # OAuth 登录端到端
├── e2e/                         # 15 个端到端测试（mock_provider / reload_multiclient / disconnect / safety / burst_spawn）
├── fixtures/                    # 测试夹具
└── test_*.py                    # 注入/自修复/登录 Python 脚本
```

| 代码层 | 测试类型 | 位置 |
|--------|---------|------|
| Provider 适配 | 集成矩阵 | `tests/provider_matrix.rs` |
| Agent turn / Tool | 内联单元 | `agent_tests.rs`、`tool/*_tests.rs`（122 个 `*_tests.rs` 与源码平级） |
| Server / Swarm | 内联集成 | `server/*_tests.rs`、`client_lifecycle_tests.rs` |
| TUI 渲染 | 快照 + 内联 | `tui/ui_tests/`、`app/tests/` |
| SDK parity | 双向守卫 | Rust `sdk_tests/parity.rs` ↔ TS `schema-parity.test.ts` 互读对方源码 |
| 协议 schema | 快照 | `harness_api_tests/schema_snapshot.rs` 钉死精确 JSON |

jcode 的测试以 crate 内联测试为主（`*_tests.rs` 与源码平级），`tests/` 目录持有跨 crate 集成测试。想理解某个模块，优先读对应的 `*_tests.rs`——它们是可执行文档。

---

## 阅读源码推荐路线

- **第一遍：理解启动与主流程**
  `src/main.rs`（allocator + multicall 拦截）→ `src/lib.rs`（三层 re-export）→ `src/cli/startup.rs` 的 `run()`（组合根注册顺序）→ `src/cli/dispatch.rs` 的 `run_main()` → `crates/jcode-app-core/src/server/client_lifecycle.rs` 的 `handle_client()`（接受连接）→ `crates/jcode-app-core/src/agent/turn_execution.rs` 的 `run_once_streaming_mpsc()`（turn 入口）

- **第二遍：理解 Agent turn 循环**
  `crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs` 的 `run_turn_streaming_mpsc()`（循环主体）→ `agent/interrupts.rs`（soft interrupt 注入点 B/C/D）→ `agent/prompting.rs`（system prompt static/dynamic split）→ `agent/turn_loops.rs` 头部（重试常量与 batch nudge）→ `agent/response_recovery.rs`（空响应/截断恢复）

- **第三遍：理解多模型与记忆**
  `crates/jcode-base/src/provider/mod.rs` 的 `complete_with_failover()`（609 行）→ `jcode-provider-core/src/failover.rs`（错误分类）→ `jcode-provider-core/src/attempt_tracker.rs`（重试回滚）→ `crates/jcode-base/src/memory_agent.rs` 的 `process_context()`（488 行起，完整召回 pipeline）→ `memory.rs` 的 `hybrid_fuse()`（RRF 融合）→ `memory_rerank.rs`（consensus listwise rerank）

- **第四遍：选择重点模块深入阅读**（模块文档）
  Server/Swarm 的文件冲突通知（`server.rs:1957` monitor_bus）→ Tool 的 destructive gate（`tool/bash_destructive_gate.rs`）→ TUI 的 StreamBuffer（`jcode-tui-core/src/stream_buffer.rs`）→ Ambient 的调度器（`ambient/scheduler.rs`，注意 adaptive headroom 未接线的现状）→ Harness API 的 NDJSON 帧（`jcode-harness-api/src/client.rs`）

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| harness | 驱动 LLM 自主完成任务的"外壳"框架，管理 tool 执行、上下文、记忆 |
| turn | agent 的一次完整循环：provider 请求 → 流式响应 → 工具执行 → 中断检查 |
| passive memory | 不作为 tool 暴露，每轮自动检索注入对话的记忆系统 |
| swarm | 多 agent 在同一仓库协作，server 自动检测文件冲突 |
| Plan DAG | swarm 共享任务图，`PlanItem.blocked_by` 依赖边驱动调度（agent-first 的演进方向） |
| ambient | 后台自主模式，像睡眠时整理记忆一样做 memory gardening + proactive work |
| self-dev | agent 修改 jcode 自身源码并热重载（exec 替换进程）的开发模式 |
| prewarm | provider 传输层预热（如 OpenAI WebSocket `generate:false` 建连），用户输入前完成 |
| split prompt | system prompt 拆 static（可缓存）/ dynamic（每轮变）两段，保 KV cache 命中 |
| soft interrupt | 注入到 turn 安全点的用户消息，不打断当前流（区别于硬 Cancel） |
| multicall | 同一 universal binary 按 argv/硬链名充当不同进程（BusyBox 模式） |
| deferred MCP | 只暴露 `mcp_search` + `mcp_call` 固定面，避免大工具目录挤占上下文 |

### 参考资料

- [jcode.sh/docs](https://jcode.sh/docs) — 官方文档站
- [jcode.sh/bench](https://jcode.sh/bench) — benchmark 方法论与结果
- [Server Architecture](https://github.com/1jehuang/jcode/blob/master/docs/SERVER_ARCHITECTURE.md)
- [Swarm Task Graph（DAG-first）](https://github.com/1jehuang/jcode/blob/master/docs/SWARM_TASK_GRAPH.md)
- [Memory Architecture](https://github.com/1jehuang/jcode/blob/master/docs/MEMORY_ARCHITECTURE.md)
- [Ambient Mode](https://github.com/1jehuang/jcode/blob/master/docs/AMBIENT_MODE.md)
- [Crate Ownership Boundaries](https://github.com/1jehuang/jcode/blob/master/docs/CRATE_OWNERSHIP_BOUNDARIES.md)
- [OpenAI WebSocket](https://github.com/1jehuang/jcode/blob/master/docs/OPENAI_WEBSOCKET.md)
- [Native SSH](https://github.com/1jehuang/jcode/blob/master/docs/NATIVE_SSH.md)
- [mermaid-rs-renderer](https://github.com/1jehuang/mermaid-rs-renderer) — 纯 Rust mermaid 渲染库
- 本博客先前解读：[jcode v0.77.1 源码解读](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)
