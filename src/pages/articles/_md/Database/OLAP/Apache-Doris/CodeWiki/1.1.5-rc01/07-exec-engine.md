---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "执行引擎"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "exec", "ExecNode", "Volcano", "RowBatch", "OlapScanNode", "HashJoin"]
description: "Doris 1.1.5 执行引擎 exec：ExecNode Volcano pull 模型（open/get_next/close）、按 RowBatch 行式、OlapScanNode scanner 线程池生产者-消费者、HashJoin/PartitionedAggregation。1.x 无 Pipeline。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

`be/src/exec/`（~3.8 万行）是 1.1.5 的 **legacy 行式执行引擎**，基于 `ExecNode` 的 Volcano pull 模型（`open/get_next/close`），按 `RowBatch` 行式处理。1.1.5 **无 Pipeline 引擎**（2.x 才引入拉模型 Pipeline）。与 `vec/exec/` 的向量化版本并存（双轨），由 `enable_vectorized_exec()` 在工厂 `create_node` 中二选一。血缘上继承自 Impala 的行式执行设计。

## 模块架构

```
ExecNode (exec/exec_node.h:66) ── 抽象基类，Volcano pull 接口
   ├─ init (:76) / prepare (:85) / open (:90)
   ├─ get_next(RowBatch*) (:105)  ── legacy 行式（默认返回 NotSupported, 强制子类覆盖）
   ├─ get_next(Block*) (:106)      ── 向量化重载
   ├─ reset (:121) / collect_query_statistics (:126) / close (:138)
   ├─ _children (vector<ExecNode*>)  ── 子节点树
   ├─ _conjunct_ctxs (谓词) / _limit / _num_rows_returned
   └─ create_tree (:143) / create_node (:343)  ── 工厂: switch TPlanNodeType, 每 case 内 enable_vectorized_exec() 二选一
       │
       ▼  典型子类（legacy 行式）
   ScanNode (exec/scan_node.h:68) extends ExecNode ── set_scan_ranges pure virtual
   ├─ OlapScanNode (olap_scan_node.h:50) ── Doris 表扫描
   │    ├─ get_next (:56) / start_scan_thread / transfer_thread / scanner_thread
   │    ├─ _materialized_row_batches (队列, 消费者拉) / _scan_row_batches (scanner 产)
   │    ├─ _olap_scanners / _column_value_ranges (谓词下推) / _scan_keys
   │    └─ scanner 线程池 + condition variable 背压
   ├─ HashJoinNode (hash_join_node.h:49) extends ExecNode ── 内存 Hash Join
   │    ├─ construct_hash_table (:173) / process_probe_batch (:753)
   │    ├─ _hash_tbl / _join_op / _probe_expr_ctxs/_build_expr_ctxs/_other_join_conjunct_ctxs
   │    └─ _match_all_probe / _build_unique
   ├─ BlockingJoinNode (blocking_join_node.h:36) ── 阻塞 Join 基类 (CrossJoin 父)
   │    └─ open 异步 construct_build_side + open 左子树
   ├─ PartitionedAggregationNode (partitioned_aggregation_node.h:118) ── 分区聚合+spill
   │    ├─ PARTITION_FANOUT=16 / MAX_PARTITION_DEPTH=16
   │    ├─ agg_fns_ / is_streaming_preagg_ / needs_finalize_
   │    └─ 支持 spill to disk + streaming preaggregation
   └─ SelectNode (select_node.cpp:28) ── child get_next → eval_conjuncts 过滤
```

## 调用链路

```
FE 下发 TExecPlanFragment (Thrift/brpc)
  → PlanFragmentExecutor::open() (runtime/plan_fragment_executor.cpp:237)
    → DescriptorTbl::create → ExecNode::create_tree (exec_node.cpp:282)
      → create_tree_helper 深度优先 → create_node (:343) switch TPlanNodeType:
          OLAP_SCAN_NODE → new OlapScanNode (或 vec::VOlapScanNode 若 enable_vectorized_exec)
          HASH_JOIN_NODE → new HashJoinNode (或 vec::HashJoinNode)
          AGGREGATION_NODE → new PartitionedAggregationNode
          ... (每 case 内 if(state->enable_vectorized_exec()) 二选一)
        → node->init(tnode, state) → 递归 children
    → _plan->prepare (exec_node.cpp:221): ExecNode::prepare (MemTracker/RuntimeProfile) 递归 children
    → scan_node->set_scan_ranges
    → _plan->open (exec_node.cpp:240): ExecNode::open 递归 children (HashJoin 异步 build)
  → PlanFragmentExecutor::get_next_internal (:582)
    → 循环: _plan->get_next(state, _row_batch, &_done) ── 拉取一个 RowBatch
      OlapScanNode::get_next: 从 _materialized_row_batches 队列取 (scanner 线程异步产)
      HashJoinNode::get_next: child(0)->get_next 拉 probe batch → hash 表查匹配
      PartitionedAggregationNode::get_next: child(0)->get_next → 聚合 → 输出
      SelectNode::get_next: child(0)->get_next → eval_conjuncts 过滤
    → _plan->close (exec_node.cpp:258) 递归 children
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `ExecNode.create_node` | 工厂建节点 | switch TPlanNodeType + enable_vectorized_exec 二选一 |
| `ExecNode.get_next` | pull 拉数据 | Volcano 模型，递归调子节点 |
| `OlapScanNode.scanner_thread` | 异步 scan | 线程池生产 RowBatch 入队列 |
| `OlapScanNode.get_next` | 消费 batch | 从队列取，condition variable 背压 |
| `HashJoinNode.construct_hash_table` | build hash 表 | open 时异步构建 |
| `PartitionedAggregationNode` | 分区聚合 | 16 fanout + spill + streaming preagg |

</details>

## 核心实现

### Volcano pull 模型

`ExecNode::get_next()`（`exec_node.h:105`）被父节点拉取，形成自顶向下调用链，根节点 `get_next` 递归调子节点，数据自底向上流。**优点**：接口统一（`open→get_next→close` 三段式）、自然表达算子树、流式内存可控（每次一个 RowBatch）。**缺点**：每次 `get_next` 跨整树深度虚函数开销大、无法跨算子流水线并行、逐行处理 cache 局部性差、无背压（pull 下消费者无法控生产者速率，`OlapScanNode` 需自用队列+CV 实现背压，`olap_scan_node.h:219`）。

### 按 RowBatch 行式

`RowBatch`（`runtime/row_batch.h:74`）内是 `TupleRow*` 指针数组，`get_next(RowBatch*)`（`:105`）按行处理，`eval_conjuncts()`（`exec_node.cpp:167`）逐行求值谓词。**为什么按行**：继承 Impala 行式引擎，Tuple/TupleRow 指针间接层适配行式，对点查简单过滤足够，实现简单。**缺点**：无法 SIMD、逐行虚函数开销大、cache miss（TupleRow 指针间接）。

### 与 vec/exec/ 双轨选择

`create_node`（`exec_node.cpp:343`）每个 case 内 `if (state->enable_vectorized_exec())` 二选一 legacy 节点或 `vec::V*Node`。`RuntimeState::enable_vectorized_exec()`（`runtime_state.h:338`）读 `_query_options.enable_vectorized_engine`（FE `Coordinator.java:316` 经 `VectorizedUtil.isVectorized()` 写入）。`ExecNode::init` 据 flag 设 RuntimeProfile 名前缀 "V"（`:156`）。**并非所有节点都有 vec 版**——`ES_SCAN_NODE`/`BROKER_SCAN_NODE`/`MERGE_NODE` 在向量化模式无实现报 `"V"+str+" not implemented"`（`:362`）。

### 为什么 1.x 还没上 Pipeline

1.x 从 Impala 继承完整行式引擎，向量化本身仍在逐步覆盖节点类型；Pipeline 需重设整个执行调度模型（`get_next` 拉模型→push-based Operator/Pipeline），工程量大，2.x 才完成。1.x 性能优化重心在向量化（直接提单算子吞吐），`OlapScanNode` 已用 scanner 线程池+队列（`:219`）实现生产者-消费者解耦部分弥补 pull 并行缺陷，但仅限 scan 节点，其他算子（HashJoin）仍同步阻塞。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `ExecNode::init/prepare/open/get_next/close` in `exec_node.h:76-138` | 基类骨架，子类覆盖 `get_next` |
| 工厂方法 | `ExecNode::create_node` switch in `exec_node.cpp:343` | 按 TPlanNodeType + enable_vectorized 二选一 |
| 组合 | `_children` + `create_tree_helper` in `exec_node.h:286, exec_node.cpp:310` | Plan 树递归构建 |
| 策略 | `enable_vectorized_exec()` 分支 in `exec_node.cpp:343` | 同一 node type 选 legacy 或 vec 实现 |
| 生产者-消费者 | `OlapScanNode._materialized_row_batches` + `scanner_thread` in `:219, :1542` | scanner 异步产 RowBatch，get_next 消费，CV 同步 |

## 模块间交互

依赖 `runtime`（RuntimeState 取消检查/mem_tracker/batch_size、`RowBatch` in `row_batch.h:74`、DescriptorTbl）、`exprs`（ExprContext/Expr `eval_conjuncts` 逐行求值、IRuntimeFilter）、`olap`（OlapScanner 读 tablet、ColumnValueRange 谓词下推）。被 `runtime/plan_fragment_executor.cpp` 驱动，由 Coordinator 经 Thrift 下发。

## 扩展方式

**新增 ExecNode 类型**（如 WindowFunctionNode）：建 `exec/window_function_node.h/cpp` 继承 `ExecNode` 实现 `get_next(RowBatch*)`；`gensrc/thrift/PlanNodes.thrift` `TPlanNodeType` 加值；`exec_node.cpp:343` `create_node` switch 加 case（向量化须同时加 `vec::VWindowFunctionNode` + 白名单）；`be/src/exec/CMakeLists.txt` 加源文件。**修改 OlapScanNode 背压**：`olap_scan_node.cpp` `get_next`（`:261`）与 `add_one_batch`（`:1717`）的 CV 等待逻辑，改 `_max_materialized_row_batches`（`:234`）判断为基于内存字节数。**HashJoin 支持 grace spill**：`hash_join_node.cpp` `construct_hash_table`（`:173`）+`process_build_batch`（`:753`）加分区 spill 逻辑，参考 `PartitionedAggregationNode`（`partitioned_aggregation_node.h:44`）已实现的 spill。
