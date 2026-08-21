---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "压缩引擎"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "列式压缩", "gorilla", "deltadelta"]
description: "TimescaleDB 列存压缩引擎——按列算法分发、batch 列式格式、sparse index 与压缩态 DML 三层剪枝解读"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

列存压缩（columnstore）是 TimescaleDB 的商业核心——它把 chunk 从行存转成列式压缩格式，实现 90%+ 压缩率并加速分析查询。这个模块（`tsl/src/compression/`，约 26k 行）负责压缩、解压、压缩态 DML、重组与 sparse index 构建。它是 Timescale License 功能，通过 `CrossModuleFunctions` 的 `compress_chunk`/`decompress_chunk`/`compressor_*` 等接口暴露给 Apache 侧调用。理解它就理解了 TimescaleDB "为什么又快又省"。

## 模块架构

```
api.c（对外）—— compress_chunk_impl (行 402) / decompress / rebuild_columnstore / compact
compression.c（核心）—— RowCompressor + 算法分发 definitions[] (行 71)
create.c —— 创建压缩 chunk、列存格式
compression_dml.c（2833 行）—— 压缩态 insert/update/delete：decompress_batches_scan (行 1103)
recompress.c（2734 行）—— recompress_chunk_segmentwise / compact_chunk 重组
algorithms/ —— 各列压缩算法（gorilla/deltadelta/dictionary/array/bool/uuid + simple8b_rle）
batch_metadata_builder_*.c —— sparse index（minmax / bloom1 / firstlast）
compression_scankey.c —— 压缩态 scankey 求值
```

## 调用链路

### 压缩链

```
compress_chunk_impl (api.c:402)
  ├─ LockRelationOid(hypertable + chunk, ExclusiveLock)
  ├─ find_chunk_to_merge_into（可合并到已有压缩 chunk）
  ├─ 若新建: create_compress_chunk 建压缩 companion chunk
  ├─ row_compressor_init (compression.c:1299)
  │    └─ 每列按类型选 Compressor（definitions[] 分发）
  └─ 主循环: 逐行 append → 满 batch flush
       ├─ segmentby 列：标量存（整 batch 同值）
       ├─ compressed 列：调 Compressor->append_val 累积
       └─ flush 时建 sparse index（min/max/bloom1/firstlast）
```

### 压缩态 DML 链

```
INSERT/UPDATE/DELETE 到压缩 chunk
  └─ decompress_batches_scan (compression_dml.c:1103)  三层剪枝:
       1. Index/Heap scan key 过滤（segmentby + orderby 列，原生 tuple 级，不解压）
       2. Bloom filter 剪枝（bloom1_contains_hash，假阳性~2.2% 无假阴，安全跳过）
       3. 内存 scankey 测试:
            batch_matches（逐行）或 batch_matches_vectorized（Arrow 批量，优先）
       └─ AllRowsPass 且无触发器/RETURNING → 直接删压缩 tuple，完全不解压
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `compress_chunk_impl` (api.c:402) | 压缩入口 | 加锁后重检查避免竞态，chunk 被并发删则报错 |
| `row_compressor_init` (compression.c:1299) | 初始化压缩器 | 每列按类型选算法 |
| `decompress_batches_scan` (compression_dml.c:1103) | 压缩态 DML | 三层递进剪枝 |
| `recompress_chunk_segmentwise` (recompress.c) | 重组 | ShareUpdateExclusiveLock 不阻塞 INSERT |

## 核心实现

### 算法分发：每列选 Compressor

`compression.c:71` 的 `definitions[]` 数组按 `CompressionAlgorithm` 枚举分发：

```c title="compression.c:71（算法分发表）"
static const CompressionAlgorithmDefinition definitions[] = {
    [COMPRESSION_ALGORITHM_ARRAY] = ARRAY_ALGORITHM_DEFINITION,
    [COMPRESSION_ALGORITHM_DICTIONARY] = DICTIONARY_ALGORITHM_DEFINITION,
    [COMPRESSION_ALGORITHM_GORILLA] = GORILLA_ALGORITHM_DEFINITION,
    [COMPRESSION_ALGORITHM_DELTADELTA] = DELTA_DELTA_ALGORITHM_DEFINITION,
    [COMPRESSION_ALGORITHM_BOOL] = BOOL_COMPRESS_ALGORITHM_DEFINITION,
    [COMPRESSION_ALGORITHM_NULL] = NULL_COMPRESS_ALGORITHM_DEFINITION,
    [COMPRESSION_ALGORITHM_UUID] = UUID_ALGORITHM_DEFINITION,
};
```

每个 `Compressor`（compression.h:66）实现 vtable：`append_null`/`append_val`/`is_full`/`finish`。算法适用类型：**gorilla**（浮点，XOR 编码连续相似值）、**deltadelta**（整数，二阶差分 + simple8b_rle 位打包）、**dictionary**（低基数重复值，存字典索引）、**array**（变长如 text/bytea）、**bool**（位图）、**uuid**。`simple8b_rle.h`（1264 行 header-only）是整数位打包的基础设施，用宏生成多类型实例。

### batch 列式格式与 segmentby/orderby

压缩 chunk 把多行（一个 batch，通常 1000 行）压缩成一行 tuple，每列存压缩后的 varlena。`CompressedDataHeader`（compression.h:38）带版本号指定算法，使同一代码跨 SQL 数据类型复用。两类特殊列：**segmentby 列**——整 batch 同值，存标量（压缩表的普通列），用于分 segment；**orderby 列**——压缩时按其排序，使 batch 内数据有序，支持稀疏索引与有序合并。`SegmentInfo`（compression.h:85）缓存 segmentby 值的比较函数加速路由。

### sparse index：跳过无关 batch

压缩时为每列 batch 构建 sparse index（`batch_metadata_builder_*.c`）：**minmax**（min/max，范围谓词跳过）、**bloom1**（bloom filter，等值谓词跳过，假阳性~2.2%）、**firstlast**（首/末值）。查询时 `compression_scankey.c` 与列存扫描的 `qual_pushdown.c` 用这些元数据在**不解压 batch** 的情况下跳过无关 batch——这是压缩态查询性能的关键。

### 压缩态 DML 的三层剪枝

`decompress_batches_scan`（compression_dml.c:1103）逐层减少解压：先 segmentby+orderby scan key 原生过滤，再 bloom filter 剪枝，最后内存 scankey（优先向量化 `batch_matches_vectorized` 用 Arrow 批量解压 + 位图运算）。当 DELETE 匹配整个 batch 所 有行且无触发器/RETURNING 时，直接删压缩 tuple**完全不解压**——CAGG 失效范围从 sparse index 元数据提取。`RowDecompressor`/`BulkWriter` 惰性初始化，过滤器排除所有 batch 时不分配内存，对高选择性点查尤其重要。

### 重组的并发策略

`recompress_chunk_segmentwise`（recompress.c）默认 `ShareUpdateExclusiveLock`（不阻塞 INSERT），仅 `ts_guc_enable_exclusive_locking_recompression` 开启才升级 `ExclusiveLock`。检测到并发 DML（唯一约束 + `GetLockConflicts` count>1）直接 bailout 避免浪费。重组完成后用 `ConditionalLockRelation` + 50ms 轮询（最多 5 秒）升级 `AccessExclusiveLock` 更新 chunk 状态。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略模式 | `definitions[]` 按列类型选算法 (compression.c:71) | 每列用最优算法 |
| 构建器模式 | `BatchMetadataBuilder` 做 sparse index | 压缩时边累积边建元数据 |
| 模板/泛型 | `simple8b_rle.h` 宏生成多类型 | 复用位打包逻辑 |
| 列式批处理 | batch（~1000 行）压缩成一行 tuple | 缓存友好 + 高压缩率 |

## 模块间交互

经 `CrossModuleFunctions` 的 `compress_chunk`/`decompress_chunk`/`recompress_chunk_segmentwise`/`compact_chunk`/`compressor_init`/`compressor_add_slot`/`compressor_flush`/`decompress_batches_for_insert`/`decompress_target_segments`/`columnstore_setup` 等暴露；调 `ts_catalog` 的 `compression_settings`（segmentby/orderby/index 配置）；与 `columnar_scan` 节点交互（查询时调 `decompress_column` 解压为 ArrowArray）；chunk 状态生命周期 `uncompressed → compressed → compressed_partial（DML 插入）→ compressed（重组后）` 由 recompress/compact 维护。

## 扩展方式

新增压缩算法：`compression.c:71` `definitions[]` 加项 + `tsl/src/compression/algorithms/` 实现 `Compressor` 接口与 `DecompressionIterator` + 若涉及 sparse index 同步扩展。新增 sparse index 类型：加 `batch_metadata_builder_*.c` + `compression_scankey.c`/`qual_pushdown.c` 识别。对应测试 `tsl/test/fuzzing/compression/`（每算法独立目录）。
