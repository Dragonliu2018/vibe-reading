---
source:
  type: "源码解读"
  project: "RTK"
  url: "https://github.com/rtk-ai/rtk"
title: "改写引擎"
date: "2026-08-25T10:45:03+08:00"
category: [AI, Agent, "AI Coding", RTK, CodeWiki, "0.45.0"]
tags: ["RTK", "Rust", "CLI 代理", "命令改写"]
description: "RTK discover/ 模块：命令三态分类、复合命令改写流水线、60+ 正则规则集。"
readingTime: "21 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/00-overview)

---

## 模块定位

`src/discover/`（~9296 行）是 RTK 的**命令改写引擎**——把 `git status` 改写成 `rtk git status` 的全部逻辑都在这里。它被 `hooks/` 调用（hook 拦截到命令后调 `rewrite_command` 改写），也被 `analytics/` 和 `learn/` 调用（用 `classify_command` 分类历史命令找漏改写机会）。它的职责边界是：**分类与改写命令字符串**，不执行命令、不过滤输出——那是 `core/` 和 `cmds/` 的事。改写逻辑与过滤逻辑解耦，独立于任何 LLM 代理。

`registry.rs`（5656 行）是全仓 god module 之一，承载改写流水线核心；`lexer.rs`（1365 行）是引号感知的 shell 词法分析器；`rules.rs`（1009 行）是 60+ 正则规则集。

## 模块架构

discover/ 的核心是一条递归下降的改写流水线：入口 `rewrite_command` 检查 heredoc/算术展开 → 按单行/多线分发 → `rewrite_compound` tokenize 后按 operator 分割并逐段改写 → `rewrite_segment_inner` 剥透明前缀/尾部重定向后调 `classify_command` → `classify_command` 用 `REGEX_SET` 三态分类。`lexer.rs` 提供 tokenize，`rules.rs` 提供规则集。

![命令改写流水线](/vibe-reading/images/articles/rtk-codewiki-0.45.0/rewrite-pipeline.svg)

文字上，流水线分两层：**结构层**（`rewrite_compound`）负责复合命令分割——遇到 `&&`/`||`/`;` 改写两侧、遇到 `|` 只改最后一段、遇到 `&` 改写两侧；**语义层**（`rewrite_segment_inner` + `classify_command`）负责单个命令的分类与改写——剥透明前缀（`uv run`/`noglob`/`docker exec`）、尾部重定向（`2>&1`）、查 `REGEX_SET` 匹配规则。两层都递归——`rewrite_segment_inner` 递归处理嵌套前缀（深度上限 `MAX_PREFIX_DEPTH=10`），多行命令逐行改写但保守跳过含 shell 关键字（for/while/if）的块。

## 调用链路

完整调用链（以 `cargo fmt --all && cargo test 2>&1 | tail -20` 为例）：

```text title="registry.rs 改写流水线"
rewrite_command(cmd, excluded, transparent_prefixes) -> Option<String>   [registry.rs:569]
├── collapse_line_continuations(cmd)  \n→空格(bash 语义)                   [587]
├── has_heredoc(cmd) || cmd.contains("$((") → None                        [593-595]
├── compile_exclude_patterns(excluded) + normalize_transparent_prefixes  [597-598]
└── rewrite_single / rewrite_multiline_block
    └── rewrite_compound(cmd, excluded, tp) -> Option<String>             [registry.rs:1035]
        ├── tokenize(cmd)  → Vec<ParsedToken>{kind, value, offset}        [1040]  lexer.rs
        ├── 遍历 tokens, 在 operator 边界分割
        │   ├── Operator(&&/||/;) → rewrite_segment(两侧) 拼操作符
        │   ├── Pipe(|) → analyze_pipeline + rewrite_pipeline_final_stage [1084-1110]
        │   │              只改最后一段（pipeline_final_safe 规则才放行）
        │   └── Shellism(&) → rewrite_segment(两侧)
        └── 任一段被改写 → Some(拼接结果)
            └── rewrite_segment_inner(seg, ..., RewriteContext, depth)    [registry.rs:1287]
                ├── strip_disabled_prefix → RTK_DISABLED=1 → None(stderr 警告) [1303-1313]
                ├── 递归剥 builtin transparent 前缀(uv run/noglob/command…)  [1324-1341]
                ├── 递归剥 user transparent 前缀(docker exec mycontainer)   [1345-1353]
                ├── strip_trailing_redirects("cargo test 2>&1"→("cargo test"," 2>&1")) [1357]
                ├── 已 rtk 前缀 → Some(原样)                               [1360]
                ├── head/tail 短路 → rewrite_line_range                     [Normal context]
                ├── classify_command(cmd_part) -> Classification           [1381]
                │   ├── IGNORED_EXACT/PREFIXES 检查
                │   ├── ENV_PREFIX 剥 sudo/env/VAR=val
                │   ├── strip_absolute_path(/usr/bin/grep→grep)
                │   ├── strip_git_global_opts(git -C /tmp status→git status)
                │   ├── REGEX_SET.matches(cmd) → 取最具体匹配             [165]
                │   └── 子命令查 subcmd_savings/subcmd_status 覆盖默认值
                ├── is_excluded → None
                ├── rule = RULES.iter().find(rtk_cmd==rtk_equivalent)
                └── strip_word_prefix("git status","git status")→Some("") → "rtk git status"
```

**结果**：`cargo fmt --all && cargo test 2>&1 | tail -20` → `rtk cargo fmt --all && rtk cargo test 2>&1 | tail -20`（`tail -20` 在管道最后段保持 raw，因为 `tail` 非 `pipeline_final_safe`）。

数据结构变化：`&str`（原始命令）→ `Vec<ParsedToken>`（lexer，带字节偏移）→ 按 operator 切片回 `&str`（用 `cmd[seg_start..tok.offset]`）→ `Classification` enum → `Option<String>`（改写后命令）。字节偏移是关键——改写器要从原始字符串精确提取子串重组，无偏移无法安全切片。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `rewrite_command()` `registry.rs:569` | 改写入口 | heredoc/$(( 跳过，行续行合并 |
| `rewrite_single()` `registry.rs:608` | 单行命令改写 | 已 rtk 前缀短路返回 |
| `rewrite_compound()` `registry.rs:1035` | 复合命令分割 | operator 两侧改写，管道只改最后段 |
| `rewrite_pipeline_final_stage()` `registry.rs:1007` | 管道末段改写 | 只允许 pipeline_final_safe 规则 |
| `rewrite_segment_inner()` `registry.rs:1287` | 单段核心改写 | 递归剥透明前缀，深度上限 10 |
| `classify_command()` `registry.rs:107` | 三态分类 | REGEX_SET 批量匹配取最具体 |
| `tokenize()` `lexer.rs:36` | shell 词法分析 | 引号感知，字节偏移 |
| `strip_disabled_prefix()` `registry.rs` | 剥环境变量前缀 | RTK_DISABLED=1 跳过 |
| `rewrite_line_range()` `registry.rs:1145` | head/tail 短路 | → `rtk read file --max-lines N` |

</details>

## 核心实现

### Classification：命令三态分类

`Classification` enum（`registry.rs:17`）是改写引擎的核心抽象——每条命令落入三态之一决定是否改写：

```rust title="src/discover/registry.rs:17"
pub enum Classification {
    Supported {
        rtk_equivalent: &'static str,   // 如 "rtk git"
        category: &'static str,          // 如 "Git"
        estimated_savings_pct: f64,      // 如 70.0
        status: super::report::RtkStatus,
    },
    Unsupported { base_command: String }, // 已知命令但 RTK 不支持
    Ignored,                              // shell 内建/无输出（cd/echo/true）
}
```

`Supported` 的 `status` 子字段（`report.rs:11` 的 `RtkStatus`）进一步分 `Existing`（有专用 handler 过滤，如 `git status → git.rs:run_status()`）、`Passthrough`（透传不过滤，如 `cargo fmt`）、`NotSupported`。`classify_command` 的分类流程是层层过滤：先查 `IGNORED_EXACT`（10 个 shell 关键字）和 `IGNORED_PREFIXES`（44 个无输出命令），再用 `ENV_PREFIX` 正则剥 `sudo`/`env`/`VAR=val` 前缀，`strip_absolute_path` 把 `/usr/bin/grep` 归一为 `grep`，`strip_git_global_opts` 把 `git -C /tmp status` 归一为 `git status`，最后 `REGEX_SET.matches()` 批量匹配取最具体的（最后一个匹配）。子命令级别用 `subcmd_savings`/`subcmd_status` 覆盖默认值（如 `cargo test` 85% vs `cargo fmt` 0%）。

### lexer.rs：引号感知的 shell 词法分析器

`tokenize_inner()`（`lexer.rs:36`）逐字符扫描产生 `Vec<ParsedToken>`。`TokenKind` 分 `Arg`、`Operator`（`&&`/`||`/`;`/`\n`）、`Pipe(PipeKind)`（`|` 或 `|&`）、`Redirect`、`Shellism`（通配符/命令替换/后台 `&`）。每个 token 带 `offset` 字节偏移。

关键设计是**引号感知**：`'` 和 `"` 内的操作符不被识别——`git commit -m "Fix && Bug"` 中的 `&&` 不分割。**`$` 变量区分**：`$HOME` 是 `Arg`（shell 执行时展开，不改写），`$(date)` 是 `Shellism`（命令替换，不可安全改写）。**`|&` 原子性**：`|&` 产生一个 `Pipe(StdoutAndStderr)` token，不拆成 `|` + `&`。辅助函数 `split_on_operators()`（`lexer.rs:405`）按 operator/pipe 分割，`stop_at_pipe=true` 时遇第一个 `|` 就返回（改写用），`false` 时穿透管道（权限检查用）。`contains_unattestable_construct()`（`lexer.rs:302`）检测命令/进程替换和文件重定向——这些不能被权限系统自动允许（防注入）。

### rules.rs：60+ 正则规则集

`RULES` 常量数组（`rules.rs:38-955`）含约 60 条 `RtkRule`，覆盖 Git、GitHub/GitLab CLI、Cargo、npm/pnpm/npx、文件操作、构建工具、基础设施（docker/kubectl/aws/psql/helm/terraform）等。

```rust title="src/discover/rules.rs:3 RtkRule 结构"
pub struct RtkRule {
    pub pattern: &'static str,           // 正则，如 r"^cargo\s+(build|test|clippy)"
    pub rtk_cmd: &'static str,           // "rtk cargo"
    pub pipeline_final_safe: bool,        // 管道末段是否安全（仅 grep/rg 为 true）
    pub rewrite_prefixes: &'static [&'static str], // ["cargo"] 或 tsc 的 15 个变体
    pub category: &'static str,
    pub savings_pct: f64,
    pub subcmd_savings: &'static [(&'static str, f64)],  // 子命令级节省率
    pub subcmd_status: &'static [(&'static str, RtkStatus)],
}
```

规则编译用两个 `LazyLock` 静态（`registry.rs:54-62`）：`REGEX_SET: LazyLock<RegexSet>` 做批量快速匹配（一次扫描所有模式），`COMPILED: LazyLock<Vec<Regex>>` 做单条捕获组提取。`rewrite_prefixes` 用 `strip_word_prefix` 做词边界匹配——`strip_word_prefix("cargo test", "cargo")` 返回 `Some("test")`，拼接 `"rtk cargo" + " " + "test"` = `"rtk cargo test"`。复杂前缀如 tsc 规则有 15 个 `rewrite_prefixes`（`npm exec tsc`/`npx tsc`/`pnpm dlx tsc`/`tsc` 等），保证各种包管理器调用形式都能匹配。

## 设计模式

| 模式 | 位置（文件名 + 方法名） | 为什么用 |
|------|------------------------|---------|
| 流水线模式 | `rewrite_command→compound→segment_inner→classify` | 每层明确职责，上层结构分割，下层语义匹配 |
| 策略模式 | `rewrite_compound:1059` 按 token kind 分策略 | operator/pipe/shellism 各自不同处理 |
| 递归下降 | `rewrite_segment_inner:1287` 递归剥透明前缀 | `noglob shadowenv exec -- git status` 三层递归 |
| 短路模式 | `rewrite_line_range:1145` head/tail + `gh --json→None` | 特殊命令绕过完整 classify 流程 |
| 安全保守模式 | `classify_line` 多行 Unsafe 整块跳过 | for/while/if 不配对括号 = Unsafe → None |

## 模块间交互

discover/ 被多方调用，是次级 hub：

- **`hooks/hook_cmd.rs`**（AI agent hook 入口）：`use crate::discover::registry::{has_heredoc, rewrite_command}`。hook 拦截命令后调 `rewrite_command` 改写，返回 JSON `{"hookSpecificOutput":{"updatedInput":{"command":"rtk git status"}}}`。
- **`hooks/rewrite_cmd.rs`**（`rtk rewrite` CLI 子命令）：调 `registry::rewrite_command`，用 exit code 0/1/2/3 区分 Allow/Passthrough/Deny/Ask。
- **`main.rs`**（`rtk hook check`）：直接调 `rewrite_command` 打印结果。
- **`discover/mod.rs`**（`rtk discover`）：用 `classify_command`/`split_command_chain` 扫描 session JSONL 统计漏改写的命令。
- **`analytics/session_cmd.rs` + `gain.rs`**：用 `classify_command` 做 session 分析和 RTK_DISABLED 使用率警告。
- **`learn/mod.rs`**：用 `discover::provider`（`ClaudeProvider`）读 JSONL session。

`provider.rs` 的 `ClaudeProvider` 实现 `SessionProvider` trait（`provider.rs:33`），读 `~/.claude/projects/<encoded-path>/*.jsonl`，`extract_commands()`（`provider.rs:152`）两遍扫描 JSONL：第一遍收集 `tool_use` Bash 命令的 ID 和内容，第二遍匹配 `tool_result` 的输出长度、内容预览（前 1000 字符）和 `is_error` 标志。这是 discover 和 learn 共享的数据源基础设施。

## 扩展方式

**新增一个命令的改写规则**（如 `zig` 编译器）：在 `src/discover/rules.rs` 的 `RULES` 数组加一条 `RtkRule`（`pattern: r"^zig\s+(build|test|run)\b"`、`rtk_cmd: "rtk zig"`、`rewrite_prefixes: &["zig"]`、`category: "Build"`、`savings_pct: 70.0`）。`classify_command` 和 `rewrite_segment_inner` **无需修改**，会自动通过 `REGEX_SET` 匹配新规则。但还需在 `src/cmds/` 实现 `rtk zig` 的过滤逻辑，否则改写后无 handler 会走 passthrough。

**修改复合命令分割逻辑**（如允许改写管道中间段）：改 `registry.rs:1035` 的 `rewrite_compound` 和 `:1007` 的 `rewrite_pipeline_final_stage`——当前只改最后一段，改中间段需在 `analyze_pipeline` 收集所有 pipe 段、对每段调 `rewrite_segment_inner`（需引入 `pipeline_middle_safe` 字段区分安全规则）。这是个谨慎的改动，因为改写管道生产者会破坏消费者依赖的原始格式。

**添加用户配置的 transparent prefix**：用户在 `config.toml` 的 `[hooks]` 节加 `transparent_prefixes = ["docker exec mycontainer"]`，**无需改代码**。`rewrite_command` 接收该参数，`normalize_transparent_prefixes`（`registry.rs:1252`）去重 + 按长度降序排序（保证 `docker exec app` 优先于 `docker` 匹配），`rewrite_segment_inner` 递归剥离和拼回。
