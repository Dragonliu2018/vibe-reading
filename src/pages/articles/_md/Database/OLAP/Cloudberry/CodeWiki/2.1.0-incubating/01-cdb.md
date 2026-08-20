---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "分布式执行内核"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C/C++", "MPP", "Motion", "interconnect", "分布式事务"]
description: "Cloudberry cdb 模块——把单机 PostgreSQL 改造为 coordinator+segment MPP 的核心层：Locus 驱动 Motion 插入、Gang 派发、interconnect 互联、两阶段提交与分布式快照。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/00-overview)

---

## 模块定位

`src/backend/cdb/` 是 Cloudberry 把单机 PostgreSQL 改造成 coordinator（QD, Query Dispatcher）+ 多 segment（QE, Query Executor）MPP 集群的核心层。`cdb` 是早年 "Cluster Database" 的工作代号，名称已不再使用但代码前缀保留。它干四件事：**用 Locus 抽象驱动 Motion 算子插入**（把计划改写为可并行形态）、**建立 segment 间 interconnect 互连网络**、**向 segment 派发命令**（Gang 建立 + 查询派发）、**协调分布式事务与分布式快照**（保证 MPP 一致性）。cdb 是整个 Cloudberry diff 相对上游 PostgreSQL 14 最集中的模块——PostgreSQL 的执行器、存储、事务机制大部分复用，cdb 负责把"一个计划变成并行计划、让 segment 间交换数据、保持分布式一致性"这三件事。

互联网络实现独立在 `contrib/interconnect/`（共享库 `interconnect.so`），通过 `shared_preload_libraries` 加载，与核心代码解耦便于测试与扩展。

## 模块架构

```text
optimizer 产 Path 树 ── cdbpath 在 Path 上插 CdbMotionPath ── cdbllize 顶层并行化
                                                                        │
                                                            create_plan Path→Plan
                                                                        │
┌───────────────────────────────────────────────────────────────────────┴──────────────┐
│  计划改写        cdbpath.c (Motion 决策) · cdbpathlocus.c (Locus 类型系统)            │
│                cdbpathtoplan.c (Locus→Flow) · cdbllize.c (顶层并行化+slice 表)        │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  派发与 Gang    dispatcher/cdbgang.c (Gang 工厂) · cdbdisp.c (异步派发)               │
│                cdbdisp_query.c (CdbDispatchPlan) · cdbdisp_async.c (轮询)            │
│                cdbdispatchresult.c (结果收集) · cdbconn.c (QE 连接封装)              │
├────────────────────────────────────────────────────────────────────────────────────┤
│  互联网络       motion/cdbmotion.c (SendTuple/RecvTupleFrom) · tupser.c (序列化)    │
│   (可插拔)      ┌─ tcp/ic_tcp.c (TCP socket)                                       │
│                contrib/interconnect  ┼─ udp/ic_udpifc.c (UDP+可靠性层,默认)            │
│                                    └─ proxy/ic_proxy_main.c (libuv 代理,云环境)       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  分布式事务     cdbtm.c (2PC + 重试恢复) · cdbdistributedsnapshot.c (分布式快照)    │
│  与快照        DistributedSnapshot 三级缓存可见性判断                                │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  AO 存储       cdbappendonlystorageformat.c · cdbappendonlystorageread.c            │
│               cdbappendonlystoragewrite.c · cdbappendonlyxlog.c                     │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                            executor/nodeMotion.c 实际驱动 Motion 算子
```

cdb 内部分五块：**计划改写**（cdbpath 用 Locus 决定插哪种 Motion）、**派发与 Gang**（dispatcher 建 segment 进程组、派发查询、收结果）、**互联网络**（motion + 三种可插拔传输协议）、**分布式事务与快照**（cdbtm 2PC、分布式快照三级缓存）、**AO 存储**（append-only 行/列存）。`MotionIPCLayer` 虚表（`ml_ipc.h:36`，约 20 个函数指针）是互联层的可插拔关键——三种传输实现（TCP/UDPIFC/Proxy）注册其中，运行时由 `gp_interconnect_type` GUC 选择。

## 调用链路

### Motion 计划改写：Locus 决定插哪种 Motion

```text
cdbpath_motion_for_join(outer_path, inner_path, ...) in cdbpath.c:1362
  ├─ cdbpathlocus_equal(a, b) in cdbpathlocus.c:88   两侧 locus 等价? 无需 Motion
  ├─ 两侧均分区 → 逐级尝试:
  │    1. cdbpath_match_preds_to_both_distkeys  两 distkey 匹配? 无需 Motion
  │    2. 重分布较小侧到较大侧 distkey
  │    3. 广播较小侧 (if small.bytes * numsegments < large.bytes)
  │    4. 重分布较大侧
  │    5. 两侧都重分布到等连接列
  │    6. 最后手段: 收集到 SingleQE
  └─ cdbpath_create_motion_path(subpath, locus, ...) in cdbpath.c:193   [CdbMotionPath*]
       ├─ cdbpathlocus_equal(subpath->locus, locus)? 无 Motion 返回原路径
       └─ 决策矩阵 (source→target):
            Partitioned→Bottleneck    : Gather Motion (有 pathkeys→Merge Receive, 否则 Union Receive)
            Bottleneck→Partitioned     : Redistribute Motion
            Partitioned→Partitioned    : Redistribute (新 distkey)
            Partitioned→Replicated     : Broadcast Motion
            General→任意               : 无 Motion (identity)
       └─ 创建 CdbMotionPath 节点 in :605 · cdbpath_cost_motion 估算代价 in :86

cdbllize_adjust_top_path() in cdbllize.c:400    顶层最终 locus
  ├─ SELECT: gather 到 Entry · INSERT: 重分布到目标表策略 · CTAS: 按目标策略建 Motion
  └─ cdbllize_build_slice_table() in cdbllize.c:1113   为 Motion 节点分 slice ID + 建 slice 表
       └─ build_slice_table_walker() in :1290   遍历计划树
```

### Gang 建立与查询派发

```text
CdbDispatchPlan(queryDesc, ...) in cdbdisp_query.c:184
  ├─ exec_make_plan_constant  QD 预计算 STABLE 函数/序列值
  ├─ verify_shared_snapshot_ready  writer gang 共享快照就绪
  └─ cdbdisp_dispatchX() in cdbdisp_query.c:127
       ├─ cdbdisp_buildPlanQueryParms  序列化计划树 + qdSerializeDtxContextInfo(分布式快照/事务)
       ├─ AllocateGang(ds, GANGTYPE_PRIMARY_WRITER, segments) in cdbgang.c:107
       │    └─ cdbgang_createGang_async() in cdbgang_async.c:49
       │         ├─ buildGangDefinition() in cdbgang.c:263   为每 segment cdbcomponent_allocateIdleQE 取/建 QE 连接
       │         ├─ cdbconn_doConnectStart→doConnectComplete  libpq 异步连 QE
       │         ├─ poll() 轮询 PQconnectPoll 完成异步连接
       │         ├─ build_gpqeid_param  构造 gpqeid 参数串 · makeOptions 同步 GUC 到 QE
       │         └─ cdbconn_setQEIdentifier  writer gang 设标识
       ├─ cdbdisp_dispatchToGang() in cdbdisp.c  → cdbdisp_dispatchToGang_async
       │    └─ 对 gang 每 QE: PQsendGpQuery_shared 发序列化查询 · poll() 轮询发送完成
       ├─ cdbdisp_waitDispatchFinish  等派发完成
       └─ cdbdisp_checkDispatchResult  等 QE 执行完成 · cdbdisp_getDispatchResults 收结果/错误
```

### Tuple 传输（Motion 算子调 cdb 收发）

```text
发送: SendTuple(motionlayer_ctx, ic_ctx, motionID, slot, targetRoute) in motion/cdbmotion.c
  ├─ 零拷贝: CurrentMotionIPCLayer->GetTransportDirectBuffer  → conn->pBuff+msgSize
  ├─ SerializeTuple() in tupser.c  CandidateForSerializeDirect? memcpy 直存(TC_WHOLE) : 分块(TC_PARTIAL_START/MID/END)
  ├─ PutTransportDirectBuffer 推进游标
  └─ 或 SendTupleChunkToAMS() in contrib/interconnect/ic_common.c
       ├─ targetRoute==BROADCAST_SEGIDX? doBroadcast 遍历所有连接
       └─ CurrentMotionIPCLayer->SendChunk(transportStates, pEntry, conn, tcItem, motNodeID)
            = SendChunkTCP: 缓冲满→flushBuffer→send(sockfd,...) · memcpy 到 conn->pBuff

接收: RecvTupleFrom(motionlayer_ctx, ic_ctx, motionID, route) in cdbmotion.c
  ├─ htfifo_gettuple(ready_tuples)  先取已完成 tuple
  └─ 无则 processIncomingChunks:
       ├─ CurrentMotionIPCLayer->RecvTupleChunkFromAny = RecvTupleChunkFromAnyTCP: readPacket→recv(sockfd)
       └─ addChunkToSorter  按 chunk 头类型状态机:
            TC_WHOLE/TC_EMPTY → appendChunkToTCList + reconstructTuple
            TC_PARTIAL_START/MID → 累积 · TC_PARTIAL_END → reconstructTuple
            TC_END_OF_STREAM → 标记发送方完成
            reconstructTuple → CvtChunksToTup in tupser.c → TRCheckAndRemap 记录类型重映射 → htfifo_addtuple
```

### 分布式事务两阶段提交

```text
prepareDtxTransaction() in cdbtm.c:883
  ├─ 无 WAL 写入或单 segment? → doNotifyingOnePhaseCommit() in :551   一阶段优化
  │    └─ currentDtxDispatchProtocolCommand(DTX_PROTOCOL_COMMAND_COMMIT_ONEPHASE) 广播 QE
  └─ 两阶段提交:
       Phase 1: doPrepareTransaction() in cdbtm.c:483
            state=DTX_STATE_PREPARING → 广播 PREPARE
            QE: performDtxProtocolPrepare → PrepareTransactionBlock(gid) 写 PREPARE WAL + pg_prepared_xacts
            state=DTX_STATE_PREPARED
       Phase 2: doNotifyingCommitPrepared() in cdbtm.c:575
            state=DTX_STATE_NOTIFYING_COMMIT_PREPARED · 持 TwophaseCommitLock(共享)
            广播 COMMIT_PREPARED → QE: performDtxProtocolCommitPrepared → FinishPreparedTransaction(gid,true)
            失败? 指数退避重试: ResetAllGangs 重建 gang → RETRY_COMMIT_PREPARED · 全失败 PANIC
            成功: doInsertForgetCommitted → RecordDistributedForgetCommitted(gxid) 写 FORGET COMMITTED WAL
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `cdbpath_create_motion_path` in `cdbpath.c:193` | 由 source/target Locus 决策矩阵建 Motion Path | Locus 作类型系统，Motion 作类型转换 |
| `cdbpathlocus_equal` in `cdbpathlocus.c:88` | 判两 Locus 等价（Strewn 永不等） | collocation 检查跳过冗余 Motion，MPP 优化核心 |
| `cdbpathlocus_join` in `cdbpathlocus.c:728` | 算 join 结果 Locus | FULL JOIN→HashedOJ（NULL 可在任意 segment） |
| `cdbllize_adjust_top_path` in `cdbllize.c:400` | 顶层最终 Locus（SELECT→Entry/INSERT→重分布） | 按查询类型决定 gather 目标 |
| `cdbllize_build_slice_table` in `cdbllize.c:1113` | 为 Motion 分 slice ID + 建 slice 表 | executor 据此建 gang 和 interconnect |
| `AllocateGang` in `cdbgang.c:107` | Gang 工厂，按 GangType 取/建 segment 进程组 | 函数指针 `pCreateGangFunc` 可插拔 |
| `CdbDispatchPlan` in `cdbdisp_query.c:184` | 派发计划到 segment | 序列化计划树+DTX 上下文，异步派发+轮询收结果 |
| `SendTuple`/`RecvTupleFrom` in `cdbmotion.c` | Motion 算子收发 tuple | 零拷贝直存 + 分块序列化状态机 |
| `prepareDtxTransaction` in `cdbtm.c:883` | 分布式事务 2PC | 一阶段优化 + Phase2 指数退避重试 + DtxRecovery 恢复 |
| `DistributedSnapshotWithLocalMapping_CommittedTest` in `cdbdistributedsnapshot.c:39` | 本地 XID→GXID 可见性判断 | 三级缓存（进程本地→LocalDistribXactCache→DistributedLog） |

</details>

## 核心实现

### Locus 抽象：MPP 计划的类型系统

`CdbPathLocus`（`src/include/cdb/cdbpathlocus.h:154`）描述元组在 segment 间的分布——`locustype`（类型枚举）、`distkey`（分布键，`DistributionKey` 列表，每组含 `EquivalenceClass`，利用 `WHERE a=b` 等价类让 `a`/`b` 都可算 hash）、`numsegments`、`parallel_workers`。关键类型：`Entry`（数据仅在 QD）、`SingleQE`（任意单后端）、`General`（自包含，兼容任何 locus）、`SegmentGeneral`（所有 QE 可用不在 QD，查复制表）、`Replicated`（N-gang 所有 QE 复制，DML 写复制表）、`Hashed`（按 distkey hash 分布，每 segment 不相交子集）、`HashedOJ`（外连接 hash 结果，NULL 可在任意 segment）、`Strewn`（分布函数未知，**永不等任何 locus 包括自身**）。并行变体 `HashedWorkers`/`SegmentGeneralWorkers`/`ReplicatedWorkers` 见 [查询优化器](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer)。

整个 Motion 插入遵循"Locus 作类型系统，Motion 作类型强制转换"模式：`cdbpath_create_motion_path`（`cdbpath.c:193`）接收 subpath（携带 source locus）和 target locus，按决策矩阵（Partitioned→Bottleneck=Gather、Bottleneck→Partitioned=Redistribute、Partitioned→Replicated=Broadcast、General→任意=无 Motion）决定 Motion 类型。好处是声明式（optimizer 只声明"需要 Hashed 上的数据"、cdbpath 自动决定是否/何种 Motion）、组合性（`cdbpathlocus_join` 算 join 结果分布可递归改写复杂查询）、优化友好（`cdbpathlocus_is_hashed_on_exprs` collocation 检查跳过冗余 Motion）。

### Gang、Slice 与派发

**Slice** 是查询的并行分片：`PlanSlice`（`plannodes.h:234`）静态描述（sliceIndex/parentIndex/gangType/numsegments/parallel_workers/directDispatch），`ExecSlice`（`execdesc.h:81`）运行时关联 `primaryGang` 和 `primaryProcesses`（`CdbProcess` 列表，含 listenerAddr/Port/pid/contentid/dbid）。`cdbllize_build_slice_table` 遍历计划树为每个 Motion 节点分 slice ID，构建 slice 表，executor 据此建 gang 和 interconnect。**Gang** 是 segment 进程组（`cdbgang.h:32`，type/size/db_descriptors/allocated），`GangType` 分 `ENTRYDB_READER`/`SINGLETON_READER`/`PRIMARY_READER`/`PRIMARY_WRITER`。`AllocateGang`（`cdbgang.c:107`）是工厂入口，通过函数指针 `pCreateGangFunc`（默认 `cdbgang_createGang_async`）实现创建策略可插拔——`buildGangDefinition` 为每 segment 从 QE 连接池 `cdbcomponent_allocateIdleQE` 取/建连接，libpq 异步建连 + `poll` 轮询完成，`build_gpqeid_param` 构造 gpqeid 参数串、`makeOptions` 同步 GUC 到 QE。**派发** `CdbDispatchPlan`（`cdbdisp_query.c:184`）序列化计划树 + DTX 上下文（`qdSerializeDtxContextInfo`），构造 'M' 消息，`cdbdisp_dispatchToGang_async` 对 gang 每 QE `PQsendGpQuery_shared` 发送，`cdbdisp_checkDispatchResult` 等 QE 执行完成、`cdbdisp_getDispatchResults` 收结果或错误。`DirectDispatchUpdateContentIdsFromPlan`（`cdbtargeteddispatch.c:390`）分析查询谓词算目标 segment，避免向不相关 segment 派发。

### interconnect：三种可插拔传输协议

`MotionIPCLayer`（`src/include/cdb/ml_ipc.h:36`）是 C 风格虚表（约 20 个函数指针：`SetupInterconnect`/`SendChunk`/`RecvTupleChunkFromAny`/`DirectPutRxBuffer` 等），三种实现在 `contrib/interconnect/ic_modules.c:145` 的 `_PG_init` 经 `RegisterIPCLayerImpl` 注册，运行时由 `gp_interconnect_type` GUC 选择、`SetCurrentMotionIPCLayer` 解析：

- **TCP**（`tcp/ic_tcp.c`）：简单可靠，阻塞 `send`/`recv` + `select` 中断检查，`PACKET_HEADER_SIZE`=4 字节，适合大数据量 OLAP。
- **UDPIFC**（`udp/ic_udpifc.c`，**默认**）：UDP + 自定义可靠性层——完整 TCP 类拥塞控制（`cwnd`/`ssthresh`/AIMD）、序列号+ACK+重传、RTT 估算、CRC 完整性、接收端环形缓冲区，避免 TCP head-of-line blocking，适合高扇出互联。
- **Proxy**（`proxy/ic_proxy_main.c`）：基于 libuv 的代理 bgworker，每 segment 一个 proxy，本地 backend 经 Unix domain socket 连 proxy，proxy 间 TCP（`TCP_NODELAY`）互联，专为云/K8s 环境解决直连受限设计。

互联层用 `CONTAINER_OF` 宏（`ic_internal.h:23`）做 C 风格继承：`MotionConn` 是基类，`MotionConnTCP`/`MotionConnUDP` 将 `struct MotionConn mConn` 作首成员；`getMotionConn` 宏按 `ic_type` 分派到正确派生类型。tuple 序列化（`tupser.c`）有零拷贝路径（`CandidateForSerializeDirect` → `memcpy` 直存 `TC_WHOLE`）和分块路径（`TC_PARTIAL_START/MID/END`），`TupleRemapper`（`tupleremap.c`）处理 record 类型的跨 segment typmod 同步。

### 分布式事务与快照

分布式事务用**优化的两阶段提交**（`cdbtm.c`）：默认 QD 分配 GXID → 广播 PREPARE（各 QE 写 PREPARE WAL + `pg_prepared_xacts`）→ 广播 COMMIT PREPARED → 写 FORGET COMMITTED WAL；`TwophaseCommitLock` 在 Phase 2 共享持有。**一阶段优化**：`!TopXactExecutorDidWriteXLog()`（无 WAL）或单 segment 时跳过 PREPARE 直接 `COMMIT_ONEPHASE`（`:551`）。Phase 2 失败指数退避重试，重建 gang 后 `RETRY_COMMIT_PREPARED`，全失败 PANIC 由 `DtxRecovery` 后台进程恢复 in-doubt 事务。GXID 是 `uint64` 用 `pg_atomic_uint64` 跨平台原子，QD 批量预取（`gp_gxid_prefetch_num`）减锁争用。`DtxState`（`cdbtm.h:30-90`）有 14 个状态完整生命周期，`DtxContext` 区分 QD/QE 角色。

**分布式快照**解决"每 segment 独立本地 XID 空间无法跨 segment 比较事务顺序"问题：QD `setupDtxTransaction`（`cdbtm.c:420`）分配 GXID 并构建 `DistributedSnapshot`（xmin=最低进行中 GXID、xmax=latestCompletedGxid+1、inProgressXidArray=排序的进行中 GXID 数组），`DistributedSnapshot_Serialize`（`cdbdistributedsnapshot.c:277`）序列化随查询派发，QE `setupQEDtxContext`（`cdbtm.c:1732`）反序列化。可见性判断 `DistributedSnapshotWithLocalMapping_CommittedTest`（`:39`）三级缓存把本地 XID 映射到 GXID：L1 进程本地 `inProgressMappedLocalXids` → L2 `LocalDistribXactCache_CommittedFind` → L3 `DistributedLog_CommittedCheck`（持久化磁盘日志）。Reader QE 经 `SharedLocalSnapshotSlot` 共享 Writer QE 快照（`verify_shared_snapshot_ready` 强制 writer dump 后 reader 才用），`xminAllDistributedSnapshots` 早剪枝支持早期清理。

### AO 存储

Append-Only 存储用 64 位多态头部系统（位操作而非 C 位域，`cdbappendonlystorage_int.h:37` 的 `AOHeader`）：`SmallContent`（一个块容纳）、`LargeContent`（元数据头 + N 个 SmallContent 分片）、`NonBulkDenseContent`（列存无压缩）、`BulkDenseContent`（列存有压缩 128 位长头）。特点：append-only 写不原地 UPDATE/DELETE（新行追加、AO visimap 跟踪删改）、变长块（不像 heap 固定 8KB）、大内容跨块透明重组、块级压缩（`compressedLength`、不减时存非压缩）、块内 `rowCount`（不解压即可跳块，对列存扫描优化关键）、逻辑 EOF 快照一致（读用 `logicalEof` 防读未提交数据）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Locus 类型系统 + Motion 类型转换 | `cdbpathlocus.c` + `cdbpath.c:193` 决策矩阵 | 声明式 + 组合性 + 优化友好（collocation 跳过冗余 Motion） |
| Strategy 虚表（MotionIPCLayer） | `ml_ipc.h:36` 约 20 函数指针 + `ic_modules.c` 注册 | 互联传输协议可插拔（TCP/UDPIFC/Proxy），运行时 GUC 选择 |
| C 风格继承（CONTAINER_OF） | `ic_internal.h:23` MotionConn 基类 + TCP/UDP 派生 | C 无原生继承，首成员嵌入 + 宏实现多态分派 |
| Gang 工厂 | `cdbgang.c:107` `AllocateGang` + `pCreateGangFunc` | segment 进程组创建策略可插拔 |
| 两阶段提交 + 重试恢复 | `cdbtm.c:575` Phase2 指数退避 + `DtxRecovery` | 分布式原子性，in-doubt 事务可恢复 |
| 三级缓存可见性 | `cdbdistributedsnapshot.c:39` L1→L2→L3 | 本地 XID→GXID 映射热路径快、冷路径持久 |
| Chunk 类型状态机 | `cdbmotion.c` `addChunkToSorter` TC_WHOLE/PARTIAL_*/END_OF_STREAM | 变长 tuple 跨网络分块重组 |
| 直接派发优化 | `cdbtargeteddispatch.c:390` `DirectDispatchInfo` | 谓词算目标 segment，避免向无关 segment 派发 |

## 模块间交互

cdb 是连接 optimizer/executor/postmaster 的中枢。**被 optimizer 调**：`cdbllize_adjust_top_path`/`cdbllize_build_slice_table`（standard_planner 各阶段）、`cdbpath_motion_for_join`/`cdbpath_create_motion_path`（join 路径生成）、`choose_grouping_locus`/`add_second_stage_hash_agg_path`（两阶段聚合）。**被 executor 调**：`SendTuple`/`RecvTupleFrom`/`SendEndOfStream`（`nodeMotion.c` 的 Motion 节点执行）、`CdbDispatchPlan`（`execMain.c` 派发计划到 segment）。**被 xact.c 调**：`prepareDtxTransaction`/`notifyCommittedDtxTransaction`（CommitTransaction 提交分布式事务）。**依赖 postmaster**：postmaster 启动 QE 后端进程、cdbgang 经 libpq 连这些进程、`ic_proxy_bgworker` 作 bgworker 每 segment 启一个 proxy。**依赖 access/storage**：AO 存储读写直接调 `cdbappendonlystorage*`、`DistributedSnapshot` 用于本地 MVCC 可见性判断、interconnect 用 socket/共享内存、分布式事务用 WAL 和共享内存。与 [fts](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/06-fts) 协作：dispatcher gang 创建前查 `FtsIsSegmentDown`/失败 `FtsNotifyProber`，FTS 更新 catalog → `status_version++` → dispatcher 重建 gang。

## 扩展方式

- **新增一种 Locus 类型**：在 `cdbpathlocus.h` 的 `CdbLocusType` 加枚举值 + `CdbPathLocus_IsXxx`/`MakeXxx` 宏；在 `cdbpathlocus.c` 更新 `cdbpathlocus_equal`/`cdbpathlocus_join`/`cdbpathlocus_is_valid`/`cdbpathlocus_pull_above_projection`；在 `cdbpath.c:193` 的 `cdbpath_create_motion_path` 决策矩阵加新类型转换；在 `cdbpathtoplan.c:27` 的 `cdbpathtoplan_create_flow` 加 Locus→Flow 映射。
- **新增一种 Motion 类型**：在 `plannodes.h:1636` 的 `MotionType` 加枚举值；在 `cdbmutate.c` 仿 `make_hashed_motion`（`:100`）/`make_broadcast_motion`（`:137`）加 `make_xxx_motion` 构造函数；在 `cdbpath.c:193` 加创建逻辑；在 `cdbmotion.c` 的 `SendTuple` 加路由、`addChunkToSorter` 加接收；在 `nodeMotion.c` 加 `ExecMotion` 逻辑（待核实确切路径）；必要时改 `contrib/interconnect/ic_common.c` 的 `SendTupleChunkToAMS` 路由。
- **修改/新增 interconnect 传输层**：改现有协议（如优化 UDP 拥塞）改 `udp/ic_udpifc.c` 的 `SendChunkUDPIFC`（`MotionConnUDP` 的 `rttvar`/`cwnd`/`ssthresh`）；新增协议（如 RDMA）新建 `contrib/interconnect/rdma/` 实现 `MotionIPCLayer` 全部函数指针、在 `ic_modules.c` 建 `rdma_ipc_layer` 常量并 `RegisterIPCLayerImpl` 注册、在 `cdbvars.h:292` 加 `INTERCONNECT_TYPE_RDMA`、在 `guc_gp.c` 更新 `gp_interconnect_type` 可选值；改 Proxy 路由改 `proxy/ic_proxy_router.c`/`ic_proxy_peer.c`/`ic_proxy_backend.c`。
