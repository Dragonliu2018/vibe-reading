---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "CDC 与 xCluster 复制"
date: "2026-09-23T00:15:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "C++", "CDC", "xCluster", "异步复制", "Debezium", "Virtual WAL"]
description: "YugabyteDB CDC 与 xCluster 复制层解读——两条通道一套基础设施（xCluster WAL 零转码 vs CDCSDK 语义格式）、cdc_state 普通表存 checkpoint、consumer 拉模型 + 心跳配置分发、防循环 external_hybrid_time 标记全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`src/yb/cdc/`（18k 行，cdc_service.cc 5964 行）+ master 侧的 `src/yb/master/xrepl_catalog_manager.cc`（6945 行）+ 新拆出的 `src/yb/master/xcluster/` 目录。**核心架构事实是"两条复制通道，一套基础设施"**：xCluster（集群间异步复制，DR 用）与 CDCSDK（Debezium/walsender 输出）共用 `GetChanges` RPC、stream 元数据、cdc_state checkpoint 表，只在三个维度分流（`CDCRequestSource`，cdc_service.proto:154）：记录格式（WAL 原始字节 vs 语义 RowMessage）、checkpoint 类型（IMPLICIT vs EXPLICIT）、消费端（consumer tserver vs 外部系统）。

## 模块架构

```
producer tserver                          consumer 侧
CDCServiceImpl (src/yb/cdc/cdc_service.cc:145)
  注册在 tserver (tablet_server.cc:794)
  GetChanges (:1622) ──按 source_type 分流──┬─ GetChangesForXCluster (xcluster_producer.cc:289)
                                            │    → consensus->ReadReplicatedMessagesForXCluster
                                            │      → LogCache 读 [from_op_id+1, committed] 区间
                                            └─ GetChangesForCDCSDK (cdcsdk_producer.cc:2686, 3411 行)
                                                 → IntentsDB + Virtual WAL 聚合排序

checkpoint: cdc_state 普通表 (system namespace)
  行键 (tablet_id hash, stream_id [, colocated_table_id])
  列: checkpoint, last_replication_time, data map
```

- **xCluster 消费端**：consumer master 驱动 setup → `XClusterPoller`（`src/yb/tserver/xcluster_poller.cc:325` 的 `DoPoll`）拉 GetChanges → `XClusterOutputClient` 按记录 key 路由到本地 tablet → 组装普通 WriteRequestPB 走 consumer 自己的 Raft
- **CDCSDK 消费端**：`cdcsdk_virtual_wal.cc` 的 Virtual WAL 跨 tablet 聚合排序，提供 **PG replication slot 语义**（`confirmed_flush_lsn`/`restart_lsn` 也持久化到 cdc_state）

## 调用链路

**xCluster 消费循环**（一条端到端异步复制）：

```
consumer master: XClusterTargetManager::SetupUniverseReplication (master/xcluster/xcluster_target_manager.cc:1276)
  → 每表一个 XClusterTableSetupTask
  → XClusterRpcTasks (master/xcluster_rpc_tasks.cc, 独立 YBClient + TLS)
     拉 producer schema → CreateCDCStream / BootstrapProducer
  → ComputeTabletMapping (xcluster_consumer_registry_service.cc:106)
     tablet 数相同 → 按 key range 1:1 映射（local_tserver_optimized）
     否则按 producer key range 中点匹配 consumer tablet
  → ConsumerRegistryPB 写入 consumer 的 ClusterConfig

配置分发: CatalogManager::FillHeartbeatResponseCDC (master/xrepl_catalog_manager.cc:6461)
  → tserver: TabletServer::XClusterHandleMasterHeartbeatResponse (tablet_server.cc:2414)
  → XClusterConsumer::HandleMasterHeartbeatResponse (tserver/xcluster_consumer.cc:306)
  → 后台线程 (1s) TriggerPollForNewTablets(:470)：本节点是 leader 的 consumer tablet 建 Poller

消费循环: XClusterPoller::DoPoll (xcluster_poller.cc:325)
  → CreateGetChangesRpc (cdc/xcluster_rpc.cc, 直连 producer tserver)
  → HandleGetChangesResponse → ApplyChanges
  → XClusterOutputClient (xcluster_output_client.cc:223) 按记录 key 路由
  → XClusterWriteImplementation (xcluster_write_implementations.cc:268)
     组装普通 WriteRequestPB → consumer 自己的 Raft → 成功后推进 op_id_、UpdateSafeTime(:668)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
|---|---|---|
| `GetChangesForXCluster` | xCluster 变更抽取 | xcluster_producer.cc:289；从 LogCache 读区间 |
| `PopulateWriteRecord` | WAL 批转 CDCRecordPB | :86；**key/value 直接拷 WAL 原始编码**（:128 注释："avoid unnecessary deserializing... re-serializing"） |
| `PopulateTransactionRecord` | 事务记录 | :175；只为 APPLYING 状态生成 APPLY record |
| `GetChangesForCDCSDK` | SDK 语义抽取 | cdcsdk_producer.cc:2686；解码 RowMessage + schema/enum 缓存 |
| `UpdatePeersAndMetrics` | WAL 保留屏障 | cdc_service.cc:3486；60s 全表扫 cdc_state 取 min checkpoint |
| `ComputeTabletMapping` | tablet 映射 | xcluster_consumer_registry_service.cc:106 |
| `PopulateXClusterStreamEntryTabletMapping` | 注册表填充 | :44 |

</details>

## 核心实现

### checkpoint：普通 YCQL 表而非特殊存储

`cdc_state` 表定义在 `system` namespace 下（`kCdcStateYBTableName(YQL_DATABASE_CQL, kSystemNamespaceName, "cdc_state")`，cdc_state_table.cc:76）——**不是 sys_catalog、不是特殊 tablet**。行键 (tablet_id hash, stream_id [, colocated_table_id])，`CDCStateTableEntry`（cdc_state_table.h:73）含 checkpoint、`last_replication_time`、data map（`cdc_sdk_safe_time`、`confirmed_flush_lsn`、`restart_lsn` 等）。

**Why**：tserver（leader 会漂移）和 master 都能经 YBClient 读写，天然随 system namespace 的 tablet 分裂扩展。代价：WAL 保留屏障需跨 peer 传播——后台线程 `UpdatePeersAndMetrics`（:3486，默认 60s）按 stream 源类型分别取 min checkpoint（`ProcessEntryForXCluster` :2652），设置 tablet peer 的 `cdc_min_replicated_index`（`TabletPeer::set_cdc_min_replicated_index`，tablet_peer.cc:1295）——LogCache 不得 GC 更早 segment。stale 判定（1800s）防僵死流无限保 WAL。

### xCluster：WAL 原始字节零转码 + consumer 拉模型

producer 侧 `PopulateWriteRecord` 把 `KeyValueWriteBatch` 按 DocKey 拆成一行一个 `CDCRecordPB`，**key/value 直接拷贝 WAL 原始编码**——consumer 是本库 tserver，能直接吃 DocDB 编码，省一次解/序列化。这是与 CDCSDK（解码成语义化 RowMessage proto + schema 信息）的根本差异。

**拉模型 + 心跳配置分发**：producer 不维护 consumer 连接，只维护 cdc_state。配置变更（加表/split/pause）只改 consumer master 的 ClusterConfig（`ConsumerRegistryPB`），全集群经既有心跳通道增量下发，无需新 RPC 通道。poller 有空闲退避（`async_replication_idle_delay_ms`）与指数失败退避（xcluster_poller.cc:303-323），绑定 consumer tablet leader term（term 变了 MarkFailed 重建）。

### 防循环（bidirectional 的关键）

consumer 写请求打标 `set_external_hybrid_time(record.time())` + `set_xcluster_target_applied(true)`（xcluster_write_implementations.cc:281-283）；producer 的 `GetChangesForXCluster` 用 `EraseIf` 过滤带这些标的 WAL 条目（xcluster_producer.cc:375-383）——**双向复制时变更不会被弹回源集群**。

### 事务一致性窗口

`GetChangesForXCluster` 的 apply_safe_time 机制（:318-360 完整注释）：先 `ResolveIntents`，记录 `last_apply_safe_time` 与 `apply_safe_time_checkpoint_op_id`（= majority_replicated_index），仅当 checkpoint 越过该 op id 才在响应中下发 `safe_hybrid_time`——保证 consumer 看到的 WAL 中事务已全部 apply。另有 `ValidateAutoFlagsConfigVersion` 防跨版本复制不兼容。

### Tablet split 的双向处理

producer split 由 `UpdateChildrenTabletsOnSplitOpForXCluster`（cdc_service.cc:5300）把子 tablet 的 cdc_state checkpoint 设为 split op id——无缝续传；consumer 侧 `UpdateConsumerOnProducerSplit`（xrepl_catalog_manager.cc:4817）重算 tablet 映射（split 后按 key 中点匹配）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 策略分流 | `StreamMetadata::GetSourceType()` 决定两条 producer 路径 | 一套 RPC 面服务两种消费者 |
| 注册表 | `ConsumerRegistryPB` 挂在 ClusterConfig | 心跳通道复用、增量下发 |
| 适配器 | `XClusterOutputClient` 把 CDC 记录转回 WriteRequestPB | consumer 复用完整写路径（含 Raft/事务） |
| 虚拟化 | Virtual WAL 聚合多 tablet 流 | 提供 PG slot 语义的单流抽象 |

## 模块间交互

- **与 Raft/WAL**：抽取源是 LogCache（见[Raft 共识与 Tablet](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/02-raft-tablet)）——`log_index_needed_by_cdc` 软下限参与 WAL GC 决策；xCluster 不是 Raft peer，是跨 universe 的 leader-to-leader poll
- **与 master**：stream 生命周期在 `xrepl_catalog_manager.cc`（`CreateCDCStream` :1043）；新 xCluster 2.0 管理已拆到 `src/yb/master/xcluster/`（source/target manager、safe time service、DDL replication 任务族）——这个目录拆分本身就是"老 god file 偿还"的活案例
- **与 tserver**：CDCService 注册在 tserver（`RegisterService(FLAGS_xcluster_svc_queue_length, ...)`）；master 也可启用（服务 sys_catalog 轮询）
- **与 YSQL**：CDCSDK 的 roadmap 方向是 PG Publication/Replication slot API（issue #18724）；consumer master 的 `XClusterSafeTimeService` 计算 namespace 级 safe time 支撑 YSQL staleness-consistent read

## 扩展方式

**新增 CDC 输出格式**：`CDCRecordFormat` 枚举（cdc_service.proto:148）+ `GetChangesResponsePB` 扩展；xCluster 格式改 `xcluster_producer.cc` 的 `Populate*Record` 族；CDCSDK 格式改 `cdcsdk_producer.cc` 的 RowMessage 填充族（`FillDDLInfo` :740、`FillBeginRecord` :1801 等）。旧 gRPC JSON connector 在 `java/yb-cdc`，Debezium connector 在独立 repo。

**新增 cdc_state 列**：`CDCStateTableEntry` + 列名常量 + 兼容处理（该表无 schema 迁移，靠覆盖 upsert）。

**改 poller/apply 行为**：`tserver/xcluster_poller.cc` / `xcluster_output_client.cc` / `xcluster_write_implementations.cc`。
