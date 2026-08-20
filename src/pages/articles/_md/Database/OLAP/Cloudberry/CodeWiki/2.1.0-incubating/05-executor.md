---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "执行引擎"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C/C++", "MPP", "Volcano", "Motion"]
description: "Cloudberry executor 模块——Volcano 迭代 pull 模型驱动 Plan 树，Motion/Gather/Split 算子把网络 I/O 与分布式更新隐藏在迭代器背后。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/00-overview)

---

## 模块定位

`src/backend/executor/` 是查询执行引擎，用 PostgreSQL 的 **Volcano 迭代 pull 模型**驱动优化器产出的 Plan 树：上层算子需要数据时才向下 `ExecProcNode` 拉取一个 tuple，递归驱动整棵树。Cloudberry 在这个标准模型上叠加了一组分布式算子——**Motion**（跨 segment 数据重分布）、**Gather/GatherMerge**（CBDB 双层并行的 segment 内 worker 协作）、**Sequence**（顺序执行子计划）、**SplitUpdate/SplitMerge/TupleSplit**（分布式更新/合并的拆分）。它的核心价值是把"网络收发""行迁移"这些分布式细节**完全封装在标准 Volcano 算子里**，上层算子不需要知道数据来自本地扫描还是远端 segment。

## 模块架构

```text
execMain.c                        执行器主框架（四阶段）
  ExecutorStart → ExecutorRun → ExecutorFinish → ExecutorEnd
       │              │                              │
       │              │                              └─ ExecEndNode ── 递归清理
       │              └─ ExecutePlan ── for(;;) ExecProcNode(planstate)  拉取 tuple
       └─ InitPlan ── ExecInitNode ── switch(nodeTag) ── 按 Plan 创建 PlanState
                                                                          │
execProcnode.c                    节点分发 + 迭代回调                          │
  ExecProcNode(node)  inline ── node->ExecProcNode(node)  函数指针多态 ◄──────┘
       └─ ExecProcNodeFirst → ExecProcNodeGPDB → node->ExecProcNodeReal
            (栈深度检查)    (instrument/squelch/QueryFinish)  (真正算子逻辑)

分布式算子（各自一个 nodeXxx.c + XxxState）
  nodeMotion.c      MotionState    ── sender(发)/receiver(收) via interconnect
  nodeGather.c      GatherState    ── segment内 parallel worker + leader 参与
  nodeGatherMerge.c               ── 有序归并的 parallel worker
  nodeSequence.c                  ── 顺序执行子计划
  nodeSplitUpdate.c               ── UPDATE 拆 DELETE+INSERT（分布键变→迁移）
  nodeSplitMerge.c                ── MERGE 拆分
  nodeTupleSplit.c                ── Distinct 聚合拆分
```

执行器分三层：**主框架 `execMain.c`** 管 `ExecutorStart/Run/End` 三阶段与 `InitPlan`（把 Plan 树变 PlanState 树）；**节点分发 `execProcnode.c`** 用函数指针实现多态，`ExecProcNode` inline 调用 `node->ExecProcNode`；**各算子 `nodeXxx.c`** 实现各自的 `ExecInitXxx`（建 state、注册回调）/`ExecXxx`（pull 逻辑）/`ExecEndXxx`（清理）三件套。`EState` 持有 `motionlayer_context` 和 `interconnect_context` 两个上下文，是 Motion 算子与 `cdb` 模块交互的桥梁。

## 调用链路

### 执行器主流程

```text
ExecutorStart(queryDesc, eflags) in execMain.c:229
  └─ standard_ExecutorStart() in execMain.c:246
       ├─ CreateExecutorState() ── 构建 EState  in :350
       ├─ InitSliceTable(estate, plannedstmt) in :454   (QD 构建 slice 表)
       ├─ createMotionLayerState() in :476              (有 Motion 时建 motion layer)
       ├─ SetupInterconnect(estate) in :535             (QE 建立 interconnect)
       ├─ InitPlan(queryDesc, eflags) in :584
       │    └─ ExecInitNode(start_plan_node) in execProcnode.c:190
       │         └─ switch(nodeTag): T_Motion→ExecInitMotion / T_Gather→ExecInitGather / ...
       └─ CdbDispatchPlan(queryDesc, ...) in :697      (QD 分发 Plan 到 QE)

ExecutorRun(queryDesc, ...) in execMain.c:821
  └─ standard_ExecutorRun() in :857
       ├─ getGpExecIdentity() ── GP_IGNORE / GP_NON_ROOT_ON_QE / GP_ROOT_SLICE  in :960
       └─ ExecutePlan() in :983/1037
            └─ for(;;) { slot = ExecProcNode(planstate); } in :2891   拉取 tuple
                 └─ node->ExecProcNode(node) in executor.h:278
                      └─ ExecProcNodeFirst → ExecProcNodeGPDB → ExecProcNodeReal
                           └─ ExecMotion / ExecGather / ExecSeqScan / ...

ExecutorEnd(queryDesc) in execMain.c:1232
  └─ standard_ExecutorEnd() in :1248
       ├─ cdbexplain_sendExecStats() in :1298   (QE 回传统计)
       ├─ mppExecutorFinishup() in :1306        (清理 MPP 资源)
       ├─ RemoveMotionLayer() in :1318
       └─ ExecEndNode(planstate) in execProcnode.c:791  (递归 ExecEndMotion/ExecEndGather/...)
```

关键细节：QE 上非 root slice 的执行从 Plan 树中某个 **Sending Motion 节点处"切入"**而非从 root 进入（`execMain.c:953-982`，`execMain.c:611` 的 `getMotionState()` 定位切入点），因为 QE 的顶层节点是 sender Motion，tuple 通过 interconnect 发出而非本地返回。

### Motion 算子收发流程

```text
ExecMotion(node) in nodeMotion.c:100        按 mstype 分发
  ├─ MOTIONSTATE_SEND → execMotionSender() in :202
  │    └─ while(!done):
  │         outerTupleSlot = ExecProcNode(outerNode)   从子计划 pull tuple
  │         ├─ NULL → doSendEndOfStream()  in :1143   发 EOS 标记
  │         └─ 非空 → doSendTuple() in :1181           按 Motion 类型路由后 SendTuple
  │              ├─ MOTIONTYPE_GATHER         → targetRoute=0
  │              ├─ MOTIONTYPE_BROADCAST      → targetRoute=BROADCAST_SEGIDX
  │              ├─ MOTIONTYPE_HASH (Redistribute) → evalHashKey()→segIdx
  │              │    parallel_workers>=2 再 hash 到 worker 级 → segIdx*pw+workerIdx  in :1265-1298
  │              └─ MOTIONTYPE_EXPLICIT       → 从 tuple 列读 segidColIdx  in :1299-1309
  │              └─ SendTuple(motionlayer_ctx, interconnect_ctx, motionID, slot, targetRoute) in :1319
  │              └─ stopRequested? → ExecSquelchNode(outerNode) 向下传播反压
  │    return NULL   (sender 永远返回 NULL，tuple 走网络)
  └─ MOTIONSTATE_RECV → execMotionUnsortedReceiver() in :306  / execMotionSortedReceiver() in :432
       └─ tuple = RecvTupleFrom(motionlayer_ctx, interconnect_ctx, motionID, route) in :356
            ├─ sorted: binary heap 归并（每 sender 拉一个入堆，取堆顶后补位）in :493-575
            └─ ExecStoreMinimalTuple(tuple, slot)
            return slot   (对父节点，Motion receiver 像普通数据源)
```

Motion 收发协议：sender 侧 `SendTuple` → interconnect → receiver 侧 `RecvTupleFrom`；控制消息有 `SendEndOfStream`（流结束）、`SendStopMessage`（接收方主动停止，反压传播）。`mstype` 在 `ExecInitMotion`（`nodeMotion.c:666-760`）按 `LocallyExecutingSliceIndex` 匹配 send/recv slice 决定。

### Gather：CBDB 双层并行

`ExecGather`（`nodeGather.c:142`）走 leader 参与 + parallel worker 的混合策略：首次执行 `ExecInitParallelPlan` + `LaunchParallelWorkers` + `ExecParallelCreateReaders`；之后 `gather_getnext`（`:264`）先从 `TupleQueueReader` 读 worker tuple，无 tuple 且 `need_to_scan_locally` 时 leader 自己 `ExecProcNode(outerPlan)` 执行子计划，都耗尽返回 NULL。`gather_readnext`（`:312`）round-robin 轮询但不每次切换 reader（注释 "much more efficient to keep reading from the same queue"），全部无数据时 `WaitLatch`。

```c title="src/backend/executor/execMain.c"
/* CBDB style parallelism won't interfere PG style parallel mechanism.
 * So that we will pass if use_parallel_mode is true which means there exists
 * Gather/GatherMerge node. */                            // L2876-2878
...
ExecutePlan() {
    ...
    if (useMppParallelMode)
        GpInsertParallelDSMHash(planstate);               // L2881  设置 DSM hash 表
}
```

这是 Cloudberry 的**双层并行**设计：MPP 级（segment 间）用 Motion+interconnect，segment 内用 Gather+parallel worker。`GpInsertParallelDSMHash` 让 Gather/GatherMerge 节点能在 MPP slice 内部用 PG 风格的 parallel worker，与 CBDB 的"所有 worker 平等"并不冲突——前者是节点内并行，后者是节点间并行，两套机制分层叠加。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `standard_ExecutorStart` in `execMain.c:246` | 初始化 EState、slice 表、interconnect、PlanState 树、QD 派发 | 按 `Gp_role` 分 QD/QE 不同初始化路径 |
| `ExecutePlan` in `execMain.c:2707` | `for(;;) ExecProcNode` 拉 tuple | 反压天然内建于 pull 模型 |
| `ExecProcNode` in `executor.h:278` | inline 调 `node->ExecProcNode` 函数指针 | 多态分发避免热路径 switch-case |
| `ExecProcNodeGPDB` in `execProcnode.c:631` | instrument/squelch/QueryFinish wrapper | Cloudberry 定制，统一 MPP 执行横切关注点 |
| `ExecInitMotion` in `nodeMotion.c:666` | 建 MotionState、定 send/recv 角色 | 按 `LocallyExecutingSliceIndex` 匹配 slice |
| `execMotionSender` in `nodeMotion.c:203` | pull 子计划 tuple 并按 Motion 类型路由发出 | sender 返回 NULL，tuple 走网络 |
| `execMotionSortedReceiver` in `nodeMotion.c:433` | binary heap 归并多 sender 流 | 把"多网络流有序归并"隐藏在 Volcano 算子后 |
| `ExecGather` in `nodeGather.c:142` | 启动 parallel worker + leader 参与混合执行 | CBDB 双层并行：MPP slice 内 PG 风格 worker |
| `ExecSplitUpdate` in `nodeSplitUpdate.c:170` | UPDATE 拆 DELETE+INSERT | 分布键变→行迁移到新 segment |

</details>

## 核心实现

### Volcano pull 模型与算子状态树

`ExecProcNode`（`src/include/executor/executor.h:278-284`）是整个执行器的发动机——一个 inline 函数指针调用：检查 `chgParam` 决定是否 `ExecReScan`，然后调 `node->ExecProcNode(node)`。每个算子在 `ExecInitXxx` 中通过 `ExecSetExecProcNode(&node->ps, ExecXxx)`（`execProcnode.c:580-590`）注册自己的执行函数。`ExecInitNode`（`execProcnode.c:190`）是大型 switch-case 分发器，按 `nodeTag` 把 Plan 节点初始化为对应 PlanState（如 `T_Motion → ExecInitMotion`、`T_Gather → ExecInitGather`、`T_Sequence → ExecInitSequence`），递归初始化子节点，形成与 Plan 树同构的 PlanState 树。Cloudberry 在 PG 的 `ExecProcNodeFirst`（`:598`）后加了 `ExecProcNodeGPDB`（`:631`）wrapper，统一处理 `QueryFinishPending`（Motion 节点除外）、squelched 状态、instrumentation、内存上下文切换，最终调 `node->ExecProcNodeReal`。

### Motion：把网络 I/O 封装成 Volcano 算子

Motion 的精妙在于**对上层完全透明**。Sender（`execMotionSender`，`nodeMotion.c:203`）在循环里 `ExecProcNode(outerNode)` 拉子计划 tuple、`SendTuple` 发出，自己返回 NULL——它的"输出"不是给父节点而是发给远端 receiver，所以在 Plan 树里表现为一个数据出口。Receiver（`execMotionUnsortedReceiver`，`:307`）调 `RecvTupleFrom` 从网络拉 tuple 存 slot 返回父节点——对父节点而言和 `SeqScan` 无异。这让上层算子不知道也不需要知道数据来自本地扫描还是远端 segment。Sorted receiver 的 binary heap 归并（`:433-608`）更把"从多个网络流做有序归并"这一复杂逻辑藏在一个普通 Volcano 算子背后。`CHECK_FOR_INTERRUPTS`（`:111`）保证 Motion 等待网络数据时能响应取消信号。

`doSendTuple`（`:1181`）的路由逻辑体现了 CBDB 并行对 Motion 的影响：`MOTIONTYPE_HASH` 先按分布键 hash 到 segment（`evalHashKey`→`segIdx`），若 `parallel_workers >= 2` 再 hash 到 worker 级（`targetRoute = segIdx * parallel_workers + workerIdx`，`:1265-1298`）——即把 [查询优化器](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer) 算出的 `parallel_workers` 翻译成实际的网络路由。

### SplitUpdate：分布式更新的行迁移

分布式数据库里 `UPDATE` 可能改分布键，行必须从原 segment 迁移到新 segment。`ExecSplitUpdate`（`nodeSplitUpdate.c:170-214`）把一条 UPDATE tuple 拆成 DELETE（原 segment 删旧行）+ INSERT（新 segment 插新行）：`SplitTupleTableSlot`（`:73`）对每列分别填 `deleteTuple`/`insertTuple`，设 DML action 标记（`delete_values[attno]=DML_DELETE`、`insert_values[attno]=DML_INSERT`），再用 `evalHashKey`（`:159`）算新行目标 segment 写入 `gp_segment_id` 列。下游 `ModifyTable` 拿到带 DML action 标记的 tuple 后，按 segment id 通过 Motion 重分布到正确 segment 执行 DELETE/INSERT。`SplitMerge`（`nodeSplitMerge.c`）做类似的事但用于 `MERGE` 语句（同时处理 MATCHED/NOT MATCHED 路径）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Volcano 迭代 pull | `ExecProcNode` in `executor.h:278`、`ExecutePlan` in `execMain.c:2707` | 上层按需拉取，反压天然内建，接收方消费慢 sender 自然停止，网络缓冲不无限膨胀 |
| 算子状态树 | `ExecInitNode`/`ExecEndNode` in `execProcnode.c:190,797` | PlanState 镜像 Plan 树，每个算子一套 state，递归初始化/清理 |
| 策略模式 | `ExecSetExecProcNode` 注册 `ExecProcNode` 回调 in `execProcnode.c:580` | 函数指针多态分发，避免热路径巨大 switch-case |
| 网络封装为算子 | `execMotionSender`/`execMotionUnsortedReceiver` in `nodeMotion.c` | 网络收发对上层透明，与 `SeqScan` 无异 |
| 双层并行 | `GpInsertParallelDSMHash` in `execMain.c:2754` + `nodeGather.c` | MPP 级（Motion+interconnect）与 segment 内（Gather+worker）分层叠加互不干扰 |

## 模块间交互

`executor` 与三个模块协作：**`cdb`**——Motion 算子通过 `EState.motionlayer_context`/`interconnect_context`（`execMain.c:472,535` 创建）调 `SendTuple`/`RecvTupleFrom`/`SendEndOfStream`/`SendStopMessage`（`nodeMotion.c:1319,356,1149,327`），网络收发全委托 cdb；**`optimizer`**——`InitPlan`（`execMain.c:1754`）接收 `queryDesc->plannedstmt->planTree`，调 `ExecInitNode` 转 PlanState 树，QE 的切入点可能是某个 Motion 节点而非 root（`:1935-1943`，只初始化本地 slice 相关子树）；**`storage`**——SeqScan/IndexScan 等扫描算子在 `ExecInitXxx` 开 relation、`ExecXxx` 用 table AM 接口（`table_scan_getnextslot` 等）拉 tuple，形成存储→计算→网络的流水线。`executor` 被 `tcop/postgres.c` 的 `exec_simple_query` 经 `ExecutorStart/Run/End` 驱动。

## 扩展方式

- **新增一个算子节点**：改 `execProcnode.c` 的 `ExecInitNode` switch 加 `case T_NewNode: ExecInitNewNode(...)`（仿 `:498` 的 `T_Motion`）；改 `ExecEndNode` switch 加 `case T_NewNodeState: ExecEndNewNode(...)`（仿 `:1047`）；新建 `nodeNewNode.c` 实现 `ExecInitNewNode`（建 state、注册 `ExecProcNode` 回调）、`ExecNewNode`（pull 逻辑）、`ExecEndNewNode`（清理）。
- **修改 Motion 收发协议**：改 `nodeMotion.c` 的 `doSendTuple`（`:1181`）和 receiver（`:307,433`）；如改路由策略调 `MOTIONTYPE_HASH` 分支（`:1265`）；如加新 Motion 类型在 `motionType` 枚举与 `doSendTuple`/`execMotionSender` 的 AssertState 与路由 switch 加分支（需同步改 `cdb` interconnect API）。
- **新增并行 worker 协作逻辑**：改 `nodeGather.c` 的 `gather_readnext`（`:312`）轮询策略或 `gather_getnext`（`:264`）leader/worker 混合策略；改 `execMain.c:2754` 的 `GpInsertParallelDSMHash`/`:2999` 的 `GpDestroyParallelDSMEntry` 调 DSM hash 表；改 `InitPlan` 的 `useMppParallelMode`（`:1914`）/`TotalParallelWorkerNumberOfSlice`（`:1920`）设 slice 级并行度（这些值在 `doSendTuple` 算 `parallel_workers` 级路由 `nodeMotion.c:1273-1284`）。
