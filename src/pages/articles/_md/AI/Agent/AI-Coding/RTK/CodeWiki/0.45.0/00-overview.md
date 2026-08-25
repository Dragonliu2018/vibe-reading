---
source:
  type: "源码解读"
  project: "RTK"
  url: "https://github.com/rtk-ai/rtk"
title: "Overview"
date: "2026-08-25T10:45:03+08:00"
category: [AI, Agent, "AI Coding", RTK, CodeWiki, "0.45.0"]
tags: ["RTK", "Rust", "CLI 代理", "Token 优化", "AI Coding Agent"]
description: "RTK 是拦截 LLM 编码代理 CLI 输出并压缩 60-90% token 的高性能 Rust 代理。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.45.0 · **协议** Apache-2.0 · **语言** Rust（edition 2021，MSRV 1.91）· **代码量** ~84,700 行 · **仓库** [GitHub](https://github.com/rtk-ai/rtk)

---

## 总览

### 项目简介

**RTK（Rust Token Killer）** 是一个挂在 LLM 编码代理（Claude Code、Cursor、Copilot、Gemini CLI 等）和 shell 命令之间的**高性能 CLI 代理**。它拦截代理要执行的 bash 命令，在输出进入代理上下文窗口之前做过滤、分组、截断、去重，把 bash output 压缩 **60-90%**，从而降低成本、提高有效上下文利用率。整个项目是单二进制 Rust 程序，无运行时依赖，每次命令代理开销低于 10ms。

RTK 解决的核心问题是：编码代理为每条 CLI 输出消耗 token，而大多数命令输出里充斥着进度条、ANSI 转义、样板格式、通过测试的长列表——这些对代理没有可操作价值，却挤占了宝贵的上下文窗口。RTK 只保留代理"看得懂、用得上"的部分。

**项目边界**需要先说清：RTK 只压缩 **bash output**（命令输出字节），不是账单缩减工具——bash output 只是 input token 的一项，input token 又只是账单的一部分。RTK 不带 tokenizer（`src/core/tracking.rs` 用 `bytes/4` 估算），所以百分比可靠但绝对 token 数是近似值。RTK 也不替你跑 LLM，不托管应用代码，只做"代理 → 过滤 → 统计"这一件事。

核心使用场景：`rtk init` 为你的代理装 hook → 代理运行 `git status` 被 hook 自动改写成 `rtk git status` → RTK 执行真实 `git status` 子进程并过滤输出 → 代理读到压缩后的结果 → `rtk gain` 看 90 天节省仪表盘。

### 功能矩阵

| 功能 | 实现文件 | 说明 |
|------|---------|------|
| 命令改写（hook 拦截） | `src/hooks/hook_cmd.rs`、`src/discover/registry.rs` | PreToolUse 事件 → `git status` 改写为 `rtk git status` |
| 子进程执行与捕获 | `src/core/runner.rs`、`src/core/stream.rs` | spawn 子进程、10MiB 上限捕获、`ChildGuard` 防 zombie |
| 输出过滤 | `src/cmds/`（100+ 命令）、`src/core/toml_filter.rs` | 命令专用 handler + 声明式 TOML DSL 管道 |
| 降级保护 | `src/core/guard.rs` | `never_worse`：过滤后若更长则回退 raw |
| Token 节省统计 | `src/core/tracking.rs`、`src/analytics/gain.rs` | SQLite 历史库 + `rtk gain` 仪表盘 |
| 账单经济学 | `src/analytics/cc_economics.rs`、`src/analytics/ccusage.rs` | 关联 ccusage 花费，加权 CPT 估美元节省 |
| 11+ 代理集成 | `src/hooks/init.rs` | `rtk init` 写 hook 脚本 + SHA-256 完整性 + patch settings |
| 命令发现 | `src/discover/mod.rs`、`src/learn/` | 扫描 session JSONL 找漏改写的命令、检测 CLI 修正模式 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| clap 4 | 核心 | CLI 参数解析（`Commands` enum 路由） |
| rusqlite (bundled) | 核心 | 历史统计库（WAL 模式 + 0600 权限） |
| regex | 核心 | 60+ 改写规则集（`LazyLock<RegexSet>`） |
| serde / serde_json | 核心 | hook JSON 解析、ccusage 数据反序列化 |
| toml | 核心 | `filters.toml` 声明式过滤 + `config.toml` 配置 |
| encoding_rs / codepage | 核心 | Windows 子进程控制台代码页解码 |
| ignore / walkdir | 可选 | `.gitignore` 感知的文件遍历（`ls`/`tree`） |
| colored | 可选 | TTY 感知的仪表盘着色 |
| ureq / flate2 / quick-xml | 可选 | 更新检查、gzip、OpenClaw 数据源 |
| chrono / sha2 | 核心 | 时间戳、hook SHA-256 完整性 |

### 版本历史

RTK 的架构演进有一条清晰主线：

- **v0.9.5+**：引入 Hook 架构，从"用户手动敲 `rtk`"转向"代理 hook 自动改写"，是采纳率从个位数跃升到 70-100% 的关键。
- **v0.28+**：Hook 从 shell 脚本模式（`~/.claude/hooks/rtk-rewrite.sh`）迁移到**原生 binary command** 模式（settings.json 直接注册 `"command": "rtk hook claude"`），消除脚本文件 + SHA-256 维护负担。
- **v0.45.0**（本次解读基线）：支持 11+ 代理（Claude/Cursor/Copilot/Gemini/Droid/Vibe 六家有 PreToolUse hook；Codex/Windsurf/Cline 等五家走纯指令注入），100+ 命令、60+ 改写规则，TOML DSL 让用户无需改代码即可加过滤规则。

## 快速上手

最简安装与端到端验证（macOS/Linux）：

```bash title="安装与初始化"
brew install rtk                  # 或 curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
rtk --version                     # 确认装对包（不是 Rust Type Kit）
rtk init -g                       # 给 Claude Code 装 hook（默认）
```

一条命令验证代理生效：

```text title="端到端验证：rtk git status"
$ rtk git status
On branch main
2 files changed

$ rtk gain                         # 看节省仪表盘
Commands: 1   Saved: 87%   312 tokens → 41 tokens
```

`rtk init -g` 会 patch `~/.claude/settings.json` 注册 `PreToolUse` hook；之后代理运行 `git status` 会被自动改写成 `rtk git status`，无需手动加前缀。`rtk gain` 读 SQLite 历史库展示压缩率。

## 架构设计解析

### 系统架构

RTK 的架构思想是**"代理 + 降级 + 零开销"**：它是子进程的代理（拦截 stdout/stderr 过滤后再输出），核心不变量是"RTK 永不输出比原始命令更多的 token"（`never_worse` 守卫），并且任何失败路径都回退到原始输出——Better to pass through unfiltered than to error out。

系统分四层 + 两个旁路模块。纵向从上到下是请求流向：Agent 集成层拦截并改写命令 → CLI 路由层解析分发 → 核心引擎层执行子进程并过滤 → 命令处理器层实现各命令的专用过滤逻辑。旁路的「改写引擎」`discover/` 被 Hook 调用做命令分类与改写；「统计分析」`analytics/` 读核心层写入的 SQLite 库生成仪表盘。

![RTK 分层架构](/vibe-reading/images/articles/rtk-codewiki-0.45.0/architecture.svg)

文字上，四层各自的存在理由是：**Agent 集成层**把"代理无关"的改写逻辑隔离在 Rust 内，hook 只做薄委托；**CLI 路由层**用 Clap 把 100+ 子命令分发到对应 handler，并提供 `run_fallback` 三层兜底；**核心引擎层**承载执行/捕获/过滤/统计/降级的统一骨架，是全仓最高扇入的 hub；**命令处理器层**因每命令输出格式差异极大而独立成文件。层间依赖单向：cmds → core，hooks → discover → core，analytics → core（读 SQLite）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|------------------------|
| Agent 集成层 | `src/hooks/` | 隔离各代理的 JSON 格式与安装位置差异，保护核心改写逻辑不随代理变化 |
| CLI 路由层 | `src/main.rs`、`src/parser/` | Clap 解析 + 枚举路由 + 兜底分发，单一进程入口 |
| 核心引擎层 | `src/core/` | 执行/捕获/过滤/统计/降级的统一骨架，全仓最高扇入 hub |
| 命令处理器层 | `src/cmds/` | 每命令专用过滤逻辑，按 ecosystem 分组独立演进 |
| 改写引擎（旁路） | `src/discover/` | 命令三态分类与复合命令改写流水线，被 Hook 调用 |
| 统计分析（旁路） | `src/analytics/`、`src/learn/` | 读 SQLite 历史生成仪表盘、扫描 session 找优化机会 |

### 设计模式

| 模式 | 位置（文件名 + 方法名） | 为什么用 |
|------|------------------------|---------|
| 代理模式（Proxy） | `core/runner.rs:run()` → `core/stream.rs:run_streaming()` | 拦截子进程输出过滤后再发，`run_passthrough()` 是透明代理 |
| 策略模式 | `core/runner.rs:84` `RunMode` enum 四变体 | 不同命令选 capture-then-filter / 流式 / 带退出码 / 直通 |
| 管道模式 | `core/toml_filter.rs:511` `apply_filter_with_info()` | TOML DSL 8 阶段声明式过滤：strip_ansi→replace→match_output→… |
| 降级保护 | `core/guard.rs:6` `never_worse()` | 永不输出比 raw 更长；多层降级链兜底 |
| 模板方法 | `core/runner.rs:159` `run()` 骨架 | start timer→exec→filter→guard→track，子类填 `RunMode` |
| RAII 守卫 | `core/stream.rs:284` `ChildGuard` | Drop 时 `wait()` 防 zombie（曾致 kernel panic #897） |
| 完整性校验 | `hooks/integrity.rs` SHA-256 | hook 有 allow 权限，防篡改即防命令注入 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `RunMode` | 执行策略选择器（Filtered/FilteredWithExit/Streamed/Passthrough） | 单次命令 | 由 cmds 构造，传给 `runner::run` |
| `StreamResult` | 子进程执行结果（exit_code + raw + filtered） | 单次命令 | `stream::run_streaming` 返回，runner 消费 |
| `Tracker` / `TimedExecution` | SQLite 连接封装 / 计时器 | 命令级 | `runner` 持有 timer，结束时 `track()` 写库 |
| `Classification` | 命令三态分类（Supported/Unsupported/Ignored） | 改写时 | `classify_command` 产出，决定是否改写 |
| `CompiledFilter` | TOML 过滤器编译后的不可变结构 | 进程级（LazyLock） | `find_matching_filter` 查找，`apply_filter_with_info` 应用 |
| `HookDecision` | hook 运行时决策（AllowRewrite/AskRewrite/Defer/Deny） | 单次拦截 | `decide_from_verdict` 产出，映射为 JSON 响应 |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `StreamFilter` | `core/stream.rs` | `BlockStreamFilter<H>`、`LineStreamFilter<H>`、`SearchStreamFilter` | cmds 构造 `Box<dyn StreamFilter>` 传入 `run_streamed` |
| `BlockHandler` / `LineHandler` | `core/stream.rs` | `CargoTestHandler`、`GitPushHandler` 等 | 各 cmd 实现 trait，包进 `BlockStreamFilter` |
| `FilterStrategy` | `core/filter.rs` | `NoFilter`、`MinimalFilter`、`AggressiveFilter` | `get_filter(level)` 工厂返回 `Box<dyn FilterStrategy>` |
| `OutputParser` | `parser/mod.rs` | `VitestParser`、`PnpmListParser`、`PlaywrightParser` | 各 cmd `impl OutputParser`，调用 `parse()` |
| `TokenFormatter` | `parser/formatter.rs` | `TestResult`、`DependencyState` 的 impl | trait 默认方法按 `FormatMode` 分发 |

## 代码目录

```text
rtk/
├── src/
│   ├── main.rs              # 入口：Clap Commands enum + 路由 + run_fallback 兜底（~3640 行）
│   ├── core/                # 核心引擎：runner/stream/tracking/guard/filter/toml_filter/tee/config（~9842 行）
│   ├── cmds/                # 命令处理器：11 个 ecosystem 分组（~44407 行，全仓最大）
│   │   ├── git/             #   git/gh/glab/gt（~8314 行）
│   │   ├── rust/            #   cargo + 通用 runner（~3153 行）
│   │   ├── js/              #   npm/pnpm/tsc/vitest/eslint/next/playwright/prisma（~3941 行）
│   │   ├── python/          #   ruff/pytest/mypy/pip/uv
│   │   ├── go/ jvm/ dotnet/ cloud/ php/ ruby/ scala/ system/
│   ├── discover/            # 改写引擎：registry(god 5656)/lexer/rules/provider（~9296 行）
│   ├── hooks/               # Agent 集成：init(god 8387)/hook_cmd/permissions/integrity/trust（~14126 行）
│   ├── analytics/           # 统计：gain/cc_economics/ccusage/session（~2759 行）
│   ├── parser/              # 输出解析框架：OutputParser/TokenFormatter/ParseResult（~711 行）
│   └── learn/               # CLI 修正模式检测：detector/report（~942 行）
├── hooks/                   # 嵌入的 hook 脚本模板与 awareness 文件（include_str!）
├── openclaw/                # 规则数据源
├── build.rs                 # 编译时生成规则
├── Cargo.toml               # edition 2021，MSRV 1.91
└── docs/contributing/       # ARCHITECTURE.md + TECHNICAL.md（项目自带深度文档）
```

`src/cmds/` 按语言/ecosystem 分组而非按命令类型，每组一个 `mod.rs` + 若干 `*_cmd.rs`——因为同一 ecosystem 的工具（如 JS 栈的 npm/pnpm/tsc/vitest）共享测试与构建语义，分组便于维护。`hooks/` 顶层目录（非 `src/hooks/`）存放嵌入二进制的脚本/awareness 文本，由 `include_str!` 编译进可执行文件。`docs/contributing/` 是项目自带的架构文档，本系列大量参考其 ARCHITECTURE.md 与 TECHNICAL.md。

## 模块地图

RTK 的六大模块围绕「核心引擎」这个全局 hub 组织，模块间依赖几乎都汇聚到 `core/`（最高扇入：`tracking` 27 次、`runner` 20 次、`guard` 19 次、`stream` 15 次）。`discover/` 是次级 hub，服务 Hook 改写与会话分析；`parser/` 是命令处理器共享的解析框架。

![RTK 模块依赖关系](/vibe-reading/images/articles/rtk-codewiki-0.45.0/module-dependencies.svg)

模块间的依赖方向：`cmds` → `core`（执行/过滤/统计）、`hooks` → `discover`（改写）+ `core`（权限/配置）、`analytics` → `core`（读 SQLite）+ `discover`（provider 读 JSONL）、`learn` → `discover`（provider）、`parser` ← `cmds`（实现 trait）→ `core`。依赖单向无环，数据全靠参数和返回值传递，唯一的"状态"是 `LazyLock` 只读正则集和 `TimedExecution` 栈上计时器。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 核心引擎 | 执行子进程、捕获、过滤、统计、降级 | `core/runner.rs:run()` | 承载全仓统一骨架，是最高扇入 hub | [核心引擎](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/01-core-engine) |
| 命令处理器 | 100+ 命令的专用输出过滤 | 各 `cmds/*/*_cmd.rs:run()` | 每命令输出格式差异极大，无法统一抽象 | [命令处理器](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/02-command-handlers) |
| 改写引擎 | 命令三态分类与复合命令改写流水线 | `discover/registry.rs:rewrite_command()` | 改写逻辑与过滤逻辑解耦，独立于代理 | [改写引擎](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/03-discover-registry) |
| Agent 集成 | 11+ 代理的 hook 安装与拦截 | `hooks/init.rs:run()`、`hooks/hook_cmd.rs` | 隔离各代理 JSON 格式与安装位置差异 | [Hook 集成](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/04-hooks-integration) |
| 统计分析 | 节省仪表盘与账单经济学 | `analytics/gain.rs:run()` | 纯读端，消费核心层写入的 SQLite | [Token 统计](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/05-analytics) |
| 解析与学习 | 输出解析框架 + CLI 修正模式检测 | `parser/mod.rs`、`learn/mod.rs:run()` | 复用格式化逻辑；learn 发现用户习惯错误 | [解析与学习](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/06-parser-learn) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」——静态依赖图讲谁依赖谁，运行流程讲一次请求里谁先调谁。

## 运行时行为

### 启动流程

RTK 是单二进制 CLI，无守护进程。一次 `rtk git status` 的启动调用链：

```text title="启动调用链（main.rs:1534 fn main）"
main()                                    [main.rs:1534]
└── Cli::parse()                          # Clap 解析 Commands enum
└── match cli.command {
    Commands::Git { command, args } => match command {
        GitCommands::Status { args } => git::run(   # 路由到 cmds/git/git.rs
            GitCommand::Status, &args, cli.verbose)?,
        ...
        GitCommands::Other(args) => git::run_passthrough(&args, ...)?,  # 未识别子命令兜底
    }
    ...
    _ => run_fallback(&cli)?              # clap 解析失败的最终兜底 [main.rs:1287]
}
```

对象装配极简：`Config::load()`（`core/config.rs`）按 `~/.config/rtk/config.toml` → 环境变量 → 默认值优先级加载；`LazyLock` 静态（`REGEX_SET`/`REGISTRY`/`COMPILED`）在首次使用时编译 regex 与 TOML filter，进程内只编译一次；`Tracker::new()`（`tracking.rs:417`）按需打开 SQLite（WAL + busy_timeout=5000 + 0600 权限）。无 DI 容器、无单例注册表——组件在调用栈上按需构造，符合「零开销」原则。

### 核心运行流程

RTK 有两条主运行链路：直接执行模式（用户/代理直接运行 `rtk git status`）和 hook 改写模式（代理运行 `git status` 被 hook 拦截改写后再执行）。后者是生产默认路径，前者是后者改写后的实际执行体。两条链路在前者入口汇合。

![RTK 端到端请求流程](/vibe-reading/images/articles/rtk-codewiki-0.45.0/data-flow.svg)

#### Hook 改写：代理命令拦截链路

业务流程：代理发 `PreToolUse` 事件（含 `git status`）→ hook 读 JSON → `rewrite_command` 改写为 `rtk git status` → 返回 `updatedInput` → 代理执行改写后命令 → 进入直接执行链路。

文字上，`hooks/hook_cmd.rs:run_claude()` 先 `read_stdin_limited()`（1MiB 上限）读代理 JSON，`process_claude_payload()` 从 `/tool_input/command` 提取命令。`decide_hook_action()`（`hook_cmd.rs:273`）先查权限规则（`permissions::check_command_for`），再检测不可验证构造（backtick/`$()`/文件重定向 → `Defer` 不改写防注入），最后 `get_rewritten()` 调 `registry::rewrite_command()` 改写。决策映射为 `HookDecision`：`AllowRewrite`（有 allow 规则，设 `permissionDecision:"allow"`，100% 采纳）vs `AskRewrite`（无 allow 规则，不设该字段，代理原生提示流程接管，70-85% 采纳）。关键安全设计（#1155）：`PermissionVerdict::Default` 必须映射到 Ask 而非 Allow，`rewrite_cmd.rs:176` 的测试 `test_default_verdict_maps_to_ask_exit_code` 锁定此行为，防"无规则即放行"漏洞。

#### 直接执行：六阶段命令生命周期

业务流程：① Parse（Clap 解析）→ ② Route（枚举分发到 `git::run`）→ ③ Execute（`runner::run` spawn 子进程并捕获）→ ④ Filter（`format_git_output` 过滤）→ ⑤ Guard（`never_worse` 守卫）→ ⑥ Print + Track（输出到 stdout 并写 SQLite）。

文字上，`cmds/git/git.rs:run_status()`（`git.rs:824`）用 `core::stream::exec_capture()`（`stream.rs:534`）spawn 真实 `git status` 子进程，stdout/stderr 各起一线程用 `BufReader` 读（10MiB `RAW_CAP` 上限防 OOM，`stream.rs:245`），`ChildGuard`（`stream.rs:284`）在 Drop 时 `wait()` 防 zombie。捕获后 `format_git_output()` 把"分支 + 改动文件"压成紧凑格式。`never_worse(raw, &filtered)`（`guard.rs:6`）比较 `estimate_tokens`，若过滤后反而更长则回退 raw——这是「Token Killer」的核心安全网。最后 `TimedExecution::track()`（`tracking.rs:1392`）用 `bytes/4` 估算 input/output token，`Tracker::record()` 写 SQLite 并 `cleanup_old()` 删 90 天前记录。`estimate_tokens` 用 `ceil(len/4)` 而非真 tokenizer，只为统计量级，不参与过滤决策。

数据结构变化：`Command`（std::process）→ spawn → `CaptureResult{stdout,stderr,exit_code}`（`stream.rs:518`）→ 过滤函数 `String` → `&str`（never_worse 返回）→ stdout 输出 + SQLite 记录。exit code 全程传播：`status_to_exit_code()`（`stream.rs:230`）在 Unix 下正确处理信号终止（128+signal），确保 `kill -9` 返回 137 而非 0，不误导代理判断命令成功。

### 状态流

RTK 没有长生命周期状态机，但命令改写有三态分类（`Classification` enum，`registry.rs:17`）这一关键状态流转：每条命令经 `classify_command` 落入 `Supported`（RTK 可改写并过滤，带 `rtk_equivalent`/`savings_pct`/`status`）、`Unsupported`（已知命令但 RTK 不支持，如 `git tag`）、`Ignored`（shell 内建/无输出，如 `cd`/`echo`/`true`）三态之一。`Supported` 的 `status` 子字段进一步分 `Existing`（有专用 handler 过滤）、`Passthrough`（透传不过滤，如 `cargo fmt`）、`NotSupported`。改写流水线在每个 segment 上跑这个三态判定，`Unsupported`/`Ignored` 直接返回 `None` 不改写。

## 典型修改场景

#### 场景 1：新增一个命令的过滤支持

两种路径：
- **改代码**：在 `src/cmds/<ecosystem>/` 新建 `xxx_cmd.rs`，实现 `pub fn run(args, verbose) -> Result<i32>`，用 `resolved_command("xxx")` 建子进程，选 `runner::run_filtered` / `run_streamed` 执行路径，实现过滤函数（用 `CAP_ERRORS`/`CAP_WARNINGS` 截断）；在 `mod.rs` 加 `pub mod xxx_cmd;`；在 `main.rs` 的 `Commands` enum 加变体 + `run_cli` match 加分支。同时在 `src/discover/rules.rs` 的 `RULES` 数组加改写规则（`pattern` + `rtk_cmd` + `rewrite_prefixes`）。
- **不改代码**：在 `.rtk/filters.toml` 或 `~/.config/rtk/filters.toml` 写声明式 TOML filter（8 阶段管道），走 `run_fallback` → `toml_filter::find_matching_filter` 路径热加载，`rtk verify` 验证。

对应测试：各 `*_cmd.rs` 文件内 `#[cfg(test)] mod tests`，`rtk verify` 命令做 inline 测试。

#### 场景 2：新增一个 LLM 代理支持

修改文件：`src/main.rs`（`AgentTarget` enum 加变体，`main.rs:37`）、`src/hooks/constants.rs`（加目录/hook 命令常量）、`src/hooks/init.rs`（实现 `run_newagent_mode()`，参考 `run_droid_mode()`）、`src/hooks/hook_cmd.rs`（若有 PreToolUse hook，实现 `run_newagent()` 处理 JSON 格式）、`src/hooks/permissions.rs`（`Host` enum 加变体 + `load_newagent_rules()`）。若代理不支持 hook 改写（只支持 allow/deny），则走纯指令注入路径（写 `AGENTS.md`/`.windsurfrules`），让代理自愿用 `rtk` 前缀。

对应测试：`rewrite_cmd.rs:157` 的 `exit_code_protocol` 测试模块是安全哨兵，确保 exit code 0/1/2/3 语义一致。

#### 场景 3：修改截断阈值或过滤策略

- **改常量**：`src/core/truncate.rs` 的 `CAP_ERRORS=20`/`CAP_WARNINGS=10`/`CAP_LIST=20`/`CAP_INVENTORY=50`，引用方自动生效。要让用户可配，再改 `src/core/config.rs` 的 `LimitsConfig`（`config.rs:122`）加字段。
- **改某命令过滤**：如让 `cargo test` 也显示通过测试名，改 `src/cmds/rust/cargo_cmd.rs` 的 `CargoTestHandler::should_skip()`（`cargo_cmd.rs:143`）和 `format_summary()`（`cargo_cmd.rs:197`），注意 `never_worse` 会限制输出膨胀——超过 raw 就回退。

对应测试：`cargo_cmd.rs` 内 `#[cfg(test)] mod tests` 的 `AggregatedTestResult` 解析测试。

## 测试体系

```text
tests/
├── *.rs               # 集成测试（按命令分文件）
└── fixtures/          # 真实命令输出样本
```

RTK 采用「inline 单元测试 + 集成测试」双层：每个 `*_cmd.rs` 文件内有 `#[cfg(test)] mod tests` 测试该命令的过滤逻辑（如 `git.rs:2190` 的 `test_run_status_compact_propagates_non_repo_failure` 验证 corrupt index 必传播非 0 exit code）；`tests/` 目录的集成测试用 `fixtures/` 里的真实命令输出样本端到端验证。`rewrite_cmd.rs:157` 的 `exit_code_protocol` 测试模块是安全哨兵，锁定权限 exit code 语义。`bash scripts/test-all.sh` 跑已安装二进制的冒烟测试。

| 代码层 | 测试类型 | 侧重 |
|--------|---------|------|
| `core/` 各模块 | inline unit | 降级链、exit code、token 估算 |
| `cmds/*` 各命令 | inline unit | 过滤输出正确性、不吞 exit code |
| `discover/registry` | inline unit | 改写流水线、复合命令、管道 |
| `hooks/` | inline unit + `exit_code_protocol` | 权限判定、防绕过 |
| 跨模块 | `tests/` 集成 | 端到端命令执行 |

## 阅读源码推荐路线

- 第一遍：理解主流程
  `src/main.rs:1534` `fn main()` → `src/core/runner.rs:159` `run()` → `src/core/stream.rs:247` `run_streaming()` → `src/cmds/git/git.rs:824` `run_status()` → `src/core/guard.rs:6` `never_worse()` → `src/core/tracking.rs:1392` `track()`
- 第二遍：理解改写与 Hook
  `src/hooks/hook_cmd.rs:630` `run_claude()` → `src/hooks/rewrite_cmd.rs:47` `evaluate()` → `src/discover/registry.rs:569` `rewrite_command()` → `src/discover/registry.rs:107` `classify_command()` → `src/discover/rules.rs` `RULES` 数组
- 第三遍：理解核心数据结构与扩展点
  `src/core/runner.rs:84` `RunMode` enum → `src/core/stream.rs:9` `StreamFilter`/`BlockHandler` trait → `src/core/toml_filter.rs:511` `apply_filter_with_info()` 8 阶段管道 → `src/parser/mod.rs:18` `ParseResult` 三层降级
- 第四遍：选择重点子模块深入阅读（见上方模块地图链接，每篇模块文档含深度解读）

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| RTK | Rust Token Killer，本项目 |
| never_worse | `guard.rs` 的降级守卫：过滤后若 token 数 > 原始则回退 raw |
| RunMode | 执行策略 enum（Filtered/FilteredWithExit/Streamed/Passthrough） |
| tee | 原始输出磁盘恢复机制，溢出时写临时文件 + 恢复提示 |
| ccusage | 外部 npm 包，解析 Claude Code 用量与花费，RTK 通过子进程集成 |
| CPT | Cost Per Token，加权 CPT 用 API 价格比（output=5×input）估算 |
| RtkStatus | Supported 命令的处理方式（Existing/Passthrough/NotSupported） |
| transparent prefix | 透明前缀（如 `docker exec`、`uv run`），改写时递归剥离后改写内部命令 |

### 参考资料

- [RTK ARCHITECTURE.md](https://github.com/rtk-ai/rtk/blob/master/docs/contributing/ARCHITECTURE.md) — 项目自带深度架构参考（过滤分类法、性能、ADR）
- [RTK TECHNICAL.md](https://github.com/rtk-ai/rtk/blob/master/docs/contributing/TECHNICAL.md) — 端到端流程导览，本系列大量参考
- [How RTK Savings Work](https://github.com/rtk-ai/rtk/blob/master/docs/guide/resources/savings-explained.md) — "bash output vs 账单"口径澄清
- [RTK CONTRIBUTING.md](https://github.com/rtk-ai/rtk/blob/master/CONTRIBUTING.md) — 五大设计原则
