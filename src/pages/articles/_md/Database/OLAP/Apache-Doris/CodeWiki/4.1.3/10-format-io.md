---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "文件格式与 IO"
date: "2026-08-23T18:40:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "FileSystem", "Parquet", "ORC", "谓词下推"]
description: "Doris 文件格式与 IO：FileSystem 抽象 (S3/HDFS/本地) + Parquet/ORC 多级谓词下推 + Lazy 物化。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

文件格式与 IO 模块（`be/src/format/` + `be/src/io/`，~7.2 万行）负责文件系统抽象与多种文件格式读取。`io/` 用 `FileSystem` 抽象统一 Local/S3/HDFS/Broker 后端，`format/` 用 `GenericReader` 统一 Parquet/ORC/CSV/JSON/Native 格式，实现列裁剪与谓词下推到文件层。独立成文是因为多后端 IO 与格式解析独立于存储引擎——它回答"怎么透明读 S3/HDFS/本地、怎么按列读 Parquet/ORC、怎么用统计过滤数据"。

## 模块架构

模块分两块：**IO 抽象层**（`io/fs/file_system.h` 的 `FileSystem` 基类 + `RemoteFileSystem` 中间层 + 各实现，`file_reader.h` 的 `FileReader` 基类 + `ObjStorageClient` 统一对象存储客户端）、**格式读取层**（`generic_reader.h` 的 `GenericReader` 基类 + 各格式 Reader + `FileFactory` 抽象工厂）。

```
FileSystem (抽象基类, open_file→open_file_impl 模板方法)
  ├─ LocalFileSystem (全局单例 global_local_filesystem)
  └─ RemoteFileSystem (中间层, 自动包装文件块缓存)
       ├─ S3FileSystem (持 ObjClientHolder, AK/SK 热更新)
       ├─ HdfsFileSystem (持 HdfsHandler)
       └─ BrokerFileSystem (Thrift 调 Broker 进程)

FileReader (read_at→read_at_impl 偏移随机读)
  └─ DelegateReader (按 AccessMode 包装: MergeRange/BufferedStream/Tracing)

GenericReader (策略模式, get_next_block 统一接口)
  ├─ ParquetReader (RowGroupReader + 列裁剪 + LazyRead)
  ├─ OrcReader (SearchArgument 原生下推)
  ├─ CsvReader / JsonReader
  └─ NativeReader (Doris 自有二进制, PBlock 反序列化)
```

## 调用链路

Scan 算子通过 FileScanner 到 Block（以 Parquet 为例）：

```
FileScanner::_get_next_reader (exec/scan/file_scanner.cpp:1051)
  ├─ FORMAT_PARQUET → ParquetReader::create_unique (line 1184)
  ├─ ParquetReader::init_reader (vparquet_reader.cpp:405)
  │    ├─ _open_file → DelegateReader::create_file_reader (底层 Local/S3/HDFS FileReader)
  │    ├─ parse_thrift_footer → FileMetaData (Parquet footer, FileMetaCache 缓存)
  │    ├─ 列裁剪: 遍历 all_column_names 检查 schema → _read_file_columns / _missing_cols
  │    └─ 构建 _lazy_read_ctx (conjuncts, predicate_columns, lazy_read_columns)
  └─ ParquetReader::set_fill_columns (vparquet_reader.cpp:490)
       ├─ 提取 predicate_columns
       ├─ 构建 _push_down_predicates (SingleColumnBlockPredicate)
       └─ 判定 can_lazy_read
  循环 _cur_reader->get_next_block (file_scanner.cpp:589)
    → ParquetReader::get_next_block (vparquet_reader.cpp:698)
      → _next_row_group_reader (line 780)
        ├─ 遍历 row groups:
        │    _process_min_max_bloom_filter (line 797)
        │      ├─ _process_column_stat_filter (line 1181): read_column_stats + read_bloom_filter
        │      │    → predicate->evaluate_and(&stat) 判定是否过滤整个 Row Group
        │      └─ _process_page_index_filter (line 1195): 页级 min/max 过滤
        │    过滤的 group 跳过，选中创建 RowGroupReader
        └─ RowGroupReader::next_batch(block, batch_size, ...)
              ├─ _read_column_data → 读取谓词列
              ├─ 执行谓词过滤 → FilterMap
              └─ _do_lazy_read → 仅读过滤后剩余行的 lazy 列
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `FileFactory.create_fs` | 创建 FileSystem | 按 TFileType switch |
| `FileFactory.create_file_reader` | 创建 FileReader | 远程文件包装 cached_file_reader |
| `FileSystem.open_file` | 打开文件 | 模板方法，调 open_file_impl |
| `FileReader.read_at` | 偏移随机读 | 调 read_at_impl |
| `GenericReader.get_next_block` | 读一批 Block | 策略模式，各格式实现 |
| `ParquetReader.init_reader` | 初始化 | footer+列裁剪+lazy ctx |
| `_process_min_max_bloom_filter` | Row Group 过滤 | min/max+Bloom Filter |
| `RowGroupReader.next_batch` | 读 Row Group | 谓词列先读，lazy 列后读 |
| `OrcReader._init_search_argument` | ORC 下推 | VExpr→orc::SearchArgument |

</details>

## 核心实现

### 统一 FileSystem 抽象

`FileSystem`（`io/fs/file_system.h:85`）公开接口非虚函数 `open_file`，调用保护纯虚 `open_file_impl`——模板方法模式。`FILESYSTEM_M` 宏（`file_system.h:34`）把 bthread 上下文中的同步 IO 切到异步 IO 线程池。`RemoteFileSystem`（`remote_file_system.h:31`）是中间层：`open_file_impl` 调子类 `open_file_internal` 并用 `create_cached_file_reader` 自动包装文件块缓存，本地文件不需。

**为什么统一抽象**：Doris 需支持本地/S3/HDFS/Broker 多后端，统一后上层 reader 只经 `FileReader::read_at(offset, ...)` 读数据不关心底层是 S3 GET/HDFS read/本地 pread。`ObjClientHolder`（`s3_file_system.h:45`）允许运行时热更新 AK/SK 不重建 FileReader，解决 S3 凭证轮换。`ObjStorageClient`（`obj_storage_client.h:86`）统一对象存储客户端接口，支持 `AWS/AZURE/BOS/COS/OSS/OBS/GCP/TOS` 八种类型。

### Parquet 多级谓词下推

Parquet 文件可能数亿行，全扫代价巨大，Doris 实现三层过滤（`vparquet_reader.cpp:1150` `_process_min_max_bloom_filter`）：

1. **Row Group 级 min/max**：读 `ColumnMetaData.statistics`，用 `MutilColumnBlockPredicate::evaluate_and` 判定整组数据范围是否与查询条件相交，不相交跳过整组（可跳过数万行）。
2. **Page 级 min/max**：读 `ColumnIndex`（Page 级统计），`_process_page_index_filter`（`vparquet_reader.cpp:952`）在组内进一步过滤不需要的 Page。
3. **Bloom Filter**：等值查询（`=`/`IN`）读 Row Group Bloom Filter，`ParquetPredicate::read_bloom_filter`（`parquet_predicate.h:441`）用 `ParquetBlockSplitBloomFilter` 判定值是否一定不存在。

统计信息解析 `ParquetPredicate::parse_min_max_value`（`parquet_predicate.h:216`）把 Parquet 物理编码的 min/max 转换为 Doris 逻辑类型，处理了 INT96 时间戳统计不可靠（PARQUET-1065）、旧版 UTF-8 字符串统计截断（`_try_read_old_utf8_stats`）、浮点 NaN/-0.0 等边界情况。

### 列裁剪与 Lazy Materialization

Doris 不仅做基本列裁剪（只读查询涉及的列），还实现 **Lazy Read（延迟物化）**（`vparquet_reader.cpp:445`）：将列分为 `predicate_columns`（谓词列）和 `lazy_read_columns`（非谓词列）。先只读谓词列执行过滤得 FilterMap，再据 FilterMap 只读匹配行的 lazy 列，避免读取被过滤行数据。判定（`vparquet_reader.cpp:629`）：`can_lazy_read = _enable_lazy_mat && predicate_columns.size() > 0 && lazy_read_columns.size() > 0`。

### ORC SearchArgument vs Parquet 自研

ORC 库原生提供 `SearchArgument` API 做 Stripe 级谓词过滤，Doris 只需翻译表达式——`OrcReader::_init_search_argument`（`vorc_reader.cpp:1164`）递归构建 `orc::SearchArgument`（`_build_less_than`/`_build_equals`/`_build_filter_in`），经 `_row_reader_options.searchArgument` 交给 ORC 库原生过滤，支持 `LT/LE/GT/GE/EQ/NE/FILTER_IN/IS_NULL`。Parquet 无类似库级 API，Doris 自研 `ParquetPredicate` + `MutilColumnBlockPredicate` 体系，可更细粒度控制（Page 级 + Bloom Filter + Lazy Read）。

### Native 格式

`NativeReader`（`format/native/native_reader.h:49`）读取 Doris 自有二进制格式（序列化 `PBlock`），`_read_next_pblock` 反序列化得 Block，零序列化开销。Doris 内部表用 segment_v2 格式（`storage/segment/`，不经 format/ 模块，直接用 `SegmentReader`），但底层 IO 仍经 `io::FileReader`（LocalFileReader）。开放格式（Parquet/ORC）主要用于外部表（Hive/Iceberg）和数据导入导出，远程查询结果传输用 Native 格式零开销。

### FileFactory 抽象工厂

`FileFactory`（`io/file_factory.h:82`）用 `ENABLE_FACTORY_CREATOR` 宏，`create_fs` 按 `FSProperties` 创建 FileSystem，`create_file_reader` 按 `TFileType`（FILE_LOCAL/FILE_S3/FILE_HDFS/FILE_BROKER/FILE_HTTP）创建对应 FileReader，远程文件还包装 `create_cached_file_reader` 实现文件块缓存。各 reader 类也用 `ENABLE_FACTORY_CREATOR`（如 `ParquetReader::create_unique`），对象创建与使用解耦。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 抽象工厂 | `FileFactory` | 按类型创建 FS/Reader，解耦创建与使用 |
| 策略 | `GenericReader` + 各格式 Reader | 运行时按 TFileFormatType 选读取策略 |
| 模板方法 | `FileSystem.open_file`/`FileReader.read_at` | 基类骨架，子类填步骤 |
| 谓词下推 | ParquetPredicate / Orc SearchArgument | Row Group/Page/Bloom Filter 三级过滤 |
| 委托/包装 | DelegateReader / ORCFileInputStream | 适配 IO 模式与库接口 |

## 模块间交互

被 `exec/scan`（`FileScanner::_get_next_reader`（`file_scanner.cpp:1051`）按 `TFileFormatType` 创建 reader，循环 `get_next_block`）、`storage`（Doris 内部表经 `segment_v2` 直接读自有格式，但底层 IO 经 `io::FileReader`）、`datasource`（外部表 Hive/Iceberg/Hudi/Paimon 经 `format/table/` 的 reader 如 `IcebergTableReader`/`HiveReader` 读 Parquet/ORC，内部调 `ParquetReader`/`OrcReader` 或经 JNI 调 Java SDK）。与 `core` 对接：所有 reader 输出 `Block`（`core/block/block.h`），Block 含 `ColumnWithTypeAndName` 数组，DataType 和 Column 直接复用 Doris 向量化执行引擎。

## 扩展方式

新增文件格式（如 Avro C++ 原生读取）：新建 `be/src/format/avro/avro_reader.h/cpp` 继承 `GenericReader`（实现 `init_reader`/`get_next_block`/`get_columns`/`get_parsed_schema`/`set_fill_columns`）；`exec/scan/file_scanner.cpp:1119` 的 `_get_next_reader` switch 加 `case FORMAT_AVRO:`；`format/transformer/vfile_format_transformer_factory.cpp` 如需导出加 transformer；FE 侧 `TFileFormatType` Thrift 加枚举。

新增 FileSystem（如新对象存储）：新建 `be/src/io/fs/xxx_file_system.h/cpp` 继承 `RemoteFileSystem`（实现 `open_file_internal`/`create_file_impl`/`delete_file_impl`/`list_impl`）；新建 `xxx_file_reader.h/cpp` 继承 `FileReader`（实现 `read_at_impl`，通常调 `ObjStorageClient`）；`obj_storage_client.h` 实现 `ObjStorageClient` 子类或 `ObjStorageType` 枚举加类型；`file_factory.cpp:99` 的 `create_fs` switch 加 `case FILE_XXX:`；FE 侧 `TFileType`/`TStorageBackendType` 加类型。

修改 Parquet 谓词下推规则（如新增对 JSON 类型的 min/max 过滤）：`parquet_predicate.h:216` 的 `parse_min_max_value` 加对应 `tparquet::Type` 物理列构造和逻辑转换；`parquet_predicate.h:171` 的 `bloom_filter_supported` 如需 Bloom Filter 支持则新增类型；`vparquet_reader.cpp:1203` 的 `_process_column_stat_filter` 中 `get_stat_func` lambda 如需特殊处理则修改。
