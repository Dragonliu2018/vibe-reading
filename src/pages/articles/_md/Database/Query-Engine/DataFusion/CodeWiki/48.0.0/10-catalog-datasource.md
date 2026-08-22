---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "目录与数据源"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "TableProvider 双职责、CatalogProvider 三级目录、ListingTable 文件表与 Hive 分区裁剪。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/catalog`（+ `catalog-listing`）与 `datafusion/datasource`（+ `datasource-{parquet,csv,json,avro,arrow}`）是 DataFusion 的**存储接入层与扩展基石**。`TableProvider` 横跨计划期（供 schema/统计）与执行期（`scan` 产 ExecutionPlan），是用户接入新存储的核心扩展点；`CatalogProvider`/`SchemaProvider` 提供三级目录。DataFusion 不绑定特定存储——通过 trait 抽象，第三方可读任何存储（Delta Lake/Iceberg/Hudi/PostgreSQL/Kafka）而不改核心代码。

## 模块架构

```text
catalog/
├── catalog.rs    # CatalogProvider + CatalogProviderList trait（三级目录顶层）
├── schema.rs     # SchemaProvider trait（table 列表，table() async）
├── table.rs      # TableProvider trait（schema/scan/supports_filters_pushdown/insert_into）
├── streaming.rs  # StreamingTable（无界数据源）
├── listing_schema.rs / dynamic_file/ / memory/  # schema 与动态文件 catalog 实现
└── view.rs cte_worktable.rs information_schema.rs  # view/CTE/information_schema
datasource/
├── source.rs          # DataSource trait + DataSourceExec（适配为 ExecutionPlan）
├── file_scan_config.rs  # FileScanConfig（文件扫描配置 + PartitionColumnProjector）
├── file.rs            # FileSource trait + FileOpener
├── file_format.rs     # FileFormat trait（infer_schema/create_physical_plan）
└── statistics.rs / file_groups.rs / file_meta.rs
datasource-{parquet,csv,json,avro,arrow}/  # 各格式 FileSource/FileFormat 实现
```

## 调用链路

查询执行时数据源的介入：

```text
SQL 表名解析 → catalog.schema.table 三级路径
  CatalogProviderList::catalog("my_catalog") → CatalogProvider
  CatalogProvider::schema("my_schema") → SchemaProvider
  SchemaProvider::table("my_table") → TableProvider (async)
TableProvider::scan(state, projection, filters, limit) → Arc<dyn ExecutionPlan>   # table.rs:166
  ListingTable::scan                                                # core/src/datasource/listing/table.rs:884
    ├─ 分离 partition filter（仅依赖分区列，做分区裁剪）与普通 filter
    ├─ list_files_for_scan(state, &partition_filters, limit) → (file_groups, statistics)
    ├─ split_groups_by_statistics（按 min/max 分组到目标分区数）
    └─ format.create_physical_plan(FileScanConfigBuilder…build()) → DataSourceExec
DataSourceExec::execute → DataSource::open(partition, ctx) → FileStream → RecordBatch
```

## 核心实现

### TableProvider：横跨计划期与执行期

```rust title="datafusion/catalog/src/table.rs:51"
#[async_trait]
pub trait TableProvider: Debug + Sync + Send {
    fn schema(&self) -> SchemaRef;                                          // 计划期供优化器
    fn table_type(&self) -> TableType;
    async fn scan(&self, state: &dyn Session, projection: Option<&Vec<usize>>,
                  filters: &[Expr], limit: Option<usize>) -> Result<Arc<dyn ExecutionPlan>>;
    fn supports_filters_pushdown(&self, filters: &[&Expr]) -> Result<Vec<TableProviderFilterPushDown>>;  // Exact/Inexact/Unsupported
    fn statistics(&self) -> Option<Statistics> { None }                       // cost-based 优化
    async fn insert_into(&self, …) -> Result<Arc<dyn ExecutionPlan>> { not_impl }
    // … constraints / get_column_default / get_table_definition
}
```

计划期：`schema()` 给列名/类型供表达式检查/投影裁剪/统计估算；`supports_filters_pushdown()` 逐条告知哪些 filter 可下推（`Exact` 精确/`Inexact` 近似/`Unsupported` 不支持，默认全 Unsupported）；`statistics()` 供 join 重排等 cost 优化。执行期：`scan(projection, filters, limit)` 三参数分别承载投影下推、谓词下推、limit 下推——列存用 `projection` 跳无关列大幅减 I/O，用 `filters` 在读取层裁剪。注意：filter 列可能不在 projection 中但 scan 仍需内部读该列评估谓词（`table.rs:121` 注释图解）。

### 三级目录与 sync/async 设计

```text
CatalogProviderList (catalog 集合)  → CatalogProvider (schema_names/schema)
   → SchemaProvider (table_names，table() async) → TableProvider (schema/scan)
```

关键设计：`CatalogProvider`/`CatalogProviderList` 方法**同步**，`SchemaProvider::table()` **async**（`schema.rs:52`）。注释（`catalog.rs:67`）解释：计划 API 故意非 async——远程 catalog 若每次访问触发网络请求会导致一次 plan 多次 round-trip，性能极差。推荐预取缓存快照后同步查询。`table()` 是 async 因列出表名容易但读表详情（统计/schema）可能有非平凡 I/O。查询路径 `catalog.schema.table` 经这三层。

### ListingTable：文件表 Facade

```rust title="datafusion/core/src/datasource/listing/table.rs:751"
pub struct ListingTable {
    table_paths: Vec<ListingTableUrl>,
    file_schema: SchemaRef,        // 文件物理 schema（不含分区列）
    table_schema: SchemaRef,       // file_schema + 分区列
    options: ListingOptions,       // 格式/扩展名/分区列/统计收集
    collected_statistics: FileStatisticsCache,
    constraints: Constraints,
}
```

`ListingTable` 是文件表 Facade，封装文件发现、分区裁剪、统计收集、格式分发。`scan`（`:884`）：分离 partition filter 与普通 filter；`list_files_for_scan` 用 partition filter 跳不匹配 Hive 分区目录；无文件返 `EmptyExec`；按统计 min/max 分组文件到目标分区数；委托 `FileFormat::create_physical_plan(FileScanConfigBuilder…build())`（`:959`）。格式推断 `infer_options`（`:155`）从扩展名取格式（`.parquet`→ParquetFormat，`.csv.gz`→CsvFormat+gzip），经 `state.get_file_format_factory`。`DataSourceExec`（`source.rs:183`）impl `ExecutionPlan` 委托 `DataSource::open`/`statistics`，统一执行接口。

### Hive 分区与 PartitionColumnProjector

Hive 路径 `/data/year=2022/month=01/file.parquet` 的 `year=2022`/`month=01` 解析为分区列。分区列类型默认 `Dictionary(UInt16, Utf8)`（`file_scan_config.rs:1508` `wrap_partition_type_in_dict`），空间与分区值数折中。分区列不在物理文件中，由 `PartitionColumnProjector`（`:1131`）读时注入 RecordBatch。分区裁剪在文件列出阶段完成（`table.rs:905`），避免读不相关文件；分区列所有 key=0 的字典数组复用同一 zero buffer（`file_scan_config.rs:1230` `ZeroBufferGenerators`），内存从 O(record_count) 降 O(batch_size)——千万级分区表裁剪查询近零开销。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy | `TableProvider`（`table.rs:51`）、`DataSource`（`source.rs:115`）、`FileSource`（`file.rs:54`） | 不同数据源/格式同接口 |
| Adapter | `FileFormat`（`file_format.rs:50`）适配各格式，`DataSourceExec` 适配 `DataSource` 为 `ExecutionPlan` | 统一 FileScanConfig→格式特定 plan |
| Builder | `FileScanConfigBuilder`（`file_scan_config.rs:239`） | 链式建 FileScanConfig 应用默认值 |
| Facade | `ListingTable` | 封装文件发现/裁剪/统计/分发，对外统一 TableProvider |

## 模块间交互

`catalog` 依赖 `common`/`expr`/`physical-plan`/`arrow`；`datasource` 依赖 `common`/`execution`/`physical-plan`/`physical-expr`；`datasource-parquet` 依赖 `datasource`/`physical-expr`/`object_store`。被 `catalog-listing`（装配 ListingTable、`pruned_partition_list` 分区裁剪）、`core`（`read_csv`/`read_parquet` 注册 ListingTable、`listing_table_factory.rs`）、`sql`（表名三级路径解析）依赖。关键调用链：SQL→`sql::resolve_table_ref`→`CatalogProviderList::catalog`→`CatalogProvider::schema`→`SchemaProvider::table`→`TableProvider::scan`→`FileFormat::create_physical_plan`→`FileScanConfigBuilder::build`→`DataSourceExec::from_data_source`→`FileStream::execute`。

## 扩展方式

- **自定义 TableProvider 读新存储**：新建 crate 定义 `XxxTable` impl `TableProvider`（`schema`/`scan`/`supports_filters_pushdown`），`scan` 内查存储构 `DataSourceExec` 或返自定义 `ExecutionPlan`，`SessionContext::register_table` 注册。参考 `StreamingTable`（`streaming.rs:36`，最简）。
- **新增文件格式**：新建 crate 定义 `XxxSource` impl `FileSource`（`create_file_opener` 返 `XxxOpener` impl `FileOpener`、`with_projection`/`with_statistics`），定义 `XxxFormat` impl `FileFormat`（`infer_schema`/`infer_stats`/`create_physical_plan`/`file_source`），定义 `XxxFormatFactory` impl `FileFormatFactory` 注册到 `SessionState`。参考 `ParquetSource`（`datasource-parquet/src/source.rs:261`）、`ParquetFormat`。
- **注册自定义 catalog**：定义 `XxxCatalogProvider` impl `CatalogProvider`、`XxxSchemaProvider` impl `SchemaProvider`、`XxxCatalogProviderList` impl `CatalogProviderList`，`SessionContext::register_catalog` 注册。按 `catalog.rs:67` 设计指导：远程 metastore 应预取所有 schema/table 元数据到内存快照同步访问。参考 `datafusion-examples/examples/remote_catalog.rs`。
