---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "RootCoord 元数据"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "Go", "etcd", "TSO"]
description: "Milvus RootCoord 解读——v2.6 的 DDL 广播 + Ack 回调架构、WAL 全序串行化、etcd 写序换原子性、TSO 时间戳 Oracle（移植 TiKV PD）与 mixcoord 合体设计"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

`internal/rootcoord/`（61 文件 24K 行）+ `internal/tso/` + `internal/metastore/` 构成全局元数据层。v2.6 最重大的变化在这里：**DDL 执行模型从"内存任务队列"迁移到"WAL 广播 + Ack 回调"**——旧模型（≤2.5）的 scheduler 串行队列在任务 Execute 里同步调下游 RPC；新模型把 DDL 变成 broadcast 消息写入 streaming WAL，由 broadcaster 跟踪各 channel 的 ack 位图，全部 ack 后才触发回调写元数据。两个本质收益：**副作用顺序由 WAL 全序保证**（所有组件按同一顺序消费，跨 failover 一致），以及 **ack 回调可无限重试**（broadcast task 故障恢复后重放）——DDL 变成了幂等的分布式事务。

## 模块架构

`Core` struct（`rootcoord/root_coord.go:92`）：`meta IMetaTable`（内存缓存 + catalog 持久层）、`broker`（对 mixCoord 的 RPC 出口，v2.6 处于半退役——新代码大量直接用 `c.mixCoord`）、`ddlTsLockManager`（后台 DDL 时间戳水位）、`idAllocator`/`tsoAllocator`（etcd 全局分配器）、`quotaCenter`（1,786 行独立职责）、`tombstoneSweeper`（墓碑清扫）。**`mixCoord types.MixCoord` 自引用**：无论独立还是合体部署，rootcoord 都通过同一接口调用 datacoord/querycoord 能力。

## 核心实现

### DDL callbacks：v2.6 新架构

![DDL 广播机制](/vibe-reading/images/articles/milvus-internals/ddl-broadcast.svg)

`RegisterDDLCallbacks`（`ddl_callbacks.go:35`）把全部回调注册到 streamingcoord 的 registry：Collection 的 Create/Drop/Alter/Truncate、Partition、Database、Alias、RBAC 十一类——**一个 `ddl_callbacks_xxx.go` 文件一个 DDL**（共 17 个实现文件）。

**互斥从调度器锁迁到 WAL 资源键**（`ddl_callbacks.go:142-182`）：broadcast 前取资源键锁——collection DDL 取 `SharedDBName + ExclusiveCollectionName`（同库其它 DDL 可并行、同名 collection 串行），RBAC 取全局 Exclusive 键。锁随 `BroadcastAPI.Close()` 释放，且**持久化在 broadcast task 里**——跨 failover 的串行化保证，取代旧 scheduler 三级锁（Cluster→Database→Collection）只在单 leader 内存里的局限。

**幂等三防线**（因回调会被无限重试，幂等是正确性前提而非优化）：(a) broadcast 前置检查返回 `errIgnoredXxx` 哨兵（RPC 层转 Success）；(b) meta 层幂等（`AddCollection` 已存在即跳过，`meta_table.go:508`）；(c) catalog 写序（见下）。

### CreateCollection 完整流程

`CreateCollection`（`root_coord.go:892`）→ `broadcastCreateCollectionV1`（`ddl_callbacks_create_collection.go:40`）：取资源键锁 → Prepare（校验 shard 上限/库内配额/全局容量；`prepareSchema` 校验 + 注入系统字段 + 用户 field 从 `StartOfUserFieldID=100` 编号；**vchannel 由 streaming balancer 分配**——`snmanager.StaticStreamingNodeManager.AllocVirtualChannels`，`create_collection_task.go:458`）→ 幂等检查（已存在且 schema 全等返回 errIgnored）→ 构造消息 broadcast 到控制 channel + 全部 vchannel → ack 后 `createCollectionV1AckCallback`（:95）：每 vchannel 调 `mixCoord.WatchChannels`（datacoord 建 watch + 起点）、从 appendResult 组装 model（MessageID→start position）、`meta.AddCollection` 持久化、`ExpireCaches` 通知 Proxy。**querycoord 不参与 create**——load 是显式 lazy 操作。

### Drop 的级联与两阶段删除

`dropCollectionV1AckCallback`（`ddl_callbacks_drop_collection.go:72`）的嵌套广播体现 DDL 顺序语义：control channel ack 分支先广播 `DropLoadConfigMessageV2`（querycoord 释放）→ `DropIndexMessageV2`（索引清理）→ `meta.DropCollection`（etcd 标 Dropping）；每 vchannel ack 分支调 `DropVirtualChannel`（datacoord 清数据）。之后 `tombstoneSweeper.AddTombstone`：`ConfirmCanBeRemoved` 轮询 datacoord GC 完成后才 `Remove` 物理删除 etcd key——**两阶段 drop：先逻辑删再异步物理清**，故障恢复时 `restore()`（`root_coord.go:610`）扫描 Dropping/Creating 状态重建墓碑续传。

### etcd 写序换原子性

`kv_catalog.go` 的 `CreateCollection`（:178）：collection key + 每个 partition/field/function 各一个 key，**因 etcd txn 数量限制分批 MultiSave**，写序刻意"先 fields/partitions、最后 collection key"（:237-244 注释）——中途崩溃则 collection key 不存在、reload 不加载（DDL 重试完整重写，孤儿 key 会被覆盖）；key 已写则全部已持久化。这是 etcd 无跨批事务下的原子性技巧。

### TSO：移植自 TiKV PD 的时间戳 Oracle

`internal/tso/tso.go:66` 的 `timestampOracle`：混合时间戳 = 物理 ms（46bit）+ 逻辑（18bit，每毫秒最多 26 万个）。**租约式预借**：`saveInterval = 3s`——`InitTimestamp` 取 etcd 保存值（防时钟回拨的 guard），**立即保存 now+3s**；进程崩溃后新 leader 从 etcd 读到的是未来时间，绝不发重复 ts。`UpdateTimestamp`（:173）三约束（保存值单调、物理单调、物理 < 保存值）：逻辑数过半则物理 +1ms。`GlobalTSOAllocator.GenerateTSO`（`global_allocator.go:110`）CAS 风格分配：current 为 nil（等 leader SyncTimestamp）时 sleep 200ms 重试（maxRetryCount = 10）；logical ≥ maxLogical 且 LimitMaxLogic 时 sleep `UpdateTimestampStep`(50ms) 重试。单写者保证来自上层：整个 mixcoord 经 sessionutil 在 etcd 上 `ProcessActiveStandBy` 选举唯一 active（`coordinator/mix_coord.go:128-164`）。澄清：本目录**没有** PD 式 lease/watch 代码——etcd key 的"保存值 > 当前值"窗口就是事实上的故障租约。

### mixcoord：位置透明的合体

`mixCoordImpl`（`coordinator/mix_coord.go:53`）聚合 rootcoord.Core + querycoordv2 + datacoord + streamingcoord 于一个进程，`initInternal()`（:155）顺序：streamingCoord → rootcoord → (datacoord ∥ querycoord 并行)。**三个子协调者之间通信仍走 MixCoord gRPC 接口**（`SetMixCoord(s)` 注入自身）——代码路径与独立部署完全一致，**合体是部署形态而非代码形态**。收益：一个 session、一次选举；代价：可用性域合并（任一组件崩溃即整体 failover）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| WAL 广播 + Ack 回调 | `ddl_callbacks.go:35` | 幂等分布式事务：顺序 + 可重试 |
| 领域模型解耦 | `metastore/model/` 与 etcd proto 双向 marshal | meta 操作 model，存储格式可换（etcd/TiKV） |
| 写序原子性 | `kv_catalog.go:237` | etcd 无跨批事务的替代 |
| 自引用门面 | `Core.mixCoord` | 合体/独立部署的位置透明 |
| 两阶段删除 | tombstoneSweeper | GC 确认前的安全窗口 |

## 模块间交互

DDL 广播经 [StreamingCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/06-streaming) 的 broadcaster（本模块只注册回调）；`ExpireCaches` 通知 [Proxy](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/01-proxy) 失效缓存；`WatchChannels/DropVirtualChannel` 命令 [DataCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/03-datacoord)。TSO 的产物（时间戳）是全系统 MVCC 的锚——QueryNode 的 TSafe 等待、Proxy 的 guarantee_ts 计算都溯源到这。

## 扩展方式

**新增一种 DDL**（六处，v2.6 范式）：消息定义（streaming/util/message 的 BuilderV2 + Header/Body proto）→ registry 槽位（`specialized_callback.go` 的 messageAckCallbacks map）→ `ddl_callbacks_xxx.go`（广播函数 + ack 回调）→ RegisterDDLCallbacks 注册 → RPC 入口（`root_coord.go` + errIgnored 转 Success）→ metastore 三层（model/catalog/kv_catalog，注意写序）。新 DDL 天然获得 WAL 顺序、资源键互斥、故障重放、缓存失效——这正是 callback 架构想卖的。
