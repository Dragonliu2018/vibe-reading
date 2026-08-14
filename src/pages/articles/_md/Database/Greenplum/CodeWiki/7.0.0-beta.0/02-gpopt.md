---
source:
  type: "源码解读"
  project: "Greenplum"
  url: "https://github.com/greenplum-db/gpdb"
title: "gpopt 翻译桥"
date: "2026-08-14T15:39:30+08:00"
category: [Database, Greenplum, CodeWiki, "7.0.0-beta.0"]
tags: ["Greenplum", "C++", "ORCA", "DXL", "翻译器"]
description: "gpopt——PostgreSQL Query/Plan 与 ORCA DXL 之间的翻译桥，GPDB 调用 GPORCA 的唯一通道。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Greenplum/CodeWiki/7.0.0-beta.0/00-overview)

---

## 模块定位

`gpopt`（`src/backend/gpopt/`，头文件 `src/include/gpopt/`，~3.2 万行 C++）是 GPDB 调用 GPORCA 的**唯一通道**。GPDB 内核是 C（`Query`、`Plan` 等 PostgreSQL 结构），GPORCA 是 C++（`CExpression`、`CGroup` 等优化器内部对象），两者内存管理与类型系统不兼容。`gpopt` 用 **DXL**（一种 XML 中间表示）作为中性交换格式，完成三段翻译：把 PostgreSQL `Query` 树翻成 DXL 逻辑树喂给 ORCA，再把 ORCA 输出的物理 DXL 树翻回 GPDB 可执行的 `PlannedStmt`。它同时负责向 ORCA 按需提供元数据（relcache → DXL MD 对象）。

## 模块架构

模块由三大方向各异的翻译器 + 一个编排器 + 一个 C↔C++ 桥组成：

| 组件 | 文件 | 职责 |
|------|------|------|
| `CTranslatorQueryToDXL` | `translate/CTranslatorQueryToDXL.cpp`（5075 行） | `Query` → DXL 逻辑算子树 |
| `CTranslatorDXLToPlStmt` | `translate/CTranslatorDXLToPlStmt.cpp`（6829 行） | ORCA 物理 DXL → `PlannedStmt`（含 Motion/slice） |
| `CTranslatorRelcacheToDXL` | `translate/CTranslatorRelcacheToDXL.cpp`（3170 行） | relcache/catalog → ORCA `IMDCacheObject` 元数据 |
| `CTranslatorScalarToDXL` / `CTranslatorDXLToScalar` | `translate/` | 标量表达式 `Expr` ↔ DXL 互译 |
| `COptTasks` | `utils/COptTasks.cpp` | 编排：Query→DXL→optimize→DXL→PlanStmt 全流程 |
| `CGPOptimizer` | `translate/CGPOptimizer.cpp` | C↔C++ 桥，`extern "C"` 入口 `GPOPTOptimizedPlan` |

`CMDProviderRelcache`（`relcache/CMDProviderRelcache.cpp`，仅 ~50 行）是实现 `IMDProvider` 的适配器，委托 `CTranslatorRelcacheToDXL::RetrieveObject`。所有 gpopt 分配在 ORCA 的 `CMemoryPool` 中，PG 分配在 `MemoryContext` 中，跨边界用 `gpdb::GPDBAlloc`/`GPDBFree`。

## 调用链路

从 `standard_planner` 到 `PlannedStmt` 的完整翻译路径（数据类型在箭头上标注）：

```
orca.c: optimize_query(Query*, cursorOptions, boundParams)        optimizer/plan/orca.c:92
 ├─ fold_constants() / transformGroupedWindows()    预处理
 └─ GPOPTOptimizedPlan(pqueryCopy, &fUnexpected)    orca.c:156   [extern "C" 桥]
     └─ COptTasks::GPOPTOptimizedPlan(query, &ctx)    COptTasks.cpp:1145
        └─ Execute(&OptimizeTask, &ctx)              COptTasks.cpp:1152   ← 切到 GPOS 线程
           └─ OptimizeTask(ptr)                      COptTasks.cpp:850
              ├─ [1] 初始化 MDCache / CMDAccessor(relcache_provider)
              ├─ [2] Query → DXL
              │     CTranslatorQueryToDXL::QueryToDXLInstance(mp, &mda, query)
              │     └─ TranslateQueryToDXL()  按 commandType switch 分发
              │         └─ TranslateSelectQueryToDXL / Insert / Delete / Update / CTAS
              │   数据: Query* → CDXLNode*(逻辑)
              ├─ [3] ORCA 优化
              │     COptimizer::PdxlnOptimize(mp, &mda, query_dxl, …, optimizer_config)   :956
              │   数据: CDXLNode*(逻辑) → CDXLNode*(物理,含 Motion)
              └─ [4] DXL → PlannedStmt
                    ConvertToPlanStmtFromDXL(mp, &mda, query, plan_dxl, …)   :976
                      └─ CTranslatorDXLToPlStmt::GetPlannedStmtFromDXL(plan_dxl, …)
                          └─ TranslateDXLOperatorToPlan(dxlnode, …)   按 ulOpId switch
                              └─ TranslateDXLTblScan / HashJoin / Motion / Agg / …
                  数据: CDXLNode*(物理) → PlannedStmt*(含 Motion + slices)
```

核心上下文 `SOptContext`（`include/gpopt/utils/COptTasks.h:58`）贯穿流程：`m_query`(输入 Query) → `m_plan_dxl`(中间 DXL 串) → `m_plan_stmt`(输出计划)，含失败标志与错误消息。

<details>
<summary>方法速查</summary>

| 方法 | 一行职责 | 关键决策 |
|------|----------|----------|
| `optimize_query` (orca.c:92) | GPDB 侧 ORCA 入口，预处理 + 调桥 + 后处理 | ShareInput xslice、redundant results 清理 |
| `GPOPTOptimizedPlan` (COptTasks.cpp:1145) | C↔C++ 桥，`extern "C"` | 切换到 GPOS 内存/异常体系 |
| `OptimizeTask` (COptTasks.cpp:850) | GPOS 线程内编排四步翻译 | 工厂创建翻译器、建 MDCache |
| `TranslateQueryToDXL` (COptTasks.cpp:937) | Query→DXL 逻辑树 | commandType switch 分发 |
| `PdxlnOptimize` (COptTasks.cpp:956) | 调 ORCA 优化 | 传 search_strategy + optimizer_config |
| `ConvertToPlanStmtFromDXL` (COptTasks.cpp:976) | DXL→PlannedStmt | 构造 slice/motion ID |

</details>

## 核心实现

### CTranslatorQueryToDXL：Query → DXL 逻辑树

遍历 PostgreSQL `Query` 树逐节点翻译为 DXL 逻辑算子树（`translate/CTranslatorQueryToDXL.cpp`）。按 `m_query->commandType` switch 分发到 `TranslateSelectQueryToDXL`/`TranslateInsertQueryToDXL`/`TranslateDeleteQueryToDXL`/`TranslateUpdateQueryToDXL`/`TranslateCTASToDXL`（`CTranslatorQueryToDXL.cpp:793`）。子查询通过在**构造函数栈上创建新的 `CTranslatorQueryToDXL` 实例**递归处理（`TranslateDerivedTablesToDXL:4089`），共享同一个 `CContextQueryToDXL`（保证 ColId 全局唯一），复制 `CMappingVarColId` 让子查询可见父查询列映射，递增 `m_query_level`。标量表达式由 `CTranslatorScalarToDXL::TranslateScalarToDXL`（`CTranslatorScalarToDXL.cpp:307`）按 `expr->type` switch 翻译（Var/Const/OpExpr…）。

### CTranslatorDXLToPlStmt：DXL → PlannedStmt（含 Motion/Gang）

把 ORCA 输出的物理 DXL 树翻译回执行器可识别的 `PlannedStmt`（`translate/CTranslatorDXLToPlStmt.cpp`）。`TranslateDXLOperatorToPlan`（`:328`）按 `ulOpId` switch 分发到 20+ 个 `TranslateDXL*` 方法（TblScan/IndexScan/HashJoin/NLJoin/Motion/Agg/Window/Sort/Append/Split/PartSelector…），每个递归调用处理子节点。

Motion/Gang 的翻译是 GPDB 专属难点。`TranslateDXLMotion`（`:2339`）把 ORCA 的 `CDXLPhysicalMotion`（Gather/Redistribute/Broadcast/RoutedDistribute/Random）翻成 GPDB `Motion` plan node，同时构建 `PlanSlice`：为每个 Motion 创建新发送端 slice、设 `parentIndex` 指向接收端、按 `input_segids_array` 大小判 gang 类型（单 segment → `GANGTYPE_SINGLETON_READER`/`GANGTYPE_ENTRYDB_READER`，多 segment → `GANGTYPE_PRIMARY_READER`），对 Redistribute/RoutedDistribute/Random 翻译 hash 表达式列表并算 hash 函数。`GetPlannedStmtFromDXL`（`:165`）最后组装 `PlannedStmt` 时设顶层 slice 与 direct dispatch 信息（用于 INSERT 只发部分 segment）。

### CTranslatorRelcacheToDXL：relcache → ORCA 元数据

ORCA 优化需大量元数据（表 schema、列统计、索引、类型、函数、cast），但 GPDB relcache 是 C 结构（`RelationData`/`FormData_pg_attribute`），ORCA 无法直接用。`CTranslatorRelcacheToDXL`（`translate/CTranslatorRelcacheToDXL.cpp`）在 ORCA 需要时**按需**从 relcache/syscache 提取并翻译为 `IMDCacheObject`。`RetrieveObject`（`:90`）按 `IMDId::MdidType()` switch 分发到 `RetrieveRel`/`RetrieveIndex`/`RetrieveColStats` 等。

它还负责**统计信息格式转换**：GPDB `pg_statistic` 用 MCV + histogram 格式，ORCA 用 `CHistogram`/`CDXLBucketArray`，由 `TransformStatsToDXLBucketArray`（`:200`）转换。通过 `CMDProviderRelcache` 实现**lazy 按需加载**——`CMDAccessor` 先查 `CMDCache` 缓存，未命中才调 provider。

### COptTasks：编排器

`COptTasks::OptimizeTask`（`COptTasks.cpp:850`）是全流程编排核心：创建 `CMDProviderRelcache` 包装进 `CMDAccessor` → 工厂创建 `CTranslatorQueryToDXL` 调 `TranslateQueryToDXL()` → 调 `COptimizer::PdxlnOptimize()` → 调 `ConvertToPlanStmtFromDXL()`。还负责 `CreateOptimizerConfig`（GUC → `COptimizerConfig`）、`GetCostModel`（`CCostModelGPDB`）、`GetPlanHints`（`CPlanHint`，可外部强制计划形状如强制 HashJoin）。`Execute()` 把任务投到 GPOS 线程执行，隔离 PG 与 ORCA 的内存/异常。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 翻译器（Translator） | 三大翻译器各自封装一个方向，接口统一（注入 mp+md_accessor+context） | 分离 C 结构与 C++ 对象的转换职责 |
| 上下文对象（Context Object） | `CContextQueryToDXL`（ColId/CTE ID 生成器、`m_has_distributed_tables`）；`CContextDXLToPlStmt`（plan/motion/param ID、rtable、subplan、slices） | 跨子查询/递归下降共享状态，保证 ID 全局唯一 |
| switch 分发 + 递归下降 | Query→DXL 按 commandType、DXL→Plan 按 ulOpId、relcache→MD 按 mdidType | 算子种类多，分发比 Visitor 更直接 |

## 模块间交互

- **上游**：`optimizer/plan/orca.c:156` 通过 `extern "C"` 函数 `GPOPTOptimizedPlan()` 调 `CGPOptimizer`（`translate/CGPOptimizer.cpp:199`），这是 C→C++ 桥。`orca.c` 由 `standard_planner` 在 `optimizer=on && Gp_role==DISPATCH` 时调用。
- **下游 ORCA**：`COptTasks::OptimizeTask` 调 `COptimizer::PdxlnOptimize()`（`COptTasks.cpp:956`），即 `gporca` 库入口。
- **读写 PG 结构**：`CTranslatorQueryToDXL` 读 `Query*`，`CTranslatorDXLToPlStmt` 写 `PlannedStmt*`/`Plan*`，经 `gpdb::` 包装函数调 PG 内部函数（`gpdb::GetRelation`/`GPDBAlloc`/`makeNode`）。
- **元数据**：经 `CMDProviderRelcache` → `CTranslatorRelcacheToDXL` → GPDB relcache/syscache（`pg_class`/`pg_type`/`pg_statistic`/`pg_proc`/`pg_aggregate`/`pg_operator`/`pg_constraint`/`pg_index`）。
- **内存隔离**：gpopt 分配在 `CMemoryPool`，PG 在 `MemoryContext`，跨边界用 `gpdb::GPDBAlloc`/`GPDBFree`。

## 扩展方式

支持新 SQL 语法（如 MERGE/ON CONFLICT）：在 `CTranslatorQueryToDXL.cpp` 的 `TranslateQueryToDXL` switch 加分支（如新增 `TranslateMergeQueryToDXL`），必要时在 `CTranslatorScalarToDXL.cpp` 的 switch 加标量 case，在 `CTranslatorDXLToPlStmt.cpp` 的 `TranslateDXLOperatorToPlan` switch 加对应 plan node 的 `TranslateDXL*` 方法。

新增算子：ORCA 侧加 `CDXLPhysical*` DXL 算子（naucrates 库）→ `CTranslatorDXLToPlStmt.cpp` switch 加 case + `TranslateDXLNewOperator()` → 若影响 Motion/Gang 语义则改 `CContextDXLToPlStmt` 与 slice 管理。

ORCA 升级：改 `COptTasks.cpp::OptimizeTask` 的 `PdxlnOptimize` 调用参数与 `CreateOptimizerConfig`/`CConfigParamMapping` 的 GUC 映射，若 ORCA 新增元数据类型则在 `RetrieveObject` switch 加 case。

> 文件路径注意：实现文件在 `src/backend/gpopt/translate/`（非 `translator/`），头文件在 `src/include/gpopt/translate/`。`CMDProviderRelcache` 仅 ~50 行，是实现 `IMDProvider` 的适配器。
