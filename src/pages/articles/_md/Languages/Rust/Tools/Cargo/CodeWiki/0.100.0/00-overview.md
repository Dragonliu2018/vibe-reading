---
source:
  type: "源码解读"
  project: "Cargo"
  url: "https://github.com/rust-lang/cargo"
title: "Overview"
date: "2026-08-19T12:13:38+08:00"
category: [Languages, Rust, Tools, Cargo, CodeWiki, "0.100.0"]
tags: ["Cargo", "Rust", "包管理器", "构建系统", "依赖解析"]
description: "Cargo v0.100.0 源码架构解读：从 CLI 命令分发、操作编排层、编译引擎（BuildContext/BuildRunner/fingerprint/job_queue）、工作区与清单、源管理 Source trait、依赖解析 DFS 回溯算法到配置上下文 GlobalContext 与诊断 lint 系统的全面 internals 拆解。"
readingTime: "50 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.100.0 · **协议** MIT OR Apache-2.0 · **语言** Rust (edition 2024, MSRV 1.97) · **代码量** ~129,000 行（src ~107k + crates ~22k）· **仓库** [GitHub](https://github.com/rust-lang/cargo)

---

## 总览

### 项目简介

Cargo 是 Rust 的官方包管理器与构建系统，随 rustup 分发的那个 `cargo` 二进制就是这个仓库的产物。它把"下载依赖、解析版本、编译项目、发布到 registry"这几件原本割裂的事统一成一个工具：写一行 `serde = "1"` 它就去 crates.io 拉取兼容版本、写进 `Cargo.lock`、调用 `rustc` 按依赖拓扑顺序编译，并把产物摆进 `target/`。

它的核心价值不在"能编译"，而在**把整个 Rust 生态（crates.io 索引、semver 兼容、增量编译缓存、build script、feature 统一、jobserver 并发）封装成一个可复现的构建契约**——开发者只管声明依赖，版本选择、下载缓存、增量判定、并发调度全部由 Cargo 内部处理。

核心使用场景：`cargo build`/`check`/`test`/`run`（本地编译）、`cargo update`（升级依赖）、`cargo add`/`remove`（增删依赖）、`cargo publish`/`yank`（发布到 registry）、`cargo install`（安装二进制）、`cargo vendor`（离线源码归档）、`cargo metadata`/`tree`（导出依赖图）。

**项目边界**：Cargo 负责**包的元数据与编排**——解析 `Cargo.toml`、解析依赖图、调度 `rustc`/`rustdoc` 进程、管理 `target/` 布局；它**不负责**实际的类型检查、代码生成与链接（那是 `rustc` 的职责），也不负责 rustup 工具链安装本身。Cargo 把每个 crate 的编译下放给 `rustc` 进程，自己只做"编排者"。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 编译/检查/测试/运行 | `src/ops/cargo_compile/mod.rs` | 所有编译类命令的统一入口 `compile()` |
| 依赖解析 | `src/resolver/mod.rs` | NP-hard 语义版本解析，DFS + 回溯 |
| 依赖下载与缓存 | `src/sources/registry/mod.rs`、`src/sources/git/` | Source trait 抽象，registry/git/path/vendor 四类源 |
| 清单解析 | `src/workspace/manifest.rs`、`src/workspace/parser/` | `Cargo.toml` → `Manifest` |
| 增量编译判定 | `src/compiler/fingerprint/mod.rs` | fingerprint + mtime 判定 dirty/fresh |
| 并发调度 | `src/compiler/job_queue/mod.rs` | jobserver 令牌 + 线程池 |
| 配置系统 | `src/context/mod.rs` | 三层配置合并（文件/env/CLI）+ serde |
| 诊断 lint | `src/diagnostics/mod.rs` | 数据驱动的 passes + rules |
| build script | `src/compiler/custom_build.rs` | 编译前执行，解析 stdout 指令 |
| registry Web API | `src/ops/registry/` | publish/yank/owner/search/login |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| `clap` | 核心 | CLI 参数解析与子命令 |
| `serde` + `toml` | 核心 | 配置与清单反序列化 |
| `gix` / `git2` | 核心 | git 源与 git 依赖 |
| `curl`/`reqwest`(async) | 核心 | registry 索引与 crate 下载 |
| `tracing` | 核心 | 结构化日志 |
| `annotate-snippets`+`anstyle` | 核心 | 诊断报告渲染（彩色片段） |
| `im_rc` | 核心 | 解析器中的持久化数据结构（回溯快照零拷贝） |
| `rustc-hash`(`FxHashMap`) | 核心 | 高性能哈希，解析/构建热路径 |
| `blake3` | 核心 | fingerprint/缓存哈希 |
| `anyhow` | 核心 | 错误传播 |
| `cargo-util-schemas` | 子 crate | `Cargo.toml`/`Cargo.lock` 的 schema 定义 |
| `cargo-util-terminal` | 子 crate | Shell 输出与彩色报告 |

### 版本历史

Cargo 与 rustc 同步发布（跟随 rustc submodule 更新）。本篇解读的 v0.100.0 处于 master HEAD、对应下一轮稳定版，已落地若干近期演进：`-Zembed-metadata=no` 默认在 nightly 启用（`Cargo.toml:17267`）、build-dir layout v2 重新稳定化、诊断系统从"散落 warn"重构为**数据驱动的 pass + rule** 模型（`src/diagnostics/`）。架构主轴（ops 薄封装 + compiler 两段式 BuildContext/BuildRunner + resolver 回溯）自 2017 年前后稳定至今。

## 快速上手

代码阅读者视角的最快验证路径（假设已装 rustup）：

```bash title="构建并验证 Cargo 自身"
cd /Users/ace/code/Language/cargo
cargo build            # 用系统 cargo 引导编译 cargo 自身
./target/debug/cargo --version      # 预期: cargo 1.0.0 (...) — 跑起来了
./target/debug/cargo build --manifest-path tests/testsuite/build.rs/fixtures/foo/Cargo.toml
```

> Cargo 是"自举友好"的：用已发布的 `cargo` 编译仓库自身即可，无需特殊构建系统。开发迭代时 `cargo build` 即可看到改动生效。`cargo nextest run -p cargo` 跑测试套件（仓库推荐 nextest）。

## 架构设计解析

### 系统架构

Cargo 的架构思想是**严格分层 + 薄命令封装 + 编排与执行分离**：上层每条命令（`build`/`test`/`doc`）都只是 `ops` 里同名操作的薄封装，自身不含业务逻辑；`ops` 是编排者，把"取清单 → 解析依赖 → 下载 → 构造 Unit 图 → 调度 rustc"串成流水线；真正与 `rustc` 打交道的执行细节全部下沉到 `compiler`；而领域名词（`Package`/`Manifest`/`SourceId`）和算法（resolver）独立成层，被上层复用。这样分层的好处是：加一条命令只需在 `bin/cargo/commands/` 加薄文件 + `ops/` 加操作，编译流水线改动不会外溢到 CLI 层，领域模型可被 `cargo metadata` 等只读命令直接复用。

![Cargo 分层架构](/vibe-reading/images/articles/cargo-internals/architecture.svg)

五层自上而下、依赖方向向下（上层依赖下层，下层不知道上层存在）：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 命令入口层 | `src/bin/cargo/` | 解析 argv、装配 `GlobalContext`、分发到子命令；把"用户语言"翻译成"ops 调用"，自身无业务逻辑 |
| 操作编排层 | `src/ops/` | 每条命令对应一个操作函数，编排"解析→下载→编译→发布"流水线；是 CLI 与执行细节之间的缓冲带 |
| 编译引擎层 | `src/compiler/` | 唯一直接驱动 `rustc`/`rustdoc` 进程的层；负责 Unit 图、fingerprint、jobserver 并发、产物布局 |
| 领域与解析层 | `src/workspace/`、`src/resolver/`、`src/sources/` | 项目的"名词"（Package/Manifest/SourceId）与"算法"（依赖解析 DFS）；无 IO 副作用，可被只读命令复用 |
| 基础设施层 | `src/context/`、`src/util/`、`src/diagnostics/`、`crates/` | 配置、网络、锁、interning、诊断等横切关注点；被所有上层依赖 |

> 一个关键设计：**编译器层不直接读 `Cargo.toml`**。它只消费 `BuildContext`——一个由 `ops` 用 workspace+resolver+sources 装配好的不可变快照。这让"解析"与"执行"可独立测试、可分别替换（如 `cargo metadata` 只走前几层不进 compiler）。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 薄封装 / Facade | `commands/build.rs::exec` → `ops::compile` | 命令只做参数翻译，业务演进不影响 CLI；测试可直接打 ops |
| 两段式构建（前端/后端） | `BuildContext`（前端）+ `BuildRunner`（后端） | 前端只读快照便于缓存/校验，后端持有可变运行态；职责分离 |
| 策略 + 拦截器 | `trait Executor`（`src/compiler/mod.rs`）+ `DefaultExecutor` | 允许第三方（如 RustRustc）拦截 rustc 调用注入逻辑，而不改 Cargo 主流程 |
| Source 抽象（策略族） | `trait Source`（`src/sources/source.rs`）+ 5 实现 | 把 registry/git/path/vendor 的差异藏在统一接口后，resolver 不感知源类型 |
| 持久化数据结构回溯 | `im_rc::HashMap` 在 `ResolverContext`（`src/resolver/context.rs`） | 回溯算法要频繁"撤销决策"，持久化结构让克隆/回退 O(1) |
| jobserver 令牌传递 | `src/compiler/job_queue/mod.rs` | 与 `make`/rustc 共享同一令牌池，保证总并发 ≤ N，不超订 CPU |
| 数据驱动诊断 | `passes` + `rules`（`src/diagnostics/`） | lint 规则与执行框架分离，加 lint 只改数据表不动框架 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `GlobalContext` | 全局配置与环境（`src/context/mod.rs:209`） | 进程级单例，`main()` 创建后贯穿全程 | 被几乎所有结构以 `&gctx` 持有 |
| `Workspace` | 一个 workspace 的所有 package 集合（`src/workspace/workspace.rs:50`） | 命令期 | 持有 `packages`/`PackageSet`/`target_dir` |
| `Manifest` | 解析后的 `Cargo.toml`（`src/workspace/manifest.rs:64`） | 包级 | 持有 `Summary`/`Vec<Target>`/`workspace config` |
| `Package` | 文件系统上的一个包（`src/workspace/package.rs`，`Rc<PackageInner>`） | 包级 | 持有 `Manifest`+`manifest_path` |
| `PackageId` | 包的唯一身份证（name+version+SourceId） | 永久（可序列化进 lock） | 索引一切解析结果 |
| `SourceId` | 源的唯一标识（`src/workspace/source_id.rs`） | 永久 | 区分 crates.io/git/path 等 |
| `Resolve` | 解析后的依赖图（`src/resolver/resolve.rs`） | 单次构建 | 节点=PackageId，边=Dependency |
| `Unit` | 一次编译器调用（`src/compiler/unit.rs`） | 单次构建 | Package+Target+Profile+CompileMode 的组合 |
| `UnitGraph` | 编译用的 Unit 依赖图（`src/compiler/unit_graph.rs`） | 单次构建 | 由 `Resolve` 降低而来 |
| `BuildContext` / `BuildRunner` | 构建前端/后端（`src/compiler/build_context/`、`build_runner/`） | 单次构建 | 前端只读→后端可变 |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Source` | `src/sources/source.rs` | `RegistrySource`/`GitSource`/`PathSource`/`DirectorySource`/`ReplacedSource` | `SourceConfigMap` 按 `[source.*]` 配置懒加载 |
| `Executor` | `src/compiler/mod.rs` | `DefaultExecutor` | `compile_with_exec` 传入，默认即透传 |
| `Registry`（resolver 视角的源） | `src/workspace/registry.rs` | 由 `SourceMap` 聚合 | `ops::resolve` 内构造 |
| `Source` 的 `MaybePackage` | `src/sources/source.rs` | `Ready`/`Download` | `download()` 返回，驱动下载状态机 |

## 代码目录

```
cargo/
├── src/                      # cargo 二进制主体（~107k 行）
│   ├── bin/cargo/            # 入口：main.rs + cli.rs + commands/*.rs（42 个子命令薄封装）
│   ├── ops/                  # 操作编排层（21k 行，每条命令一个 cargo_* 模块）
│   ├── compiler/             # 编译引擎（20k 行：build_context/build_runner/fingerprint/job_queue/...）
│   ├── workspace/            # 清单/包/SourceId 领域模型（20k 行）
│   ├── sources/              # Source trait + registry/git/path/vendor 实现（10k 行）
│   ├── resolver/             # 依赖解析核心算法（6k 行）
│   ├── context/              # GlobalContext 配置系统（5.5k 行）
│   ├── diagnostics/         # lint passes/rules 数据驱动诊断（4.6k 行）
│   ├── util/                 # 横切工具：网络/锁/interning/进度（12.5k 行）
│   ├── lib.rs                # cargo-as-library 导出 + 架构文档
│   └── version.rs
├── crates/                   # 独立发布的子 crate（22k 行）
│   ├── cargo-util-schemas/   # Cargo.toml/Cargo.lock 的 schema（serde）
│   ├── cargo-util/           # 进程/路径/文件系统工具
│   ├── cargo-util-terminal/  # Shell 输出与彩色报告
│   ├── cargo-platform/       # Platform/Cfg 表达
│   ├── crates-io/           # crates.io Registry 类型
│   ├── rustfix/             # 诊断→自动修复
│   ├── home/                # cargo home 目录定位
│   └── xtask-*/             # 仓库维护任务
├── credential/              # 凭据存储后端（macOS Keychain/WinCred/libsecret）
├── tests/testsuite/         # 端到端测试（snapshot 测试为主）
├── benches/                 # 性能基准
└── Cargo.toml               # workspace 根 + cargo 包本身（[package] version=0.100.0）
```

## 模块地图

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| CLI 命令分发 | 解析 argv、分发子命令 | `bin/cargo/cli.rs::main` | 它是"用户语言→ops 调用"的唯一翻译层，自身零业务逻辑 | [CLI 命令分发](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/01-cli-commands) |
| 配置上下文 | 三层配置合并、环境探测 | `context::GlobalContext::default` | 配置是横切关注点，所有层都依赖它，必须独立且无上游 | [配置上下文](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/02-context) |
| 工作区与清单 | `Cargo.toml` 解析、Package/SourceId 领域模型 | `Workspace::new`、`manifest::Manifest` | 承载项目的"名词"，被解析/编译/只读命令共享 | [工作区与清单](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/03-workspace) |
| 源管理 | 从 registry/git/path 获取包 | `sources::source::Source` trait | 源类型差异大（HTTP/git/fs），用 trait 封装后 resolver 不感知具体源 | [源管理](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/04-sources) |
| 依赖解析 | semver 兼容的版本图解析 | `resolver::resolve` | 是独立 NP-hard 算法，与 IO/编译解耦，可单独复用与测试 | [依赖解析](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/05-resolver) |
| 操作编排 | 把命令翻译成跨模块流水线 | `ops::cargo_compile::compile`、`ops::resolve_ws_with_opts` | 是 CLI 与执行细节的缓冲带，集中编排避免散落各处 | [操作编排层](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/06-ops) |
| 编译器 | 驱动 rustc、增量、并发 | `compiler::BuildContext`/`BuildRunner` | 唯一直接进程级操作 rustc 的层，副作用最重，必须隔离 | [编译引擎](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/07-compiler) |
| 诊断 | lint 规则与执行框架 | `diagnostics::passes::emit_parse_diagnostics` | 数据驱动模型让 lint 规则可独立增删，框架稳定 | [诊断系统](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/08-diagnostics) |

![模块依赖关系](/vibe-reading/images/articles/cargo-internals/module-dependencies.svg)

依赖方向遵循"上层依赖下层"：CLI → ops → compiler，ops/resolver/sources 都汇聚到 workspace 与 sources，而 `context`+`util`+`diagnostics` 是被全员依赖的底座。注意 `compiler` 与 `resolver` 都不直接 import 彼此——它们通过 `ops` 的编排间接协作（`ops::resolve_ws_with_opts` 喂给 `create_bcx`）。

## 运行时行为

### 启动流程

```
main() in src/bin/cargo/main.rs
  ├─ setup_logger()                        # tracing 日志
  ├─ GlobalContext::default()              # 装配配置：读 ~/.cargo/config、env、CLI --config
  ├─ clap_complete::CompleteEnv            # nightly: shell 补全短路
  ├─ fix_get_proxy_lock_addr()?             # cargo fix 代理模式分支
  └─ cli::main(&mut gctx) in cli.rs
       ├─ cli(gctx).try_get_matches()       # clap 解析 argv
       ├─ expand_aliases()                 # 展开 [alias] 与外部子命令
       ├─ configure_gctx()                 # 应用 verbose/frozen/locked/target 等
       ├─ init_git()                        # 注册 git2 transport
       └─ exec.exec(gctx, args)            # Exec::infer(cmd) 分发到 commands/*.rs::exec
```

对象装配的关键：`GlobalContext` 是第一个被 `new` 出来的对象，它内部用 `OnceLock` 懒初始化 `home_path`/`values`/`cargo_exe`/`rustdoc`/`sysroot`——配置不是一次性全读，而是按需在第一次 `get()` 时从文件/env/CLI 三源合并（见配置上下文模块）。`Workspace` 在每条命令的 `args.workspace(gctx)?` 里才构造（`command_prelude` 提供），因此"配置先行、工作区按需"。

### 核心运行流程

下面三条链路覆盖了 Cargo 最核心的运行模式：构建、解析、发布。

#### 构建：cargo build 主链路

业务流程：读 `Cargo.toml` → 解析依赖图 → 写/读 `Cargo.lock` → 下载缺失 crate → 构造 Unit 图 → 判定增量 → 并发调度 rustc → 产物入 `target/`

![cargo build 数据流](/vibe-reading/images/articles/cargo-internals/data-flow.svg)

文字描述：入口 `commands/build.rs::exec`（`src/bin/cargo/commands/build.rs`）只做参数翻译，调 `ops::compile(&ws, &compile_opts)`（`src/ops/cargo_compile/mod.rs`）。`compile_with_exec` 先跑诊断 parse pass，再 `compile_ws` 装配 `BuildContext`：`create_bcx` 内部依次 `RustcTargetData::new`（探 rustc 信息）→ `ops::resolve_ws_with_opts`（解析依赖，产物 `WorkspaceResolve{pkg_set, resolve, ...}`）→ `UnitGenerator::generate_root_units`（把命令行选中的 target 转成 root `Unit`）→ `build_unit_dependencies`（把"包间依赖"的 `Resolve` **降低**为"target 间依赖"的 `UnitGraph`，因为一个包有 lib/bin/build.rs 多个 target，编译顺序要在 target 粒度）→ 装成 `BuildContext`。随后 `BuildRunner::new` 接管后端：`Layout` 准备 `target/` 布局，`JobQueue` 对每个 Unit 算 `fingerprint` 判 dirty/fresh，最后 `drain_the_queue` 用 jobserver 令牌并发跑 rustc，结果收进 `Compilation`。`cargo test`/`run`/`doc` 复用同一条链，只是 `UserIntent` 与 root Unit 不同。

#### 解析：cargo update / 依赖图计算

业务流程：读 `Cargo.toml` 的依赖声明 → 向各 Source 查询候选版本 → DFS 激活最高兼容版本 → 冲突则回溯 → 生成新的 `Resolve` 图 → 落盘 `Cargo.lock`

文字描述：`ops::resolve_ws_with_opts`（`src/ops/resolve.rs`）先构造 `SourceConfigMap` 聚合所有源，再调 `resolver::resolve`（`src/resolver/mod.rs:125`）。核心是 `activate_deps_loop`（`src/resolver/mod.rs`）做 DFS：对每个依赖，`RegistryQueryer` 向 Source `query` 拿候选 Summary 列表，**优先激活最高版本**，遇到 semver 不兼容或 `links` 冲突就记入 `ConflictCache` 并回溯。`ResolverContext` 用 `im_rc::HashMap` 持久化结构保存 `activations`/`parents`，回退只 O(1) clone。解析跑两遍：第一遍全 feature（写 lock），第二遍按用户选的 feature（编译用）。详见依赖解析模块。

#### 发布：cargo publish

业务流程：校验清单 → 打包 `.crate`（tar+gzip）→ 上传到 registry Web API → 等待索引更新

文字描述：`ops::registry::publish`（`src/ops/registry/cargo_publish.rs`）先 `package` 打包（含校验 `Cargo.lock` 一致性、`cargo package` 生成 `.crate`），再用 `cargo_credential` 取 token，通过 `http_async` 把 `.crate` POST 到 registry 的 publish 端点。registry 收到后异步建索引，Cargo 轮询直到索引可见或超时。`yank`/`owner`/`search` 走同一套 `ops/registry/` 的 Web API 封装。

## 典型修改场景

#### 场景 1：新增一条 cargo 子命令

- 新增 `src/bin/cargo/commands/<name>.rs`：定义 `cli()`（clap `Command`）+ `exec(gctx, args)`
- 在 `src/bin/cargo/commands/mod.rs` 注册（`builtin_command!` 宏 + `COMMAND_FLAGS`）
- 把业务逻辑写进 `src/ops/cargo_<name>.rs`，`exec` 只调 `ops::<name>`
- 对应测试：`tests/testsuite/<name>.rs`（snapshot 测试，用 `snapbox`）

#### 场景 2：新增一种源（如新的私有 registry 协议）

- 实现 `src/sources/<name>.rs`：实现 `Source` trait 的 `query`/`download`/`finish_download`/`fingerprint` 等
- 在 `src/sources/config.rs::SourceConfigMap` 注册加载逻辑
- 在 `src/workspace/source_id.rs::SourceKind` 加变体
- 对应测试：`tests/testsuite/registry.rs` 系列

#### 场景 3：新增一条 lint 规则

- 在 `src/diagnostics/rules/` 下定义规则（数据驱动，`FnLintManifest`/`FnLintPackage` 等）
- 注册进 `src/diagnostics/rules/mod.rs::LINTS`
- 如需新 pass，在 `src/diagnostics/passes.rs` 加并接入 `emit_parse_diagnostics` 调用点
- 对应测试：`tests/testsuite/diagnostics/`

## 测试体系

```
tests/
├── testsuite/        # 端到端 snapshot 测试（主体，用 snapbox 比对输出）
│   ├── build.rs      # 每个命令一个测试文件
│   ├── registry.rs
│   └── ...
└── benchmarks/       # 性能基准
```

| 代码层 | 测试类型 |
| --- | --- |
| ops/compiler/resolver | testsuite 端到端（snapshot 全流程输出） |
| sources/registry | testsuite + `tests/testsuite/registry/` |
| diagnostics | `tests/testsuite/diagnostics/` |
| 子 crate (cargo-util-schemas 等) | 各 crate 内 `tests/` |

Cargo 的测试哲学是**重端到端、轻单测**：绝大多数行为通过"跑一次真实 cargo + 比对 stdout/stderr 快照"验证。想理解某条命令，优先读 `tests/testsuite/<cmd>.rs`——它是最好的可执行文档。

## 阅读源码推荐路线

- 第一遍：理解主流程
  `src/bin/cargo/main.rs::main` → `src/bin/cargo/cli.rs::main`（argv 解析与分发）→ `src/bin/cargo/commands/build.rs::exec`（最薄的命令封装）→ `src/ops/cargo_compile/mod.rs::compile` / `create_bcx`（编排流水线）
- 第二遍：理解核心数据结构
  `src/workspace/manifest.rs::Manifest` → `src/workspace/package.rs::Package` → `src/workspace/package_id.rs::PackageId` / `source_id.rs::SourceId` → `src/compiler/unit.rs::Unit`（编译粒度）
- 第三遍：理解两个算法核心
  `src/resolver/mod.rs::resolve` → `activate_deps_loop`（DFS 回溯，配 `src/resolver/context.rs::ResolverContext` 看持久化回溯）→ `src/compiler/fingerprint/mod.rs`（dirty/fresh 判定）→ `src/compiler/job_queue/mod.rs::DrainState::drain_the_queue`（jobserver 并发）
- 第四遍：选择重点子模块深入阅读（模块文档）

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| Unit | 一次编译器调用（Package+Target+Profile+Mode 的组合），是编译调度的最小单元 |
| fingerprint | 判断 Unit 是否需要重编译的哈希，存 `.fingerprint/` |
| jobserver | make 协议的令牌传递机制，Cargo/rustc 共享以限制总并发 |
| resolve / Resolve | 依赖版本图的解析结果（选定版本 + 边） |
| Source / SourceId | 包来源的抽象与唯一标识 |
| links | 清单中声明链接某原生库的属性，用于避免两个版本同时链接 |
| feature | 可选依赖/条件的开关，解析时统一 |
| build script | `build.rs`，编译前执行，靠 stdout 指令与 Cargo 通信 |

### 参考资料

- [The Cargo Book](https://doc.rust-lang.org/cargo/) — 官方用户文档
- [Cargo Contributor Guide](https://rust-lang.github.io/cargo/contrib/) — 贡献者指南
- [Cargo Architecture Overview](https://doc.rust-lang.org/nightly/nightly-rustc/cargo/) — nightly rustdoc（`src/lib.rs` 顶部文档即此来源）
- [rustc-dev-guide: Errors and Lints](https://rustc-dev-guide.rust-lang.org/diagnostics.html) — 诊断设计参考

## 相关阅读

- [uv 源码解读](/vibe-reading/articles/Languages/Python/Tools/uv/CodeWiki) — **方法论镜像**·同为包管理器，Rust 实现的 Python 包/虚拟环境工具，可对照解析与缓存设计
- [Ruff 源码解读](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki) — **同家族**·Rust 写的 Python 工具链，对照 Rust 工程实践与诊断报告渲染
