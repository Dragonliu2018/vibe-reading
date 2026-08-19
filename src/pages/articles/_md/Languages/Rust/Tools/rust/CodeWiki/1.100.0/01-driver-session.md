---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "驱动与会话"
date: "2026-08-19T14:56:00+08:00"
category: [Languages, Rust, Tools, rust, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "驱动", "CodeWiki"]
description: "rustc 的驱动主循环、Callbacks 回调注入与 Session 会话装配。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/rust/CodeWiki/1.100.0/00-overview)

---

## 模块定位

`rustc` 二进制本身只有几十行——真正的编译逻辑在 `rustc_driver_impl`。这一层是**编译流程的编排者**：它解析命令行、装配 `Session`（编译会话）与 `CodegenBackend`（代码生成后端），然后用一个**回调注入**机制把全局流程固定下来、把可变点留给外部工具。它是编译器对外的边界——rustdoc、clippy、miri 不需要 fork rustc，只需实现 `Callbacks` trait 介入编译流程。涉及 crate：`rustc_driver_impl`（驱动主循环）、`rustc_interface`（编译流程公共 API）、`rustc_session`（Session/Options）。

## 模块架构

驱动层有三个核心对象，职责清晰分层：

- **`Session`**（`rustc_session/src/session.rs:327`）：编译会话的全局状态，持有 `target`、`opts`、`psess`（解析会话）、`config`、`prof` 等。它依赖少，可独立于 `TyCtxt` 存在。
- **`Compiler`**（`rustc_interface/src/interface.rs:36`）：编译器实例，持有 `sess: Session`、`codegen_backend: Box<dyn CodegenBackend>`、`override_queries`。源码注释明确："`Compiler` 包含 `Session`，但 `Session` 依赖更少，不能放在 `Session` 中的东西放到了 `Compiler` 里"。
- **`Callbacks` trait**（`rustc_driver_impl/src/lib.rs:120`）：回调注入接口，在解析后、展开后、分析后三个点提供钩子，返回 `Compilation` 决定是否继续。

`Options`（`rustc_session/src/options.rs:333`）是 CLI 选项集合，每个字段带 `[TRACKED]`/`[UNTRACKED]`/`[TRACKED_NO_CRATE_HASH]` 标记，供增量编译依赖追踪——一个选项是否影响编译结果，决定了它变更时是否要让相关 query 失效。

## 调用链路

从二进制入口到链接完成的核心调用链：

```
main()                                     // rustc/src/main.rs
  └→ run_compiler(at_args, callbacks)      // rustc_driver_impl/src/lib.rs:172
       ├→ handle_options → Options        // 解析 CLI
       ├→ 组装 interface::Config           // lib.rs:208-225
       ├→ callbacks.config(&mut config)    // 回调注入点 #0
       └→ interface::run_compiler(config, |compiler| {  // interface.rs:370
            ├→ build_session + get_codegen_backend
            ├→ 构造 Compiler { sess, codegen_backend }
            └→ create_and_enter_global_ctxt(compiler, krate, |tcx| {  // passes.rs:935
                 ├→ setup_dep_graph       // passes.rs:961
                 ├→ DEFAULT_QUERY_PROVIDERS // passes.rs:898 注册 ~20 crate 的 provider
                 ├→ TyCtxt::create_global_ctxt   // passes.rs:1004
                 ├→ passes::parse → ast::Crate    // passes.rs:53
                 ├→ callbacks.after_crate_root_parsing()  // 回调 #1
                 ├→ tcx.resolver_for_lowering()  // 宏展开 + 名称解析
                 ├→ callbacks.after_expansion(tcx)  // 回调 #2
                 ├→ tcx.analysis(())               // 类型检查 + 借用检查
                 ├→ callbacks.after_analysis(tcx) // 回调 #3
                 ├→ Linker::codegen_and_build_linker(tcx, backend)
                 └→ linker.link(sess, incr_comp, backend)
            })
       })
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `run_compiler` (`lib.rs:172`) | 驱动主循环，装配并执行编译 | 用闭包 `f` 注入具体逻辑 |
| `interface::run_compiler` (`interface.rs:370`) | 构造 Session/Compiler 并执行闭包 | 模板方法，固定装配骨架 |
| `create_and_enter_global_ctxt` (`passes.rs:935`) | 创建 `TyCtxt` 并进入 `'tcx` 生命周期 | 闭包形式保证 `'tcx` 单生命周期 |
| `Callbacks::config` (`lib.rs:120`) | 回调注入配置 | 允许工具改 Config |
| `Linker::link` (`queries.rs:49`) | 等待 codegen 完成并链接 | 分离 codegen 与 link |

</details>

## 核心实现

### 回调注入与 Compilation 状态机

`Callbacks` trait 是这一层的设计核心：

```rust title="rustc_driver_impl/src/lib.rs:120"
pub trait Callbacks {
    fn config(&mut self, _config: &mut interface::Config) {}
    fn after_crate_root_parsing(&mut self, _compiler: &interface::Compiler,
        _krate: &mut ast::Crate) -> Compilation { Compilation::Continue }
    fn after_expansion<'tcx>(&mut self, _compiler: &interface::Compiler,
        _tcx: TyCtxt<'tcx>) -> Compilation { Compilation::Continue }
    fn after_analysis<'tcx>(&mut self, _compiler: &interface::Compiler,
        _tcx: TyCtxt<'tcx>) -> Compilation { Compilation::Continue }
}
```

`Compilation` enum（`lib.rs:410`）是两态状态机 `Stop`/`Continue`，在每个回调点检查，决定是否提前退出。rustdoc 在 `after_analysis` 提取文档后返回 `Stop`（不需要 codegen），clippy 在 `after_expansion` 运行 lint。这是开闭原则的体现——编译流程对扩展开放，对修改封闭。

### 为什么分 `rustc_driver` / `rustc_driver_impl` 两层

`rustc_driver/src/lib.rs` 注释明确写道：它是"intentionally empty and a re-export of `rustc_driver_impl`"，目的是"allow the code in `rustc_driver_impl` to be compiled in parallel with other crates"。这是 Cargo 构建并行化的纯工程手段——拆出一个薄 crate 打破依赖链，让 `rustc_driver_impl` 能与其他 crate 并行编译。

### 为什么 `create_and_enter_global_ctxt` 用闭包而非直接调用

`passes.rs:989-999` 的注释解释了关键原因：`'tcx` 生命周期的起点就在这里。`gcx_cell` 在闭包内定义并传入 `create_global_ctxt`，使 `TyCtxt` 获得正确的单生命周期 `&'tcx`。若直接构造 `GlobalCtxt`，会出现两个生命周期参数 `&'a GlobalCtxt<'tcx>`，破坏类型系统不变量。这是一种用 Rust 类型系统编码"资源作用域"的手法——生命周期即资源生命周期。

### 模式分发

`run_compiler` 闭包内有多个提前返回分支（`lib.rs:248-291`）：`--print` 走 `print_crate_info`、`--link-only` 走 `process_rlink`（rlink 增量链接文件）、`--pretty` 走 `pretty::print`、`--parse-crate-root-only` 直接退出。这些不是单独的 pass，而是在驱动主循环中以条件分支实现，避免启动完整编译管线。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 回调注入（Hook） | `Callbacks` trait (`lib.rs:120`) | 外部工具介入无需 fork rustc |
| 模板方法 | `interface::run_compiler(config, f)` (`interface.rs:370`) | 固定装配骨架，逻辑委托闭包 |
| 策略模式 | `CodegenBackend` trait（`Compiler.codegen_backend`） | 运行时替换后端（LLVM/Cranelift） |
| Builder | `Config` struct (`interface.rs:310`) | 逐字段填充后传入 `run_compiler` |
| 两态状态机 | `Compilation` (`lib.rs:410`) | 每个回调点决定是否继续 |

## 模块间交互

驱动层是编译流程的"总调度"，向下调用 `rustc_interface`（`run_compiler`/`passes`/`Linker`）、`rustc_session`（`Session`/`Options`）、`rustc_codegen_ssa`（`CodegenBackend` trait）、`rustc_middle`（`TyCtxt`）。`rustc_interface` 是编译流程的"公共 API"层，向 driver 提供入口，向内部协调 `rustc_metadata`、`rustc_resolve`、`rustc_expand` 等。外部工具（rustdoc/clippy）实现 `Callbacks` 传入 `run_compiler`——这是它们与编译器的唯一交互面。

## 扩展方式

新增一个编译阶段钩子：在 `Callbacks` trait（`lib.rs:120`）加方法，在 `run_compiler` 闭包内对应位置调用（如 `lib.rs:315` 的 `analysis` 之后）。新增 CLI 选项：在 `rustc_session/src/options.rs` 的 `UnstableOptions` 宏加字段（标 `[TRACKED]`/`[UNTRACKED]`），在 `config.rs::build_session_options` 解析。新增 codegen 后端：实现 `CodegenBackend` trait 并在 `rustc_interface/src/util.rs::get_codegen_backend` 注册，或通过 `Config.make_codegen_backend` 运行时注入。
