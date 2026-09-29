---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "执行器"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "向量化执行"]
description: "TiDB 执行器解读：火山模型 + Chunk 列式批处理、executorBuilder 巨型分发、distsql 下推与 TiFlash MPP 路径"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/executor/` 把物理计划变成会跑的算子树。它承载 TiDB 执行模型的两条路线：**能下推的**（扫描、聚合、JOIN、TopN）编码成 coprocessor DAG 发给 TiKV/TiFlash；**推不动的**在 TiDB 本地以火山算子执行。执行模型是经典 Volcano 论文的变体——一次 `Next` 返回一批行（Chunk）而非单行，这是 TiDB 向量化执行的地基。模块总量巨大（`builder.go` 超 6 万行、`simple.go`/`show.go` 各 10 万+ 行），但骨架清晰：一个接口、一个分发器、一批算子。

## 模块架构

```
pkg/executor/
├── internal/exec/executor.go    # Executor 接口 + BaseExecutorV2（装饰器）
├── adapter.go                   # ExecStmt：compile 产物；recordSet 适配 RecordSet
├── compiler.go                  # Compiler.Compile：Preprocess→Optimize→组装 ExecStmt
├── builder.go                   # executorBuilder.build：~150 case 的 type switch
├── table_reader.go / index_merge_reader.go / point_get.go   # 数据源类算子
├── distsql.go                   # 与 distsql 层的胶水（结果包装）
├── select.go / insert.go / update.go / delete.go / write.go
├── mpp_gather.go                # TiFlash MPP 聚合入口
├── shuffle.go                   # ShuffleExec：分区表并行执行
└── internal/                    # join/ aggfuncs/ sortexec/ ... 本地实现算子
pkg/distsql/
├── request_builder.go           # RequestBuilder：组装 kv.Request（DAG pb + ranges）
└── select_result.go             # selectResult：流式解码 tipb.SelectResponse
```

## 调用链路

```
ExecStmt.Exec (adapter.go:587)
├─ buildExecutor (adapter.go:1493)
│   └─ executorBuilder.build (builder.go:193)      # ~150 case type switch，递归先建孩子
│       case *physicalop.PhysicalTableScan → buildTableReader (builder.go:3993)
│       case *physicalop.PhysicalSelection → buildSelection
│       └─ ...
├─ openExecutor (adapter.go:1532)
│   └─ TableReaderExecutor.Open (table_reader.go:232)
│       ├─ 下推子计划序列化进 dagPB（TiFlash 用 ConstructTreeBasedDistExec）
│       ├─ RequestBuilder.SetDAGRequest/SetKeyRanges/SetFromSessionVars
│       │      (distsql/request_builder.go:190/258/339)
│       └─ distsql.SelectWithRuntimeStats (distsql/distsql.go:163 → Select :59)
│           └─ dctx.Client.Send → coprocessor 请求 → *selectResult
└─ recordSet.Next (adapter.go:165)  ← session 层驱动整棵树迭代
    └─ TableReaderExecutor.Next (table_reader.go:356) → tableResultHandler.nextChunk
```

数据类型演变：`base.Plan` → `exec.Executor` 树 → `*chunk.Chunk`（批）→ `recordSet`（`sqlexec.RecordSet`）→ MySQL 行包。Executor 接口（`pkg/executor/internal/exec/executor.go:224`）：

```go
type Executor interface {
    NewChunk() *chunk.Chunk
    Open(context.Context) error
    Next(ctx context.Context, req *chunk.Chunk) error   // 一次返回一批行
    Close() error
    Schema() *expression.Schema
}
```

`exec.Open`/`exec.Next` 包装函数（executor.go:609/627）在真正调用算子前统一注入 RuntimeStats、SQL killer 检查等横切逻辑——装饰器模式让几十个算子不必各自重复这些代码。

## 核心实现

### Chunk：向量化执行的数据载体

`pkg/util/chunk/chunk.go:35` 的 `Chunk` = `sel []int`（选择向量）+ `columns []*Column`（每列一个固定宽度的 Go slice + null bitmap）。相对行式的三重收益：虚函数调用按 1024 行批摊薄；列内同类型连续存储（cache 友好、SIMD 可用）；`sel` 让 Selection 只记录选中行号而不物化拷贝。算子契约：`Next` 收到的 `req` 必须**先 `req.Reset()`** 再填充（executor.go:223 注释）——复用请求内的列内存。`required_rows` 机制（`chunk.SetRequiredRows` in chunk.go:214，消费见 `pkg/executor/distsql.go:1752`）让 Limit 类算子把精确需求行数下传，cop 请求配合 Limit 下推不多取数据。

### executorBuilder：编译期穷举的巨型 switch

`build` in `builder.go:193` 是 ~150 个 case 的 type switch，对孩子递归 `b.build(child)` 再构造自身。为什么不用注册表（map）？物理计划类型是封闭集合，switch 的编译期穷举让"新增算子忘挂 executor"在编译期就暴露，而 map 注册有注册时序、遗漏不可检的问题。代价是 `builder.go` 膨胀到 6 万+ 行——TiDB 团队接受了这个权衡。错误不走返回值而是 `b.err` 字段（builder.go:112），避免每层递归都判错。

### 下推边界与 TableReader 的两种身份

`TableReaderExecutor`（`table_reader.go:139`）既可能只做扫描（聚合/JOIN 都推下去了，dagPB 只剩 TableScan + 少量 Projection），也可能什么都不推（本地聚合）。下推深度由 planner 决定（表达式黑名单等），`kvRangeBuilder` 抽象为接口（table_reader.go:146-151 注释）因为 range 来源多样（点查、范围、分区、index merge）。一个精妙细节：`corColInFilter` 为真（相关子查询的列出现在过滤条件里）时，每次 `Open` 都要**重写 dagPB**（table_reader.go:248-262）——这是 Apply 类相关子查询与下推并存的机制。TiFlash/MPP 路径：`useMPPExecution`（`mpp_gather.go:37`，条件是 MPP 允许且计划顶层为 `PhysicalExchangeSender`）为真时改走 `buildMPPGather`（builder.go:3907），`GenerateRootMPPTasks` 切出 MPP 任务经 `mpp.ExecutorWithRetry` 派发，结果由 `distsql.GenSelectResultFromMPPResponse` 接收（distsql.go:43）——Exchange 算子承担了 TiFlash 侧的数据 Shuffle。

### 本地并行：Shuffle 与 required_rows

本地并行执行由 `ShuffleExec`（`shuffle.go:106`，builder.go:331 构建）承担：goroutine worker 池 + `shuffleOutput` channel，用于分区表并行聚合等场景；简单并行（如本地 HashAgg 内部）由算子自己起 worker。两个代表性的本地复杂算子值得一提：**IndexLookUp**（`pkg/executor/distsql.go`）是回表场景的双 worker 流水线——索引侧 worker 扫索引拿 handle，表侧 worker 按批量回表，keepOrder 时在表侧按 handle 列做归并排序保持顺序，`dummy` 标志代表临时表/缓存表不发请求的特殊分支；**HashJoinV2**（`pkg/executor/join/hash_join_v2.go`）把 build/probe 分到 `HashJoinCtxV2`（按 `RightAsBuildSide` 决定建哈希表的一侧），分区数必须取 2 的幂（`partitionNumber`，取模用位运算），数据超出内存配额时按分区逐轮 spill 磁盘（`initMaxSpillRound` 依分区数算最大轮次），重新读入后做 grace merge。加上 `Projection` 内 expression 求值的向量化批处理（见 [04-expression](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/04-expression)），TiDB 本地路径的并行度有三个来源：算子树天然可并行（不同孩子）、算子内部 worker、Chunk 批内 SIMD。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 迭代器（火山） | `Executor` 接口 in `internal/exec/executor.go:224` | pull-based 组合性：Limit/流式/EXPLAIN 随时截断 |
| Builder | `executorBuilder.build` in `builder.go:193` | 计划 → 算子的递归构造，编译期穷举 |
| 装饰器 | `exec.Open/exec.Next` 包装 in `executor.go:609/627` | RuntimeStats/kill 检查统一注入 |
| 适配器 | `recordSet` in `adapter.go:100` | 把 Executor 树适配成 session 需要的 `RecordSet` 接口 |

## 模块间交互

上游：`Compiler.Compile` in `compiler.go:50`（Preprocess → planner.Optimize → 组装 `ExecStmt`），即 planner 的物理计划经 `build` switch 进入。侧向：`EvaluatorSuite` 消费 expression（Projection/Selection 的过滤与投影）；虚拟列在 `table_reader.go:374` 经 `table.FillVirtualColumnValue` 补值。下游：`distsql.Select` → `kv.Client.Send`（接口），真实实现是 `pkg/store/copr`（见 [08-store](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/08-store)）。DDL/ANALYZE/Import 等语句的执行器也在此包（`ddl.go`/`analyze.go`/`import_into.go`），它们是"语句类型分发"的第二层：简单语句不走 planner 物理优化，直接在 `simple.go` 命令式实现。

## 扩展方式

新增一个内置算子（概览场景 1 的延伸）：planner 定义 PhysicalFoo → `builder.go` 的 `build` 加 case + `buildFoo` → 新文件嵌入 `exec.BaseExecutorV2` 实现 Open/Next/Close（Next 先 `req.Reset()`）→ 需下推则改 dagPB 编码（`ConstructListBasedDistExec`）+ TiKV/TiFlash 侧 → EXPLAIN 注册（`explain.go`）。若需被 plan cache 复用，还要实现 plan 的 `CloneForPlanCache`。
