---
source:
  type: "源码解读"
  project: "RTK"
  url: "https://github.com/rtk-ai/rtk"
title: "Hook 集成"
date: "2026-08-25T10:45:03+08:00"
category: [AI, Agent, "AI Coding", RTK, CodeWiki, "0.45.0"]
tags: ["RTK", "Rust", "CLI 代理", "Hook", "AI Coding Agent"]
description: "RTK hooks/ 模块：11+ LLM 代理的 hook 安装、PreToolUse 拦截、SHA-256 完整性校验与权限模型。"
readingTime: "23 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/00-overview)

---

## 模块定位

`src/hooks/`（~14126 行）是 RTK 连接 LLM 编码代理的桥梁——`rtk init` 为 11+ 代理安装 hook，`rtk hook <agent>` 在运行时拦截 `PreToolUse` 事件改写命令。它是全仓第二大模块（`init.rs` 8387 行是 god module），但代码量大是因为要适配各家代理的 JSON 格式与配置位置差异，而非逻辑复杂。它的职责边界是：**把代理无关的改写逻辑隔离在 Rust 内，hook 只做薄委托**——hook 脚本/binary 读代理 JSON、调 `discover::registry::rewrite_command` 改写、返回代理特定 JSON 响应。改写引擎本身在 `discover/`，hooks 只做格式适配与安装。

## 模块架构

hooks/ 内部分两条主线：**安装线**（`init.rs`，`rtk init` 时跑）负责写 awareness 文件、patch 代理配置、SHA-256 完整性基线、迁移旧脚本；**运行线**（`hook_cmd.rs` + `rewrite_cmd.rs`，代理每次执行命令时跑）负责读 stdin JSON、查权限、调改写、返回响应。`permissions.rs` 做权限判定，`integrity.rs` 做 SHA-256 防篡改，`trust.rs` 做项目级 filter 的信任模型，`constants.rs` 存各代理目录/命令常量。

文字上，安装线是模板方法——每代理一个 `run_<agent>_mode()` 函数按固定步骤实现（迁移旧 hook → 写 awareness → patch 配置 → 报告），但步骤执行和顺序由各代理自行决定。运行线是策略模式——每代理的 JSON payload 格式不同（snake_case `tool_name` vs camelCase `toolName` vs TOML），响应对结构也不同（`hookSpecificOutput` vs `updated_input` vs `decision`），`Host` enum 是策略选择器。`HookFormat` enum（`hook_cmd.rs:31`）自动检测 Copilot 的 VS Code/CLI/IDE 三种子格式。

## 调用链路

以 Claude Code 的 hook 改写为例（`rtk hook claude` 运行时拦截 `git status`）：

```text title="hook_cmd.rs:630 run_claude() 拦截流程"
run_claude() -> Result<()>                                       [hook_cmd.rs:630]
├── read_stdin_limited() 最多读 1 MiB (STDIN_CAP)                [hook_cmd.rs:16]
├── serde_json::from_str(input.trim())  解析失败 → Ok(()) 不崩溃
├── process_claude_payload(&v)                                    [hook_cmd.rs:574]
│   ├── 从 /tool_input/command 提取命令，空则 Ignore
│   └── decide_hook_action(cmd, Host::Claude)                    [hook_cmd.rs:273]
│       └── decide_from_verdict(cmd, check_command_for(cmd, Host::Claude))
│           ├── PermissionVerdict::Deny → HookDecision::Deny
│           ├── contains_unattestable_construct(cmd) → Defer      [hook_cmd.rs:263]
│           │   (backtick/$()/文件重定向 → 不改写，防注入)
│           ├── get_rewritten(cmd) → registry::rewrite_command()  [hook_cmd.rs:243]
│           │   ├── has_heredoc → None
│           │   ├── Config::load() → (excluded, transparent_prefixes)
│           │   └── rewrite_command(cmd, &excluded, &tp)
│           ├── Allow + rewrite → AllowRewrite(r)   # 100% 采纳
│           ├── Default + rewrite → AskRewrite(r)  # 70-85% 采纳
│           └── No rewrite → Defer
├── 构建 JSON 响应                                                 [hook_cmd.rs:601-626]
│   {"hookSpecificOutput": {
│     "hookEventName": "PreToolUse",
│     "permissionDecisionReason": "RTK auto-rewrite",
│     "updatedInput": { "command": "rtk git status", ...保留原字段 },
│     "permissionDecision": "allow"  ← 仅 AllowRewrite 时有
│   }}
└── writeln!(io::stdout(), "{output}") + audit_log(...)          [hook_cmd.rs:647-654]
```

**关键安全设计**（#1155）：`PermissionVerdict::Default` 必须映射到 `AskRewrite`（不设 `permissionDecision`）而非 `AllowRewrite`——防"无规则即放行"漏洞。`rewrite_cmd.rs:176` 的测试 `test_default_verdict_maps_to_ask_exit_code` 锁定此行为。`AskRewrite` 让 Claude Code 原生权限提示流程接管（用户确认），`AllowRewrite` 则自动放行（用户无感）。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `init::run()` `init.rs:263` | `rtk init` 入口分发 | 模板方法，校验 flag 后分发子模式 |
| `run_default_mode()` `init.rs:1142` | Claude Code 安装 | 迁移旧脚本→写 RTK.md→patch settings→filters 模板 |
| `patch_settings_json_command()` `init.rs:955` | 注册 PreToolUse hook | deep-merge + atomic_write + .bak 备份 |
| `hook_cmd::run_claude()` `hook_cmd.rs:630` | Claude hook 运行时拦截 | 1MiB stdin 上限，解析失败 Ok(()) |
| `decide_hook_action()` `hook_cmd.rs:273` | 改写决策 | 权限→不可验证构造→改写 三层 |
| `get_rewritten()` `hook_cmd.rs:234` | 调改写引擎 | heredoc 跳过 + Config 加载 + rewrite_command |
| `permissions::check_command_for()` `permissions.rs` | 权限判定 | Host enum 选规则集，Deny>Ask>Allow>Default |
| `integrity::runtime_check()` `integrity.rs:321` | 启动时校验 hook hash | Tampered → exit(1)，无 env-var bypass |
| `integrity::store_hash()` `integrity.rs:79` | 安装时存 SHA-256 | 0o444 只读，兼容 sha256sum -c |
| `trust::run_trust()` `trust.rs` | 项目 filter 信任 | SHA-256 hash，内容变更即失效 |
| `rewrite_cmd::evaluate()` `rewrite_cmd.rs:47` | `rtk rewrite` CLI | exit 0/1/2/3 = Allow/Passthrough/Deny/Ask |

</details>

## 核心实现

### init 安装流程：以 Claude Code 默认模式为例

`run_default_mode()`（`init.rs:1142`）的完整步骤是模板方法的典范：

1. **参数校验**——flag 互斥检查（codex vs opencode/claude-md/hook-only/auto-patch/no-patch），global-only 约束（cursor/opencode/windsurf/cline 需 `-g`）
2. **迁移旧 hook 脚本**——`migrate_old_hook_script()`（`init.rs:1234`）：若 `~/.claude/hooks/rtk-rewrite.sh` 存在（旧 shell 脚本模式），删除它和 `.rtk-hook.sha256`，`remove_legacy_settings_entries()` 清理指向旧脚本的条目。这是从 v0.28 的脚本模式迁移到原生 binary command 模式的清理逻辑
3. **写 RTK.md**——`write_if_changed(~/.claude/RTK.md, RTK_SLIM)`：写入 10 行精简 awareness（meta 命令、安装验证、名称冲突警告、hook 用法），由 `include_str!("../../hooks/claude/rtk-awareness.md")` 嵌入
4. **Patch CLAUDE.md**——`patch_claude_md()`（`init.rs:2585`）：末尾加 `@RTK.md` 引用行，若旧版 137 行 RTK block 存在则 `remove_rtk_block()` 迁移为 10 行引用
5. **Patch 配置**——`patch_settings_json_command(CLAUDE_HOOK_COMMAND, ...)`（`init.rs:955`）：读配置（不存在初始化 `{}`）→ `hook_already_present()` 查幂等 → 按 `PatchMode`（Ask/Auto/Skip）决定 → `insert_hook_entry()` deep-merge 在 `PreToolUse` 数组插 `{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}` → 备份 `.json.bak` → `atomic_write()`（tempfile + rename，跟随 symlink）
6. **生成 filters.toml 模板**——`generate_global_filters_template()`：在 `~/.config/rtk/filters.toml` 写注释模板

`PatchMode`（Ask/Auto/Skip）和 `FilterTrust`（Ask/Trust/Skip）让用户控制安装激进程度，`InitContext{verbose, dry_run}` 贯穿所有 init 函数支持 dry-run 预览。

### 支持的 11+ 代理：JSON 格式与安装差异

RTK 区分两类代理：**有 PreToolUse hook 改写能力的**（6 家，可自动改写命令）和**只支持纯指令注入的**（5+ 家，写 rules 文件让代理自愿用 `rtk` 前缀）。

| 代理 | 安装位置 | Hook 触发 | JSON 响应机制 |
|------|---------|---------|-------------|
| **Claude Code** | `~/.claude/settings.json` | PreToolUse + matcher `Bash` | `hookSpecificOutput` + `updatedInput` + `permissionDecision` |
| **Cursor** | `~/.cursor/hooks.json` | preToolUse + matcher `Shell` | `continue`+`permission`+`updated_input`（snake_case） |
| **Gemini CLI** | `~/.gemini/hooks/*.sh` + settings | BeforeTool + `run_shell_command` | `decision: allow/ask_user` + `hookSpecificOutput` |
| **GitHub Copilot** | `.github/hooks/` 或 `~/.copilot/` | PreToolUse | VsCode: `updatedInput`；CLI: `modifiedArgs`；IDE: deny-with-suggestion |
| **Factory Droid** | `~/.factory/hooks.json` | PreToolUse + `Execute` | `updatedInput` only，**永不**设 `permissionDecision` |
| **Mistral Vibe** | `~/.vibe/hooks.toml` | pre_tool + `bash` | `hook_specific_output.tool_input.command` |
| Codex/Windsurf/Cline/Kimi | `AGENTS.md`/`.windsurfrules`/`.clinerules` | 无 hook（纯指令注入） | N/A，代理自愿用 `rtk` 前缀 |
| Hermes/Pi/OpenCode | Python/TS 插件 | 插件内 auto-rewrite | N/A |

关键格式差异：Claude/Droid 用 snake_case `tool_name` + `tool_input.command`；Copilot CLI 用 camelCase `toolName` + `toolArgs`（JSON string）；JetBrains IDE 只尊重 top-level `deny`（返回 `permissionDecision:"deny"` + suggestion 文本，不能改写只能建议拒绝）。`HookFormat` enum（`hook_cmd.rs:31`）的 `detect_format()` 自动检测这些格式。Droid 特殊——像 Claude 但**永不**设 `permissionDecision`（`hook_cmd.rs:821`："RTK can't reproduce the verdict Droid would emit for a command it renames"），只通过 `updatedInput` 改写。

### 完整性校验：SHA-256 防篡改

`integrity.rs` 实现 hook 防篡改，因为 hook 有 `permissionDecision:"allow"` 权限，绕过代理原生权限提示——任何未授权修改都是命令注入向量（SA-2025-RTK-001 Finding F-01）。安装时 `store_hash()`（`integrity.rs:79`）计算 hook 文件 SHA-256，写入 `.rtk-hook.sha256`（格式兼容 `sha256sum -c`，权限 0o444 只读）。运行时 `runtime_check()`（`integrity.rs:321`）对比 hash，`Tampered` 则 stderr 警告 + `exit(1)` 拒绝执行；`Verified`/`NoBaseline` 静默通过。手动 `rtk verify`（`run_verify`，`:202`）打印 PASS/FAIL/WARN。

关键设计：**无 env-var bypass**——`integrity.rs:319` 注释明确："No env-var bypass is provided — if the hook is legitimately modified, re-run `rtk init -g --auto-patch`"。hash 文件 0o444 是"速度减震器"（非安全边界，攻击者可 chmod，但强制 deliberate action）。新版 binary command 模式（`rtk hook claude`）无脚本文件，integrity check 自动 no-op（`integrity.rs:326`：`if !hook_path.exists() { return Ok(()) }`）。

### 信任-before-加载：项目 filter 信任模型

`trust.rs` 对项目级 `.rtk/filters.toml` 实现信任模型——未信任的 filter 文件被**跳过**（不加载，而非"加载并警告"），`rtk trust` 存储 SHA-256 hash，内容变更即失效。`RTK_TRUST_PROJECT_FILTERS=1` + CI 环境变量可覆盖（`trust.rs:115` 警告"CI environment not detected"，防 `.envrc` 注入）。这防的是恶意仓库在 `.rtk/filters.toml` 里藏破坏性 filter，受害者 clone 后 `rtk init` 就被植入。

## 设计模式

| 模式 | 位置（文件名 + 方法名） | 为什么用 |
|------|------------------------|---------|
| 模板方法 | `init.rs:263` `run()` + 各 `run_<agent>_mode()` | 统一安装骨架，各代理填步骤 |
| 策略模式 | `permissions.rs:33` `Host` enum + `hook_cmd.rs:31` `HookFormat` | 每代理不同 JSON 格式/规则加载 |
| 完整性校验 | `integrity.rs` SHA-256 `store_hash`/`runtime_check` | hook 有 allow 权限，防篡改即防注入 |
| 信任-before-加载 | `trust.rs` 未信任跳过 | 防恶意仓库 filter 注入 |
| 兜底 | `hook_cmd.rs` 解析失败 `Ok(())` + shell 脚本 exit 0 | hook 永不阻断命令（Never Block） |

## 模块间交互

hooks/ 依赖 `discover/`（改写引擎）和 `core/`（配置/捕获/常量）：

```text title="hooks 依赖关系"
hooks/ 模块依赖:
  ├── discover::registry  → rewrite_command() / has_heredoc()      # 核心改写
  ├── discover::lexer     → split_for_permissions() / contains_unattestable_construct()
  ├── core::config        → Config::load() (exclude_commands, transparent_prefixes)
  ├── core::tracking      → get_db_path() (integrity 数据目录权限检查)
  ├── core::utils         → create_private_dir() / open_private() (audit log)
  ├── core::constants     → RTK_DATA_DIR, TRUSTED_FILTERS_JSON, FILTERS_TOML
  ├── core::toml_filter   → active_filter_summaries() / filter_parse_error()
  └── hooks::integrity    → compute_hash_bytes() (trust.rs 复用)
```

被调用方：`main.rs` 的 `HookCommands::{Claude,Cursor,Gemini,Copilot,Droid,Vibe,Check}` 路由（`main.rs:2435`）、`Commands::Init` → `init::run()`、`Commands::Rewrite` → `rewrite_cmd::run()`、`Commands::Verify` → `integrity::run_verify()`、`Commands::Trust/Untrust` → `trust::run_*()`。`analytics/gain.rs` 调 `hooks/hook_check::status()` 和 `hooks/trust::untrusted_active_filter_count()` 在仪表盘显示 hook 健康度。

## 扩展方式

**新增一个 agent 支持**：
1. `src/main.rs`——`AgentTarget` enum（`:37`）加变体，`--agent` arg 解析加匹配
2. `src/hooks/constants.rs`——加目录名、hook 命令常量、hook 文件名
3. `src/hooks/init.rs`——实现 `run_newagent_mode()`（参考 `run_droid_mode()`），在 dispatcher 加调用分支，实现 uninstall
4. `src/hooks/hook_cmd.rs`——若有 PreToolUse hook，实现 `run_newagent()` 处理 JSON payload，构建响应
5. `src/hooks/permissions.rs`——`Host` enum（`:33`）加变体，实现 `load_newagent_rules()`
6. 若代理不支持 hook 改写（只 allow/deny），走纯指令注入路径（写 `AGENTS.md`/`.windsurfrules`）

**修改 hook 脚本模板**：Gemini shell wrapper 改 `init.rs:4182` 的 `GEMINI_HOOK_SCRIPT` 常量；Copilot hook JSON 改 `init.rs:4800` 的 `COPILOT_HOOK_JSON`；Vibe TOML 改 `init.rs:4623` 的 `vibe_hook_entry()`。改后重跑 `rtk init -g` 重装，Gemini hook 的 `store_hash()` 自动更新 baseline。

**修改权限判定**：改 `permissions.rs:54` `check_command_with_rules()`（调 Deny>Ask>Allow>Default 优先级）+ `hook_cmd.rs:259` `decide_from_verdict()` + `rewrite_cmd.rs:47` `evaluate()`。三处必须保持 exit code 一致（0=Allow/1=Passthrough/2=Deny/3=Ask），`rewrite_cmd.rs:157` 的 `exit_code_protocol` 测试是安全哨兵。
