---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "Connector 外表"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "Connector", "数据湖", "Hive", "Iceberg", "Parquet", "ORC"]
description: "StarRocks Connector 双端架构：FE ConnectorMgr 三层组合与 13 种数据源注册，BE DataSource 抽象与自研 parquet/orc 向量化读取栈。"
readingTime: "15 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

湖仓直查（"querying data in data lakes directly"）的支撑模块，FE 侧 7.3 万行 + BE 侧 2.6 万行 + formats 4.2 万行。它独立成篇是因为这是一个**双端对称的边界模块**：FE 把外部 metastore 的库表映射成 `ExternalCatalog` 对象参与 SQL 生命周期，BE 把外部文件抽象成 `DataSource` 喂进 pipeline——两侧各有一套注册表与扩展契约，且必须同步演进。

## 模块架构

FE 侧是"注册表 + 三层组合"：`server/CatalogMgr`（:311）在 create catalog 时调 `connector/ConnectorMgr.createConnector()`。`ConnectorMgr` 本质是 `ConcurrentHashMap<String, CatalogConnector>` + 读写锁的注册表（`createConnector`/`removeConnector` 调 `shutdown()` 释放资源，`getMemTrackers()` 把支持 `MemoryTrackable` 的 connector 纳入 FE 内存追踪）。

`ConnectorFactory.createConnector()` 不直接 new 数据源类，而是组装 `CatalogConnector` = `LazyConnector`（延迟到首次使用才实例化真实 connector，避免建 catalog 时访问外部 metastore 阻塞）+ `InformationSchemaConnector` + `TableMetaConnector`。`CatalogConnector.getMetadata()` 返回聚合视图 `CatalogConnectorMetadata`，统一路由 information_schema 查询、元数据缓存与普通表元数据。真实实例化走反射：`ConnectorType` 枚举（ES/HIVE/ICEBERG/JDBC/HUDI/DELTALAKE/PAIMON/ODPS/KUDU/FLUSS/UNIFIED/BENCHMARK/LANCE，**13 种**）提供 `connectorClass`/`configClass`，反射调 `(ConnectorContext)` 构造器，每个数据源一个子包。

> SPI 待核实：`fe/connector/README.md` 描述了面向 `fe/spi` 的插件化愿景（ServiceLoader 发现），但当前 HEAD 不存在 `fe/spi` 目录——实际机制仍是 enum+反射，SPI 属于规划中。

## 调用链路

### BE 扫描链（以 Hive 为例）

```text
Connector 接口（connector_primitive/connector.h，仅两个虚方法）
  create_data_source_provider(ConnectorScanNode*, TPlanNode&)    # 读路径收敛点
  create_sink_provider(...)                                       # 外表写回
HiveConnector → HiveDataSourceProvider（持 THdfsScanNode）
  prepare_scan_ranges() / default_data_source_mem_bytes()（内存仲裁）
  → 每个 TScanRange 一个 HiveDataSource：
      open() → _init_conjunct_ctxs / _decompose_conjunct_ctxs / _init_global_dicts
             → _init_scanner() 选择 HdfsScanner 子类
      get_next(RuntimeState, ChunkPtr*) → close()
```

注意核心接口已从 `be/src/connector/` 前移到 `be/src/connector_primitive/`（模块边界清单的产物——connector_common 只依赖原语层）。

### Split 调度

FE 侧 `HdfsScanNode.setupScanRangeLocations()`（`planner/HdfsScanNode.java`）委托 `HiveConnectorScanRangeSource`：`RemoteFileOperations.getRemoteFiles()` 列文件（含 CachingRemoteFileIO 缓存）→ `getSourceOutputs(maxSize)` 生成 `TScanRangeLocations`。两个关键调度决策：`updateBackendSplitFile()`——split 数 > 2×(CN+BE) 时把"按 maxScanRangeLength 切文件"**下推给 BE**（backend split），否则 FE 直接切；最后 `Collections.shuffle(res)` 打乱分区顺序避免 probe 查询撞坏 case。BE 侧 `ConnectorScanNode::convert_scan_range_to_morsel_queue_builder()`（`exec/connector_scan_node.h:65`）把 scan range 转 morsel 队列供 pipeline 并行，`get_split_tasks()` 支持 IO-intensive 的 split task 并行。

## 核心实现

### 自研 parquet 栈

`be/src/formats/parquet/`：`metadata.h` 注释明言 "port from apache/arrow metadata"——从 Arrow C++ 移植了 FileMetaData 解析（arrow_memory_pool 复用 Arrow 内存分配），但列读取栈 `column_reader`/`stored_column_reader`/`page_reader`/`group_reader` **全部自研**，不复用 libarrow 运行时。ORC 则 vendor 了完整 `apache-orc/` 子目录，`OrcChunkReader` 做适配（`orc_mapping`/`orc_min_max_decoder` 做 schema 映射与 min/max 下推解码）。基于 parquet/orc 的湖格式（Iceberg/Hudi/Delta/Paimon）BE 侧重用 Hive 的 `HdfsParquetScanner`/`HdfsOrcScanner`，差异在 split 生成与 delete 处理（`formats/iceberg/iceberg_delete_builder.h`、`formats/delta/deletion_vector.h`）。

### 数据缓存

- **BE datacache**：`be/src/cache/datacache.{h,cpp}`（BlockCache 抽象 + disk/mem + peer/remote cache engine），starcache 集成在 `be/src/compute_env/staros/staros_starcache.cpp`。
- **FE datacache 包**是**查询级智能缓存选择/填充**（`DataCacheMgr`/`DataCacheSelectExecutor`/`DataCachePopulateMode`，规则化热数据 populate），与 BE block cache 是两回事，勿混淆。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 枚举注册表 + 反射工厂 | FE `ConnectorType` + `ConnectorFactory.createRealConnector()` | 新数据源接入面收敛到一处清单 |
| 注册表 | BE `connector_registry.h`（`default_instance()` 单例），注册入口 `be/src/module/connector_bootstrap.cpp` 的 `bootstrap_builtin_connectors()`（`install_if_absent<HiveConnector>()()` 编译期条件注册，JDBC/ES 受宏控制可选裁剪） | 链接期裁剪 |
| 惰性初始化 | FE `LazyConnector` | 建 catalog 不应被外部 metastore 卡住 |
| 组合/装饰 | `CatalogConnector` 三合一 | information_schema 与普通元数据统一路由 |
| 策略 | `HdfsScanner` 子类按文件格式选择 | 格式差异隔离在 scanner 层 |

## 模块间交互

- FE 侧挂 [02 元数据](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/02-catalog-ha) 的 catalog 树（`ExternalCatalog`）；split 生成结果进 [04 QE](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/04-qe) 的 Coordinator scan range 分配。
- BE 侧 DataSource 是 [09 Pipeline](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/09-pipeline) scan 算子的数据来源；读取产出 [10 向量化](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/10-vectorization) 的 Chunk。
- shared-data 模式下 lake 表读写经 `connector/lake` 与 StarOS 文件层，见 [07 存算分离](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/07-shared-data)。

## 扩展方式

**新增一个数据湖引擎**（完整清单）：

1. FE：`ConnectorType.java` 加枚举 → 新建 `connector/<source>/<Source>Connector implements Connector`（`getMetadata()` 返回 `ConnectorMetadata` 实现）+ `ColumnColumnTypeConverter` 类型映射 → split source（参照 `HiveConnectorScanRangeSource`）→ planner 侧 ScanNode；
2. BE：`be/src/connector/<source>/` 实现 `Connector`（`create_data_source_provider`）+ `DataSource`/`DataSourceProvider` → 新文件格式则扩展 `be/src/formats/`，parquet/orc 基座则复用 `HdfsScanner` 栈 → `be/src/module/connector_bootstrap.cpp` 注册。
