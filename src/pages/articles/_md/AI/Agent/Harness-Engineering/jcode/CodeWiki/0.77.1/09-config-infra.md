---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Config 与基础设施"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Config", "Bus", "Session", "Safety", "持久化"]
description: "jcode Config 与基础设施——配置热重载回调链、Bus 事件总线、session journal+.bak 双重恢复、safety 依赖反转、registry"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

Config 与基础设施是 jcode 的底座——被所有上层模块依赖。它管理配置热重载、会话持久化、进程级事件总线、安全权限、存储、注册表。模块位于 `crates/jcode-base/src/` 的 `config.rs`/`session.rs`/`bus.rs`/`storage.rs`/`safety.rs`/`registry.rs`/`platform.rs`/`hooks.rs`。设计核心是**零向上依赖**——config 不直接调用 auth/bus，而是通过回调让上层自行注册反应。

---

## 模块架构

- **config.rs** — `Config` 聚合结构 + 热重载缓存 + `on_config_reloaded` 回调
- **session.rs + session/** — `Session` 状态 + `persistence.rs`(journal/snapshot) + `journal.rs`
- **bus.rs** — `Bus` 全局事件总线 + `BusEvent`（30+ 变体）
- **storage.rs** — `read_json`/`write_json_fast` + 自动 `.bak` 恢复
- **safety.rs** — `SafetySystem` + `register_permission_notifier` 依赖反转
- **registry.rs** — `ServerRegistry`（`~/.jcode/servers.json`）
- **platform.rs** — 平台适配（nofile limit / power inhibit）
- **hooks.rs** — pre/post tool hook
- **cache_tracker.rs / cache_invalidation.rs** — KV cache 追踪与失效

`Config`（`config.rs:466`）是聚合结构，含 `keybindings`/`dictation`/`display`/`features`/`websearch`/`tools`/`auth`/`provider` 等子配置，通过 `jcode-config-types` crate re-export 类型，`#[serde(default)]` 保证向后兼容。

---

## 调用链路

### 配置加载与热重载

```
config() 调用 (config.rs:259)
  ├─ 检查 CONFIG_CACHE (RwLock) + 500ms 节流
  ├─ ConfigCacheFingerprint::current()  文件 mtime/len + 180+ JCODE_* env 指纹
  ├─ 指纹变化? ──Yes──→ leak_config(Config::load())  重新加载 TOML + env override
  │                      ├─ cache_invalidation::record("config reload")
  │                      ├─ notify_config_reloaded()
  │                      │    ├─ CONFIG_RELOAD_GENERATION.fetch_add(1)
  │                      │    └─ 遍历 CONFIG_RELOAD_LISTENERS → 逐个调用 fn()
  │                      └─ provider::populate_context_limits_from_config()
  └─ No → 返回缓存的 &'static Config
```

### 会话持久化与恢复

```
写入: Session.save()
  ├─ checkpoint_snapshot()  persistence.rs:188
  │    ├─ guard_snapshot_shrink()  拒绝空覆盖非空 + .bak 备份
  │    ├─ write_json_fast(snapshot_path, self)
  │    └─ 删除 journal 文件 (重置增量)
  └─ 或 append journal entry (增量模式)

恢复: Session::load_from_path()  persistence.rs:232
  ├─ read_json(snapshot_path)  主快照 (含 .bak 恢复)
  ├─ replay_journal_lines(journal_path)
  │    ├─ 逐行 serde_json::from_str
  │    ├─ 损坏行 → salvage_glued_journal_entries()  修复撕裂写入
  │    └─ 跳过坏行继续重放
  └─ 若有损坏 → schedule_checkpoint_after_corrupt_journal()
```

### 事件总线

```
Server/Agent/Provider ──publish()──→ Bus::global() (broadcast::channel(256))
                                       │
                            ┌──────────┴──────────┐
                       TUI subscribe()      Server subscribe()
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `config()` | 获取配置（带缓存） | 500ms 节流 + 指纹缓存 |
| `on_config_reloaded(fn())` | 注册重载回调 | 裸函数指针，零向上依赖 |
| `Bus::global()` | 事件总线单例 | broadcast channel(256) |
| `publish_models_updated()` | 模型列表更新 | 750ms 去抖 |
| `checkpoint_snapshot()` | 会话全量快照 | 拒绝空覆盖非空 + .bak |
| `replay_journal_lines()` | journal 重放 | salvage 撕裂写入 |
| `register_permission_notifier()` | safety 依赖反转 | safety 不依赖 notifications |

---

## 核心实现

### 配置热重载回调链

config 是最底层基础模块，若直接调用 auth/bus 会产生循环依赖。通过 `on_config_reloaded(fn())`（`config.rs:456`）让上层在启动时注册反应，保持 config 零向上依赖。回调类型为裸函数指针 `fn()`（非闭包），确保注册安全且无分配。`startup.rs` 中注册了三个回调：`sync_output_style_from_config`、`AuthStatus::invalidate_cache`、`Bus::global().publish_models_updated`。

`ConfigCacheFingerprint`（`config.rs:190`）不仅检查文件 mtime/len，还跟踪 180+ 个 `JCODE_*` 环境变量指纹——env 变化也触发重载。加载后 re-fingerprint 避免 env 自传播（如 `copilot_premium → JCODE_COPILOT_PREMIUM`）导致的假重载。

### Bus 全局事件总线

`Bus::global()`（`bus.rs:502`）用 `OnceLock` 单例化，`broadcast::channel(256)` 提供 fan-out。`BusEvent`（`bus.rs:395`）30+ 变体：`ToolUpdated`/`TodoUpdated`/`FileTouch`/`BackgroundTaskCompleted`/`LoginCompleted`/`ModelsUpdated`/`CompactionFinished`/`SidePanelUpdated`/`MermaidRenderCompleted` 等。

`publish_models_updated()` 带 750ms 去抖（`MODELS_UPDATED_DEBOUNCE`），避免频繁 catalog 刷新淹没订阅者。还联动 `provider::catalog_scheduler::bump_catalog_generation()`。测试用 `new_isolated_for_tests()` 避免全局 bus 竞态。

### Session Journal + .bak 双重恢复

journal 是 append-only JSONL。`replay_journal_lines`（`persistence.rs:76`）损坏行不截断，而是 `salvage_glued_journal_entries` 尝试从撕裂写入中恢复完整条目（搜索 `{"meta":` 起始标记流式解析）。`checkpoint_snapshot` 硬拒绝空会话覆盖非空快照 + `.pre-wipe-*.bak` 备份。`schedule_checkpoint_after_corrupt_journal` 确保下次 save 全量重写。

`StreamingGuard`（`session.rs:16`）组合 storage 的流式标记 RAII + platform 的 `PowerAssertion`（防息屏）。

### Safety Permission Notifier 依赖反转

historical `safety → notifications` 依赖被反转：notifications 层（已依赖 safety 类型如 `AmbientTranscript`）在启动时注册 dispatcher，safety 不再需要构造 `NotificationDispatcher`：

```rust title="crates/jcode-base/src/safety.rs"
pub fn register_permission_notifier(f: impl Fn(&str, &str, &str) + Send + Sync + 'static)
```

`SafetySystem`（`safety.rs:150`）持有 `queue: Mutex<Vec<PermissionRequest>>`、`history`、`actions`。`request_permission()` 入队 + 持久化 + `dispatch_permission_notification()` 通知。`AUTO_ALLOWED`（`safety.rs:132`）Tier-1 只读动作名列表自动豁免权限请求。

### Storage 与 Registry

`storage.rs` 提供 `read_json`/`write_json_fast` 带自动 `.bak` 恢复（`StorageRecoveryEvent::CorruptPrimary → RecoveredFromBackup`）。

`ServerRegistry`（`registry.rs:49`）跟踪 `~/.jcode/servers.json` 运行中服务器，`cleanup_stale()` 两轮清理（PID 死亡 + socket 去重）。**不清理 socket 文件**（`registry.rs:124` 注释）——新 server 可能在 reboot/reload 后复用同一 socket。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 观察者 | `on_config_reloaded(fn())` | 配置重载通知，config 零向上依赖 |
| 事件总线 | `Bus::global()` broadcast(256) | 解耦 server/agent/provider/TUI |
| 注册表 | `ServerRegistry` servers.json | 跟踪运行中 server |
| 依赖反转 | `register_permission_notifier` | safety 不依赖 notifications |
| 策略 | `PersistVectorMode` Clean/Append/Full | 根据脏标记选择持久化策略 |
| RAII | `StreamingGuard` + `PowerAssertion` | 流式标记 + 防息屏 |

---

## 模块间交互

- **config** 被几乎所有模块依赖（`config()` 返回 `&'static Config`）。为避免循环依赖，config 不直接调用 auth/bus，而是通过 `on_config_reloaded` 回调。
- **bus** 连接 server（发布事件）、agent（ToolUpdated/FileTouch）、provider（LoginCompleted/ModelsUpdated）、TUI（订阅渲染）。
- **safety** 通过 `register_permission_notifier` 反转到 notifications 层。
- **storage** 提供带 `.bak` 恢复的 JSON 读写，被 session/config/registry 共用。
- **session** 的 `StreamingGuard` 组合 storage + platform。
- **cache_tracker** 追踪客户端 KV-cache 状态，`cache_invalidation` 记录失效原因。

---

## 扩展方式

**新增配置项**（如 `MemoryConfig`）：(1) 在 `jcode-config-types` 定义 struct + serde；(2) `config.rs:466` 的 `Config` 添加字段；(3) `CONFIG_ENV_KEYS`（`config.rs:30`）添加相关 `JCODE_*` 环境变量键；(4) 若需重载响应，在子系统启动时调 `on_config_reloaded(|| { ... })`。

**新增 BusEvent 变体**：(1) `bus.rs` 定义 payload struct；(2) `BusEvent` enum 添加变体；(3) 发布方 `Bus::global().publish(BusEvent::Xxx(...))`；(4) 订阅方 match 处理。

**新增安全权限动作**：(1) 若只读，在 `safety.rs:132` 的 `AUTO_ALLOWED` 加动作名自动豁免；(2) 若需权限，`classify()` 默认返回 `RequiresPermission`，无需改列表；(3) 通过 `register_permission_notifier` 管道自动触发通知。
