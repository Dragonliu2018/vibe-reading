---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "解释器与上下文"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "Context", "InterpreterFactory", "executeQuery", "服务定位器"]
description: "ClickHouse 解释器与上下文源码解读——Context 服务定位器(pimpl)、InterpreterFactory 工厂分发、executeQuery 全流程。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Interpreters/` 是 ClickHouse 的中央枢纽。`Context.h` 是全仓库被 #include 最多的头文件（1127 次），作为服务定位器持有配置、设置、工厂、catalog 等所有全局状态；`InterpreterFactory` 按 AST 类型分发到具体 Interpreter；`executeQuery` 串联 parse→analyze→plan→execute 全流程。它独立成模块因为编排与服务定位贯穿全局，是各子系统的汇聚点。

## 模块架构

```text
src/Interpreters/
  ├─ Context.h/.cpp          ── Context 主类（ContextData 继承）+ pimpl
  ├─ ContextSharedPart (Context.cpp:471) ── pimpl 实现体（全局共享状态，单例）
  ├─ executeQuery.h/.cpp     ── executeQuery 全流程入口（parse→transform→factory→execute）
  ├─ InterpreterFactory.h/.cpp ── 工厂分发（50+ Interpreter，name→CreatorFn）
  ├─ registerInterpreters.cpp   ── 集中注册入口
  ├─ IInterpreter.h            ── IInterpreter 接口（execute 返回 BlockIO）
  ├─ ProcessList.h             ── 查询进程列表（QueryStatus，取消/限流）
  ├─ ActionsDAG.h              ── 表达式 DAG（Planner 与 Processors 之间）
  └─ InterpreterSelectQueryAnalyzer.h ── 新路径 SELECT 解释器
```

## 调用链路

```text
executeQuery(istr, context, ...) in executeQuery.cpp:2463
  └─ executeQueryImpl(begin, end, context, ...) in executeQuery.cpp:1147
     ├─ parseQuery(parser, begin, end, ...)        # 1. SQL → ASTPtr
     ├─ AST 预处理: ReplaceQueryParameterVisitor/ApplyWithGlobalVisitor/NormalizeSelectWithUnion
     ├─ context->getProcessList().insert(...)       # 3. 注册 ProcessList 获取 QueryStatus
     ├─ InterpreterFactory::instance().get(ast, context, options)  # 4. 分发到 Interpreter
     │  └─ query->as<ASTSelectQuery>() if-else 链 → interpreter_name → interpreters.at(name)(args)
     ├─ quota 检查                                  # 5.
     ├─ interpreter->execute()                      # 6. 返回 BlockIO（含 QueryPipeline）
     └─ pipeline.complete(output_format) + CompletedPipelineExecutor(pipeline).execute()  # 7. 执行
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `executeQueryImpl` in `executeQuery.cpp:1147` | 查询全流程骨架 | parse→transform→factory→execute |
| `InterpreterFactory::get` in `InterpreterFactory.cpp:116` | 按 AST 分发 | name→CreatorFn 查表 |
| `Context::createGlobal` in `Context.cpp:1395` | 创建全局 Context | shared 指向 ContextSharedPart |
| `Context::createCopy` in `Context.cpp:1410` | 派生子 Context | 共享 shared，独立 settings |
| `ProcessList::insert` | 注册查询 | 返回 QueryStatus EntryPtr |
| `QueryStatus::cancelQuery` | 取消查询 | 原子 CAS is_killed |

</details>

## 核心实现

### Context：服务定位器 + pimpl

```cpp title="src/Interpreters/Context.h"
class ContextData {                        // per-instance 状态层
    ContextSharedPart * shared{};          // 裸指针指向共享部分（非拥有）
    ClientInfo client_info;
    std::unique_ptr<Settings> settings{};
    ContextWeakMutablePtr query_context, session_context, global_context;
    std::weak_ptr<QueryStatus> process_list_elem;
    ProgressCallback progress_callback;
};
class Context : public ContextData, public std::enable_shared_from_this<Context> {
    mutable ContextSharedMutex mutex;
    static ContextMutablePtr createGlobal(ContextSharedPart *);
    static ContextMutablePtr createCopy(const ContextPtr & other);
    Settings getSettingsCopy() const;
    ProcessList & getProcessList();        // return shared->process_list;
    AccessControl & getAccessControl();
    // 数百个 getter...
};
```

`ContextSharedPart`（`Context.cpp:471`）定义在 .cpp 中，持有所有跨 session/query 共享的全局状态——config、access_control、process_list、merge_list、所有 cache（uncompressed/mark/primary_index）、所有线程池、ZooKeeper 连接、DDL worker、storage policies。构造函数用 `static atomic num_calls` 计数强制单例（>1 则 `std::terminate`）。`SharedContextHolder`（`Context.h:328`）持 `unique_ptr<ContextSharedPart>`，头文件仅前向声明——隔离 1127+ includer 的编译依赖。

### Context 三层作用域

global（cache/ZooKeeper/工厂）、session（当前用户/数据库/session settings）、query（progress callback/access info/scalars）。`makeGlobalContext` 设 `global_context=shared_from_this` 并初始化 DatabaseCatalog；`makeSessionContext` 设 `session_context`；`makeQueryContext` 重置 throttler 与 privileges。子 Context 经 `createCopy(global)` 派生，`shared` 指向同一 ContextSharedPart，但独立 settings/client_info。

### InterpreterFactory：name→CreatorFn 分发

```cpp title="src/Interpreters/InterpreterFactory.h"
class InterpreterFactory {
    static InterpreterFactory & instance();
    using CreatorFn = std::function<InterpreterPtr(const Arguments &)>;
    std::unordered_map<String, CreatorFn> interpreters;
    InterpreterPtr get(ASTPtr & query, ContextMutablePtr, const SelectQueryOptions &);
    void registerInterpreter(const std::string & name, CreatorFn);
};
```

`get`（`InterpreterFactory.cpp:116`）用 `query->as<ASTSelectQuery>()` if-else 链确定 `interpreter_name`（如 `ASTSelectQuery` → `InterpreterSelectQueryAnalyzer` 或 `InterpreterSelectQuery`，由 `allow_experimental_analyzer` 选择），再 `interpreters.at(name)(args)` 创建。50+ Interpreter 经 `registerInterpreters()`（`registerInterpreters.cpp:71`）集中注册。

### IInterpreter 与 executeQuery 流程

```cpp title="src/Interpreters/IInterpreter.h"
class IInterpreter {
    virtual BlockIO execute() = 0;    // 返回含 QueryPipeline 的 BlockIO
    virtual bool ignoreQuota() const { return false; }
    virtual bool supportsTransactions() const { return false; }
};
```

`executeQueryImpl`（`executeQuery.cpp:1147`）是模板方法骨架。`InterpreterSelectQueryAnalyzer`（新路径）构建 QueryPlan：`Planner(query_tree, options, planner_context).buildQueryPlanIfNeeded()` → `query_plan.buildQueryPipeline` → `pipeline.execute()` 得 `PipelineExecutor`。`CompletedPipelineExecutor` 驱动完整流水线，`PullingAsyncPipelineExecutor` 供 handler 拉结果块。

### ProcessList 与查询取消

```cpp title="src/Interpreters/ProcessList.h"
class QueryStatus : public WithContext {
    String query;
    QuerySlotPtr query_slot;              // 工作负载槽位
    MemoryReservationPtr memory_reservation;
    std::atomic<bool> is_killed { false };
    CancellationCode cancelQuery(CancelReason reason, ...);
    bool checkTimeLimit();               // 超时检查
};
```

`ProcessList::insert` 注册查询返回 `EntryPtr`。取消有三机制：用户 `KILL QUERY`（`cancelQuery` 设 `is_killed`）、pipeline 异常取消、`CancellationChecker` 后台线程超时检测（按 deadline 网格批量处理）。异常过滤 `QUERY_WAS_CANCELLED` 等不标记为系统错误。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `Context` | 数百服务需全局访问，调用链极深避免参数爆炸 |
| pimpl | `ContextSharedPart` | 隔离 1127+ includer 编译依赖 |
| 工厂 | `InterpreterFactory` | 50+ Interpreter 按名注册/查找 |
| 单例 | `InterpreterFactory::instance`/`ContextSharedPart` | 全局唯一 |
| 模板方法 | `executeQueryImpl` | parse→factory→execute 骨架固定 |

## 重要设计决策

### 为什么用 Context 服务定位器而非依赖注入

ClickHouse 数百个需全局访问的服务（cache/工厂/config/ZooKeeper），调用链极深（executeQuery→Interpreter→Planner→Storage→Processor→Reader）。构造注入每层传数十依赖参数签名爆炸。服务定位器让每模块只需一个 `ContextPtr` 按需获取。代价：Context.h 被包含 1127 次，编译依赖广泛传播，Context 成上帝对象（2000+ 行、数百方法）——pimpl 缓解编译依赖。

### Context 为什么用 shared_ptr + pimpl

生命周期管理——global/session/query 三层，子 Context 经 `createCopy` 创建 shared_ptr 拷贝但共享部分只建一次，query/session 销毁不影响全局状态。编译依赖隔离——ContextSharedPart 持重型成员（AccessControl/ProcessList/Cache），定义在 .cpp，头文件仅前向声明，避免 includer 拉入完整定义。

## 扩展方式

新增 Interpreter `InterpreterFooQuery`：建 `src/Interpreters/InterpreterFooQuery.h/.cpp` 继承 `IInterpreter` 实现 `execute`；在 `registerInterpreters.cpp` 加 `registerInterpreterFooQuery` 调用；`InterpreterFactory::get` 加 `query->as<ASTFooQuery>()` 分支设 `interpreter_name="InterpreterFooQuery"`；建对应 `ASTFooQuery` 与 Parser。给 Context 加全局服务：在 `ContextSharedPart`（`Context.cpp:471`）加成员，`Context.h` 加 getter 声明，`Context.cpp` 实现（仿 `getUncompressedCache`，加锁返回 shared 成员），启动时 `setMyCache`。

## 模块间交互

Context 被几乎所有模块 import（1127 次）。`executeQuery` 调 Parsers（`parseQuery`）、InterpreterFactory（分发到 Planner/Storages/Processors）。Interpreter 通过 Context 获取 Settings、DatabaseCatalog（`DatabaseCatalog::instance()` 单例，`makeGlobalContext` 初始化）、FunctionFactory。`ProcessList` 跟踪所有执行中查询，支持 `KILL` 与限流。`ActionsDAG` 是 Planner 与 Processors 之间的表达式中间表示。
