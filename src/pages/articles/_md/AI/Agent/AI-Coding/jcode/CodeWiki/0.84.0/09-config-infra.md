---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Config 与基础设施"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "AI Coding", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "Config", "Session Journal", "Bus", "Compaction", "Skill"]
description: "jcode Config 与基础设施——config() 热重载（500ms 指纹节流 + leak 静态引用）、session journal/snapshot 双持久化（torn line 修复）、Bus broadcast(256)、三模式压缩管线、skill 分层、跨 provider 用量汇总"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

`jcode-base` 的底座模块群：config（全局访问 + 热重载）、session（journal/snapshot 双持久化 + crash 恢复）、Bus（进程内事件总线）、compaction（上下文压缩管线）、skill（技能注册）、storage（原子写 + active_pids）、usage（跨 provider 用量）、logging。它们被所有上层依赖，本身零向上依赖（反转点全部由组合根注册）。

---

## 模块架构

`jcode-base` 共 73 个 `pub mod`，底座核心分布：`config.rs` + `config/`（4 文件）、`session/`（9 文件）、`bus.rs`、`compaction.rs`（71.7K）+ `jcode-compaction-core`（纯函数层）、`skill.rs` + `skill/`、`storage/`（`jcode-storage` crate）、`usage/`（8 文件）、`jcode-logging`。契约在 `jcode-config-types`（TOML serde 全类型）。

---

## 调用链路

```
config() [config.rs]  每次调用都可能触发热重载
  ├─ 500ms 指纹节流（path + mtime + len + CONFIG_ENV_KEYS 值 hash）
  ├─ 变化 → leak_config(&'static Config) → 替换缓存
  ├─ notify_config_reloaded() → 3 个注册的回调（emoji 样式 / auth 缓存 / bus models）
  └─ populate_context_limits_from_config()   context_window 改动免重启生效

Session::save() [session/persistence.rs]
  ├─ metadata_needs_snapshot？ →（17 字段对比，高频字段刻意排除）
  ├─ 普通路径：append_json_line_fast 追加 journal 行（单次 O_APPEND write）
  ├─ journal > 512KB → checkpoint_snapshot（全量快照 + 删 journal）
  └─ append 失败 → 回退全量 snapshot
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `config()` in `config.rs` | 全局配置访问 | `Box::leak` 出 `&'static Config`，旧引用 in-flight 期间永远有效 |
| `on_config_reloaded()` in `config.rs` | 回调注册 | 上层（auth/bus）注册反应，避免 config→上层循环依赖 |
| `replay_journal_lines()` in `persistence.rs` | journal 重放 | 坏行不再截断尾部，改 salvage 粘行 |
| `salvage_glued_journal_entries()` in `persistence.rs` | torn line 修复 | 利用序列化恒以 `{"meta":` 开头找候选起点 |
| `detect_crash()` in `session.rs:1075` | crash 检测 | status==Active 且 last_pid 已死 |
| `ensure_context_fits()` in `compaction.rs` | 压缩入口 | ≥0.95 先等 in-flight 后台压缩再硬压 |
| `hybrid_fuse`… | — | （memory 模块见专文） |
| `effective_for_working_dir()` in `skill.rs` | skill 项目覆盖 | 每次现读磁盘——编辑免重启可见 |

</details>

---

## 核心实现

### 配置热重载：leak 出来的无锁设计

`config() -> &'static Config` 读 `CONFIG_CACHE: LazyLock<RwLock<ConfigCache>>`。返回的是 `Box::leak` 出的 `&'static Config`——旧引用在 in-flight 操作期间永远有效，这是整个系统能无锁传递 `&'static Config` 的前提。**节流**：`CONFIG_CACHE_CHECK_INTERVAL = 500ms`，超时才检查 `ConfigCacheFingerprint`（path + mtime + len + `CONFIG_ENV_KEYS` 中的环境变量值 hash）。一个微妙的顺序问题被注释钉死：指纹在 load **之后**再取一次——env override 本身会设置环境变量，先取指纹下一次必然误判为变更。约 180 个 `JCODE_*` 环境变量覆盖（`apply_env_overrides`）；`load_for_update()` 是读-改-写专用路径，**跳过 env 覆盖**防瞬态设置被写盘。

`on_config_reloaded` 回调链存在的 why（config.rs 注释原话）：config 是底层模块不该向上依赖 auth/bus，由上层注册反应。实际注册点在 `src/cli/startup.rs:61-63`：`sync_output_style_from_config`、`AuthStatus::invalidate_cache`、`Bus::publish_models_updated`（内部 750ms debounce 合并）。config.toml 约 25 个顶级段（provider/providers/agents/tools/features/display/ambient/compaction/hooks/safety/...），`providers.<name>` 支持 `extra_body` 注入任意请求字段。

### session journal：为崩溃而生的持久化

**布局**：快照 `~/.jcode/sessions/<id>.json` + journal 同名 `.journal.jsonl`。每行 journal = 全量 meta 快照 + 4 个增量向量（`append_messages`/`append_env_snapshots`/`append_memory_injections`/`append_replay_events`）——**每行都带全量 meta** 是 torn-line 容错的关键：任何一条 entry 自身足以恢复元数据。

**save 决策**：`metadata_requires_snapshot` 对比 17 个字段（`updated_at`/`model`/`last_pid` 等**刻意不在内**——高频变化不触发全量快照）；向量长度缩水（compaction 删了历史）必须写 snapshot——journal 无法表达删除。**torn line 修复**：`salvage_glued_journal_entries` 利用序列化字段序恒为 `{"meta":` 开头，在坏行内找全部候选起点流式解析连续完整 entry——writer 死在半行时，下一次 append 会接着同一行写产生"粘行"。检测到损坏时备份 `.corrupt.jsonl` + `mark_messages_full_dirty()` 强制下次写全量。**防误删护栏**：`destructive_empty_checkpoint`（内存空 + 磁盘有非空转录）直接 bail；`guard_snapshot_shrink` 先做 `.bak` 备份。

**crash 恢复**：`detect_crash()`（status==Active 且 `last_pid` 已死）→ `find_recent_crashed_sessions()` 快速路径扫 `~/.jcode/active_pids/`（0-5 个文件）而非数万文件的 sessions 目录 → `recover_crashed_sessions()` 建 `session_recovery_<id>` 新会话（parent_id 指回原会话，**只保留 Text block** 丢 tool call/image）。

### Bus：进程内 broadcast

`Bus::global()`：`OnceLock` 单例 + `broadcast::channel(256)`（lossy——lagged 慢订阅者丢消息，事件须可丢弃/可重建）。`BusEvent` 32 个变体分七类：工具/Todo UI 状态、swarm 协调（FileTouch/SwarmOutputTail）、后台任务、用量报告、登录/目录刷新、off-UI-thread 完成通知（clipboard/git/dictation）、`CompactionFinished`（后台压缩完成提示调用方 `check_and_apply`）。两个附加机制：`publish_models_updated` 发布前先 `bump_catalog_generation()` 使路由目录 memo 失效，内部 `MODELS_UPDATED_DEBOUNCE = 750ms` 防抖合并（无 tokio runtime 时同步发布）；`UpdateStatus` 事件额外存一份全局 `OnceLock<Mutex<Option<UpdateStatus>>>`（`latest_update_status()`），让晚订阅者也能拿到最新升级状态。**与 `ServerEvent` 的关系**：Bus 是进程内 jcode-base 层；`ServerEvent`（`jcode-protocol/src/wire.rs:751`）是 daemon→client 的 wire 协议——bus 事件驱动服务端状态，服务端再转译成 ServerEvent 推给远程客户端。

### 压缩管线：三模式 + 双阈值

`jcode-compaction-core` 常量层：`DEFAULT_TOKEN_BUDGET = 200_000`、`COMPACTION_THRESHOLD = 0.80`（后台压缩）、`CRITICAL_THRESHOLD = 0.95`（同步硬压缩）、`RECENT_TURNS_TO_KEEP = 10`、`MIN_TURNS_TO_KEEP = 2`（emergency 下限）、`EMERGENCY_TOOL_RESULT_MAX_CHARS = 4000`（截断保头 1/2 尾 1/4）、`EMERGENCY_IMAGE_MAX_CHARS = 1024`、`SYSTEM_OVERHEAD_TOKENS = 18_000`（仅当 budget ≥ 100K 才计入，让小 budget 测试不受干扰）、`IMAGE_TOKEN_COST = 1600`（按 base64 长度/4 计会高估 ~100x，曾引发图一直在保留区的"triple compaction"连环压缩——Image 块按 `IMAGE_TOKEN_COST * CHARS_PER_TOKEN` 计而非原始 data 长度）。

`CompactionManager`（`compaction.rs`）不持有消息（caller 传 `&[Message]`）；三种模式：**Reactive**（默认 80% 阈值）、**Proactive**（EWMA 增速投影 `lookahead_turns=15` 超阈值提前压）、**Semantic**（embedding 余弦检测 topic shift，`topic_shift_threshold=0.45`）。`safe_compaction_cutoff` 向后扩 cutoff 直到保留区内每个 ToolResult 都有配对 ToolUse（否则返回 0 不压缩——保护 API 约束）。≥0.95 时若已有 in-flight 后台压缩先 `wait_for_pending_compaction_at_hard_threshold`——此时起新后台任务只会被随后的 hard compact 作废（summary 基于 pre-hard-compact 偏移）；硬压缩本身（`hard_compact_with`）从 `RECENT_TURNS_TO_KEEP` 起步、剩余 token 仍超预算则轮数减半、下限 `MIN_TURNS_TO_KEEP`，提交前 abort in-flight 后台任务防 stale pending_cutoff 双重压缩（`check_and_apply` 对 `pending_cutoff > active_len - MIN_TURNS_TO_KEEP` 的过期结果直接丢弃）。token 计费由 `effective_context_tokens_from_usage` 统一 Anthropic（split：input+cache_read+cache_creation）与 OpenAI（subset：prompt_tokens 已含 cached）两种口径（issue #441——侧边栏与 compaction manager 必须共用同一函数）。

### skill 分层：全局注册表 + 现读项目覆盖

`SkillRegistry::shared_registry()` 进程级**只装全局技能**（Claude Code 插件扫描深度 5、`~/.jcode/skills/`、`~/.agents/skills/`）——项目技能若进共享 registry，daemon 启动 cwd 会污染所有会话。项目覆盖：`load_project_overlay(working_dir)` 扫 `./.jcode/skills/` 等，`effective_for_working_dir` = base + overlay（同名胜出），**每次现读磁盘**——编辑免重启可见且不同 repo 会话互不可见。`list()` 强制按 name 排序——HashMap 迭代序随机会使 system prompt 字节不一致，静默打掉 Anthropic strict-prefix KV cache。首次运行 `import_from_external()` 从 Claude Code/Codex 拷贝技能。

### safety、registry 与平台

**SafetySystem**（`safety.rs:150`）持有 `queue: Mutex<Vec<PermissionRequest>>` + `history` + `actions`——ambient 等无人值守场景的权限审批队列；`AUTO_ALLOWED`（`safety.rs:132`）是 Tier-1 只读动作名白名单，命中则自动豁免权限请求，其余默认 `RequiresPermission`。`request_permission()` 入队 + 持久化 + 经 `register_permission_notifier` 注册的 dispatcher 通知用户；决策可以是即时（`Decision`）或等待（TUI 里弹出 `PermissionsApp`，`jcode-tui-permissions` crate）。**ServerRegistry**（`registry.rs:50`）跟踪 `~/.jcode/servers.json` 运行中服务器供客户端发现（server 名持久化，reload 后新进程注册新名）；`cleanup_stale()`（`registry.rs:125`）两轮清理（PID 死亡 + socket 去重），**刻意不清理 socket 文件**（注释：新 server 可能在 reboot/reload 后复用同一 socket）。平台层还有 `platform.rs::raise_nofile_limit` 与 power inhibit（`PowerInhibitor` 让 turn 处理期间屏幕不休眠）。

### storage 与 usage

`jcode-storage`：**原子写**——temp 文件 → write → fsync → Unix 上先 hard_link 旧 inode 为 `.bak` 再 rename（旧方案 rename-away 会让 primary 短暂 ENOENT，load-all 型读者静默丢条目）→ rename。`runtime_dir()`（Linux `$XDG_RUNTIME_DIR`，socket/易失状态）与 `durable_state_dir()`（`~/.jcode/state`，必须扛住重启——runtime_dir 常是 tmpfs）分离。`active_pids/`（session→PID 注册）+ `streaming_pids/`（StreamingGuard RAII）+ `internal_pids/`（issue #508：presence UI 过滤 swarm worker/调试会话）。

**usage 汇总**（`usage.rs:158` 的 `fetch_all_provider_usage_progressive`）：先发 `PROVIDER_USAGE_CACHE`（TTL 120s）的 stale 结果（UI 先有内容）→ `JoinSet` 并发投递各 provider 任务（Anthropic 多账号 / OpenAI / API-key 型 / openrouter/copilot/...）→ 每完成一个 `ProviderUsageProgress` 回调驱动 TUI 渐进显示。`AccountUsageSnapshot` 支撑同 provider 账号 failover 的 `best_available_alternative()`。

---

## 模块间交互

config 被 startup/server/agent/tool 全层消费（`&'static` 传递）；Bus 连接 server↔agent↔TUI 的进程内事件（FileTouch 是 swarm 冲突检测的起点）；session 被 Agent 持有（journal 在每次 add_message 后 save）；compaction manager 由 Registry 持有（`conversation_search` 工具共享）；skill registry 被 memory 的 synthetic entry provider 反转消费。logging 带 watchdog（`watchdog.rs`：300s 心跳 + 90s stall dump 含 per-thread 状态，独立于 async runtime 和 UI loop——二者卡死时仍能报告）。

---

## 扩展方式

**新增配置项**（以 `[compaction]` 加字段为例）：`jcode-config-types` 对应 struct 加字段 + `#[serde(default)]` + Default 实现（老 config 缺字段不报错）→ 需要 env 覆盖则在 `config/env_overrides.rs` 加分支 + `CONFIG_ENV_KEYS` 加变量名（否则改 env 不触发热重载）→ 需要展示则补 `display_summary.rs` / `default_file.rs`。**新增 BusEvent**：`bus.rs` 加变体 → 发布方 publish → 订阅方 match 加臂；跨进程到达远程客户端还需 wire 变体 + 服务端转译。对应测试：config 内联测试、`session/*_tests.rs`、`bus.rs` 内联测试。
