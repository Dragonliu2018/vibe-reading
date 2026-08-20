---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "DXL 翻译桥"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C/C++", "MPP", "ORCA", "DXL"]
description: "Cloudberry gpopt 模块——PostgreSQL Query/Plan 与 GPORCA DXL 之间的双向翻译桥，用 Context + 映射表 + Wrapper 解耦 C 内核与 C++ 优化器。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/00-overview)

---

## 模块定位

`gpopt` 是 PostgreSQL C 内核与 GPORCA C++ 优化器之间的**双向翻译桥**。ORCA 只认自己设计的 XML 风格中间表示 DXL（Dynamic eXchange Language），完全不接触 PostgreSQL 的 `Query`/`Plan`/`PlannedStmt` 结构；而 PostgreSQL planner 在 `optimizer=on` 时需要调用 ORCA 拿到最优物理计划。`gpopt` 就负责这条往返管道：把 PG 的 `Query*` 翻译成 `CDXLNode*` 喂给 ORCA，再把 ORCA 产出的优化后 `CDXLNode*` 翻译回 PG 的 `PlannedStmt*`。

它的核心价值是**解耦**：让 ORCA 的 C++ 对象体系（GPOS 内存池、C++ 异常）与 PG 的 C 内存上下文（`MemoryContext`、`setjmp`/`longjmp`）彻底隔离，两边可以独立演进、独立调试，互不污染内存与异常栈。`gpopt` 本身用 C++ 编写，编译为 `libgpopt.so` 被 C 代码 `orca.c` 调用，是整个 Cloudberry 里把 C/C++ 两个世界缝合起来的那一层。

## 模块架构

```text
                     PostgreSQL C 内核
                            │
                   ┌────────┴────────┐
                   │ optimizer/plan/  │   optimize_query()  ── extern "C"
                   │     orca.c       │   GPOPTOptimizedPlan()
                   └────────┬────────┘
                            │  Query*
              ┌─────────────┴──────────────┐
              │       CGPOptimizer         │  翻译器主入口（静态方法）
              │   GPOPTOptimizedPlan()     │
              └─────────────┬──────────────┘
                            │
              ┌─────────────┴──────────────┐
              │        COptTasks           │  任务封装 + GPOS 隔离
              │   Execute() → gpos_exec()  │  10MB 错误缓冲、独立内存池
              │      OptimizeTask()       │
              └──────┬─────────────┬──────┘
      Query→DXL     │              │     DXL→Plan
  ┌──────────────────┴───┐   ┌─────┴──────────────────┐
  │ CContextQueryToDXL   │   │  CContextDXLToPlStmt    │  Context 对象
  │ + CTranslatorQuery   │   │  + CTranslatorDXLToPl  │  （持有 ID 生成器/
  │   ToDXL              │   │    Stmt                 │   RTE/Slice 等状态）
  │ + CMappingVarColId   │   │  + CMappingColIdVar     │  映射表（ColId↔Var）
  └──────────┬───────────┘   └──────────┬─────────────┘
             │ CDXLNode*                 │ PlannedStmt*
             └────────────┬─────────────┘
                    ┌──────┴──────┐
                    │   gporca     │  COptimizer::PdxlnOptimize()
                    │ (libgpopt)  │  Cascades 搜索
                    └─────────────┘
```

`gpopt` 内部分三个层次：**主入口 `CGPOptimizer`** 对外暴露静态方法和一个 `extern "C"` 的 C 接口；**任务封装 `COptTasks`** 把整个往返包成一个在 GPOS 独立内存/异常环境中运行的任务；**翻译上下文 + 翻译器 + 映射表** 是实际干翻译活的部分，按 Query→DXL 与 DXL→Plan 两个方向各有一组。横切所有层次的是 `gpdbwrappers`——把 PG 内核函数用 `sigsetjmp` 包起来，把 PG 的 `longjmp` 错误转成 GPOS 的 C++ 异常。

## 调用链路

一次 ORCA 优化的完整往返（`optimizer=on` 时被 PG planner 调用）：

```text
orca.c: optimize_query(query)                         [Query*]
  └─ GPOPTOptimizedPlan(parse, &fUnexpectedFailure, options)   [extern "C", CGPOptimizer.cpp:204]
     └─ CGPOptimizer::GPOPTOptimizedPlan(query, ...)            [CGPOptimizer.cpp:45]
        └─ COptTasks::GPOPTOptimizedPlan(query, &gpopt_context, opts)  [COptTasks.cpp:1180]
           └─ COptTasks::Execute(&OptimizeTask, gpopt_context)  [COptTasks.cpp:247]
              └─ gpos_exec(...)                  // 进入 GPOS 独立栈/内存池
                 └─ OptimizeTask(opt_ctxt)       [COptTasks.cpp:883]
                    ├─ CTranslatorQueryToDXL::TranslateQueryToDXL()  [→ CDXLNode* query_dxl]
                    ├─ COptimizer::PdxlnOptimize(query_dxl, ...)     [→ CDXLNode* plan_dxl]  ── gporca
                    └─ ConvertToPlanStmtFromDXL(plan_dxl, ...)       [COptTasks.cpp:305]
                       └─ CTranslatorDXLToPlStmt::GetPlannedStmtFromDXL()  [→ PlannedStmt*]
```

数据类型三段变化：`Query*` →（CTranslatorQueryToDXL）→ `CDXLNode*` →（ORCA `PdxlnOptimize`）→ `CDXLNode*`（优化后物理计划）→（CTranslatorDXLToPlStmt）→ `PlannedStmt*`。`SOptContext` 结构体（`COptTasks.h:62`）作为整个往返的"信封"，承载输入 `m_query`、输出 `m_plan_stmt`（或序列化的 `m_plan_dxl`）和 `m_error_msg`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `CGPOptimizer::GPOPTOptimizedPlan` in `CGPOptimizer.cpp:45` | 翻译器主入口，转交 COptTasks | 静态方法 + `extern "C"` 包装供 C 调用 |
| `CGPOptimizer::InitGPOPT` / `TerminateGPOPT` in `CGPOptimizer.cpp:164,187` | 初始化/终止 gpos/gpdxl/gpopt 三层库 | 进程级生命周期，GPOS 全局单例 |
| `COptTasks::GPOPTOptimizedPlan` in `COptTasks.cpp:1180` | 设置 `SOptContext`，调 `Execute` | 把状态打包进信封，避免全局变量 |
| `COptTasks::Execute` in `COptTasks.cpp:247` | 通过 `gpos_exec` 在 GPOS 框架中运行任务 | 独立内存池 + 10MB 错误缓冲 + abort 回调 |
| `COptTasks::OptimizeTask` in `COptTasks.cpp:883` | 核心任务：Query→DXL→ORCA→DXL→Plan | 在 GPOS 线程内执行完整往返 |
| `COptTasks::ConvertToPlanStmtFromDXL` in `COptTasks.cpp:305` | DXL→PlannedStmt 翻译入口 | 创建 `CContextDXLToPlStmt` + `CTranslatorDXLToPlStmt` |
| `CMappingVarColId::GetColId` in `CMappingVarColId.cpp` | 通过 PG `Var` 查 ORCA `ColId` | hashmap 键为 `(query_level, var_no, attrnum)` 三元组 |

</details>

## 核心实现

### CGPOptimizer 与 COptTasks：入口与 GPOS 任务隔离

`CGPOptimizer`（`src/include/gpopt/CGPOptimizer.h`）是翻译器的对外门面，三个静态方法 `GPOPTOptimizedPlan`/`SerializeDXLPlan`/`InitGPOPT`/`TerminateGPOPT` 覆盖了"优化一条 Query""序列化 DXL""库生命周期"三类操作。真正的活转交给 `COptTasks`：

```cpp title="src/include/gpopt/CGPOptimizer.h"
class CGPOptimizer
{
public:
    static PlannedStmt *GPOPTOptimizedPlan(Query *query,
        bool *had_unexpected_failure, OptimizerOptions *opts);
    static char *SerializeDXLPlan(Query *query);
    static void InitGPOPT();
    static void TerminateGPOPT();
};
```

`COptTasks`（`src/backend/gpopt/utils/COptTasks.cpp`）的关键设计是**把 ORCA 优化包成一个在 GPOS 框架中运行的任务**。`Execute()` 在 `COptTasks.cpp:247` 调 `gpos_exec()`，传入任务函数 `OptimizeTask`、10MB 错误缓冲（`#define GPOPT_ERROR_BUFFER_SIZE 10 * 1024 * 1024`）和一个 `abort_requested` 回调。`OptimizeTask`（`COptTasks.cpp:883`）在这个隔离环境里串起三段翻译。为什么要这么做？因为 ORCA 用自己的 GPOS 内存池（`CMemoryPool`）和 C++ 异常（`GPOS_TRY`/`GPOS_CATCH_EX`），与 PG 的 `palloc`/`MemoryContext` 和 `setjmp`/`longjmp` 完全是两套机制——混在一起会内存泄漏、异常栈错乱。`gpos_exec` 提供独立栈和 `CAutoMemoryPool`（RAII 自动释放），让 ORCA 的分配/异常不污染 PG 侧。

### 双向翻译器与 Context 对象

翻译分两个方向，各有一组 Context + Translator + Mapping：

- **Query→DXL**：`CContextQueryToDXL`（`src/backend/gpopt/translate/CContextQueryToDXL.cpp`）持有三个 `CIdGenerator`（ColId/QueryId/CTEId，起始值 `GPDXL_COL_ID_START` 等）和分布式表检测标志 `m_has_distributed_tables`；`CTranslatorQueryToDXL::TranslateQueryToDXL()` 实际把 `Query` 树转成 `CDXLNode`。
- **DXL→Plan**：`CContextDXLToPlStmt` 持有 Plan node/Motion/Param 三套 ID 生成器，外加 `m_rtable_entries_list`（RTE 列表）、`m_subplan_entries_list`、`m_slices_list`（PlanSlice）、`m_cte_producer_info`（CTE Producer 追踪）、`m_part_selector_to_param_map`（分区裁剪参数映射）。`ConvertToPlanStmtFromDXL()` 在 `COptTasks.cpp:321` 创建 context，传给 `CTranslatorDXLToPlStmt::GetPlannedStmtFromDXL()`。

Context 模式的好处是把翻译过程的全局可变状态（ID 分配、列表累积）从翻译器函数里抽出来，避免全局变量，也让子上下文能 `MergeTcxt()` 合并（`CDXLTranslateContext` 维护 `m_colid_to_target_entry_map` 和 `m_colid_to_paramid_map` 两个 hashmap）。

### 映射表：在两个列标识世界间架桥

PG 与 DXL 的列标识完全不同：PG 的 `Var` 是三元组 `(query_level, var_no, attrnum)`——基于 RTE 位置和属性号；DXL 的 `ColId` 是全局唯一整数，由 `CIdGenerator` 递增分配。没有映射表，翻译器根本无法在两边转换。

`CMappingVarColId`（`src/backend/gpopt/translate/CMappingVarColId.cpp`）是 Query→DXL 方向的核心映射表，内部维护一个初始 2047 槽的 hashmap `GPDBAttOptColHashMap`，键为 `CGPDBAttInfo(query_level, var_no, attrnum)`，值为 `CGPDBAttOptCol(gpdb_att_info, opt_col_info)`。关键方法：`Insert()` 插入 PG 属性→ORCA ColId 映射；`GetColId()` 通过 PG `Var` 查 ORCA `ColId`；`LoadTblColumns()`/`LoadIndexColumns()`/`LoadCTEColumns()`/`LoadProjectElements()` 从不同来源批量加载列映射；`CopyRemapColId()` 处理子查询层级提升时的 ColId 重映射。反方向 DXL→Plan 用 `CMappingColIdVar`（及其子类 `CMappingColIdVarPlStmt`），维护 `ColId→Var` 的反向映射；`CMappingElementColIdParamId` 维护 `ColId→ParamId` 用于 initplan/subplan 参数化。

### gpdbwrappers：longjmp → C++ 异常

`gpdbwrappers`（`src/backend/gpopt/gpdbwrappers.cpp`）不是 class，而是 `gpdb::` 命名空间下的函数集合，每个函数用 `GP_WRAP_START`/`GP_WRAP_END` 宏包裹一次 PG 调用。宏机制：用 `sigsetjmp` 设跳转点，PG 的 `longjmp`（`ereport(ERROR)`）被捕获后转为 `GPOS_RAISE(gpdxl::ExmaGPDB, gpdxl::ExmiGPDBError)` C++ 异常，让 ORCA 的 `GPOS_TRY`/`GPOS_CATCH_EX` 框架统一处理。文件注释强调**永不直接在 `PG_TRY` 块中 return**——必须先存到局部变量、在 `PG_END_TRY` 之后返回，否则 `longjmp` 栈未恢复会出错。典型函数如 `gpdb::CopyObject()`、`gpdb::AggregateExists()`、`gpdb::BmsAddMember()` 各自是对 PG 同名函数的安全封装。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 翻译器 / 中性中间表示 | `gpopt` 三大 Translator + DXL | 解耦 GPDB C 结构与 ORCA C++ 对象（内存/类型/异常隔离） |
| Context 对象 | `CContextQueryToDXL`/`CContextDXLToPlStmt` | 把翻译全程可变状态（ID 生成、列表累积）从函数抽出，避免全局变量 |
| 映射表 | `CMappingVarColId`/`CMappingColIdVar`/`CMappingElementColIdParamId` | 在 PG `Var` 三元组与 DXL `ColId` 整数两个列标识世界间双向转换 |
| Wrapper（适配器） | `gpdbwrappers.cpp` `gpdb::` 函数集 | 把 PG 的 `setjmp`/`longjmp` 错误转成 GPOS C++ 异常，统一异常处理框架 |
| 任务封装 / 隔离环境 | `COptTasks::Execute` → `gpos_exec` | ORCA GPOS 内存池与 PG `MemoryContext` 隔离，防内存泄漏与异常栈错乱 |

## 模块间交互

`gpopt` 被 `src/backend/optimizer/plan/orca.c` 的 `optimize_query()` 调用（`orca.c:202`，定义 `optimizer=on` 时 PG planner 的 ORCA 分支）。调用前 `orca.c` 做预处理：`copyObject(parse)` 复制 Query 树、`fold_constants()` 常量折叠、`transformGroupedWindows()` 分离窗口/聚合；调用后做后处理：`apply_shareinput_xslice()`、`remove_redundant_results()`、`cdb_extract_plan_dependencies()` 提取计划依赖供 plan cache invalidation。

`gpopt` 调用的是 GPORCA 库 `libgpopt` 的 `COptimizer::PdxlnOptimize()`（定义在 `src/backend/gporca/libgpopt/include/gpopt/optimizer/COptimizer.h:86`），输入输出都是 `CDXLNode*`——ORCA 从不接触 PG 结构。交互方式是 C++ 直接函数调用，但被 `COptTasks::Execute`/`gpos_exec` 包了一层内存与异常隔离。`gpopt` 自身不直接与 `cdb`/`executor` 交互——它产出的 `PlannedStmt`（含 Motion 节点，由 ORCA 的 enforcer 动态插入）交给 PG planner 后续经 `cdb` 改写/派发。不存在循环依赖：数据单向流 PG→gpopt→ORCA→gpopt→PG。

## 扩展方式

- **支持一种新 PG 算子翻译（Query→DXL）**：改 `src/backend/gpopt/translate/CTranslatorQueryToDXL.cpp` 的 `TranslateQueryToDXL()`（`:813`）在对应分支增加新 JoinType/节点类型的 case，构造 `CDXLLogicalJoin` 等 DXL 节点；可能需同步改 `CTranslatorDXLToPlStmt.cpp` 的反向翻译。
- **新增一个 DXL 节点翻译回 Plan（DXL→Plan）**：改 `CTranslatorDXLToPlStmt::GetPlannedStmtFromDXL()`（`:168`）的节点分发逻辑，增加新 case 构造对应 PG Plan 节点；可能在 `CContextDXLToPlStmt` 加新 ID 分配或状态追踪。
- **新增 `optimizer_xxx` GUC 控制 ORCA 行为**：改 `src/backend/gpopt/config/CConfigParamMapping.cpp` 的 `m_elements[]` 数组（`:30`）增加 `{Eopttrace..., &optimizer_xxx, negate, description}` 条目，把 GUC 映射为 ORCA trace flag；可能在 `COptTasks::CreateOptimizerConfig()`（`:386`）加 GUC→`COptimizerConfig`/`CHint` 映射。

扩展点的契约定义见概览「架构设计解析 > 核心概念」——`gpopt` 的扩展本质上是"在 PG 与 ORCA 两个世界之间增加一种新的双向映射"，必须同时维护正反两个方向的映射表一致性。
