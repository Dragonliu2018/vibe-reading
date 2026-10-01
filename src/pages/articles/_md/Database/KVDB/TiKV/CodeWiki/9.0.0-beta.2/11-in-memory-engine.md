---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "In-Memory Engine"
date: "2026-10-01T21:30:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "InMemoryEngine", "Skiplist", "RegionCache", "缓存"]
description: "TiKV Region 级只读内存副本：全局 crossbeam skiplist、RegionState 状态机、双引擎 seqno 对齐与 hybrid_engine 混合读。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

IME 解决热点 region 的读放大：RocksDB block cache 缓存的是解码后的 block，同一 MVCC key 的多个版本会重复占缓存，且无法提前 GC 旧版本。IME 是 **Region 粒度的只读内存副本**——把热点 region 整个装进内存（crossbeam skiplist），apply 线程双写维持镜像，读路径优先命中、GC 比 磁盘更激进。注意启用方式：**不是 EngineType**（storage/config.rs:71 只有 RaftKv/RaftKv2），而是独立开关 `in_memory_engine.enable`（config/mod.rs:3726）——它挂在 RaftKv 旁边，不替代磁盘引擎。

## 模块架构

```text
components/in_memory_engine/src/
├── engine.rs        RegionCacheMemoryEngine（:338）+ SkiplistEngine（:120）
├── background.rs    BgWorkManager（:150）+ do_load_region（:913）
├── region_manager.rs RegionManager（:608）+ CacheRegionMeta（:118）
│                    + RegionState 状态机（:28）
├── read.rs          RegionCacheIterator / Filter（MVCC GC 过滤）
├── keys.rs          InternalBytes（user_key + seqno + type）
├── memory_controller.rs  配额原子累加
└── cross_check.rs   与磁盘引擎周期一致性对账
components/hybrid_engine/src/   混合读 Facade
├── observer/snapshot.rs    HybridSnapshotObserver（:88）
├── observer/load_eviction.rs  LoadEvictionObserver
└── snapshot.rs     HybridEngineSnapshot（:20 双引擎委托）
components/crossbeam-skiplist/  fork：加 OwnedIter 让迭代器持 Arc 脱离 guard
```

## 调用链路

### Region 加载

```text
raft apply 线程首次写该 region
└─ RegionCacheWriteBatch::prepare_for_region（write_batch.rs:128）
   └─ prepare_for_apply（engine.rs:213，fast path 仅读锁）
      # state Pending→Loading，取 RocksDB snapshot
      └─ BackgroundTask::LoadRegion → do_load_region（background.rs:913）
         ├─ 遍历 DATA_CFS：snapshot KV 以 seqno 为版本号插 skiplist
         │   逐条 MemoryController::acquire 扣配额，超限取消
         ├─ PD TSO 计算 safe_point = now - gc_run_interval
         │   Filter::filter_keys_in_region 内存 MVCC GC（清 safe_point 前旧版本）
         └─ on_snapshot_load_finished 置 Active + set_safe_point
【此后增量靠 apply 线程双写维持镜像】
```

### 读路径选择

```text
raftstore 生成 RegionSnapshot
└─ HybridSnapshotObserver::on_snapshot（hybrid_engine/src/observer/snapshot.rs:88）
   └─ RegionManager::region_snapshot（region_manager.rs:693）三重校验：
      state==Active ∧ epoch version 匹配 ∧ read_ts > safe_point
      失败 → NotCached / EpochNotMatch / TooOldRead（回磁盘）
└─ RaftKv::async_in_memory_snapshot（src/server/raftkv/mod.rs:606）
   → HybridEngineSnapshot（disk_snap + region_cache_snap）
      get_value_cf_opt：is_data_cf 且有 IME 快照走内存，否则透明回退 RocksDB
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `prepare_for_apply` in engine.rs:213 | 加载触发 | 读锁 fast path 零开销 |
| `do_load_region` in background.rs:913 | 快照装载+GC | seqno 对齐磁盘 |
| `region_snapshot` in region_manager.rs:693 | 读校验 | 三重条件才命中 |
| `split_region` in region_manager.rs:1023 | split 缓存维护 | 继承 safe_point |
| `on_region_event` in engine.rs | evict/load 事件分发 | 观察者统一入口 |
| `set_being_written` | 写中标记 | 阻止 evict 竞态 |

</details>

## 核心实现

### RegionState 状态机与延迟删除

```text
Pending → Loading → Active → PendingEvict → Evicting → 物理删除
              ↓（内存超限）
        LoadingCanceled
```

`validate_update_region_state`（region_manager.rs:211）校验转移，非法即 panic。evict 的物理删除要等**最后一个存活 snapshot 释放**：`SnapshotList`（BTreeMap<read_ts, ref_count>）引用计数 + split 后旧 region 进 `historical_regions` 阻塞该范围 GC/evict（`get_history_regions_min_ts`），释放时慢路径删除（region_manager.rs:728）——两级延迟回收（配合 crossbeam epoch）。

### 双引擎一致性：共享 sequence number

正确性的关键设计：**IME 与 RocksDB 用同一个 seqno**。`ObservableWriteBatch::write_opt_seq`（hybrid_engine/src/observer/write_batch.rs:50-53）把 RocksDB 写返回的 seqno 灌入 `RegionCacheWriteBatch` 再写 skiplist；`RegionCacheSnapshotMeta.sequence_number` 用磁盘快照 seq 做可见性判断——两引擎原子等价。加载起点是 RocksDB snapshot，天然一致。`is_written` 标记阻止写入中途被 evict。`cross_check.rs` 周期对账兜底（入口 `start_cross_check` engine.rs:466）。

### 为什么 region 粒度 + crossbeam skiplist

engine.rs:331-336 的 doc comment 直说：region 是 raft/leader/scheduler 的自然单元，IME 的 safe_point 可以比磁盘 GC 更激进（内存里 GC 掉 safe_point 前所有旧版本），单次读不再重复读多版本 key——这是 block cache 做不到的。leader-only 缓存避开 follower 一致性问题。crossbeam skiplist：无锁并发读写（加载线程插入与读线程扫描并行），epoch-based reclamation 与快照生命周期天然配合；TiKV fork 加 `OwnedIter`/`owned_iter`（crossbeam-skiplist/src/base.rs:520,2246）让迭代器持 `Arc<SkipList>` 脱离 guard 生命周期。全局**一套** `SkiplistEngine`（三 CF 三个 skiplist，engine.rs:120）+ `regions_by_range` BTreeMap 做 range→region 二分定位——数据与元数据分离。

### 自动热度管理

`TopRegionsLoadEvict` 周期任务（background.rs:712）：`RegionStatsManager` 按 coprocessor 请求速率（`CopRequestsSma` 一小时滑动均值）选 top region 自动 load/evict；`PdRangeHintService`（background.rs:168）watch region label 规则 `cache=always` 实现手动 range 加载；became follower/destroy peer/ingest SST/flashback → 对应 evict（`EvictByRange` 扫 `iter_overlapped_regions`，engine.rs:592）。

### 内存硬边界

`MemoryController::acquire` 原子累加返回 `CapacityReached`/`EvictThresholdReached`；`stop_load_threshold`（= evict_threshold - 预留 delta，config.rs:149）达到时取消在途加载（background.rs:938）——防加载本身打爆内存。`lock_modification_bytes` 累计 lock CF 墓碑触发 `CleanLockTombstone`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Observer 寄生 | LoadEvictionObserver 等挂 raftstore | 不改 apply 主流程 |
| 状态机 | `RegionState` region_manager.rs:28 | 非法转移 panic |
| Facade 委托 | `HybridEngineSnapshot` 按分支转发 | 对上层透明 |
| 引用计数延迟删除 | `SnapshotList` + `historical_regions` | 快照持有期间数据不删 |
| 数据/元数据分离 | 全局 skiplist + range BTreeMap | 免 per-region 引擎开销 |

## 模块间交互

engine_traits：实现 `RegionCacheEngine`/`RegionCacheEngineExt`（region_cache_engine.rs:110——`snapshot(region, read_ts, seq_num)`、`on_region_event`）；raftstore：只认 `dyn RegionCacheEngineExt`，经 `RegionEvent::{Eviction, TryLoad, Split, EvictByRange}` 通信，加载完成经 `CasualMessage::InMemoryEngineLoadRegion` 通知 peer（background.rs:1322）；storage：`RaftKv::async_in_memory_snapshot` + `Storage::async_in_memory_snapshot`（mod.rs:3507）是上层唯一入口，metrics `in_memory_engine_hit()` 区分命中。v9 限制：只接入了 v1 raftstore 的 observable write batch 路径（raftstore-v2 未接，待核实）。

## 扩展方式

- **新增 evict 触发源**：`LoadEvictionObserver` 加 observer 方法 → 新 `EvictReason`（engine_traits）→ metrics
- **调整内存 GC 策略**：`do_load_region` 的 safe_point 计算 + `read.rs` 的 `Filter::filter_keys_in_region` 过滤规则 + `region_snapshot` 的 `TooOldRead` 判定三处联动
- **迭代器新 seek 模式**：`RegionCacheIterator`（read.rs:227）+ crossbeam-skiplist fork 的 `OwnedIter` 两处联动（本模块最重改动面）
