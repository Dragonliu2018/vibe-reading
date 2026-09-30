---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Hummock 存储"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "LSM", "对象存储", "MVCC"]
description: "Hummock 存储解读：S3 分层 LSM、epoch MVCC 与版本 pin、单写者事件驱动写路径、iterator 静态化与流式特化剪枝、compactor 独立进程"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

Hummock 是为流计算**协同设计**的云原生 LSM 状态存储：KV API 全存 S3，本地盘只是缓存（计算节点无盘化），版本管理与 compaction 调度在 meta，压实执行在独立 compactor 进程。它不是通用 KV——state-store-overview.md 明确列出三个流式特化假设：算子只读写自己的数据分片、数据不跨节点共享（读他节点数据需等 epoch）、写入按 epoch 串行提交。这三条假设塑造了它的全部设计。

## 模块架构

```text
src/storage/src/hummock/
├── store/
│   ├── hummock_storage.rs     # HummockStorage：无状态门面（读接口）
│   ├── local_hummock_storage.rs # LocalHummockStorage：单写者本地写
│   └── version.rs             # HummockVersionReader：读路径 iterator 组装
├── event_handler/             # HummockEvent 单写者 worker
│   ├── uploader/              # imm→SST 三阶段上传 + sync
│   └── refiller.rs            # cache refill（本地自适应读）
├── shared_buffer/             # imm 编码与迭代
├── local_version/             # PinnedVersion(RAII) / RecentVersions(time travel)
├── sstable/                   # SST 格式（Block/XorFilter/builder）
├── sstable_store.rs           # SST 读缓存（foyer 两级）
├── iterator/                  # forward/backward × user/merge/concat/skip_watermark
├── compactor/                 # CompactTask 执行器（CN 本地也复用）
└── write_limiter.rs           # meta 驱动的写背压
+ src/storage/compactor/       # 独立 compactor 进程（Dedicated/Shared/Iceberg 模式）
+ src/storage/table/           # 上层 StateTable/StorageTable 抹平语义差异
```

顶层抽象是 `StateStore` trait 族（store.rs）：`StateStore`（含关联类型 `Local`/`ReadSnapshot`/`VectorWriter`）→ `LocalStateStore`（算子专用单写者）→ `StateStoreImpl` enum（store_impl.rs:226）做类型擦除——**opaque type 避免 monomorphization 爆炸**：release 静态分发，debug 构建下 `may_dynamic_dispatch` 套 `Arc<dyn>` 便于测试注入。

## 调用链路

写路径（write batch → shared buffer → barrier sync → L0 SST）：

```text
算子写 StateTable → LocalHummockStorage::insert/delete（先入 MemTable）
 └ flush（MemTable drain 成排序 kv + sanity check）    local_hummock_storage.rs:431
    ├ write_limiter.waitPermission（meta 下发限流）      :684
    ├ MemoryLimiter 超限 → BufferMayFlush 全局 flush + 阻塞背压 :686-709
    └ SharedBufferBatch::build_shared_buffer_batch（imm）
 barrier 到来 → seal_current_epoch（封 epoch）           :541
 └ imm 超阈值 → HummockEvent::ImmToUploader
    └ HummockUploader flush_imms → shared_buffer_compact  event_handler + compactor/shared_buffer_compact.rs:54
       （MergeIterator 合并 imm → L0 SST，ObjectIdManager 批量领号）
    └ StagingSstableInfo 挂进 read version staging 层    hummock_event_handler.rs:617
 barrier 提交 → hummock.sync(vec![(prev_epoch, table_ids)]) hummock_storage.rs:673
    └ HummockEvent::SyncEpoch → 等该 epoch 全部上传完成 → SyncedData
    └ meta 统一 commit_epoch（CN 侧 panic!("Only meta service can commit_epoch in production.") hummock_meta_client.rs:78）
```

读路径（`new_read_snapshot(epoch)` → iterator 树）：`build_read_version_tuple`（hummock_storage.rs:378）按 `HummockReadEpoch`（hummock_sdk/lib.rs:256，五变体：`Committed`/`BatchQueryCommitted`/`NoWait`/`Backup`/`TimeTravel`）分派三条路径——`build_read_version_tuple_from_committed`（:463，等 committed epoch，`is_read_committed` 对 Committed/TimeTravel/BatchQueryCommitted 为 true）、`build_read_version_tuple_from_all`（:475，NoWait：额外扫描 `read_version_mapping` 中各 local 实例**未提交**版本，按 vnode 过滤且排除 replicated 实例——replicated 是做 COW 复制用的高可用副本，不是权威数据源）、`build_read_version_tuple_from_backup`（:422）。组装出三元组 `(imm 列表, 未提交 SST, CommittedVersion)` 后：点查 `get`（version.rs:638）三级短路（staging imm → uncommitted SST → committed 分层）；范围扫 `iter_inner`（version.rs:991）用 `ForwardIteratorFactory` 组树统一进 `MergeIterator`，最后 `UserIterator` 做 epoch 过滤与 tombstone 吞噬。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `LocalHummockStorage::flush` in local_hummock_storage.rs:431 | memtable→imm | 限流+内存背压 |
| `seal_current_epoch` in local_hummock_storage.rs:541 | 封 epoch | EpochWithGap 编码 |
| `HummockStorage::sync` in hummock_storage.rs:673 | epoch 提交等价物 | 事件驱动三阶段 |
| `build_read_version_tuple` in hummock_storage.rs:378 | 读版本组装 | Committed/NoWait/TimeTravel 分派 |
| `HummockVersionReader::get` in version.rs:638 | 点查 | 三级短路+bloom+vnode 剪枝 |
| `iter_inner` in version.rs:991 | 范围扫 | iterator 静态 union |
| `try_wait_epoch` in hummock_storage.rs:893 | 等 epoch 可见 | watch channel |

</details>

## 核心实现

### 为什么不用 RocksDB

`StateStoreImpl::new`（store_impl.rs:784）整个存储栈构建在 `build_remote_object_store` 之上，本地盘只是 foyer 磁盘缓存（且受 `Feature::ElasticDiskCache` license 门控）。流计算 CN 需要秒级扩缩容/故障恢复——状态不在本地盘，恢复 = 重放 + 拉 S3；块缓存跨 CN 共享底层数据；compaction CPU 与流计算 CPU 彻底解耦。代价是读路径自建两级缓存与 prefetch（`PrefetchBlockStream`、`max_preload_retry_times` 重试）。

### epoch 即 barrier：per-epoch MVCC + 版本 pin

每个 barrier 一个 epoch：写侧 `seal_current_epoch` 封版，读侧快照由 epoch 决定。`PinnedVersion` RAII pin（local_version/pinned_version.rs）——`PinnedVersionGuard` 创建时登记、Drop 时发送 `PinVersionAction::Unpin`，`start_pinned_version_worker` 聚合 unpin 请求批量调 meta 的 `unpin_version_before`，`max_version_pinning_duration_sec` 兜底防止读挂死导致版本永不释放。`try_wait_epoch`（hummock_storage.rs:893）用 watch channel 等 epoch 可见——"算子读自己刚提交的数据"的确定性，是流处理 exactly-once 的基石。time travel 读用 `RecentVersions`（本地缓存最近 N 个版本）+ meta `get_version_by_epoch` 兜底。

### staging 三段队列与全局内存治理

`HummockReadVersion`（version.rs:230）的 staging 层是三段队列流转：`pending_imms`（刚 flush 出的 imm）→ `start_upload_pending_imms` 时移入 `uploading_imms` → 上传完成收到 `VersionUpdate::Sst` 时按 imm_ids 逐个弹出（做 batch_id 一致性校验）转为 `StagingSstableInfo`。全局 shared buffer 内存由 `BufferTracker`（event_handler/hummock_event_handler.rs:117 的 `need_flush`）治理：`uploader_imm_size + uploader_uploading_task_size` 超过 `shared_buffer_capacity_mb * shared_buffer_flush_ratio` 计算的阈值时触发全局 flush，`need_more_flush` 的 `min_batch_flush_size` 保证单次 flush 攒够批量再干活。

### EpochWithGap：单 epoch 多次 spill 的编码技巧

epoch 内 memtable 超阈值 spill 时，`EpochWithGap`（hummock_sdk/lib.rs:404）用 **epoch 占 u64 高 48 位、spill_offset 占低 16 位**——同一 epoch 多次 spill 仍可通过 key 排序保持版本序，无需改 epoch。

### 流式特化的 SST 与剪枝

key 布局 `[table_id 4B][vnode][ordered pk][EpochWithGap u64]`；bloom filter 过滤的是 **dist_key hash ^ table_id**（sstable/mod.rs:204——dist key 不必是 pk 前缀，为 join/agg 分布键查询优化）；SST meta 带 per-vnode key range 统计做 get 剪枝；`SkipWatermarkIterator` 按 table watermark 跳过"已过时"的 key——纯流式特性，通用 LSM 没有。

### iterator 静态化

`HummockIteratorUnion`（iterator/mod.rs:180-203）显式注明动机：把 MergeIterator 输入从 `Box<dyn HummockIterator>` 改为编译期枚举 union，消除热路径虚调用；代价是 forward/backward 各自镜像一套。

### compactor 独立进程

`src/storage/compactor` 是独立 binary：无状态、向 meta 注册并行度、被动拉 `CompactTask`。compaction 是 CPU+IO 密集且波动大的负载，独立后按 SST 增长率单独扩容；CN 只做轻量的 shared-buffer→L0 本地 compact（`CompactorContext::new_local_compact_context`）以降低 barrier 延迟。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Actor/事件驱动单写者 | `HummockEvent` → `HummockEventHandler` in event_handler/ | 全局 shared buffer 统一调度 |
| 策略 | `CachePolicy::{Disable,Fill,NotFill}` in sstable_store.rs:155；`SpawnUploadTask = Arc<dyn Fn>` in uploader/mod.rs:79 | 上传时序测试可控 |
| 装饰器 | `MonitoredStateStore`、debug 的 `VerifyStateStore`（Sled 对照校验） | 指标/正确性横切 |
| RAII guard | `PinnedVersionGuard`（Drop 自动 Unpin） | 版本生命周期防漏 |
| const 泛型消 dyn | `SharedBufferBatchIterator<D, const IS_NEW_VALUE: bool>` | 新旧值两套迭代复用 |

## 模块间交互

**↔ meta**（gRPC）：`get_current_version`（启动 pin 首版）、`get_new_object_ids`（SST id 批量领号）、`get_version_by_epoch`、版本推送走 ObserverManager；CN 用 PinnedVersion 防读时 GC。**↔ stream**：StateTable 持 LocalStateStore 按 barrier 调 init/seal/flush；barrier worker 调 sync；恢复时 clear_shared_buffer。**↔ object_store**：SstableStore 全部经 ObjectStoreRef（opendal 抽象 7 种存储）。**↔ compactor**：独立进程拉任务执行，meta 单点决策全局最优。

## 扩展方式

**调整 compaction 层级策略**：hummock_sdk/version.rs 的 `LevelType` + version.rs 的 `iter_inner`/`get` 读路径适配 + shared_buffer_compact.rs（目前硬编码 always L0）；调度本体在 meta 侧。

**调整缓存/预取策略**：`CachePolicy` 分支（sstable_store.rs:470）+ refill 策略（event_handler/refiller.rs + `apply_table_refill_runtime_config`）+ 配置 opts.rs。注意 `MAX_SPILL_TIMES`（hummock_sdk）影响 key 编码兼容性，改动需谨慎。
