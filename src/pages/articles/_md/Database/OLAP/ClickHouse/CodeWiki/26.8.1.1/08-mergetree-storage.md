---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "MergeTree 存储引擎"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "MergeTree", "data part", "merge", "mutation"]
description: "ClickHouse MergeTree 存储引擎源码解读——不可变 data part、后台 merge、mutation 改写、副本与 ZK 队列协调。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Storages/MergeTree/` 是 ClickHouse 最大也最核心的存储引擎（`src/Storages/` 共 40 万行）。MergeTree 家族以"不可变 data part + 后台合并"为基本范式：写入产生新 part，查询扫描多 part，后台 merge 合并小 part，mutation 改写生成新 part。它独立成模块因为存储引擎通过 `IStorage` 接口与查询引擎解耦——引擎内部如何组织 part、如何 merge，对上层透明。

## 模块架构

```text
src/Storages/
  ├─ IStorage.h                ── 表引擎抽象接口（read/write/alter/optimize）
  ├─ StorageFactory.h/.cpp     ── 表引擎工厂（注册 MergeTree/ReplicatedMergeTree/...）
  ├─ StorageMergeTree.h        ── 单机 MergeTree
  ├─ StorageReplicatedMergeTree.h ── 副本 MergeTree（ZK 队列协调）
  └─ MergeTree/
     ├─ MergeTreeData.h        ── MergeTreeData 基类（data_parts_indexes 双索引）
     ├─ IMergeTreeDataPart.h   ── data part 抽象（不可变存储单元）
     ├─ MergeTreeDataMergerMutator.h ── 合并与 mutation 调度（协程式 MergeTask）
     ├─ MergeTreeSelectProcessor.h ── 读取（ReadFromMergeTree）
     ├─ MergeTreeDataPartType.h    ── part 格式（Wide/Compact/InMemory）
     ├─ MergeTreeDataPartChecksum.h── part 校验
     └─ IMergeTreeReader.h / IMergedBlockOutputStream.h ── 读写流
```

`MergeTreeData` 是基类，`StorageMergeTree` 与 `StorageReplicatedMergeTree` 是两个具体 `IStorage` 实现。part 管理、合并、读取逻辑在 `MergeTreeData` 中共享，副本只在写入与 merge 协调层加 ZK。

## 调用链路

写入路径：
```text
InterpreterInsertQuery::execute → IStorage::write(res, context)
  └─ MergeTreeData::write(partitions, context)   ── 按 partition 分发
     └─ MergeTreeDataWriter::writeTempBlock → 生成 IMergeTreeDataPart
        ├─ 列式编码（按 granule 组织）
        ├─ CompressionCodec 按块压缩
        └─ 原子提交（rename 临时目录到正式名）→ data_parts_indexes 更新
```

读取路径：
```text
ReadFromMergeTree（IProcessor）→ selectRangesToRead
  └─ MergeTreeDataSelectExecutor::readFromParts
     └─ 按 partition/part/granule 范围选择，建 MergeTreeSelectProcessor
        └─ IMergeTreeReader::readRows → 解压 → 组装 Block
```

合并路径：
```text
MergeTreeDataMergerMutator::selectPartsToMerge → MergeTask（协程多阶段）
  └─ 合并选中 part → IMergedBlockOutputStream → 新 part → 原子替换旧 part
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MergeTreeData::write` | 写入产生新 part | 原子提交 |
| `MergeTreeDataMergerMutator::selectPartsToMerge` | 选 merge 候选 | 按 size 策略 |
| `IMergeTreeDataPart::loadIndex` | 加载 part 索引 | granule 级 |
| `ReadFromMergeTree` in `Storages/MergeTree` | 读取 processor | 并行 part 读取 |
| `IStorage::read` | 查询接口 | 返回 QueryPipeline |

</details>

## 核心实现

### 不可变 data part 与 granule

`IMergeTreeDataPart`（`src/Storages/MergeTree/IMergeTreeDataPart.h`）是不可变存储单元，按 partition 组织，每个 part 含各列的压缩数据文件 + mark 索引 + 元数据。**granule**（颗粒，默认 8192 行）是列式数据的最小索引单位——mark 索引记录每个 granule 在压缩文件中的偏移，读取时可按 granule 范围跳跃。part 格式有 Wide（每列单独文件）、Compact（所有列合并一文件）、InMemory（内存）。

```cpp title="src/Storages/MergeTree/MergeTreeData.h"
class MergeTreeData : public IStorage {
    using DataParts = std::set<MergeTreeDataPartPtr>;
    boost::multi_index_container parts_index;   // 双索引
    // TagByInfo: 按 partition_id→min_block→max_block→level→mutation 排序
    // TagByStateAndInfo: 按 (state, info) 排序，快速取某状态 parts
    shared_parts_list;        // 只读 Active parts 缓存（共享锁下安全）
};
```

`data_parts_indexes` 用 `boost::multi_index_container` 提供双索引：`TagByInfo` 按 part info 排序用于范围查找，`TagByStateAndInfo` 按 `(state, info)` 排序用于快速取某状态 parts（Active/Outdated），状态转换用 `modify()` 只改索引位置 O(log n) 不移动元素。`shared_parts_list` 缓存只读 Active parts 列表，共享锁下安全使用避免每次 SELECT 复制。

### 后台合并：MergeTask 协程

`MergeTreeDataMergerMutator`（`src/Storages/MergeTree/MergeTreeDataMergerMutator.h`）周期性 `selectPartsToMerge` 选若干小 part，合并生成新 part 替换旧 part（原子切换）。合并用协程式多阶段 `MergeTask`——这是为了支持暂停/恢复（如内存压力大时让出），合并大 part 时不阻塞。

**为什么 merge 异步**：写入只追加新 part 不改旧 part，查询可扫描所有 part；merge 在后台慢慢合并优化布局，不阻塞读写。merge 让 part 数稳定、提升查询效率（少 part 少随机读）。

### Mutation：不就地改写

`ALTER UPDATE/DELETE` 不就地修改 part，而是生成 mutation 任务，为涉及的 part 生成新 part（只含修改列），替换旧 part。`MutationContext`（`src/Storages/MergeTree/MergeTreeMutationStatus.h`）跟踪 mutation 进度。这是不可变 part 设计的必然——改写不就地，生成新 part。

### 副本：ZK 日志队列协调

`StorageReplicatedMergeTree`（`src/Storages/StorageReplicatedMergeTree.h`）通过 ZooKeeper/Keeper 日志队列协调副本。写入把 part 元数据写入 ZK 队列，各副本拉取并在本地生成相同 part。merge 任务同样经 ZK 队列分配，保证所有副本 merge 出 byte-identical 的结果——因为 merge 是确定性的（相同输入+相同算法=相同输出），副本只需协调"merge 哪些 part"，各自独立执行即可得到一致结果。

### Patch Parts 与 PartLoadingTree

`MergeTreePartInfo::Kind::Patch`（`MergeTreePartInfo.h:30`）是轻量级更新——patch part 只含被更新列，读取时 `getPatchesForPart`（`MergeTreeData.h:606`）动态叠加到原 part，避免小更新生成完整新 part。`PartLoadingTree`（`MergeTreeData.h:1885`）利用 part `contains()` 关系构建层级，启动加载时顶层 part 完好则停止（覆盖子 part），损坏则递归加载子 part，最大化加载效率。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `StorageMergeTree`/`StorageReplicatedMergeTree` | 不同 MergeTree 变体 |
| 不可变 + COW | `IMergeTreeDataPart` | part 不改写，merge 生成新 part |
| 协程 | `MergeTask` 多阶段 | 支持暂停/恢复，大合并不阻塞 |
| 双索引 | `data_parts_indexes` multi_index | 按状态/按 info 两种查找 |
| WAL 已移除 | — | data part 原子性替代 WAL |

## 重要设计决策

### 为什么用 data part 而非 page/extent

part 是列式压缩的不可变单元，天然适合列式存储与压缩；追加写入不阻塞读；merge 可优化布局。granule 级 mark 索引让读取可跳跃，按列扫描只读相关列。

### merge 为什么是后台异步

写入只追加不阻塞，查询扫所有 part；merge 在后台慢慢合并减 part 数提效率。副本只需经 ZK 协调"merge 哪些 part"，各自独立执行得 byte-identical 结果（merge 确定性）。

## 扩展方式

新增 MergeTree 变体：继承 `MergeTreeData`（共享 part 管理/合并逻辑），在 `StorageFactory` 注册。修改 part 格式：在 `MergeTreeDataPartType::Value` 加枚举，`MergeTreeDataPartBuilder::build` 按类型建对应 part 实现，`choosePartFormat`（`MergeTreeData.h:342`）加选择逻辑。新增 merge 调度策略：改 `MergeTreeDataMergerMutator::selectPartsToMerge` 的 size 策略。

## 模块间交互

依赖 `Processors`（`ReadFromMergeTree` 是 processor，参与拉模型 DAG）、`IO`/`Disks`（落盘，`IDisk` 抽象本地/S3）、`Coordination`（ZooKeeper 副本协调）、`Access`（行策略）。被 `Interpreters` 通过 `IStorage` 接口调用——`InterpreterSelectQuery` 调 `IStorage::read` 得 QueryPipeline，`InterpreterInsertQuery` 调 `IStorage::write`。`DatabaseCatalog`（`DatabaseCatalog::instance()`）管理所有表的元数据与生命周期。
