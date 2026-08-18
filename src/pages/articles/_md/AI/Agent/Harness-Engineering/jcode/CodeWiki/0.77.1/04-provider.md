---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Provider 多模型抽象"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Provider", "Failover", "多模型", "OAuth"]
description: "jcode Provider 多模型抽象——Provider trait、8 类 provider 槽、两级 failover、runtime 工厂注册、stream_idle_timeout、模型 catalog"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

Provider 模块是 jcode 多模型能力的核心——它定义了所有 LLM 后端的统一抽象，管理 8 类 provider 槽、两级 failover、30+ OAuth 登录流程。模块位于 `crates/jcode-base/src/provider/`（基础层）+ `jcode-provider-core`（trait 定义）+ 11 个 `jcode-provider-*-runtime` 叶子 crate。设计目标是让用户用已有的 OAuth 订阅或 API key，并在主 provider 故障时自动切换。

---

## 模块架构

- **jcode-provider-core** — `Provider` trait + `ActiveProvider` 枚举 + `failover` + `selection`
- **jcode-base/src/provider/** — `MultiProvider`（多槽管理）、`dispatch`（分发）、`routing`、`state`、`external`（runtime 注册表）、`pricing`、`stream_timeout`、`account_failover`
- **jcode-provider-*-runtime** — 11 个叶子 crate（anthropic/openai/gemini/copilot/bedrock/antigravity/cursor/openrouter/grok-build/claude-cli），各自实现 `Provider` trait

`MultiProvider` 持有 8 个 `RwLock<Option<Arc<dyn Provider>>>` 槽（anthropic/claude/openai/copilot/antigravity/gemini/cursor/bedrock/openrouter + openai_compatible_profiles map）。

---

## 调用链路

```
agent turn → MultiProvider::complete_with_failover()   mod.rs:609
  ├─ image_clamp 过滤/降采样
  ├─ active = self.active_provider()
  ├─ sequence = fallback_sequence(active)              core/selection.rs:314
  │
  for candidate in sequence:
  ├─ provider_is_configured? / unavailability_detail? / precheck?
  │    ↓ 不可用则 record + continue
  ├─ complete_on_provider / complete_split_on_provider  dispatch.rs:57
  │    └─ match ActiveProvider → 取对应 Arc<dyn Provider>
  │        → provider.complete(.await) → EventStream
  ├─ Ok(stream): clear_unavailable + record_activity
  │    └─ candidate != active 时 set_active + 通知
  │       return Ok(stream)
  └─ Err:
       classify_failover_error → FailoverDecision
       ├─ RetryAndMarkUnavailable: record_provider_unavailable
       ├─ 同 provider 多账号: try_same_provider_account_failover  multi_provider.rs:5
       ├─ active 且 candidate != active: 返回 ProviderFailoverPrompt（让 UI 提示用户一键切换）
       └─ decision=None: 返回原 err
  全部失败 → no_provider_available_error
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `complete_with_failover()` | failover 链执行 | 两级：同 provider 账号 → 跨 provider |
| `fallback_sequence()` | 生成优先级链 | Claude→OpenAI→Copilot→Gemini→... |
| `classify_failover_error_message()` | 错误分类 | 413/context→RetryNext；429/401→MarkUnavailable |
| `try_same_provider_account_failover()` | 同 provider 切账号 | 减少 disruptive 跨 provider 切换 |
| `stream_idle_timeout()` | 流式空闲超时 | 按 reasoning effort 缩放 |

---

## 核心实现

### Provider Trait

```rust title="crates/jcode-provider-core/src/lib.rs:75"
pub type EventStream = Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>;

#[async_trait]
pub trait Provider: Send + Sync {
    async fn complete(&self, messages: &[Message], tools: &[ToolDefinition],
        system: &str, resume_session_id: Option<&str>) -> Result<EventStream>;
    async fn complete_split(&self, messages, tools, system_static,
        system_dynamic, resume_session_id) -> Result<EventStream>;
    fn name(&self) -> &str;                    // "openrouter"/"claude"
    fn set_route_selection(&self, sel: &RouteSelection) -> Result<()>;
    fn model_routes(&self) -> Vec<ModelRoute>;
    fn active_resolved_credential(&self) -> Option<ResolvedCredential>;
    fn refresh_model_catalog(&self) -> Result<ModelCatalogRefreshSummary>;
    fn fork(&self) -> Arc<dyn Provider>;        // sidecar 独立实例
}
```

`complete_split` 把 system prompt 分为 static（可缓存）和 dynamic 两段——这是 prompt caching 的关键，static 段跨 turn 不变可命中 provider 端 KV cache。`fork` 让 sidecar 拿独立实例不干扰主 agent 的模型选择。

### 两级 Failover

第一级 `try_same_provider_account_failover`（`multi_provider.rs:5`）在同 provider 的多账号间切换（仅 Claude/OpenAI 支持，`MultiAccountProviderKind`）——切换时 `invalidate_provider_credentials_for_account_switch` 强制重载凭据。第二级跨 provider 走 `fallback_sequence`（`selection.rs:314`）。

跨 provider 时若 `candidate != active` 且已有 reason，**不自动重发**而是返回 `ProviderFailoverPrompt`（`core/failover.rs:17`）让 UI 提示用户一键确认——避免未经同意把 turn 发给另一个计费 provider。

错误分类由 `classify_failover_error_message`（`failover.rs:69`）按文本匹配：413/context 走 `RetryNextProvider`，429/401/403/quota 走 `RetryAndMarkUnavailable`。

### Runtime 工厂注册

每个 `jcode-provider-*-runtime` crate 的头注释都说明同一设计："moved out of `jcode-base` so provider edits compile only this crate plus a binary relink instead of rebuilding the base -> app-core -> tui spine"。runtime 实现移到 base 下游 crate，编辑 provider 只重编该 crate + binary relink。base 不能命名下游具体类型，故用 process-global 工厂注册：

```rust title="src/cli/startup.rs:183"
fn register_external_provider_runtimes() {
    crate::provider::external::register_external_provider(
        crate::provider::external::ANTHROPIC_RUNTIME,
        || Arc::new(AnthropicProvider::new()),
    );
    // ... 9 个 keyed factory + 1 个参数化 openrouter factory
}
```

`external.rs` 持有 `OnceLock<RwLock<HashMap<&str, Factory>>>`，base 通过 `instantiate_expected_external_provider` 拿 `Arc<dyn Provider>`。

### OpenRouter 槽多路复用

`ProviderRegistry`（`registry.rs:9`）让 `ActiveProvider::OpenRouter` 背后服务三种身份：real OpenRouter / direct OpenAI-compatible profile / named profile。`active_openrouter_execution`（`registry.rs:77`）优先返回 active compatible profile，回退 real openrouter。工厂用参数化 `OpenRouterRuntimeSpec`（`external.rs:51`）而非每身份一工厂。

### Stream Idle Timeout

`stream_idle_timeout`（`stream_timeout.rs:1`）base 预算来自 `[provider] stream_idle_timeout_secs`（默认 180s），按 reasoning effort 缩放：high×2、xhigh×3、max/swarm×4（`MAX_STREAM_IDLE_TIMEOUT_MULTIPLIER=4`）。解决 issue #434——高 effort 模型静默思考数分钟会被误判死连接。所有 streaming provider 共享此 helper。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略 + 多 provider 槽 | `MultiProvider` 8 槽 | 统一接口，运行时按 ActiveProvider 分发 |
| Failover 链（两级） | `multi_provider.rs:5` + `fallback_sequence` | 同 provider 账号先于跨 provider |
| Runtime 注册（组合根） | `external.rs` `OnceLock` | base 不命名下游类型 |
| OpenRouter 槽多路复用 | `ProviderRegistry` + `OpenRouterRuntimeSpec` | 三身份共用一槽 |
| Catalog 软刷新 | `OPENAI_COMPATIBLE_PROFILE_CATALOG_SOFT_REFRESH_SECS=15min` | stale 时返缓存同时后台刷 |
| Pricing memo + generation | `pricing.rs:9` AUTH_PRICING_GENERATION | 原子计数器即时失效 memo |

---

## 模块间交互

- **auth**：`MultiProvider::new_with_auth_status`（`startup.rs:85`）在构造时 probe 各 provider 凭据，决定哪些槽实例化。`on_auth_changed` 触发 `spawn_post_auth_model_refresh` 重新 `prefetch_models`。
- **config**：`ProviderState`（`state.rs:13`）是 `Config + AuthStatus` 的 facade，`default_provider_key`/`default_model` 统一解析 config.toml 的 `[provider]` 配置。
- **provider_catalog**：OpenAI-compatible profile 解析、命名 profile、catalog 磁盘缓存都委托给 `crate::provider_catalog`。
- **agent**：agent 调 `MultiProvider::complete` → `complete_with_failover`。

---

## 扩展方式

**新增 provider runtime**：(1) 新建 `crates/jcode-provider-xxx-runtime/`，实现 `Provider` trait；(2) `external.rs` 加 `pub const XXX_RUNTIME: &str`；(3) `startup.rs:183` 加 `register_external_provider`；(4) 若需新 `ActiveProvider` 变体，改 `selection.rs:4` enum + 所有 match 分支（成本高，通常复用 OpenRouter 槽或 OpenAI-compatible profile 更划算）；(5) `startup.rs:85` 加凭据 probe。

**修改 failover 策略**（如让 5xx 也触发）：改 `jcode-provider-core/src/failover.rs:69` 的 `classify_failover_error_message`，增加 `contains_independent_status_code(&lower, "500")` 分支返回 `RetryNextProvider`。跨 provider 优先级链改 `selection.rs:314` 的 `fallback_sequence`。
