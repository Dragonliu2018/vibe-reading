---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "SSTable 文件格式"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "SSTable", "Block Format", "文件格式"]
description: "SSTable 字节级格式：data/index/filter/metaindex 四类块、前缀压缩与 restart 二分、pending_index_entry 短索引键、Footer 定长尾与 48 字节提交点。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

SSTable（Sorted String Table，文件后缀 `.ldb`/`.sst`）是 LevelDB 的静态数据形态：memtable 落盘、compaction 输出，都产它；读取路径的所有磁盘 IO 最终都落到它身上。`table/` 目录 16 个文件 ~2,100 行实现了这套格式的**读、写两端**：`TableBuilder`（`table/table_builder.cc`）把有序 KV 流写成文件，`Table`（`table/table.cc`）打开文件做点查与迭代。

格式设计目标只有一个：**让一次点查最多读两个块**（index + 一个 data block，外加可选 filter 拦截）。为此付出的是写端的复杂度——前缀压缩、延迟索引键、按偏移分段的 filter，全部为了读时的块粒度寻址。官方 `doc/table_format.md` 是本篇的一手对照。

## 模块架构

文件的整体布局（自上而下）：

```
<文件头>                          [data block 1..N]   ← 前缀压缩的有序 KV
                                 [meta block]         ← filter（Bloom）块
                                 [metaindex block]    ← "filter.<N>" → filter 块的 BlockHandle
                                 [index block]        ← 每数据块一条：短键 → BlockHandle
<文件尾 48B 定长> Footer          metaindex_handle + index_handle + padding + magic
                                  magic = 0xdb4775248b80fb57
每块尾 5B trailer：1B 压缩类型 + 4B Mask(crc32c(块内容+类型字节))
```

读写两端的组件对应：写端 `TableBuilder::Rep`（`table_builder.cc:32`）聚合 `BlockBuilder data_block`、`BlockBuilder index_block`（restart 间隔特化为 1）、`FilterBlockBuilder`、以及 `pending_index_entry` 延迟机制；读端 `Table::Open`（`table/table.cc:47`）只读 Footer + index block 即可服务，`filter` 懒加载（`ReadMeta`→`ReadFilter`）。**索引常驻、数据按需、过滤懒取**——三级加载策略对应三级读代价。

## 调用链路

```
写:  TableBuilder::Add(key, value)              table_builder.cc:93
      ├─ pending_index_entry? → FindShortestSeparator 补上一块的索引条目
      ├─ filter_block->AddKey(key)
      ├─ data_block.Add(key, value)
      └─ 估算 ≥ block_size(4KB) → Flush() → WriteBlock（压缩+trailer）→ 记 pending_handle
Finish()                                        table_builder.cc:211
 ├─ Flush 最后一块
 ├─ filter 块（不压缩）→ metaindex("filter."+policy->Name()) → index 块
 └─ Footer 定长 48B 收尾

读:  Table::Open(file, size)                    table.cc:47
      ├─ 读末 48B → Footer::DecodeFrom（校验 magic）
      ├─ ReadBlock(index_handle)
      └─ ReadMeta → metaindex Seek("filter.*") → ReadFilter（懒）
Table::InternalGet(k)                           table.cc:223
 ├─ index_block Seek(k) → BlockHandle
 ├─ filter->KeyMayMatch(handle.offset(), k)?  否 → 不读 data block 直接 NotFound
 └─ BlockReader（查缓存/读盘/解压）→ block Seek(k) → handle_result 回调
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `TableBuilder::Add` in `table_builder.cc:93` | 追加一条 KV | 延迟索引键待下一块首键 |
| `TableBuilder::Flush` in `table_builder.cc:126` | 落一个数据块 | 同时 StartBlock 更新 filter 段 |
| `TableBuilder::WriteBlock` in `table_builder.cc:145` | 压缩并写块+trailer | 省 <12.5% 放弃压缩 |
| `TableBuilder::Finish` in `table_builder.cc:211` | 收尾四件套 | Footer 定长保证免索引定位 |
| `BlockBuilder::Add` in `table/block_builder.cc:69` | 前缀压缩编码 | restart 间隔 16 |
| `Block::Iter::Seek` in `table/block.cc:160` | restart 二分+块内线性 | 沿用当前位置免重搜 |
| `Table::Open` in `table/table.cc:47` | 打开表 | 只预读 index，filter 懒 |
| `Table::InternalGet` in `table/table.cc:223` | 点查三级跳 | filter 在读块之前 |
| `ReadBlock` in `table/format.cc` | 按 handle 读+校验+解压 | crc32c Unmask 后比对 |
</details>

## 核心实现

### 块格式：前缀压缩与 restart 二分

数据块是最小传输单位（默认 4KB 未压缩）。`block_builder.cc` 头部注释即完整格式说明，条目编码：

```
shared_bytes   varint32     ← 与前一条目 key 的公共前缀长度
non_shared     varint32
value_length   varint32
key_delta      char[non_shared]   ← 只存差量
value          char[value_length]
—— 每 16 条（block_restart_interval）设一个 restart 点，shared 归零存全键
块尾：restarts: uint32[] + num_restarts: uint32
```

前缀压缩对**有序键流**收益极大（相邻 key 常共享长前缀），但破坏了二分的前提——任意位置不能 O(1) 解出键。restart 点就是解法：16 条一个全键锚点，块内查找先对 restart 数组二分（每锚点 shared=0 可独立解码），锚点段内线性扫。`Block::Iter::Seek`（`block.cc:160`）的二分有个容易忽略的细节：`mid = (left + right + 1) / 2` **向上取整**——配 `left = mid` 的推进方向，防止 left 与 right 相邻时 mid 永远等于 left 的死循环；判定条件是"mid 键 < target 则 left=mid，否则 right=mid-1"。解码锚点条目若发现 `shared != 0`（合法 restart 条目必须存全键），直接 `CorruptionError()` 拒绝——损坏的块不猜测。`Seek` 还有个顺手的优化：迭代中 Seek 若目标在当前位置之后，直接把当前 restart 段当左界（`skip_seek`），顺序扫描场景免掉重二分。

**读端解压是逐条在线的**（`ParseNextKey` 现场拼 `key_`），配合 `DecodeEntry` 的 3 字节快路径（三个 varint 全 <128 时一字节一个，`block.cc:61`）——块内遍历的常数被压到极致。

### pending_index_entry：索引键的"事后聪明"

索引块每条 =（分隔键，BlockHandle）。最朴素的分隔键是每块的最后一条键，但它可能很长。`TableBuilder::Add`（`table_builder.cc:101-110`）的 `pending_index_entry` 机制把索引条目的生成**推迟到看到下一块的第一条键**，此时 `FindShortestSeparator(&last_key, next_key)`（`include/leveldb/comparator.h` 的可选高级方法）可以在两者之间造一个**足够短**的分隔键——如 "the quick brown fox" 与 "the who" 之间取 "the r"。语义要求只是 `≥ 块内所有键 且 < 下一块所有键`，短一个字节索引就小一分。文件收尾的最后一键用 `FindShortSuccessor`（如 "the" → "thf"）。

这是**比较器成为格式一部分**的地方：自定义 Comparator 不实现这两个方法也正确（不缩短即可），但实现了就白赚索引压缩。L1+ 文件巨大时索引块的尺寸差距可达数倍。

### filter 块：按文件偏移分段

`FilterBlockBuilder`（`table/filter_block.cc:24`）不按"每数据块一段 filter"，而按**文件偏移每 2KB 一段**（`kFilterBaseLg = 11`）：`StartBlock(block_offset)` 换算成段号，落后就 `GenerateFilter()` 补空段。理由在格式文档里：数据块是压缩后的变长单位，解压前拿不到稳定边界；**文件偏移在写端和读端都无条件可知**。读端 `FilterBlockReader::KeyMayMatch(block_offset, key)`（`filter_block.cc:90`）用 `block_offset >> base_lg` 直查段表，块尾布局：`[filters...][offsets uint32[]][offset-array 起点 uint32][lg(base) 1B]`——自描述，向前兼容。

块级 Bloom 的收益链：`Table::InternalGet` 中 filter 判定发生在 `BlockReader` **之前**（`table.cc:229-232`），不存在的键一次 data block IO 都不用发生。10 bits/key ≈ 1% 误判（`NewBloomFilterPolicy` 注释），算法细节见 [07 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/07-cache-bloom)。

### 压缩与 trailer：每块独立

`WriteBlock`（`table_builder.cc:145`）对整块做 Snappy 或 Zstd（1.23 后），**压缩后 ≥ 原长 - 12.5% 就放弃**退回不压缩——incompressible 数据不吃亏。块尾 trailer 固定 5 字节：1 字节类型 + 4 字节 `crc32c::Mask(crc)`。Mask（`util/crc32c.h:38`：循环右移 15 位加常数 `0xa282ead8`）存在的理由注释写得直白——**存起来的 CRC 不能直接当数据再被 CRC**（块内容嵌块校验时会失真），Mask 后的值无此问题。每块独立校验+独立压缩，意味着损坏永远只影响一块、读永远可以按块解压并行——**以 trailer 空间换隔离性**。

### Footer：48 字节的免索引入口

```cpp title="table/format.h"
enum { kMaxEncodedLength = 10 + 10 };          // BlockHandle: 2 个 varint64
class Footer {
  BlockHandle metaindex_handle_;
  BlockHandle index_handle_;
};  // 编码定长 48B：两个 handle + 零填充 + magic 0xdb4775248b80fb57
```

文件尾永远可以"倒着找"：`Table::Open` 先做长度前置检查——`size < Footer::kEncodedLength`（48 字节）直接 `Corruption("file is too short to be an sstable")`，然后从 `size - 48` 读 Footer，两个 varint64 BlockHandle（offset+size 各至多 10B）+ padding 补齐定长 + 8 字节 magic（取自 `echo http://code.google.com/p/leveldb/ | sha1sum` 的前 64 bit，一个有指纹感的常量）。**定长尾免掉了任何开表索引**——这是"点查最多两个块"承诺的第一块拼图。基线快照里 `068d5ee`（"Check slice length in Footer::DecodeFrom"）还加固了对畸形 Footer 的长度校验。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| Pimpl | `table_builder.cc:32` `TableBuilder::Rep`、`table.cc:24` `Table::Rep` | 公共头零内部字段泄漏，格式自由演进 |
| 延迟决策 | `table_builder.cc:101` `pending_index_entry` | 索引键质量依赖未来信息，推迟生成 |
| 两级迭代器 | `table/two_level_iterator.cc` `TwoLevelIterator` | index 遍历驱动 data 遍历的通用骨架 |
| 模板方法 | `table/table.cc` `ReadMeta/ReadFilter` | 可选部件（filter）懒加载钩子 |
| 自描述格式 | `table/format.h` Footer/filter 块尾 | 版本演进无需外部 schema |

## 模块间交互

上游：`BuildTable`（`db/builder.cc`）与 `OpenCompactionOutputFile`（`db/db_impl.cc:806`）在 memtable 落盘/compaction 输出时驱动 `TableBuilder`，输入是全序 KV 流（memtable 迭代器或 `MergingIterator`，键序由 `InternalKeyComparator` 保证——**写端 assert key 递增**，`table_builder.cc:99`）。下游：读取路径经 `TableCache` 打开 `Table`；块缓存交互在 `Table::BlockReader`（`table.cc:138`，见 [07 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/07-cache-bloom)）。依赖仅 `util/coding/crc32c` 与公共头；`table/` 不 include `db/` 任何文件——**格式层对引擎层零感知**，这也是它能被 leveldbutil、ldb 等工具独立解析的原因。

## 扩展方式

- **加 meta block 类型**（如 stats/属性块）：`doc/table_format.md` 预留了 "stats" TODO——`TableBuilder::Finish` 加写入段 + `Table::ReadMeta` 加分发（metaindex 的 key 路由就是为此设计的）
- **换压缩**：见概览典型修改场景 1（`WriteBlock` 的 switch 是唯一改动点）
- **前缀 bloom/索引**（RocksDB 路线）：`FilterBlockBuilder::AddKey` 处把 key 换成前缀、`BlockBuilder` 加 `index_type`——读写两端同改，靠 `Name()` 版本化防混读
- **改 restart 间隔**：`Options::block_restart_interval`（默认 16）已是公共选项；index 块特化为 1（`table_builder.cc:41`）因为索引条目少且 Seek 频繁
- 对应测试：`table/table_test.cc`（24.1K，读写端对拍 + 迭代器全覆盖）、`table/filter_block_test.cc`
