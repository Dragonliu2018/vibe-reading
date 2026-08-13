---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "Overview"
date: "2026-08-13T20:14:13+08:00"
category: ["Languages", "Python", "Tools", "Ruff", "CodeWiki", "0.16.2"]
tags: ["ruff", "Rust", "Linter", "Formatter", "Python", "AST"]
description: "ruff 是用 Rust 编写的极速 Python linter 与 formatter。本文从分层架构、解析管线、语义模型、规则系统、格式化 IR 到 LSP，全面解读 ruff v0.16.2 的内部实现。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.16.2 · **协议** MIT · **语言** Rust (edition 2024) · **代码量** ~400,000 行 · **仓库** [GitHub](https://github.com/astral-sh/ruff)

---

## 总览

### 项目简介

Ruff 是一个用 Rust 编写的极速 Python 代码检查器（linter）和格式化器（formatter），由 Astral 团队（同时维护 uv 和 ty）开发。它的核心价值极其直接：**用原生 Rust 重写整个 Python 工具链中"静态分析与格式化"这一环，把原本由 Flake8、Black、isort、pyupgrade、pydocstyle 等十几个独立工具承担的工作，收进一个比其中任何一个都快 10–100 倍的二进制里**。Lint 整个 CPython 代码库只需几十毫秒，而传统工具需要数分钟。

Ruff 的极速来自三方面：(1) Rust 原生实现 + jemalloc/mimalloc 全局分配器；(2) 自研带错误恢复的递归下降 Python parser，在语法错误的代码上仍能产出可用 AST；(3) rayon 并行 + 文件级缓存，增量场景下几乎零开销跳过未变更文件。

**项目边界**：ruff 负责 Python 代码的静态规则检查（900+ 内置规则）和代码格式化（对标 Black）；仓库内还包含一个独立子项目 **ty**（类型检查器），但本文聚焦 ruff 本身，不展开 ty。ruff 不做运行时分析、不做类型推断（那是 ty 的职责）、不提供图形界面。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|----------|------|
| Lint 检查 | `crates/ruff_linter/src/linter.rs` · `checkers/` | 多源 checker（tokens/AST/imports/物理行）编排 |
| 900+ 规则 | `crates/ruff_linter/src/rules/` | 按来源家族组织（pyflakes/pyupgrade/isort 等 60 族） |
| 自动修复 | `crates/ruff_linter/src/fix/` | "应用-重解析-再检查"收敛循环，≤100 轮 |
| 代码格式化 | `crates/ruff_python_formatter/` · `crates/ruff_formatter/` | AST→IR→Printer 两阶段，对标 Black |
| Python 解析 | `crates/ruff_python_parser/` | 自研递归下降 + Pratt 表达式 + error recovery |
| AST 与位置 | `crates/ruff_python_ast/` | 代码生成节点 + TextRange + 三层 Visitor |
| 语义分析 | `crates/ruff_python_semantic/` | 作用域栈 + 绑定 arena + 名称解析 |
| 配置发现 | `crates/ruff_workspace/src/resolver.rs` | 层级级联配置 + matchit Router 路由 |
| 文件缓存 | `crates/ruff_cache/` · `crates/ruff/src/cache.rs` | mtime+权限 key，rkyv 零拷贝序列化 |
| 编辑器集成 | `crates/ruff_server/` | 自建 LSP（基于 lsp_server），Snapshot COW |
| noqa 抑制 | `crates/ruff_linter/src/noqa.rs` | 文件级 / 行级 / range 三层抑制 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Rust (edition 2024) | 核心 | 实现语言，1.95 toolchain |
| clap | 核心 | CLI 参数解析（derive 宏） |
| rayon | 核心 | 数据并行（per-file lint/format） |
| ignore | 核心 | 并行目录遍历 + gitignore |
| rustc-hash (FxHashMap) | 核心 | 快速非加密哈希，全代码库默认哈希表 |
| rkyv | 核心 | 缓存零拷贝序列化 |
| jemalloc / mimalloc | 核心 | 全局分配器（Unix / Windows） |
| matchit | 可选 | 配置层级路由（最长前缀匹配） |
| lsp_server / lsp_types | 可选 | LSP 协议底层（非 tower-lsp） |
| maturin | 构建 | Rust→Python wheel 打包 |

### 版本历史

Ruff 自 2022 年开源后快速迭代，v0.16.2 这一时间点的关键脉络：(1) **AST 重构完成**——节点定义由 Python 脚本 `generate.py` 代码生成（`generated.rs` 1.1 万行），async/sync 合并为单一节点 + `is_async` 字段，子节点统一用 `Box`/`ThinVec`；(2) **格式化器成熟**——基于 Wadler-Leijen group/break 算法的 IR 框架稳定对标 Black，preview 机制承载实验性行为；(3) **ty 分离**——类型检查器 ty 作为独立子项目并行开发，与 ruff 共享 parser/AST 但有独立的语义分析（`ty_python_semantic`）；(4) **LSP 自建**——放弃 tower-lsp，基于 `lsp_server` 自建同步线程模型，精确控制线程优先级。

---

## 快速上手

```bash title="从源码构建并验证"
# 构建（依赖 Rust 1.95+）
cargo build --release --bin ruff

# 端到端验证：lint 一个有问题的 Python 文件
cat > demo.py <<'EOF'
import os, sys
def Foo( a ,b):
    return a+b
EOF
./target/release/ruff check demo.py

# 自动修复
./target/release/ruff check --fix demo.py

# 格式化
./target/release/ruff format demo.py
```

预期：`ruff check` 报告未使用 import（F401）、命名规范（N802）、空格（E203）等诊断；`--fix` 自动删除 `sys`、规范空格；`format` 将函数签名重排为 Black 风格。这正是 ruff "一个工具替代 flake8+isort+pyupgrade+black" 的直接体现。

---

## 架构设计解析

### 系统架构

Ruff 的架构思想是**把"Python 源码分析"做成一条可复用的分层管线，CLI 与 LSP 只是其上的两种入口**。整套系统按职责自上而下分四层：上层只依赖下层接口，下层不反向感知上层。这样 `ruff check` 和 `ruff server` 共享同一套 lint/format 核心 API，差异仅在 I/O 层（CLI 读文件、LSP 用内存文档）和结果序列化（CLI 打印、LSP 转 `lsp_types::Diagnostic`）。

![Ruff v0.16.2 分层架构](/vibe-reading/images/articles/ruff-internals/architecture.svg)

系统自上而下分为四层：接口层隔离 CLI/LSP 两种入口形态，保护核心不感知调用方式；编排层负责配置发现、文件遍历、lint/format 管线调度；分析核心层承载 Python 解析、AST、语义模型与规则实现——这是 ruff 的智力密度所在；基础设施层提供语言无关的格式化 IR 框架、文本范围、缓存、诊断类型等横切能力。层间依赖单向向下，所有层都通过 `TextRange`/`Diagnostic` 等基础类型协作。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|------------------------|
| 接口层 | `crates/ruff/` · `crates/ruff_server/` | 隔离 CLI 与 LSP 两种入口形态，保护核心不感知调用方式 |
| 编排层 | `crates/ruff_workspace/` · `crates/ruff_linter/`(管线) · `crates/ruff_python_formatter/` | 编排配置发现、文件遍历、lint/format 管线调度 |
| 分析核心层 | `crates/ruff_python_parser/` · `crates/ruff_python_ast/` · `crates/ruff_python_semantic/` · `crates/ruff_linter/src/rules/` | 承载 Python 解析、AST、语义模型与规则实现 |
| 基础设施层 | `crates/ruff_formatter/` · `crates/ruff_db/` · `crates/ruff_text_size/` · `crates/ruff_cache/` · `crates/ruff_python_index/` | 提供语言无关的 IR、文本范围、缓存、诊断等横切能力 |

### 设计模式

| 模式 | 位置 | 说明 |
|------|------|------|
| 命令模式 | `Command` enum in `crates/ruff/src/args.rs:131`，分发 in `lib.rs:170` | 每子命令一个枚举变体，`match` 强制穷尽分发 |
| 递归下降 + Pratt | `parse_statement` in `parser/statement.rs`，`parse_binary_expression_or_higher` in `parser/expression.rs:246` | 语句递归下降，表达式 Pratt 优先级攀爬 |
| Error Recovery | `parse_list` in `parser/mod.rs:733`，`RecoveryContext` bitmask in `parser/mod.rs:1010` | 语法错误时仍产出 AST，linter 不中断 |
| Visitor 模式 | `Visitor`/`SourceOrderVisitor`/`Transformer` in `ruff_python_ast/src/visitor.rs` | 三层 visitor：求值序 / 源码序 / 可变换 |
| 策略分发 | `LintSource` enum + `Rule::lint_source()` in `registry.rs:247` | 规则声明数据源类型，`check_path` 按类型路由 |
| Arena + ID 索引 | `Bindings`/`Scopes` as `IndexVec` in `ruff_python_semantic` | u32 index 引用，O(1) 访问，无生命周期标注 |
| Snapshot/Restore | `SemanticModel::snapshot()` in `model.rs:2053`，`DocumentSnapshot` in `ruff_server/session.rs` | 轻量 Copy 快照，支持 deferred 分析与 LSP COW |
| IR 模式 | `FormatElement` in `ruff_formatter/src/format_element.rs`，`Printer` in `printer/mod.rs` | AST→IR→output 两阶段，Wadler-Leijen group 算法 |
| 收敛循环 | `lint_fix()` in `linter.rs:544`，`apply_fixes` in `fix/mod.rs` | "应用-重解析-再检查"直到无新 fix |
| 层级配置 | `PyprojectDiscoveryStrategy` + `Resolver` Router in `resolver.rs:97` | monorepo 友好的级联配置，最长前缀匹配 |
| RAII Guard | `DiagnosticGuard` in `checkers/ast/mod.rs:3615` | Drop 时提交诊断，支持链式修改与 defuse |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `Parsed<T>` | 解析结果（AST + tokens + errors） | 单文件分析期间 | 由 parser 构造，被 checker 消费 |
| `SemanticModel` | 语义状态机（作用域 + 绑定 + 引用） | 单文件遍历期间 | 由 Checker 驱动构建，规则只读访问 |
| `Checker` | AST 遍历器 + 规则分发器 | 单文件 | 持有 SemanticModel + LintContext |
| `LintContext` | 诊断收集器 + 规则启用表 | 单文件 | 被 Checker 引用，收集 `Diagnostic` |
| `Diagnostic` | 一条诊断（规则 + 范围 + fix） | 跨 crate 传递 | 由规则经 DiagnosticGuard 产生 |
| `FormatElement` | 格式化 IR 节点（Token/Line/Group/Tag） | 单次格式化 | 由 `Format` trait 生成，Printer 消费 |
| `Settings` | 最终生效配置 | 单次命令运行 | 由 Configuration 合并而来 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
|----------|----------|--------|---------|
| `Violation` trait | `ruff_linter/src/violation.rs:49` | 每条规则一个 struct | `#[derive(ViolationMetadata)]` + `map_codes` 宏生成 `Rule` enum |
| `Format<Context>` trait | `ruff_formatter/src/lib.rs:596` | 每个 AST 节点的 `FormatNodeRule` | trait dispatch，按节点类型 |
| `Visitor<'a>` trait | `ruff_python_ast/src/visitor.rs:23` | `Checker` | 手动 impl，override `visit_*` |
| `ConfigurationTransformer` | `ruff_workspace/src/resolver.rs:300` | `ConfigArguments`(CLI) | 解耦 CLI 覆盖注入 |
| `CacheKey` trait | `ruff_cache/src/cache_key.rs:74` | FileTime/GlobMatcher/Settings | 自定义哈希，确定性 + 可移植 |

---

## 代码目录

```
ruff/
├── crates/
│   ├── ruff/                    # CLI 入口、命令分发、printer、cache 使用方
│   │   ├── src/main.rs          # main() + 全局 allocator
│   │   ├── src/lib.rs           # run() + 命令分发
│   │   ├── src/args.rs          # clap 参数定义
│   │   ├── src/commands/        # check/format/server 子命令实现
│   │   └── src/cache.rs         # 文件缓存逻辑（PackageCacheMap）
│   ├── ruff_linter/             # Linter 核心 + 900+ 规则（最大 crate，~20 万行）
│   │   ├── src/linter.rs        # check_path/lint_only/lint_fix 编排
│   │   ├── src/checkers/        # ast/tokens/imports/physical_lines checker
│   │   ├── src/rules/           # 60 个规则家族（pyflakes/pyupgrade/...）
│   │   ├── src/fix/             # 自动修复引擎
│   │   ├── src/noqa.rs          # noqa 抑制
│   │   └── src/registry.rs      # Rule/Linter 枚举 + LintSource 分发
│   ├── ruff_python_parser/      # 自研 Python 解析器
│   ├── ruff_python_ast/         # AST 节点（代码生成）+ Visitor
│   ├── ruff_python_semantic/    # 语义模型（作用域/绑定/名称解析）
│   ├── ruff_formatter/          # 语言无关的格式化 IR 框架
│   ├── ruff_python_formatter/   # Python 格式化实现（对标 Black）
│   ├── ruff_workspace/          # 配置发现 + 层级级联
│   ├── ruff_cache/              # 缓存 key 基础设施
│   ├── ruff_server/             # LSP server（自建，非 tower-lsp）
│   ├── ruff_db/                 # 诊断类型 + panic 恢复
│   ├── ruff_text_size/          # TextRange/TextSize
│   └── ty*/                     # 类型检查器 ty（独立子项目，本文不展开）
├── python/                      # Python 侧胶水（maturin 绑定）
├── pyproject.toml               # maturin 构建配置
└── Cargo.toml                   # workspace 定义
```

`crates/` 下每个 `ruff_*` 都是独立 crate，通过 Cargo workspace 统一管理。`ruff` crate 是二进制入口，其余是库。这种细粒度拆分让编译并行化、依赖关系显式化（如 `ruff_python_ast` 不依赖 parser，可独立编译）。

---

## 模块地图

![核心模块依赖关系](/vibe-reading/images/articles/ruff-internals/module-dependencies.svg)

模块间依赖呈"消费者在左、提供者在右"的单向数据流：CLI 与 LSP 作为入口消费编排层；编排层（linter 管线、formatter）调用分析核心层；分析核心层的 parser/semantic/rules 最终都落在 `ruff_python_ast` 这个共享地基上。`ruff_cache` 是横切依赖，被 linter 管线在文件级调用。规则系统（rules）是 ruff_linter 内部的子模块，但它重度依赖 semantic 和 ast，故单列。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| CLI 与命令分发 | CLI 入口、参数解析、命令分发、诊断输出 | `run()` in `lib.rs:128` | 隔离 CLI 形态，核心不感知调用方式 | [CLI 与命令分发](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/01-cli-commands) |
| Python 解析器 | 词法 + 递归下降语法分析，带 error recovery | `parse_module()` in `lib.rs:112` | linter 必须在语法错误代码上运行 | [Python 解析器](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/02-parser) |
| Python AST | AST 节点定义 + 位置 + 三层 Visitor | `Stmt`/`Expr` in `generated.rs` | 所有消费者共享的不可变地基 | [Python AST](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/03-python-ast) |
| 语义分析 | 作用域栈、绑定 arena、名称解析 | `SemanticModel` in `model.rs:58` | 规则需要超越 AST 模式匹配的语义信息 | [语义分析](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/04-semantic-analysis) |
| Linter 核心管线 | 多源 checker 编排、诊断收集、fix 收敛 | `check_path()` in `linter.rs:119` | 分发不同数据源 + 容错 + 修复循环 | [Linter 核心管线](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/05-linter-pipeline) |
| 规则系统 | 900+ 规则的定义、注册、选择、preview | `Rule` enum（宏生成） | 规则按家族组织，宏驱动注册 | [规则系统](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/06-rule-system) |
| 格式化器 | AST→IR→Printer 两阶段，对标 Black | `format_module_source()` in `lib.rs:137` | IR 解耦格式化逻辑与换行决策 | [格式化器](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/07-formatter) |
| Workspace 与配置 | 配置发现、层级级联、文件遍历 | `project_files_in_path()` in `resolver.rs:429` | monorepo 友好的 per-directory 配置 | [Workspace 与配置](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/08-workspace-config) |
| 缓存系统 | 文件级缓存，跳过未变更文件 | `Cache::get()` in `cache.rs:260` | 极速的关键之一：增量场景零开销 | [缓存系统](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/09-cache) |
| LSP Server | 编辑器集成，诊断/格式化/code action | `Server::run()` in `server.rs:129` | 实时编辑场景与 CLI 共享核心 | [LSP Server](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/10-lsp-server) |

---

## 运行时行为

### 启动流程

```
main()                                      [crates/ruff/src/main.rs:30]
  ├─ wild::args_os() → argfile::expand_args_from()   展开 @argfile
  ├─ Args::parse_from(args)                          clap 解析 CLI
  └─ run(args)                                       [lib.rs:128]
       ├─ colored_override() → set_override()        颜色控制
       ├─ ruff_db::set_program_version()             全局版本
       ├─ std::panic::set_hook()                     panic hook（引导报 issue）
       ├─ set_up_logging()                           日志（Server 命令跳过）
       └─ match command {                            ── 命令分发 ──
            Command::Check(args) => check(args, global_options)
            Command::Format(args) => format(args, global_options)
            Command::Server(args) => server(args)
            Command::Analyze(Graph(args)) => analyze_graph(...)
            ...
          }
```

对象装配的关键决策：**全局分配器在编译期选定**——`main.rs:11-28` 通过 `#[global_allocator]` 为 Unix 注入 jemalloc、为 Windows 注入 mimalloc，这是 ruff 极速的基础设施前提（小对象多线程分配性能）。**配置发现是延迟的**——`run()` 只解析 CLI 参数，真正的 `PyprojectConfig` 在各命令函数内通过 `resolve::resolve()` 按四级优先级（`--isolated` > `--config=file` > 向上查找 > 用户级 > 默认）解析。**check 与 format 路径对称但独立**——都走 `partition()` → `resolve()` → stdin 判断 → 委托 `commands::xxx`，但 `check()` 因有大量"伪子命令"（`--watch`/`--statistics`/`--add-noqa`）而内联更多逻辑。

### 核心运行流程

下面三条链路覆盖了 ruff 的核心运行模式：lint 检查、自动修复、代码格式化。它们共享解析与配置基础设施，但在修复策略和输出形态上分叉。

#### Lint 检查：`ruff check` 主链路

业务流程：用户指定文件 → 发现文件 + 解析每文件配置 → 并行 lint → 规则执行 → noqa 抑制 → 合并排序 → 输出诊断。

![ruff check 数据流](/vibe-reading/images/articles/ruff-internals/data-flow.svg)

文字描述：`check()` 调 `project_files_in_path()` 用 ignore crate 并行遍历目录树（≤12 线程），同时用 matchit Router 做层级配置的最长前缀匹配，每个文件拿到其最近祖先目录的 `LinterSettings`。随后 `paths.par_iter()` 用 rayon 并行处理每文件：`lint_path()` 先查缓存（mtime+权限 hash 命中则跳过），未命中则 `parse_unchecked_source()` 解析（语法错误也产出 AST），构建 `Locator`/`Stylist`/`Indexer`/`Directives` 辅助结构，最后 `check_path()` 按 `lint_source()` 把规则分发到 `check_tokens`/`check_ast`/`check_imports`/`check_physical_lines`/`check_noqa` 五类 checker。诊断经 noqa 三层抑制后合并，按源码位置排序输出。单文件 panic 由 `catch_unwind` 捕获转为诊断，不影响其他文件。

#### 自动修复：`ruff check --fix` 链路

当 `fix_mode` 为 `Apply`/`Diff` 时走 `lint_fix()` 而非 `lint_only()`。关键设计是**"应用-重解析-再检查"收敛循环**：每轮 `check_path()` 产出诊断后，`fix_file()` 按位置排序应用不重叠的 fix（跳过重叠 edit，支持 `IsolationLevel` 防止删空 block），生成新源码；然后用新源码**重新解析、重新检查**，捕获级联效应（如 `super(Foo, self)`→`super()` 后 `Foo` 变成未使用变量）。当一轮无新 fix 即收敛退出，上限 100 轮防震荡。若 fix 引入语法错误则立即回滚。这保证 `--fix` 的结果与多次手动修复一致。

#### 代码格式化：`ruff format` 链路

`format()` 调 `project_files_in_path()` 后并行，每文件 `format_module_source()` 走两阶段：**第一阶段** parse 后遍历 AST，每个节点通过 `FormatNodeRule::fmt_fields()` 生成语言无关的 `FormatElement` IR（Token/Line/Group/Indent 等），comments 被预先关联到 AST 节点（leading/dangling/trailing）；**第二阶段** `Printer` 消费 IR，对每个 `StartGroup` 用 `FitsMeasurer` 预测量宽度决定 flat/expanded 模式，soft line 在 flat 时变空格、expanded 时换行，子 group 展开会通过 `ExpandParent` 向上传播。最终输出对标 Black 风格的文本。

---

## 典型修改场景

#### 场景 1：新增一条 lint 规则

1. `crates/ruff_linter/src/rules/<家族>/rules/my_rule.rs`——定义 `#[derive(ViolationMetadata)]` struct + `impl Violation`（`message()`/`fix_title()`）+ 检查函数 `fn my_rule(checker: &Checker, ...)`
2. `crates/ruff_linter/src/rules/<家族>/rules/mod.rs`——`pub(crate) mod my_rule;`
3. `crates/ruff_linter/src/codes.rs`——在 `code_to_rule` 加一行 `(Linter, "XXX") => rules::...::my_rule::MyRule`（`map_codes` 宏自动生成 `Rule` enum 变体）
4. `crates/ruff_linter/src/checkers/ast/mod.rs`——在对应 `visit_*` 方法加 `if checker.is_rule_enabled(Rule::MyRule) { my_rule::my_rule(checker, ...) }`
5. `crates/ruff_linter/resources/test/fixtures/<家族>/XXX.py`——测试 fixture + `#[test_case]`
6. 对应测试：`crates/ruff_linter/src/rules/<家族>/mod.rs` 测试模块

#### 场景 2：支持新的 Python 语法

1. `crates/ruff_python_ast/generate.py`——添加 AST 节点定义（唯一手改源）
2. 运行 `python generate.py` 重新生成 `generated.rs`（enum/struct/From/Ranged 全自动）
3. `crates/ruff_python_ast/src/visitor.rs` + `visitor/source_order.rs` + `visitor/transformer.rs`——添加遍历逻辑
4. `crates/ruff_python_parser/src/parser/statement.rs` 或 `expression.rs`——添加递归下降规则，必要时更新 `RecoveryContextKind`
5. `crates/ruff_python_semantic/`——若涉及新绑定/作用域语义

#### 场景 3：新增一个配置项

1. `crates/ruff_workspace/src/options.rs`——在 `LintOptions`/`FormatOptions` 加字段（`#[serde]` + `#[option]` 注解）
2. `crates/ruff_workspace/src/configuration.rs`——加 `Option<T>` 字段 + `from_options()`/`combine()` 合并逻辑
3. `crates/ruff_linter/src/settings.rs` 或 `ruff_workspace/src/settings.rs`——最终 `LinterSettings`/`FormatterSettings` 加字段
4. `configuration.rs::into_settings()`——转换
5. `cargo dev generate-json-schema --mode write`——重新生成 `ruff.schema.json`

---

## 测试体系

```
crates/ruff_linter/resources/test/fixtures/   # 规则测试夹具（按家族/规则码组织）
crates/ruff_python_formatter/resources/test/  # 格式化快照
crates/ruff_python_parser/snapshots/          # 解析器快照
crates/*/src/*.rs #[test_case]                # 内联参数化测试
crates/ruff_python_ast_integration_tests/     # AST 集成测试
```

| 代码层 | 测试类型 | 特点 |
|--------|----------|------|
| 规则实现 | fixture + snapshot | 每条规则一个 `.py` 夹具，`#[test_case(Rule::X, Path)]` 驱动，snapshot 比对诊断输出 |
| 解析器 | 快照测试 | `insta` 快照比对 AST + 错误恢复行为 |
| 格式化器 | fixture + snapshot | 输入/期望输出配对，对标 Black |
| 语义分析 | 单元测试 | `assert!(size_of::<BindingKind>() <= 24)` 等内存约束 |

规则测试夹具是理解规则行为最好的"可执行文档"——想理解某条规则，直接读 `resources/test/fixtures/<家族>/<CODE>.py`。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `crates/ruff/src/main.rs` 的 `main()` → `crates/ruff/src/lib.rs` 的 `run()` + `check()` → `crates/ruff/src/commands/check.rs` 的 `check()`（看 rayon 并行）→ `crates/ruff_linter/src/linter.rs` 的 `check_path()`（看多源 checker 分发）→ `crates/ruff_linter/src/checkers/ast/mod.rs` 的 `Checker` 实现 `Visitor`
- **第二遍：理解解析与语义**
  `crates/ruff_python_parser/src/lib.rs` 的 `parse_module()` → `parser/mod.rs` 的 `parse_list()`（error recovery）→ `crates/ruff_python_semantic/src/model.rs` 的 `SemanticModel` + `resolve_load()`（作用域链名称解析）
- **第三遍：理解规则与修复**
  挑一条简单规则（如 `rules/pyflakes/rules/raise_not_implemented.rs`，看 `Violation` + fix）→ `crates/ruff_linter/src/codes.rs` 的 `code_to_rule` + `map_codes` 宏 → `crates/ruff_linter/src/linter.rs` 的 `lint_fix()`（收敛循环）→ `crates/ruff_linter/src/fix/mod.rs` 的 `apply_fixes`
- **第四遍：理解格式化与编辑器集成**
  `crates/ruff_python_formatter/src/lib.rs` 的 `format_module_source()` → `crates/ruff_formatter/src/printer/mod.rs` 的 `Printer` + `FitsMeasurer`（group 算法）→ `crates/ruff_server/src/server.rs` 的 `Server::run()` + `session.rs` 的 Snapshot COW

每遍标注具体文件路径和该处读什么——主线在 linter.rs 的 `check_path`，它是所有 lint 行为的汇聚点。

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| LintSource | 规则的数据源类型（Ast/Tokens/Imports/PhysicalLines/Noqa/Filesystem 等），决定规则被哪个 checker 执行 |
| Binding | 语义模型中一个名字的绑定记录（赋值/import/参数等），含 20 种 BindingKind |
| deferred 延迟分析 | 函数体/lambda/类型注解等在模块级遍历完成后才二次分析，保证前向引用正确解析 |
| noqa | 行内/文件级注释，抑制特定规则的诊断 |
| group / soft line | 格式化 IR 概念：group 内的 soft line 由 Printer 按行宽决定变空格或换行 |
| preview | 规则/行为的渐进上线机制，未稳定规则默认不启用 |

### 参考资料

- [Ruff 官方文档](https://docs.astral.sh/ruff/)
- [Astral 官方博客：Ruff 介绍](https://astral.sh/blog/announcing-astral-the-company-behind-ruff)
- [Wadler-Leijen pretty-printing 算法](https://homepages.inf.ed.ac.uk/wadler/papers/prettier/prettier.pdf)（ruff formatter IR 的理论基础）
- [Pratt parsing](https://matklad.github.io/2020/04/13/simple-but-powerful-pratt-parsing.html)（ruff 表达式解析采用）
- [deepwiki-rs](https://github.com/sopaco/deepwiki-rs) / [CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（本文采用的方法论参考）
