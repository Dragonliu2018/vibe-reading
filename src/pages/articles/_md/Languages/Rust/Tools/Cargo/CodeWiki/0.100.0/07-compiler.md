---
source:
  type: "源码解读"
  project: "Cargo"
  url: "https://github.com/rust-lang/cargo"
title: "编译引擎"
date: "2026-08-19T12:13:38+08:00"
category: [Languages, Rust, Tools, Cargo, CodeWiki, "0.100.0"]
tags: ["Cargo", "Rust", "compiler", "fingerprint", "jobserver", "BuildContext"]
description: "Cargo 编译引擎解读：前端 BuildContext（只读快照）+ 后端 BuildRunner（可变运行态）两段式、fingerprint 增量判定（dirty/fresh）、job_queue jobserver 并发调度、unit_dependencies 把 Resolve 降维成 UnitGraph、custom_build build script 状态机。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/00-overview)

---

## 模块定位

这一层是 Cargo 唯一直接驱动 `rustc`/`rustdoc` 进程的地方。`src/compiler/mod.rs` 顶部文档自比"rustc 侧的 `rustc_interface`"——它负责从准备构建上下文、到调度每个 Unit 的 rustc 调用、到管理产物布局与缓存。它独立成层是因为**副作用最重**：spawn 进程、写 `target/`、并发线程，必须隔离在 compiler 内，不让 ops/CLI 沾染进程级操作。代码量 ~20,200 行，是 src 第三大目录。

## 模块架构

```
src/compiler/
├── mod.rs              # 顶层导出 + Executor trait + DefaultExecutor
├── build_context/      # 前端：BuildContext（只读构建快照）
├── build_runner/       # 后端：BuildRunner（可变运行态，协调中心）
├── unit.rs             # Unit（一次编译器调用的全部信息）
├── unit_dependencies.rs # Resolve → UnitGraph 降维
├── unit_graph.rs       # UnitGraph / UnitDep
├── fingerprint/        # dirty/fresh 增量判定
├── job_queue/          # jobserver 并发 + 调度 + drain_the_queue
├── custom_build.rs     # build script 执行与输出解析
├── layout.rs           # target/ 产物布局
├── compilation.rs      # Compilation：编译结果收集
├── build_config.rs     # BuildConfig / UserIntent / CompileMode
├── lto.rs / timings/ / artifact.rs / future_incompat.rs / links.rs / locking.rs / output_depinfo.rs / output_sbom.rs / trim_paths.rs / unused_deps.rs / rustdoc.rs / standard_lib.rs / crate_type.rs / compile_kind.rs
```

`mod.rs` 文档点名核心项：`BuildContext`（静态前端）、`BuildRunner`（运行协调中心）、`custom_build`、`fingerprint`、`job_queue`、`layout`、`unit_dependencies`、`Unit`。

## 调用链路

```
ops::create_bcx → BuildContext（前端，只读）
  └─ BuildRunner::new(bcx)（后端，可变）
       ├─ Layout::prepare                       # 准备 target/ 目录布局
       ├─ JobQueue::new + enqueue               # 每个 Unit 算 fingerprint 定 Freshness
       │    └─ fingerprint::prepare/fresh       # dirty/fresh
       └─ JobQueue::execute → DrainState::drain_the_queue
            ├─ 取 jobserver token → spawn 线程跑 rustc
            ├─ Message 队列回传（编译完成/错误/请求额外 token）
            └─ 摘除完成的叶子 Unit，直到队列空
       → Compilation（产物索引，供 test/run 复用）
```

<details><summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `BuildContext` 装配 | 前端只读快照 | 含 ws/gctx/profiles/build_config/packages/target_data/unit_graph |
| `BuildRunner::new` | 后端可变态 | 持有 compilation/build_script_outputs/fingerprints/mtime_cache |
| `fingerprint::prepare` | 算 Unit 的 dirty/fresh | 多机制：fingerprint 哈希 + mtime + 可选 checksum |
| `JobQueue::execute` | 并发跑队列 | 委托 `DrainState::drain_the_queue` |
| `drain_the_queue` | 真正的并发主循环 | Cargo 唯一用线程的地方 |
| `build_unit_dependencies` | Resolve→UnitGraph | 包间依赖降为 target 间依赖 |
| `custom_build::build_work` | 构造 build script 执行 | 编译+执行两 Unit |
| `Executor::exec` | 拦截 rustc 调用 | 默认透传，可被第三方覆盖 |

</details>

## 核心实现

### 前端 BuildContext：只读快照

`BuildContext`（`src/compiler/build_context/mod.rs`）是"前端产物"——`ops::create_bcx` 装配好后**不可变**的构建全貌：

```rust title="src/compiler/build_context/mod.rs"
pub struct BuildContext<'a, 'gctx> {
    pub ws: &'a Workspace<'gctx>,
    pub gctx: &'gctx GlobalContext,
    pub logger: Option<&'a BuildLogger>,
    pub profiles: Profiles,                    // 编译配置预设
    pub build_config: &'a BuildConfig,         // rustc 低层设置
    pub packages: PackageSet<'gctx>,            // 下载好的包集
    pub target_data: RustcTargetData<'gctx>,    // rustc/平台信息
    pub extra_compiler_args: HashMap<Unit, Vec<String>>,
    // unit_graph / root units ...
}
```

设计决策：前端只读是为了让 `cargo check`、`--unit-graph`（只导出图不编译）等只读用法能复用前端而不进入后端。`RustcTargetData` 缓存 `rustc --print` 探测的 target 信息（避免每个 Unit 重复 spawn rustc 探测）。`Profiles` 把 `[profile.*]` 解析成最终 rustc 参数预设。

### 后端 BuildRunner：可变运行协调中心

`BuildRunner`（`src/compiler/build_runner/mod.rs:40`）是 `mod.rs` 文档说的"center of the world"，持有构建过程所有可变态：

```rust title="src/compiler/build_runner/mod.rs"
pub struct BuildRunner<'a, 'gctx> {
    pub bcx: &'a BuildContext<'a, 'gctx>,       // 前端快照引用
    pub compilation: Compilation<'gctx>,        // 结果收集
    pub build_script_outputs: Arc<Mutex<BuildScriptOutputs>>,  // build script 输出
    pub build_explicit_deps: HashMap<Unit, BuildDeps>,          // rerun-if-changed
    pub fingerprints: HashMap<Unit, Arc<Fingerprint>>,
    pub mtime_cache: HashMap<PathBuf, FileTime>,   // mtime 缓存省 fs 命中
    pub checksum_cache: HashMap<PathBuf, Checksum>,
    pub compiled: HashSet<Unit>,                   // 已编译 Unit（去重）
    // ...
}
```

为什么前端/后端要拆：前端可缓存复用（多次 query 同一构建配置），后端只能跑一次（有副作用）。后端用 `Arc<Mutex<>>` 共享 `build_script_outputs`——多线程跑 build script 时要互斥写输出。`compiled` HashSet 去重：同一 Unit 可能被多个包依赖，但只编译一次。

### fingerprint：增量编译判定

`src/compiler/fingerprint/mod.rs` 顶部文档讲清 dirty/fresh 的多机制。`Fingerprint` 是存进 `.fingerprint/` 的哈希，记录 Unit 的全部输入：

- **fingerprint 哈希**：含源文件名、rustc 版本、依赖的 fingerprint 等。缺失或变 = dirty。依赖的 fingerprint 变会**向上传播**——改了底层 crate，所有依赖它的都变 dirty。
- **mtime 比较**：输出 mtime vs 依赖输出 mtime（`check_filesystem`）；源文件 mtime vs dep-info 文件 mtime（`find_stale_file`）。
- **checksum-freshness**（unstable）：忽略 mtime，比文件大小+校验和，靠 rustc emit 的元数据——mtime 在跨文件系统/CI 缓存不可靠时的替代方案。

`DirtyReason`（`fingerprint` 导出）精确记录为什么 dirty，驱动 `cargo clean` 与诊断。这套机制是 Cargo 增量编译的根基——让改一行只重编受影响的 Unit。

### job_queue：jobserver 并发调度

`src/compiler/job_queue/mod.rs` 文档把并发模型讲得很透。关键设计：Cargo 与 rustc 共享**单个 jobserver**（1 cargo : N rustc）。令牌来源：环境继承（如 `make -j`）或 Cargo 自建。核心约束是**总令牌数恒为 N**（`-j`），绝不超订。

```
JobQueue::new → enqueue(按优先级入队) → execute → DrainState::drain_the_queue
  ├─ Fresh 的 Job 同线程跑（省线程开销），Dirty 的 spawn 线程
  ├─ 每个 rustc 进程通过 jobserver 协议申请/释放令牌
  └─ Message 队列跨线程回传：编译完成/错误/请求额外令牌
```

`Freshness`（`job_queue` 导出）决定 Job 是在线程池跑（dirty，开销大）还是同线程跑（fresh，几乎零开销）。调度优先级在 `enqueue` 时定（`mod.rs` 文档自承"relatively rudimentary and could likely be improved"）。`drain_the_queue` 是 `mod.rs` 文档点名的"the only point in cargo that currently uses threads"。

### unit_dependencies：Resolve → UnitGraph 降维

`src/compiler/unit_dependencies.rs` 顶部文档解释为何不能直接用 `Resolve` 编译：`Resolve` 描述**包间**依赖，但编译要 **target 间**依赖——一个包有 lib/bin/example/test/bench/build.rs 多个 target，编译顺序在 target 粒度（先 lib 后 bin、先 build.rs 后其余）。所以要把 `Resolve`（包图）**降低**成 `UnitGraph`（Unit 图），`Unit` = Package+Target+Profile+CompileMode 的组合，捕获"同一 target 可能编译多次"（如带/不带 test）。

```rust title="src/compiler/unit_dependencies.rs（文档）"
// 从 Resolve（包间依赖）降到 UnitGraph（target 间依赖）
// 因为一个包有多个 target，且同一 target 可能以不同模式编译多次
```

`State` 结构（`unit_dependencies.rs`）是构造 UnitGraph 的工作集，`UnitDep`/`UnitGraph`（`unit_graph.rs`）是产物。这个降维是编译正确性的关键——它决定了 rustc 调用的拓扑顺序。

### custom_build：build script 状态机

`src/compiler/custom_build.rs` 文档讲清 build script 的两 Unit 模型。一个 `build.rs` 产生两个特殊 Unit：

- **build script 编译 Unit**（`TargetKind::CustomBuild`）——和其他 target 编译一样，递归编译依赖。
- **build script 执行 Unit**（`CompileMode::RunCustomBuild`）——在 UnitGraph 构造时插入，依赖编译 Unit，保证可执行文件就绪才跑。

执行时靠 **stdout 指令**与 Cargo 通信（`cargo:rerun-if-changed=...`/`cargo:rustc-link-lib=...` 等），由 `BuildOutput::parse` 解析存进 `BuildRunner::build_script_outputs`。`build_explicit_deps` 记录显式声明的依赖（rerun-if-changed），未跑过的 build script 必须跑。这是 build script 的状态机：首次必跑 → 输出指令 → 后续按指令判定是否重跑。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两段式（前端/后端） | `BuildContext`/`BuildRunner` | 只读前端可复用，可变后端隔离副作用 |
| 拦截器 | `trait Executor` + `DefaultExecutor` | 第三方可拦截 rustc 调用注入逻辑 |
| 状态机 | custom_build 两 Unit + 指令解析 | build script 首跑/重跑判定 |
| 令牌传递 | jobserver | 与 make/rustc 共享并发上限 |
| 哈希传播 | fingerprint 依赖链 | 改动按依赖图向上传播 dirty |
| 降维图变换 | Resolve→UnitGraph | 包图→target 图，编译正确拓扑 |
| 缓存 | mtime_cache/checksum_cache | 省 fs 命中，热路径 |

## 模块间交互

`compiler` 消费 `workspace`（`Package`/`Target`/`Profiles`/`PackageId`）、`sources`（`fingerprint` 查源 commit OID、`download` 取包）、`context`（rustc 路径、配置）、`resolver`（`Resolve` 图经 `unit_dependencies` 降维）。它被 `ops::cargo_compile` 编排——ops 装前端、调后端，compiler 不主动碰 ops。产出 `Compilation` 回给 ops，供 `cargo test`/`cargo run` 复用编译产物。`Executor` trait 是它与外部工具（如 RustRustc、clippy）的扩展接口。

## 扩展方式

拦截 rustc 调用：实现 `trait Executor`（`src/compiler/mod.rs`）的 `exec`，在 rustc 进程真正跑前注入参数/替换命令，通过 `ops::compile_with_exec`（非 `compile`）传入——`compile` 用 `DefaultExecutor` 透传。新增编译模式：在 `build_config.rs::CompileMode` 加变体，在 `unit_dependencies` 加对应 Unit 生成逻辑，在 `job_queue` 加执行分支。改产物布局：动 `layout.rs`（但 build-dir layout v2 刚稳定化，改动需谨慎，见近期 commit）。
