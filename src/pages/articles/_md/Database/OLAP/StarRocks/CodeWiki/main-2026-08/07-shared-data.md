---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "存算分离"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "存算分离", "shared-data", "对象存储", "StarOS", "LakeTablet", "StorageVolume"]
description: "StarRocks 存算分离架构：副本概念的删除、TabletMetadata 文件链版本提交、LakePersistentIndex 与 FE 触发的 compaction。"
readingTime: "17 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

3.0 起的 shared-data 架构全链路：FE 侧 `lake/`（LakeTable/LakeTablet/StarOSAgent）与 `storagevolume/`，BE 侧 `be/src/storage/lake/`（60+ 文件）与 `compute_env/`（starlet/starcache 无盘执行环境），协议在 `gensrc/proto/lake_types.proto`（715 行）与 `lake_service.proto`。它独立成篇的根本原因：**这套体系把"副本"概念整个删掉了**——版本从"FE 内存里的 Replica 状态"变成"对象存储里 version 编号的 TabletMetadata 文件链"，这是与 shared-nothing 完全不同的一套存储语义。

## 模块架构

共享与不共享的边界：

| | shared-data 下的归属 |
| --- | --- |
| 共享 | 数据（segment、TabletMetadata、TxnLog、DelVector）全部在对象存储上，**TabletMetadataPB 也是对象存储上的普通文件**，任何 CN 都可读 |
| 不共享 | 本地只有 cache——CN 的 Block Cache（`compute_env/staros/starcache`）与 persistent index 的本地 SST（`lake_local_persistent_index.cpp`） |
| FE | 仍是元数据/事务中心：事务 commit、`publishVersion`、compaction 触发全由 FE 发起；但 tablet 的 rowset 列表、版本链不在 FE 内存 |

CN 是 BE 的演进而非独立形态：`lake::Tablet : BaseTablet` 与本地 `OlapTablet : BaseTablet` 同基类（`be/src/storage/lake/tablet.h:52`），同一二进制按 RunMode 走不同路径，`Tablet::belonged_to_cloud_native()` 区分。CN = 打开 lake 路径、关闭本地存储服务的 BE。

## 调用链路

### 对象存储键布局与读写路径

BE 侧 `lake/tablet.h` 的读写围绕键布局：`metadata_location(version)`/`txn_log_location(txn_id)`/`segment_location()`/`delvec_location()` 全部经 `LocationProvider`（`starlet_location_provider.h`，从 StarOS worker 取 shard 的存储路径）拼接。写路径 `new_writer()` 写 segment + `put_txn_log()`（TxnLog 也是对象存储文件）；读路径 `get_metadata(version)` → `get_rowsets()` **即时打开 Rowset，不维护本地 rowset 树**。`set_version_hint()` 用来减少 listObject 开销（metadata 版本探测昂贵，注释 :170-179）。

### 版本提交（"publish"协议）

```text
1. CN 写数据 + put_txn_log（TxnLog 落对象存储）
2. FE commit（GlobalTransactionMgr）
3. FE 调 lake/Utils.publishVersion()（baseVersion→newVersion）让 CN 执行 publish：
     CN 重放 TxnLog → 生成 version+1 的 TabletMetadataPB 写回对象存储
     ——可见性由 metadata 版本号原子切换，没有 per-replica publish RPC 与内存版本推进
4. 批量优化：publishVersionBatch + file bundling
     FE 用 LakeAggregator.chooseAggregatorNode() 选聚合 CN
     （优先已持有该批某 tablet 的节点，避免 staros worker cache miss 引发额外 get_shard_info RPC）
     由它代写整批 BundleTabletMetadataPB / CombinedTxnLogPB（aggregate_publish_version RPC）
```

`PartitionPublishVersionData.java` 是 FE 侧把同一 partition 一批事务打包传给 publish 的数据结构。checkpoint 在此体系分两层：FE 的 image checkpoint 不变（含 `StorageVolumeMgr.save/load`，:538）；对象存储层用 `lock_tablet_metadata`/`unlock_tablet_metadata`（proto :667-668）在 vacuum/backup 时锁版本作快照点。BE 的版本回放按 `txn_vlog_location(version)` 串 TxnLog 与 metadata 版本链。

## 核心实现

### StorageVolume 抽象（`server/StorageVolumeMgr.java`）

- 类型常量：`S3`/`AZBLOB`/`ADLS2`/`GS`/`HDFS`（:71-79）；`validateLocations()`（:502）用 URI scheme 与 svType 严格匹配，HDFS 用正则放行任意 FS scheme（S3A、viewfs 等）。
- 绑定层级：db/table → volume（`bindDbToStorageVolume`/`bindTableToStorageVolume` + 反向索引）；建表未指定落 `defaultStorageVolumeId`，老版本升级回退 `builtin_storage_volume`。
- `createStorageVolume`（:121）三段式：读锁预检 → **锁外**连通性检查（`StorageVolumeAccessChecker.check`，避免慢端点卡 DDL）→ 写锁重检后持久化。ALTER 不可改 type/locations，仅 `replaceStorageVolume`（:287 运维命令）可换。
- 凭证走 `CloudConfigurationConstants` 的 param（PARAM_NAMES 反射收集），FE 的 cloud config 下发为 StarOS `Fslib` 配置供 BE 使用（待核实：具体下发链路在 StarOSAgent/StarMgrMetaSyncer）。

### LakeTablet（`lake/LakeTablet.java:42 extends Tablet`）

注释明说 "Data replicas are managed by object storage and compute replicas are managed by StarOS through Shard. **Tablet id is same as StarOS Shard id**"（`getShardId()` 直接返回 id）。`getBackendIds(ComputeResource)`（:162）不返回固定副本集，而是查 `WarehouseManager.getAllComputeNodeIdsAssignToTablet()`——任意存活 CN 都是潜在 "replica"，由 warehouse/cngroup 决定；`getAllReplicas` 是动态构造的虚拟 Replica 列表。`LakeTable.java:58 extends OlapTable` 复用表模型，额外持 `StorageInfo`（FilePathInfo + DataCacheInfo）。

### Lake 主键与 compaction（BE 侧）

- **LakePersistentIndex**（`lake_persistent_index.h:46 : PersistentIndex`）：memtable + inactive memtables + 多代 `_sstable_filesets`（SST 存对象存储，本地可 cache）。关键接口 `upsert/erase(n, keys, values, old_values, del_rssid)`——erase 打 `del_rssid`（rowset_id+op_offset）作 rebuild 点；`bulk_erase()` 直接 ingest 导入期预生成的 tombstone SST。索引合并 `major_compact`/`parallel_major_compact`（产出 OpCompaction txn log），`assign_generation_versions()` 给 SST 打 generation version 供 vacuum 保留判断。行级删除投影即 DelVector（`lake_delvec_loader.cpp` 按 version 加载），替代 shared-nothing 的本地 delete bitmap。
- **Compaction 触发方是 FE**：`lake_service.proto:662` 的 `compact`/`aggregate_compact` RPC；CN 侧 `lake/compaction_scheduler.h:132` 用非阻塞无界队列（注释："rely on the FE to limit the number of compaction tasks"）+ `Limiter` 按 `Status::MemoryLimitExceeded` 自适应降并发（:280-339），任务经 `CompactionTaskCallback::finish_task` 回 FE，compaction 本身也是一个事务（写 TxnLog 的 `OpCompaction`，`is_txn_still_valid()` 防白干）。产物经 publish 合入新版本，旧文件 `vacuum`/`vacuum_full` 清理。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| LocationProvider 抽象 | `starlet_location_provider.h` | 把"存哪"与"怎么读写"解耦——新后端只动 Fslib 寻址层 |
| 双 RunMode 同基类 | `lake::Tablet : BaseTablet` | 一套二进制两种部署形态 |
| 聚合者模式 | `LakeAggregator.chooseAggregatorNode()` | 批量 publish 的 IO 收敛 |
| 虚拟 Replica | `LakeTablet.getAllReplicas` | 兼容旧接口（调度器仍要 Replica 列表），语义换血 |

## 模块间交互

- FE 侧挂 [02 元数据](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/02-catalog-ha)（`LakeTable extends OlapTable`），但有**独立元数据域** `staros/StarMgrServer`（`starmgr_` 前缀 journal，同 BDBEnvironment 不同 Database），由 [01 FE 骨架](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/01-fe-server) 启动。
- 事务协调复用 [08 Load](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/08-load) 的 `GlobalTransactionMgr`（`LakeTableTxnStateListener`）；BE 侧存储原语与 [11 Tablet 存储](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage) 共享 `storage_primitive/`；Lake compaction RPC 走 [12 BE 服务](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/12-be-service) 的 `LakeServiceImpl`。

## 扩展方式

**新增一种对象存储后端**（三处）：(a) FE `StorageVolumeMgr` 的类型常量与 `validateLocations()` switch（:507-524）加新 scheme；(b) FE `CloudConfigurationConstants` param + `StorageVolumeAccessChecker` 探测实现；(c) BE/StarOS Fslib 支持该 scheme——BE 文件访问统一走 `compute_env/staros/starlet_filesystem.cpp`（31.5K 适配层）与 `be/src/fs/` 的 FileSystem 抽象（`fs_s3.cpp`/`fs_posix.cpp`/`fs_scheme.cpp` 注册表）。新后端无需触碰 lake/ 的版本、compaction、persistent index 逻辑——这正是 LocationProvider + Fslib 分层的收益。
