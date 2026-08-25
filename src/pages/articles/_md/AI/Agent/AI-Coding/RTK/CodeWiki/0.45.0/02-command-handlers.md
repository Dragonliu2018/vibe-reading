---
source:
  type: "源码解读"
  project: "RTK"
  url: "https://github.com/rtk-ai/rtk"
title: "命令处理器"
date: "2026-08-25T10:45:03+08:00"
category: [AI, Agent, "AI Coding", RTK, CodeWiki, "0.45.0"]
tags: ["RTK", "Rust", "CLI 代理", "过滤策略"]
description: "RTK cmds/ 模块：100+ 命令的专用输出过滤，按 ecosystem 分组，复用 core 统一骨架。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/00-overview)

---

## 模块定位

`src/cmds/`（~44407 行）是全仓最大的模块，承载 **100+ 命令的专用输出过滤逻辑**。它按语言/ecosystem 分组（git/rust/js/python/go/jvm/dotnet/cloud/php/ruby/scala/system 共 11 组），每组一个 `mod.rs` + 若干 `*_cmd.rs`。它的职责边界是：**实现每个命令"输出长什么样、该保留什么"的过滤逻辑**，但执行骨架（spawn/捕获/守卫/统计）复用 `core/`——cmds 只填过滤函数，不重写执行框架。

## 模块架构

cmds/ 的内部组织遵循两条主线：**统一执行骨架**（所有命令共享 `run→exec→filter→never_worse→track` 模板方法）和**多样过滤策略**（12 类策略按命令特性选择）。骨架来自 core/，策略在各 `*_cmd.rs` 内实现。

![RTK 命令过滤策略分类](/vibe-reading/images/articles/rtk-codewiki-0.45.0/cmds-filter-strategies.svg)

文字上，cmds/ 把 100+ 命令按 ecosystem 分 11 组：git（git/gh/glab/gt，~8314 行）、rust（cargo，~3153）、js（npm/pnpm/tsc/vitest/eslint/next/playwright/prisma，~3941）、python（ruff/pytest/mypy/pip/uv）、go（go/golangci）、jvm（mvn/gradlew）、dotnet（dotnet/binlog，~5128）、cloud（aws/docker/kubectl/curl/wget/psql，~4844）、php（phpunit/pest/phpstan 等）、ruby（rspec/rubocop）、scala（sbt）、system（grep/ls/tree/find/json/log/read 等，~6649 行）。每组下每个命令一个 `*_cmd.rs`，文件即代码位置——找 cargo 过滤逻辑直接看 `cmds/rust/cargo_cmd.rs`。

## 调用链路

以 `cargo test` 为例展示一条完整命令链路（模板方法骨架 + 策略填充）：

```text title="cargo test 完整链路"
main.rs:2249 Commands::Cargo { command } => match command {
    CargoCommands::Test { args } => cargo_cmd::run(CargoCommand::Test, &args, cli.verbose)?  [main.rs:2249]
    CargoCommands::Other(args) => cargo_cmd::run_passthrough(&args, cli.verbose)?,           # 未识别兜底
}
  ↓
cargo_cmd::run(cmd, args, verbose) -> Result<i32>            [cargo_cmd.rs:25]
└── match cmd { CargoCommand::Test => run_test(args, verbose) }
    └── run_cargo_streamed("test", args, verbose,             [cargo_cmd.rs:320]
            Box::new(BlockStreamFilter::new(CargoTestHandler::new())))   # 填策略
        ├── resolved_command("cargo")                          [utils.rs]  PATHEXT-aware
        ├── args_utils::restore_double_dash(args)              # 恢复 clap 吃掉的 --
        └── runner::run_streamed(cmd, "cargo test", args_str,
                filter, RunOptions::with_tee("cargo_test"))   [runner.rs]  ← 进入 core 骨架
            └── stream::run_streaming → CargoTestHandler::feed_line/flush/on_exit
```

**数据结构变化**：clap `CargoCommands::Test` enum → `CargoCommand::Test` → `BlockStreamFilter<CargoTestHandler>`（`Box<dyn StreamFilter>`）→ `runner::run_streamed` → `StreamResult{exit_code, raw, filtered}` → `never_worse` → stdout + SQLite。`CargoTestHandler`（`cargo_cmd.rs:124`）实现 `BlockHandler` trait（`stream.rs:17`）：`should_skip()` 跳过 `Compiling`/`Finished`/`test ... ok` 噪声行，`is_block_start()` 识别 `---- ` 开头的失败测试块，`format_summary()` 聚合 `test result:` 行输出 `10 passed; 0 failed` 紧凑格式。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `cargo_cmd::run()` `cargo_cmd.rs:25` | cargo 子命令分发 | 按 CargoCommand enum 路由到 run_test/build/clippy |
| `run_cargo_streamed()` `cargo_cmd.rs:320` | cargo 通用流式路径 | restore_double_dash 恢复 --，with_tee 溢出恢复 |
| `CargoTestHandler` `cargo_cmd.rs:124` | cargo test 失败块过滤 | BlockHandler，聚合 AggregatedTestResult |
| `git::run_status()` `git.rs:824` | git status 紧凑格式 | exec_capture + never_worse，非 runner 骨架 |
| `filter_log_output()` `git.rs:558` | git log 格式注入+body 截断 | 注入 --pretty，每 commit 保留 header+3 行 body |
| `git::run_passthrough()` `git.rs:2049` | 未识别 git 子命令透传 | .status() + track_passthrough（不计 token） |
| `search` 系列函数 `search.rs:495-722` | grep/rg 按文件分组+tee 溢出 | 仅分组缩减时用分组形式，否则 faithful baseline |
| `compact_ls()` `ls.rs:22` | ls 紧凑+树形+计数 | 解析失败回退 raw（非英语 locale 兜底） |
| `filter_tree_output()` `tree.rs:14` | tree 移除摘要+噪声目录 | 自动注入 -I 排除 node_modules/.git |

</details>

## 核心实现

### 统一执行骨架：run→exec→filter→guard→track

每个命令处理器遵循统一的四阶段骨架，但具体执行方式因命令而异。骨架来自 `core::runner`，cmds 只填两个槽：**执行策略**（选 `run_filtered`/`run_streamed`/`run_passthrough`）和**过滤策略**（闭包或 `StreamFilter` 实现）。以 `cargo test` 为例，它选 `run_streamed` + `BlockStreamFilter<CargoTestHandler>`——因为 test 输出是流式的、有明确的失败块边界，流式过滤能实时输出且只保留失败块。而 `ls` 选 `run_filtered`（整块过滤），因为输出是静态的、一次性解析即可。

**并非所有命令都走 runner 骨架**。`git log`/`diff`/`show`/`status` 等复杂命令自行编排多步 capture + 过滤——`git log` 要注入 `--pretty=format:...` 格式串、按 `---END---` 分割 commit 块、每块保留 header + 最多 3 行 body（过滤 `Signed-off-by`/`Co-authored-by`）、header 截断到 80 字符，这些需要多次子进程调用和定制编排，所以 `git.rs` 直接调 `exec_capture()` 后自行过滤，只在最后调 `never_worse()` + `timer.track()`。这是模板方法骨架的合理例外——git 输出格式太特殊，强行套骨架会割裂逻辑。

### 12 类过滤策略

cmds/ 的核心价值是**按命令特性选过滤策略**，ARCHITECTURE.md 归纳为 12 类：

- **统计提取**（git status/log/diff）：5000 行 → "3 files, +142/-89"，90-99%
- **仅错误**（runner err 模式）：stdout+stderr 混合 → 仅 stderr，60-80%
- **按模式分组**（lint/tsc/grep）：100 错误散布 → "no-unused-vars: 23"，80-90%
- **去重**（log_cmd）：重复行 → Unique+count "[ERROR]...(×5)"，70-85%
- **仅结构**（json_cmd）：大 JSON → Keys+types，80-95%
- **代码过滤**（read/smart）：按 FilterLevel 剥注释/实现体，20-90%
- **失败聚焦**（vitest/playwright）：100 测试 → 仅 2 失败，94-99%
- **树形压缩**（ls）：扁平列表 → 树+计数，50-70%
- **进度过滤**（wget/pnpm install）：ANSI 进度条 → 最终结果，85-95%
- **JSON/文本双模**（ruff/pip）：JSON 优先，文本兜底，80%+
- **状态机解析**（pytest）：test_name→PASS/FAIL 状态机，90%+
- **NDJSON 流**（go test）：逐行 JSON 聚合，90%+

每类策略对应 core/ 的某种执行路径：统计提取/仅错误/去重/仅结构多用 `run_filtered`（整块），失败聚焦/NDJSON 流多用 `run_streamed`（流式 + handler），代码过滤用 `filter.rs` 的 `FilterStrategy`。策略选择是 cmds 的核心设计决策。

### grep/rg：分组 + tee 溢出的代表性实现

`search.rs`（~1655 行）是复杂过滤的典范，体现"忠实基线"原则：

```rust title="src/cmds/system/search.rs:712 忠实基线判断"
// 仅在分组确实缩减了输出时才使用分组形式
if capped && rtk_output.len() < plain.len() {
    // 输出按文件分组的紧凑形式
} else {
    // 输出 faithful baseline（原始格式截断）
}
```

它先用 `extract_pattern_path()` 分离 patterns/paths/flags，用 `engine_capture()` 执行真实 grep/rg（追加 `-n -H --null` 解析辅助标记），`parse_match_line()` 解析 `file\0line:content` 格式，按文件分组到 `HashMap<String, Vec<(usize, bool, String)>>`。每文件 cap（`config::limits().grep_max_per_file`）、全局 cap（`max_results`），溢出部分通过 `tee::force_tee_tail_hint()` 写临时文件 + 恢复提示。**关键**：只在分组形式确实比原始短时才用它——否则输出 faithful baseline，这呼应 CONTRIBUTING.md 的「Transparency」原则（过滤后输出应是"更短的真实输出"，不是新格式）。管道输入走 `SearchStreamFilter` 流式路径（`search.rs:407`）。解析失败时（`unparsed_signal > 0`）回退 passthrough。

### 三层 passthrough 兜底体系

cmds/ 的「Never Block」原则落地为三层兜底：

1. **命令级**：`GitCommands::Other(args) => git::run_passthrough()`（`main.rs:1789`）——用户运行 `rtk git tag`，tag 不在已知子命令列表，直接 `.status()` 透传 + `track_passthrough()`（仅记时，不计 token）。每 ecosystem 的 `*_cmd.rs` 都有 `run_passthrough`。
2. **全局**：`run_fallback()`（`main.rs:1287`）——clap 解析失败时，先查 `toml_filter::find_matching_filter()`（用户 TOML 配置的自定义规则），找不到则 raw passthrough。但有白名单保护：`RTK_META_COMMANDS`（如 `gain`/`init`/`discover`）不 fallback（`main.rs:1297`），避免 `rtk gain --badtypo` 误执行 `gain` 二进制。
3. **解析失败**：`search.rs:572`——grep 输出无法按 `file\0line:content` 格式解析时回退 passthrough；`ls.rs:97`——`compact_ls` 解析 0 行时回退 raw（非英语 locale 兜底）。

## 设计模式

| 模式 | 位置（文件名 + 方法名） | 为什么用 |
|------|------------------------|---------|
| 模板方法 | `runner.rs:159` 骨架 + 各 `*_cmd.rs:run()` | 统一 run→exec→filter→guard→track，cmds 填策略 |
| 策略模式 | `runner.rs:84` RunMode + `cargo_cmd.rs:124` CargoTestHandler | 每命令不同过滤逻辑，同骨架 |
| 守卫模式 | `guard.rs:6` never_worse（cmds 各过滤路径调用） | 过滤失败时安全回退 raw |
| 适配器模式 | `search.rs` SearchStreamFilter 适配管道输入 | grep 管道流式过滤 |
| 兜底链 | `main.rs:1287` run_fallback + 各 `run_passthrough` | 三层 passthrough 保证不阻断 |

## 模块间交互

cmds/ 几乎只依赖 `core/`（单向），是被依赖最少的模块（其他模块不调 cmds）：

```text title="cmds → core 依赖（最高频）"
cmds/*/xxx_cmd.rs
  ├── core::runner     — run_filtered / run_streamed / run_passthrough + RunOptions
  ├── core::stream     — exec_capture, StreamFilter/BlockHandler/LineHandler
  ├── core::tracking   — TimedExecution::start() / track() + estimate_tokens
  ├── core::guard      — never_worse()
  ├── core::truncate   — CAP_ERRORS(20) / CAP_WARNINGS(10) / CAP_LIST(20) / CAP_INVENTORY(50)
  ├── core::utils      — resolved_command(), strip_ansi(), exit_code_from_status()
  ├── core::args_utils — restore_double_dash() (恢复 clap trailing_var_arg 吃掉的 --)
  ├── core::config     — limits() (grep_max_per_file 等运行时配置)
  ├── core::tee        — tee_and_hint() / force_tee_tail_hint() (溢出写临时文件)
  └── core::toml_filter — find_matching_filter() (TOML 热加载过滤规则)
```

`main.rs` 用 clap `Commands` enum 定义所有已知命令（~100+ 子命令变体），`run_cli()` match 分发到各 `cmds::*::run()`。`GitCommands::Other` / `CargoCommands::Other` 等 `Other(args)` 变体走各模块的 `run_passthrough()` 兜底。cmds/ 内部无跨组依赖——git 不调 cargo，保持组间独立演进。

## 扩展方式

**新增命令过滤**（如 `rtk make`）：
1. 在 `src/cmds/system/` 新建 `make_cmd.rs`，定义 `pub fn run(args, verbose) -> Result<i32>`，用 `resolved_command("make")` 建子进程
2. 选执行路径：简单过滤用 `runner::run_filtered(cmd, "make", &args.join(" "), |raw| filter_make(raw), RunOptions::with_tee("make"))`
3. 实现 `fn filter_make(raw) -> String`（用 `CAP_ERRORS`/`CAP_WARNINGS` 截断）
4. 在 `src/cmds/system/mod.rs` 加 `pub mod make_cmd;`
5. 在 `src/main.rs` 的 `Commands` enum 加 `Make { args: Vec<String> }` 变体 + `run_cli` match 加分支
6. 或不改 main.rs，用户在 `.rtk/filters.toml` 写声明式 TOML filter（走 `run_fallback`→`toml_filter` 路径）
7. 同时在 `src/discover/rules.rs` 的 `RULES` 加改写规则，让 hook 能把 `make` 改写成 `rtk make`

**修改某命令过滤策略**（如让 cargo test 显示通过测试名）：改 `cargo_cmd.rs` 的 `CargoTestHandler::should_skip()`（`:143`，当前跳过 `test xxx ... ok`）和 `format_summary()`（`:197`，调整 `AggregatedTestResult` 聚合），注意 `never_worse` 会限制输出膨胀——超过 raw 就回退。
