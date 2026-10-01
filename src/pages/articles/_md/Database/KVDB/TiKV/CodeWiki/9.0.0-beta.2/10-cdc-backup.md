---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "CDC 与备份"
date: "2026-10-01T21:25:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "CDC", "ResolvedTS", "PITR", "Backup"]
description: "TiKV 变更数据生态：CDC observer + incremental scan、leader 推进的 resolved-ts、日志备份 PITR 流水线与快照备份/SST 导入。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

TiDB 的下游生态（TiCDC 增量同步、PITR 日志备份、BR 快照备份、Lightning 导入）都从 TiKV 取数。这组模块共同回答：**怎么在不干扰在线事务的前提下，把"已提交的变更"持续吐出去**。基础设施是三个共享概念：raft apply 后的 observer 钩子、resolved-ts 安全时间戳、外部存储抽象。独立成模块的原因：它们是"寄生"在 raftstore 上的观察者生态，与在线服务解耦演进。

## 模块架构

```text
components/cdc/src/
├── endpoint.rs    Endpoint（:467）：region 订阅管理
├── observer.rs    CdcObserver（:26）：挂 raftstore cmd observer
├── delegate.rs    Delegate（:711）：一 region 多 downstream
├── initializer.rs incremental scan + 增量合流
└── service.rs     gRPC change_data_event_feed
components/resolved_ts/src/
├── resolver.rs    Resolver（:78）：locks_by_key + lock_ts_heap
└── advance.rs     AdvanceTsWorker + LeadershipResolver
components/backup-stream/src/   日志备份（PITR）
├── endpoint.rs    Endpoint + SubscriptionTracer
├── observer.rs    BackupStreamObserver
├── router.rs      Router::do_flush（:725）合并临时文件 → external storage
├── event_loader.rs  initial scan
└── checkpoint_manager.rs  per-region checkpoint
components/backup/src/endpoint.rs   快照备份（BackupRange/BackupWriter）
components/sst_importer/src/sst_importer.rs   SstImporter（:149）下载/ingest
```

## 调用链路

### CDC 事件路径

```text
raft apply 线程 flush cmd batch
└─ CdcObserver::on_flush_applied_cmd_batch（observer.rs:101）
   # 过滤 ObserveLevel::All 后 schedule Task::MultiBatch（FIFO 保序）
└─ Endpoint::on_multi_batch（endpoint.rs:988）
   └─ Delegate::on_batch（delegate.rs:711，校验 batch.cdc_id 防 ABA）
      └─ sink_data 编码 ChangeDataEvent → Conn/channel.rs → gRPC 流
【注册时】Endpoint::on_register（endpoint.rs:789）
   ├─ 查 reader.txn_extra_op（写路径回填 old value 的钩子）
   ├─ 新建 Delegate + observer.subscribe_region
   └─ spawn Initializer::initialize：从 checkpoint_ts 起增量扫
      （先扫锁建视图，再扫数据，期间增量经 barrier 排序合流）
```

### resolved-ts 推进

```text
AdvanceTsWorker::advance_ts_for_regions（advance.rs:91）
├─ pd_client.get_tso() → cm.update_max_ts
├─ cm.global_min_lock_ts() 夹紧 min_ts
└─ LeadershipResolver::resolve（:235，跨 store check-leader 排除僵尸 leader）
   └─ Resolver::resolve（resolver.rs:415）
      resolved_ts = min(最老未决锁 start_ts, min_ts)，单调不减
      # 同时写入 RegionReadProgress 供 stale read 复用
```

### 日志备份（PITR）

```text
BackupStreamObserver::on_region_changed → ModifyObserve(Start)
└─ scan pool spawn_executors → InitialDataLoader::do_initial_scan
   （event_loader.rs:451，"scan to +inf TS"——宁多推不漏推）
└─ 增量 Task::BatchEvent → Router::do_flush（router.rs:725）
   合并 tempfiles → external storage（S3/GCS）
   CheckpointManager 推进 per-region 与 global checkpoint-ts
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `on_flush_applied_cmd_batch` in observer.rs:101 | apply 后抓变更 | FIFO 强序 |
| `Endpoint::on_register` in endpoint.rs:789 | 订阅 region | txn_extra_op 取 old value |
| `Delegate::on_batch` in delegate.rs:711 | 事件分发 | cdc_id 防陈旧 |
| `Resolver::resolve` in resolver.rs:415 | 算 resolved_ts | 单调不减 |
| `Router::do_flush` in router.rs:725 | 日志合流落盘 | tempfile 削峰 |
| `update_global_checkpoint` in endpoint.rs:962 | 全局水位 | per-region 聚合 |
| `SstImporter::download` in sst_importer.rs:1145 | SST 下载 | 多 master key 解密 |

</details>

## 核心实现

### Observer 挂钩与优先级协议

三个模块共用"挂 raftstore coprocessor"模式（注册点 `register_to`），但优先级有讲究：CDC 与 backup-stream 的 cmd observer 都用 priority 0（注释明言 "must have a higher priority than resolved-ts's"），resolved_ts 用 1000——保证 resolved_ts 收到的 batch 已被 CDC 处理过，否则 resolved_ts 先推进、CDC 后看到锁会推出矛盾结论。订阅管理用 `ObserveId` 唯一代号防 ABA（`unsubscribe_region` 校验，observer.rs:75-84）。

### resolved-ts 为什么在 leader 上推进

resolved_ts/src/lib.rs:3-16 文档明言 "Resolved TS must be advanced by the region leader **after it has applied on its current term**"：只有 applied 到当前 term 的 leader 才保证见过全部已提交日志；follower 视图可能缺锁信息，会推出错误的"无锁"结论。全局 resolved_ts 拖到所有 leader 的最小值，还需 `LeadershipResolver::resolve` 跨 store check-leader 排除僵尸 region（advance.rs:164）。`Resolver` 的锁视图（`locks_by_key` + `lock_ts_heap` + `large_txns` 大事务单独跟踪）与 `RegionReadProgress` 共享——resolved-ts 与 stale read 是同一套安全水位基础设施的两个消费者。

### CDC 为什么用 apply observer 而非解析 WAL

RocksDB WAL 无事务语义（区分不了 commit/rollback，也没有 resolved-ts 配套的锁视图时机），而 raft apply 是事务提交顺序的唯一权威点。同时借 `txn_extra_op` 在写路径顺带取 old value 免二次读——代价是 CDC cmd observer 优先级必须最高（见上）。

### 背压与隔离

CDC sink 用 `sink_memory_quota`、扫描用 `scan_concurrency_semaphore` + 双 Limiter（`incremental_scan_concurrency_limit` 拒绝注册防 OOM，issue #16035）；backup-stream 用 `tempfiles` 先落盘再上传削峰内存。`old_value_cache` 缓存更新前值。

### 日志备份的 per-region checkpoint

`CheckpointManager` per-region 记录进度：任务重启/failover 时各 region 从自己的 checkpoint_ts 续扫，不需全局对齐到最老进度；failover 时保守冻结 checkpoint，等新 leader 确定后再选安全 from_ts（`Task::MarkFailover` 注释，endpoint.rs:1346-1351）。

### 快照备份与导入

`backup/src/endpoint.rs`：`BackupRange` 按 region 切区间、`BackupWriter` 写 SST 到 external storage（BR 的全量侧）。`SstImporter`（sst_importer.rs:149）：Lightning 的下载→校验→ingest 链路，`CacheMap<StorageBackend>` 缓存后端连接、`multi_master_keys_backend` 解密、`ImportModeSwitcher(V2)` 双轨切换（ingest 期间 RocksDB level 调整）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Observer/订阅 | 三模块 observer.rs + ObserveId | 寄生 apply 流不改主流程 |
| 策略注入 | `Arc<dyn ExternalStorage>` | S3/GCS/local 可换 |
| 双向流 | CDC `change_data_event_feed` | 事件推送免轮询 |
| 分片配额 | memory quota + semaphore | 观察者不拖垮在线 |

## 模块间交互

raftstore：coprocessor registry 注册 cmd/role/region_change 三类 observer，`CmdBatch` 携带 `cdc_id`/`ts_filter` 由写路径填充；ConcurrencyManager：`global_min_lock_ts` 保证与 async commit 一致；external_storage：backup/backup-stream/sst_importer 共用 `Arc<dyn ExternalStorage>`；resolved_ts 与 CDC 共享概念但**不共享实例**（各自持 Resolver，backup-stream 用 `TwoPhaseResolver`）。

## 扩展方式

- **调扫描速度/并发**：`CdcConfig` + `Endpoint::new`（endpoint.rs:531-558）增删限速器；backup-stream 的 `spawn_executors` 扩 scan pool
- **新增事件字段**：`CmdBatch` → `convert_to_grpc_events`（delegate.rs:750）→ proto 链路，同步 `validate_kv_api`（:831）与 `FeatureGate` 版本协商
- **新增外部存储后端/加密**：external_storage 实现 trait，backup 的 KvWriter / backup-stream 的 `flush_writer`（router.rs:1056）/ `SstImporter::download` 三处接入
