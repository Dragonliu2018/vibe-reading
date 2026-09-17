---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "Agent 检测与集成"
date: "2026-09-17T10:54:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
tags: ["herdr", "Rust", "规则引擎", "agent 集成"]
description: "herdr agent 检测：TOML manifest 声明式规则引擎三源仲裁，integration 模块管理 23 家 agent 的安装差异。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/detect/`（约 6,000 行）+ `src/integration/`（约 11,600 行）回答 herdr 最具产品辨识度的问题：**这个 pane 里跑的是什么 agent、它现在是什么状态**，以及**怎么把 herdr 的钩子装进每家 agent**。两个子模块职责正交：detect 是运行时的观察者（读屏幕、看进程、收 hook 报告），integration 是安装期的施工队（写 hook 脚本、改 agent 配置）。

检测的设计哲学写在 `AGENTS.md`：**Screen detection is evidence-based**——改 manifest 前先用 `herdr agent read <pane> --source detection --format text` 抓真实底部 buffer，决定哪些可见控件是不变量、哪些是备选项，编码成显式 AND/OR 门；不匹配整屏偶发文本，不用用户可见 viewport（用户会滚动它）。detector 只读屏幕快照，从不碰 parser/viewport 状态。

## 模块架构

![detect+integration 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-09-detect.svg)

上半是检测链路：三个证据源（进程探测读 `/proc` 识别 pgid；屏幕 region 切片；pane/osc.rs 截获的 OSC 0/2/9 标题与进度）汇入 manifest 规则引擎 `evaluate_loaded_manifest()`，产出 `AgentDetection`。下半是集成链路：`integration_specs()` 注册表 → `install_target()` 按 target 分发 → hook 脚本 + CST 保格式配置注入 → agent 的 SessionStart 时经 socket API 回报会话身份，成为 hook 权威。没有统一的 Registry trait——注册靠三处平行的 match/常量表，**每个 agent 的编排是手写函数**，这是刻意的直白而非抽象（targets.rs 59KB 就是 23 家差异的账本）。

## 调用链路

**检测链路**（运行于 `pane.rs:spawn_basic_detection_task`，300ms 轮询）：

```
identify_agent_in_job() in detect/mod.rs        # 进程名识别（node/bun 包装、启动器特例）
└─ agent 变更时 clear_osc_evidence_for_agent_transition + AGENT_STARTUP_GRACE_WINDOW
   └─ terminal.detection_text()                  # 屏幕尾部（bottom_non_empty_lines(12) 等 region）
      + agent_osc_title() / agent_osc_progress() # OSC 证据
      └─ detect_agent_with_osc() → manifest::detect_with_osc()
         └─ evaluate_loaded_manifest()
            ├─ 逐规则：region() 切片 → compiled_gate_matches() 匹配
            ├─ 取 priority 最高者；无命中走 fallback_explain()（已知 agent 回落 Idle）
            └─ apply_agent_detection_publish_update → AppEvent 发布
```

**`herdr integration install claude` 链路**：

```
cli/integration.rs:integration_install()
└─ parse_integration_target → actions.rs:install_target() → targets.rs:install_claude()
   ├─ claude_dir()（env.rs，CLAUDE_CONFIG_DIR 或 ~/.claude）→ check_config_targets 防误装
   ├─ fs::write(hook_path, CLAUDE_HOOK_ASSET) + make_executable   # 写 hook 脚本
   └─ claude_settings.rs:install()               # jsonc_parser CST 保注释/格式编辑
      └─ 注入 hooks.SessionStart 命令（hook_command()，带 SESSION_START_MATCHER）
         + 移除旧版全生命周期 hook 条目（HOOK_REMOVALS）
```

hook 回报路径：脚本由 `apply_pane_base_env()`（`env.rs`）注入 `HERDR_SOCKET_PATH/HERDR_PANE_ID`，SessionStart 时用 python3 走 unix socket 发 `pane.report_agent_session` → `app/api/panes.rs:handle_pane_report_agent_session` → `terminal/state.rs:set_hook_authority_at`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `evaluate_loaded_manifest()` in `detect/manifest.rs` | 规则匹配 | priority 最高者胜 |
| `compile_gate()` in `detect/manifest.rs` | 门编译 | regex 预编译缓存 |
| `identify_agent_in_job()` in `detect/mod.rs` | 进程识别 | pgid leader 优先，全 job 打分回退 |
| `auto_update()` in `detect/manifest_update.rs` | 远程热更新 | `MANIFEST_ENGINE_VERSION=3` 引擎版本门 |
| `install_target()` in `integration/actions.rs` | 安装分发 | 大 match 按 target |
| `install_claude()` in `integration/targets.rs` | Claude 安装 | CST 编辑保用户注释 |
| `parse_integration_version()` in `integration/registry.rs` | 版本探测 | 扫资产首行 `HERDR_INTEGRATION_VERSION=N` |
| `set_hook_authority_at()` in `terminal/state.rs` | 仲裁点 | hook 与屏幕检测的冲突消解 |

</details>

## 核心实现

### Manifest：TOML 规则 DSL

```rust
// src/detect/manifest.rs
pub struct AgentManifest { id, version, min_engine_version, aliases, rules: Vec<ManifestRule> }
// 每条 ManifestRule { state, priority, region } + 递归门：
//   ManifestGate { all / any / not / contains / regex / line_regex }
```

23 个 agent 各一个 TOML（`src/detect/manifests/`：claude、codex、cursor、grok、qwen、opencode、gemini、droid、kimi、letta…），经 `BUNDLED_MANIFESTS`（`include_str!`）静态编入。规则即"屏幕文本 → 状态"的声明式 DSL——例如 claude.toml 的 `live_blocked_form` 规则用 `contains = ["esc to cancel"]` + `any` 分支识别权限弹窗。规则里大量 issue 编号注释（#3283、#2650）表明这是逐 bug 迭代出来的。三级优先级：local override（`~/.config/herdr/agent-detection/*.toml`）> remote 缓存 > bundled，失败降级而非崩溃；远程 manifest 从 `herdr.dev/agent-detection/index.toml` 热更新，`validate_manifest` 强制 `MAX_RULES_PER_MANIFEST=128`、`MAX_GATE_DEPTH=8`、`MAX_TOTAL_MATCHERS=1024`——**远程 manifest 是不可信输入**。

### 检测源仲裁：三类 agent

`full_lifecycle_hook_authority()` / `session_identity_only_integration()`（`detect/mod.rs`）把 agent 分三类：**hook 全权**（pi/omp/kimi/kilo/opencode/mastracode——pane 检测任务直接 `continue` 跳过屏幕扫描）、**仅会话身份**（claude/codex/qwen/hermes/letta/agy——hook 只报 session，状态仍靠屏幕）、**纯屏幕**。为什么 claude 走"屏幕为主"：PreToolUse/Stop hook 延迟高且不可靠——各 `*_REMOVED_LIFECYCLE_HOOK_EVENTS` 常量记录了从"全 hook"退回"屏幕为主"的迁移史；hook 只提供屏幕拿不到的 session id。

### 集成安装：23 家差异的直白账本

`targets.rs` 管每家 agent 的安装差异：hook 脚本（sh/ps1）vs TS 扩展（pi/omp）vs JS 插件（opencode/kilo）vs Python 插件（hermes）；配置注入目标五花八门（claude settings.json hooks、codex config.toml+hooks.json、grok 独立 herdr.json、opencode opencode.json 插件注册）。共享原语在 `config_edit.rs`/`env.rs`/`command.rs`。幂等安装靠资产首行注释版本标记（Current/Outdated/NotInstalled）。CST 编辑（`claude_settings.rs` 用 jsonc_parser）对用户已有 settings.json 做树编辑而非 serde 重序列化——**保住用户的注释与键序**，这是对用户文件的敬意，也是集成能被接受的前提。

### env.rs 全局锁

graphify 里的 degree-127 god node `integration_env_lock()` 实为 `#[cfg(test)]` 专用全局 Mutex（`env.rs:254`）：`claude_dir()` 等直接 `std::env::var_os`（进程全局可变状态，Rust 的 set_var 非 Sync 安全），测试必须串行。生产路径靠"env 优先于 home 默认"同时充当测试缝。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 数据驱动规则引擎 | `detect/manifests/*.toml` | 规则独立于二进制热更新 |
| 声明式校验 + 复杂度上限 | `validate_manifest` in `manifest.rs` | 不可信输入防御 |
| CST 保格式编辑 | `claude_settings.rs` / `config_edit.rs` | 不破坏用户注释与键序 |
| 幂等安装 + 版本标记 | `parse_integration_version()` in `registry.rs` | 重装/升级判定 |
| 检测源仲裁 | `terminal/state.rs::set_hook_authority_at` | hook 权威 vs 屏幕回退 |

## 模块间交互

`pane.rs` 持 `AgentDetectionPresence`（连续 miss 确认去抖）并运行检测任务；`terminal/state.rs` 是仲裁落点；`agent_resume.rs` 的 `PersistedAgentSession` 从 hook 报告获得会话身份供恢复；`manifest_update.rs` 把远程 manifest 原子写入 state 目录（`atomic_write` + `sync_parent_dir` 目录级 fsync）。`IntegrationTarget` 是冻结 API enum——letta 走 CLI-only experimental 路径，注释明言"等 agent registry 取代 enum-keyed registry 后收编"。

## 扩展方式

**新增支持一个 agent "foo"**（约 8 个文件 + 2 个资产，完整清单见概览「典型修改场景 · 场景 1」）。

**为一个 agent 改进误判的状态识别**：只改 `detect/manifests/<agent>.toml`，升 `version` 与必要时 `min_engine_version`——**零 Rust 代码改动**，这正是 manifest 架构的回报。用户可先在本地 override（`~/.config/herdr/agent-detection/foo.toml`）验证再合入。

**修复某 agent 的配置注入 bug**：改 `targets.rs` 对应 install 函数 + `claude_settings.rs`/`config_edit.rs` 原语，并 bump `mod.rs` 中对应 `*_INTEGRATION_VERSION`（使 `print_outdated_update_notice` 提示重装）。

---

## 边缘机制速查

闭卷验证补充：

### manifest 细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `SCREEN_MANIFEST_AGENTS 差集` | `detect/mod.rs` | Agent::ALL 24 个成员中 Omp 与 Mastracode 不在 SCREEN_MANIFEST_AGENTS（22 个）——它们由 full_lifecycle_hook_authority 全权覆盖，屏幕扫描直接跳过
| `fallback_explain` | `detect/manifest.rs` | 已知 agent 无规则命中回落 DEFAULT_KNOWN_AGENT_IDLE_FALLBACK（Idle）；agent 为 None 返回 Unknown
| `load_manifest_uncached 三级来源` | `detect/manifest.rs` | local override（override_path，~/.config/herdr/agent-detection/）> remote 缓存（read_remote_manifest + ManifestSource 标记，cached_remote_version 低于 bundled 时弃用降级 + warning）> bundled
| `skip_state_update 约束` | `detect/manifest.rs` | validate_manifest 强制该类规则 state 取 ManifestState::Unknown 且不得带 visible_* 标志——transcript 查看器语义不产生状态
| `contains 大小写 / region 来源` | `detect/manifest.rs` | compile_gate 把 contains 小写化（不区分大小写）；osc_title/osc_progress region 读 DetectionInput 的 OSC 字段而非屏幕；top_non_empty_lines(n) 参数化 region 要求 min_engine_version ≥ TOP_NON_EMPTY_LINES_ENGINE_VERSION(3)

### 集成状态判定

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `integration_state_for_path / INTEGRATION_VERSION_MARKER` | `integration/registry.rs · mod.rs` | 从已装文件解析 HERDR_INTEGRATION_VERSION= 行标记；等于期望为 Current、低于为 Outdated、缺失为 NotInstalled
| `复合降级检查` | `integration/registry.rs` | Grok 即使 hook 版本 Current 也须 grok_hook_config_is_valid（hooks/herdr.json 与 grok_hook_config 精确比对，GROK_HOOK_CONFIG_INSTALL_NAME）；OpenCode 须 opencode_tui_integration_is_valid（tui_plugin_is_configured）——配置漂移会降级为 Outdated
| `letta 实验路径` | `integration/registry.rs · mod.rs` | experimental_letta_integration_status 走 EXPERIMENTAL_INTEGRATION_TARGET_LABELS=['letta']——不进冻结的 IntegrationTarget enum；identify_agent_in_job 里 is_interactive_letta_process 过滤 --print/--json 等非交互 letta 进程