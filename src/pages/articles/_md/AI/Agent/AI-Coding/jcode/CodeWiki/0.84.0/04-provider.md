---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Provider 多模型"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "AI Coding", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "Provider", "Failover", "WebSocket", "Prewarm", "模型目录"]
description: "jcode Provider 多模型——Provider trait、两级 failover（账号级→跨 provider）、8 槽位 + 42 内置 profile、三层模型目录、OpenAI WebSocket v2 预热、split prompt 缓存"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

Provider 子系统是 jcode 接入 LLM 的全部表面：一个 `Provider` trait + 9 个 runtime 叶子 crate + base 的编排层（`MultiProvider` failover 调度、模型目录、路由构建）+ 42 个内置 OpenAI-compatible profile。它自成一域的原因：provider 适配是 IO 密集、协议各异（SSE/WebSocket/CLI 子进程）、且必须支持运行时切换和故障转移的独立复杂度——与 agent 循环、UI 完全正交。

---

## 模块架构

```
jcode-provider-core           纯逻辑层：Provider trait、failover 分类、定价（无 IO）
jcode-provider-metadata       42 个内置 OpenAI-compatible profile 静态定义
jcode-provider-*-runtime ×9   具体 Provider 实现（base 下游，编译隔离）
jcode-base/src/provider/      编排层：MultiProvider、模型目录、路由构建、image clamp
src/cli/startup.rs            组合根：工厂闭包注册
```

`Provider` trait（`jcode-provider-core/src/lib.rs:76`）必须实现的只有三个：`complete()`（流式补全，返回 `EventStream = Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>`）、`name()`（机器稳定标识，计费/路由 key）、`fork()`（克隆独立可变状态——compaction、sidecar、resume 都用 fork 而非共享）。关键 default 方法：`prewarm()`（前台补全前的预热钩子，文档注释明确约束**不得携带用户输入、不得阻塞等待网络 warmup**）、`complete_split()`（static/dynamic 分离 system prompt）、`active_resolved_credential()`（"订阅还是 API 计费"的权威答案，服务端解析后随 wire 发给远程客户端）、`set_route_selection()`（结构化路由选择）。

`ActiveProvider` enum（`selection.rs:5`）共 8 个槽位：`Claude, OpenAI, Copilot, Antigravity, Gemini, Cursor, Bedrock, OpenRouter`。42 个 OpenAI-compatible profile（DeepSeek/Groq/Cerebras/Moonshot/NVIDIA NIM/Mistral/Together/Ollama/LM Studio/xAI...）与 config 自定义 NamedProfile 全部复用 `OpenRouterProvider` 一个 wire-protocol 实现，但经 `RuntimeKey::OpenAiCompatible{profile_id}` 保持独立 runtime 身份——OpenRouter 和 NVIDIA NIM 都说 OpenAI 兼容协议，但 endpoint/auth/catalog/路由语义不同。

---

## 调用链路

```
MultiProvider::complete_split() [mod.rs:1756]
  └─ complete_with_failover() [mod.rs:609]
       ├─ image 适配：clamp_outbound_images（#381 超 2000px 降采样）
       ├─ fallback_sequence(active)     Claude → [Claude, OpenAI, Copilot, Gemini, Cursor, Bedrock, OpenRouter]
       ├─ 逐 candidate：未配置 skip → 用量耗尽 skip → dispatch 失败 → classify_failover_error
       │    ├─ should_failover = false 的错误直接透传用户（不吞业务错误）
       │    └─ active 之外候选失败：立即以 ProviderFailoverPrompt 返回（不自动轮询第二个备选）
       └─ 成功切换：set_active_provider + "⚡ Auto-fallback" 通知
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `complete_with_failover()` in `mod.rs:609` | failover 主循环 | 备选失败即返回待确认，不自动连跳 |
| `try_same_provider_account_failover()` in `multi_provider.rs` | 同 provider 换账号 | 仅 Claude/OpenAI，按用量比率升序候选 |
| `fallback_sequence()` in `selection.rs:314` | 有序候选表 | Antigravity 只出现在 Copilot 链第二位之后 |
| `pick_next_fallback_route_with_options()` in `fallback_pick.rs:108` | 模型级兜底 | 三层：换 auth method > 换模型 > 跨 provider |
| `track_attempt_output()` in `attempt_tracker.rs` | 重试回滚 | 已流出部分输出时发 `StreamEvent::RetryRollback` 防重复 |
| `build_system_param_split()` in `anthropic/src/lib.rs:668` | split system 块 | static 块打 `cache_control: ephemeral` |
| `take_ready()` in `openai_websocket_prewarm.rs:178` | 采纳预热 socket | 全部请求设置必须匹配 + 年龄 < TTL |

</details>

---

## 核心实现

### 两级 failover

**第一级（同 provider 账号）**：`try_same_provider_account_failover`（`multi_provider.rs`），仅当 `same_provider_account_failover_enabled` 且 active 是 Claude/OpenAI。候选来自 `/usage` 探针中未耗尽账号（按 5h/7d 用量比率升序）——"第一个 ChatGPT Pro 订阅没 token 了？`/account` 切第二个"的自动版。

**第二级（跨 provider）**：`fallback_sequence(active)` 给出以 active 开头的有序候选表。关键设计（`mod.rs:644`）：active provider 之外的候选若在尝试时失败，**立即以 `ProviderFailoverPrompt` 结构化错误返回而不是继续轮询**——错误消息第一行是 `PROVIDER_FAILOVER_PROMPT_PREFIX = "[jcode-provider-failover]"` + JSON payload（`to_error_message` in `failover.rs`），第二行是人话："switching to X would resend about N input tokens"，让上层（agent loop）显式确认后再切（用户可能不想为一个请求花几十万 token 重发）；`parse_failover_prompt_message` 只取首行、strip 前缀后 serde 还原结构体，跨进程无损传递切换意图。

**错误分类**：`classify_failover_error_message`（`failover.rs`）输出两档 `FailoverDecision`——`RetryNextProvider`（413/context-length 类：payload 太大换 provider 也救不了，不标记当前 provider 不可用）vs `RetryAndMarkUnavailable`（429/402 限流配额与 auth 类：把当前 provider 记入不可用）。分类的三个关键字匹配有优先级：request_size_or_context 先于 rate_or_quota 先于 auth_or_access；`contains_independent_status_code` 要求状态码前后不是 ASCII 数字（防 "4130" 误判）。不可 failover 的错误（如内容策略拒绝）直接透传，不吞业务错误。

**重试退避与传输**：`retry_backoff_delay`（`attempt_tracker.rs:121`）——`base_ms * (1 << min(attempt-1, 16))` 再乘 0.8..1.2 随机抖动（防相关故障时所有会话同步重试），位移上限 16。瞬态传输故障重试时用 `fresh_transport_client()`（`lib.rs:660`，`pool_max_idle_per_host(0)`——全新 TCP+TLS 连接）而非共享单例（`shared_http_client`，idle 8/host + 90s 超时）：复用共享池可能命中同一条经损坏网络路径的空闲连接（如 TLS BadRecordMac），重试同样失败。

**默认选择**：`auto_default_provider`（`selection.rs:44`）优先级 copilot_premium_zero → Claude → OpenAI → Copilot → Antigravity → Gemini → Cursor → Bedrock → OpenRouter，全部不可用时兜底 Claude。

**重试安全**：`attempt_tracker.rs::track_attempt_output` 包裹外层 sender 记录是否有 replay-visible 事件流出，重试前发 `StreamEvent::RetryRollback` 让消费者丢弃部分输出——否则重试会重复已显示内容。Claude CLI 路径例外（它 mid-stream 执行工具），保留 no-retry-after-output 守卫。

### 三层模型目录

- **静态表**（`jcode-provider-core/src/models.rs`）：`ALL_CLAUDE_MODELS` 等人工审校表 + `context_limit_for_model_with_provider`。base 的 `models.rs`（1178 行）在其上做**按账号 scope 的动态合并**（`provider_runtime_scope_key` 如 `claude:oauth:work`，静态 + live catalog + 磁盘缓存三路 merge）
- **运行时状态机**（`model_catalog_service.rs`）：per-scope 目录 + `record_runtime_model_unavailable`（账号级模型不可用记录）+ single-flight refresh
- **路由构建**（`catalog_routes.rs`，1688 行）：`simplified_model_routes_for_picker` 把模型列表变成统一 picker 的 `Vec<ModelRoute>`——OpenAI 模型可同时产出 oauth 和 api-key 两条路由；每条附 `RouteCheapnessEstimate`（25k input + 5k output 计价，billing_kind 分 Metered/Subscription/IncludedQuota）

刷新调度是 `catalog_scheduler.rs`：历史上刷新是"渲染 route 的副作用"（每次 route 构建 fan out 几十个请求），现在拆成**route 构建纯函数化（只读缓存不做 IO）+ 进程级 sweeper**（60s 周期、只刷 stale≥15min 或 missing 的缓存）。目录变化经 `bump_catalog_generation()` 使 memo 失效。

### OpenAI WebSocket v2 预热

`jcode-provider-openai-runtime/src/openai_websocket_prewarm.rs`：每个新 socket 带 `OpenAI-Beta: responses_websockets=2026-02-06` 头选 v2 协议。**预热请求**从真实请求拷贝全部设置（model/instructions/tools/reasoning/service_tier/cache policy），但删掉 `input/stream`，强制 `generate: false`、`input: []`、`store: false`——服务器返回已完成的 response ID 但无模型输出。触发时机：agent 的 `prewarm` 钩子在"idle 客户端订阅时"（用户打字时后台准备）和本地 turn 上下文准备前各试一次。常量：`PREWARM_TIMEOUT = 5s`、`PREWARM_TTL = 30s`。真实请求时 `PrewarmSlot::take_ready` 校验全部设置匹配才采纳；前台**不等待**未完成的 warmup（直接取消）。warm socket 上首轮发全量 input，此后每轮 `previous_response_id` 只发增量 item（`openai_stream_runtime.rs:523`，剔除 `rs_*` reasoning item 防 "Duplicate item" 拒绝）。

安全约束都有实现对应：warmup 不执行工具不产生输出；fork 不继承父的 warmup socket（`PrewarmJob::drop` → `task.abort()`）；**过期凭据跳过 warmup 且投机路径绝不轮换 OAuth refresh token**（取消后可能丢失服务器已轮换的新凭据）——凭据余量检查为 `expires_at` 至少还有 300 秒（5 分钟，`openai_websocket_prewarm.rs:122`），否则跳过预热。

### stream idle timeout：按 reasoning effort 缩放

`stream_timeout.rs` 解决 issue #434——高 effort 模型静默思考数分钟后才吐 token，固定超时会被误判死连接。base 预算来自 `[provider] stream_idle_timeout_secs`（默认 180s），按 effort 缩放：high×2、xhigh×3、max/swarm/swarm-deep×`MAX_STREAM_IDLE_TIMEOUT_MULTIPLIER = 4`。所有 streaming provider 共享此 helper。

### ProviderState：Config + AuthStatus facade

`ProviderState`（`state.rs:13`）把 `Config + AuthStatus` 组合成统一视图——`default_provider_key`/`default_model` 从 config.toml 的 `[provider]` 段与认证状态合并解析，provider 层其余代码不直接碰 config/auth。`MultiProvider::new_with_auth_status` 在构造时 probe 各 provider 凭据决定哪些槽实例化；`on_auth_changed` 后 `spawn_post_auth_model_refresh` 重新 `prefetch_models`（`post_auth_refreshes_pending` 原子计数供查询刷新是否仍在途）。

### split prompt 为什么提升缓存

Anthropic 路径（`build_system_param_split`）：system 拆多个 `ApiSystemBlock`，**static 块（指令文件、base prompt、skills）带 `cache_control: ephemeral`，dynamic 块（日期、git status、memory）不带**。Anthropic prompt cache 是前缀匹配——dynamic 混进 static 前面会让每轮日期变化打掉整个前缀；分离后 static 前缀字节级稳定，跨轮命中 cache read（约正常 input 价格的 10%）。不支持 split 结构的 provider 走 trait 默认 `complete_split`：dynamic 上下文作为独立消息插在**最后一条 fresh user 消息之后**——位置在尾部，历史前缀仍不变。

---

## 模块间交互

向上被 Agent 的 `complete_split` 消费（`EventStream` 进程内异步流）；`MultiProvider` 构造点在 startup / post-auth / TUI onboarding（经组合根注册的工厂实例化，base 不命名下游类型）。runtime crate 对 `jcode-base` 必须声明 `default-features = false`——否则 feature unification 会重新打开 base 的重 feature（embeddings/bedrock/tract-linalg），破坏 Windows ARM64 release 目标。memory sidecar 经 `set_active_provider` 全局注册复用 active provider。

---

## 扩展方式

**OpenAI 兼容 provider 零新 crate**：在 `jcode-provider-metadata/src/catalog.rs` 加一个 `pub const XXX_PROFILE: OpenAiCompatibleProfile`（id/api_base/env_file/default_model/setup_url）并加进 `openai_compatible_profiles()` 列表。**独立协议 provider**：新建 `crates/jcode-provider-xxx-runtime/`（依赖 base 时 `default-features = false`），实现 `Provider` trait，在 `src/cli/startup.rs:204` 注册工厂；要进 failover 链则改 `ActiveProvider` enum（成本较高——所有 match 分支）+ `dispatch.rs` 分发臂 + `MultiProvider` 槽位。对应测试：`tests/provider_matrix.rs`、`provider_init_tests.rs`。
