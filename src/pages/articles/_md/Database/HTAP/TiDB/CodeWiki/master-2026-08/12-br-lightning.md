---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "备份恢复与导入工具"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "BR", "Lightning"]
description: "TiDB BR 与 Lightning 解读：KV 层 SST 备份、恢复三阶段、PITR log backup 与物理/逻辑双导入模式"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`br/` 与 `lightning/` 是绕过 SQL 层的两条旁路：**BR** 在 KV 层做快照备份/恢复与 PITR（log backup），**Lightning** 做高速批量导入。两者都以 CLI 形态发布（`br`/`tidb-lightning`），但 BR 的 task 层经 `Glue` 抽象还能以 `BR BACKUP` SQL 语句嵌入 tidb-server 进程运行（复用 Domain）。本快照的关键变化：Lightning 的 local backend（SST 物理导入）已抽到 `pkg/ingestor`（见 [11-ingestor-dxf](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/11-ingestor-dxf)），Lightning 与 `IMPORT INTO` 共享同一导入引擎。Dumpling（`dumpling/`）是独立导出工具，走 SQL 层 `SELECT`，与 BR 无代码复用。

## 模块架构

```
br/pkg/
├── task/               # CLI 命令入口层：RunBackup（backup.go:392）/ RunRestore / RunStreamStart...
├── backup/            # 备份客户端：Client.BackupRanges（client.go:1144）+ metautil/（backupmeta）
├── restore/
│   ├── snap_client/   # 快照恢复：CreateTables / RestoreTables / tikv_sender
│   ├── log_client/    # PITR 日志恢复客户端（client.go:166）
│   ├── data/ split/   # EBS 恢复 / region split
│   └── restorer.go    # SimpleRestorer/BatchRestorer/MultiTablesRestorer（:156/:224/:302）
├── stream/ streamhelper/    # log backup 元数据 + checkpoint 推进守护
├── glue/ gluetidb/ gluetikv/   # 宿主抽象：嵌入 TiDB vs 独立 CLI
└── conn/              # PD/TiKV 连接管理
lightning/pkg/
├── server/ importer/ checkpoints/ errormanager/ precheck/   # 入口层与导入编排
pkg/lightning/         # 引擎层（从 lightning/ 迁入）：
├── mydump/            # 数据源解析（CSV/SQL dump）
└── backend/
    ├── backend.go     # Backend/EngineManager 接口（:193）
    ├── tidb/          # 逻辑后端：KV 逆转回 SQL 执行（kv2sql.go）
    └── (local → pkg/ingestor/ingestctrl)
```

## 调用链路

**BR 全量备份**（`RunBackup` in `br/pkg/task/backup.go:392`）：

```
NewMgr（连 PD）→ backup.NewTableBackupClient → SetStorageAndCheckNotInUse（锁文件防双写）
→ GetTS 取快照 TS → Client.BackupRanges (client.go:1144)
    ├─ BuildProgressRangeTree（全局进度树）
    └─ 对每个 TiKV store 建 gRPC BackupClient → startBackup
        # TiKV 在 raft snapshot 上扫描 range，直接把 SST 写入对象存储
        # client 端只收 metadata/checksum；store 掉线由 StateNotifier 触发重发
→ metautil.MetaWriter 写 backupmeta（metafile.go:838）
```

**BR 快照恢复**（`task/restore.go:1874` 起）：

```
SnapClient.CreateTables (snap_client/client.go:1168)   # DDL 重建表 + AllocTableIDs 预分配 ID
→ RestoreTables (tikv_sender.go:281) 三阶段：
   ① SortAndValidateFileRanges   # 合并 SST 边界 + checksum
   ② SplitPoints → split.RegionSplitter.ExecuteSortedKeys   # PD split & scatter
   ③ RestoreSSTFiles (:460) → restorer 的 GoRestore pipeline
       # 每个 SST：GetRewriteRules（t_oldID→t_newID 前缀重写，restore/utils/rewrite_rule.go:188）
       #   → TiKV ImporterClient download & ingest
```

**Lightning 物理导入**（local backend）：

```
Controller.Run (lightning/pkg/importer/import.go:590)   # 显式 pipeline
  setGlobalVariables → restoreSchema → preCheckRequirements → initCheckpoints
  → importTables → fullCompact → cleanCheckpoints
└─ TableImporter.importTable (table_import.go:118)
    ├─ importEngines (:458) → preprocessEngine (:660)
    │    # mydump 解析 → encode.EncodingBuilder 编码 KV → 写本地 pebble Engine
    └─ importEngine (:955) → Backend.ImportEngine（→ pkg/ingestor/ingestctrl）
         split/scatter region → regionJob 状态机：doWrite（gRPC 写 KV 生成 SST）→ doIngest
```

| 结构 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Controller` in `import.go:199` | Lightning 导入编排 | worker 池分表/索引/region 三类 |
| `Backend` 接口 in `backend/backend.go:193` | 导入引擎抽象 | local/tidb 双实现可切换 |
| `SimpleRestorer/BatchRestorer` in `restorer.go` | SST 恢复策略 | 表数量级不同走不同 pipeline |
| `Glue` in `glue/glue.go:25` | 宿主抽象 | 同一 task 层，CLI 与嵌入两种形态 |

## 核心实现

### BR 为什么走 KV 层而非 SQL 层

SQL 层导出（`SELECT` + 写文件）有两个硬伤：跨表一致性快照无法保证（每个查询是独立快照）、吞吐被事务层限死。BR 的做法：`GetTS` 取全局 snapshot TS（TSO 保证一致），TiKV 在 **raft snapshot 上扫描**并把 SST 直接写入对象存储——数据面完全绕过 TiDB，一致性靠 TSO + GC safepoint。防 GC 有两道：`Client.GetTS` 内 `CheckGCSafePoint`（`br/pkg/gc/safepoint.go`）先校验目标 TS 未被回收；备份期间由 `StartServiceSafePointKeeper` 起一个**service safepoint 守护**（`BRServiceSafePoint`，`MakeSafePointID` 生成唯一 ID）周期性向 PD 续约（`globalManager.SetServiceSafePoint`，keyspace 场景走 `manager_keyspace.go` 的 `keyspaceManager`），进程退出即释放——比粗放地调大 `tikv_gc_life_time`（旧路径 `increaseGCLifeTime` 的做法）精确且不影响全集群。备份目标目录还写 `backup.lock` 锁文件（`metautil` 定义，`SetLockFile` in `client.go:525`）防止两个 BR 任务写同一目录。代价是恢复期必须做 **key 重写**（备份 SST 的 key 含原 table ID，恢复的目标集群分配新 ID——`GetRewriteRules` 的 `t_oldID→t_newID` 前缀替换）与 checksum 校验（range 树聚合）。

### Lightning 双后端：物理 vs 逻辑的取舍

`import.go:352-458` 的 switch 按 config 选择：**local**（物理）绕过 SQL/事务层直接 ingest SST——快，但需要本地磁盘排序、切 TiKV import mode、协调 region split，且受 TiKV 版本约束；**tidb**（逻辑）把编码的 KV **逆转回 SQL**（`backend/kv/kv2sql.go`）按事务执行——慢，但兼容性好（可写入不支持 ingest 的下游、更易排错）。统一的 `Backend`/`EngineManager` 接口让上层编排（Controller 的表级并行、checkpoint 断点续传在 `lightning/pkg/checkpoints`）对两种后端无感。

### PITR：log backup 与 checkpoint 推进

全量快照只能恢复到备份时刻，PITR 补上"任意时间点"：TiKV 侧持续运行 KV event 流（event store，本仓库外），BR CLI 只做发号施令（`RunStreamStart`/`RunStreamStop`/`RunStreamTruncate` in `task/stream.go:601/791/1142`）。TiDB 侧的关键角色是 `domain.go:977-982` 内嵌的 `streamhelper.NewTiDBCheckpointAdvador`：经 etcd owner 选举的全局 checkpoint 推进者——把"已可回放到的位置"周期性落盘，恢复时 `RunStreamRestore`（`task/stream.go:1370`）校验 `checkLogRange` 无 gap，先恢复全量再回放日志区间；DDL 期间的表结构变更由 `rewrite_meta_rawkv.go` 处理重命名。

### glue：一套代码两种宿主

`Glue` 接口（`glue/glue.go:25`：`GetDomain/CreateSession/Open/StartProgress`）隔离了"独立 CLI 进程"与"嵌入 tidb-server"两种运行形态：`gluetidb` 实现复用进程内 Domain（`BR BACKUP` SQL 语句走这条路），console glue 用于独立 `br` 命令。这让 task 层（`br/pkg/task/`）完全不知道自己跑在哪——与 [10-server](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/10-server) 的 `TiDBContext` 防腐是同一思想的工具侧版本。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `switch cfg.TikvImporter.Backend` in `import.go:352` | 物理快/逻辑稳，配置即换 |
| Pipeline | `Controller` 的阶段切片；`PipelineRestorerWrapper[T].WithSplit` in `restorer.go:423` | 阶段显式可断点（checkpoint） |
| 防腐/宿主抽象 | `Glue` in `glue/glue.go:25` | CLI 与嵌入复用 task 层 |
| Owner 选举 | log backup checkpoint advador in `domain.go:977` | 全集群单点推进（复用 pkg/owner） |

## 模块间交互

TiKV gRPC：备份走 `backuppb.BackupClient`；恢复/导入走 `import_sstpb`（download/ingest）；`ingestctrl` 走 `ingestcli`。PD：region split/scatter（`split` 包）、恢复期临时 placement rule（`tikv_sender.go`）。对象存储：全部经 `pkg/objstore`（新增后端 BR/Lightning 零改动，见 [11-ingestor-dxf](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/11-ingestor-dxf)）。与 TiDB 内核：BR 恢复用内部 session 执行 DDL 重建表（`CreateTables`）；log backup 的 checkpoint 守护住在 Domain 里与 DDL owner 并列。

## 扩展方式

新增备份存储后端：实现 `pkg/objstore` 的新 backend（模板 `azblob.go`）+ `parse.go:60` 注册 scheme——task 层 `objstore.ParseBackend(cfg.Storage...)` 自动生效；对象锁语义需在 `backup/client.go` 的 `SetStorageAndCheckNotInUse`/`SetLockFile`（:525）适配。新增 Lightning 后端：实现 `pkg/lightning/backend/backend.go` 的 `Backend` + `EngineManager`，在 `import.go:352` switch 加 case。改 backupmeta 格式：`br/pkg/metautil/metafile.go`（MetaWriter :838）+ `backupmetas`。
