---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "连接器生态与存储格式库"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "连接器", "数据湖", "Parquet"]
description: "Trino 483 连接器生态鸟瞰：61 插件分类、example-http 最小连接器走读、base-jdbc 复用模式与 lib/ 分层"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

生态层：`plugin/` 的 61 个插件覆盖数据湖/RDBMS/NoSQL/流/系统扩展，`lib/` 的 20 个模块是连接器间共享的底层库（文件系统抽象、Parquet/ORC 读写、Hive Metastore 客户端）。这一篇回答三个问题：**生态怎么分层组织、一个最小连接器长什么样、RDBMS 家族怎么复用同一套框架**。

## 生态鸟瞰

| 类别 | 数量 | 成员 |
| --- | --- | --- |
| 数据湖 | 5 | hive, iceberg, delta-lake, hudi, lakehouse |
| base-jdbc 家族 | 15 | base-jdbc + 14 消费者：mysql, postgresql, mariadb, sqlserver, oracle, exasol, singlestore, clickhouse, redshift, duckdb, snowflake, druid, ignite, example-jdbc |
| 非 JDBC 数据源 | 13 | cassandra, elasticsearch, opensearch, mongodb, redis, kafka, pinot, loki, prometheus, bigquery, google-sheets, thrift, faker |
| 函数包 | 6 | ai-functions, datasketches, functions-python, geospatial, ml, teradata-functions |
| 内建/测试连接器 | 8 | memory, jmx, blackhole, tpch, tpcds, example-http, thrift-api, thrift-testing-server |
| 系统扩展 | 14 | exchange-filesystem, exchange-hdfs, spooling-filesystem；4 个 event-listener；opa/ranger；password-authenticators, ldap-group-provider, resource-group-managers, session-property-managers, openlineage |

Top 5 LOC（main 源码实测）：**hive 64,173 / iceberg 47,388 / delta-lake 30,220 / base-jdbc 21,831 / kafka 9,365**。

## 最小连接器走读：trino-example-http

17 个类 1,299 行（含测试服务器）——这就是"一个连接器最少要实现什么"的活教材：

```
ExamplePlugin.getConnectorFactories() → [ExampleConnectorFactory]
ExampleConnectorFactory.create()      → Bootstrap(JsonModule + TypeDeserializerModule
                                         + ConnectorContextModule + ExampleModule)
                                         → Guice Injector → ExampleConnector
ExampleConnector                      → beginTransaction→INSTANCE（单例事务）
                                         getMetadata / getSplitManager / getRecordSetProvider
ExampleMetadata                       → listSchemaNames / getTableHandle / getTableMetadata
                                         / listTables / getColumnHandles / listTableColumns
ExampleSplitManager.getSplits()       → table.getSources() 每个 URI 一个 ExampleSplit，
                                         Collections.shuffle 后包 FixedSplitSource
ExampleRecordSetProvider.getRecordSet → ExampleRecordSet → ExampleRecordCursor
ExampleClient                         → Suppliers.memoize 拉 JSON 元数据
```

关键点：example 只实现**行式 API**——`ExampleRecordCursor.advanceNextPosition()` 逐行、`getLong/getDouble/getSlice/isNull` 按列取值；向量化由引擎侧 `RecordPageSourceProvider`（core/trino-main/.../split/）+ `RecordPageSource`（trino-spi）包装成 Page，**连接器不必手写 Page**。

最小清单：Plugin → ConnectorFactory → Connector（metadata + splitManager + recordSetProvider 三件套）+ ConnectorMetadata（表/列）+ ConnectorSplitManager（并行单元）+ RecordSet/Cursor（读）+ Handle POJO（Table/Column/Split）+ Config/Module。PageSink、AccessControl、SessionProperties 全可选。`checkStrictSpiVersionMatch`（plugin/base/Versions，来自 trino-plugin-toolkit）强制 SPI 版本匹配。

## base-jdbc 框架：73 方法的复用面

`io.trino.plugin.jdbc` 下 112 类；`JdbcClient` 接口 **73 个方法**（metadata 13 类 + 类型映射 + 谓词/join 下推 + DDL + insert/merge 全生命周期）。`JdbcConnector` 组装 11 项 SPI 能力。

复用链（以 mysql 为例）：`MySqlPlugin` → `BaseJdbcConnectorFactory`（装 `MySqlClientModule`）→ `JdbcModule` → `JdbcConnector`。子连接器只写 `MySqlClientModule.setup()` 里一行 `binder.bind(JdbcClient.class).annotatedWith(ForBaseJdbc.class).to(MySqlClient.class)` + 一个 `@Provides ConnectionFactory`（DriverConnectionFactory.builder）；`MySqlClient extends BaseJdbcClient` 仅 46 个 @Override / 73。

薄适配实测（main LOC）：**duckdb 454 / exasol 618 / snowflake 825 / singlestore 928 / mariadb 1,161 / mysql 1,890（仅 7 类）/ postgresql 3,182**——vs base-jdbc 的 21,831。装饰器：`CachingJdbcClient`（元数据缓存）、`DynamicFilteringJdbcSplitSource`（动态过滤下推 JDBC）、`ClassLoaderSafeConnectorMetadata`（防类泄漏）。

## lib/ 分层

| 层 | 模块（main LOC） | 被谁用 |
| --- | --- | --- |
| 引擎用 | plugin-toolkit 19,376、array 2,146、cache 1,760、geospatial-toolkit 1,671、memory-context 771、matching 757 | trino-main 直接依赖 |
| 湖格式族 | parquet 36,255、orc 30,498、hive-formats 21,801、metastore 9,221、filesystem 6,362、filesystem-s3 4,679、hdfs 3,945、filesystem-azure 3,164、filesystem-gcs 2,250、filesystem-cache-alluxio 1,331、filesystem-manager 579 | 仅连接器（湖族五家共用） |
| 其他 | record-decoder 4,247（kafka/redis 的 CSV/JSON 解码）、geospatial-epsg(+generator) 847 | 各自消费方 |

核心抽象 `TrinoFileSystem`（~39 方法：`newInputFile(Location)/newOutputFile/listFiles/deleteDirectory`…）+ `TrinoInputFile/TrinoOutputFile`。装配在 `FileSystemModule.createFileSystemFactory()`（lib/trino-filesystem-manager）：`SwitchingFileSystemFactory` 按 `Location.scheme()` 路由 s3/gs/abfss/hdfs 工厂，外包 `TracingFileSystemFactory` 与可选 Alluxio/Memory 缓存。iceberg 的 `DefaultIcebergFileSystemFactory`、hive 连接器均基于此构建。`io.trino.metastore.HiveMetastore`（72 方法）被 hive/iceberg/delta-lake/hudi/lakehouse 五连接器共享——**lib/ 独立成 Maven 模块的最大动因：36k 行 parquet 只写一份**。云 SDK（s3/gcs/azure）各自成 jar 隔离传递依赖。

## exchange-filesystem：容错执行的可插拔存储

`FileSystemExchangePlugin.getExchangeManagerFactories()` → `FileSystemExchangeManagerFactory` → `FileSystemExchangeManager implements ExchangeManager`（io.trino.spi.exchange）。fault-tolerant 模式下 stage 间数据不走内存直连，每个 task 把输出 Page 序列化为分区文件，下游经 `FileSystemExchangeSource` 读。存储后端抽象为 `FileSystemExchangeStorage` 接口（createExchangeStorageReader/Writer、deleteRecursively、listFilesRecursively），三个实现：Local/S3/AzureBlob——**容错执行可换存储后端，这正是 exchange 也做成插件的原因**（配合[分布式调度](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/04-scheduler)的 EventDriven 调度器）。

## 设计决策

- **为什么连接器只依赖 SPI**：每 catalog 一个 PluginClassLoader 隔离，SPI 面小且稳定（revapi 门禁）；`ClassLoaderSafeConnectorMetadata` 防引擎持插件类。合约细节见[SPI 与连接器框架](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/07-spi-connector-framework)；
- **为什么 lib/ 独立成 Maven 模块**：湖族 5 连接器共享一份 parquet/orc/metastore 实现；trino-main 只引 6 个 lib，引擎依赖树干净；
- **为什么 exchange 也做成插件**：同 Plugin 机制加载，后端可替换（Local/S3/Azure）。

## 扩展方式

**新 RDBMS 连接器（base-jdbc 路线）**：抄 trino-example-jdbc——Plugin/ConnectorFactory 注册 `BaseJdbcConnectorFactory` + 自己的 Module；Module 里 bind `JdbcClient @ForBaseJdbc` + `@Provides ConnectionFactory`；`XxxClient extends BaseJdbcClient` 覆写 `toColumnMapping/buildSql`。**duckdb 454 行即跑通**。

**新非 JDBC 连接器（example-http 路线）**：实现 Metadata+SplitManager+RecordSetProvider 三件套挂进 Guice Module；需要向量化/复杂谓词时再换 `ConnectorPageSourceProvider`。
