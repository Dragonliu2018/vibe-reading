---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "执行器"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "executor", "Volcano", "迭代器", "ModifyTable", "HashJoin"]
description: "PostgreSQL executor 模块——Volcano 迭代器模型、函数指针分发、Init/Exec/ReScan/End 四方法、EState/ExprContext、HashJoin、ModifyTable DML"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/executor/` 是 Volcano/迭代器模型执行器。接收 optimizer 产出的 `Plan` 树，按「一次一元组」的迭代器方式执行。每个 Plan 节点对应一个 `ExecProcNode` 调用，递归拉取元组。这一层独立存在，因它把「计划如何执行」与「数据如何存取」解耦——执行器通过 table AM 抽象调 access 层，不直接操作 heap，使得存储引擎可插拔。

---

## 模块架构

核心调度在 `execMain.c`（`ExecutorStart`/`ExecutorRun`/`ExecutorFinish`/`ExecutorEnd` + `ExecutePlan` + `InitPlan`）和 `execProcnode.c`（`ExecProcNode` 函数指针分发）。各类节点实现各自 `nodeXxx.c`：扫描（`nodeSeqscan.c`/`nodeIndexscan.c`）、连接（`nodeNestloop.c`/`nodeHashjoin.c`/`nodeMergejoin.c`）、聚合（`nodeAgg.c`/`nodeWindowAgg.c`）、DML（`nodeModifyTable.c` 5978 行最大文件）、排序（`nodeSort.c`/`nodeIncrementalSort.c`）等。`execExpr.c` 处理表达式求值，`execJit.c` 接 LLVM。

---

## 调用链路

```
[tcop/pquery.c] PortalRun → PortalRunSelect
  → [execMain.c:122] ExecutorStart(queryDesc)  ── InitPlan 初始化 plan 树 + EState
  → [execMain.c:297] ExecutorRun(queryDesc)     ── ExecutePlan 循环拉元组
  → [execMain.c:406] ExecutorFinish()           ── AFTER 触发器
  → [execMain.c:476] ExecutorEnd()              ── ExecEndPlan 清理

ExecutePlan 循环（execMain.c:1660）:
  for (;;) {
    ResetPerTupleExprContext(estate);
    slot = ExecProcNode(planstate);   # 拉一个元组
    if (TupIsNull(slot)) break;
    dest->receiveSlot(slot, dest);     # 发往 DestReceiver
  }
```

NestLoop 拉取调用栈：
```
ExecutePlan
  └─ ExecProcNode(planstate)          # 顶层节点
       └─ ExecNestLoop()              # NestLoop.Exec
            ├─ ExecProcNode(outerPlan) → ExecSeqScan()   # 拉外表
            ├─ ExecReScan(innerPlan) → ExecReScanIndexScan()  # 重扫内表
            └─ ExecProcNode(innerPlan) → ExecIndexScan()       # 拉内表
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ExecutorStart/Run/Finish/End` | 执行生命周期 | hook 扩展（pg_stat_statements） |
| `InitPlan` | 初始化 plan 树 | 权限检查 + 分区裁剪 + 递归 ExecInitNode |
| `ExecutePlan` | 元组拉取循环 | count 限制自然背压 |
| `ExecProcNode` | 节点分发 | 函数指针而非 switch，零开销 |
| `ExecInitNode` | 节点初始化 | 按 nodeTag 分发到 ExecInitXxx |

---

## 核心实现

### 执行器生命周期

四阶段，每阶段有 hook：

| 阶段 | 函数 | 核心工作 |
| --- | --- | --- |
| Start | `standard_ExecutorStart`（L143） | 创建 EState、注册 snapshot、`InitPlan` 递归初始化 plan 树 |
| Run | `standard_ExecutorRun`（L318） | 启动 DestReceiver、`ExecutePlan` 循环拉元组 |
| Finish | `standard_ExecutorFinish`（L426） | `ExecPostprocessPlan` + `AfterTriggerEndQuery`（AFTER 触发器） |
| End | `standard_ExecutorEnd`（L486） | `ExecEndPlan` 递归清理、注销 snapshot、`FreeExecutorState` |

### Volcano 迭代器模型

`ExecProcNode`（`executor.h:321`）是 **inline 函数**，通过函数指针调用，非 switch：

```c
// src/include/executor/executor.h:321
static inline TupleTableSlot * ExecProcNode(PlanState *node) {
    if (node->chgParam != NULL) ExecReScan(node);   // 参数变化触发重扫
    return node->ExecProcNode(node);                  // 调用节点特定函数
}
```

每节点在 `ExecInitNode`（`execProcnode.c:142`，switch 分发到 `ExecInitXxx`）创建时由 `ExecSetExecProcNode`（L429）设 `ExecProcNode` 函数指针。首次调用经 `ExecProcNodeFirst` wrapper 做栈深度检查和仪表初始化，之后直接调真实函数。

**四方法范式**：

| 方法 | 职责 | 典型 |
| --- | --- | --- |
| Init | 创建 state、开关系、初始化表达式、初始化子节点 | `ExecInitSeqScan`（L219） |
| Exec | 拉下一个元组 | `ExecSeqScan`（L118） |
| ReScan | 重置扫描位置 | `ExecReScanSeqScan`（L347） |
| End | 释放资源 | `ExecEndSeqScan`（L303） |

ReScan 比 End+Init 轻量——只重置游标不重开关系，NestLoop 每个外表元组都需重扫内表（`nodeNestloop.c:152`）。

### EState 与 ExprContext

**EState**（`execnodes.h:690`）执行期全局状态，所有节点共享（经 `PlanState.state` 指针）：`es_snapshot`（可见性快照）、`es_range_table`、`es_result_relations`（DML 目标表）、`es_query_cxt`（per-query 内存）、`es_processed`（处理元组数）、`es_jit_flags`。

**ExprContext**（`execnodes.h:281`）节点局部表达式求值上下文：`ecxt_scantuple`/`ecxt_innertuple`/`ecxt_outertuple`（join 用）、`ecxt_per_tuple_memory`（per-tuple 短生命期，每元组 `ResetExprContext` 重置避免泄漏）。

### 关键节点

**SeqScan**（`nodeSeqscan.c`）：Init 据 qual/projection 组合选 5 种 `ExecProcNode` 变体（无 qual 无投影最快 → 有 qual 有投影），编译器 `pg_always_inline` 消除分支。`SeqNext`（L52）调 `table_scan_getnextslot` 委托 table AM。

**HashJoin**（`nodeHashjoin.c`）：Hybrid Hash Join（多 batch 溢出 + 并行）。8 状态机：`HJ_BUILD_HASHTABLE`（Hash 子节点 `MultiExecHash` 批量建表）→ `HJ_NEED_NEW_OUTER`→`HJ_SCAN_BUCKET`（probe）→ `HJ_FILL_*`（outer/inner null 填充）→ `HJ_NEED_NEW_BATCH`（切 batch）。内存不足自动增 batch 数（2 的幂）。

**Agg**（`nodeAgg.c`）：按 `aggstrategy` 分发——`AGG_HASHED`（`agg_fill_hash_table` 建 hash 表 + `agg_retrieve_hash_table` 遍历输出，支持 spill to disk）、`AGG_SORTED`（输入已排序，`agg_retrieve_direct` 检测分组边界）、`AGG_MIXED`（grouping sets）。聚合经 `advance_transition_function` 推进转移状态，`finalize_aggregate` 终结。

### DML 执行（ModifyTable）

`nodeModifyTable.c`（5978 行）。`ExecModifyTable`（L4635）：首次调 `fireBSTriggers`（BEFORE STATEMENT）→ 循环 `ExecProcNode(subplanstate)` 拉元组 → 按 operation 分发 → 子计划耗尽 `fireASTriggers`。

`ExecInsert`（L874）：分区路由 → `ExecMaterializeSlot` → `ExecBRInsertTriggers` → `ExecComputeStoredGenerated`（GENERATED 列）→ `table_tuple_insert`/FDW/批量 → `ExecInsertIndexTuples`（更新索引）→ `ExecARInsertTriggers`（AFTER 排队）→ `ExecProcessReturning`。

`ExecDelete`/`ExecUpdate` 用 **Prologue/Act/Epilogue 三段式**：BEFORE ROW 触发器 → `table_tuple_delete/update` 实际操作（处理 `TM_Result` 并发冲突）→ 索引更新 + AFTER ROW 排队。跨分区 update 触发 `ExecCrossPartitionUpdate`（先 DELETE 再 INSERT）。

触发器时序：BEFORE STATEMENT → BEFORE ROW → 实际操作 → AFTER ROW（排队）→ AFTER STATEMENT（`ExecutorFinish` 中 `AfterTriggerEndQuery` 触发）。

### 投影/选择下推

**选择下推**：`ExecScanExtended`（`execScan.h:160`）中 `if (qual == NULL || ExecQual(qual, econtext))`——qual 是 planner 下推到 scan 的过滤条件，扫描时立即过滤。

**投影**：`ProjectionInfo`（`execnodes.h:396`），planner 尽量使 scan targetlist 与上层一致（`ExecAssignScanProjectionInfo` 设 `ps_ProjInfo=NULL` 跳过投影），重要性能优化。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 迭代器（Volcano pull） | `ExecProcNode` | 自然背压，流水线化，LIMIT 提前终止 |
| 函数指针分发 | `node->ExecProcNode` | 避免 switch 开销，热路径优化 |
| 模板方法 | Init/Exec/ReScan/End 四方法 | 统一生命周期，Exec 路径极简 |
| 策略模式 | table AM 抽象 | 执行器不直接操作 heap，存储可插拔 |
| 钩子 | 四入口 hook | Citus/pg_shard 等扩展 |

### 为什么用 pull 模型而非向量化 push

pull 模型核心优势：自然背压（上层需要才拉，不物化整个结果集）、流水线化（NestLoop 拉到外表元组即扫内表输出）、内存效率（per-tuple context 每元组重置）、通用接口（统一 `TupleTableSlot*`）。PG 未选向量化因需重写整个执行器架构，且 tuple-at-a-time 与 SQL 语义（游标/LIMIT/嵌套子查询）天然契合；近年通过 batch 执行（`ExecBatchInsert`）部分弥补分析负载差距。

---

## 模块间交互

executor 调 `access`（`table_beginscan`/`table_tuple_insert` 等 AM 回调）、`storage`（buffer/lock）、`utils`（触发器 `commands/trigger.c`、约束检查、RI `utils/ri_triggers.c`、快照 `utils/snapmgr.c`）。被 tcop `PortalRun`→`PortalRunSelect` 调用。JIT（`es_jit_flags`）控制表达式 LLVM 编译。

---

## 扩展方式

**新增执行节点**（如 VectorScan）：新建 `nodeVectorScan.c` 实现 Init/Exec/ReScan/End → `execProcnode.c:142 ExecInitNode` 加 `case T_VectorScan` → `execProcnode.c:542 ExecEndNode` 加 case → `execAmi.c:77 ExecReScan` 加 case → `execnodes.h` 定义 `VectorScanState` → `plannodes.h` 定义 plan 节点 → optimizer 侧 `createplan.c` 生成该 plan。

**新增 Join 算法**（如 BloomFilterJoin）：参考 `nodeHashjoin.c` 状态机模式实现四方法 → `execProcnode.c`/`execAmi.c` 加 case → optimizer `joinpath.c` 加 path + `createplan.c` 生成 plan → `plannodes.h` 定义节点。

**修改投影逻辑**（向量化批量投影）：`execScan.h:160 ExecScanExtended` 加批量路径 → `nodeSeqscan.c:276-291` 变体选择加向量化变体 → `execnodes.h:396 ProjectionInfo` 加批量状态 → `execExpr.c ExecProject` 实现批量。
