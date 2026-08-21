---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "Overview"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "C++", "Python", "DataFrame", "时序数据库"]
description: "Man Group 的高性能无服务器 DataFrame 数据库 ArcticDB 源码架构解读概览"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 6.23.0 · **协议** Business Source License 1.1 · **语言** C++ / Python ≥ 3.9 · **代码量** ~154,000 行（C++ ~132k + Python ~22.5k）· **仓库** [GitHub](https://github.com/man-group/ArcticDB)

---

## 总览

### 项目简介

**ArcticDB** 是 Man Group（Man Alpha Technology）开源的高性能、**无服务器（serverless）DataFrame 数据库**，面向 Python 数据科学生态。它用一个 Python 友好的 API 把 Pandas DataFrame、NumPy 数组持久化到 S3、Azure Blob、LMDB、MongoDB 等后端，背后是一套用 C++ 编写的列式数据处理与压缩引擎。2023 年 3 月发布，是老牌 Arctic 项目的继任者。

它解决的核心问题是：**在金融时序数据这种"行数和列数都极大"的场景下，如何在不引入独立数据库服务器的前提下，高速读写并版本化海量 DataFrame**。ArcticDB 的设计哲学是"无服务器 + 持久化数据结构"——没有独立的服务进程，客户端直接从对象存储拉取压缩数据，因此不存在单点故障，也无所谓"过载"；一旦某个 symbol 的某个版本写入完成，它就是不可变的，后续更新永远无法破坏已落盘的数据。

核心价值与使用场景：金融行情与因子数据（一个 symbol 可存 20 年、40 万只证券的历史）、实验数据版本管理（time travel、命名快照）、流式数据追加（staged writes）。**项目边界**：ArcticDB 不是一个带 SQL 查询语言的 OLAP 引擎，也不做跨 symbol 的分布式 Join——它以"单 symbol 独立维护、无共享数据"为粒度横向扩展，查询能力聚焦于单 symbol 内的过滤、投影、聚合下推（pushdown）。生产环境使用或作为数据库服务对外提供需向 ArcticDB Limited 购买商业许可（BSL 1.1）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| Pandas 进 / Pandas 出 | `python/arcticdb/version_store/_normalization.py` | DataFrame ↔ 内部列式格式互转，支持 pyarrow/polars |
| 时序索引与时间穿越 | `cpp/arcticdb/version/local_versioned_engine.cpp` | 不可变版本链，`as_of` 按版本号/时间戳/快照读历史 |
| 无 Schema 约束 | `cpp/arcticdb/pipeline/pipeline_context.hpp` | `dynamic_schema` 允许版本间列变化，append/update 自由 |
| 流式稀疏存储 | `cpp/arcticdb/stream/aggregator.hpp` | staged writes + sparse column 支持 |
| 查询下推 | `cpp/arcticdb/processing/clause.hpp` | filter/project/aggregate 在存储层执行，避免全量物化 |
| 列统计裁剪 | `cpp/arcticdb/pipeline/column_stats_filter.hpp` | 段级 min/max 预先裁剪不匹配的行分片 |
| C++ 并发引擎 | `cpp/arcticdb/async/task_scheduler.hpp` | CPU + I/O 双线程池，Folly Future 驱动并行拉取与解压 |
| 多后端存储 | `cpp/arcticdb/storage/storage_factory.cpp` | S3 / Azure / LMDB / Mongo / Memory / GCP / NFS / MappedFile |
| 分布式锁（弱） | `cpp/arcticdb/util/storage_lock.hpp` | 仅用于 symbol list 压缩，写不持锁（last-writer-wins） |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| pybind11 | 核心 | Python ↔ C++ 绑定（`cpp/third_party/pybind11`） |
| Folly | 核心 | Future/Promise 驱动异步 I/O 与并行编解码 |
| Protobuf 3.21 | 核心 | 段头、描述符、存储配置的序列化格式 |
| Apache Arrow 21 / Sparrow | 可选 | 列式内存互操作、pyarrow/polars 输出 |
| LZ4 / ZSTD / zlib | 核心 | 段级压缩（LZ4 默认，ZSTD 高压缩比） |
| LMDB / lmdbxx | 核心 | 本地嵌入式存储后端 |
| AWS SDK / Azure SDK / Mongo C++ driver | 核心 | 对应存储后端客户端 |
| msgpack-c | 核心 | 任意 Python 对象的兜底序列化（MsgPackNormalizer） |
| entt | 核心 | 查询处理的 entity-component 系统（`ComponentManager`） |
| pandas / numpy | 核心（Python 运行时） | 用户侧数据载体与零拷贝桥接 |
| Google Test / pytest / hypothesis | 测试 | C++ 单测 / Python 单测+集成 / 属性测试 |

### 版本历史

ArcticDB 采用高频发布（每周一个 minor），BSL 1.1 协议在版本发布约两年后自动转为 Apache 2.0。1.0（2023.3 发布）→ 2.x/3.x/4.x 逐步完善查询下推与存储后端 → 5.x/6.x 引入列统计裁剪、pipeline 内存约束、Polars/Arrow 输出与可靠锁。本文解读的 **6.23.0**（2026-08-17）处于 6.x 主线，特性已包含 column stats read path、`read_modify_write_internal` 管道、pipeline 内存上限等近期演进。

## 快速上手

```bash title="安装"
pip install arcticdb
# 或 conda-forge
conda install -c conda-forge arcticdb
```

```python title="最小端到端示例"
import arcticdb as adb
import pandas as pd, numpy as np

ac = adb.Arctic("lmdb://./my_db")          # 本地 LMDB
ac.create_library("travel_data")
lib = ac["travel_data"]

df = pd.DataFrame(np.random.randint(0, 100, size=(100_000, 4)),
                  columns=list("ABCD"),
                  index=pd.date_range("2000", periods=100_000, freq="h"))
lib.write("my_data", df)                    # 写入 → 返回 VersionedItem
out = lib.read("my_data")                   # 读回 → out.data 是原 DataFrame
print(out.version, out.data.shape)
```

预期输出：一个版本号（如 `0`）与 `(100000, 4)` 的形状，证明端到端读写闭环。无需启动任何服务进程——`lmdb://` 即在本地目录建库。

## 架构设计解析

### 系统架构

ArcticDB 的架构思想是**"瘦客户端 + 持久化数据结构 + 下推执行"**：不在数据路径上放任何服务器，所有计算（切片、压缩、查询）都在客户端 C++ 引擎里完成，存储只负责键值读写。这样做的收益是——数据路径上没有单点、没有服务过载、读永远可用；代价是查询能力受限于"单 symbol 内下推"，不做分布式 Join。这种取舍对金融时序场景（单 symbol 海量行、按时间范围与列裁剪读）正合适。

![ArcticDB 分层架构](/vibe-reading/images/articles/arcticdb-internals/architecture.svg)

系统自上而下分为六层，外加一个跨层的异步调度侧柱：**Python API 层**（`Arctic`/`Library`/`NativeVersionStore` + 归一化）负责用户接口与 DataFrame 互转；**版本引擎层**（`version_store_api`/`local_versioned_engine` + `VersionMap` 缓存）管理版本链、快照、symbol list；**读写管道层**（`write_frame`/`read_frame`/`slicing`/`PipelineContext`）负责切片、装配与并行编解码；**查询处理层**（`Clause`/`ExpressionNode`/`Aggregation`）执行下推查询；**列式与编解码层**（`SegmentInMemory`/`Column`/`Codec`）是内存列式格式与压缩落盘；**存储后端层**是 8 种后端的统一抽象。**异步调度**（`TaskScheduler` 的 CPU/I/O 双池）横跨版本引擎到存储，把压缩/解压/存储读写并行化。依赖方向自上而下，下层不知道上层存在。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| Python API 层 | `python/arcticdb/` | 隔离用户数据格式（pandas/arrow/polars），保护 C++ 引擎不感知 Python 对象 |
| 版本引擎层 | `cpp/arcticdb/version/` | 编排版本语义（写/读/删/快照），维护版本链与缓存，是业务逻辑核心 |
| 读写管道层 | `cpp/arcticdb/pipeline/` | 把"一个 DataFrame"拆成"一批段"并并行编码/解码，是数据流骨架 |
| 查询处理层 | `cpp/arcticdb/processing/` | 把查询算子下推到段级执行，避免全量物化 |
| 列式与编解码 | `cpp/arcticdb/column_store/` `cpp/arcticdb/codec/` | 定义内存列式格式与落盘压缩格式，是性能基座 |
| 存储后端层 | `cpp/arcticdb/storage/` | 适配异构存储，对上提供键值语义，可替换 |
| 异步调度（侧柱） | `cpp/arcticdb/async/` | 把计算与 I/O 并行化，隐藏存储延迟 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 类型擦除多态（`folly::Poly`） | `IClause` in `processing/clause.hpp` | Clause 种类多且需值语义存储在 vector，比虚函数更灵活 |
| 策略模式 | `SlicingPolicy` variant in `pipeline/slicing.hpp` | 切片策略（固定/哈希/不切）可按 WriteOptions 切换 |
| pimpl | `SegmentInMemory` → `SegmentInMemoryImpl` in `column_store/memory_segment.hpp` | 稳定 ABI + 降低编译依赖 |
| 抽象工厂 | `create_storage()` in `storage/storage_factory.cpp` | 按 protobuf 配置分发到 8 个后端实现 |
| 模板方法 | `Storage::write()` → `do_write()` in `storage/storage.hpp` | 公共前置/校验在基类，后端只实现 `do_*` |
| 内容寻址键 | `AtomKeyImpl` in `entity/atom_key.hpp` | 不可变键 + content_hash 天然去重（`DeDupMap`） |
| Future/Promise 流水线 | `write_frame`/`fetch_data` 返回 `folly::Future` in `pipeline/` | 段级并行编码/拉取，隐藏 I/O 延迟 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `SegmentInMemory` | 内存列式段，读写路径的核心数据载体 | 一次管道操作 | 含 `Column` 列与 `StringPool` |
| `AtomKey` | 不可变内容寻址键（symbol+version+hash+type+index range） | 永久（落盘后不变） | 指向一个 `Segment` |
| `RefKey` | 可变引用键（仅 id 定位） | 可被覆写 | `VERSION_REF` 指向最新 `AtomKey` |
| `PipelineContext` | 贯穿一次读/写操作的全局状态 | 一次操作 | 持有 `SliceAndKey` 列表与描述符 |
| `VersionedItem` | 一次写操作的结果句柄（symbol+version+index key） | 调用方持有 | 指向版本链节点 |
| `Clause` | 一个下推查询算子（filter/project/aggregate…） | 一次查询 | 链式组合成管道 |
| `ProcessingUnit` | 段级处理单元（段+行/列范围+键+表达式缓存） | 一次 clause.process | 由 `ComponentManager` 管理实体 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Store` | `storage/store.hpp` | `AsyncStore` | `create_store` 工厂构造 |
| `Storage` | `storage/storage.hpp` | `S3Storage`/`AzureStorage`/`LmdbStorage`/`MongoStorage`/`MemoryStorage`/… | `create_storage()` 按 protobuf 分发 |
| `IClause`（`folly::Poly`） | `processing/clause.hpp` | `FilterClause`/`ProjectClause`/`AggregationClause`/`SortClause`/`ResampleClause`/… | Python `QueryBuilder` 序列化构造 |
| `Aggregator`（模板） | `stream/aggregator.hpp` | 按 Index/Schema/SegmentingPolicy 实例化 | 写管道内构造 |
| `Normalizer`（Python） | `version_store/_normalization.py` | `DataFrameNormalizer`/`SeriesNormalizer`/`ArrowTableNormalizer`/`MsgPackNormalizer` | 按 Python 输入类型分发 |

## 代码目录

```text
ArcticDB/
├── cpp/arcticdb/              # C++ 引擎（核心数据处理，~132k 行）
│   ├── version/               # 版本引擎、版本链、symbol list、快照（~25k 行）
│   ├── processing/            # 查询处理：clause、表达式、聚合（~24k 行）
│   ├── storage/               # 存储后端抽象与 8 种实现（~15k 行）
│   ├── pipeline/              # 读写管道、切片、列统计（~14k 行）
│   ├── column_store/          # 内存列式：SegmentInMemory、Column、StringPool（~13k 行）
│   ├── codec/                 # 压缩与段格式：LZ4/ZSTD、V1/V2 编码（~6.4k 行）
│   ├── stream/                # 流式聚合、索引、incomplete（~5.3k 行）
│   ├── entity/                # 核心类型：键、DataType、描述符（~7.5k 行）
│   ├── async/                 # TaskScheduler 双线程池（~2.9k 行）
│   ├── python/                # pybind11 绑定入口（~3.2k 行）
│   ├── arrow/                 # Apache Arrow 互操作（~3.1k 行）
│   └── util/ log/ toolbox/    # 工具、日志、管理工具
├── python/arcticdb/           # Python 包与测试（~22.5k 行）
│   ├── arctic.py              # Arctic 顶层入口
│   ├── version_store/         # Library(V2)、_store(V1)、_normalization、processing(QueryBuilder)
│   ├── adapters/              # URI 解析与存储适配器（S3/Azure/LMDB/Mongo/Memory/GCP）
│   └── util/ toolbox/         # Python 工具与管理
├── cpp/proto/                 # protobuf 定义（descriptors/encoding/storage/s3_storage…）
├── docs/                      # MkDocs 用户文档 + docs/claude/ 技术架构文档
├── build_tooling/             # 构建与格式化脚本
└── setup.py / pyproject.toml  # Python 构建编排（CMake + vcpkg）
```

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/arcticdb-internals/module-dependencies.svg)

依赖方向自上而下：Python API 经 Python 绑定进入 C++ 版本引擎，引擎调度管道与处理层，它们都建立在列式/编解码之上，最终落到存储后端；`entity/` 是所有人依赖的类型地基，`async/` 与 `stream/` 作为基础设施横跨多层。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Python API 层 | 用户接口、DataFrame 归一化、URI 适配 | `arctic.py` / `library.py` | 隔离 Python 对象格式，是唯一面向用户的层 | [Python API 层](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/01-python-api) |
| 版本引擎 | 版本链、缓存、快照、symbol list、tombstone | `local_versioned_engine.cpp` | 承载全部版本语义与并发正确性，最大模块 | [版本引擎](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/02-version-engine) |
| 读写管道 | 切片、并行编解码、段装配、列统计裁剪 | `write_frame.cpp` / `read_frame.cpp` | 数据流骨架，把 DataFrame 拆成段 | [读写管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline) |
| 编解码 | 段格式、LZ4/ZSTD 压缩、V1/V2 编码 | `codec.cpp` / `segment_header.hpp` | 落盘格式独立于内存格式，是压缩性能基座 | [编解码](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/04-codec) |
| 查询处理 | Clause 管道、表达式树、聚合、列统计求值 | `clause.hpp` / `expression_node.hpp` | 下推查询算子独立成层，避免全量物化 | [查询处理](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/05-processing) |
| 列式存储 | 内存列式段、Column、StringPool、ChunkedBuffer | `memory_segment.hpp` | 内存数据格式是所有层的共享词汇 | [列式存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/06-column-store) |
| 存储后端 | Store/Storage 抽象、8 种后端、storage_factory | `storage_factory.cpp` | 异构存储可替换，对上提供统一键值语义 | [存储后端](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage) |
| 核心类型 | AtomKey/RefKey、KeyType、DataType、TypeDescriptor | `key.hpp` / `types.hpp` | 类型系统是全库地基，被所有模块 import | [核心类型](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/08-entity) |
| 流式与异步 | Aggregator、索引、incomplete、TaskScheduler 双池 | `aggregator.hpp` / `task_scheduler.hpp` | 流式追加与并行 I/O 是性能基础设施 | [流式与异步](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/09-stream-async) |
| Python 绑定 | pybind11 模块、类型转换、GIL、异常映射 | `python_module.cpp` | C++↔Python 边界，零拷贝与 GIL 管理独立成层 | [Python 绑定](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/10-python-bindings) |

## 运行时行为

### 启动流程

ArcticDB 是库而非服务，"启动"即 `Arctic(uri)` 构造与首次 `create_library`/`get_library` 时的对象装配：

```text
Arctic.__init__(uri)                        arctic.py
  ├─ 遍历 _LIBRARY_ADAPTERS 匹配 supports_uri(uri)   # S3/GCP/LMDB/Azure/Mongo/Memory 6 个适配器
  ├─ ArcticLibraryAdapter(uri)               # 解析 URI → ParsedQuery + protobuf Storage 配置
  └─ LibraryManager(config_library)          # C++ 对象，管理库元数据
create_library(name, LibraryOptions)
  ├─ adapter.config_library → 写 LIBRARY_CONFIG 键
  └─ Library(NativeVersionStore(...))        # 装配：NativeVersionStore 持有 C++ PythonVersionStore
lib.write(symbol, df)
  └─ _normalization.normalize(df) → PandData # Python 侧归一化
     └─ arcticdb_ext (pybind11) → PythonVersionStore::write_versioned_dataframe  # 进 C++
        └─ LocalVersionedEngine::write_versioned_dataframe_internal
           └─ TaskScheduler::init()（首次惰性初始化单例，读 cgroup 定 CPU 数）
```

配置优先级：构造函数 `encoding_version`/`output_format` 参数 > `LibraryOptions`（`dynamic_schema`/`dedup`/`segment_row_size`）> 运行时 `arcticdb_ext.set_config_int/string`（如 `VersionMap.ReloadInterval`）> 编译默认。`TaskScheduler` 是 `std::once_flag` 守护的单例，首次提交任务时 `init()`，并在 `pthread_atfork` 注册了子进程 `reattach_instance()`（fork 后线程池失效需重建）。

### 核心运行流程

下面三条链路覆盖了 ArcticDB 最核心的运行模式：写入建版本、读取下推查询、追加与更新。它们共享同一个管道与版本引擎，但数据流方向与触发的键写入顺序不同。

![写入与读取数据流](/vibe-reading/images/articles/arcticdb-internals/data-flow.svg)

#### 写入：DataFrame → 版本链

业务流程：用户 `lib.write("sym", df)` → 归一化为 `PandasData`（numpy 数组引用 + `NormalizationMetadata` protobuf）→ 进 C++ `write_versioned_dataframe_internal` → `slice_and_write` 按 `segment_row_size`（默认 10 万行）切行/列分片 → 每个 `WriteToSegmentTask` 在 CPU 池并行编码（codec 压缩）→ `AsyncStore` 在 I/O 池写 `TABLE_DATA` 键 → 全部成功后写 `TABLE_INDEX` → 写 `VERSION`（含指向前一版本的链表指针）→ 最后更新 `VERSION_REF`。关键设计决策：**严格按 `key_types_write_precedence()` 顺序写键**（DATA→INDEX→VERSION→REF），先写不可变 ATOM 键、最后写可变 REF 键，实现无锁的 last-writer-wins；若中途配额超限，`rollback_on_quota_exceeded` 会回收已写键避免孤儿数据。数据结构变化：`DataFrame` → `InputFrame` → `vector<SegmentInMemory>` → 压缩 `Segment` → 存储键。

#### 读取：版本解析 → 下推查询 → 重建

业务流程：`lib.read("sym", as_of, columns, query_builder)` → `VersionMap::check_reload` 判缓存是否新鲜（默认 2 秒 `ReloadInterval`），否则从存储 reload 版本链 → 解析 `VersionQuery`（monostate=最新/SpecificVersion/Timestamp/Snapshot）→ `fetch_index_and_column_stats` 并行拉 `TABLE_INDEX` 与可选 `COLUMN_STATS` → 按行范围/列选择/列统计 min/max 裁剪不匹配的段 → I/O 池并行拉取 `TABLE_DATA` 段、CPU 池并行解压 → 若有 `query_builder`，Clause 管道在段级执行 filter/project/aggregate → `read_frame` 装配 `SegmentInMemory` → 归一化还原成 `DataFrame`。关键决策：**列统计用三值逻辑**（`ALL_MATCH`/`NONE_MATCH`/`UNKNOWN`）做段裁剪，NaN/NaT 遵循 Pandas 语义；读特定版本时缓存未命中会自动 bypass retry，保证最终一致。

#### 追加与更新：读改写复合链路

`append` 与 `update` 走 `read_modify_write_internal`（`local_versioned_engine.cpp`）：先读现有版本的 index，`append` 把新数据段链到尾部、`update` 用 `flatten_and_fix_rows` 把更新区间涉及的 5 类段（前不交/前交/全含/后交/后不交）重排成新段集合，再走写入路径产出新版本。`update` 的 `AffectedSegmentPart { START, END }` 标记被部分影响的段需重写。这条链路体现了"不可变版本"的代价——任何修改都是"读旧+写新版本"，旧版本由 tombstone 标记、由 `prune_previous_versions` 物理回收。

### 状态流

版本是 ArcticDB 最核心的生命周期对象。一个 symbol 的某个版本经历：**Created**（写入完成，VERSION 键落盘）→ **Visible**（VERSION_REF 指向，list_versions 可见）→ **Tombstoned**（`delete_version` 在 VERSION 段内写 TOMBSTONE，list_versions 不可见、显式读报错，数据仍在）→ **Pruned**（`prune_previous_versions` 物理删除段键、回收空间）。`TOMBSTONE_ALL` 是批量标记"某版本之前全部删除"的优化，避免在 tombstones map 里存上千条目。快照（`SNAPSHOT_REF`）是旁路状态——它独立于版本链引用特定版本的 index 键，被引用的版本不会被 prune 回收。相关代码：tombstone 记录在 `version/version_map_entry.hpp` 的 `tombstones_`/`tombstone_all_`，删除方法在 `local_versioned_engine.cpp` 的 `delete_version`/`delete_all_versions`，prune 在 `write_version_and_prune_previous`。

## 典型修改场景

#### 场景 1：新增一种查询算子（如 window 聚合）

需修改：`cpp/arcticdb/processing/clause.hpp` 与 `clause.cpp`（新增 `WindowClause` struct 实现 `IClause` 的 `structure_for_processing`/`process`/`modify_schema`）；`cpp/arcticdb/processing/operation_types.hpp`（如需新聚合算子枚举）；`python/arcticdb/version_store/processing.py`（`QueryBuilder` 暴露 `.window()` 方法并序列化为 C++ clause）。对应测试：`python/tests/unit/arcticdb/version_store/test_processing.py`。

#### 场景 2：新增一种存储后端（如 Google Cloud Storage native）

需修改：`cpp/arcticdb/storage/<backend>/`（新建后端类继承 `Storage`，实现 `do_write`/`do_read`/`do_remove`/`do_key_exists`/`do_iterate_type_until_match`）；`cpp/proto/arcticc/pb2/<backend>_storage.proto`（protobuf 配置）；`cpp/arcticdb/storage/storage_factory.cpp`（`create_storage` 加 `else if` 分支）；`python/arcticdb/adapters/<backend>_library_adapter.py`（URI 解析）+ `arctic.py` 的 `_LIBRARY_ADAPTERS` 列表。对应测试：`python/tests/integration/arcticdb/test_storage_<backend>.py`。

#### 场景 3：新增一种压缩编码（如 Delta 编码）

需修改：`cpp/arcticdb/storage/memory_layout.hpp`（`Codec` 枚举加值）；`cpp/arcticdb/codec/encode_v1.cpp` 或新建 `encode_v<version>.cpp`（实现 encode/decode）；`cpp/arcticdb/codec/segment_header.hpp`（如需新 `EncodingVersion`）；`cpp/arcticdb/codec/codec.cpp` 的 `encode()`/`decode()` 分发。对应测试：`cpp/arcticdb/codec/test/` 的 gtest。

## 测试体系

```text
python/tests/
├── unit/            # Python 单元测试（逻辑、归一化、QueryBuilder）
├── integration/     # 集成测试（端到端读写、各后端）
├── hypothesis/      # 属性测试（随机生成 DataFrame 验证不变量）
├── stress/          # 压力测试（多进程缓存、版本图压缩）
└── nonreg/          # 非回归测试
cpp/arcticdb/*/test/ # C++ Google Test 单元测试（各模块就地）
python/benchmarks/   # ASV 性能基准
```

| 代码层 | 测试类型 | 框架 |
| --- | --- | --- |
| 归一化 / QueryBuilder / Python API | `python/tests/unit/` | pytest |
| 端到端读写 / 各后端 | `python/tests/integration/` | pytest + storage fixtures |
| 数据不变量 | `python/tests/hypothesis/` | hypothesis |
| 多进程缓存 / 并发 | `python/tests/stress/` | pytest（`test_stale_version_cache.py`） |
| C++ 各模块 | `cpp/arcticdb/*/test/` | Google Test |

修改某层代码时，参照上表优先阅读对应测试——ArcticDB 强制 TDD（每个改动伴随一个先失败的测试）。想理解版本链缓存行为，`test_stale_version_cache.py` 是最好的可执行文档。

## 阅读源码推荐路线

- **第一遍：理解主流程（写 → 读）**
  `python/arcticdb/arctic.py` 的 `Arctic.__init__` → `version_store/library.py` 的 `Library.write`/`read` → `version_store/_store.py` 的 `NativeVersionStore` → `cpp/arcticdb/version/version_store_api.cpp` 的 `PythonVersionStore::write_versioned_dataframe` → `local_versioned_engine.cpp` 的 `write_versioned_dataframe_internal`
- **第二遍：理解数据流（切片与段）**
  `cpp/arcticdb/pipeline/write_frame.hpp` 的 `write_frame`/`slice_and_write`/`WriteToSegmentTask` → `pipeline/read_frame.hpp` 的 `fetch_data`/`decode_into_frame_static` → `pipeline/pipeline_context.hpp` 的 `PipelineContext` → `pipeline/slicing.hpp` 的 `SlicingPolicy`
- **第三遍：理解核心数据结构（键与段）**
  `cpp/arcticdb/entity/key.hpp` 的 `KeyType` 枚举 + `key_types_write_precedence` → `entity/atom_key.hpp` 的 `AtomKeyImpl`/`AtomKeyBuilder` → `column_store/memory_segment.hpp` 的 `SegmentInMemory` → `column_store/column.hpp` 的 `Column`/`ChunkedBuffer`
- **第四遍：理解版本语义与并发**
  `cpp/arcticdb/version/version_map.hpp` 的 `check_reload`/`has_cached_entry` → `version/version_map_entry.hpp` 的 tombstone 字段 → `version/symbol_list.cpp` → `async/task_scheduler.hpp` 的双池 + cgroup 感知
- **第五遍：选择重点模块深入阅读**（上方模块地图链接，如查询处理的 `clause.hpp`/`expression_node.hpp`、存储的 `storage.hpp`/`storage_factory.cpp`）

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| symbol | 一个逻辑数据集的标识（如 "my_data"），版本链的根 |
| segment / SegmentInMemory | 一个行列分片，存储与内存的基本单元 |
| AtomKey / RefKey | 不可变内容寻址键 / 可变引用键（见核心类型模块） |
| version chain | 一个 symbol 的 VERSION 键链表，支持 time travel |
| tombstone | 惰性删除标记，存在于 VERSION 段内，不独立存盘 |
| pushdown | 把 filter/project/aggregate 下推到存储层段级执行 |
| column stats | 段级 min/max 统计，用于读时裁剪不匹配的行分片 |
| staged write | 流式追加未提交段（APPEND_REF），finalize 后合并成版本 |

### 参考资料

- [ArcticDB 官方文档](https://docs.arcticdb.io)
- [ArcticDB GitHub](https://github.com/man-group/ArcticDB)
- 仓库内 `docs/claude/ARCHITECTURE.md` 及 `docs/claude/cpp/`、`docs/claude/python/` 模块文档（维护者撰写，本文解读的重要参考）
