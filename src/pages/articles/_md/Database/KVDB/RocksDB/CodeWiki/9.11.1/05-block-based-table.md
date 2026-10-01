---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "BlockBasedTable"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "SST", "Bloom Filter"]
description: "SST 物理格式的读写：data/index/filter block + footer、三级索引、full/partitioned filter、delta 编码与 CachableEntry 缓存引用管理。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

`table/block_based/`（builder 2207 行 + reader 3248 行为主体）实现 SST 的物理格式与读写。文件布局：`[data block]* [meta blocks: filter/index/compression dict/range del/properties] [metaindex] [footer]`，每个 block 尾带 5 字节 trailer（1B 压缩类型 + 4B checksum）。读侧三级加速：**SST 级 bloom filter → index block 二分/哈希/两级 → 块内 restart 二分 + data block hash index**。

## 模块架构

```
写侧 BlockBasedTableBuilder（状态机 kBuffered→kUnbuffered→kClosed）
  Add(ikey, value)
    ├─ flush_block_policy->Update：块满（≈4KB 默认）→ Flush()
    │    └─ data_block.Finish（restart 数组 + footer）
    │        → CompressAndVerifyBlock → WriteMaybeCompressedBlock（+5B trailer）
    ├─ index_builder->AddIndexEntry（延迟到下块首键——算最短 separator）
    └─ filter_builder->AddWithPrevKey（bloom 位图）
  Finish()
    → WriteFilterBlock / WriteIndexBlock（partitioned 循环）/ WriteRangeDelBlock
    → WritePropertiesBlock / metaindex / WriteFooter（magic 0x88e241b785f4cff7）

读侧 BlockBasedTable（Open 时解析 footer→metaindex→properties）
  Get(key)
    → FullFilterKeyMayMatch（整 SST 一个 bloom，一次 lookup 裁决）
    → index_iter->Seek（BinarySearch/Hash/Partitioned 三策略）
    → NewDataBlockIterator（cache Lookup → miss 读盘+解压 → Insert）
    → block_iter->SeekForGet（restart 二分或 data_block_hash_index）
```

## 调用链路

```
写路径（builder.cc:1016 Add）
  ├─ flush_block_policy->Update（flush_block_policy.cc:37：
  │    curr >= block_size 或 BlockAlmostFull 提前封口）
  ├─ Flush()（:1150）→ WriteBlock（:1173）
  │    block->Finish()（block_builder.cc:126：append restarts + 4B footer；
  │      ≤64KiB 且启用时再 append 块内 hash index）
  │    → CompressAndVerifyBlock（:1234，劣化压缩直接落未压缩）
  │    → WriteMaybeCompressedBlock（:1375，+5B context checksum trailer）
  ├─ index_builder->AddIndexEntry(last_ikey, &ikey, pending_handle)（:1071）
  └─ Finish()（:2067）→ 依次 meta block → footer（format_version≥6 时
      index handle 移出 footer 进 metaindex）

读路径（reader.cc:2231 Get）
  ├─ FullFilterKeyMayMatch（:2067）→ filter->KeyMayMatch
  │    （whole_key_filtering=true 走整 key；false 时须同时有 prefix_extractor
  │     且 filter 支持前缀才走 prefix 分支）
  │    → GetOrReadFilterBlock（缓存/文件一次取整 filter）
  │    → filter_bits_reader->MayMatch → false 则整 SST 跳过
  │      （MayMatch 计数 BLOOM_FILTER_USEFUL；filter block 本身读取失败时
  │       返回 true——fail-open，不能因 filter 读不出而误判"不存在"）
  ├─ NewIndexIterator → IndexBlockIter::SeekImpl（block.cc:465）
  │    BinarySeek 在 restart 数组二分（index restart interval=1，二分即直达）
  ├─ 循环 iiter：NewDataBlockIterator（reader_impl.h:47）
  │    → RetrieveBlock（:1830）→ MaybeReadBlockAndLoadToCache（:1571）
  │        GetDataBlockFromCache（cache Lookup）miss → BlockFetcher
  │        读 payload+trailer+校验+解压 → PutDataBlockToCache → SetCachedValue
  │        （read_tier == kBlockCacheTier 且未命中时走 GetContext::MarkKeyMayExist
  │          ——语义"可能存在"而非 NotFound，供 KeyMayExist 语义使用）
  │    → block_iter->SeekForGet（block.h:720）
  │        有块内 hash → data_block_hash_index->Lookup 直达 restart
  │          （kNoEntry→取最后 restart 区间；kCollision→退回 BinarySeek）
  │        否则 BinarySeek（restart 二分）+ 区间内线性
  └─ get_context->SaveValue 逐条交付（merge/tombstone 语义）

MultiGet（sync_and_async.h:359）
  → FullFilterKeysMayMatch 批量过滤 → RetrieveMultipleBlocks（:32）
    相邻 block 合并为一个 FSReadRequest → MultiRead 一次 IO
```

## 核心实现

### filter 为什么分 full 与 partitioned

旧 LevelDB 式 per-2KB filter（"filter." 前缀）**只保留只读兼容**（`reader.cc:1117` 读到时打 WARN，9.11 已无对应 Builder）。full filter 整 SST 一个 bloom：(a) 一次 cache lookup/一次 IO 裁决整个文件；(b) bit 预算按全文件 key 数精确摊，假阳性率稳定；(c) 可整体 pin/预取/进二级 cache。代价：迭代时无法按 block 剪枝——于是 partitioned filter 与 two-level index 对齐切分（`reader.cc:1128` 断言二者必须同用），迭代路径经 `RangeMayExist` 做 block 级剪枝。两者由同一 `FilterBitsBuilder` 策略（Bloom/Ribbon，`filter_policy.cc:1589`）驱动。

### delta 编码的三层

data block 内相邻 key 共享长前缀：`AddWithLastKeyImpl`（`block_builder.cc:187`）只存 shared/non_shared 差量；restart interval（默认 16）限制最坏回溯代价，尾部 restart 数组支持二分。index key 更进一步：**等下一个 block 首键到齐后**用 `FindShortestInternalKeySeparator` 找最短分隔键（"the quick"/"the who" → "the r"）；index value（BlockHandle）也 delta 编码（format_version≥4）；第三层 `index_key_includes_seq`——所有相邻 user key 不同时可整体去掉 8B seqno。

### 四种 IndexType 的取舍

`kBinarySearch`（默认）：单 index block，restart interval=1 使二分落点即答案免线性扫。`kHashSearch`：index 之上加 `BlockPrefixIndex`（prefix→block id），O(1) 定位候选 block；代价是必须配 prefix_extractor（哈希以 prefix→block id 为映射键，没有 extractor 就无从计算前缀）、写侧两个额外 meta block；**prefix_extractor 与建表时不一致或未设置时经 `PrefixExtractorChanged`（`reader.cc:1990`）判定降级**——迭代需要 `need_upper_bound_check` 防哈希索引越过上界误剪。`kTwoLevelIndexSearch`：index 自身按 `metadata_block_size`（4096）切 partition + 顶层索引——解决**大 SST 单 index block 过大、无法整块进 cache** 的问题。`kBinarySearchWithFirstKey`：IndexValue 附 first_internal_key，Get 可**不读 data block** 就确认 miss（请求 key 落在两 block 间隙时直接 break）；迭代器惰性物化使 bounded scan 少读块。

### footer 不进 block cache

footer 固定 ≤53B 且位置固定（文件尾），`Open` 只读一次后常驻 `Rep::footer`；而 `BlockBasedTable` 对象本身已被 TableCache 缓存——缓存 footer 等于缓存一个每表只读一次、已随表常驻的 53B 结构。时序上也做不到：cache key 体系依赖 properties（`SetupBaseCacheKey` 在 ReadPropertiesBlock 之后），而读 metaindex/properties 必须先用 footer——**footer 是先于 cache 体系存在的引导路径**。呼应 format_version≥6 的最小化：index handle 移出 footer 进 metaindex，footer 只留定位与校验所必需字段。

### CachableEntry 与 block cache 引用

```cpp title="table/block_based/cachable_entry.h:43（四种形态）"
template <class T> class CachableEntry {
  // 1) cached    → 析构时 cache_->Release(handle)
  // 2) owned     → 析构时 delete value_（直接从文件读、无 cache）
  // 3) unowned   → 只是借指针
  // 4) transferred → TransferTo(Cleanable*) 释放责任转给迭代器 cleanup 链
};
```

`block.TransferTo(iter)` 把 cache handle 释放责任挂到迭代器——pinned value 生命周期的基础（见 [06-read-path](06-read-path) 的 pin 机制）。cache key 结构 `base_cache_key + BlockHandle`（`GetCacheKey`），`OffsetableCacheKey` 支持文件重编号后的 offset-key 迁移；**16 字节 CacheKey 恰是 HyperClockCache 只支持 16B key 的前提**。

### kBuffered 状态机与并行压缩

zstd 字典压缩（`max_dict_bytes > 0`）时先进 `kBuffered` 把未压缩块攒内存，`EnterUnbuffered`（`:1908`）用**素数步长随机采样**（`kPrimeGenerator = 545055921143`，与任意块数互素）训练字典后回放写出。`ParallelCompressionRep`（`:670`）两条 WorkQueue + 每 block 一个容量 1 的 `BlockRepSlot`——**保证写出顺序与切分顺序一致**；写线程内补做 filter/index 更新。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两级迭代器 | `BlockBasedTableIterator`（index_iter + block_iter）；两级 index 再嵌套 `NewTwoLevelIterator` | 用户只见一个迭代器；分区 index 惰性加载 |
| RAII + 责任转移 | `CachableEntry` 四态 + `TransferTo` | cache handle 寿命收敛到迭代器析构 |
| 工厂 + 策略 | `CreateIndexReader/FilterBlockBuilder/FlushBlockPolicy` 分派 | 格式细节可插拔 |
| NVI + 模板分派 | `BlockIter::Seek` final，子类只实现 `SeekImpl`；`BinarySeek<DecodeKeyFunc>` 消掉 format_version 差异 | `UpdateKey()` 每次移动只调一次 |
| 零成本标签类型 | `Block_kData/Block_kIndex` 空结构 + typed cache | 按类型统计/priority 分派，无虚函数开销 |

## 模块间交互

**block cache**：`MaybeReadBlockAndLoadToCache` 是唯一读写通道；`BlockCreateContext`（`block_cache.h:70`）让 cache 未命中时在 cache 内部线程/二级 cache 回调里做解压+构造；`GetCachePriority`（`:1322`）：data/properties=LOW、index/filter 可 HIGH。**compression**：`CompressBlock`（含采样统计与劣化回退）；meta block（filter/dict）永不压缩。**table_cache**：`BlockBasedTable` 声明 `friend class TableCache`（`reader.h:457`）——footer→metaindex→properties 的解析代价摊销在 table cache 命中上。**文件层**：`FilePrefetchBuffer`（尾预取+自适应 readahead）、MultiGet 相邻 block 合并 IO。

## 扩展方式

**新增/替换 filter 算法**：实现 `FilterBitsBuilder/Reader`，挂到 `BuiltinFilterPolicy::GetBuilderWithContext`（`filter_policy.cc:1589`）——Builder/Reader 对 bits 格式无感知，改动收敛在 filter_policy.cc。

**自定义 block 切分**：实现 `FlushBlockPolicyFactory`（参考 `FlushBlockBySizePolicy`，`flush_block_policy.cc:22`），经 `BlockBasedTableOptions::flush_block_policy_factory` 注入——Builder 侧 `flush_block_policy->Update` 调用点无需改动。

**新增 IndexType**：源码自带指引（`index_builder.h:26` 注释三步）：subclass `IndexBuilder` + 枚举 + `CreateIndexBuilder` 分支；读侧对偶 `CreateIndexReader` 分支及迭代器实现——需评估 `BlockBasedTableIterator` 对 `index_iter_->value().handle`/`first_internal_key` 的契约。

**新增 meta block 类型**：`BlockType` 枚举 + `GetCacheItemHelper` + 写侧 `WriteXXXBlock`（内容写盘 + metaindex 登记名字）+ 读侧 `PrefetchIndexAndFilterBlocks` 按名探测。
