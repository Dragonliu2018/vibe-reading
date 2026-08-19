---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "核心上下文与查询系统"
date: "2026-08-19T15:06:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "TyCtxt", "查询系统", "增量编译", "CodeWiki"]
description: "rustc 的 TyCtxt 中央上下文、demand-driven 查询引擎与增量编译依赖图。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

如果说前述各模块是 `rustc` 的器官，那么这一层是它的**神经系统**。`TyCtxt` 是编译中央上下文，所有编译阶段通过它调用彼此；查询系统是 demand-driven 的执行引擎，让编译变成"按需求值 + 缓存 + 依赖追踪"。这是 `rustc` 区别于多数编译器的根本架构特征——它同时支撑了**增量编译**（dep graph 记录依赖，未修改的 query 跳过重算）与**并行编译**（Sharded 缓存 + query latch 等待）。涉及 crate：`rustc_middle`（`TyCtxt`/`Ty` 定义，~65k 行，全编译器最大）、`rustc_query_impl`（查询执行引擎）、`rustc_query_system`（框架）、`rustc_type_ir`（`Interner` trait 抽象）。

## 模块架构

- **`TyCtxt<'tcx>`**（`rustc_middle/src/ty/context.rs:677`）：编译中央上下文，本身只是薄包装 `#[derive(Copy, Clone)] pub struct TyCtxt<'tcx> { gcx: &'tcx GlobalCtxt<'tcx> }`。
- **`GlobalCtxt`**（`context.rs:700`）：真正持数据的，核心字段 `arena: &WorkerLocal<Arena<'tcx>>`、`interners: CtxtInterners`、`dep_graph: DepGraph`、`query_system: QuerySystem<'tcx>`、`types/lifetimes/consts: CommonTypes`。
- **`Ty<'tcx>`**（`rustc_middle/src/ty/mod.rs:647`）：intern 后的指针 `pub struct Ty<'tcx>(Interned<'tcx, WithCachedTypeInfo<TyKind<'tcx>>>)`。`WithCachedTypeInfo` 在 interning 时预计算 `TypeFlags` 和 `outer_exclusive_binder`，避免每次遍历重新推导。
- **`QueryVTable`**（`rustc_middle/src/query/plumbing.rs:69`）：每个查询的元数据中心，持 `invoke_provider_fn`（provider 函数指针）、`execute_query_fn`（缓存+dep graph 集成入口）、`cache`、`state`、`eval_always`/`depth_limit`/`feedable` 标志。
- **`QuerySystem`**（`plumbing.rs:145`）：聚合所有 VTable、`local_providers`/`extern_providers`（函数指针表）、`on_disk_cache`。
- **`DepNode`/`DepGraph`**（`rustc_middle/src/dep_graph/graph.rs`）：依赖图，节点是 query 调用，边是 query 间依赖。

## 调用链路

以 `tcx.type_of(def_id)` 为例，宏展开后调用链：

```
tcx.type_of(def_id)                  // 宏生成的方法
  → QueryVTable::execute_query_fn(tcx, span, key, mode)
    → execute_query_incr_inner (execution.rs:581)        [增量模式]
      → DepNode::construct(tcx, dep_kind, &key)          // 构造 dep node
      → try_execute_query::<C, true>(...) (execution.rs:217)
        ├─ query.cache.lookup(&key)                       // 1. 查内存缓存 → hit 返回
        ├─ state.active.lock_shard_by_hash(key_hash)     // 2. 查 active 状态
        ├─ Entry::Vacant →                               // 3. 无人算 → 启动新 job
        │   execute_job_incr(query, tcx, key, dep_node, id)  (execution.rs:408)
        │   ├─ try_mark_green(tcx, &dep_node)            // 3a. 尝试标记 green（增量复用）
        │   │   → load_from_disk_or_invoke_provider_green
        │   └─ dep_graph_data.with_task(dep_node, tcx,   // 3b. green 失败 → 跑 provider
        │       || (query.invoke_provider_fn)(tcx, key), hash_value_fn)
        ├─ Entry::Occupied(Started(job)) →               // 4. 有线程在算
        │   wait_for_query(...) or find_and_handle_cycle(...)  // 等待或检测循环
        └─ Entry::Occupied(Poisoned) → FatalError        // 5. 前次 panic → 致命错误
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `try_execute_query` (`execution.rs:217`) | 查缓存→查 active→跑 provider | 三态 entry（Vacant/Started/Poisoned） |
| `execute_job_incr` (`execution.rs:408`) | 增量模式执行 | 先 `try_mark_green` 再跑 provider |
| `try_mark_green` (`graph.rs:909`) | 递归检查依赖是否全 green | green 则跳过重算 |
| `DepGraph::with_task` (`graph.rs:330`) | 执行 provider 时收集依赖边 | 哈希结果后分配 DepNodeIndex |
| `intern_ty` (`context.rs:208`) | 类型 interning 去重 | `ShardedHashMap` 支持并行 |
| `find_and_handle_cycle` (`execution.rs:291`) | 检测并处理 query 循环 | 单线程直接检测 |

</details>

## 核心实现

### 为什么用 query system

解决了两个核心问题——**增量编译**（dep graph 记录依赖，未修改的 query green 跳过执行，见 `try_mark_green` `graph.rs:909`）和**并行编译**（`Sharded` 缓存 + `QueryLatch` 等待机制，见 `execution.rs:277-296`）。这两者让大型项目的增量重编译只算真正变更的部分，且能利用多核。

### 为什么 TyCtxt 是 `&self` 不可变且 `Copy`

所有可变状态在 `GlobalCtxt` 内用 `Lock`/`RwLock`/`WorkerLocal` 保护，`TyCtxt` 只持引用，可自由复制传递，天然支持多线程（`context.rs:674-679`，`:684` 的 `DynSend`/`DynSync`）。这是 Rust 用类型系统编码"共享不可变状态"的典范——不可变 + Copy 让并发访问零成本。

### Interner trait 抽象

`Interner` trait（`rustc_type_ir/src/interner.rs`）将类型系统抽象化，`TyCtxt` 实现该 trait（`impl_interner.rs:97` 的 `with_cached_task` → `dep_graph.with_anon_task`），使 new solver 和 rust-analyzer 可共用同一套类型逻辑，各自提供不同的 interning/dep graph 后端。这是 `rustc` 与 rust-analyzer 能复用类型系统代码的架构基础。

### Poisoned 状态

`plumbing.rs:48`：provider panic 时 `ActiveJobGuard::drop` 将 key 标记为 `Poisoned`，后续访问该 key 的 query 立即 `FatalError.raise()`，防止 panic 后的脏数据传播。这是 Rust 标准库 `Mutex` 的 poisoning 思想在编译器层面的复用。

### incremental_verify_ich

`execution.rs:513`：green 节点从磁盘加载结果后，可选地重跑 provider 比对哈希，捕获 `DefId` 排序不稳定等隐微 bug——增量编译正确性的安全网。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Demand-driven query（惰性求值） | `try_execute_query` (`execution.rs:217`) Vacant 分支 | 省计算 |
| Memoization | `job_guard.complete(&query.cache, value, ...)` (`execution.rs:270`) | 避免重算 |
| Dependency graph | `DepGraph::with_task` (`graph.rs:330`) | 增量编译 |
| Arena/Interning | `CtxtInterners::intern_ty` (`context.rs:208`) | 全局去重，`Ty` 退化为指针 |
| Active query stack（循环检测） | `QueryState::active` (`plumbing.rs:26`) | 检测 query 递归循环 |
| DepNode 三色标记 | `Green`/`Red`/`Unknown` (`graph.rs:127`) | 增量复用判定 |

## 模块间交互

`TyCtxt` 是 parse 之后所有阶段的共享上下文——driver 装配它，各 pass 既消费又提供 query。`rustc_query_impl`（`execution.rs`）提供查询执行引擎；`rustc_middle/src/query`（`plumbing.rs`）定义 `QueryVTable`/`QuerySystem` 框架；`rustc_middle/src/queries.rs` 通过 `rustc_queries!` 宏声明全部查询（`type_of`/`typeck`/`mir_built`/`borrow_check`/`optimized_mir` 等），宏生成 `TyCtxt` 上的方法和 `Providers` struct。各 crate 通过 `provide(Providers)` 暴露自己的 query 实现，在 `rustc_interface/src/passes.rs:898` 的 `DEFAULT_QUERY_PROVIDERS` 集中注册。typeck/mir/borrowck/codegen 各阶段通过 `tcx.$query(key)` 调用，底层透明处理缓存、dep graph、循环检测。

## 扩展方式

新增查询：在 `rustc_middle/src/queries.rs` 的 `rustc_queries!` 块加 `query my_query(key: DefId) -> MyResult { desc {...} cache_on_disk { true } }`，在 `rustc_interface` 的 `DEFAULT_QUERY_PROVIDERS` 注册 provider 函数，宏自动生成 `TyCtxt::my_query` 方法、缓存和 dep graph 集成代码。修改增量编译依赖追踪：编辑 `rustc_middle/src/dep_graph/edges.rs`（定义哪些 `DepKind` 产生边）和 `graph.rs::with_task`（`:368`，控制边收集），引入新 dep kind 还需更新 `dep_node.rs:285` 的 `DepKind` enum。调整缓存策略：改 `rustc_middle/src/query/caches.rs` 的 `DefaultCache`/`VecCache`/`SingleCache`，或在 `queries.rs` 调 modifier（`eval_always`/`no_hash`/`arena_cache`）。
