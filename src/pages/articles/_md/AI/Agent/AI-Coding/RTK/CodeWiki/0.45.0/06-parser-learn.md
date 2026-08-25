---
source:
  type: "源码解读"
  project: "RTK"
  url: "https://github.com/rtk-ai/rtk"
title: "解析与学习"
date: "2026-08-25T10:45:03+08:00"
category: [AI, Agent, "AI Coding", RTK, CodeWiki, "0.45.0"]
tags: ["RTK", "Rust", "CLI 代理", "输出解析", "使用模式学习"]
description: "RTK parser/ + learn/ 模块：三层降级解析框架与 CLI 修正模式自动检测。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/00-overview)

---

## 模块定位

`src/parser/`（~711 行）和 `src/learn/`（~942 行）是两个小而聚焦的模块，合在一起讲是因为它们都关于"理解命令结构/使用模式"且都依赖 `discover::provider` 基础设施。

**parser** 的职责是**复用格式化逻辑**——把 vitest、pnpm、playwright 等工具高度相似但原始格式各异的输出，解析成规范类型（`TestResult`/`DependencyState`），再用统一 trait 格式化。**learn** 的职责是**发现 CLI 修正模式**——扫描 Claude Code session JSONL 历史，找"错误命令 → 正确命令"配对，自动生成 `.claude/rules/cli-corrections.md` 规则文件让代理避免重复错误。两者都不参与命令执行或实时过滤——parser 是被 cmds 调用的格式化框架，learn 是事后分析。

## 模块架构

### parser/ 内部架构

parser/ 三件套：**规范类型**（`types.rs` 定义 `TestResult`/`TestFailure`/`DependencyState`/`Dependency`）、**解析框架**（`mod.rs` 的 `OutputParser` trait + `ParseResult<T>` 三层降级 + 辅助函数）、**格式化器**（`formatter.rs` 的 `TokenFormatter` trait + `FormatMode` enum）。各 cmd 实现 `OutputParser` trait（parse 工具特有逻辑），格式化由 trait 统一处理——cmd 只填解析槽，不写格式化代码。

### learn/ 内部架构

learn/ 的 `mod.rs:run()` 是检测流水线入口，`detector.rs` 是检测核心，`report.rs` 是报告生成。它依赖 `discover::provider` 的 `ClaudeProvider` 读 JSONL session（**不依赖** analytics/core/tracking——数据源是文件系统 JSONL，不是 SQLite）。

## 调用链路

### parser 被调用的流程（以 vitest 为例）

```text title="parser 调用链（vitest_cmd.rs:336）"
VitestParser::parse(stdout) -> ParseResult<TestResult>     [parser/mod.rs:80]
├── extract_json_object(stdout)  剥 pnpm prefix/dotenv banner  [parser/mod.rs:145]
├── serde_json 反序列化为 TestResult
└── Full(data) / Degraded(data, warnings) / Passthrough(truncated)
    │
FormatMode::from_verbosity(verbose)  u8 → Compact/Verbose/Ultra  [formatter.rs]
└── match parse_result {
    Full(data) => data.format(mode)                          # TokenFormatter::format
    Degraded(data, warnings) => emit_degradation_warning() + data.format(mode)
    Passthrough(_) => emit_passthrough_warning() + 截断原始输出
}
```

**数据结构变化**：`&str`（原始 stdout）→ `ParseResult<TestResult>`（三层之一）→ `FormatMode` 选择 → `String`（格式化输出）。pnpm 的流程完全一致，只是类型参数为 `DependencyState`。`pipe_cmd.rs:75` 的 `vitest_wrapper` 直接复用 `VitestParser::parse()` + `TokenFormatter::format(FormatMode::Compact)` 整套链路。

### learn 检测流程

```text title="learn/mod.rs:11 run() 检测流程"
learn::run()
├── ClaudeProvider 创建 session provider
├── 确定 project_filter（--all 则 None；--project 则指定；默认当前目录编码）
├── provider.discover_sessions(project_filter, Some(since))   # 扫 ~/.claude/projects/*.jsonl
├── 遍历 session，provider.extract_commands(session_path)    # 提取 ExtractedCommand 列表
├── 过滤：只保留有 output_content 的命令 → Vec<CommandExecution>
├── find_corrections(&all_commands)                           [detector.rs:222]
│   ├── 对每个 error 命令，在后续 CORRECTION_WINDOW=3 个命令中找相似命令
│   ├── command_similarity()  Jaccard（同 base 0.5 基础 + 参数交集 0.5）
│   ├── 排除 TDD 周期（is_tdd_cycle_error：error[E / FAILED 不算 CLI 修正）
│   ├── 排除仅路径不同（differs_only_by_path：相似度 >0.9 且 <1.0）
│   ├── 修正成功（候选非 error）confidence +0.2，上限 1.0
│   └── 低于 MIN_CONFIDENCE=0.6 丢弃
├── deduplicate_corrections(filtered)                         [detector.rs:312]
│   └── 按 (base_command, error_type, diff_token) 分组，每组取最高 confidence
├── 按 min_occurrences 过滤
└── 输出：json → JSON 打印；否则 format_console_report() + 可选 write_rules_file()
    （写入 .claude/rules/cli-corrections.md）
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `OutputParser::parse()` `parser/mod.rs:80` | 统一解析接口 | 返回 ParseResult 三层降级 |
| `extract_json_object()` `parser/mod.rs:145` | 提取 JSON 剥前缀 | 处理 pnpm prefix/dotenv banner |
| `TokenFormatter::format()` `parser/formatter.rs:40` | 按 FormatMode 分发 | 默认实现，子类填 compact/verbose/ultra |
| `FormatMode::from_verbosity()` `formatter.rs` | u8 → 三档 | Compact/Verbose/Ultra |
| `learn::run()` `learn/mod.rs:11` | 检测入口 | project_filter 三态 |
| `find_corrections()` `detector.rs:222` | 找修正配对 | Jaccard 相似度 + 时间窗口 3 |
| `classify_error()` `detector.rs:106` | 错误分类 | 6 个 LazyLock<Regex> |
| `deduplicate_corrections()` `detector.rs:312` | 去重 | 按 (base, error_type, diff_token) 分组 |

</details>

## 核心实现

### ParseResult：三层降级解析

`ParseResult<T>` enum（`parser/mod.rs:18`）是 parser 的核心抽象——确保解析失败时**永不静默返回假数据**：

```rust title="src/parser/mod.rs:18"
pub enum ParseResult<T> {
    Full(T),                    // Tier 1: 完整 JSON 解析
    Degraded(T, Vec<String>),   // Tier 2: 部分解析 + 警告
    Passthrough(String),        // Tier 3: 截断原始输出
}
```

`Full` 是完整 JSON 解析成功；`Degraded` 是部分解析（如 pnpm banner 污染了 JSON）带警告；`Passthrough` 是完全无法解析时截断原始输出加 `[RTK:PASSTHROUGH]` 标记。`extract_json_object()`（`parser/mod.rs:145`）专门处理 pnpm prefix、dotenv banner 等非 JSON 前缀，确保 vitest JSON 能被提取。**设计意图**：即使工具输出格式变更或被 banner 污染，rtk 也不会悄悄吞掉数据——要么正确解析，要么带警告降级，要么原样透传。这呼应 core/ 的「Never Block」原则。

### TokenFormatter：三档格式化

`FormatMode` enum（`formatter.rs:9`）分 `Compact`、`Verbose`、`Ultra` 三档。`Ultra` 模式（"Symbols and abbreviations"）在 Compact 之外提供极致压缩，如 `TestResult::format_ultra()` 输出 `[ok]28 [x]1 [skip]0 (1500ms)`，比 Compact 的 `PASS (28) FAIL (1)` 更短——服务于 rtk 削减 token 的核心目标。`TokenFormatter` trait 的 `format()` 默认实现按 `FormatMode` 分发到 `format_compact`/`format_verbose`/`format_ultra`——模板方法。`TestResult` 和 `DependencyState` 各自实现该 trait（`formatter.rs:49` 和 `:122`），被 vitest/playwright 和 pnpm 共享。

parser 与 cmds/format 的分工：parser 提供**规范类型定义 + 解析框架 + 格式化 trait**；各 cmd 实现 `OutputParser`（工具特有解析逻辑）。对非规范类型（如 cargo 的 `AggregatedTestResult`），cmd 自行实现同名方法 `format_compact()`（`cargo_cmd.rs:1089`），不实现 trait——"鸭子类型"式本地格式化。

### learn：CLI 修正模式检测

learn 检测的是**用户的 CLI 习惯错误**（如"总是把 `--amend` 拼成 `--ammend`"），不是命令频率（discover 做的事）。通过扫描 JSONL 历史中的 error 命令及后续修正命令，自动生成 `.claude/rules/cli-corrections.md` 让代理在后续会话避免同样错误。

关键过滤逻辑体现设计意图：
- **TDD 周期排除**（`detector.rs:191` `is_tdd_cycle_error`）：编译错误 `error[E` 和测试失败 `FAILED` 不是 CLI 拼写错误，排除
- **路径探索排除**（`detector.rs:208` `differs_only_by_path`）：`cat file1.txt` → `cat file2.txt` 是探索不是修正，相似度 >0.9 且 <1.0 时排除
- **时间窗口**（`detector.rs:129` `CORRECTION_WINDOW = 3`）：修正通常紧随错误之后，只在后续 3 个命令中找
- **相似度**（`detector.rs:154` `command_similarity`）：Jaccard，同 base command 0.5 基础分 + 参数交集最多 0.5 分；修正成功（候选非 error）confidence +0.2，上限 1.0；低于 `MIN_CONFIDENCE=0.6` 丢弃

`ErrorType` enum（`detector.rs:6`）分 7 类（UnknownFlag/CommandNotFound/WrongSyntax/WrongPath/MissingArg/PermissionDenied/Other），`classify_error`（`:106`）用 6 个 `LazyLock<Regex>` 匹配。`deduplicate_corrections`（`:312`）按 `(base_command, error_type, diff_token)` 分组，每组取最高 confidence 示例，合并 `occurrences`。

## 设计模式

| 模式 | 位置（文件名 + 方法名） | 为什么用 |
|------|------------------------|---------|
| Strategy / Formatter | `formatter.rs:29` `TokenFormatter` + `FormatMode` | 同一数据按不同策略格式化 |
| 三层降级 | `mod.rs:18` `ParseResult<T>` Full/Degraded/Passthrough | 永不静默返回假数据 |
| 模板方法 | `mod.rs:40` `TokenFormatter::format()` 默认实现 | 按 FormatMode 分发到子方法 |
| 检测器/模式匹配 | `detector.rs:222` `find_corrections` | 正则 + 相似度 + 时间窗口 |
| Provider trait | `provider.rs:33` `SessionProvider` | 抽象数据源，当前仅 ClaudeProvider |

## 模块间交互

```text title="parser + learn 依赖关系"
main.rs
  ├── Commands::Learn → learn::run()          (main.rs:2301)
  └── Commands::Discover → discover::run()

learn::run() (learn/mod.rs)
  ├── 依赖 discover::provider::{ClaudeProvider, SessionProvider}  # 读 ~/.claude/projects JSONL
  ├── detector::find_corrections()
  ├── detector::deduplicate_corrections()
  └── report::format_console_report() / write_rules_file()

cmds/js/vitest_cmd.rs, pnpm_cmd.rs, playwright_cmd.rs
  ├── 实现 OutputParser trait (parser/mod.rs)
  └── 调用 TokenFormatter::format(mode)

parser/formatter.rs
  └── 依赖 core::truncate::CAP_INVENTORY
parser/mod.rs
  └── 依赖 core::config::limits().passthrough_max_chars
```

**关键**：learn **不依赖** analytics/core/tracking 读历史——它直接依赖 `discover::provider` 读 Claude Code JSONL session 文件。discover 和 learn 共享同一套 provider 基础设施，但 discover 检测"可优化命令"（高频命令 + 节省机会），learn 检测"CLI 修正模式"（错误→修正配对）。parser 被 cmds（vitest/pnpm/playwright）调用，依赖 core 的截断常量和配置。

## 扩展方式

**新增一种输出格式**（如 Markdown 表格）：改 `formatter.rs` 的 `FormatMode` enum 加 `Markdown` 变体 → 更新 `from_verbosity()` 和 `format()` 的 match → 为 `TestResult`/`DependencyState` 的 `impl TokenFormatter` 加 `format_markdown()`。各 cmd 的 `format_test_output()` 不需改——通过 `data.format(mode)` 自动获得新格式。

**新增错误类型**（如 Timeout）：改 `detector.rs:6` 的 `ErrorType` enum 加变体 → `as_str()` 加分支 → 加对应 `LazyLock<Regex>` 静态 → `classify_error()`（`:106`）加匹配分支。`report.rs` 通过 `error_type.as_str()` 自动显示。

**新增 parser 实现**（如 jest）：在 `src/cmds/js/` 新建 `jest_cmd.rs`，实现 `OutputParser for JestParser`（`type Output = TestResult`），复用 `extract_json_object()` 提取 JSON，解析 jest 的 `numPassedTests` 等字段为 `TestResult`——`TestResult` 已有 `TokenFormatter` 实现，无需额外格式化代码。
