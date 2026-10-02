---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "缓存与 Bloom"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "LRU Cache", "Bloom Filter", "分片"]
description: "读加速双件套：ShardedLRUCache 的 16 分片与手搓 HandleTable、in-use/LRU 双链表、以及 BloomFilterPolicy 的双重哈希与 k 参数自描述。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

读路径的两级"拦截器"：**LRU 缓存**（`util/cache.cc`，401 行）负责"读过的别再读盘"，**Bloom 过滤器**（`util/bloom.cc` + `table/filter_block.cc`）负责"肯定没有的别读盘"。两者在 LevelDB 里被用在两个层面——`TableCache` 用 LRU 缓存"打开的表"（`db/table_cache.cc`），`Table::BlockReader` 用 LRU 缓存"解压后的块"（`table/table.cc:138`）；Bloom 则作为可选 `FilterPolicy` 嵌进每个 SSTable 的 meta block（见 [05 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/05-sstable-format)）。

这两个模块是**通用数据结构**——`Cache` 与 `FilterPolicy` 都是公共头文件里的纯虚接口，可以脱离 DB 单独使用（`NewLRUCache` 直接可用，Chrome 等嵌入方真这么干），也因此它们的设计不沾染任何引擎概念。

## 模块架构

```
ShardedLRUCache（util/cache.cc:339）
├─ shard_[16]（kNumShardBits=4）── Shard(hash) = hash >> 28 取高 4 位
│    └─ 每个 LRUCache 自带 Mutex + 容量（capacity 均分向上取整）
│         ├─ HandleTable（手搓哈希表：桶数组 + next_hash 链，负载>1 翻倍）
│         ├─ in_use_ 环链（被客户端持有的条目，无序，仅做不变量校验）
│         └─ lru_   环链（无人持有的条目，真 LRU 序）
└─ LRUHandle（变长分配：头内嵌 key_data[1]）
     refs / in_cache / charge / hash / deleter

BloomFilterPolicy（util/bloom.cc:28）
├─ CreateFilter(keys[], n, dst)：每 key 掷 k 个位（k = bits_per_key × 0.69）
│    h = BloomHash(key)（Hash in util/hash.cc，murmur 变体）
│    位地址 = h % bits，h += delta（h 循环右移 17 位）推进
│    尾字节存 k → 过滤器自描述
└─ KeyMayMatch(key, filter)：k 个位全 1 才可能存在，0 即定无
```

分片是这套 LRU 的第一设计决策：16 个 shard 各自持锁，**把锁竞争除以 16**——块缓存的访问来自所有读线程。哈希分片用高位（`hash >> (32-4)`）而非低位，因为 `HandleTable` 桶索引用的是低位（`hash & (length_-1)`），高低分工避免同一批 key 挤进同一 shard 又在同一桶里排队。

## 调用链路

```
缓存通用链（以块缓存为例）:
 Table::BlockReader(index_value)              table/table.cc:138
 ├─ cache_key = [cache_id(8B)][block offset(8B)]   ← Table::Rep::cache_id 每表唯一
 ├─ block_cache->Lookup(key)
 │    └─ 命中 → Value(handle) 取 Block*，RegisterCleanup(ReleaseBlock)
 ├─ 未命中 → ReadBlock（读盘+解压+校验）→ new Block
 │    └─ options.fill_cache && contents.cachable → Insert(key, block, charge=block->size(), DeleteCachedBlock)
 │    └─ 不缓存（fill_cache=false 或 cachable=false）→ RegisterCleanup(DeleteBlock, block)
 │         ↑ 直接 delete，不经缓存——两个清理回调对应"缓存管/调用者管"两种所有权
 └─ 超容量 → lru_.next 逐个淘汰（assert refs==1：无人持有才能删）

TableCache 链（表级）:
 TableCache::FindTable(file_number, file_size, &handle)   db/table_cache.cc:37
 ├─ key = 8B 文件号 → cache_->Lookup
 ├─ 未命中 → NewRandomAccessFile（.ldb 失败回退 .sst）→ Table::Open → Insert(charge=1)
 │    └─ 失败不缓存（table_cache.cc:62-65 注释："We do not cache error results so
 │         that if the error is transient, or somebody repairs the file, we recover
 │         automatically"）——缓存一个错误句柄会把瞬时故障钉死成永久失败
 └─ Evict(file_number)：文件被删时精确逐出
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ShardedLRUCache::Insert/Lookup` in `util/cache.cc:362/366` | 按 hash 高位路由 shard | 锁竞争 ÷16 |
| `LRUCache::Insert` in `util/cache.cc:270` | 插入并触发淘汰 | 超容即从 lru_ 头部逐出 |
| `LRUCache::Release` in `util/cache.cc` | 归还引用 | 归零时 in_use→lru 换链或销毁 |
| `HandleTable::Insert/Remove` in `util/cache.cc:80/94` | 哈希索引维护 | 负载因子 >1 翻倍 Resize |
| `TableCache::FindTable` in `db/table_cache.cc:37` | 表级缓存 | charge=1（限文件个数） |
| `BloomFilterPolicy::CreateFilter` in `util/bloom.cc:38` | 建过滤器 | 双重哈希免 k 次完整哈希 |
| `BloomFilterPolicy::KeyMayMatch` in `util/bloom.cc:66` | 查过滤器 | 读尾字节 k，跨参数兼容 |
| `BloomHash` in `util/bloom.cc:24` | 一次基础哈希 | 复用 `util/hash.cc` 的 murmur 变体 |
</details>

## 核心实现

### 双链表 LRU：in-use 与 lru 的分野

`cache.cc` 头部 30 行注释讲清了引用语义：每个条目的 `refs` **含缓存自身那一票**。条目只在两个环链之一（或都不在——被 Erase 但客户端还持有）：`in_use_` 挂"还有外部 handle 的"，`lru_` 挂"只剩缓存一票的"按 LRU 序。`LRUCache::Ref`/`Unref`（`cache.cc:218/224`）负责双向搬家：`Unref` 把 refs 减到 1 时把条目从 `in_use_` 摘下挂到 `lru_` 尾部（减到 0 则 `deleter` + `free`）；`Ref` 命中再取引用时（refs 1→2）反向从 `lru_` 搬回 `in_use_`（`cache.cc:219-221`）——**换链跟着"是否只剩缓存自己"这个组合走**（`refs == 1 && in_cache` 判据），正是 `in_cache` 与 `refs` 组合表达的语义；淘汰循环（`Insert` 尾部，`cache.cc:291-298`）从 `lru_.next` 头部摘——**最久未被客户端碰过的先死**，且 `assert(old->refs == 1)` 保证正在使用的条目物理上不可能被逐出。

这个"缓存持票"模型让 `Erase`/析构/淘汰都无需通知持有者——条目生命周期由引用计数自然兜底，`deleter` 只在最后一票归还时调用。`in_use_` 链自己承认（注释原文）只用于不变量检查，删了也行——留着换 debug 价值。另有一个文档化的特殊态：`capacity_ == 0` 时 `Insert` 仍然可用——条目**不进哈希表不挂 LRU 链**（`in_cache` 保持 false），返回的 handle `refs = 1`（纯调用者持有），**缓存被关闭、接口照常**（`cache.cc:283-289` 的 else 分支注释 "don't cache. (capacity_==0 is supported and turns off caching.)"）。

`HandleTable`（`cache.cc:80` 前的注释给出动机："removes a whole bunch of porting hacks and is also faster"，读随机场景 ~5% 提升，2011 年的 g++ 4.4 对比）是**桶数组 + next_hash 单链**：构造时 `Resize()` 起步 16 个桶，`FindPointer` 返回"指向目标槽位的指针的指针"——`Insert` 和 `Remove` 拿它一步完成摘链/替换，无先查后改两步。负载因子超过 1 就 `Resize` 翻倍（注释："each cache entry is fairly large, we aim for a small average linked list length (<= 1)"）——条目大，指针数组便宜，宁可翻倍数组。

### 变长条目与键内嵌

`LRUHandle` 末尾的 `key_data[1]` 是**柔性数组**技巧：`Insert` 一次 `new char[sizeof(LRUHandle) - 1 + key.size()]` 把键直接嵌进条目尾，省一次分配一次间接寻址。`Slice key()` 直接指向这块内存（`cache.cc:73`）。这是 C 风格在 C++ 里的精准用法——键生命周期严格等于条目生命周期，何须分离。

### Bloom：双重哈希与自描述 k

`CreateFilter`（`bloom.cc:38`）的核心循环：

```cpp title="util/bloom.cc"
uint32_t h = BloomHash(keys[i]);
const uint32_t delta = (h >> 17) | (h << 15);   // 循环右移 17 位
for (size_t j = 0; j < k_; j++) {
  const uint32_t bitpos = h % bits;
  array[bitpos / 8] |= (1 << (bitpos % 8));
  h += delta;
}
```

**双重哈希**（Kirsch-Mitzenmacher 2006 的分析被注释引用）：k 个探测位由一个基础哈希加固定增量生成，等效 k 次独立哈希但只算一次——Bloom 里最经典的常数优化。`k = bits_per_key × 0.69`（ln 2 的近似，注释 "intentionally round down to reduce probing cost"）取整钳到 [1,30]；bits 下限 64 防**小集合误判爆炸**（n 小时 10 bits/key 也才几十个位）。

`KeyMayMatch`（`bloom.cc:66`）读**过滤器尾字节里存的 k** 而非用构造参数——同一个库可以混着读不同 bits_per_key 时期写的表，格式自描述。防御分支：`k > 30` 视为未来编码直接返回 true（宁可误放行不误拦截）。

Bloom 的接入语义在 `Table::InternalGet`（`table/table.cc:229`）：误判（false positive）只是多读一次 data block，漏判（false negative）不可接受——所以位图只置不清、判断只查不写。`InternalFilterPolicy`（`db/dbformat.cc`）是读侧适配器：把 internal key 剥成 user key 再问用户策略，**用户给的 Bloom 只需认识自己的键**。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| 策略接口 | `include/leveldb/cache.h` `Cache`、`filter_policy.h` `FilterPolicy` | 用户可整体替换（scan-resistance、Ribbon filter…） |
| 分片 | `util/cache.cc:339` `ShardedLRUCache` | 以空间换锁竞争 |
| 句柄 + 引用计数 | `cache.cc` `Handle`/`Release` | 逐出与持有共存无竞态 |
| 工厂函数 | `include/leveldb/cache.h` `NewLRUCache`、`filter_policy.h` `NewBloomFilterPolicy` | 实现类型不出公共头 |
| 适配器 | `db/dbformat.cc` `InternalFilterPolicy` | internal→user 键翻译 |

## 模块间交互

被 [读取路径](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/06-read-path)消费两级：`TableCache`（表级，容量 `max_open_files - 10` 个文件）与 `Table::BlockReader`（块级，容量 8MB 默认或用户 `Options::block_cache`）。块缓存的键设计值得注意——`cache_id`（`Cache::NewId` 分配，每 `Table` 唯一）+ 块偏移，**不是文件号**：文件号会复用（`ReuseFileNumber`），而表对象销毁后 cache_id 永不复用，天然免疫键碰撞。`TableCache::Evict`（`table_cache.cc:106`）在文件删除时精确逐出表级缓存。Bloom 侧被 [SSTable 格式](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/05-sstable-format)在写端（`FilterBlockBuilder`）和读端（`FilterBlockReader`）对接。两个模块零引擎依赖——graphify 图上它们所在社区与 `db/` 无桥梁边。

## 扩展方式

- **换缓存策略**（LFU/ARC）：实现 `Cache` 接口替换 `NewLRUCache`——注释明说欢迎（"like scan-resistance, a custom eviction policy"）
- **换过滤器**（Ribbon/Cuckoo filter）：实现 `FilterPolicy`（`Name()` 换新即可混库共存）；注意自定义 Comparator 忽略键的一部分时过滤器必须同样忽略（`filter_policy.h` 尾注的 TrailingSpaces 例子）
- **调 Bloom 误判率**：`NewBloomFilterPolicy(bits_per_key)`——10 → ~1%，20 → ~0.01%，内存线性涨
- **缓存粒度**（如压缩块缓存，RocksDB 路线）：改 `Table::BlockReader` 存原始压缩块 + 读时解压
- 对应测试：`util/cache_test.cc`、`util/bloom_test.cc`（含不同 bits/k 的误判率统计断言）
