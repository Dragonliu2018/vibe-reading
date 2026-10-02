---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "Overview"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "LSM-Tree", "C++", "KV 存储"]
description: "Google 开源嵌入式 KV 存储库 LevelDB 全景解读：LSM-Tree 七层结构、InternalKey 多版本编码、写入 group commit、Version/Manifest 元数据、leveled compaction、SSTable 块格式与 Bloom/LRU 读加速。"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** main-2026-03（1.23 之后 91 个提交的维护快照，2021-02 后无 release tag）· **解读基线** commit [`7ee830d02b`](https://github.com/google/leveldb/commit/7ee830d02b623e8ffe0b95d59a74db1e58da04c5)（2026-03-10）· **协议** BSD-3-Clause · **语言** C++17（C11）· **代码量** 核心非测试 ~17,500 行 + benchmarks ~2,400 行 · **仓库** [GitHub](https://github.com/google/leveldb)

---

## 总览

### 项目简介

LevelDB 是 Sanjay Ghemawat 与 Jeff Dean（Google Bigtable 两位核心作者）2011 年开源的**嵌入式持久化 key-value 存储库**——不是数据库服务，没有网络层和 SQL，就是一个编译链接进宿主进程的 C++ 库。它把 Bigtable tablet 的存储层抽出来单独成库（`doc/impl.md` 明说 "similar in spirit to the representation of a single Bigtable tablet"），用 **LSM-Tree**（Log-Structured-Merge-Tree）换取顺序写吞吐：所有写先追加 WAL、进内存跳表，再由后台线程批量归并成磁盘上的分层 SSTable。

三条核心价值主张：

1. **写路径全顺序**：一次写 = 一条 WAL 追加 + 一次内存跳表插入，磁盘上永远没有随机写；`BuildBatchGroup` 把并发小写折叠成一次批处理。
2. **读路径可组合**：memtable → imm → L0 → L1..L6 逐层下沉查找，SSTable 内部有 Bloom filter → index block → restart 二分三级加速，配 LRU 块缓存。
3. **极简可移植**：单进程单目录一组文件，所有 OS 交互收敛在一个 `Env` 虚接口后面（Posix / Windows / 内存三个实现），2 万行读得完。

**项目边界**：README 明确——非 SQL、无索引、无事务（只有 atomic batch）；**单进程**访问（`LOCK` 文件 flock 互斥，进程内多线程安全）；无 client-server，需要的话自己包。README 头部声明仓库已进入**仅维护关键 bugfix** 状态。它是 RocksDB（Facebook fork，见本站 [RocksDB 9.11.1 CodeWiki](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)）与大量后续 LSM 引擎（TiKV 的底层演进线、IndexedDB 的一个时期方案）的共同源头。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| KV 读写 | `db/db_impl.cc` 的 `DBImpl::Get/Write` | Put/Delete 是 Write 的语法糖（`WriteBatch` 单条） |
| 原子批量写 | `include/leveldb/write_batch.h` + `db/write_batch.cc` | 序列化字符串格式，`Iterate(Handler)` 重放 |
| 快照读 | `db/snapshot.h` 的 `SnapshotList` | 双向环形链表按 sequence 排序，compaction 保留最老快照 |
| 前后向迭代 | `db/db_iter.cc` 的 `DBIter` | 多版本过滤 + 方向切换优化 |
| 压缩 | `table/table_builder.cc` 的 `WriteBlock` | Snappy / Zstd（2021 年后加入），节省 <12.5% 自动放弃 |
| Bloom 过滤 | `util/bloom.cc` + `table/filter_block.cc` | 每 2KB 文件偏移一段 filter，10 bits/key ≈ 1% 误判 |
| 块缓存 | `util/cache.cc` 的 `ShardedLRUCache` | 16 分片 LRU，默认 8MB |
| 自定义比较器 | `include/leveldb/comparator.h` | Name() 写入 MANIFEST，Open 时校验防混用 |
| 环境替换 | `include/leveldb/env.h` + `helpers/memenv` | `NewMemEnv` 全内存 DB（测试用） |
| 损坏修复 | `db/repair.cc` 的 `Repairer` + `db/dumpfile.cc` | 扫全部表重建 MANIFEST；`leveldbutil dump` 查看 |
| C API | `db/c.cc` | `leveldb_t` 等不透明结构，供 C/FFI 绑定 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++17 / C11 | 核心 | 无 Boost、无 STL 重型组件，仅标准库 |
| CMake ≥ 3.9 | 构建 | `LEVELDB_BUILD_TESTS/BENCHMARKS/INSTALL` 三开关 |
| Snappy | 可选（bundled submodule） | 默认块压缩，~200-500MB/s |
| Zstd | 可选（bundled submodule） | 1.23 后新增，`zstd_compression_level` 默认 1 |
| GoogleTest | 可选（仅测试） | 30 个 `*_test.cc` |
| crc32c | 内置（`util/crc32c.cc`） | WAL/块校验，带 Mask 抗 CRC 嵌套 |
| pthread / std::thread | 核心 | `port/port_stdcxx.h` 封装 Mutex/CondVar |

### 版本历史

- **2011 初版**：Bigtable tablet 存储层独立成库，同年迭代到 1.2-1.9（NEWS 记录了 L0 硬限、memtable 管理等关键修复）
- **2012-2020 演进**：Bloom filter meta block（2012）、CMake 化、C++11 迁移、Windows 一等公民、mmap/fd 限流器
- **2021-02 `1.23`**：最后一个 release tag（CMake 工程版本号仍钉在 1.23.0）
- **1.23 → main（本基线 91 提交）**：Zstd 压缩（`1d6e8d6`）、Zstd level（`c61238d`）、Footer 校验加固、C++23 编译修复、`TEST_CompactMemTable` 死锁修复、若干 placement-new/指针算术修复——**纯维护，无新特性**
- **当前状态**：README 声明只接受关键 bug（数据丢失/内存损坏）与内部客户端必需的修复

---

## 快速上手

纯库无服务进程，最快路径是编译 + 跑测试 + 写 10 行调用代码：

```bash
git clone --recurse-submodules https://github.com/google/leveldb.git
cmake -S leveldb -B build -DLEVELDB_BUILD_BENCHMARKS=OFF -DLEVELDB_BUILD_TESTS=ON
cmake --build build -j
ctest --test-dir build --output-on-failure   # 30 组测试全绿 = 跑起来了
```

最小调用示例（库视角的"端到端验证"）：

```cpp title="quick_start.cpp"
#include <cassert>
#include "leveldb/db.h"

int main() {
  leveldb::DB* db;
  leveldb::Options opts;
  opts.create_if_missing = true;
  assert(leveldb::DB::Open(opts, "/tmp/testdb", &db).ok());

  db->Put(leveldb::WriteOptions(), "key1", "value1");          // 写
  std::string val;
  assert(db->Get(leveldb::ReadOptions(), "key1", &val).ok());  // 读
  assert(val == "value1");

  leveldb::WriteBatch batch;   // 原子批量
  batch.Delete("key1");
  batch.Put("key2", "value2");
  assert(db->Write(leveldb::WriteOptions(), &batch).ok());

  delete db;  // 关库即落盘收尾
}
```

跑完后 `ls /tmp/testdb` 会看到 `CURRENT`、`LOCK`、`LOG`、`MANIFEST-000002`、`000003.log`——这就是 LevelDB 的全部持久化形态。想看内部结构可用 `leveldbutil dump 000003.log` 打印 WAL 记录。

---

## 架构设计解析

### 系统架构

LevelDB 的架构思想一句话：**把"随机写"彻底变成"顺序写 + 后台归并"**——写入只碰 WAL（追加）和 memtable（内存跳表），磁盘上永远只产生新文件、删除旧文件，从不原地修改；读取用"由新到旧逐层探测"补偿，元数据用一个追加式的 MANIFEST 日志管理版本跃迁。四层职责如下：

![LevelDB 分层架构](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/architecture.svg)

**接口层**（`include/leveldb/`）是全部 15 个公共头文件定义的纯虚契约——`DB`、`Iterator`、`Comparator`、`Env`、`FilterPolicy`、`Cache`……引擎层只见接口不见用户；这一层同时是**线程契约**的声明处（注释逐类标明 thread-safe 与否）。**引擎层**（`db/`）是两根顶梁柱：`DBImpl`（`db_impl.cc` 1579 行）管写入编排、后台线程与生命周期；`VersionSet`（`db/version_set.cc` 1569 行）管"当前磁盘上有哪些文件"的版本视图——所有读操作都先从它拿到一份不可变的 `Version` 快照再解锁执行，这是读不加长锁的关键。**文件格式层**（`table/` + `db/log_*`）定义三种字节级格式：SSTable（排序的静态数据）、WAL（追加的动态数据）、MANIFEST（元数据变更日志）。**基础设施层**（`util/` + `helpers/memenv`）是与 OS 隔离的全部可替换件。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 接口层 | `include/leveldb/` | 隔离用户与引擎：契约稳定后引擎可整体重写；跨语言绑定的唯一依赖面 |
| 引擎层 | `db/` | 承载并发协议与版本视图：写串行化、读快照化、后台单线程调度 |
| 文件格式层 | `table/` · `db/log_writer.cc` · `db/log_reader.cc` | 字节级稳定性：格式即兼容性承诺，独立于引擎逻辑演进 |
| 基础设施层 | `util/` · `helpers/memenv/` · `port/` | 可移植与可替换：Env 一处收敛全部 OS 差异 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pimpl（Rep 前置声明） | `TableBuilder::Rep` in `table/table_builder.cc`、`Table::Rep` in `table/table.cc` | 公共头不暴露内部字段，ABI 稳定 |
| 策略接口 | `Comparator` / `FilterPolicy` / `Env`（`include/leveldb/*.h`） | 排序规则、过滤算法、文件系统三个最易变的维度全部开放替换 |
| 装饰/包装器 | `InternalKeyComparator` in `db/dbformat.h`、`InternalFilterPolicy` | 在用户策略外面包一层 internal key 语义，不改用户代码 |
| 引用计数 + 不可变快照 | `Version::Ref/Unref` in `db/version_set.cc`、`MemTable::Ref/Unref` | 读写无长锁的基础：旧版本为活读存活，无人引用即销毁 |
| 迭代器统一抽象 | `include/leveldb/iterator.h` + `IteratorWrapper` in `table/iterator_wrapper.h` | memtable/SSTable/合并/两级四种数据源用同一接口拼装 |
| 单例（placement new） | `SingletonEnv` in `util/env_posix.cc` | `Env::Default()` 进程唯一，析构即 abort（注释明说不支持） |
| Handler 回调 | `WriteBatch::Handler` in `db/write_batch.cc`（`MemTableInserter`） | 同一份序列化格式既写 memtable 又参与恢复，逻辑单点 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `InternalKey` | user_key + 8 字节 tag（(seq«8)\|type） | 无独立生命周期，嵌入各处 | 全库排序的最小单位（`db/dbformat.h`） |
| `MemTable` | 跳表 + Arena 的内存写缓冲 | 引用计数；满 4MB 转 `imm_` 待落盘 | 被 `DBImpl::mem_/imm_` 持有 |
| `Version` | 一份"每层有哪些文件"的不可变视图 | 双向环链挂 `dummy_versions_`，引用计数 | 由 `VersionSet::LogAndApply` 产生 |
| `VersionEdit` | 一次版本变更（增删文件/水位线） | 一次性，编码进 MANIFEST 记录 | `Builder::Apply` 消费 |
| `Compaction` | 一次合并的输入集合与约束 | 后台线程一轮回调内 | `PickCompaction` 产出 |
| `Table` | 一个已打开 SSTable 的索引视图 | TableCache LRU 持有 | footer → index → filter → block |
| `SnapshotImpl` | 一个 sequence 水位 | 环形链表节点，`ReleaseSnapshot` 删除 | compaction 取 `oldest()` |
| `Status` / `Slice` | 错误与字节视图值对象 | 值语义 | 全库返回值通货 |

对象关系（引擎视角）：

```
DBImpl ──┬── mem_ ── MemTable(SkipList+Arena)
          ├── imm_ ── MemTable（待落盘）
          ├── versions_ ── VersionSet ── dummy_versions_ ⇄ Version×N（环形链）
          │                          └─ Builder → 新 Version
          ├── table_cache_ ── ShardedLRUCache ── Table×N
          ├── log_ ── log::Writer（WAL）
          ├── snapshots_ ── SnapshotList（环形链）
          └── writers_ ── deque<Writer*>（写队列）
```

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `DB` | `include/leveldb/db.h` | `DBImpl` | `DB::Open` 工厂（唯一路径） |
| `Comparator` | `include/leveldb/comparator.h` | `BytewiseComparatorImpl`、用户子类 | `Options::comparator` 传入 |
| `Env` | `include/leveldb/env.h` | `PosixEnv`、`WindowsEnv`、`InMemoryEnv`(memenv) | `Options::env`，默认 `Env::Default()` |
| `FilterPolicy` | `include/leveldb/filter_policy.h` | `BloomFilterPolicy`、用户子类 | `Options::filter_policy`，`NewBloomFilterPolicy(10)` |
| `Cache` | `include/leveldb/cache.h` | `ShardedLRUCache` | `Options::block_cache`，`NewLRUCache(n)` |
| `Iterator` | `include/leveldb/iterator.h` | `MemTableIterator`/`Block::Iter`/`MergingIterator`/`TwoLevelIterator`/`DBIter`… | 各工厂函数组合返回 |
| `WriteBatch::Handler` | `include/leveldb/write_batch.h` | `MemTableInserter` | `WriteBatch::Iterate` 参数 |

### Import Cycles

graphify 对 2739 节点 5987 边做了 AST 级 include/调用建图，`GRAPH_REPORT.md` 检出 **Import Cycles: None**——15 年库的卫生度：`db/` → `table/` → `util/` 严格单向，`include/` 不反向依赖任何实现目录。唯一的"循环"是 `DBImpl` 与其嵌套 `Writer/CompactionState` 的友元关系，编译期即解。

---

## 代码目录

```
leveldb/
├── include/leveldb/   # 公共 API：15 个头文件（db/env/iterator/comparator/...）
├── db/                # 引擎核心（~8,100 行非测试）
│   ├── db_impl.cc     # DBImpl：写入/读取/后台编排（1,579 行 god file）
│   ├── version_set.cc # Version/VersionSet/Builder/Compaction（1,569 行 god file）
│   ├── dbformat.*     # InternalKey 编码与比较器、config 常量
│   ├── memtable.* / skiplist.h / snapshot.h
│   ├── log_writer.cc / log_reader.cc / log_format.h
│   ├── version_edit.* / filename.* / write_batch.*
│   ├── table_cache.* / builder.cc
│   ├── db_iter.cc     # 用户视图迭代器（多版本过滤）
│   ├── repair.cc / dumpfile.cc / leveldbutil.cc  # 维修与检查工具
│   └── c.cc           # C 绑定层
├── table/             # SSTable 格式（~2,100 行）
│   ├── table_builder.cc / table.cc    # 写入器 / 读取器
│   ├── block.cc / block_builder.cc    # 前缀压缩块
│   ├── filter_block.cc                # Bloom meta block
│   ├── format.cc                      # BlockHandle/Footer/ReadBlock
│   └── merger.cc / two_level_iterator.cc / iterator.cc
├── util/              # 基础设施（~4,400 行）
│   ├── env_posix.cc / env_windows.cc / env.cc
│   ├── cache.cc       # ShardedLRUCache（16 分片）
│   ├── bloom.cc / hash.cc / crc32c.cc / coding.cc
│   └── arena.cc / histogram.cc / logging.cc / status.cc
├── helpers/memenv/    # 全内存 Env（测试/缓存场景）
├── port/              # 平台垫片（Mutex/CondVar/Snappy 桥）
├── doc/               # 官方文档：index.md / impl.md / table_format.md / log_format.md
├── benchmarks/        # db_bench（vs SQLite3 / TreeDB 对比）
├── issues/            # 回归测试（issue178/200/320）
└── third_party/       # submodules：googletest / benchmark / snappy / zstd
```

两个 god file 值得点名：`db_impl.cc` 与 `version_set.cc` 合计 3,148 行，占引擎层的 40%——读通这两份就等于读通了 LevelDB 的运行时。

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/module-dependencies.svg)

依赖方向严格单向：`include/` 契约被所有实现依赖；`db/` 引擎调用 `table/`（读写 SSTable）和 `db/log_*`（WAL）；`util/`（Env/缓存/编码/校验）被一切依赖且不依赖任何人；memtable 与 Version 管理处在被读写两条路径共享的枢纽位置。九个模块的职责与独立性：

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 写入路径 | 串行化、成组、落 WAL 与 memtable | `DBImpl::Write` in `db/db_impl.cc` | 并发协议自成一体（队列+条件变量），与查询正交 | [01](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/01-write-path) |
| 版本管理与 Manifest | 层视图、版本跃迁、元数据持久化 | `VersionSet::LogAndApply` in `db/version_set.cc` | "磁盘上有什么"的唯一裁判，读写 compaction 三方共用 | [02](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/02-version-manifest) |
| MemTable | 内存有序写缓冲 | `MemTable::Add` in `db/memtable.cc` | 无锁并发读的跳表设计值得单独讲 | [03](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/03-memtable) |
| Compaction | 触发、选文件、归并、提交 | `BackgroundCompaction` in `db/db_impl.cc` | LSM 的灵魂：写放大/读放大/空间放大在此交易 | [04](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/04-compaction) |
| SSTable 文件格式 | 静态数据字节布局 | `TableBuilder::Add` in `table/table_builder.cc` | 字节格式独立演进，是兼容性承诺本身 | [05](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/05-sstable-format) |
| 读取路径 | 层间探测与迭代器合并 | `DBImpl::Get` / `NewIterator` in `db/db_impl.cc` | 与写入对称的另一半运行时 | [06](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/06-read-path) |
| 缓存与 Bloom | 读加速双件套 | `NewLRUCache` in `util/cache.cc`、`KeyMayMatch` in `util/bloom.cc` | 通用数据结构，可脱离 DB 复用 | [07](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/07-cache-bloom) |
| WAL 与恢复 | 崩溃一致性 | `log::Writer::AddRecord` in `db/log_writer.cc` | 独立的分块日志格式 + 恢复/修复流程 | [08](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/08-wal-recovery) |
| Env 环境抽象与生态 | OS 隔离层、MemEnv、工具链 | `Env::Default` in `util/env_posix.cc` | 可替换性的人格化：换 Env 换存储介质 | [09](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/09-env-ecosystem) |

模块间的动态调用顺序见下方「核心运行流程」三条链路；静态模块图与动态链路互为印证——写链路贯穿「写入路径 → MemTable → WAL」，读链路贯穿「读取路径 → Version → SSTable → 缓存」，compaction 链路把三者缝合。

## 运行时行为

### 启动流程

`DB::Open`（`db/db_impl.cc:1503`）是唯一入口，装配顺序：

```
DB::Open(options, dbname, &db)
 └─ new DBImpl(...)                          # 构造即装配（db_impl.cc:126）
     ├─ SanitizeOptions()                    # 修剪参数 + 默认 info_log/block_cache
     ├─ new TableCache(size = max_open_files - 10)
     └─ new VersionSet(...)
 └─ impl->Recover(&edit, &save_manifest)     # db_impl.cc:292
     ├─ env_->LockFile("LOCK")               # 单进程互斥（flock）
     ├─ 无 CURRENT 且 create_if_missing → NewDB()   # MANIFEST-000001 + CURRENT
     ├─ VersionSet::Recover()                # 读 CURRENT → 重放 MANIFEST → 装配 Version
     │   └─ ReuseManifest()?                 # reuse_logs 时续用旧 MANIFEST
     └─ 逐个 RecoverLogFile()                # 重放比 MANIFEST 新的 *.log
         ├─ log::Reader 重放 → MemTable（WriteBatch::InsertInto）
         ├─ 满 4MB → WriteLevel0Table() 立即落盘
         └─ reuse_logs && 最后一个 log → 续写该 log（Chrome 场景）
 └─ 新建 logfile + mem_ + log::Writer        # 未复用时
 └─ save_manifest → LogAndApply(edit)        # 首个 MANIFEST 落盘 + CURRENT 切换
 └─ RemoveObsoleteFiles() + MaybeScheduleCompaction()
```

对象装配的关键决策：**配置无文件、无环境变量**——一切来自 `Options` 结构体，经 `SanitizeOptions`（`db_impl.cc:84`）修剪（`ClipToRange` 把 `max_open_files` 钳到 74..50000、`write_buffer_size` 钳到 64KB..1GB 等）并注入默认值（`info_log` 落 `dbname/LOG`、`block_cache` 默认 `NewLRUCache(8<<20)`）。依赖注入全部是**构造函数手动 new**，没有 DI 容器；单例只有 `Env::Default()`（placement-new 的 `SingletonEnv`，`util/env_posix.cc`）。`TableCache` 容量是 `max_open_files - 10`——那 10 个是 `kNumNonTableCacheFiles`（`db/db_impl.cc:40`），给 CURRENT/LOCK/LOG 等非表文件留的 fd 余量。

### 核心运行流程

三条主链路覆盖 LevelDB 的全部运行模式：写链路（含 memtable 切换与背压）、读链路（含迭代器）、后台 compaction 链路（LSM 的自稳态机制）。

#### 写入：Put → Write → Group Commit → WAL + MemTable

业务流程：调用方提交 KV → 排入写队列 → 背压检查 → 队首线程成组 → 先追加 WAL 再插入 memtable → （满 4MB 时）切表触发后台落盘。

![写入数据流](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/write-path.svg)

写请求先被 `Put/Delete` 包成单条 `WriteBatch`（`db_impl.cc:1198`），在 `DBImpl::Write`（`db_impl.cc:1206`）里排进 `writers_` FIFO 队列——只有队首线程能前进，其余在各自 `CondVar` 上等待。队首先过 `MakeRoomForWrite` 背压闸（`db_impl.cc:1331`：L0 文件数 ≥8 每写延迟 1ms、≥12 直接停写等 compaction；mem 满 4MB 切 `mem_→imm_` 换新表），再由 `BuildBatchGroup`（`db_impl.cc:1281`）把队列里能合并的 writer 批次拼进 `tmp_batch_`（上限 1MB，sync 写不混入非 sync 组）。关键解锁区间：**写 WAL 与插 memtable 时大锁是放开的**——因为队首身份本身就是互斥器，并发写者既不会同时写日志也不会同时插跳表。数据形态经历 `WriteBatch`（12 字节头 + 记录序列）→ WAL 物理记录（32KB 分块）→ memtable 定长编码条目三层转换。sync 失败会走 `RecordBackgroundError` 把整库置为拒写态（日志状态不确定，宁停不错）。

#### 读取：Get → mem → imm → L0 → L1..L6 → SSTable 内三级

业务流程：构造 LookupKey → memtable/imm 顺序探测 → 版本视图逐层下沉 → TableCache 打开文件 → Bloom/index/block 三级 → 命中校验返回。

![读取数据流](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/read-path.svg)

`DBImpl::Get`（`db_impl.cc:1121`）先持锁取三份引用（`mem_`、`imm_`、`current Version` 各 `Ref()`），然后**解锁探测**——这是读高并发的根基：探测的全是不可变结构。`LookupKey`（`db/dbformat.h`）把 user_key + snapshot 序列打包成一次 seek 用的内部键（短键走 200 字节栈缓冲免分配）。L0 文件可能互相重叠，`Version::Get`（`version_set.cc:324`）经 `ForEachOverlapping` 按文件号**从新到旧**逐个问；L1..L6 文件不重叠，每层 `FindFile` 二分至多命中 1 个文件。每层找到即停——层序即新旧的覆盖语义由 compaction 维护。文件内部走 `TableCache::Get` → `Table::InternalGet`（`table/table.cc:223`）：index block 二分定位 data block → Bloom filter（`FilterBlockReader::KeyMayMatch`）拦掉不存在键 → block 内 restart 二分。读副作用：一次读探了多个文件时给第一个文件记一次 seek（`Version::UpdateStats`，`version_set.cc:402`），超额触发 seek compaction——读路径反过来喂养 LSM 的自稳态。

#### 后台：Compaction 三类触发 → 选文件 → 归并 → 提交新版本

业务流程：触发（size 超限 / seek 超额 / imm 待落盘）→ 单后台线程取出任务 → PickCompaction 选输入 → trivial move 或归并重写 → LogAndApply 提交 → 删除废弃文件。

![Compaction 流转](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/compaction-flow.svg)

一切从 `MaybeScheduleCompaction`（`db_impl.cc:668`）开始：单实例只有一个后台线程（`Env::Schedule` + `PosixEnv` 惰性启动的工作线程），`background_compaction_scheduled_` 标志防重入。`BackgroundCompaction`（`db_impl.cc:708`）三分支：`imm_` 优先落盘（`CompactMemTable`）；手动 `CompactRange` 逐层推进；自动路径 `VersionSet::PickCompaction`（`version_set.cc:1252`）选输入——size compaction（score = L0 文件数/4 或层字节/10^L MB，`Finalize` in `version_set.cc:1031` 计算）优先于 seek compaction，按 `compact_pointer_[level]` 在键空间上轮转防热点。真正的数据搬运在 `DoCompactionWork`（`db_impl.cc:898`）：`MakeInputIterator` 把 L0 全部输入文件 + L+1 文件做成 `MergingIterator` 归并流，逐条应用 drop 规则（旧版本被 `smallest_snapshot` 遮蔽即丢；墓碑确认无更深层引用即丢），输出经 `TableBuilder` 写新 SSTable，超 2MB 或祖先层重叠超限就切下一个输出文件。收尾 `InstallCompactionResults` → `LogAndApply`（`version_set.cc:777`）：VersionEdit 追加进 MANIFEST、新 Version 挂链生效，然后 `RemoveObsoleteFiles` 清理无引用旧文件——**换文件不改文件**，原子性由 MANIFEST 记录序保证。

### 状态流

LevelDB 有两个隐式状态机：memtable 的三级流转与 Version 的引用生命周期。

```
MemTable 状态机:                          Version 生命周期:
 [活跃 mem_] ──满4MB切表──▶ [imm_ 待落盘]      [Builder 构造]
     ▲                        │                    │ SaveTo + Finalize
     │                        │                    ▼
 新 log+新表 ◀──BackgroundCall──┘           [current_ 当前视图] ──Ref──▶ [老 Version 存活]
 (旧 memtable 引用归零销毁)                     (compaction/手动读产生新 current_)
                                                  │ 全部 Unref
                                                  ▼
                                              [析构: 文件引用-1, 无引用文件可删]
```

memtable 三态（`db_impl.cc:1331` 的 `MakeRoomForWrite`）：活跃 `mem_` → 满 `write_buffer_size`（默认 4MB）转为 `imm_` 并置原子标志 `has_imm_` → 后台 `CompactMemTable` 落盘成 L0 文件后置空。`imm_` 同时只能有一个——它是写路径与后台线程的交接棒，两个状态位（`imm_` 指针 + `has_imm_` 原子）配合 `background_work_finished_signal_` 构成完整的生产者-消费者闭环。

## 典型修改场景

#### 场景 1：新增一种压缩算法

- `include/leveldb/options.h`：`CompressionType` 枚举加值（如 `kZlibCompression = 0x3`）
- `port/port_stdcxx.h`：加 `Zlib_Compress/Zlib_Uncompress` 桥接
- `table/table_builder.cc` 的 `WriteBlock`：switch 加分支（沿用"省不到 12.5% 就放弃"的启发式）
- `table/format.cc` 的 `ReadBlock`：解压分支
- 对应测试：`table/table_test.cc`
- ⚠️ 磁盘格式扩展：trailer 的 type 字节已预留空间，老版本读到未知 type 会报 Corruption

#### 场景 2：调整 compaction 策略（如加 FIFO 模式）

- `db/version_set.cc` 的 `PickCompaction`：插入策略分支（size/seek 之外的第三入口）
- `db/dbformat.h` 的 `config::` 常量：触发阈值参数化
- `db/db_impl.cc` 的 `BackgroundCompaction`：是否跳过合并只删旧文件
- 对应测试：`db/db_test.cc` 的 `TEST_CompactRange` 系列可参照
- RocksDB 的 `fifo` compaction 就是这么长出来的——改动的正是这几个函数

#### 场景 3：换存储介质（如全内存 / 远程文件系统）

- 实现 `Env` 子类：13 个纯虚方法（`NewSequentialFile/NewRandomAccessFile/NewWritableFile/LockFile/Schedule/...`），参照 `helpers/memenv/memenv.cc`（412 行完整样例）
- `Options::env` 传入即可，引擎零改动
- 需要后台线程支持时实现 `Schedule`（参照 `PosixEnv::BackgroundThreadMain`）
- 对应测试：`util/env_test.cc` 是 Env 合规测试清单

## 测试体系

```
30 个 *_test.cc（全 gtest，无单独 test/ 目录——测试与实现同目录混放）
├── db/db_test.cc        69.8K   # 引擎行为全景（最大单文件）
├── db/*_test.cc                 # 各职责单测：log/filename/write_batch/dbformat/
│                                #   version_edit/corruption/recovery/fault_injection/
│                                #   autocompact/skiplist/memtable(经 db_test)
├── table/*_test.cc              # block/filter/format/merger/two_level/table
├── util/*_test.cc               # arena/bloom/cache/coding/crc32c/env/hash/logging/status
├── issues/issue{178,200,320}_test.cc   # 线上回归最小用例
└── db/c_test.c                  # C API 烟雾测试（非 gtest）
```

| 代码层 | 测试类型 | 找谁 |
|--------|----------|------|
| 并发协议（写队列/后台线程） | `db_test.cc` 的 `Concurrent*` 系列 + `fault_injection_test.cc` | 故障注入测试最能暴露协议漏洞 |
| 版本/compaction | `db_test.cc` + `version_set_test.cc` + `autocompact_test.cc` | `TEST_CompactRange` 入口 |
| 文件格式 | `table_test.cc`（24.1K）+ `format` 相关 | 读旧格式的兼容性用例 |
| Env 合规 | `env_test.cc` + `env_posix_test.cc` | 新 Env 实现先过这套 |
| 崩溃恢复 | `recovery_test.cc` + `corruption_test.cc` + `log_test.cc` | 人为截断/翻转字节 |

`fault_injection_test.cc`（15.4K）值得一提：`FaultInjectionTestEnv` 包装真实 Env 注入读写错误，专测"哪一步失败后重启仍一致"。读某个类之前先读它的测试是本库的高效路径——测试即文档。

## 阅读源码推荐路线

- 第一遍：主流程跑通
  `include/leveldb/db.h`（契约）→ `db/db_impl.cc` 的 `DB::Open`（1503 行处）→ `DBImpl::Write` → `DBImpl::Get` → 顺手跑 `benchmarks/db_bench.cc --benchmarks=fillseq,readrandom` 看真实运行
- 第二遍：核心数据结构
  `db/dbformat.h`（InternalKey/ValueType/config 常量）→ `db/skiplist.h`（读头 30 行并发注释）→ `db/memtable.cc` 的 `Add/Get` → `table/format.h`（BlockHandle/Footer）→ `util/arena.h`
- 第三遍：版本与 compaction（LSM 灵魂）
  `db/version_set.h`（先读文件头 20 行注释）→ `version_set.cc` 的 `LogAndApply`/`Finalize`/`PickCompaction` → `db/db_impl.cc` 的 `BackgroundCompaction`/`DoCompactionWork` → `doc/impl.md`（作者自己写的实现说明，与本篇互证）
- 第四遍：格式细节与生态
  `table/block_builder.cc`（前缀压缩+restart）→ `table/table_builder.cc` 的 `Finish` → `util/bloom.cc` → `db/log_format.h` + `doc/log_format.md` → `db/repair.cc` → `helpers/memenv/memenv.cc`（Env 实现样例）

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| InternalKey | user_key + 8B tag `(seq<<8)\|type` 的引擎内统一键格式（`db/dbformat.h`） |
| sequence number | 全局单调递增版本号，56 bit 上限（`kMaxSequenceNumber`），MVCC 之源 |
| 墓碑 (tombstone) | `kTypeDeletion` 标记，读作 NotFound、compaction 时可回收 |
| L0..L6 | 七层 SST 阶梯；L0 文件可重叠（同源于一个 memtable 批次），L1+ 区间互斥 |
| score | compaction 紧迫度：L0 = 文件数/4，L≥1 = 层字节/10^L MB；≥1 触发 |
| allowed_seeks | 每文件 seek 配额 = `file_size/16384`（下限 100），读超额触发 seek compaction |
| trivial move | 单输入且下层无重叠时只改文件归属层、不重写数据的快速路径 |
| boundary file | 与合并边界共享 user_key 的相邻文件，必须一并入列防读错层（`AddBoundaryInputs`） |
| MANIFEST | 元数据重放日志：CURRENT 指针 + VersionEdit 记录流 |
| trailer | 块尾 5 字节：1B 压缩类型 + 4B Mask 过的 crc32c |

### 参考资料

- 官方文档（bundled）：`doc/index.md`（用法）、`doc/impl.md`（实现蓝图）、`doc/table_format.md`、`doc/log_format.md`
- Bigtable 论文 §5.3（LevelDB 的精神源头）：*Chang et al., OSDI 2006*
- 本站姊妹篇：[RocksDB 9.11.1 CodeWiki](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)（看这个库 15 年后长成什么样）、[TiKV 9.0.0-beta.2 CodeWiki](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)（LSM 之上的分布式化）
- O'Neil et al., *The Log-Structured Merge-Tree*, Acta Informatica 1996（LSM 原始论文）

### 工具推荐

| 工具 | 用途 |
| --- | --- |
| `leveldbutil dump <file>` | 打印 .log/.ldb/.MANIFEST 的内容（`db/dumpfile.cc`） |
| `benchmarks/db_bench` | 内置基准：`fillseq/fillrandom/readrandom/seekrandom/compact` 等十余场景 |
| `ldb`（rocksdb 工具，兼容读） | 交互式查 leveldb 目录（需 format 兼容性确认） |
| `helpers/memenv` | 全内存 Env——给 DB 跑单测时当 RAM 盘 |
