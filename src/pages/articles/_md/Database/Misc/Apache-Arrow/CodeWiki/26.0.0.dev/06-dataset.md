---
source:
  type: "源码解读"
  project: "Apache Arrow"
  url: "https://github.com/apache/arrow"
title: "Dataset API"
date: "2026-08-21T10:31:12+08:00"
category: [Database, Misc, Apache Arrow, CodeWiki, "26.0.0.dev"]
tags: ["Apache Arrow", "C++", "Dataset", "谓词下推"]
description: "Arrow Dataset API——三层编排架构（发现/抽象/执行），Scanner 编译 Acero 计划，谓词/投影/分区下推减少 I/O"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/Apache-Arrow/CodeWiki/26.0.0.dev/00-overview)

---

## 模块定位

`cpp/src/arrow/dataset/`（~24k 行）是 Arrow 的**顶层数据访问编排者**。它把"一组分区的文件（Parquet/IPC/CSV/JSON）+ 一个 filter + 一个 projection"统一成一次扫描，输出 `Table`。核心价值是**解耦**：上层只关心"要什么数据"，下层各文件格式只关心"怎么读自己"，Dataset 用 Scanner 把两者编译成一个 Acero 执行计划，并尽可能把 filter/projection 下推到文件 reader 以减少 I/O。它是数据湖查询的入口模式。

## 模块架构

```
┌─────────── 发现层（discovery.h）────────────┐
│  DatasetFactory → FileSystemDatasetFactory  │ 从文件系统发现文件
│    └─ 推断 schema、构建分区信息             │
└──────────────────┬──────────────────────────-┘
                   │ 产出
┌──────────────────▼──────────────────────────┐
│  Dataset (dataset.h)                          │ 抽象数据集
│   └─ Fragment (dataset.h)  一个可扫描单元    │
│        ├─ ParquetFileFragment (file_parquet.h)│
│        ├─ IpcFileFragment / CsvFileFragment  │
│   FileFormat (file_base.h)  策略：怎么读     │
│   Partitioning (partition.h)  Hive/Directory │
│   EvolutionStrategy  schema 演化（补 null/重映射）│
└──────────────────┬──────────────────────────-┘
                   │ 由 Scanner 驱动
┌──────────────────▼──────────────────────────┐
│  Scanner (scanner.h)  ScanOptions+ScannerBuilder│
│   AsyncScanner (scanner.cc)                  │
│    └─ 构建 Acero ExecPlan: scan→filter→project→sink│
│         ├─ V1: SourceNode + AsyncGenerator    │
│         └─ V2: ScanNode (Acero ExecNode)      │
└──────────────────────────────────────────────-┘
```

## 调用链路

`Scanner::ToTable()` 的完整流程：

```
Scanner::ToTable()                         scanner.h
  └─ AsyncScanner::ToTableAsync()          scanner.cc
       └─ ScanBatchesUnorderedAsync()
            └─ 构建 Acero Declaration::Sequence
                 {"scan", "filter", "augmented_project", "sink"}
            └─ plan->StartProducing()
                 └─ scan 节点 / ScanNode 驱动 Fragment 扫描
                      └─ Fragment::ScanBatchesAsync
                           └─ ParquetFileFragment: ReadRowGroup + 下推 filter/projection
                                └─ parquet::arrow::FileReader 按 RowGroup 统计过滤
                           └─ 输出 ExecBatch (含 ArrayData)
                 └─ filter/project 节点 (MapNode) 用 compute 处理
                 └─ sink 节点聚合 → Table::FromRecordBatches
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `Scanner::ToTable` (`scanner.h`) | 同步取整表 | 内部异步转同步 |
| `AsyncScanner::ToTableAsync` (`scanner.cc`) | 异步取表 | 构建 Acero plan |
| `DatasetFactory::Finish` (`discovery.h`) | 发现文件建 Dataset | 推断 schema + 分区 |
| `Fragment::ScanBatchesAsync` (`dataset.h`) | 扫描一个文件 | 各 FileFormat 实现 |
| `ParquetFileFormat::ScanBatchesAsync` (`file_parquet.cc`) | 扫 Parquet | RowGroup 统计过滤 + 列裁剪 |
| `Partitioning::Unify`/`Parse` (`partition.h`) | 解析分区值 | Hive/Directory 方案 |
| `Initialize` (`plan.h`) | 注册 scan 节点工厂 | 到 Acero registry |
</details>

## 核心实现

### Dataset/Fragment/FileFormat 抽象

`Dataset`（`dataset.h`）是数据集抽象，`Fragment` 是其中"一个可扫描单元"（通常一个文件或文件的一段），`FileFormat`（`file_base.h`）是"怎么读这种文件"的策略。三者分离让"数据在哪"（Fragment）、"格式是什么"（FileFormat）、"整体是什么"（Dataset）独立变化——新增格式只需实现 `FileFormat`/`FileFragment`，不影响 Dataset 与 Scanner。`FileSystemDataset`（`file_base.cc`）是常见实现，`ParquetFileFormat`（`file_parquet.h`）是最完整的范例。`EvolutionStrategy`（`dataset.cc:344` 的 `BasicFragmentEvolution`）处理 schema 演化（列缺失补 null、列重映射）。

### 谓词与投影下推

`ScanOptions`（`scanner.h`）带 `filter`（`compute::Expression`）和 `projection`。**下推策略**：filter 尽可能下推到文件 reader，避免读出全量再过滤。对 Parquet，`ParquetFileFormat::ScanBatchesAsync`（`file_parquet.cc`）把 filter 拆解为：①RowGroup 级统计过滤（用 min/max 跳过整个 RowGroup），②Page 级谓词（`PageReader::set_data_page_filter`，跳过 min/max 不满足的 page），③列裁剪（只读投影用到的列），④读出后的 compute filter。`compute::Expression::SimplifyWithGuarantee` 用分区信息简化 filter（如目录 `year=2024` 让 `year=2024` 谓词在该分区恒真）。**为什么下推**：把计算下推到读数据的地方，I/O 是分析负载最贵的环节，少读一列/跳过一个 page 直接省磁盘+网络带宽。

### 分区裁剪

`Partitioning`（`partition.h`）抽象分区方案：`HivePartitioning`（Hive 风格 `key=value` 目录）、`DirectoryPartitioning`（按位置）。扫描时 `Fragment` 携带分区值，Scanner 用它做**分区裁剪**——filter 引用分区列时，先按分区目录跳过整批文件，无需打开。`SchemaManifest`（`arrow/schema.h:106`，Parquet 侧）维护列索引到字段的映射。`DatasetFactory` 发现文件时同时构建分区信息。

### 两代扫描路径

Dataset 有两代扫描实现：**V1**（`scanner.cc` 的 `AsyncScanner`）用 `SourceNode`+`AsyncGenerator`，scanner 管理数据流；**V2**（`scan_node.cc` 的 `ScanNode`）是 Acero `ExecNode`，深度集成 Acero 调度（`AsyncTaskScheduler`），让扫描与执行统一在一个调度框架。V2 是演进方向——把"scanner 管流"升级为"scan 节点即 Acero 节点"，更好地利用 Acero 的并行/背压。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Builder | `ScannerBuilder`（`scanner.h`） | 链式配置 ScanOptions |
| Strategy | `FileFormat`/`Partitioning`（`file_base.h`/`partition.h`） | 格式/分区方案可替换 |
| Adapter | `Fragment` 适配不同文件格式到统一 scan | 多格式统一接口 |
| Layered | 发现/抽象/执行三层 | 各层职责独立，可单独替换 |

## 模块间交互

依赖 **acero**（`Scanner` 构建 `ExecPlan`，`SourceNode`/`ScanNode` 是 Acero 节点）、**parquet/ipc/csv/json**（各 `FileFormat` 调对应 reader）、**compute**（filter/projection 是 `Expression`，下推用 `SimplifyWithGuarantee`）、**io/filesystem**（`FileSource` 持文件路径 + `FileSystem`）、**核心类型**（`RecordBatch`/`ChunkedArray`/`Table`）。是高层编排者——把低层能力组合成"扫描数据集"用例。被用户代码或 DataFusion 直接调用。

## 扩展方式

- **支持新文件格式**：实现 `FileFormat` 子类（`file_base.h`）的 `ScanBatchesAsync`/`Inspect`，实现 `FileFragment` 的 `ReadRowGroup`/`SplitRowGroups`，在 `plan.h` 的 `Initialize()` 注册工厂。下推靠实现 reader 的 `GetReadRanges`/`set_data_page_filter`（Parquet 范例见 `file_parquet.cc`）。测试 `dataset/*_test.cc`。
- **自定义分区方案**：继承 `Partitioning`（`partition.h`）实现 `Parse`/`Unify`，在 `DatasetFactory` 构建时传入。
- **schema 演化扩展**：继承 `BasicFragmentSelection`（`dataset.cc:331`）扩展 `FragmentSelection` 携带类型转换/alias 映射，参考 `BasicFragmentEvolution`（`dataset.cc:344`）。
