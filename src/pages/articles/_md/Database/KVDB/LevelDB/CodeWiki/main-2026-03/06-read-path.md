---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "读取路径"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "Iterator", "MergingIterator", "快照读"]
description: "读取路径全解：Get 的分层探测与 seek 统计、NewIterator 的迭代器组合树（MergingIterator/TwoLevelIterator/DBIter）、方向切换与多版本过滤。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

读取路径是写入的镜像：写把数据散进 memtable/L0/L1+ 的多层结构，读负责**按序归拢**——点查 `DBImpl::Get` 由新到旧逐层探测，迭代 `NewIterator` 把所有层做成一棵归并迭代器树再过滤多版本。它横跨三处代码：`db_impl.cc` 的 `Get/NewInternalIterator`、`db/db_iter.cc` 的 `DBIter`（用户视图适配）、`db/version_set.cc` 的 `Version::Get/ForEachOverlapping`（层路由）。

这个模块最能体现 LevelDB 的一个总设计观：**把"层"的语义做进排序与覆盖规则，读路径只需要"找到就停"**——没有 undo、没有事务表、没有墓碑旁路，一切由 `(user_key asc, seq desc)` 的全序 + 层序新旧的覆盖语义兜底。

## 模块架构

![读取数据流](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/read-path.svg)

两个入口共享同一套底层。点查路径：`LookupKey`（一次构造，`db/dbformat.h`）→ mem/imm 直查 → `Version::Get` 层路由（`ForEachOverlapping` 的回调式遍历）→ `TableCache::Get` 文件级 → `Table::InternalGet` 块级。迭代路径：`NewInternalIterator` 收集**内部键迭代器**（mem + imm + 每层）→ `NewMergingIterator` 归并 → 包一层 `DBIter` 翻译成用户键视图。两路的分叉只在最外层——点查要的是"第一个命中"，迭代要的是"全序流去重"。

`Iterator` 抽象（`include/leveldb/iterator.h`）是整个模块的接口货币：MemTableIterator、Block::Iter、MergingIterator、TwoLevelIterator、DBIter 五种实现互相包装组合，每种只懂自己的归并/翻译职责。

## 调用链路

```
点查: DBImpl::Get(options, key, &value)          db_impl.cc:1121
 ├─ snapshot = options.snapshot ? 其 seq : LastSequence
 ├─ [持锁] mem_/imm_/current 各 Ref()            ← 一致性窗口开始
 ├─ [解锁] LookupKey lkey(key, snapshot)
 │    ├─ mem_->Get(lkey)     命中(值/墓碑)即返回
 │    ├─ imm_->Get(lkey)     同上
 │    └─ current->Get(options, lkey, value, &stats)   version_set.cc:324
 │         └─ ForEachOverlapping(user_key, ikey, &state, State::Match)
 │              ├─ L0: 收集区间含 key 的文件 → 按文件号降序（新→旧）逐个 Match
 │              ├─ L1..L6: FindFile 二分 → 至多 1 文件 → Match
 │              └─ Match: table_cache_->Get(...) → SaveValue 回调判定
 │                    (kNotFound 继续 / kFound 停 / kDeleted 停 / kCorrupt 停)
 ├─ [加锁] have_stat_update && UpdateStats(stats) → MaybeScheduleCompaction
 └─ 三个 Unref()                                   ← 一致性窗口结束

迭代: DBImpl::NewIterator(options)                db_impl.cc:1168
 └─ NewInternalIterator                            db_impl.cc:1083
      ├─ list = [mem_->NewIterator(), imm_?, ...每层]
      │    └─ Version::AddIterators                version_set.cc:229
      │         ├─ L0: 每文件一个 table_cache_->NewIterator
      │         └─ L1+: NewConcatenatingIterator（TwoLevelIterator 套 LevelFileNumIterator）
      ├─ iter = NewMergingIterator(&icmp_, list)   table/merger.cc
      └─ RegisterCleanup(CleanupIteratorState)      ← 迭代器析构时 Unref 三个引用
 └─ NewDBIterator(db, ucmp, iter, snapshot, seed)  db/db_iter.cc
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DBImpl::Get` in `db_impl.cc:1121` | 点查编排 | Ref 三件套 + 解锁探测 |
| `Version::Get` in `version_set.cc:324` | 层路由 | 回调式遍历，Match 内自带停止语义 |
| `Version::ForEachOverlapping` in `version_set.cc:276` | L0 逆序 + L1+ 二分 | 层序即覆盖序 |
| `Version::UpdateStats` in `version_set.cc:402` | seek 记账 | 反哺 compaction |
| `DBImpl::NewInternalIterator` in `db_impl.cc:1083` | 组装归并树 | Cleanup 钩子管引用生命周期 |
| `DBIter::FindNextUserEntry` in `db/db_iter.cc:177` | 正向多版本过滤 | skip 指针跳过同键旧版 |
| `DBIter::FindPrevUserEntry` in `db/db_iter.cc:236` | 反向多版本过滤 | 方向切换时先回扫到键边界 |
| `MergingIterator::FindSmallest` in `table/merger.cc` | 归并选头 | 比较内部键，天然 seq 新者胜 |
| `NewDBIterator` in `db/db_iter.cc` | 用户视图包装 | 方向状态 + 采样调度 |
</details>

## 核心实现

### 点查：Ref 三件套与回调式层遍历

`DBImpl::Get` 的骨架（`db_impl.cc:1135-1149`）先持锁抓三份引用再放锁——`mem_`、`imm_`、`current` 的存活期覆盖整个探测过程，切表/换版本都不会让手里的指针悬空。探测本身全在锁外，包括所有磁盘 IO。

`Version::Get` 的层遍历用了一个**函数指针回调**（`ForEachOverlapping(user_key, internal_key, arg, func)`）而非迭代器：L0 收集区间命中文件后按文件号**降序**排序（`NewestFirst` 比较器，`version_set.cc:273`），逐个调 `State::Match`；L1+ 每层 `FindFile` 二分出一个候选再 Match——候选判定是 `user_key < f->smallest.user_key()` 则该层无此键（找到的文件区间已越过查询键），直接跳过整层。`Match`（`version_set.cc:335`）内部经 `TableCache::Get` 触发 `SaveValue` 回调——四态返回（NotFound 继续 / Found / Deleted / Corrupt 停止）控制是否继续下沉。**找到即停**的底气：同一 user_key 的更旧版本只会出现在更老的层，先命中的一定最新。

### seek 统计：读路径的"影子逻辑"

`Version::Get` 里 `State::Match` 开头那段（`version_set.cc:337-341`）与查询结果无关：**这次读若探了不止一个文件，就给"第一个探的文件"记一笔 seek**。回到 `DBImpl::Get`，`UpdateStats`（`version_set.cc:402`）给 `allowed_seeks` 减一，减穿且当前无 seek 任务则把该文件立为 `file_to_compact_` 并触发 `MaybeScheduleCompaction`。

设计意图（`Builder::Apply` 的换算注释，`version_set.cc:655`）：文件被穿透一次 ≈ 10ms 一次随机 IO ≈ 压实 40KB 数据的代价；每 16KB 文件配一次 seek（下限 100）。一个被反复穿而不中的文件（下层也无命中），合并它能摊平这条读路径——**把"读到了多少"变成"该重排哪里"的信号**。迭代路径每读约 1MB（`kReadBytesPeriod`，`DBIter` 的 `bytes_until_read_sampling_`）也采样一次（`RecordReadSample`，`version_set.cc:411`：与两个以上文件区间相交才算 seek）。

### 迭代器组合树：四种 Iterator 的拼装

`NewInternalIterator`（`db_impl.cc:1083`）组装内部键迭代器树，两个层相关的构造选择：

```cpp title="db/version_set.cc"
void Version::AddIterators(...) {
  // L0 文件互相重叠：每文件独立迭代器
  for (size_t i = 0; i < files_[0].size(); i++)
    iters->push_back(vset_->table_cache_->NewIterator(...));
  // L1+ 文件区间互斥：一个 TwoLevelIterator 串起整层
  for (int level = 1; level < config::kNumLevels; level++)
    if (!files_[level].empty())
      iters->push_back(NewConcatenatingIterator(options, level));
}
```

L1+ 的 `NewConcatenatingIterator`（`version_set.cc:222`）= `TwoLevelIterator`（`table/two_level_iterator.cc`）套 `LevelFileNumIterator`（`version_set.cc:163`，key=文件 largest 键，value=16B 文件号+尺寸）+ `GetFileIterator` 桥函数（经 TableCache 开表）——**文件级惰性打开**：迭代到哪个文件才打开哪个。所有叶子汇总进 `MergingIterator`（`table/merger.cc`）：`FindSmallest` 在所有孩子当前位置里选内部键最小者。归并无需懂"版本"——`(user_key asc, seq desc)` 的全序保证同 user_key 的最新版本总是先浮出水面。

引用生命周期交给 `Iterator::RegisterCleanup`（`include/leveldb/iterator.h` 的 CleanupNode 单链表）：`IterState`（`db_impl.cc:1063`）封装 mem/imm/version 三个引用，**迭代器析构时在锁下统一 Unref**——用户随手 `delete it` 就是完整的资源回收，这个钩子机制让组合迭代器树的资源管理无需侵入每个节点。

### DBIter：内部键到用户键的翻译层

`DBIter`（`db/db_iter.cc:48`）是归并树上唯一面向用户的包装，两个职责：

**多版本过滤**（`FindNextUserEntry`，`db_iter.cc:177`）：正向走时，遇到 `kTypeDeletion` 就把该 user_key 记进 `skip`（`SaveKey`）并置 `skipping=true`；遇到 `kTypeValue` 时用 **`user_comparator_->Compare(ikey.user_key, *skip) <= 0`** 判隐藏——`<=`（而非 `<`）意味着被删键自身的旧版本也在跳过范围（skip 记的是同一个键）；不属于 skip 范围且 `seq <= snapshot` 即产出。`ikey.sequence > sequence_` 的条目静默跳过——**快照隔离在迭代器里的实现就这一行判断**。流末的终态：`valid_ = false`、`saved_key_.clear()`——一个干净的失效，状态不残留。

**方向切换优化**（`Next/Prev` 的 `direction_` 处理）：反向时内部迭代器停在"当前 user_key 的版本串之前"，正向时停在串头，切换方向需先回扫对齐（`db_iter.cc:209-232`）。`key()/value()` 在两个方向上分别从内部迭代器或 `saved_key_/saved_value_` 取——反向时当前条目不在内部迭代器上，必须缓存。反向多版本过滤的 `FindPrevUserEntry`（`db_iter.cc:236`）：`value_type` 预置为 `kTypeDeletion`，逐条向前回扫同一 user_key 的版本串——**遇到第一个 `kTypeValue` 即产出并 `ClearSavedValue()`**；扫到头仍是删除标记则该键直接跳过（`valid_ = false` 或继续找上一个键），方向状态保持 `kReverse` 等待下一次回扫。反向比正向慢的原因也在此：`Prev` 每步都要回扫到键边界（SkipList 的 `Prev` 同样是"向前找前驱"而非真双向链，见 [03 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/03-memtable)）。

**归并器自身的方向切换**（`MergingIterator::Next/Prev`，`table/merger.cc`）：`Next` 前若处于反向（`direction_ != kForward`），先把**所有**非 current_ 的孩子 `Seek(key())` 对齐到当前键，再把 current_ `Next()` 一步——保证所有孩子都位于当前键之后；`Prev` 对称（全员 `Seek` 后 `FindLargest`）。`NewMergingIterator` 对退化输入有快捷分支：n==0 返回 `NewEmptyIterator()`、n==1 直接返回那个孩子——**单输入免一层包装**。采样调度藏在 `DBIter::ParseKey`（`db_iter.cc:122`）：`bytes_until_read_sampling_` 递减到 0 时调用 `db_->RecordReadSample(ExtractUserKey(key))`，周期由 `RandomCompactionPeriod()` 生成——`kReadBytesPeriod * (2 + seed % 5)`，即 2-6 倍 1MB 的**随机抖动**（防所有迭代器同相位采样打爆统计）。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| 组合模式 | `db_impl.cc:1083` `NewInternalIterator` 的树状拼装 | 归并/两层/块迭代器同接口递归组合 |
| 回调遍历 | `version_set.cc:276` `ForEachOverlapping` + `State::Match` | 停止语义内联进遍历，免构造中间列表 |
| 装饰器 | `db/db_iter.cc` `DBIter` 包 `MergingIterator` | 键视图翻译与归并逻辑分离 |
| RAII 钩子 | `include/leveldb/iterator.h` `RegisterCleanup` | 组合树任意深度的资源回收 |
| 引用计数快照 | `db_impl.cc:1135` Ref 三件套 | 读一致性窗口 = 引用存活期 |

## 模块间交互

上游是公共 API（`Get/NewIterator/GetSnapshot`）。中层依赖 [版本管理](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/02-version-manifest)（`current()` 视图 + `ForEachOverlapping` 路由）与 [MemTable](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/03-memtable)（mem/imm 两路输入）。底层依赖 [SSTable](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/05-sstable-format)（`Table::InternalGet`/`Table::NewIterator`）与 [缓存](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/07-cache-bloom)（`TableCache` 文件级 + `Table::BlockReader` 块级，两级 LRU）。向 [compaction](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/04-compaction) 单向输出 seek 统计信号。快照（`snapshots_`）只为 `DBImpl::Get/NewIterator` 提供 sequence 水位，与结构引用（Ref）正交协作。

## 扩展方式

- **加 MultiGet**（批量点查共享一次版本抓取）：`DBImpl::Get` 泛化成循环——`Ref 三件套` 提到循环外即可，`TODO` 文件里 "There have been requests for MultiGet" 正是此意；RocksDB 的 MultiGet 就从这里长出
- **前缀 seek**（RocksDB `prefix_seek` 路线）：`DBIter::Seek` 换 SeekForPrev 族 + 前缀比较器
- **迭代器级块预取**：`TwoLevelIterator` 的 `SkipEmptyDataBlocksForward` 处插预取钩子
- 对应测试：`db/db_test.cc` 的 `GetEncounter*`/`Iter*` 系列（迭代器行为近 40 个用例）、`table/merger.cc` 的对拍测试在 `table_test.cc`
