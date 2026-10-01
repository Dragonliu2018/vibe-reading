---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "Overview"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "LSM-Tree", "Storage Engine", "C++"]
description: "Facebook 开源嵌入式 KV 存储引擎 v9.11.1 全景解读：写入路径 group commit、Version/Manifest 元数据、MemTable、Compaction、BlockBasedTable SST 格式、读写路径与三后端缓存。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v9.11.1（2025-03-05，tag commit `68b2d941b`）· **协议** GPLv2 / Apache 2.0 双许可 · **语言** C++17 · **代码量** 核心非测试 ~180k 行 .cc + ~140k 行 .h · **仓库** [GitHub](https://github.com/facebook/rocksdb)

---

## 总览

### 项目简介

RocksDB 是 Facebook 开源的**嵌入式持久化 key-value 存储引擎**——没有网络层、没有 SQL、没有服务进程，就是一个链接进宿主程序的库（MyRocks、TiKV、CockroachDB、Flink state backend、FoundationDB 的某后端都是拿它当存储引擎）。README 的自我定位是 "a persistent key-value store for fast storage environments"——它为 SSD/NVMe 而生，用 **LSM-Tree**（Log-Structured-Merge）设计换取写吞吐，把 WAF（写放大）/RAF（读放大）/SAF（空间放大）三个因子的权衡暴露成上百个可调选项。

三条核心价值主张：

1. **写路径极致优化**：所有写先入内存跳表 + 顺序追加 WAL，绝不随机写盘；group commit 把 N 个并发写折叠成一次 WAL append + 一次 fsync。
2. **读路径多层加速**：MemTable 直查 → L0 逐文件 → L1+ 逐层二分（FileIndexer 剪枝）→ SST 内三级（bloom filter → index block → 块内 restart 二分/哈希），外加 block cache 与 table cache 两级缓存。
3. **一切皆可调**：compaction 三种策略（leveled/universal/fifo）、三种 memtable 实现、block 格式细节、后台线程数、限速……每个选项标明是否可 `SetOptions()` 热改。

**项目边界**：没有分布式（无复制/分片——TiKV 等在外面自己加 Raft）、没有 SQL 解析（纯 KV API + MergeOperator）、不是服务（宿主程序管进程生命周期）。单实例数据规模设计目标是 TB 级。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| KV 读写 | `db/db_impl/db_impl.cc` | Get/ Put/ Delete/ Merge/ Iterator/Snapshot（MVCC by sequence number） |
| Column Family | `db/column_family.cc` | 一个 DB 内多命名空间，共享 WAL 与空间，独立选项 |
| WriteBatch 原子写 | `db/write_batch.cc`（3498 行） | 12 字节头 + record 流的批处理编码，跨 CF 原子提交 |
| 事务（可选） | `utilities/transactions/` | 悲观（行锁+2PC）/乐观（冲突检测）两种，三种 write policy |
| 大 value 分离 | `db/blob/` + flush/compaction 集成 | value 超阈值写独立 blob 文件，SST 只存 blob_index |
| Compaction | `db/compaction/`（~29k 行） | leveled（默认）/universal/fifo 三策略 + 远程 CompactionService |
| SST 格式 | `table/block_based/` | data/index/filter block + footer；三级索引 + bloom/ribbon filter |
| 缓存 | `cache/` | LRUCache（默认）/HyperClockCache + 压缩 secondary cache + 分片 |
| 多形态实例 | `db/db_impl/db_impl_secondary|follower|readonly` | 物理复制的只读副本（共享存储 tail MANIFEST） |
| 备份/检查点 | `utilities/backup/`、`utilities/checkpoint/` | BackupEngine 增量备份；Checkpoint 硬链接快照 |
| 观测 | `monitoring/` + `db/internal_stats.cc` | Statistics per-core 分片计数、PerfContext 线程级剖析 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| 无强制第三方依赖 | 核心 | 纯 C++17 标准库实现（glibc 系统调用） |
| zlib/zstd/bzip2/lz4 | 可选 | block 压缩（编译期探测） |
| liburing | 可试 | Linux io_uring 批量/异步读（`ROCKSDB_IOURING_PRESENT`） |
| jemalloc/memkind | 可试 | 内存分配器（nodump allocator 等） |
| gflags/gtest/benchmark | 构建 | 工具与测试 |
| JNI（`java/`） | 可选 | Java 绑定（192 个类） |

### 版本历史

RocksDB 源自 2013 年 Facebook 对 LevelDB 的 fork。9.x 主线（2024-2025）的演进重点：**HyperClockCache**（替代有 bug 被删除的老 ClockCache）、**tiered compaction**（`preclude_last_level_data_seconds` 等 per-key placement 特性）、**follower 模式**（2024 新增的第三种只读副本）、**CompactionService**（远程卸载 compaction）、**WAL 链式校验**（`track_and_verify_wals`，9.11.0 新增，替代 6.16.0 的 `track_and_verify_wals_in_manifest`）。v9.11.1（2025-03-05）是 9.11.0 的修复版：修 `GetMergeOperands()` 的错误状态返回。

### 顶层上下文图

外部交互面：**宿主程序**经 `include/rocksdb/` 的 81 个公共头调用（唯一稳定 API——头文件注释明确 "Callers should not include or rely on the details of any other header files"）；**文件系统**经 `Env`/`FileSystem` 双层抽象（posix 默认，可插远程 FS/加密/tracer）；**OS 线程**经 Env 线程池（HIGH=flush/LOW=compaction/BOTTOM 三池）；**观测系统**经 Statistics/PerfContext/EventListener 三通道；**JVM** 经 `java/` 绑定。

## 快速上手

```bash
# 1. 编译静态库（约几分钟）
cd rocksdb && make -j8 static_lib
# 或 cmake: cmake -B build && cmake --build build -j8

# 2. 最小示例（examples/simple_example.cc 的骨架）
```

```cpp title="examples/simple_example.cc（骨架）"
DB* db;
Options options;
options.create_if_missing = true;
Status s = DB::Open(options, "/tmp/rocksdb_simple", &db);
s = db->Put(WriteOptions(), "key1", "value");
std::string value;
s = db->Get(ReadOptions(), "key1", &value);
delete db;
```

验证"跑起来了"：跑 `./db_stress` 或 `make db_bench && ./db_bench -benchmarks=fillrandom,readrandom -num=100000`，看统计里 WAL 文件数、L0 文件数、compaction 计数在动。

## 架构设计解析

### 系统架构

设计思想一句话：**用"追加写 + 后台归并"替代"原地更新"**——写路径只碰内存跳表和顺序 WAL，磁盘上的 SST 文件一旦写成就不可变；所有合并、去重、垃圾回收都推给后台 compaction 线程。这带来了两样东西：写吞吐（盘上永远只有顺序写）和复杂度（读要在多层里找最新版本、空间要靠后台整理）。全库的复杂性都在消化这个取舍。

![分层架构](/vibe-reading/images/articles/rocksdb-codewiki-9.11.1/architecture.svg)

四层职责与依赖方向：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| API 层 | `include/rocksdb/`（81 头） | 唯一稳定契约，隔离引擎内部演进（"internal APIs may be changed without warning"） |
| 编排层 | `db/db_impl/`（~24.5k 行） | DBImpl 中枢：写/读/后台调度/恢复/CF 管理；一切子系统的装配点 |
| LSM 数据层 | `db/`（write_thread、version_set、memtable、compaction、db_iter 等） | LSM 语义本体：MVCC、版本元数据、内存层、后台归并、读路径 |
| 存储与缓存层 | `table/`、`cache/`、`env/`、`file/`、`util/`、`memtable/`（跳表） | SST 格式、三级缓存、IO 抽象、编解码与限速 |

监控（`monitoring/`）与选项（`options/`）横切全部层。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Lock-free Treiber stack + leader/follower | `write_thread.cc` 的 `newest_writer_` + `JoinBatchGroup` | group commit：单删除者免 ABA |
| Copy-on-write 版本链 + 双级引用计数 | `version_set.cc` 的 `Version::Ref` + `FileMetaData::refs` | 读无锁：旧 Version 永不被修改 |
| 策略 | `CompactionPicker` 三实现（level/universal/fifo）+ `MemTableRep` 四实现 | compaction 形态与内存结构可插拔 |
| 模板方法 | `PessimisticTransaction::Prepare/Commit` 骨架 + 三种 write policy 子类 | 事务状态机复用，写入策略可换 |
| 装饰器（StackableDB） | `utilities/` 的 TransactionDB/BlobDB/TTL | 功能叠加不动核心引擎 |
| 分片 | `cache/sharded_cache.cc`、`PointLockManager` 的 stripe | 锁竞争按 hash 摊开 |
| 伪反射注册表 | `options/` 的 Configurable + OptionTypeInfo 偏移表 | 一套元数据撑起解析/序列化/校验/热改 |
| 两级迭代器 | `BlockBasedTableIterator`（index+data）、`PartitionIndexReader` | 惰性加载，bounded scan 少读块 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `InternalKey` | user key + 8 字节尾（seq<<8 \| type） | 一切 KV 的统一形态 | 排序规则：user key 升序、seq 降序 |
| `WriteBatch` | 12B 头 + record 流的原子写入单元 | 单次 Write 调用 | rep_ 可直接 memcpy 合并（group commit） |
| `MemTable` | 内存跳表 + 独立 range tombstone 表 | 写满 seal 成 immutable | 进 MemTableList 队列等 flush |
| `Version` | 一个 CF 在某时刻的不可变 SST 文件视图 | COW 链表，引用计数 | 挂在 CF 的 dummy_versions_ 环上 |
| `VersionSet` | 全 DB 的版本总管 + MANIFEST 写入 | DB 生命周期 | LogAndApply 是唯一提交点 |
| `SuperVersion` | mem + imm + current Version 的三元组快照 | 线程本地缓存，原子切换 | 读路径免 DB mutex 的关键 |
| `FileMetaData` | 单个 SST 的全部元数据 | 跨 Version 共享同一对象 | refs 计数保护物理文件生存期 |
| `Block` | SST 块的解压内存形态 | block cache 或 owned | restart 数组支持二分 |
| `WriteThread::Writer` | 一次写入请求在队列中的化身 | 栈上对象，leader 唤醒后即析构 | 状态机 7 态 |

```
用户 key →(PackSequenceAndType)→ InternalKey →(写入)→ MemTable 跳表 + WAL record
     →(flush)→ L0 SST →(compaction)→ L1..LN SST →(VersionEdit)→ 新 Version
     →(读)→ GetImpl 逐层 / MergingIterator 堆合并 → user key
```

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Env` / `FileSystem` | `include/rocksdb/env.h:151` / `file_system.h:292` | Posix（默认）/Mock/ReadOnly/Encrypted/Tracer/Remap | ObjectLibrary 工厂按 URI 名加载 |
| `MemTableRep` / `MemTableRepFactory` | `include/rocksdb/memtablerep.h:61` | InlineSkipList（默认）/HashSkipList/HashLinkList/Vector | `CreateFromString` |
| `CompactionPicker` | `db/compaction/compaction_picker.h:48` | Level/Universal/FIFO/Null | 按 compaction_style 在 CFD 构造时选定 |
| `FilterBitsBuilder/Reader` | `table/block_based/filter_policy.cc` | Bloom/Ribbon | `BuiltinFilterPolicy::GetBuilderFromContext` |
| `Cache` | `include/rocksdb/cache.h` | LRUCache/HyperClockCache（经 ShardedCache） | `NewLRUCache`/`HyperClockCacheOptions` |
| `SecondaryCache` | `include/rocksdb/secondary_cache.h` | CompressedSecondaryCache/TieredSecondaryCache | 经 `CacheWithSecondaryAdapter` 装配 |
| `MergeOperator` / `Comparator` | `include/rocksdb/` | 用户自定义 | Options 注入 |
| `TransactionDB` | `include/rocksdb/utilities/transaction_db.h:433` | Pessimistic(Optimistic) 三种 write policy | `TransactionDB::Open` |

## 代码目录

```shell
rocksdb/
├── include/rocksdb/          # 唯一公共 API（81 个头；c.h 是 C 绑定）
├── db/                       # LSM 核心与编排（~200 文件）
│   ├── db_impl/              #   DBImpl 中枢 16 文件 ~20.3k 行（write/open/compaction_flush/files/secondary/follower）
│   ├── compaction/           #   picker/job/iterator/outputs（~29k 行）
│   ├── blob/                 #   大 value 分离存储 45 文件
│   ├── wide/                 #   wide column 序列化
│   ├── version_set.cc        #   7575 行——Version/VersionSet/Manifest（全库最大非测试文件）
│   ├── write_thread.cc       #   group commit 无锁队列
│   ├── write_batch.cc        #   3498 行批处理编码与 MemTableInserter
│   ├── db_iter.cc / dbformat.h  # 读方向转换与 internal key 定义（dbformat.h 被引用 83 次，全库最高）
│   └── memtable.cc / memtable_list.cc / table_cache.cc / column_family.cc
├── table/                    # SST 格式（block_based 为主，另有 plain/adaptive/cuckoo）
│   └── block_based/          #   builder 2207 行 / reader 3248 行 / filter / index
├── cache/                    # LRU（默认）/HyperClockCache/分片/二级缓存/容量预留
├── memtable/                 # 跳表实现（inlineskiplist 1178 行）与 WBM
├── env/ + file/              # Env/FileSystem 双层抽象（posix/io_uring）、限速删除、预读
├── options/ + monitoring/    # Configurable 反射注册表；statistics/perf_context
├── utilities/                # 47 个叠加功能：transactions/blob_db/backup/checkpoint/ttl/...
├── java/                     # JNI 绑定（192 个 Java 类）
├── tools/                    # ldb/ db_bench/ db_stress 等
└── docs/                     # GitHub Pages 文档站（FAQ/getting-started）
```

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/rocksdb-codewiki-9.11.1/module-dependencies.svg)

依赖方向的骨干：DBImpl 编排一切数据模块；`db/dbformat.h`（InternalKey/比较器）是被引用最多的内部头（83 处），横切所有数据模块；table 层依赖 cache 层与文件层；utilities 层只经公共 API + 少量友元叠加。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 写入路径 | WriteBatch 编码 + group commit + 写止速 | `WriteThread::JoinBatchGroup` | 无锁并发设计自成体系 | [01-write-path](01-write-path) |
| Version/Manifest | 不可变版本链 + 元数据提交协议 | `VersionSet::LogAndApply` | 全库一致性的锚点 | [02-version-manifest](02-version-manifest) |
| MemTable | 内存跳表 + imm 队列 + 内存配额 | `MemTableList::TryInstallMemtableFlushResults` | COW 快照与乱序执行按序提交 | [03-memtable](03-memtable) |
| Compaction | 三策略挑选 + 合并执行 + 文件切分 | `CompactionPicker::PickCompaction` | LSM 的心脏，29k 行 | [04-compaction](04-compaction) |
| BlockBasedTable | SST 物理格式的读写 | `BlockBasedTableBuilder::Add/Finish` | 格式契约独立于 LSM 语义 | [05-block-based-table](05-block-based-table) |
| 读路径 | 逐层点查 + 堆合并扫描 | `DBImpl::GetImpl` / `MergingIterator::Seek` | 与写路径完全解耦的加速链 | [06-read-path](06-read-path) |
| Cache | LRU/HyperClock + 二级 + 容量预留 | `LRUCacheShard::Release` | 三态层次与分片并发 | [07-cache](07-cache) |
| WAL 与恢复 | 32KB 分段日志 + 回放 + 错误分级 | `log::Writer::AddRecord` / `RecoverLogFiles` | 崩溃一致性的全部逻辑 | [08-wal-recovery](08-wal-recovery) |
| DBImpl 与 ColumnFamily | 中枢编排 + CF 生命周期 + 后台调度 | `MaybeScheduleFlushOrCompaction` | 全部子系统的装配点 | [09-dbimpl-cf](09-dbimpl-cf) |
| Env/FileSystem | IO 双层抽象 + 限速 + 预读 + 删除调度 | `PosixRandomAccessFile::MultiRead` | 可移植性与 IO 治理 | [10-env-filesystem](10-env-filesystem) |
| Blob 与事务 | 大 value 分离 + 三种 write policy | `BlobFileBuilder::Add` / `PessimisticTransaction::Commit` | utilities 层叠加功能的代表 | [11-blob-txn](11-blob-txn) |
| Options 与监控 | 反射注册表 + per-core 统计 | `Configurable::RegisterOptions` | 横切层的契约 | [12-options-monitoring](12-options-monitoring) |

## 运行时行为

### 启动流程

```
DB::Open（db_impl_open.cc:2319）
  1. ValidateOptions（options_helper.cc:41，Configurable 反射校验）
  2. new DBImpl（装配 VersionSet + table_cache_ + 线程池）
  3. Recover（db_impl_open.cc:418）
     ├─ LockFile(LOCK)（进程独占）
     ├─ versions_->Recover()：读 CURRENT → 回放 MANIFEST
     │   （VersionEditHandler 逐条 DecodeFrom → VersionBuilder delta 归并 → 初始 Version）
     ├─ 列 wal_dir → WalSet::CheckWals 对账（track_and_verify_wals）
     └─ RecoverLogFiles（:1135）：逐 WAL ReadRecord → InsertInto memtable
         → 写满即 WriteLevel0TableForRecovery 直接落 L0
         → edit->SetLogNumber(max_wal+1)（下次 open 跳过已恢复 WAL）
  4. 新建 WAL + dummy batch + LogAndApplyForRecovery（恢复期 edit 一次性原子提交）
  5. 各 CF InstallSuperVersion + DeleteObsoleteFiles + MaybeScheduleFlushOrCompaction
  6. StartPeriodicTaskScheduler（dump stats 等周期任务）
```

对象装配的关键事实：**一切经 DBImpl 构造函数与 Open 完成**——VersionSet 持有 ColumnFamilySet，每 CF 持 mem/imm/Version 三件套（SuperVersion 聚合）；table_cache 的容量语义是"打开文件数"（charge=1）；读路径拿 SuperVersion 引用即可无锁工作。配置优先级：代码默认值 → Open 时 options（SanitizeOptions 规范化，如强制 `level0_stop ≥ slowdown ≥ trigger`）→ SetOptions 热改（mutable 子集，经 InstallSuperVersionForConfigChange 原子生效）。

### 核心运行流程

#### 写入：一次 Put 到最终成为某层 SST

![Put 数据流](/vibe-reading/images/articles/rocksdb-codewiki-9.11.1/data-flow.svg)

文字解读：用户线程构造 WriteBatch（12B 头：8B 起始 seq + 4B count）进 `WriteThread::JoinBatchGroup` 的无锁队列；leader 吸收兼容 writer 成组（上限 1 MiB，小 leader 收紧到 1/8 防延迟放大），一次 WAL append（32KB 分段 + CRC）+ 一次可选 fsync 覆盖全组，再统一插 memtable（internal key = user key + 8B `(seq<<8)|type`），最后 `SetLastSequence` 发布可见性（刻意放在 memtable 插完之后，防"reader 拿到新快照却查不到数据"）。后台：memtable 写满 → seal 进 imm 队列 → FlushJob 转 L0 SST → compaction 按 score 挑文件合并去重下沉。

#### 读取：GetImpl 逐层与 MergingIterator 堆合并

点查 `GetImpl`（`db_impl.cc:2289`）：snapshot seq → active memtable 直查（跳表 Get）→ imm 逐个 → `Version::Get` 的 FilePicker 按层挑候选文件（L0 按 largest_seq 新→旧、L1+ FileIndexer 二分剪枝）→ 每个 SST 先 bloom filter（整 SST 一个 bloom，一次 lookup 裁决）再 index 定位 data block（cache 命中或读盘+解压）→ 块内 restart 二分或 hash index → `GetContext::SaveValue` 裁决版本可见性与 merge 语义。扫描路径：DBIter 包装 MergingIterator——后者把 memtable+imm+L0 每文件+L1+ 每层的迭代器（含 range tombstone）放进一个最小堆按 internal key 全序吐出，**不做去重**；DBIter 按 user key 跳旧版本并处理 merge 链。

#### 后台：flush 与 compaction 的双池调度

`MaybeScheduleFlushOrCompaction`（`db_impl_compaction_flush.cc:2834`）：flush 进 HIGH 池、compaction 进 LOW 池（**分池防 compaction 饿死 flush，而 flush 慢会直接卡死写路径**）；`unscheduled_/bg_scheduled_/num_running_` 三级计数器构成调度状态机；每个后台任务做完再调度一次直到队列空。compaction 的输入集必须扩展到 user key 的 clean cut（`ExpandInputsToCleanCut`）——同一 user key 的版本要么全进 compaction 要么全不进，否则 Get 会读到 stale 值。

### 状态流

MemTable 与 SST 文件的生命周期状态流（Version 视角）：

![MemTable 到 SST 状态流](/vibe-reading/images/articles/rocksdb-codewiki-9.11.1/state-flow.svg)

版本切换的规则：每一次文件集合变化（flush/compaction 完成、文件删除）都产生新 Version 挂到链头；旧 Version 由引用计数保护（迭代器/snapshot/compaction 持 ref），全部释放后其文件才进 obsolete 队列；`pending_outputs_` 用"文件号单调"这一个不变量保护所有 in-flight 输出文件（删除永不越过最小在途号）；`DeleteScheduler` 对删除限速（rename 成 `.trash` 后后台慢删，大文件分块 truncate 削峰）；WAL 在全部依赖它的 memtable flush 后才可删（2PC 场景还要等 `LogsWithPrepTracker` 对账）。

## 典型修改场景

#### 场景 1：新增一种 WriteBatch record 类型

四处同步：`db/write_batch.cc` 顶部 rep_ 格式注释与 `ReadRecordFromWriteBatch` 解析、`ContentFlags` 位与 classifier（影响并行 memtable 判定）、`MemTableInserter` 的 Handler 重载、WAL 恢复路径 `WriteBatchInternal::Iterate` 的 tag dispatch。漏 `kValueTypeForSeek`（`dbformat.cc:28`，type 最大值）会导致 seek 落点错误。

#### 场景 2：新增一个可热改 CF 选项

`advanced_options.h` 加字段 → `MutableCFOptions` 加成员 → `cf_mutable_options_type_info` 加 `{offsetof, kType, kNormal, kMutable}` 一条 → `UpdateColumnFamilyOptions` 加回写行。反射框架自动获得 SetOptions/OPTIONS 文件/比较全部能力。

#### 场景 3：新增一种 compaction 触发理由

`VersionStorageInfo::ComputeXxxFiles()`（`version_set.cc:3630+`）注册被标记文件 → `LevelCompactionBuilder::SetupInitialFiles` 的回退链加分支并赋 `CompactionReason::kXxx` → `CompactionReason` 枚举扩充。

## 测试体系

RocksDB 的测试是与生产代码同目录的 `*_test.cc`（`db/db_test.cc` 7717 行等，gmock/gtest），另有 `db_stress_tool/`（长时间随机操作+一致性校验，CI 杀手锏）与 `fuzz/`。值得注意：**CompactionIterator 专门抽出 `CompactionProxy` 窄接口**（`compaction_iterator.h:87`）使测试可注入 compaction 语义——这是为可测性做架构让步的范例。PerfContext 结构用 `static_assert` 校验字段偏移（`perf_context.cc:188`），加字段漏改直接编译失败。

## 阅读源码推荐路线

- **第一遍：理解写入主流程**
  `db/write_batch.cc:10` 的 rep_ 格式注释 → `db/write_thread.cc:401` 的 `JoinBatchGroup` → `EnterAsBatchGroupLeader`（`:440`）→ `db/db_impl/db_impl_write.cc` 的 `WriteImpl`（`:315`）leader 分支 → `write_batch.cc:3212` 的 `InsertInto`
- **第二遍：理解核心数据结构**
  `db/dbformat.h` 的 `InternalKey/ValueType/PackSequenceAndType` → `db/memtable.cc:909` 的 Add 编码 → `memtable/inlineskiplist.h` → `db/version_set.h:872` 的 Version/VersionStorageInfo → `db/version_edit.h:178` 的 FileMetaData
- **第三遍：理解元数据提交与后台**
  `db/version_set.cc:5910` 的 `LogAndApply` → `db/version_builder.cc:1429` 的 SaveTo 归并 → `db/compaction/compaction_picker_level.cc:510` → `compaction_iterator.cc:451` 的 `NextFromInput` → `compaction_outputs.cc:231` 的 `ShouldStopBefore`
- **第四遍：选重点深入**（模块文档）：SST 格式读 [05-block-based-table](05-block-based-table)；读路径与 pin 机制读 [06-read-path](06-read-path)；缓存三态读 [07-cache](07-cache)；崩溃恢复读 [08-wal-recovery](08-wal-recovery)

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| LSM-Tree | 追加写+后台归并的存储结构；RocksDB 的骨架 |
| Internal key | user key + 8 字节（56 位 seq + 8 位 type）；全库统一 KV 形态 |
| WAL | write-ahead log，32KB 分段 + 每 record CRC |
| MANIFEST | 元数据日志：VersionEdit 流 + CURRENT 指针 |
| Version | 一个 CF 的不可变 SST 文件视图（COW 链） |
| SuperVersion | mem + imm + Version 的三元组读侧快照 |
| group commit | leader 代表全组写一次 WAL/memtable/发布 seq |
| clean cut | compaction 输入集与 user key 边界对齐（防 stale read） |
| trivial move | 无重叠时只改元数据移动文件（零 IO） |
| compaction score | 层大小（或 L0 文件数）与目标的比值，≥1 触发 |
| blob_index | SST 内嵌的 value 地址（file_number/offset/size/压缩） |
| write stall | memtable/L0/pending bytes 触线时的写减速或停写 |
| pinned iterator | 长扫描 pin 住 data block 防 cache 踢出 |

### 参考资料

- [RocksDB Wiki](https://github.com/facebook/rocksdb/wiki)——官方架构与调优文档（RocksDB 特有知识的最权威来源）
- `HISTORY.md`——逐版本变更（版本归属核实的一手依据）
- `USERS.md`——生产使用者清单（Facebook 全家桶、TiKV、CockroachDB、FoundationDB 等）
- `DUMP_FORMAT.md` / `docs/`——格式与入门
