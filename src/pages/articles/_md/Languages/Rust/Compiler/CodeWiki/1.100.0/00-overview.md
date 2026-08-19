---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "Overview"
date: "2026-08-19T14:55:12+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "编译器", "rustc", "CodeWiki"]
description: "Rust 官方编译器 rustc 1.100.0 源码架构解读：从源码到机器码的完整流水线。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.100.0 · **协议** MIT / Apache-2.0 · **语言** Rust（自举） · **编译器代码量** ~866,000 行 · **仓库** [GitHub](https://github.com/rust-lang/rust)

---

## 总览

### 项目简介

`rustc` 是 Rust 编程语言的官方编译器实现，仓库 [rust-lang/rust](https://github.com/rust-lang/rust) 同时托管了编译器（`compiler/`）与标准库（`library/`）。它把 `.rs` 源码翻译成机器码，并在编译期完成 Rust 最核心的承诺——**内存安全与线程安全**：所有权、借用、生命周期的全部规则由编译器的类型检查与借用检查在编译期静态验证，运行时零开销。

`rustc` 自身用 Rust 编写并**自举**（用上一版本的编译器编译当前版本），是地球上最大的 Rust 单体代码库之一（`compiler/` 约 87 万行、70+ 个 crate）。它的核心价值有三：**零成本抽象**（泛型单态化、trait 静态分发不引入运行时开销）、**编译期安全保证**（借用检查器让数据竞争与悬垂指针在编译期暴露）、**业界顶级的诊断**（基于 Span 的精确错误定位与建议）。

**项目边界**：本系列聚焦 **编译器内核**——`compiler/` 下构成 `rustc` 的约 70 个 crate 组成的流水线。标准库 `library/`（`std`/`core`/`alloc`/`proc_macro` 等）的内部实现不在本系列范围，留作后续系列。外部维护的工具（Cargo、Clippy、rustfmt、rust-analyzer、Miri）虽随仓库分发但各自有独立仓库，不在解读范围内。

### 功能矩阵

| 编译阶段 | 核心实现 crate | 输入 → 输出 |
| --- | --- | --- |
| 词法/语法分析 | `rustc_lexer`、`rustc_parse`、`rustc_ast` | 源码 → Token → AST |
| 宏展开 | `rustc_expand`、`rustc_builtin_macros` | AST →（固定点展开）→ AST' |
| HIR 降低 | `rustc_ast_lowering`、`rustc_hir` | AST → HIR |
| 名称解析 | `rustc_resolve` | HIR 路径 → `Res`/`DefId` |
| 类型检查 | `rustc_hir_typeck`、`rustc_hir_analysis`、`rustc_infer` | HIR → `TypeckResults` |
| Trait 求解 | `rustc_trait_selection`、`rustc_next_trait_solver` | trait obligation → `ImplSource` |
| MIR 构建 | `rustc_mir_build`、`rustc_middle::mir` | HIR → MIR (`Body`) |
| MIR 优化/借用检查 | `rustc_mir_transform`、`rustc_mir_dataflow`、`rustc_borrowck` | MIR → 优化后 MIR + region 关系 |
| 代码生成 | `rustc_codegen_ssa`、`rustc_codegen_llvm` | MIR → LLVM IR → 目标文件 |
| 驱动与会话 | `rustc_driver_impl`、`rustc_interface`、`rustc_session` | 编排上述全部阶段 |
| 查询系统 | `rustc_middle`、`rustc_query_impl` | 惰性求值 + 增量编译基础设施 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Rust（自举） | 核心 | 编译器实现语言；用 stage0（上一稳定版）自举 |
| LLVM | 核心 | 默认代码生成后端（`rustc_codegen_llvm`） |
| `rustc_thread_pool` | 核心 | rayon 的 fork，线程池并行执行 query |
| jemalloc | 可选 | rustc 进程的全局分配器（override libc malloc） |
| `rustc_codegen_gcc` / `rustc_codegen_cranelift` | 可选 | 替代后端（GCC、Cranelift），实现 `CodegenBackend` trait 接入 |
| bootstrap (`src/bootstrap`) | 工具 | 编译编排系统（`./x`/`x.py`） |

### 版本历史

Rust 1.0（2015）后 `rustc` 持续演进，几个关键里程碑塑造了当前架构：借用检查从基于 AST 的词法生命周期（2015）迁移到基于 MIR 的 **NLL**（Non-Lexical Lifetimes，2018，`rustc_borrowck`）；引入**查询系统**（query system）支撑增量编译与并行；当前正进行中的最大迁移是 **trait 求解器**从旧 `rustc_trait_selection` 迁移到 `rustc_next_trait_solver`（基于 canonical query + 固定点迭代，解决旧 solver 的循环处理缺陷）。1.100.0 处于新旧 trait solver 并存的过渡期，是观察这一架构演进的理想版本。

---

## 快速上手

最快看到 `rustc` 跑起来的方式是用已安装的编译器直接编译一个文件：

```bash title="最简编译验证"
echo 'fn main() { println!("hello, rustc"); }' > hello.rs
rustc hello.rs -o hello && ./hello
# hello, rustc
```

从源码构建整个编译器需要 bootstrap（`./x`），周期较长，适合真正要改 `rustc` 的场景：

```bash title="从源码构建（bootstrap）"
./x build --stage 1         # stage1 = 用 stage0 编译出的当前 rustc
./x build --stage 2         # stage2 = 用 stage1 自举验证（自举完整性测试）
# 产物在 build/<host>/stage1/bin/rustc
```

> 这是"用户视角"的最简操作。内部 `main` 走了哪些步骤、驱动如何装配 `Session` 与 `TyCtxt`，见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

`rustc` 是经典的**多阶段编译流水线**，但有一个根本性的架构特征让它区别于多数编译器：**整个流水线是 demand-driven（按需求值）的**。阶段之间不是显式的"先 A 再 B"顺序调用，而是通过**查询系统**串联——每个阶段是一个 query，被下游 query 调用时才真正执行，结果 memoize 缓存，并记录依赖图供增量编译复用。这意味着从代码层面看，编译流程更像是"代码生成反向触发了类型检查、触发了 MIR 构建、触发了 HIR 降低"的级联，而非自顶向下的单向流。

设计思想：把编译切成 ~70 个职责单一的 crate，每个 crate 提供一组 query provider，由中心的 `TyCtxt` 统一调度。这样获得了三件事——**增量编译**（dep graph 记录依赖，未修改的 query 标记 green 跳过重算）、**并行**（Sharded 缓存 + query latch 等待机制）、**关注点分离**（类型检查不关心代码生成，只产出 `TypeckResults` 供下游消费）。

![rustc 分层架构](/vibe-reading/images/articles/rust-compiler-1.100.0/architecture.svg)

纵向分五层 + 一层横切基础设施。各层只依赖下游（层间单向），横切层（`TyCtxt`/查询系统/Span/错误诊断）被所有层共享。层间数据通过 query 传递（而非直接函数调用），产物经 arena 分配并 interning 去重。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 入口层 | `rustc_driver_impl`、`rustc_interface`、`rustc_session` | 解析命令行、装配 `Session`/`CodegenBackend`、用回调注入点编排全局流程，隔离二进制入口与编译逻辑 |
| 前端层 | `rustc_lexer`、`rustc_parse`、`rustc_ast`、`rustc_expand`、`rustc_ast_lowering`、`rustc_resolve` | 源码→Token→AST→（宏展开）→HIR+名称解析，把人类语法翻译成下游可分析的树与路径解析 |
| 类型系统层 | `rustc_hir_typeck`、`rustc_hir_analysis`、`rustc_infer`、`rustc_trait_selection`、`rustc_next_trait_solver` | 类型推导、coercion、trait obligation 求解，把"类型正确吗"这一核心安全保证做完 |
| MIR 层 | `rustc_mir_build`、`rustc_mir_transform`、`rustc_mir_dataflow`、`rustc_borrowck` | HIR→MIR(CFG)，做借用检查（NLL）、drop 展开、优化，MIR 是 borrowck 与 codegen 的共同基础 |
| 后端层 | `rustc_codegen_ssa`、`rustc_codegen_llvm` | 单态化收集、MIR→LLVM IR、LTO、链接，把类型安全的 MIR 落到具体平台机器码 |
| 横切基础设施 | `rustc_middle`、`rustc_query_impl`、`rustc_span`、`rustc_errors`、`rustc_data_structures` | `TyCtxt` 全局上下文、惰性 query 执行引擎、源位置 Span、诊断系统、共享数据结构——所有层共用 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| **Demand-driven query + memoization** | `rustc_query_impl::execution::try_execute_query` | 惰性求值省计算；memoize 避免重算；dep graph 支撑增量编译 |
| **回调注入（Callbacks trait）** | `rustc_driver_impl/src/lib.rs:120` | 让 rustdoc/clippy/miri 无需 fork 即可介入编译流程，开闭原则 |
| **手写递归下降 + Pratt 解析** | `rustc_parse/src/parser/` | Rust 语法需复杂 lookahead、错误恢复、token 捕获，生成器难以表达 |
| **固定点迭代** | `rustc_expand::fully_expand_fragment`、`rustc_resolve::resolve_imports` | 宏展开与名称解析互相依赖，需迭代到不动点 |
| **trait 抽象多后端（Strategy）** | `rustc_codegen_ssa::traits::CodegenBackend` | MIR→IR lowering 逻辑写一次，LLVM/Cranelift/GCC 复用 |
| **Dataflow framework（lattice + fixpoint）** | `rustc_mir_dataflow::framework` | 借用检查的活跃性/初始化分析统一建模为 may-flow 不动点问题 |
| **Arena + interning** | `rustc_middle::ty::context::CtxtInterners` | 类型对象全局去重，`Ty<'tcx>` 退化为指针，`Copy` 且可 `Send` |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `TyCtxt<'tcx>` | 编译中央上下文，所有 query 的入口 | `'tcx`（一次编译） | 持有 `GlobalCtxt`，被所有 pass 共享 |
| `Ty<'tcx>` | intern 后的类型指针 | `'tcx` | 由 `CtxtInterners` 去重分配 |
| `Session` | 编译会话状态（选项、诊断、target） | 一次编译 | `Compiler` 持有，`rustc_session` 定义 |
| `ast::Crate` / `hir::OwnerInfo` | AST/HIR 根产物 | 编译期 | AST 经 lowering 产出 HIR |
| `mir::Body<'tcx>` | 一个函数的 MIR（CFG） | `'tcx` | 由 `mir_build` 产出，borrowck/codegen 消费 |
| `Obligation` | 待证明的 trait 谓词 | typeck 期间 | 由 `FulfillmentContext` 驱动求解 |
| `DefId` / `HirId` | 定义标识 / HIR 节点标识 | 全局 / 本地 | 跨 crate / owner 内局部唯一 |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Callbacks` | `rustc_driver_impl/src/lib.rs:120` | rustdoc/clippy/miri 各自实现 | `run_compiler(callbacks)` 传入 |
| `CodegenBackend` | `rustc_codegen_ssa/src/traits/backend.rs:36` | `LlvmCodegenBackend`、Cranelift/GCC 后端 | `Config.make_codegen_backend` 或 `util::get_codegen_backend` |
| `Analysis`（dataflow） | `rustc_mir_dataflow/src/framework/mod.rs:98` | `Borrows`、`MaybeUninitializedPlaces` 等 | borrowck 内组合 |
| `MirPass` | `rustc_mir_transform/src/pass_manager.rs:131` | 各 MIR 优化 pass | `declare_passes!` 宏 + pass 数组 |
| `Interner` | `rustc_type_ir/src/interner.rs` | `TyCtxt` 实现 | 让 new solver 与 rust-analyzer 共用类型逻辑 |

---

## 代码目录

```
rust/
├── compiler/                 # 编译器内核（~70 crate，本系列解读范围）
│   ├── rustc/                #   二进制入口（main.rs → rustc_driver）
│   ├── rustc_driver_impl/   #   驱动主循环、Callbacks、编排
│   ├── rustc_interface/     #   编译流程公共 API（passes.rs / queries.rs）
│   ├── rustc_session/       #   Session、Options、config
│   ├── rustc_lexer/         #   纯词法（零 rustc 依赖，可被 r-a 复用）
│   ├── rustc_parse/         #   手写递归下降解析器
│   ├── rustc_ast/           #   AST 节点定义
│   ├── rustc_expand/        #   宏展开引擎（固定点迭代）
│   ├── rustc_builtin_macros/ #  内建宏（format!/println!/asm!…）
│   ├── rustc_ast_lowering/  #   AST → HIR
│   ├── rustc_hir/           #   HIR 节点定义 + intravisit
│   ├── rustc_resolve/       #   名称解析（early/late resolution）
│   ├── rustc_hir_typeck/    #   函数体类型检查
│   ├── rustc_hir_analysis/  #   well-formedness / coherence
│   ├── rustc_infer/         #   类型推导上下文 InferCtxt
│   ├── rustc_trait_selection/ # 旧 trait 求解器（~50k 行）
│   ├── rustc_next_trait_solver/ # 新 trait 求解器（canonical query）
│   ├── rustc_mir_build/     #   HIR → MIR 构建
│   ├── rustc_mir_transform/ #   MIR 优化 pass 流水线
│   ├── rustc_mir_dataflow/  #   数据流分析框架
│   ├── rustc_borrowck/      #   借用检查（NLL）
│   ├── rustc_codegen_ssa/   #   后端无关代码生成
│   ├── rustc_codegen_llvm/  #   LLVM 后端
│   ├── rustc_middle/        #   ★ TyCtxt / Ty / MIR 定义（~65k 行，最大 crate）
│   ├── rustc_query_impl/   #   查询执行引擎
│   ├── rustc_span/         #   源位置 Span / hygiene
│   └── rustc_errors/       #   诊断系统
├── library/                  # 标准库（不在本系列范围）
│   ├── core/ alloc/ std/ proc_macro/ …
├── src/                      # bootstrap 编译系统 + 工具
│   ├── bootstrap/          #   ./x 编排
│   └── tools/              #   rustfmt/clippy/cargo 等外部工具（各自独立仓库）
├── tests/                    # 测试套件（见「测试体系」）
└── x.py / x                 # bootstrap 入口
```

---

## 模块地图

本系列把编译器拆为 11 个模块，按流水线顺序排列。每个模块独立成文，概览此处给出全局地图。

![模块依赖与数据流](/vibe-reading/images/articles/rust-compiler-1.100.0/module-dependencies.svg)

实线箭头表示数据/产物传递（上游 crate 产出喂给下游），右侧虚线绿箭头表示查询系统与 `TyCtxt` 对各模块的 demand-driven 驱动与共享上下文供给——每个模块既是 query 的消费者也是 provider，通过 `TyCtxt` 解耦。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 驱动与会话 | 编排全局编译流程、命令行、回调 | `run_compiler` in `rustc_driver_impl` | 二进制入口与编译逻辑的隔离边界，承载对外扩展点（Callbacks） | [驱动与会话](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/01-driver-session) |
| 词法与语法分析 | 源码→Token→AST | `new_parser_from_file` in `rustc_parse` | 词法层零依赖可复用；解析是手写递归下降，控制力与错误恢复是核心 | [词法与语法分析](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/02-lexer-parser) |
| 宏展开 | AST→（固定点展开）→AST' | `fully_expand_fragment` in `rustc_expand` | 宏与名称解析交错迭代，需独立的不动点机制与 hygiene 体系 | [宏展开](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/03-macro-expansion) |
| 高层中间表示 HIR | AST→HIR | `lower_to_hir` in `rustc_ast_lowering` | HIR 的 owner-based 结构是增量编译稳定性的基础，大量去糖在此完成 | [HIR](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/04-hir) |
| 名称解析 | 路径→DefId/Res | `resolve_crate` in `rustc_resolve` | 名称解析是类型检查的前提；early/late 两阶段因宏展开而必需 | [名称解析](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/05-name-resolution) |
| 类型检查与推导 | HIR→TypeckResults | `typeck` in `rustc_hir_typeck` | 类型正确性是 Rust 安全保证的核心，推导+coercion+方法解析自成体系 | [类型检查](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/06-type-checking) |
| Trait 求解 | obligation→ImplSource | `select` in `rustc_trait_selection` | trait 系统是 Rust 类型系统的灵魂，新旧 solver 并存，复杂度最高 | [Trait 求解](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/07-trait-solver) |
| 中间表示 MIR | HIR→MIR(CFG) | `build_mir` in `rustc_mir_build` | MIR 是 borrowck 与 codegen 的共同基础，把高层语法统一为 CFG | [MIR](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/08-mir) |
| MIR 优化与借用检查 | MIR→优化 MIR+region | `mir_borrowck` in `rustc_borrowck` | NLL 借用检查是 Rust 的招牌特性，dataflow 框架复用于优化 | [MIR 优化与借用检查](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/09-mir-optimization-borrowck) |
| 代码生成 | MIR→LLVM IR→目标文件 | `codegen_crate` in `rustc_codegen_ssa` | 单态化与多后端抽象，把类型安全的 MIR 落到具体平台 | [代码生成](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/10-codegen) |
| 核心上下文与查询系统 | TyCtxt + 惰性 query | `try_execute_query` in `rustc_query_impl` | 编译器的"神经系统"，是增量编译与并行的架构基石 | [查询系统与 TyCtxt](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/11-query-system-tycontext) |

> 模块间的**动态调用顺序**见「运行时行为 > 核心运行流程」——静态职责是上面的地图，动态数据流是下文的链路。

---

## 运行时行为

### 启动流程

从 `rustc` 二进制到真正开始编译，对象装配的调用链如下（文件路径标注于右侧）：

```
main()                                     // compiler/rustc/src/main.rs
  └→ rustc_driver::main()                  // re-export rustc_driver_impl
       └→ run_compiler(at_args, callbacks) // rustc_driver_impl/src/lib.rs:172
            ├→ handle_options → HandledOptions + Options  // rustc_session/options.rs
            ├→ 组装 interface::Config (opts/input/callbacks)
            ├→ callbacks.config(&mut config)              // 回调注入点 #0
            └→ interface::run_compiler(config, |compiler| { ... })  // interface.rs:370
                 ├→ jobserver::initialize → 线程池         // interface.rs:380
                 ├→ build_session → Session              // rustc_session/session.rs
                 ├→ util::get_codegen_backend → CodegenBackend  // 默认 LLVM
                 ├→ 构造 Compiler { sess, codegen_backend, ... }
                 └→ create_and_enter_global_ctxt(compiler, krate, |tcx| { ... })  // passes.rs:935
                      ├→ setup_dep_graph → DepGraph      // 增量编译依赖图
                      ├→ DEFAULT_QUERY_PROVIDERS 注册 ~20 个 crate 的 provider  // passes.rs:898
                      └→ TyCtxt::create_global_ctxt → 'tcx 生命周期起点  // passes.rs:1004
```

对象装配要点：配置来自命令行（`rustc_session/src/options.rs` 的 `Options`，每个字段标 `[TRACKED]`/`[UNTRACKED]` 用于增量依赖追踪）；`Session` 与 `CodegenBackend` 在 `run_compiler` 内创建后注入 `Compiler`；query provider 以函数指针表形式在 `create_and_enter_global_ctxt` 集中注册到 query system（这是依赖注入的等价物——各 crate 通过 `provide(Providers)` 暴露自己的 query 实现）。`Callbacks` trait 的三个钩子（`after_crate_root_parsing`/`after_expansion`/`after_analysis`）是外部工具介入点，返回 `Compilation::Stop` 可提前终止。

### 核心运行流程

下文三条链路覆盖了 rustc 的主要运行模式：前端管线（解析到 HIR）、分析阶段（类型检查 + 借用检查）、代码生成与链接。它们通过 query 系统串联，实际触发顺序是 demand-driven 的。

![编译数据流](/vibe-reading/images/articles/rust-compiler-1.100.0/data-flow.svg)

#### 前端管线：源码到 HIR 与名称解析

业务流程：源码 → 词法 → 解析 AST → 宏展开固定点 → HIR 降低 + 名称解析。

从 `passes::parse(sess)`（`rustc_interface/src/passes.rs:53`）出发，`new_parser_from_file` 调 `parser.parse_crate_mod()` 产出 `ast::Crate`。随后 `tcx.resolver_for_lowering()`（`lib.rs:295`）触发 `resolver_for_lowering_raw` query：内部 `configure_and_expand`（`passes.rs:133`）做 cfg 处理 + 宏展开（`rustc_expand::fully_expand_fragment` 的固定点循环）+ 注入 prelude，并与 `rustc_resolve` 的名称解析交错（宏路径需先解析才能展开，展开又产出新导入），最终产出 `(Steal<ResolverAstLowering>, Steal<ast::Crate>, ResolverGlobalCtxt)`。`Steal<T>` 实现一次性所有权转移——AST 在 lowering 完成后即被 drop，避免驻留内存。

#### 分析阶段：类型检查与借用检查

业务流程：HIR → 类型检查（TypeckResults）→ MIR 构建 → 借用检查（NLL）。

`tcx.ensure_ok().analysis(())`（`lib.rs:315`）触发 `run_required_analyses`（`passes.rs:1093`）。它先做 `misc_checking_1`（并行：entry_fn、check_mod_attrs 等），随后 `emit_delayed_lints` 触发 `hir_crate_items` → `lower_to_hir` 把 AST 降为 HIR（惰性、per-owner）。接着 `rustc_hir_analysis::check_crate` 做 coherence/well-formedness，再 `par_hir_body_owners` **并行**对每个函数体跑 `tcx.typeck(def_id)`（类型推导 + coercion + 方法解析 + trait obligation 注册），之后并行跑 `mir_borrowck(def_id)`——borrowck 内部先 `mir_built` 构建 MIR，再做 NLL region 推理与数据流分析。关键设计：类型检查的 `TypeckResults`（含每个节点的 `Ty` 与 coercion adjustments）是 MIR 构建的前提；borrowck 基于 MIR 而非 HIR，把 lifetime 推理从词法作用域移到控制流图，这就是 NLL。

#### 代码生成：单态化到链接

业务流程：MIR → 单态化收集 → MIR→LLVM IR → LTO → 链接产物。

`Linker::codegen_and_build_linker`（`queries.rs:29`）调 `passes::start_codegen`（`passes.rs:1286`）：先 `encode_and_write_metadata` 写 `.rmeta`（crate 元数据），再 `backend.codegen_crate(tcx)`（`rustc_codegen_ssa/src/base.rs:714`）。后者调 `tcx.collect_and_partition_mono_items(())` 做单态化收集与 CGU 分区，`start_async_codegen` 启动 coordinator 线程，每个 CGU 走 `compile_codegen_unit` → `codegen_instance` → `mir::codegen_mir`：按逆后序（RPO）遍历 MIR basic block，把 `TerminatorKind`（Goto/SwitchInt/Call/Drop/Return）逐一翻译为 LLVM IR。`join_codegen` 等待所有并行 LLVM 编译完成，`backend.link` 链接 `.o` 为可执行文件或 rlib。关键决策：Rust 默认对所有泛型单态化（每具体类型一份代码）换取零开销，代价是二进制体积，CGU 的"大小交错排序"（`base.rs:777`）用于平衡内存与吞吐。

> **demand-driven 的反向链路**：上面看似顺序执行，实则 codegen 的 `optimized_mir(def_id)` 会**反向**触发 `mir_borrowck → typeck → mir_built → lower_to_hir → resolver`。但 `analysis()` 先显式跑了 typeck/borrowck，所以 codegen 时这些 query 命中缓存（dep graph 标记 green），除非增量编译检测到变更。这统一了"全量编译"与"增量编译"——区别只是缓存是否命中。

---

## 典型修改场景

#### 场景 1：新增一个语法特性（如 `gen` 块）

1. `rustc_ast/src/ast.rs`：在 `ExprKind` 新增 variant（如 `Gen`）。
2. `rustc_parse/src/parser/expr.rs`：新增 `parse_gen_block` 方法并在 `parse_expr_prefix` 分发。
3. `rustc_ast_lowering/src/expr.rs`：在 `lower_expr_mut` 加分支把语法糖展开为底层控制流。
4. 下游 `rustc_hir_typeck`/`rustc_mir_build` 适配新节点的类型检查与 MIR 构建。

#### 场景 2：新增一个 MIR 优化 pass

1. 新建 `rustc_mir_transform/src/my_pass.rs`，`struct MyPass;` 实现 `MirPass` trait（`pass_manager.rs:131`）的 `run_pass` 与 `policy`。
2. 在 `rustc_mir_transform/src/lib.rs` 的 `declare_passes!` 宏（`:122`）注册 `mod my_pass : MyPass;`。
3. 在 `run_optimization_passes`（`lib.rs:687`）的 pass 数组中按依赖关系插入 `&my_pass::MyPass`。

#### 场景 3：新增一个 codegen 后端（如自定义 WASM 后端）

1. 实现 `CodegenBackend` trait（`rustc_codegen_ssa/src/traits/backend.rs:36`）的 `codegen_crate`/`join_codegen`/`link`。
2. 实现 `ExtraBackendMethods`、`WriteBackendMethods`、`BackendTypes`、`BuilderMethods`。
3. 在 `rustc_interface/src/util.rs` 的 `get_codegen_backend` 注册后端名，或通过 `Config.make_codegen_backend` 运行时注入（`cg_clif` 的方式）。

---

## 测试体系

```
tests/
├── ui/              # 编译输出对比测试（.stderr 快照，最大宗）
├── codegen/         # codegen 正确性
├── codegen-llvm/    # LLVM 后端特定
├── run-make/        # 端到端：编译+运行+比对
├── run-pass/        # 能编译并运行通过的用例
├──mir-opt/          # MIR 优化输出对比
├── incremental/     # 增量编译正确性
└── ...              (assembly/debuginfo/pretty/等等)
```

`rustc` 用 **compiletest**（`src/tools/compiletest`）驱动测试。分层对应：前端语义→`ui`，类型检查/借用检查的错误诊断→`ui` 的 `.stderr` 快照，MIR 优化→`mir-opt`，增量编译→`incremental`，代码生成→`codegen`/`run-make`。理解某个 pass 时，对应的 `mir-opt` 或 `ui` 测试是很好的"可执行文档"——改代码后用 `./x test --bless` 机械重生成快照。

---

## 阅读源码推荐路线

- **第一遍：理解主流程与驱动**
  `compiler/rustc/src/main.rs` → `rustc_driver_impl/src/lib.rs` 的 `run_compiler`（`:172`）→ `rustc_interface/src/passes.rs` 的 `create_and_enter_global_ctxt`（`:935`）→ `rustc_interface/src/queries.rs` 的 `Linker`。看清"编译怎么被串起来的"。
- **第二遍：理解数据表示的演进**
  `rustc_ast/src/ast.rs` 的 `Expr`/`Item` → `rustc_ast_lowering/src/lib.rs` 的 `lower_to_hir`（`:659`）→ `rustc_hir/src/hir.rs` 的 `Item`/`Expr` 与 `OwnerNodes` → `rustc_middle/src/mir/mod.rs` 的 `Body`/`BasicBlock`/`Terminator`。看清 AST→HIR→MIR 三种 IR 各自长什么样、为什么。
- **第三遍：理解类型与借用的安全核心**
  `rustc_hir_typeck/src/fn_ctxt/mod.rs` 的 `FnCtxt` + `expr.rs` 的 `check_expr_with_expectation` → `rustc_infer/src/infer/mod.rs` 的 `InferCtxt` + `UnificationTable` → `rustc_borrowck/src/lib.rs` 的 `mir_borrowck` 与 `nll::compute_regions`。看清"类型怎么推导、借用怎么检查"。
- **第四遍：理解架构基石与扩展点（选重点子模块深入）**
  `rustc_middle/src/ty/context.rs` 的 `TyCtxt`/`GlobalCtxt` → `rustc_query_impl/src/execution.rs` 的 `try_execute_query`（query 缓存 + dep graph + 循环检测）→ 再从模块地图挑一个深读（推荐 trait 求解器或 codegen 后端抽象）。

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| HIR | High-level IR，AST 去糖后的高层中间表示，类型检查的工作集 |
| MIR | Mid-level IR，基于 CFG + basic block 的中间表示，borrowck 与 codegen 的基础 |
| TyCtxt | 编译中央上下文，所有 query 的入口，持有 `GlobalCtxt` |
| DefId / HirId | 跨 crate 的定义标识 / 本地 HIR 节点标识（owner-based 两级结构） |
| NLL | Non-Lexical Lifetimes，基于 MIR 控制流而非词法作用域的借用检查 |
| demand-driven | query 按需求值，下游调用才触发上游计算 |
| dep graph | 依赖图，记录 query 间依赖，支撑增量编译（green 节点跳过重算） |
| interning | 全局去重分配，使 `Ty<'tcx>` 退化为可 `Copy` 的指针 |
| monomorphization | 单态化，每个泛型具体类型生成一份代码，零开销抽象 |
| obligation | trait 求解器中"待证明的谓词"，由 `FulfillmentContext` 驱动 |

### 参考资料

- [rustc-dev-guide](https://rustc-dev-guide.rust-lang.org/) — 官方编译器贡献指南，本系列多处设计与术语的权威来源
- [rustc 仓库](https://github.com/rust-lang/rust) — 源码（`compiler/` 为本系列解读对象）
- [deepwiki-rs](https://github.com/sopaco/deepwiki-rs)、[CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) — 本流水线参考的方法论
