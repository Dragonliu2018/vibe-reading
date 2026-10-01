---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "Cache"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "LRU", "Cache"]
description: "LRUCache 三段优先级池、HyperClockCache 单原子字设计、ShardedCache 分片、二级缓存的 dummy 双向占位协议与 CacheReservationManager 容量预留。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

`cache/`（~18k 行）实现 block cache 的三态层次：primary（LRU 或 HyperClock）→ compressed secondary → tiered（NVM）三级。先纠正三处旧知识（9.11.1 核实）：**老 ClockCache 已因 "unresolved bug" 被整体删除**（`cache.h:496` DEPRECATED 注释；`NewClockCache()` 直接返回 LRUCache）；现在的实现叫 **HyperClockCache**（EXPERIMENTAL）；LRU 侧不是两条队列，而是**一条环形双链表 + 两个分割指针**切成 high/low/bottom 三段。

## 模块架构

```
ShardedCache（按 hash 分片，默认每 512KB 一片上限 64 片）
  ├─ LRUCacheShard（默认）
  │    LRUHandleTable（自研链式哈希，高 32 位 hash 定位桶）
  │    lru_（环形链）+ lru_low_pri_ / lru_bottom_pri_（分割指针切三段）
  │    逐出永远从 lru_.next（bottom 段尾）开始
  └─ ClockCacheShard<Fixed|AutoHyperClockTable>（EXPERIMENTAL）
       单个 64-bit meta 原子字：acquire/release 双 30 位计数器 + hit bit + 状态

二级缓存（装饰器链）
  CacheWithSecondaryAdapter（primary 的包装）
    ├─ CompressedSecondaryCache（内部就是一个 LRUCache，存 LZ4 压缩块）
    └─ TieredSecondaryCache（compressed + NVM 三队列 admission）

容量预留：CacheReservationManager（256KB dummy entry 占位）
  ChargedCache（把 blob cache 用量记账到 block cache）
```

## 调用链路

```
LRU：Lookup → 维护 → Release → 逐出
  Cache::Lookup（sharded_cache.h:198）ComputeHash → GetShard
  → LRUCacheShard::Lookup（lru_cache.cc:430）
      持分片锁 → table_.Lookup（桶链比 hash+全 key）
      → 命中且 refs==0 → LRU_Remove（被引用者不入链）
      → e->Ref() + SetHit()（M_HAS_HIT：下次回链可升池）
  LRUCacheShard::Release（:472）
      e->Unref() 最后引用且回链：
        超容量 → 直接释放（顺势清超额）
        否则 LRU_Insert（:256）：
          (IsHighPri || HasHit) → 插 lru_ 头（high 段）
          IsLowPri → 插 lru_low_pri_ 后（low 段头）
          否则 → 插 lru_bottom_pri_ 后（bottom 段头）
        → MaintainPoolSize（:298）：high 池超容 → 尾部降 low；low 超 → 降 bottom
  InsertItem（:372）
      → EvictFromLRU（:323）：while 超容量 && lru_.next != lru_：
        从最老端逐出 → NotifyEvicted → eviction_callback_（secondary 接入点）

CLOCK：单原子字
  Insert → BeginSlotInsert（FetchOr 独占 Empty→Construction）
         → 写数据 → FinishSlotInsert（Visible + 初始 countdown）
  Lookup：meta.FetchAdd(kAcquireIncrement)  ← 一次原子加 = ref+1 且 countdown+1
  Release：useful ? FetchAdd(release) : FetchSub(acquire)（撤销）
  Evict（:1115）：clock_pointer_.FetchAddRelaxed(4) 每线程认领 4 slot
         并行钟扫；countdown 减到 0 → CAS Construction 拿所有权逐出
```

## 核心实现

### LRUCacheShard 的三段池与 scan 污染

`high_pri_pool_ratio=0.5` 时非 high-priority 新 entry 从**中点插入**（cache.h:220 的 midpoint 语义）——一次长 scan 装入的 data block 只能占据 low/bottom 段；index/filter 等 HIGH entry（`cache_index_and_filter_blocks_with_high_priority`）受 ratio 保护不被 scan 冲刷。`M_HAS_HIT` 让二次命中的 entry 升入 high 段。**降级发生在最后一个引用释放、entry 回插 LRU 链这一刻**，不是 Release 本身。

### HyperClockCache 的 meta word

```cpp title="cache/clock_cache.h:318（编码）"
// | acquire counter (30b) | release counter (30b) | hit bit | state marker |
// 当前 refcount = acquires - releases；refs==0 时 countdown = min(3, acquires)
```

**没有独立的 usage bit**——usage 信息折进 acquire counter（Lookup 使 acquires+1 即"置位"）。设计目标写在头注释（`:120`）：**Lookup 命中与 Release 各只需一次原子 fetch_add**——读路径热路径免费附带所有元数据维护。两个表实现：`FixedHyperClockTable`（表大小固定，open addressing + double hashing，`sizeof(HandleImpl)==64` 一个 slot 一条 cache line）与 `AutoHyperClockTable`（linear hashing 增量扩容）。hash 用 16 字节 key 的**无损双射** `BijectiveHash2x64`——无需存储 key 本体（可 `ReverseHash` 反推），这正是它只支持 16B key 的原因（与 BlockBasedTable 的 16B CacheKey 互相成全）。

### 为什么默认 LRUCache

HyperClockCache 的限制（`clock_cache.h:40-297` 的 260 行设计文档）：只支持 16B key（不能用 row cache/table cache）、需要 `estimated_entry_charge` 调参（估计偏差两边都有代价）、**优先级执行更弱**——"enough transient LOW or BOTTOM priority items can evict HIGH priority entries"、pinned 占满时 CLOCK 全表扫描烧 CPU（靠 `eviction_effort_cap=30` 缓解）。LRU 通用且严格容量行为可预期。反过来看分片策略的差异也印证：LRU 连读都要独占锁，靠 64 分片换并发；CLOCK 锁开销极小，特意选 32MB min shard 用更少分片。

### 二级缓存的 dummy 双向占位协议

"promote on second hit"：primary 侧用 `kDummyObj` 0-charge entry 记"secondary 里有它"；`CompressedSecondaryCache` 侧用 0-charge dummy 记"primary 曾逐出过它"（`compressed_secondary_cache.h:47-63`）。Lookup 命中 dummy 即证明第二次访问，才真正双向搬运：primary 逐出 → `EvictionHandler` 试探性插入 secondary（第一次只插 dummy）；第二次被逐出才压缩入库（LZ4 + 按 jemalloc bin 切块）。反向：primary miss → secondary 命中 → `Promote` 重建对象回插 primary（用 without_secondary_compat 防再溢出环）。`StartAsyncLookup/WaitAll` 批量预取是 multi-get 的支点。

### CacheReservationManager：为什么存在

block cache 是 RocksDB 的统一内存预算记账中心，但 cache 之外的分配（memtable via WBM、bloom/ribbon 构造、TableReader 元数据）同样吃 RSS——不占 cache 容量总内存就超预算。解法：插 **256KB 步进的空值 dummy entry**（`cache_reservation_manager.h:206`）占住配额；`delayed_decrease` 的 3/4 滞回防反复插拔（dummy 插入贵且未来增长概率高）；`kFullChargeCacheMetadata` 默认把 `malloc_usable_size(LRUHandle)` 也计入 entry charge。7 个角色（kWriteBuffer/kFilter/kBlockBasedTableReader/kBlobValue...）显式实例化即 7 个记账方。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 分片 | `ShardedCacheBase` 按 hash 路由 | LRU 锁竞争摊开 |
| 模板静态多态 | `ShardedCache<CacheShard>` duck typing | LRU/CLOCK 共用分片框架零虚函数开销 |
| 装饰器链 | CacheWrapper → CacheWithSecondaryAdapter → ChargedCache | 层次叠加不改底层 |
| C 风格回调协议 | `CacheItemHelper` 函数指针四件套 | entry 可能比 DB 活得久，stateless 简化生命周期 |
| 占位/dummy entry | reservation 与 secondary 双向协议 | 复用同一套 Insert/charge 机制表达"记号" |
| 最终一致性容量 | CLOCK non-strict 的 relaxed 原子操作 | 热路径免锁，短暂超额可接受 |

## 模块间交互

**table reader**：`BlockBasedTable::GetCacheKey` 用 `OffsetableCacheKey::WithOffset` 生成 16B key；`MaybeReadBlockAndLoadToCache` 是唯一写通道；`BlockCreateContext` 让 cache 内部线程做解压构造。**WriteBufferManager**：经 `CacheReservationManagerImpl<kWriteBuffer>` 记账。**BlobDB**：独立 blob cache 或 `ChargedCache` 包装记账。**hash seed 随机化**（`sharded_cache.cc:28`）：防"同一批 SST 广播到多 host 后相同不幸 hash 把大 bloom 全挤进同一分片"（`cache.h:167` 详述动机）。

## 扩展方式

**新增 CacheEntryRole**：`cache.h:55-88` 枚举（kMisc 保持最后）+ `cache_entry_roles.cc` 字符串映射 + `cache_reservation_manager.cc:175` 显式实例化。

**新增 admission policy**：`TieredAdmissionPolicy` 枚举（`cache.h:512`）→ `EvictionHandler` 的 force 判定与 `MaybeInsertDummy` 路径两个决策点。

**接入自定义二级缓存**：实现 `SecondaryCache` 六个纯虚函数（`secondary_cache.h:82`——重点 `InsertSaved` 的 CacheTier 语义与 `WaitAll` 异步聚合）即可被 adapter 透明编排。
