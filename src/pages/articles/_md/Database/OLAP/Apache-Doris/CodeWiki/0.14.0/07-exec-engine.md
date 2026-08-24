---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "执行引擎"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "exec", "Volcano", "ExecNode", "RowBatch", "行式执行"]
description: "Doris 0.14.0 执行引擎：ExecNode Volcano pull 行式执行（open/get_next/close）、create_node 纯 switch 工厂（无 enable_vectorized 分支）、RowBatch 行式、PlanFragmentExecutor。0.x 唯一执行路径，纯 Impala 血统。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块是 `be/src/exec/`（~3.8 万行，173 文件），是 0.14.0 的**唯一执行引擎**。用 `ExecNode` 的经典 Volcano 拉模型（`open/get_next/close`），按 `RowBatch` 行式处理。**0.14.0 没有 `vec/` 目录、没有向量化执行、没有 Pipeline 引擎**——`ExecNode::create_node`（`exec_node.cpp:329`）是纯 switch，每个 case 直接实例化具体节点，没有 `enable_vectorized_exec()` 二选一分支。这是 0.14.0 与 1.x/2.x 最本质的差异：纯 Impala 血统、纯行式。向量化栈（源自 ClickHouse）是 1.x 才集成，Pipeline 是 2.x 才引入。

## 模块架构

```
PlanFragmentExecutor (runtime/plan_fragment_executor.cpp)
   ├─ prepare() (:71)  ── 装配 RuntimeState + ExecNode 树
   ├─ open() (:236) / open_internal() (:266)
   └─ get_next(RowBatch**) (:450) / get_next_internal() (:467)  ── Volcano pull 主循环
        │
        ▼
ExecNode (exec/exec_node.h:60) ── 算子基类（行式 Volcano）
   ├─ init/prepare/open/get_next(reset/close                (:70/79/84/99/114/131)
   ├─ get_next(RowBatch*, bool* eos) = 0  ── 纯虚拉模型     (:99)
   ├─ _children (:273)  ── 计划树子节点
   ├─ eval_conjuncts() (:160)  ── 谓词求值
   ├─ create_tree() (:136)  ── 从 TPlan DFS 建树
   └─ create_node() (:330)  ── 工厂（纯 switch，无向量化分支）

算子族（exec_node.cpp:329 create_node switch）:
   ├─ Scan:   OlapScanNode / BrokerScanNode / MysqlScanNode / OdbcScanNode / EsScanNode / SchemaScanNode / CSV_SCAN_NODE
   ├─ Join:  HashJoinNode (:48) / CrossJoinNode / MergeJoinNode
   ├─ Agg:   AggregationNode (:52)（本地+全局两阶段）
   ├─ Sort:  SortNode / AnalyticEvalNode
   ├─ Set:  UnionNode / IntersectNode / ExceptNode / MergeNode
   ├─ 其它: ExchangeNode (:43) / SelectNode / EmptySetNode / OlapRewriteNode / RepeatNode / AssertNumRowsNode
   （无 vec::V*Node —— 0.14.0 不存在向量化算子）
```

## 调用链路

```
BE brpc PInternalServiceImpl::exec_plan_fragment
  → FragmentMgr::exec_plan_fragment()                          [runtime/fragment_mgr.cpp:445]
  → FragmentExecState::execute()                               [:214]
  → PlanFragmentExecutor::prepare()                            [runtime/plan_fragment_executor.cpp:71]
       ├─ RuntimeState 装配
       └─ ExecNode::create_tree()                              [exec/exec_node.cpp:261]
            └─ create_tree_helper() (:280) DFS 建树
                 └─ create_node() (:329) 按 TPlanNodeType switch 实例化
                      case OLAP_SCAN_NODE (:363) → new OlapScanNode(...)
                      case HASH_JOIN_NODE (:374) → new HashJoinNode(...)
                      ... （无 enable_vectorized_exec() 分支）
  → PlanFragmentExecutor::open() (:236)
  → 循环 get_next(&row_batch) (:450)                            ── Volcano pull 递归拉取 RowBatch
       └─ root→get_next() 调子节点 get_next()，递归到底 OlapScanNode
            → TabletReader 读 Tablet 的 Rowset/Segment 按列存 Page 解码
  → close()
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `FragmentMgr::exec_plan_fragment`（`fragment_mgr.cpp:445`） | fragment 执行入口 | 包装回调，提交线程池 |
| `PlanFragmentExecutor::prepare`（`:71`） | 装配 | RuntimeState + `ExecNode::create_tree` |
| `ExecNode::create_tree`（`exec_node.cpp:261`） | 建算子树 | DFS，`create_tree_helper`（`:280`） |
| `ExecNode::create_node`（`:329`） | 算子工厂 | **纯 switch，无 `enable_vectorized` 分支**（0.14.0 特征） |
| `ExecNode::get_next`（`exec_node.h:99`） | 拉模型核心 | 纯虚，子类实现，按 `RowBatch` 行式 |
| `PlanFragmentExecutor::get_next`（`:450`） | 主循环 | Volcano pull 递归 |

</details>

## 核心实现

### Volcano 拉模型：open/get_next/close

`ExecNode`（`exec/exec_node.h:60`）是 0.14.0 所有算子的基类，定义经典 Volcano 拉模型骨架：`prepare()`（`:79`）初始化、`open()`（`:84`）启动、`get_next(RowBatch*, bool* eos)`（`:99`，**纯虚**）拉取一批行、`close()`（`:131`）释放。子树通过 `_children`（`:273`）组织，`get_next` 递归调子节点的 `get_next` 拉数据——上游算子"拉"下游算子，数据按 `RowBatch`（`runtime/row_batch.h:74`，`public RowBatchInterface`）行式流动。`eval_conjuncts()`（`:160`）做谓词过滤。这是 Impala 血统的执行模型，1.x 在其上叠加向量化双轨、2.x 重写为 Pipeline。

### create_node 纯 switch：0.14.0 的指纹

`ExecNode::create_node`（`exec/exec_node.cpp:329`）是识别 0.14.0 的指纹——它是一个**纯 switch**，每个 `case TPlanNodeType::XXX_NODE:` 直接 `*node = new XxxNode(...)` 实例化具体节点，**没有 `if (state->enable_vectorized_exec())` 二选一分支**。对比 1.x，同样的工厂每个 case 内会 `if (enable_vectorized_exec())` 选 `vec::V*Node`（Block 列存）或 legacy 节点（RowBatch 行式）。0.14.0 不存在 `vec/` 目录，因此没有向量化分支——`OLAP_SCAN_NODE`（`:363`）直接 `new OlapScanNode`，`HASH_JOIN_NODE`（`:374`）直接 `new HashJoinNode`。算子族覆盖 Scan（`OlapScanNode`/`BrokerScanNode`/`MysqlScanNode`/`OdbcScanNode`/`EsScanNode`/`SchemaScanNode`）、Join（`HashJoinNode`/`CrossJoinNode`/`MergeJoinNode`）、Agg（`AggregationNode`）、Sort（`SortNode`/`AnalyticEvalNode`）、Set（`UnionNode`/`IntersectNode`/`ExceptNode`/`MergeNode`）等。0.14.0 还有独特的 `OLAP_REWRITE_NODE`（`:398`）。

### PlanFragmentExecutor：装配与主循环

`PlanFragmentExecutor`（`runtime/plan_fragment_executor.cpp`）是单个 fragment 的执行器：`prepare()`（`:71`）装配 `RuntimeState` 并调 `ExecNode::create_tree`（`exec_node.cpp:261`）从 Thrift `TPlan` DFS 建算子树（`create_tree_helper` at `:280` 递归，每层调 `create_node` at `:329` 实例化）；`open()`（`:236`）/`open_internal()`（`:266`）启动；主循环 `get_next(&row_batch)`（`:450`）/`get_next_internal`（`:467`）反复 Volcano pull 直到 eos。`FragmentMgr::exec_plan_fragment`（`fragment_mgr.cpp:445`）是入口，建 `FragmentExecState`（`:execute` at `:214`）并提交线程池。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `ExecNode::open/get_next/close`（`exec_node.h:84/99/131`） | 基类骨架，子类覆盖 `get_next` |
| 工厂方法 | `create_node`（`exec_node.cpp:329`） | 按 `TPlanNodeType` 实例化（纯 switch，0.14.0 无向量化分支） |
| 组合 | `_children`（`:273`） | 计划树递归结构 |
| 迭代器（拉模型） | `get_next(RowBatch*, bool* eos)`（`:99`） | Volcano pull，上游拉下游 |

## 模块间交互

`exec` 上游接 `runtime`（`PlanFragmentExecutor`/`FragmentMgr`/`RuntimeState`/`RowBatch`/`MemTracker`），下游接 `olap`（`OlapScanNode` 经 `TabletReader` 读 Rowset/Segment）与 `exprs`（`eval_conjuncts` 调 `Expr` 求值）。`OlapTableSink`（写路径）也在此模块，向 `olap.DeltaWriter` 写数据。**0.14.0 不与 `vec/` 交互——该目录不存在。**

## 扩展方式

新增算子：在 `be/src/exec/` 加 `XxxNode.h/cpp` 继承 `ExecNode` 实现 `get_next`（`exec_node.h:99`）；在 `exec_node.cpp:329` 的 `create_node` switch 加 `case TPlanNodeType::XXX_NODE:` 直接 `new XxxNode`（0.14.0 无需二选一）；在 `gensrc/thrift/PlanNodes.thrift` 的 `TPlanNodeType` 枚举加值；FE 侧 `planner` 加构建逻辑。这是 0.14.0 与 1.x 扩展方式的差异点——1.x 还要同时实现 `vec::V*Node` 向量化版并在工厂白名单登记。
