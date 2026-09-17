---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "会话持久化"
date: "2026-09-17T10:56:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
tags: ["herdr", "Rust", "持久化", "快照"]
description: "herdr 会话持久化：进程不存活但会话可恢复——结构快照原子落盘、BSP 树重建、agent 会话注入式 resume。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/persist/`（约 4,200 行）+ `src/agent_resume.rs` + `src/session.rs` 回答的问题是：**detach 之后哪怕机器重启，工作现场怎么找回来**。herdr 的答案很诚实——PTY 子进程无法跨机器重启存活，所以它不试图迁移进程，而是持久化"结构 + agent 自己的会话引用"：BSP 布局树、每个 pane 的 cwd/label/agent 信息，恢复时按保存的 cwd 起全新 shell、把 `claude --resume <id>` 类命令"敲"进新 PTY。README 对此毫不隐瞒："the original processes do not survive"——agent 的对话历史本来就在 agent 自己的磁盘上，herdr 只是记得怎么把它叫回来。

## 模块架构

![persist 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-11-persist.svg)

保存链路：布局变异 → 5s 防抖 → 后台线程快照 → 原子写。恢复链路：server 启动时 `load` → `restore` 重建 → agent resume **延迟到 client attach 后**执行。两条链共享可序列化 DTO 层（`snapshot.rs`），运行时对象（Node/Workspace/Tab）与 DTO 严格分离——快照/回放（Memento）模式。`session.rs` 管 named session：`--session work` 各自一个数据目录，socket、快照、历史天然互不干扰。

## 调用链路

**保存链路**：

```
任意布局变异 → mark_session_dirty()
└─ schedule_session_save() in app/session.rs:14（5s 防抖 SESSION_SAVE_DEBOUNCE）
   └─ headless 事件循环到期 → start_background_session_save() in server/headless.rs:3403
      └─ 后台线程 run_session_save_job() in app/session.rs:128
         ├─ capture() in persist/snapshot.rs:252
         │    ├─ 遍历 workspace/tab/pane 产出纯 JSON
         │    ├─ cwd 从 TerminalRuntimeRegistry 实时取
         │    └─ agent_session 优先 terminal.hook_authority.session_ref
         │        回退 persisted_agent_session（snapshot.rs:338-358）
         └─ SessionWriter::save() in persist/writer.rs:29 → session.json
              （persist_pane_history 开启时另存 session-history.json）
```

**恢复链路**：

```
server 启动 → App::new() in app/mod.rs:374
└─ persist::load() in persist/io.rs:88（版本过高直接丢弃）
   └─ persist::restore() in persist/restore.rs:65
      ├─ restore_workspace → restore_tab 逐层重建
      ├─ restore_node_remapped()（restore.rs:865）：旧 pane id 重映射为全局新 PaneId::alloc()
      ├─ 每 pane 按保存 cwd 起全新 shell（TerminalRuntime::spawn_with_initial_history）
      │    # 初始 24×80，client attach 后再 resize；spawn 失败 prune_restored_node 剪死分支
      │    # cwd 不存在回退 HOME（restore.rs:476）
      └─ pane_restore_startup()（restore.rs:739）→ agent_resume::plan()
         → AgentResumePlan 挂在 TerminalState::with_pending_agent_resume_plan（不 spawn）
         → client attach + 宿主主题到位后 start_pending_agent_resumes() in app/agent_resume.rs:43
            → spawn 普通 shell → resume 命令 + "\r" 经 runtime.try_send_bytes() 注入 PTY
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `capture()` in `snapshot.rs:252` | 快照采集 | cwd 实时取，agent 会话双来源 |
| `SessionWriter::save()` in `writer.rs:29` | 落盘 | temp + rename 原子写 |
| `preserve_existing()` in `writer.rs:66` | 保护未恢复快照 | 复制到 session-backups/ 留 3 代 |
| `migrate_snapshot()` in `snapshot.rs:189` | 版本迁移 | v2 无 tab 格式迁移为单 tab |
| `restore_node_remapped()` in `restore.rs:865` | 布局重建 | pane id 重映射防撞 |
| `agent_resume::plan()` in `agent_resume.rs:136` | resume 命令翻译 | argv 数组传递，id 当数据不当 shell 文本 |
| `start_pending_agent_resumes()` in `app/agent_resume.rs:43` | 延迟执行 | 等宿主主题 750ms |

</details>

## 核心实现

### 快照结构与原子写

```rust
// src/persist/snapshot.rs
pub struct SessionSnapshot { version: u32, workspaces: Vec<WorkspaceSnapshot>, ... }  // SNAPSHOT_VERSION = 3
pub struct PaneSnapshot {           // pane 元数据：进程本身绝不持久化
    cwd: PathBuf, label: Option<String>,
    agent_name: Option<String>,
    agent_session: Option<PaneAgentSessionSnapshot>,   // ← resume 的关键
    launch_argv: Option<Vec<String>>,
}
pub struct PaneAgentSessionSnapshot { source: String, agent: String,
    kind: AgentSessionRefKind /* Id | Path */, value: String }
pub enum LayoutSnapshot { Pane(u32), Split { direction, ratio, first, second } }  // 可序列化 BSP 树
```

写盘的三道保险：`session.json`（结构）与 `session-history.json`（屏幕 ANSI，可含敏感内容）**分文件**各自 temp+rename——结构写成功后即使 history 失败也不把会话标记为 unloaded（`writer.rs:41-46` 注释）；`protect_unloaded` 机制——若启动时发现磁盘快照但本次未成功恢复，首次覆写前先把旧文件复制到 `session-backups/` 保留 3 代，时间戳取 `max(now, prev+1)` 防时钟回拨；workspaces 为空时 `SessionSaveJob::Clear` 删除文件（干净退出不留空壳）。关机路径 `save_session_on_shutdown()`（`headless.rs:724`）兜底——防的正是 0.8.x 时代"中断的 pane 退出把保存会话替换成空会话"那类 bug（#3415）。

### agent resume：注入而非 spawn

resume 是三段式：(a) 保存时 detect 的 hook 报告（`session_ref_from_report`，`agent_resume.rs:53`）拿到 agent 会话 id/path；(b) 恢复时 `plan()` 把 `(source, agent, ref)` 翻译成具体 argv——如 `["claude","--resume",id]`、`["pi","--session",path]`——挂在 `TerminalState` 上**不 spawn**；(c) client attach 后 spawn 普通 shell、把 resume 命令字符串加 `\r` 敲进 PTY。安全细节：命令以 argv 数组传递、id 经 `valid_session_id`（`agent_resume.rs:289`）拒绝控制字符——"ids are data not shell text"。为什么延迟到 attach：agent CLI 需要 24-bit 主题环境变量才正确渲染（`PENDING_AGENT_RESUME_THEME_WAIT` 750ms）；native agent resume 时**跳过** ANSI 历史 replay（`restore.rs:747` 注释）——agent 自己会重放对话。同一 dedupe_key 的重复会话只 resume 一次（`resumed_sessions` HashSet）。

### named session：目录隔离

`--session work` → `HERDR_SESSION` 环境变量 → `data_dir_for` 返回 `~/.config/herdr/sessions/work/`（`session.rs:161`）：socket（herdr.sock/herdr-client.sock）、session.json、history 全落在这个目录，天然互不干扰。名字经 `validate_name`（`session.rs:452`）白名单字符校验防路径穿越；大小写不敏感文件系统上删除前要求目录项精确匹配（`exact_session_dir_for_delete`）。显式 `--session` 优先于继承的 `HERDR_SOCKET_PATH`，且 env 继承的 session 不算 explicit。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 快照/回放（Memento） | `capture_*` / `restore_*` 镜像函数对 | 运行时对象与 DTO 分离 |
| 版本化迁移 | `migrate_snapshot` in `snapshot.rs:189` | 新字段全 `#[serde(default)]` 前向兼容 |
| 策略开关 | `AppPolicy`（restore_session/persist_session） | PRODUCTION/TEST/HANDOFF_REPLACEMENT 三态 |
| 去重预约 + 回滚 | `pane_restore_startup` in `restore.rs:739` | spawn 失败回滚预约（:668） |
| write-temp-then-rename | `save_json_to_path` in `io.rs:48` | 原子写 + 目录级 fsync |

## 模块间交互

`server/headless` 持有 App，驱动防抖保存、关机保存与延迟 resume；detect 是 agent 会话引用的唯一来源（`HookAuthority.session_ref`）；`pane/terminal` 的 `spawn_with_initial_history` 支持把 ANSI 历史预填充进新 PTY；`PaneLaunchEnv` 注入 HERDR pane id 环境变量（`restore.rs:520`）。handoff 路径（`restore_handoff`，`restore.rs:95`）在进程迁移场景直接复用 PTY master fd——那是 live handoff 的地盘。

## 扩展方式

- **新增可恢复 agent**：`agent_resume.rs::plan()` 加一个 `(source, agent, kind)` match 臂 + `is_official_agent_source` 白名单 + `session_ref_from_report` 提取规则——persist 层零改动（纯数据驱动）
- **快照加新字段**：`PaneSnapshot` 加 `#[serde(default, skip_serializing_if=...)]` 字段 + `capture_tab`/`restore_tab` 各一行，旧文件自动兼容（对照 `launch_argv` 的加法式演进）
- **修改保存触发策略**：改 `src/app/session.rs`（防抖/checkpoint/shutdown 语义集中在此）而非 persist 模块

---

## 边缘机制速查

闭卷验证补充：

### 写入与版本守卫

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `resolve_write_target / save_json_to_path` | `persist/io.rs` | 符号链接跟随上限 16 次（不用 canonicalize——它要求目标存在，无法处理 stow 用户的悬空链接）；临时文件 .json.tmp + fs::rename 原子替换，rename 失败删临时文件
| `snapshot_file_version / parse_snapshot` | `persist/io.rs · snapshot.rs` | SNAPSHOT_VERSION=3；version > 3 拒绝解析，load/load_history 检测到更高版本以 unsupported_version 记 warn 返回 None——不崩溃也不覆盖新版本写的文件
| `备份细节` | `persist/writer.rs` | preserve_existing 备份到 session-backups/，文件名 session-{timestamp:039}-{pid}-{sequence}.json（sequence 最多试 128 次避 AlreadyExists）；时间戳取 now.max(prev+1) 防时钟回拨；prune_backups 保留 older 末尾 2 份（加新备份共 3）；copy_recovery 先 .pending + sync_all 再 rename——中断的拷贝不会被当成完整备份
| `protect_unloaded 置位时序` | `SessionWriter.save in writer.rs` | 主 session.json 保存成功后、写历史文件之前就置 false——历史失败只记日志不阻塞后续布局保存（optional_history_failure_does_not_block_later_layout_saves 测试）

### 快照结构与迁移

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `capture_history / capture_pane_history` | `persist/snapshot.rs` | 历史经 TerminalRuntimeRegistry.snapshot_history 取 ANSI 独立成 SessionHistorySnapshot/PaneHistorySnapshot（lines 为行数）；PaneSnapshot 无 history 字段，旧嵌入历史被 serde 忽略丢弃；save_history_to_path 在 history 为 None 时删除过期历史文件
| `migrate_workspace / legacy_identity_cwd` | `persist/snapshot.rs` | 有 identity_cwd 按新格式、有 layout 按 LegacyWorkspaceSnapshot 迁移（包装单 tab，active_tab=0）；identity_cwd 回退链：root pane cwd → 布局首 pane cwd → 最小 key pane cwd → current_dir → '/'（first_pane_id_in_layout）

### 恢复与会话管理

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `restore 细节` | `persist/restore.rs` | restore_node_remapped 全新 PaneId + 映射；cwd 不存在回退 HOME 再 '/'；prune_restored_node 折叠死分支（两侧皆死则丢 tab）；resolve_restored_pane 优先 focused/root_pane 存活者；restore_workspace 空 tabs 丢 workspace、active_tab clamp
| `resume 去重与安全` | `restore.rs · agent_resume.rs` | pane_restore_startup spawn 前把 dedupe_key（source\0agent\0kind\0value）插入 resumed_sessions 预约，失败即 duplicate_agent_session；有原生恢复计划时 initial_history_ansi=None（不回放 ANSI）；restore_plan_for_snapshot 在 resume_agents_on_restore=false 时返回 None；plan() 须过 is_official_agent_source 白名单（herdr:<agent>），copilot/omp 用 --resume=<value> 单参数，pi/omp 双 kind 其余仅 Id；valid_session_path 要求绝对路径 MAX_SESSION_PATH_LEN=4096，valid_session_id 上限 512，均拒控制字符；spawn 失败回滚预约
| `named session 细节` | `session.rs` | SESSION_ENV_VAR=HERDR_SESSION、DEFAULT_SESSION_NAME=default；data_dir_for 命名会话在 config_dir/sessions/<name>；validate_name 仅 ASCII 字母数字与 ._-（≤64 字节，拒 . 和 ..）；normalize_name 把 default 归 None；delete_session 拒删默认/运行中（is_running_at 探测）、exact_session_dir_for_delete 精确匹配目录名；api_socket_path_for=herdr.sock、client_socket_path_for=herdr-client.sock
| `session stop` | `session.rs` | stop_socket_with_timeout 发 server.stop（id cli:session:stop）；STOP_WAIT_TIMEOUT=15s、STOP_WAIT_POLL=25ms；wait_until_stopped_until 轮询双 socket 不可达；socket_timeout_from_remaining 剩余为零返回 None 否则钳到 ≥1ms；BrokenPipe/ConnectionReset 等视为可继续等待