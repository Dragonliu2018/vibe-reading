---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "Master 集群管理"
date: "2026-09-23T00:20:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "C++", "Master", "系统目录", "负载均衡", "Online Schema Change", "Tablet Split"]
description: "YugabyteDB Master 集群管理层解读——sys catalog 就是一个普通 DocDB Raft tablet（pg_catalog 行也存里面）、COW 实体 + staged commit、领导者栅栏三件套、先加后删的负载均衡、四阶段 index backfill 状态机全解"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`src/yb/master/`（约 116k 行）是集群的大脑——系统目录、tablet 元数据、分裂与均衡调度、online schema change 驱动。god node 数据（graphify AST）：**CatalogManager 808 度**、TableInfo 133、SysCatalogTable 111、XClusterManager 107、ClusterLoadBalancer 100。`catalog_manager.cc`（14921 行）是全库最大文件，**没有 Pimpl/Impl 嵌套类**——god file 的组织方式是按领域拆伴生文件 + 18 个 friend class 白名单（catalog_manager.h:1953-1971 的 TODO 自认："Get rid of these friend classes and introduce formal interface"）。模块正在持续解体：已拆出 `xcluster/`、`ysql/`、`clone/` 三个子目录。

## 模块架构

### 类层次

- **`CatalogManagerIf`**（catalog_manager_if.h:62，363 行）：纯虚接口约 90 个方法。**用途是可测试性**（mini_cluster 注入假实现）——不是给 pgsql 层的接口（pgsql 层走 RPC）
- **`CatalogManager`**（catalog_manager.h:250）：继承 CatalogManagerIf + SnapshotCoordinatorContext。伴生文件分工：

| 文件 | 行数 | 职责 |
|---|---|---|
| `catalog_manager.cc` | 14921 | 领导者生命周期、CRUD、split、系统表 |
| `xrepl_catalog_manager.cc` | 6945 | XClusterManager 三合一实现 |
| `backfill_index.cc` | 1841 | MultiStageAlterTable + Backfill 编排 |
| `catalog_manager_bg_tasks.cc` | — | 后台任务循环（RunMasterTasks） |

### 实体树（catalog_entity_info.h，1787 行）

两层基类（catalog_entity_base.h）：`Persistent<DataEntryPB>`（sys catalog 里的 proto 行）→ **`MetadataCowWrapper`**（:68）——把 proto 装进 `CowObject`，`LockForRead()/LockForWrite()`，**写锁拿到 dirty 副本，写盘成功后 `l.Commit()` 才对读方可见**。实体：`TabletInfo`（:306，反向持 TableInfo + replica_locations）、`TableInfo`（:663，133 度）、NamespaceInfo、RoleInfo、CDCStreamInfo、SnapshotInfo、`ClusterConfigInfo`（SingletonMetadataCowWrapper）等。

索引层（catalog_manager.h:2483-2496，全部 GUARDED_BY(mutex_)）：`VersionTracker<TableIndex>`——boost::multi_index（TableId 唯一 + IsSecondaryTable 哈希让 LB 跳过 colocated 表）；`VersionTracker` 的 `CheckOut()` 提供无锁读旧版本快照。

## 核心实现

### 系统目录 = 一个普通 DocDB Raft tablet

最重要的架构事实：**sys catalog 单 tablet 全零 ID**（`kSysCatalogTabletId = "00000000000000000000000000000000"`，sys_catalog_constants.h），表名 `sys.catalog`，schema 是三元组 KV：`(entry_type, entry_id) -> metadata`。`SysCatalogTable::CreateNew`（sys_catalog.cc:376）构造 RaftGroupMetadata，master 进程内嵌完整 tserver 栈（`MasterTabletServer` + ConsensusServiceImpl/RemoteBootstrapServiceImpl/PgClientServiceImpl，master.cc:302）——**写路径就是普通 `tablet_peer()->WriteAsync`**，和用户表完全相同的 DocDB/Raft 流水线。

**YSQL 的 pg_catalog 行确实存在 sys catalog tablet 里**（证据链）：`CatalogManager::CreateYsqlSysTable`（catalog_manager.cc:4080）把新 PG 系统表的 table_id 追加进 sys catalog tablet 的 `SysTabletsEntryPB::table_ids`——每张 pg 系统表的唯一 tablet 就是 sys catalog tablet（强制 colocation）；pggate 把 `pg_class`/`pg_attribute` 的 INSERT 经 master 的 PgClientServiceImpl 写进去；读侧 `SysCatalogTable::ReadPgClassInfo/ReadPgIndexBoolColumn`（sys_catalog.h:300-390）用 `DocRowwiseIterator` 直接读。初始集群时 master 拉起 postgres initdb，`InitialSysCatalogSnapshotWriter` 把初始 pg_catalog 写入。

### Master 高可用：sys catalog tablet 的 leader 就是 leader master

Master 集群的 Raft 组 = sys catalog tablet 这个 Raft 组（RF = `--master_addresses` 数量，通常 3）。leader 选举回调 `ElectedAsLeaderCb`（catalog_manager.cc:1215）→ `LoadSysCatalogDataTask`（:1248）三步：

1. `WaitUntilCaughtUpAsLeader`：等未提交元数据落定 + leader lease（超时 FATAL——注释 "TODO: Abdicate instead"）
2. `VisitSysCatalog`（:1472）：拿 `leader_mutex_` **写锁**（`PREFER_WRITING`）栅栏掉所有逻辑操作 → 清空内存 maps → `RunLoaders` 重放全部 sys catalog → `leader_ready_term_ = term`
3. `CheckIsLeaderAndReady`（:2246）三重校验：state、consensus leader_uuid、`leader_ready_term_ == current_term`——**"是 leader"和"目录加载完"是两件事**

**LeaderEpoch{leader_term, pitr_count}**（leader_epoch.h:32）：pitr_count 每次 PITR +1，防 PITR 前读到的旧 TableInfo 在恢复后写回覆盖恢复结果。

**Master follower 永不驱逐**（master_main.cc:84-86 强制 `evict_failed_followers = false`、follower 不可用阈值 2h）：没有更高层给 master tablet 补副本——注释原话 "It's not turtles all the way down!"。灾难恢复（majority 丢失）无自动机制：`--emergency_repair_mode`（catalog_manager.cc:618）下 CatalogManager 不加载，只服务 `DumpSysCatalogEntries`/`WriteSysCatalogEntry` 两个 RPC 供 yb-admin 手工修。

### Tablet 调度：双相位分裂阈值 + 先加后删均衡

**Split**（无 merge——本快照 master 中无 merge 调度器）：`CatalogManagerBgTasks::RunMasterTasks`（1000ms 一轮）→ `TabletSplitManager::DoSplitting`（tablet_split_manager.cc:855）。候选判定 `ShouldSplitValidCandidate`（catalog_manager.cc:3095）用 **双相位阈值**：tablet/server 低于 low-phase shard 数时只需超 low 阈值、介于两者之间需超 high 阈值、超 high shard 数则 force-split。执行 `DoSplitTablet`（:3398）：`SplitScope` RAII 下**先在 sys catalog 注册子 tablet**（write-ahead metadata，`children_already_registered` 幂等重试——任意一侧崩溃都能恢复），再发 `AsyncSplitTablet` RPC 让 tserver 做真正的 DocDB split。

**均衡**（cluster_balance.cc，模型是三层 per-run 状态：Options/PerRunState/PerTableLoadState）：`RunClusterBalancerWithOptions`（:373）的两阶段移动是核心安全设计——**先加后删**：move = 目标机先加 PRE_VOTER（宁可暂时 over-replication），之后轮次再从源机删——**杜绝瞬间 under-replication**。leader 均衡独立（affinitized zone 内 + 跨优先级两级）；全局均衡门控 `can_perform_global_operations_` 仅当所有表自身均衡后才允许跨表搬（避免小表饿死大表）。

**Placement**：`ReplicationInfoPB { live_replicas, read_replicas[], affinitized_leaders[] }`（common_net.proto:62），解析顺序表级 → YSQL tablespace → 集群级，`CatalogManager::GetTableReplicationInfo` 合并。

### Online Index Backfill：四阶段状态机

设计文档（architecture/design/online-index-backfill.md）核心：`DELETE_ONLY → WRITE_AND_DELETE → DO_BACKFILL(DB_REORG) → READ_WRITE_AND_DELETE`，状态存为 `IndexPermissions`（`SysTablesEntryPB` 的 `IndexInfoPB::index_permissions`），由 master 持久化并经 AlterTable RPC 复制到全部 tserver。

代码（backfill_index.cc 1841 行）：`MultiStageAlterTable::UpdateIndexPermission`（:198）**每次只推一步**；`ShouldProceedWithPgsqlIndexPermissionUpdate`（:148）推进前读 sys catalog 里的 `pg_index.indislive/indisready` 确认 PG 层没落后——**DocDB 元数据与 pg_catalog 行的双写同步**。`BackfillTable` 编排：等 split 收敛（期间禁分）→ `GetSafeTime` 等 pending 事务 → read_time 持久化 → 每 tablet `BackfillChunk`（checkpoint 重试，150 次上限）→ `AllowCompactionsToGCDeleteMarkers`（backfill 期间 index 表保 delete marker 不被 major compaction 回收）。`DdlRequesterLivenessTask` 监控发起 backfill 的 PG backend，死了就 abort。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Copy-on-write + staged commit | MetadataCowWrapper（catalog_entity_base.h:68） | 读方永远读到已提交版本，写失败回滚天然 |
| 接口抽象 | CatalogManagerIf（90 个纯虚） | 可测试性 |
| 栅栏 | leader_mutex_ 写锁 + leader_ready_term_ + LeaderEpoch 三件套 | reload 期间排除逻辑 RPC；PITR 防回写 |
| 状态机 | IndexPermissions 四阶段 + outstanding split 状态 | online DDL 的跨集群一致性 |
| 两阶段移动 | 均衡先加后删 | 永不 under-replicate |

## 模块间交互

- **与 tserver**：心跳（tablet report 上报 + split/balance/stepdown 指令下发）；split 执行经 `AsyncSplitTablet` RPC（见[Raft 共识与 Tablet](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/02-raft-tablet)）
- **与 pggate**：PG 系统表行经 master 的 PgClientServiceImpl 读写（见[PostgreSQL 查询层](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/06-ysql)）
- **与 xCluster**：CDC stream 生命周期 + split 双向处理在 xrepl_catalog_manager.cc（见[CDC 与 xCluster](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/07-cdc-xcluster)）；新 xCluster 2.0 已拆 `src/yb/master/xcluster/`
- **与快照/PITR**：SnapshotCoordinatorContext 继承；sys catalog 天然被快照机制覆盖

## 扩展方式

**给表加一个元数据字段**（参照真实提交 `36302f25f8` DDL savepoints、`2f89e3cd2c` reltuples）：

1. `src/yb/master/catalog_entity_info.proto`：`SysTablesEntryPB` 加字段（加 field number 不破坏旧数据）
2. `catalog_entity_info.h`：`PersistentTableInfo` 加 COW 层 accessor
3. DDL 可设则：`master_ddl.proto` + `catalog_manager.cc` 的 CreateTable/ProcessAlterTable 拷贝链 + `src/yb/client/client-internal.*` 构造器
4. 暴露给客户端：`master_client.proto` 的 TableInfoPB 及填充
5. tserver 需要：`master.proto` 的 TableInfoPB + 消费点
6. **Loader 无需改**（TableLoader 走通用 proto 解析）——这正是 KV 化 sys catalog 的收益
