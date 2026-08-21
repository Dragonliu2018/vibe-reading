---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "扩展系统"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "SPI", "扩展", "Deep Storage", "Guice"]
description: "Druid 扩展系统——DruidModule + ServiceLoader 加载、Deep/Metadata storage SPI、Jackson @JsonSubTypes 多态、Guice Multibinder 注册、代表性扩展。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（SPI 定义散于 `processing/.../segment/loading/`、`indexing-service/.../metadata/`、`server/.../guice/`，实现于 `extensions-core/` 与 `extensions-contrib/`）是 Druid 的**可插拔后端与扩展点**：Deep storage、Metadata storage、InputSource、聚合、安全、流摄入等均以 SPI 形式实现。职责边界：**让 core 只依赖契约，扩展按需加载**；具体扩展（S3/MySQL/Kafka…）不进 core。

## 模块架构

```
启动：druid.extensions.loadList / directory
  → ExtensionLoader 扫描扩展 jar → ServiceLoader(DruidModule) 发现
  → ExtensionInjectorBuilder 注册扩展 module（覆盖层）
运行时：core 注入 SPI 接口实现
  Deep Storage：DataSegmentPusher / Mover / Killer / Archiver + SegmentizerFactory
  Metadata：MetadataStorageConnector / SQLMetadataStorageActionHandler
  Jackson 多态：@JsonSubTypes（InputSource/InputFormat/Task/AggregatorFactory/Rule...）
  Guice Multibinder：@JsonTypeRegistration / Set<...> 注入扩展
```

扩展实现 core 的 SPI 接口，运行时 core 经 Guice 注入获取实现——core 不感知具体后端。

## 调用链路

```
启动：ServerInjectorBuilder → ExtensionInjectorBuilder
  → ExtensionLoader.loadExtensions（druid.extensions.directory 扫描 jar）
    → ServiceLoader.load(DruidModule.class) → 各扩展 *DruidModule.configure(Binder)
      → DruidBinders 注册 Jackson subtype + 绑定 SPI 实现
运行时（以 deep storage push 为例）：
  TaskToolboxFactory（注入 DataSegmentPusher）→ task 持有 pusher
    → Appenderator.push → IndexMerger.merge → DataSegmentPusher.push（如 S3DataSegmentPusher）
  读取：SegmentizerFactory.factorize（从 LoadSpec 下载并加载 segment）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DruidModule.configure` | 注册扩展 binding | 统一注册点 |
| `ExtensionLoader.loadExtensions` | 扫描加载扩展 jar | `druid.extensions.loadList` |
| `DataSegmentPusher.push` | 推 segment 到 deep storage | 目录约定 `dataSource/interval/version/partitionNum` |
| `MetadataStorageConnector` | 元数据读写 | 各 DB 实现 |
| `SegmentizerFactory.factorize` | 从磁盘加载 segment | 配合 LoadSpec |

</details>

## 核心实现

### DruidModule + ServiceLoader 加载

`DruidModule` 是扩展的核心接口，扩展写一个实现类并配 `META-INF/services/org.apache.druid.initialization.DruidModule`（ServiceLoader 注册文件）。启动时 `ExtensionLoader`（`processing/.../initialization/`）按 `druid.extensions.directory` 扫描扩展 jar、`druid.extensions.loadList` 指定加载哪些，`ServiceLoader.load(DruidModule.class)` 发现各 `*DruidModule`，`ExtensionInjectorBuilder` 把它们注册为 injector 覆盖层。`DruidModule.configure(Binder)` 是统一注册点：绑 SPI 实现 + 经 `DruidBinders` 注册 Jackson subtype。**独立 jar 扩展**避免 core 膨胀、按需加载、各扩展依赖隔离。

### Deep storage SPI

`processing/.../segment/loading/` 定义一组 `@ExtensionPoint`：`DataSegmentPusher`（push segment 文件到 deep storage，`push(File, DataSegment, boolean)` + `makeLoadSpec(URI)`）、`DataSegmentMover`（迁移）、`DataSegmentKiller`（删除，`kill`/`killAll`）、`DataSegmentArchiver`（归档/恢复）、`SegmentizerFactory`（从磁盘加载生成 `Segment`）。`DataSegmentPusher.getDefaultStorageDir()`（`DataSegmentPusher.java:91`）定的 `dataSource/interval/version/partitionNum/` 目录结构是跨实现标准约定，killer 依赖它清理。`LoadSpec` 配合 `SegmentizerFactory` 决定从哪个后端下载。

### Metadata storage SPI

`processing/.../metadata/MetadataStorageConnector.java` 是元数据存储 SPI，`server/.../metadata/SQLMetadataConnector.java` 是 SQL 抽象基类，`indexing-service/.../metadata/SQLMetadataStorageActionHandler.java` + `MetadataStorageActionHandlerFactory` 是 action handler。`server/.../guice/SQLMetadataStorageDruidModule.java` 是各 SQL metadata 扩展的基类 module，`LocalDataStorageDruidModule` 是默认 deep storage。Deep storage 存 segment 文件、metadata storage 存元数据表——两者 SPI 边界清晰。

### Jackson subtype 多态

Druid 大量用 Jackson `@JsonSubTypes` + `@JsonTypeRegistration` 实现多态反序列化：`InputSource`/`InputFormat`/`Task`/`AggregatorFactory`/`Rule`/`SupervisorSpec`/`StageProcessor`/`ShuffleSpec` 等按 `type` 字段反序列化具体类。扩展经 Guice Multibinder 注入自定义 subtype，core 运行时按 JSON type 拿到实现类。这是 Druid 扩展性的另一支柱——不止 Guice binding，序列化层也多态可扩展。

### 代表性扩展

- **Deep storage（S3）**：`extensions-core/s3-extensions/` 的 `S3DataSegmentPusher`（实现 `DataSegmentPusher`）、`S3StorageDruidModule`（注册）、`S3InputSourceDruidModule`（`InputSource`）、`S3StorageConnectorModule`（输出 connector）。ServiceLoader 文件含三个 module 类。
- **Metadata（MySQL）**：`extensions-core/mysql-metadata-storage/` 的 `MySQLMetadataStorageModule` + `MySQLConnector`（继承 `SQLMetadataConnector`），实现 `MetadataStorageConnector`。
- **流摄入（Kafka）**：`extensions-core/kafka-indexing-service/` 的 `KafkaIndexTaskModule`（`org.apache.druid.indexing.kafka.KafkaIndexTaskModule`），提供 `KafkaSupervisor`/`KafkaIndexTask`/`KafkaRecordSupplier`。
- **聚合（datasketches）**：`extensions-core/datasketches/` 提供近似聚合的 `AggregatorFactory`。

`TaskToolboxFactory`（`indexing-service/.../common/TaskToolboxFactory.java`）在运行时把 `DataSegmentPusher` 等 SPI 实现注入给 task——task 无需感知具体后端。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| SPI | `DataSegmentPusher`/`MetadataStorageConnector`（`@ExtensionPoint`） | 后端可插拔 |
| 插件加载器 | `ExtensionLoader` + ServiceLoader | 按需加载独立 jar |
| Multibinder | `DruidBinders` + `@JsonTypeRegistration` | 统一注册扩展点 |
| 策略 | 各 SPI 多实现 | 后端可换 |
| 工厂 | `SegmentizerFactory`/`MetadataStorageActionHandlerFactory` | 按需创建 |

## 模块间交互

扩展实现 `processing`（deep storage SPI）/`indexing-service`（metadata SPI）的接口；运行时 core 经 Guice 注入获取实现。`MSQ`/`摄入` 也经 Jackson subtype 扩展 `StageProcessor`/`InputSource`。扩展不反向依赖具体业务模块。

## 扩展方式

- **新增 deep storage**（仿 s3）：实现 `DataSegmentPusher`/`Killer`/`Mover`/`Archiver` + `LoadSpec`/`SegmentizerFactory`，遵守 `getDefaultStorageDir()` 目录约定，写 `*DruidModule` 配 `META-INF/services` 注册，`druid.extensions.loadList` 启用。
- **新增 metadata storage**：实现 `MetadataStorageConnector`（或继承 `SQLMetadataConnector`）+ `SQLMetadataStorageDruidModule` 子类 + SQL schema 初始化，注册 binding。
- **新增 aggregation extension**：实现 `AggregatorFactory` + `Aggregator`/`BufferAggregator`，`@JsonSubTypes` 注册，Guice 绑定 factory；参考 `extensions-core/datasketches/`。
