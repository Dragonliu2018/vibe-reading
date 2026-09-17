---
title: "三处裸 std 异常抛出，把查询报错升级成了 BE coredump"
source:
  project: "Doris"
  type: "PR"
  id: "36666"
  url: "https://github.com/apache/doris/pull/36666"
  prType: "fix"
date: "2026-09-17T11:51:17+08:00"
category: [Database, OLAP, Apache Doris, PRs]
contentType: "PRs"
tags: ["Apache Doris", "BE", "Exception", "Coredump", "C++"]
description: "BE 的异常安全框架只捕获 doris::Exception，代码里残留的 std::runtime_error / std::length_error / std::exception 三处裸抛会逃逸线程函数触发 std::terminate，整个进程 coredump；本 PR 把三处统一替换为带错误码和栈回溯的 doris::Exception。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#36666](https://github.com/apache/doris/pull/36666) · **Issue** `-` · **commit** [7e13704](https://github.com/apache/doris/commit/7e1370490ad0ff133d1bc88f165c93441d94d9f9) · **首发版本** 3.0.0 · **变更行数** +7 行 · **合并时间** 2024-06-24

---

## 背景

Doris BE 从 2.0 前后开始建设**异常安全（exception-safe）执行框架**：核心思路是把执行期错误统一收敛到自定义的 `doris::Exception`，在算子边界用宏捕获后转成 `Status` 返回给 FE——查询失败只是返回一条错误信息，进程继续服务。这套框架的起点是 2023-03 合并的 [#17531](https://github.com/apache/doris/pull/17531)（`add exception structure`），随后 `RETURN_IF_CATCH_EXCEPTION` 系列宏逐步铺到各执行路径。

但框架有个隐含契约：**捕获点的 catch 类型只有 `doris::Exception`**。任何代码路径上如果还残留 `throw std::runtime_error` / `std::length_error` 这类标准库异常，它们不会被这些 catch 匹配，会一路逃逸出线程函数，触发 `std::terminate()`——整个 BE 进程直接 abort、coredump，所有正在执行的查询一起被杀。

本 PR 的作者在描述里写得很直白：

> `std::runtime_error` is not caught which leads to be coredump.

改动只有 +7 行，修的却是「进程级崩溃」和「查询级报错」的差别。

## 前置知识

### doris::Exception 与捕获宏

`doris::Exception` 定义在 `be/src/common/exception.h`，继承自 `std::exception`，携带错误码、可嵌套异常、以及（按错误码配置的）栈回溯：

```cpp title="be/src/common/exception.h（节选）"
class Exception : public std::exception {
public:
    Exception(int code, const std::string_view& msg);
    Exception(const Status& status) : Exception(status.code(), status.msg()) {}
    ...
    Status to_status() const { return {code(), _err_msg->_msg, _err_msg->_stack}; }
};
```

算子边界的捕获宏长这样（三个变体逻辑一致，此处节选一个）：

```cpp title="be/src/common/exception.h（RETURN_IF_CATCH_EXCEPTION 节选）"
#define RETURN_IF_CATCH_EXCEPTION(stmt)                     \
    do {                                                   \
        try {                                              \
            doris::enable_thread_catch_bad_alloc++;         \
            Defer defer {[&]() { doris::enable_thread_catch_bad_alloc--; }}; \
            { stmt; }                                      \
        } catch (const doris::Exception& e) {               \
            ...                                            \
            return Status::Error<false>(e.code(), e.to_string()); \
        }                                                  \
    } while (0)
```

两个关键细节：

1. **catch 的类型是 `const doris::Exception&`**，不是 `const std::exception&`。标准库异常类型不在捕获范围内。
2. `enable_thread_catch_bad_alloc` 是配套机制：Doris 重载了 allocator（`be/src/vec/common/allocator.cpp`），分配失败时**不再抛 `std::bad_alloc`**，而是抛 `doris::Exception(MEM_ALLOC_FAILED)`——也就是说框架刻意把「内存不足」也折叠成 `doris::Exception`，保证 catch 单一类型就够。宏作用域内的裸 `std::*` 异常属于漏网之鱼。

### 未捕获异常的终点是 terminate

C++ 规定：异常逃逸出线程函数（`std::function` 被 thread pool 调用的边界）时没有 handler 就调 `std::terminate()`，默认行为是 `abort()`——BE 进程整体退出并 dump core。Doris 的 pipeline 执行线程池没有在这层加兜底 `catch (...)`，所以「抛了但没被匹配的异常」=「整个 BE 挂掉」。

改动前后两条路径的对比：

![异常的两条出口](/vibe-reading/images/articles/doris-pr-36666-std-exception-be-coredump/exception-paths.svg)

同一个 throw 点，抛 `doris::Exception` 会被宏捕获、转成 `Status(INTERNAL_ERROR)` 返回 FE，只有当前查询失败（右列绿线）；抛 `std::runtime_error` 则不被匹配，逃逸线程函数触发 `std::terminate`，整个进程 coredump（左列红线）。本 PR 做的事就是把左边这条路堵死。

## 实现

三个改动点都是把裸 std 异常换成 `doris::Exception(INTERNAL_ERROR, ...)`，按触发场景逐个看。

### sort_cursor.h：归并排序拉数失败

`BlockSupplierSortCursorImpl::has_next_block()` 在从上游 supplier 拉下一个 block 失败时抛异常。改动前后：

```cpp title="be/src/vec/core/sort_cursor.h（改动前）"
} else if (!status.ok()) {
    throw std::runtime_error(std::string(status.msg()));
}
```

```cpp title="be/src/vec/core/sort_cursor.h（改动后）"
} else if (!status.ok()) {
    throw doris::Exception(doris::ErrorCode::INTERNAL_ERROR, status.msg());
}
```

调用链决定了它的杀伤力。这个 cursor 被 `VSortedRunMerger` 持有，而 `has_next_block` 有两个调用时机，命运截然不同：

- **构造期**（cursor 在 `VSortedRunMerger::prepare()` 里构造，构造函数会调一次 `has_next_block`）：`prepare` 自带 `catch (const std::exception& e)` 转 `Status::Cancelled`——即使抛 std 异常也被兜住，只影响查询。
- **数据流期**（`get_next()` 里 `_pending_cursor` 有值时调 `has_next_block`）：`get_next` 本身没有 try/catch，异常一路穿透到调用它的算子（`vdata_stream_recvr` 的 exchange source、local shuffle 的 `LocalMergeSortExchanger`、spill sort 等），这些算子外层只有捕获 `doris::Exception` 的宏——`std::runtime_error` 逃逸，进程崩溃。

也就是说同一段代码，构造期出错是查询失败，拉数中途出错是 BE 挂掉——后者正是排序归并这种长跑数据流操作最容易踩中的时机。注释里原本就留着一句 `should throw exception in the future`，这次是把「throw 什么」补对了。

### bitmap_value.h：满位图的 cardinality

`Roaring64Map::cardinality()` 在位图满（元素数 $2^{64}$，无法用 64 位整数表示语义上的「全体」）时抛异常：

```cpp title="be/src/util/bitmap_value.h（改动前）"
uint64_t cardinality() const {
    if (isFull()) {
        throw std::length_error(
                "bitmap is full, cardinality is 2^64, "
                "unable to represent in a 64-bit integer");
    }
```

```cpp title="be/src/util/bitmap_value.h（改动后）"
uint64_t cardinality() const {
    if (isFull()) {
        throw doris::Exception(doris::ErrorCode::INTERNAL_ERROR,
                               "bitmap is full, cardinality is 2^64, "
                               "unable to represent in a 64-bit integer");
    }
```

`cardinality()` 是 bitmap 函数族的高频出口——`bitmap_count`、`bitmap_andnot` 等的向量化实现（`be/src/vec/functions/function_bitmap.cpp`）里大量直接调用。这些函数在算子的表达式执行路径上跑，外层同样只有 `catch (doris::Exception)`，`std::length_error` 直接逃逸。换成 `doris::Exception` 后，同一个满位图查询会得到一条带错误码的查询报错，而不是 BE 崩溃。

### once.h：CallOnce 的 stored_result

`DorisCallOnce::stored_result()` 在方法尚未被调用时抛异常，改动把无信息的裸 `std::exception()` 换成带消息的异常：

```cpp title="be/src/util/once.h（改动后）"
ReturnType stored_result() const {
    if (!has_called()) {
        // Could not return status if the method not called.
        throw doris::Exception(doris::ErrorCode::INTERNAL_ERROR,
                               "calling stored_result while has not been called");
    }
```

这个类在 `Segment` 的索引懒加载（`_load_index_once`）、`Tablet` 初始化（`_init_once`）等处使用。裸 `std::exception()` 除了类型不被捕获，`what()` 也只返回一句 "std::exception"，崩溃后没有排查线索；换成 `doris::Exception` 后带上了明确的消息文案。

### 为什么换异常类型，而不是加兜底 catch

一个自然的疑问：为什么不在执行边界加 `catch (...)` 兜底？Doris 的选择是**收敛异常类型**而不是扩大捕获面——兜底 catch 会把任何未知异常吞成统一错误，丢失类型、错误码和栈；而统一抛 `doris::Exception(INTERNAL_ERROR)` 有三个额外收益：

1. **栈回溯**：`INTERNAL_ERROR` 在错误码表里配置了 `stacktrace = true`（`be/src/common/status.h` 的 `APPLY_FOR_THRIFT_ERROR_CODES`），`Exception` 构造时会自动抓一份 `get_stack_trace()` 存进异常对象，FE 拿到的错误信息里直接带崩溃点上下文。
2. **错误码语义**：`to_status()` 能还原成带 code 的 `Status`，FE 侧按错误码展示，而不是一段裸字符串。
3. **零额外开销**：复用已有的捕获宏，不需要新增任何 try/catch 块。

## 意义与影响

改动 7 行，影响的是故障的爆炸半径：三处场景从「BE 进程 coredump、全节点查询中断、需要人工拉起」降级为「单条查询收到带错误码和栈的报错」。对线上集群来说，这属于低频但极高代价的故障——满位图、supplier 拉数失败这类边界条件平时不触发，一旦触发就是整个 BE 挂掉。

同时要注意这个 PR 是**点修**而非收口：合并时 `be/src` 下仍残留 6 处 `throw std::runtime_error`（`vorc_transformer.cpp`、`phdr_cache.cpp`、http action 等）和 1 处 `std::logic_error`（`string_ref.h`）。这些残留点中，ORC 读取路径（`vorc_transformer.cpp`）同样位于查询执行链上，是同类风险。后续版本里 `vorc_transformer` 已改用 `doris::Exception`，但 `string_ref.h` 至今仍保留 std 异常，且后来新增的 `pod_array.h` 还引入了新的裸抛——「std 异常不允许出现在查询执行路径」这条纪律，靠的是持续的单点修复而非一次性清理。

## TODO

PR 只修了被确认触发 coredump 的三处，合并时残留的同类裸抛（截至本 PR 合并后的 master）：

- [ ] `be/src/vec/runtime/vorc_transformer.cpp` 两处 `throw std::runtime_error(st.to_string())`——ORC 查询路径（后续版本已改掉）
- [ ] `be/src/vec/common/string_ref.h` 的 `throw std::logic_error`（无 SSE 环境的 CRC32Hash）
- [ ] `be/src/common/phdr_cache.cpp`、`be/src/http/action/*` 的 `std::runtime_error`（进程初始化 / HTTP 边界，触发面较窄）
- [ ] `be/src/core/pod_array.h` 的 `throw std::exception()`（2026 年才引入的新代码，同类问题回潮）

## 相关阅读

- [修复 Set 操作 4G 大块数据 coredump](/vibe-reading/articles/Database/OLAP/Apache-Doris/PRs/doris-pr-61471-set-op-coredump-4g) — 同属 BE 崩溃修复线，对照看「溢出导致的崩溃」与「异常类型导致的崩溃」两类根因。
- [补齐 AddColumnsClause 在 AGG_KEYS 表的 key 标记逻辑](/vibe-reading/articles/Database/OLAP/Apache-Doris/PRs/doris-pr-61798-agg-double-key-crash) — 崩溃点在 BE、根因在 FE 的案例，与本篇「根因在异常类型约定」互为补充。
- [Pipeline 执行引擎](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/07-pipeline) — Doris 4.1.3 CodeWiki，理解本文异常逃逸所处的算子调度与线程池执行体系。
