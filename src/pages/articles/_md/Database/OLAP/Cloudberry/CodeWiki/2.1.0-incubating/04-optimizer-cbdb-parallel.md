---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "CBDB 并行查询机制"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C/C++", "MPP", "并行查询", "Locus"]
description: "CBDB 并行查询机制深度解读——所有 worker 平等协作、Locus 嵌入 parallel_workers、Gang 按因子扩展，以及放弃 PostgreSQL Gather leader 模式的三条原因。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回查询优化器](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer)

---

## 主题定位

Cloudberry 已经是一个 MPP 系统——segment 间并行由 Motion + interconnect 承担。那为什么还要在 segment 内做"节点内并行"？答案是现代多核服务器上单 segment 进程的 CPU/IO 没用满，一个 scan 在一个 segment 上只用单进程扫本地数据，浪费多核。PostgreSQL 上游用 **Gather/GatherMerge** 节点解决这个问题——leader 进程拉起若干 worker，各扫一部分数据再汇总。Cloudberry 原本可以照搬这套，但它没有，而是设计了自己的 **CBDB 风格并行查询**。这个深度文档讲清 CBDB 并行的核心机制——Locus 嵌入 `parallel_workers`、"所有 worker 平等"、Gang 按因子扩展——以及为什么放弃 PG Gather leader 模式的三条根本原因。设计依据是仓库内的 `src/backend/optimizer/README.cbdb.parallel`。

## 核心原理

### "所有 worker 平等"（All Workers Equal）

`README.cbdb.parallel` 开宗明义：PostgreSQL 的 Gather/GatherMerge 会"launch any number of workers to execute a plan as a leader process（PG style）"，而 **Apache Cloudberry doesn't have that——treats all workers equally**。CBDB 的 worker 像启动非并行计划一样启动，拥有完整的 QE（Query Executor）上下文，只是当顶层路径节点的 `parallel_workers > 1` 时按因子扩展 Gang 规模。worker 间用同步机制协作（如建共享哈希表），而非 leader 拉起 worker 的父子关系。一句话：**CBDB 不用 leader，所有 worker 是平等的 QE 进程**。

### Locus 嵌入 parallel_workers

Cloudberry 的并行度不只在 `Path.parallel_workers` 上，而是**嵌进 Locus 类型**里。`CdbPathLocus`（`src/include/cdb/cdbpathlocus.h:154`）有 `parallel_workers` 字段，`CdbPathLocus_NumSegmentsPlusParallelWorkers` 宏（`:173`）算总进程数 `numsegments * parallel_workers`。新增了几种并行 Locus 类型：

| LocusType | 含义 |
|-----------|------|
| `CdbLocusType_Hashed` | hash 分布在所有 segment（无节点内并行） |
| **`CdbLocusType_HashedWorkers`** | hash 分布在 segment，但每个 segment 的 M 个 worker 间再分区 |
| **`CdbLocusType_SegmentGeneralWorkers`** | 所有 QE 可用但 worker 间散布 |
| **`CdbLocusType_ReplicatedWorkers`** | 副本到 segment，worker 间散布 |

`cdbpathlocus_from_policy`（`cdbpathlocus.c:323`）由分布策略 + `parallel_workers` 设类型：`Hashed 分布 & parallel_workers > 1` → `CdbPathLocus_MakeHashedWorkers`（`:348`）；`Replicated & parallel_workers > 1` → `CdbPathLocus_MakeSegmentGeneralWorkers`（`:371`）；`parallel_workers <= 1` → 普通 `Hashed`/`SegmentGeneral`。关键设计：`cdbpathlocus.c:100-102` 注释强调 **"HashedWorkers will never be equal"**——两个 `HashedWorkers` locus 永不判等，强制走 Motion 协调。这把"每个 worker 只持部分数据"这一事实编码进类型系统，避免错误地认为两个 worker 的数据等价。

### Gang 按因子扩展

README 原文："CBDB style launches workers as non-parallel plan except that **expand Gang size by factor** if a top path node has `parallel_workers > 1`"。总进程数 = `numsegments * parallel_workers`（`CdbPathLocus_NumSegmentsPlusParallelWorkers` 宏）。以 README 例子：`t1(parallel_workers=3)` 在 3 segments 上 → 9 个 worker 进程，`t2(parallel_workers=2)` → 6 个，Gather Motion 6:1 汇聚 6 个 worker 结果。worker 是平等的 QE，每个持完整分布式事务/快照/角色上下文。

## 实现细节

### parallel_workers 如何计算

`compute_parallel_worker`（`src/backend/optimizer/path/allpaths.c:4696`）算每个 base rel 的并行度：优先用表的 `rel_parallel_workers` reloption；否则 heap 按 pages 对数算；**AO/AOCO 表按 `pg_appendonly.segfilecount` 算**（`:4710-4737`）——这是 Cloudberry 特有逻辑，AO 表的 segment 文件数比 heap 的 page 数更能反映并行潜力。`create_plain_partial_paths`（`allpaths.c:1083`）在 `compute_parallel_worker > 1` 时 `add_partial_path` 加并行 seqscan；`create_seqscan_path`（`pathnode.c:1026`）把 `parallel_workers` 存进 Path 并经 `cdbpathlocus_from_baserel` 设 Locus。

### 并行 join 的 Motion 协调

当 join 两侧 `parallel_workers` 不同时，需要 Redistribute Motion 使数据匹配。`cdbpath_motion_for_parallel_join`（`src/backend/cdb/cdbpath.c:2978`）处理并行 join 的 Motion 添加——被 `pathnode.c:3910` 等三处 join 路径创建函数调用：

```c title="src/backend/optimizer/util/pathnode.c"
bool isParallel = (outer_path->locus.parallel_workers > 1 ||
                   inner_path->locus.parallel_workers > 1);
if (!isParallel)
    join_locus = cdbpath_motion_for_join(...);          // 非并行
else
    join_locus = cdbpath_motion_for_parallel_join(...); // 并行
```

内部（`cdbpath.c:2978-3903`）根据两侧 Locus 类型决定 Motion 策略，调 `cdbpathlocus_parallel_join`（`cdbpathlocus.c:1227`）算 join locus——两侧 `parallel_workers` 不同时插入 Redistribute 使数据匹配（如 README 例中的 `Redistribute Motion 9:6`）。

### 关掉 PG 风格 Gather 路径生成

CBDB 在代码上明确关闭了 PG 风格的 Gather 路径生成：

```c title="src/backend/optimizer/plan/planner.c"
/* GPDB parallel: Unlike upstream, partial_path is valid in GP without Gather nodes. */
if (final_rel->partial_pathlist != NIL)              // L611-625
{
    Path *cheapest_partial_path = linitial(final_rel->partial_pathlist);
    add_path(final_rel, cheapest_partial_path, root);
    set_cheapest(final_rel);
}
...
// L9167:  gather_grouping_paths 被 Assert(false) 禁用
// L9363:  generate_useful_gather_paths 被 #if 0 包裹
```

这让 partial_pathlist 保留到最终阶段才与 pathlist 合并选最优，而非 PG 在 `apply_scanjoin_target_to_paths` 就清空它——partial path 能在后续 join 中作为 parallel_aware hash join 的 outer。

## 性能与权衡

### 为什么不用 PG Gather leader 模式——三条根本原因

`README.cbdb.parallel` 给出三条原因，每条都有代码佐证：

**原因 1：分布式事务/快照/QE 角色信息缺失。** PG 的 Gather 启动的 worker 进程没有 GP 的 QE 上下文（分布式事务号、分布式快照、GP 角色等）。混用的话 Gather 启动的 worker 和正常 QE 进程"don't know each other"，分布式一致性无法保证。CBDB 的方式是让所有 worker 都作为正常 QE 启动、拥有完整上下文。代码佐证：`planner.c:595-602` 注释 "Unlike upstream, partial_path is valid in GP without Gather nodes"。

**原因 2：Locus 复杂性。** Gather 节点的 locus 可能与子节点不同——一个并行 scan 在 hash 分布表上的数据，作为整体是 `Hashed` locus，但每个 worker 只持部分数据是 `HashedWorkers` locus。PG 的 Gather 会把 `HashedWorkers` 收集为 `Hashed`，但当它与不同 locus join 或下面有 Motion 时变得极其复杂。CBDB 直接用 `HashedWorkers` 等 Locus 类型在类型系统层面表达这种分布，无需 Gather 转换。代码佐证：`cdbpathlocus.c:100-102` "HashedWorkers will never be equal"——强制走 Motion 协调，避免数据错配。

**原因 3：尽量晚 Gather（deferred gathering）。** CBDB 能尽量晚地并行化计划，直到最终的 Gather（到 QD 或中间到 QE）。但 PG 风格会在 `apply_scanjoin_target_to_path` 就 Gather worker——这会清空 `partial_pathlist`（`planner.c:8629`），导致 partial path 无法在后续 join 中作为 parallel_aware hash join 的 outer，丧失了晚 Gather 的优化空间。代码佐证：PG 风格 `generate_useful_gather_paths` 被 `#if 0`（`planner.c:8623-8626`）、`gather_grouping_paths` 被 `Assert(false)`（`:8436`）；CBDB 保留 partial_pathlist 到最终（`:603-609`）。

### 与 ORCA 的关系

CBDB 并行是 **PG planner 路径内**的逻辑。ORCA 是独立的 C++ 优化器（`orca.c:202` 的 `optimize_query`），与 PG planner 互斥选择（`planner.c:386-432`：先试 ORCA，失败 fallback PG planner）。ORCA 有自己的并行计划生成能力（如 `CPhysicalMotionGather` 等物理算子，走 distribution 属性的 enforcer），不依赖 CBDB 的 Locus/`parallel_workers` 机制——两套并行实现完全独立。

### 双层并行的统一

CBDB 并行（节点间）与 PG 风格 Gather（节点内）并非互斥——[执行引擎](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/05-executor) 的 `ExecutePlan` 用 `GpInsertParallelDSMHash`（`execMain.c:2754`）让 Gather/GatherMerge 节点能在 MPP slice 内部用 PG 风格的 parallel worker，形成**双层并行**：MPP 级（segment 间）用 Motion+interconnect，segment 内用 Gather+worker。注释明确："CBDB style parallelism won't interfere PG style parallel mechanism"（`execMain.c:2749-2751`）。这是 Cloudberry 在"要不要 PG Gather"上做的务实折中——节点间不用 Gather leader（用 CBDB 平等 worker），但节点内若需要仍可用 PG 风格 Gather，两者分层叠加互不干扰。

> README 末尾坦诚承认："The reasons we choose CBDB style but not PG style or mix them is complex. We encounter lots of problems when mixing them together and we don't have enough time to enable both and don't know how much the benefit we could have."——这是工程现实下的权衡，而非理论最优。
