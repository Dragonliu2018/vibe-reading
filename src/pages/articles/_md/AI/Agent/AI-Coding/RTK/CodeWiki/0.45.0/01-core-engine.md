---
source:
  type: "源码解读"
  project: "RTK"
  url: "https://github.com/rtk-ai/rtk"
title: "核心引擎"
date: "2026-08-25T10:45:03+08:00"
category: [AI, Agent, "AI Coding", RTK, CodeWiki, "0.45.0"]
tags: ["RTK", "Rust", "CLI 代理", "Token 优化"]
description: "RTK core/ 模块：子进程执行、输出捕获、过滤管道、降级守卫与 token 统计的统一骨架。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/00-overview)

---

## 模块定位

`src/core/`（~9842 行）是 RTK 全仓最高扇入的 hub——`tracking` 被引用 27 次、`runner` 20 次、`guard` 19 次、`stream` 15 次。它承载所有命令共享的**执行/捕获/过滤/统计/降级统一骨架**，把"spawn 子进程 → 读 stdout/stderr → 过滤 → 守卫 → 记录"这条流水线固化成一套模板方法，让 `cmds/` 下的 100+ 命令只填过滤逻辑、不重写执行框架。它的核心职责边界是：**提供执行骨架与安全网，不实现具体命令的过滤逻辑**（那是 `cmds/` 的事）。

## 模块架构

core/ 内部有一条清晰的执行主干：`runner`（模板方法入口）→ `stream`（spawn 子进程并捕获）→ 过滤（来自 cmds 的闭包或 `toml_filter` 的 DSL 管道）→ `guard`（never_worse 降级）→ `tee`（溢出恢复）→ `tracking`（写 SQLite）。周围环绕 `filter`（源码注释剥离）、`truncate`（截断常量）、`config`（TOML 配置）、`utils`（PATHEXT-aware 命令解析、私有文件）等基础设施。

![core/ 模块内部架构](/vibe-reading/images/articles/rtk-codewiki-0.45.0/core-engine-internal.svg)

文字上，core/ 内部分三层：**执行主干**（runner→stream→guard→tee→tracking）是所有命令的必经之路，无论命令走 `run_filtered` 还是 `run_streamed`，最终都汇入 `guard::never_worse` 和 `tracking::track`；**过滤来源**有两条——cmds 提供的闭包/`StreamFilter` 实现（命令专用），以及 `toml_filter` 的声明式 8 阶段管道（用户 TOML 配置热加载）；**基础设施**（filter/truncate/config/utils）被前两层按需引用。这样划分让执行框架与过滤策略解耦——加新过滤策略不用动执行主干，改执行主干不用动过滤逻辑。

## 调用链路

从 `runner::run()` 入口出发的主调用链（capture-then-filter 路径）：

```text title="runner.rs:159 run() 模板方法"
run(cmd, tool_name, args_display, mode: RunMode, opts) -> Result<i32>   [runner.rs:159]
├── TimedExecution::start()                                              [tracking.rs:1362]
├── match mode {
│   ├── RunMode::Filtered(fn) / FilteredWithExit(fn)
│   │   └── run_captured_filter(cmd, ..., filter_fn, opts, timer)        [runner.rs:91]
│   │       ├── stream::run_streaming(cmd, stdin, FilterMode::CaptureOnly) [stream.rs:247]
│   │       │   ├── cmd.spawn() → ChildGuard(Drop 时 wait 防 zombie)     [stream.rs:284]
│   │       │   ├── 子线程 BufReader 读 stdout/stderr（10MiB RAW_CAP）    [stream.rs:245]
│   │       │   └── 返回 StreamResult{exit_code, raw, raw_stdout, raw_stderr, filtered}
│   │       ├── [skip_filter_on_failure && exit_code!=0] 直出原始输出    [runner.rs:114]
│   │       ├── filter_fn(text, exit_code) -> filtered
│   │       ├── guard::never_worse(raw, &filtered)                       [guard.rs:6]
│   │       └── timer.track(cmd_label, rtk_cmd, raw, shown)               [tracking.rs:1392]
│   │           ├── estimate_tokens(input) / estimate_tokens(output)     [tracking.rs:1320]  bytes/4
│   │           └── Tracker::new().record(...) → cleanup_old() 删 90 天前  [tracking.rs:417]
│   ├── RunMode::Streamed(filter)  → 流式逐行 feed_line/flush/on_exit    [stream.rs:103]
│   └── RunMode::Passthrough       → cmd.status() 继承 TTY，track_passthrough [tracking.rs:1428]
```

**关键数据结构变化**：`std::process::Command` → spawn → `CaptureResult{stdout,stderr,exit_code}`（`stream.rs:518`）→ 过滤函数 `String` → `&str`（never_worse 返回两者较短者）→ stdout 输出 + SQLite 记录。流式路径则用 `mpsc::channel` 交替读两路输出，`StreamFilter::feed_line()` 逐行过滤并实时输出到正确 fd，`on_exit()` 产出退出后摘要。

设计上，`run()` 是模板方法骨架，`RunMode` 的四个变体是四种执行策略的选择器——调用方按命令特性选 `Filtered`（整块过滤，适合 ls/tree）、`FilteredWithExit`（带 exit code 的整块过滤，适合 cargo build）、`Streamed`（逐行流式，适合 cargo test/git push）、`Passthrough`（不过滤，适合 --version/未识别子命令）。流式路径的 `BlockStreamFilter<H: BlockHandler>`（`stream.rs:24`）实现了块聚合逻辑（识别块开始/续行/结束），把细节委托给 handler——这是模板方法套模板方法。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `runner::run()` `runner.rs:159` | 执行骨架入口，按 RunMode 分发 | 模板方法，统一 timer→exec→filter→guard→track |
| `runner::run_captured_filter()` `runner.rs:91` | capture-then-filter 路径 | skip_filter_on_failure 失败直出 |
| `runner::emit_guarded()` `runner.rs:12` | filtered+hint 组合后再守卫 | 双重保险，tee hint 也纳入 never_worse |
| `stream::run_streaming()` `stream.rs:247` | spawn 子进程、捕获/流式/直通 | FilterMode 三态 + ChildGuard RAII |
| `stream::exec_capture()` `stream.rs:534` | 简单整块捕获 | cmds 直接调（golangci/pip） |
| `stream::status_to_exit_code()` `stream.rs:230` | 信号终止标准化 | Unix: 128+signal，kill -9→137 |
| `guard::never_worse()` `guard.rs:6` | 过滤后更长则回退 raw | estimate_tokens 比较，最后安全网 |
| `tracking::estimate_tokens()` `tracking.rs:1320` | bytes/4 估算 token | `ceil(len/4)`，只统计不决策 |
| `tracking::TimedExecution::track()` `tracking.rs:1392` | 记录命令到 SQLite | 90 天 cleanup_old，WAL+busy_timeout |
| `tracking::track_passthrough()` `tracking.rs:1428` | passthrough 记录 input=0,output=0 | 不扭曲 rtk gain 平均值 |
| `toml_filter::apply_filter_with_info()` `toml_filter.rs:511` | TOML DSL 8 阶段管道 | 声明式，strip_ansi→replace→…→on_empty |
| `toml_filter::find_matching_filter()` `toml_filter.rs:782` | 三层查找 project→user→builtin | LazyLock REGISTRY 热加载 |
| `tee::tee_and_hint()` `tee.rs` | 溢出写临时文件 + 恢复提示 | 0600 权限，轮转 20 文件 |
| `utils::resolved_command()` `utils.rs` | PATHEXT-aware 二进制解析 | Windows .CMD/.BAT 支持 |

</details>

## 核心实现

### RunMode：四策略执行选择器

`RunMode` enum（`runner.rs:84-89`）是 core/ 的中枢抽象——它把"怎么执行"从"过滤什么"中剥离：

```rust title="src/core/runner.rs:84"
pub enum RunMode<'a> {
    Filtered(CaptureFilter<'a>),              // 闭包 Fn(&str) -> String
    FilteredWithExit(ExitAwareCaptureFilter<'a>), // 带 exit code 的闭包
    Streamed(Box<dyn StreamFilter + 'a>),     // 逐行流式
    Passthrough,                             // 不过滤，直通 TTY
}
```

`Filtered` 与 `FilteredWithExit` 的区别是过滤函数能否访问 exit code——`cargo build` 失败时要看 exit code 决定是否回退到最后 5 行编译错误，而 `ls` 不需要。`Streamed` 用 trait object（`Box<dyn StreamFilter>`）支持任意流式过滤器实现，`Passthrough` 继承 TTY 不捕获（交互式 `git log` 分页器场景）。调用方（cmds）按命令特性选策略，`run()` 骨架不关心具体是哪种——这是策略模式。

### never_worse：降级守卫（核心不变量）

`guard.rs` 只有 12 行，却是 RTK 的核心安全网：

```rust title="src/core/guard.rs:6"
pub fn never_worse<'a>(raw: &'a str, filtered: &'a str) -> &'a str {
    if estimate_tokens(filtered) > estimate_tokens(raw) { raw } else { filtered }
}
```

它保证 **RTK 永不输出比原始命令更多的 token**。为什么必要？过滤逻辑有 bug 时（如 pretty-print JSON 把一行展开成多行），过滤后反而更长，违背"Token Killer"价值。`never_worse` 是最后的安全网，确保最坏情况下用户拿到的就是原始命令输出。它被几乎所有过滤路径调用：`runner.rs:141`（capture 路径）、`git.rs:205/320/500/852/912`（git 各子命令）、`search.rs:712`（grep 间接实现：仅在 `rtk_output.len() < plain.len()` 时用分组形式）。

降级是**多层**的，不止 never_worse 一道：filter panic → 透传 raw stdout（`stream.rs:450-456`）；命令失败 → `skip_filter_on_failure` 直出原始输出（`runner.rs:114-123`）；TOML 解析失败 → 静默跳过该 filter 文件（`toml_filter.rs:197`）。整个 core/ 的设计哲学是 CONTRIBUTING.md 的「Never Block」原则——filter 失败就回退 raw，hook 失败就 exit 0，**永远不阻断命令执行**。

### stream.rs：子进程捕获与 RAII 守卫

`stream.rs:247` 的 `run_streaming()` 是所有执行路径的底座。它用 `FilterMode` enum（`stream.rs:200`）三态控制捕获行为：`Streaming`（逐行流式过滤）、`Buffered`（整块过滤）、`CaptureOnly`（捕获但不过滤，filtered=raw_stdout）、`Passthrough`（继承 TTY 不捕获）。`StdinMode` 三态控制 stdin：`Inherit`（转发 rtk 的 stdin）、`Filter`（`StdinFilter` trait 处理）、`Null`。

关键设计是 `ChildGuard`（`stream.rs:284`）——它包裹 `std::process::Child`，实现 `Drop` trait 在 drop 时调用 `wait()`，防止子进程变成僵尸进程。注释引用 ISSUE #897：曾经因僵尸进程导致 kernel panic。`RAW_CAP = 10_485_760`（`stream.rs:245`）是 10MiB 输出捕获上限，防止 `dd if=/dev/zero` 之类无限输出耗尽内存——足够大覆盖正常编译输出（cargo build 通常 <1MiB），又足够小避免 OOM，超过后截断并 stderr 警告。

`StreamFilter`/`BlockHandler`/`LineHandler` 三个 trait（`stream.rs`）是流式过滤的扩展点：`StreamFilter` 定义骨架（feed_line→flush→on_exit），`BlockHandler`（块聚合，适合 cargo test 的失败块）和 `LineHandler`（行式，适合 git push 逐行）是两个子 trait，由 `BlockStreamFilter<H>` 和 `LineStreamFilter<H>` 泛型包装实现 `StreamFilter`。cmds 实现 handler 即可获得流式过滤——模板方法套模板方法。

### tracking.rs：SQLite 统计与 bytes/4 估算

`tracking.rs` 的 `Tracker` struct 封装 `rusqlite::Connection`，所有查询通过 `prepare()` + `query_map()` 执行。`TimedExecution`（`tracking.rs:1362`）是栈上计时器，`start()` 记 `Instant`，`track()`（`tracking.rs:1392`）结束时算耗时并写记录。

```rust title="src/core/tracking.rs:1320 bytes/4 估算"
pub fn estimate_tokens(text: &str) -> usize {
    (text.len() as f64 / 4.0).ceil() as usize
}
```

**bytes/4 而非真 tokenizer** 的设计权衡：RTK 是零依赖 CLI 工具，引入 tiktoken/tokenizers 会增加网络延迟和依赖；4 bytes/token 是 OpenAI tiktoken 对英文的近似值，对"节省量级"统计足够精确。这个估算**只用于 tracking 统计（`rtk gain`），不参与过滤决策**——过滤决策由 `never_worse` 的同一估算做比较（两边同口径，比较结果可靠）。代价是中文/代码场景会低估 token 数（CJK 1 字符 = 3 bytes 但可能 1-2 token），但对百分比统计影响可忽略。

SQLite 配置体现隐私与并发考量：WAL 模式 + `busy_timeout=5000`（`tracking.rs:271`）支持多 Claude Code 实例并发读写不阻塞；`restrict_db_files()`（`tracking.rs:339`）和 `open_private()`（`utils.rs:262`）在 `open()` 时就设 mode=0600，避免 umask 022 下的窗口期泄露——因为 tracking DB 可能含命令历史中的路径和参数，属用户隐私。`cleanup_old()` 删除 90 天前记录，DB 不无限增长。`track_passthrough()`（`tracking.rs:1428`）记录 input=0/output=0——passthrough 命令（如交互式 git log 分页器）输出流经 TTY 无法捕获，记真实值会扭曲统计，记 0 不参与 savings 计算。

### toml_filter.rs：声明式 8 阶段过滤管道

`toml_filter.rs` 是 core/ 里最大的文件（~1968 行），实现了一套声明式过滤 DSL，让用户无需改代码即可在 `.rtk/filters.toml` 或 `~/.config/rtk/filters.toml` 写过滤规则。`CompiledFilter` struct（`toml_filter.rs:138`）编译后的不可变结构，由 `TomlFilterRegistry`（LazyLock，`toml_filter.rs:398`）在首次使用时从三层来源加载（project `.rtk/filters.toml` → user `~/.config/rtk/filters.toml` → builtin）。

核心是 `apply_filter_with_info()`（`toml_filter.rs:511`）的 8 阶段管道——这是管道模式的典范：

```text title="toml_filter.rs:511 apply_filter_with_info() 8 阶段"
strip_ansi → replace(链式正则替换) → match_output(短路返回 message)
→ strip/keep_lines(RegexSet 互斥) → truncate_lines_at → head/tail_lines
→ max_lines → on_empty(空输出兜底)
```

每阶段以前一阶段输出为输入，声明式配置。`match_output` 可短路——匹配到特定输出直接返回预设 message，不走后续阶段。`find_matching_filter()`（`toml_filter.rs:782`）用 `match_regex.is_match(command)` 查找，找不到则 cmds 走自己的过滤函数。这条路径由 `main.rs:1287` 的 `run_fallback` 兜底入口触发——clap 解析失败的命令先查 TOML filter，再 raw passthrough。

## 设计模式

| 模式 | 位置（文件名 + 方法名） | 为什么用 |
|------|------------------------|---------|
| 代理模式 | `runner.rs:run()` + `run_passthrough()` | 拦截子进程输出过滤后再发；passthrough 是透明代理 |
| 策略模式 | `runner.rs:84` `RunMode` 四变体 + `filter.rs` `FilterStrategy` | 不同命令选不同执行/过滤策略，骨架不变 |
| 管道模式 | `toml_filter.rs:511` `apply_filter_with_info()` | 8 阶段声明式过滤，每阶段独立配置 |
| 降级保护 | `guard.rs:6` `never_worse()` + `runner.rs:114` + `stream.rs:450` | 多层降级链，永不阻断命令 |
| 模板方法 | `runner.rs:159` `run()` + `stream.rs` `BlockStreamFilter` | 执行骨架与过滤细节分离 |
| RAII 守卫 | `stream.rs:284` `ChildGuard` | Drop 时 wait 防 zombie（#897） |
| 工厂模式 | `filter.rs` `get_filter(level)` | 按 FilterLevel 返回 Box<dyn FilterStrategy> |

## 模块间交互

core/ 是全局 hub，被几乎所有模块依赖：

- **cmds/** 调用最多：`runner::run_filtered`/`run_streamed`/`run_passthrough`、`stream::exec_capture`、`guard::never_worse`、`truncate::CAP_*`、`utils::resolved_command`、`config::limits`、`tee::tee_and_hint`、`args_utils::restore_double_dash`（恢复 clap 吃掉的 `--`）。
- **hooks/**：`permissions.rs` → `stream::exec_capture`（权限检查执行子进程）、`trust.rs`/`hook_check.rs` → `constants`、`verify_cmd.rs` → `toml_filter`。
- **discover/**：主要用 `core::tracking` 查询历史命令统计，用于 `rtk discover` 分析未过滤命令。
- **analytics/**：纯读端，消费 `tracking` 写入的同一 SQLite 库（`~/.local/share/rtk/tracking.db`），不产生写操作。

core/ 内部无循环依赖，数据全靠参数和返回值传递。唯一的"共享状态"是 `LazyLock` 只读静态（`REGEX_SET`、`REGISTRY`、`COMPILED`）和 `TimedExecution` 栈上计时器——前者线程安全且只编译一次，后者是局部变量。

## 扩展方式

**新增 TOML 过滤策略**（如 `deduplicate` 去重阶段）：改 `toml_filter.rs` 的 `TomlFilterDef`（`:85`）加字段 → `CompiledFilter`（`:138`）加字段 → `compile_filter()`（`:306`）传递 → `apply_filter_with_info()`（`:511`）在 stage 4-5 间插入 `lines.dedup_by(|a,b| a==b)`。**不需要改** runner/stream/tracking——管道阶段扩展是声明式的，执行框架不变。

**新增 StreamFilter 实现**（如限流过滤器）：在 `stream.rs` 新建 struct 实现 `StreamFilter` trait（feed_line/flush），调用方构造后通过 `runner::run_streamed(cmd, ..., Box::new(filter), opts)` 传入。**不需要改** runner——它已通过 `RunMode::Streamed(Box<dyn StreamFilter>)` 支持任意实现。

**改截断阈值**：直接改 `truncate.rs` 的常量值（`CAP_ERRORS=20` 等），引用方自动生效。要让用户可配，再改 `config.rs` 的 `LimitsConfig`（`:122`）加字段，cmds 从 `config::limits()` 读取。
