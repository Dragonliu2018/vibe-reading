---
source:
  type: "源码解读"
  project: "Greenplum"
  url: "https://github.com/greenplum-db/gpdb"
title: "cdb 分布式执行层"
date: "2026-08-14T15:39:30+08:00"
category: [Database, OLAP, Greenplum, CodeWiki, "7.0.0-beta.0"]
tags: ["Greenplum", "MPP", "Motion", "互连", "分布式事务"]
description: "cdb——把单机计划变成并行计划、派发 segment 执行、经互连交换中间结果并协调分布式事务的 MPP 执行内核。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/00-overview)

---

## 模块定位

`cdb`（`src/backend/cdb/`，~6.6 万行）是 GPDB 区别于 PostgreSQL 的核心——早年 "Cluster Database" 的工作代号。它解决三件事：把 coordinator 上产生的单机计划改写为可并行形态（插入 Motion 算子、构建 slice 表）、向 segment 派发命令并组织 gang（工作进程组）、在 segment 间经互连（interconnect）传输 Motion 元组并协调分布式事务。`cdbvars.h` 是全仓被 include 最多的头（267 次），是 MPP 运行参数的集中定义，几乎每个 cdb 子系统都依赖它。

## 模块架构

按职责划分子系统（基于 graphify god-nodes 与代码组织）：

| 子系统 | 关键文件 | graphify god-node（度） |
|--------|----------|------------------------|
| 计划并行化 | `cdbpath.c`、`cdbmutate.c`、`cdbllize.c` | `cdbpath_create_motion_path`(26)、`cdb_create_multistage_grouping_paths`(22)、`choose_grouping_locus`(18) |
| 派发 dispatcher | `dispatcher/cdbdisp_query.c`、`dispatcher/cdbdisp.c`、`dispatcher/cdbgang.c`、`dispatcher/cdbgang_async.c` | `cdbdisp_dispatchCommandInternal`(20)、`CdbDispatchSetCommand`(18)、`cdbgang_createGang_async`(19) |
| 互连 interconnect | `motion/ic_tcp.c`、`motion/ic_common.c`、`motion/ic_proxy*` | `SetupTCPInterconnect`(19)、`TeardownUDPIFCInterconnect_Internal`(18)、`ic_proxy_client_get_name`(30)、`handleAckForDisorderPkt`(19) |
| 分布式事务 DTX | `cdbtm.c`、`cdbdistributedxacts.c`、`cdbdistributedsnapshot.c` | `CdbDispatchDtxProtocolCommand`(17) |
| Motion 执行 | `src/backend/executor/nodeMotion.c`（配合 cdb 的 motion layer） | `getgpsegmentCount`(21)、`hashFn`(32) |
| AO 存储 | `cdbappendonly*.c`、`cdbbuffered*.c` | `cdbappendonlyam.h`(26× include) |

`cdb/` 下有 `dispatcher/` 与 `motion/` 子目录分别承载派发与互连逻辑；`cdbvars.h` 定义运行角色（`Gp_role`：DISPATCH/EXECUTE）、segment 数等全局状态，是各子系统协作的共享上下文。

## 调用链路

一条分布式查询在 cdb 内的执行路径（行号来自源码交叉验证）：

```
[计划并行化] 两条 Motion 插入路径：
 PG planner 回退:  cdbllize_adjust_top_path()  cdbllize.c:386  顶部加 Gather Motion path
                   └─ create_motion_plan()  createplan.c:3012
                       └─ cdbmutate.c: make_hashed_motion:99 / make_broadcast_motion:136 / make_union_motion:68
                   cdbllize_build_slice_table()  cdbllize.c:1094  为每个 Motion 分配 slice ID
 ORCA 路径:        Motion 由 ORCA xform 在 PdxlnOptimize 内插入 → gpopt TranslateDXLMotion 翻译+建 slice

[派发]  executor/execMain.c:649  standard_ExecutorStart → CdbDispatchPlan()
        cdbdisp_query.c:177  CdbDispatchPlan(queryDesc, …)
         ├─ exec_make_plan_constant() :230  常量折叠
         ├─ serializeParamsForDispatch() :245  序列化参数
         └─ cdbdisp_dispatchX() :1060
             ├─ AssignGangs() :1098 → AssignWriterGangFirst() execUtils.c:1390
             │     └─ AllocateGang() cdbgang.c:107 → cdbgang_createGang() :94
             │         └─ cdbgang_createGang_async() cdbgang_async.c:47
             │             ├─ PQconnectStart() 非阻塞 cdbgang_async.c:168
             │             ├─ WaitEventSetWait() 轮询 cdbgang_async.c:~320
             │             └─ FtsIsSegmentDown() 检查 :105
             ├─ fillSliceVector() :1106  排序派发顺序
             ├─ buildGpQueryString() :1111  序列化 Plan → 'M' 消息
             ├─ for each slice: cdbdisp_dispatchToGang() :1192 → cdbdisp.c:75  libpq 发送
             ├─ cdbdisp_waitDispatchFinish() :1201   ← 必须等完，否则死锁
             └─ cdbdisp_getDispatchResults() :1221

[互连]  SetupTCPInterconnect()  motion/ic_tcp.c:1248
         ├─ acceptIncomingConnection() :98  遍历 mySlice->children :1316
         ├─ startOutgoingConnections() :86  :1389
         └─ select() 循环 :1698  并行处理多路连接

[QE 执行]  nodeMotion.c:201  execMotionSender()
         ├─ ExecProcNode(outerNode) :227  从子节点拉元组
         ├─ doSendTuple() :264/1148  GATHER:targetRoute=0 :1166 / BROADCAST :1171 / HASH:evalHashKey :1175
         └─ doSendEndOfStream() :250/1110

[QD 汇总]  nodeMotion.c:303  execMotionUnsortedReceiver() → RecvTupleFrom() :351
         └─ execMotionSortedReceiver() :428  binaryheap :431 归并多路有序流
```

<details>
<summary>方法速查</summary>

| 方法 | 一行职责 | 关键决策 |
|------|----------|----------|
| `cdbllize_adjust_top_path` (cdbllize.c:386) | 顶部加 Gather Motion | 把分布式结果汇聚回 coordinator |
| `make_hashed_motion` (cdbmutate.c:99) | 构造哈希重分布 Motion | 按分布键 hash 分配 segment |
| `CdbDispatchPlan` (cdbdisp_query.c:177) | 派发计划到 segment | 序列化 + 建 gang + 发 'M' |
| `cdbgang_createGang_async` (cdbgang_async.c:47) | 异步建 gang | PQconnectStart 并行连所有 segment |
| `SetupTCPInterconnect` (ic_tcp.c:1248) | 建立互连 | accept incoming + start outgoing |
| `execMotionSender` (nodeMotion.c:201) | segment 发送端 | pull 模型，GATHER/BROADCAST/HASH |
| `CdbDispatchDtxProtocolCommand` | DTX 命令派发 | 两阶段提交 |

</details>

## 核心实现

### 计划并行化：插入 Motion 与 slice 表

Motion 是 GPDB 区别于 PostgreSQL 的核心算子——它表示"数据要从一个 segment 集合移动到另一个"。有两条插入路径。PG planner 回退路径：`cdbllize_adjust_top_path`（`cdbllize.c:386`）在 best_path 顶部加 Gather Motion（把分布式结果汇聚回 coordinator），`create_motion_plan`（`createplan.c:3012`）在 Path→Plan 转换时调用 `cdbmutate.c` 的 `make_hashed_motion`(:99)/`make_broadcast_motion`(:136)/`make_union_motion`(:68) 构造对应 Motion plan 节点，再 `cdbllize_build_slice_table`（`cdbllize.c:1094`，经 `build_slice_table_walker:1163`）为每个 Motion 分配 slice ID、构建 `SliceTable`。ORCA 路径则由 ORCA 的 xform 引擎在 `PdxlnOptimize` 内部插入 Motion（distribution 属性驱动），`gpopt` 的 `TranslateDXLMotion` 翻译时建 slice。

`cdbpath_create_motion_path`（graphify 度 26 的 god-node）是路径层创建 Motion 的枢纽：它比较子路径 locus 与目标 locus（`cdbpathlocus_equal`），相同则不必插 Motion；当子路径是 `CdbPathLocus_IsOuterQuery` 而目标是 Partitioned 时，会把子路径 locus 调整为 `CdbLocusType_SingleQE` 再决定 Motion 形态。locus 是 cdb 的核心抽象（`CdbPathLocus`/`CdbLocusType`，区分 SingleQE/Partitioned/General/Replicated 等），决定数据"住在哪些 segment"。`choose_grouping_locus`(:18) 决定聚合在哪个 locus 执行、`cdb_create_multistage_grouping_paths`(:22) 处理多级分组——这些是 MPP 计划改写的核心决策点。

Motion 改写还有两处关键逻辑：`fix_outer_query_motions_mutator`（`cdbllize.c`）把 `MOTIONTYPE_OUTER_QUERY` 的 Motion 按父切片 Flow 类型改写（父 Flow 为 PARTITIONED 时改写为 `MOTIONTYPE_BROADCAST`，若该 Motion `sendSorted` 为真还会额外调 `make_sort` 保证顺序）；`shareinput_mutator_dag_to_tree`（`cdbmutate.c`）处理 ShareInputScan 的 DAG→树转换——同一 `ShareInputScan.share_id` 的多个扫描节点中，第一个出现者作为 producer（`shareinput_save_producer` 保存），后续引用同一 share 的子树改为引用该 producer，把共享子图的 DAG 拍平成可派发的树形计划。

### 派发 dispatcher 与 gang

`CdbDispatchPlan`（`dispatcher/cdbdisp_query.c:177`）是派发入口：`exec_make_plan_constant`(:230) 常量折叠、`serializeParamsForDispatch`(:245) 序列化参数、`cdbdisp_dispatchX`(:1060) 编排。它先 `AssignGangs`(:1098)——`AssignWriterGangFirst`（`execUtils.c:1390`）按 slice 树分配合适的 gang（writer gang 先于 reader gang），`AllocateGang`（`cdbgang.c:107`）→ `cdbgang_createGang`(:94) → `cdbgang_createGang_async`（`cdbgang_async.c:47`，graphify 度 19）异步建 gang：用 `PQconnectStart`（非阻塞，`cdbgang_async.c:168`）**同时**对所有 segment 发起连接，`WaitEventSetWait`（`:~320`）轮询所有连接完成，建连前查 `FtsIsSegmentDown`(:105)——segment down 则 ERROR（事务中则 `resetSessionForPrimaryGangLoss`）。然后 `fillSliceVector`(:1106) 排序派发顺序、`buildGpQueryString`(:1111) 把 Plan 序列化成 libpq 'M' 消息、对每个 slice `cdbdisp_dispatchToGang`(:1192 → `cdbdisp.c:75`) 发送。

> **为什么 dispatch 必须同步等待**：`cdbdisp_waitDispatchFinish`(:1201) 在执行前必须等所有 segment 收到计划——否则会死锁：QD 的 gather motion 等 segment 发数据，而 segment 还在等 coordinator 发计划。这是 MPP 派发-执行的因果顺序约束。

### 互连 interconnect

`SetupTCPInterconnect`（`motion/ic_tcp.c:1248`，graphify 度 19）为当前 slice 的所有 producer/consumer 建立连接：incoming 方遍历 `mySlice->children`（`:1316`）`acceptIncomingConnection`(:98)，outgoing 方 `startOutgoingConnections`(:86，调于 :1389)，再用 `select()` 循环（`:1698`）并行处理多路连接。除 TCP 外还有 UDP 互连（`UDPIFC` 系列：`TeardownUDPIFCInterconnect_Internal` 度 18、`handleAckForDisorderPkt` 度 19——处理乱序包的 ACK），适合高扇出的 broadcast 场景。互连在 `standard_ExecutorStart` 的 `InitPlan` 中由 `SetupInterconnect`（`execMain.c:488`）建立，QE 与 QD 两侧各自建立自己的连接半边。建立 incoming 连接前，`setupTCPListeningSocket`（`ic_tcp.c`）确定监听端口（经 `getaddrinfo` 解析地址，当同时返回 `AF_INET` 与 `AF_INET6` 时偏好 `AF_INET6`）。

### 分布式事务 DTX

`cdbtm.c` 实现两阶段提交。`setupDtxTransaction`（在 `execMain.c:~598` 的 `standard_ExecutorStart`、`CdbDispatchPlan` 之前，当 `ExecutorSaysTransactionDoesWrites()` 为 true）设置分布式事务上下文；`addToGxactDtxSegments`（`cdbdisp_query.c:1194`）记录参与事务的 gang。提交流程：`doNotifyingCommitPrepared`（`cdbtm.c:558`）→ `currentDtxDispatchProtocolCommand(DTX_PROTOCOL_COMMAND_COMMIT_PREPARED)`(:587)；commit/abort 经 `performDtxProtocolCommitPrepared`(:134)/`performDtxProtocolAbortPrepared`(:135)，abort 重试 `retryAbortPrepared`(:686) → `ResetAllGangs`(:718) → `DTX_PROTOCOL_COMMAND_RETRY_ABORT_PREPARED`(:724)。DTX 命令经 `doDispatchDtxProtocolCommand`(:1251) → `CdbDispatchDtxProtocolCommand`（`cdbdisp_dtx.c:68`，graphify 度 17）派发给 writer gang（不可取消，`cancelOnError=false`）。分布式快照由 `cdbdistributedsnapshot.c`/`cdbdistributedxacts.c` 维护，保证跨 segment 一致性读。DTX 的全局事务 id（gxid）由 `currentDtxActivate`（`cdbtm.c`）激活分配：当 `GxidCount` 低于 `GXID_PRETCH_THRESHOLD` 时触发预取，经 `PMSIGNAL_WAKEN_DTX_RECOVERY` 唤醒 DTX recovery 进程补号；`doNotifyingCommitPrepared`（`cdbtm.c:558`）在 COMMIT_PREPARED 广播失败时进入 `DTX_STATE_RETRY_COMMIT_PREPARED` 状态等待重试。

### Motion 执行与哈希重分布

segment 侧执行经 `ExecutorRun`→`ExecProcNode` 到达 Motion 节点（`src/backend/executor/nodeMotion.c`，与 cdb 的 motion layer 协作）。`ExecMotion`(:97) 分 sender/receiver 两路：sender `execMotionSender`(:201) 是 pull 模型，`ExecProcNode(outerNode)`(:227) 从子节点拉元组 → `doSendTuple`(:264/1148) 按类型路由——GATHER `targetRoute=0`(:1166)、BROADCAST `BROADCAST_SEGIDX`(:1171)、HASH `evalHashKey`(:1175) 算哈希分配，`doSendEndOfStream`(:250/1110) 发结束标记。receiver `execMotionUnsortedReceiver`(:303) `RecvTupleFrom`(:351) 阻塞接收，`execMotionSortedReceiver`(:428) 用 `binaryheap`(:431) 归并多个有序流（归并排序模型）。`hashFn`（graphify 度 32，最高）是哈希重分布的底层函数，决定元组去哪个 segment。

> **并发模型**：每个 segment 单线程执行，但多 segment 间经互连形成数据并行；Motion 的 producer/consumer 是协作并发——下游不再需要数据时发 Stop，sender `ExecSquelchNode` 停止子节点（`stopRequested` :267）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Fan-out / Fan-in | `CdbDispatchPlan` → segments → gather | MPP 派发-汇总的核心形态 |
| 异步建连 + 多路复用 | `cdbgang_createGang_async` `PQconnectStart`+`WaitEventSetWait`；互连 `select()` | 多 segment 并行建连/收发，单进程内多路复用 |
| Worker Pool（gang） | `cdbgang.c` gang = 一组 segment 工作进程 | 按需创建/复用，FTS 保活 |
| Producer-Consumer | Motion sender/receiver + interconnect | 解耦数据生产与消费，支持流式 |
| 归并排序 | `execMotionSortedReceiver` binaryheap | 多路有序流合并 |
| 状态机 | DTX 两阶段（prepare→commit/abort→retry） | 分布式提交的显式状态推进 |

## 模块间交互

- **上游**：`optimizer`（`cdbllize_adjust_top_path`/`cdbmutate` 插 Motion）与 `executor`（`execMain.c:649` `CdbDispatchPlan`、`nodeMotion.c` 执行）调用 cdb；`gpopt` 经 ORCA 路径产生的 Motion 由 cdb 的 motion layer 执行。
- **fts**：cdb gang 创建时查 `FtsIsSegmentDown`（`cdbfts.c:135`）规避 down segment；建 gang 失败调 `FtsNotifyProber`（`cdbfts.c:78`，`cdbgang_async.c:~376`/`cdbdisp_async.c:638`）触发 FTS 重探。
- **segment postmaster**：经 libpq TCP 发 'M' 消息（`cdbdisp.c:75`），segment `PostgresMain` 收（`postgres.c:5400`）→ `exec_mpp_query`(:1129)。
- **catalog**：读 `gp_segment_configuration`（经 `cdbcomponent`）确定 segment 列表与角色。

## 扩展方式

新增一种 Motion 类型：在 `cdbmutate.c` 加 `make_*_motion` 构造函数（如 `make_hashed_motion:99` 模式）、`cdbpath.c` 的 `cdbpath_create_motion_path` 加路径创建分支、`executor/nodeMotion.c` 的 `doSendTuple`(:1148) 路由 switch 加 case（如新路由策略）、ORCA 侧加对应 `CDXLPhysicalMotion*` + xform。

修改互连超时/重试：改互连相关 GUC（`gp_interconnect_*`）+ `ic_tcp.c` 的超时与重试逻辑（`handleAckForDisorderPkt` 附近的重传/ACK）。

新增分布式事务命令：在 `cdbtm.c` 加 `DTX_PROTOCOL_COMMAND_*` 枚举 + 对应 `perform*` 函数 + `CdbDispatchDtxProtocolCommand` 派发。改 segment 状态/拓扑相关逻辑时，参照 `src/backend/cdb/dispatcher/test/cdbdisp_query_test.c` 的可执行单测验证。

> cdb 子系统多且交叉，graphify 在该模块检出 54 个社区、4874 条边，god-node `hashFn`(32) 与 `ic_proxy_*`(30) 反映哈希重分布与互连 proxy 是最密集的耦合点。互连的 UDP 乱序包处理（`handleAckForDisorderPkt`）是 broadcast 高扇出场景的性能关键路径，其精确的 ACK/重传时序设计细节待核实源码注释。
