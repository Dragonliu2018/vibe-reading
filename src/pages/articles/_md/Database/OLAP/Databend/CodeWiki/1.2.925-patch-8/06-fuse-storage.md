---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "存储引擎"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "Parquet", "MVCC", "Fuse"]
description: "Databend Fuse 存储引擎——Snapshot/Segment/Block 三层 Parquet 段存储 + Copy-on-Write 快照 MVCC + 两阶段裁剪。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

Fuse 存储引擎（`src/query/storages/fuse/` ~57.6k 行 + `src/query/storages/common/` ~31k 行）是 Databend 的**原生存储引擎**。它基于 **Parquet 列式段存储 + 三层元数据（Snapshot→Segment→Block）+ MVCC 快照版本控制 + 对象存储（S3）**，实现了 Copy-on-Write 并发控制、Time Travel、两阶段裁剪和后台 merge/compact。它是 Databend 存算分离架构的核心——数据持久化完全依赖对象存储，计算节点无本地状态。

## 模块架构

Fuse 引擎围绕 `FuseTable`（表抽象）和三层元数据组织。读路径沿 Snapshot→Segment→Block 逐层裁剪减少 IO；写路径追加 Parquet 块后经 Copy-on-Write 生成新快照，乐观锁提交。

```
FuseTable
├── TableSnapshot (第一层) ── segments: Vec<Location>
│   └── SegmentInfo (第二层) ── blocks: Vec<BlockMeta>
│       └── BlockMeta (第三层) ── location → Parquet 数据块
│
├── 读路径: read_partitions → 裁剪(Segment/Block) → read_data → Parquet
└── 写路径: append_data → SerializeBlock(Parquet) → commit → CAS 新 Snapshot
```

## 调用链路

**读路径**（`fuse_table.rs:962` `read_partitions` → `read_data`）：

```
read_partitions()                              [fuse_table.rs:962]
└── do_read_partitions_with_reusable_pruned_metas()
    ├── read_table_snapshot()                 → TableSnapshot (对象存储)
    └── prune_snapshot_blocks()               [read_partitions.rs:460]
        ├── SegmentPruner::pruning()          — 段级 range 裁剪
        └── BlockPruner::pruning()             — 块级 range+bloom+inverted+vector 裁剪

read_data()                                    [fuse_table.rs:992]
└── build_block_reader() → build_fuse_source_pipeline()
    └── 从对象存储读 Parquet → DeserializeDataTransform → DataBlock
```

**写路径**（`fuse_table.rs:1003` `append_data` → `commit_insertion`）：

```
append_data()                                 [fuse_table.rs:1003]
└── TransformSerializeBlock::try_create()     → 序列化 Parquet 块写对象存储

commit_insertion()                            [fuse_table.rs:1023]
└── do_commit()                               [commit.rs:81]
    ├── AppendGenerator::new()                — 从前快照克隆(CoW)
    ├── snapshot.write_meta(operator, loc)    — 写入对象存储
    └── update_table_meta()                    — CAS 更新元服务(MatchSeq::Exact)
```

数据类型变化：读路径 `Location`→`TableSnapshot`→`SegmentInfo`→`BlockMeta`→`Parquet`→`DataBlock`；写路径 `DataBlock`→`Parquet`→`BlockMeta`→`SegmentInfo`→`TableSnapshot`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `FuseTable::read_partitions` | 读路径入口 | 返回 `(PartStatistics, Partitions)` |
| `prune_snapshot_blocks` | 两阶段裁剪 | Segment 级先粗筛减 IO |
| `FuseTable::read_data` | 数据读取 | 向 pipeline 注入 source/transform |
| `FuseTable::append_data` | 写路径入口 | 流式或常规序列化 |
| `FuseTable::commit_insertion` | 提交快照 | CAS 乐观锁，冲突重试 |
| `TableSnapshot::from_previous` | CoW 克隆 | 复制 schema/segments，新 UUID |

</details>

## 核心实现

### 三层元数据结构

**`TableSnapshot`**（第一层，`storages/common/table_meta/src/meta/v1/snapshot.rs:32`）含 `segments: Vec<Location>` 指向段列表，`prev_snapshot_id: Option<(SnapshotId, FormatVersion)>` 形成版本链实现 MVCC：

```rust title="snapshot.rs"
pub struct TableSnapshot {
    pub snapshot_id: SnapshotId,                      // Uuid
    pub prev_snapshot_id: Option<(SnapshotId, FormatVersion)>,  // MVCC 链
    pub schema: dv::DataSchema,                       // Schema Evolution
    pub summary: Statistics,                          // 汇总统计
    pub segments: Vec<Location>,                      // 指向 SegmentInfo 列表
}
```

**`SegmentInfo`**（第二层，`segment.rs:33`）含 `blocks: Vec<Arc<BlockMeta>>` 和段级 `summary: Statistics`。v4 格式引入 `CompactSegmentInfo`，将 block metas 以 `RawBlockMeta` 原始字节存储，仅需要时通过 `block_metas()` 反序列化，减少读取开销。

**`BlockMeta`**（第三层，`segment.rs:45`）含 `location`（Parquet 块路径）、`col_stats`（列统计 min/max/null_count）、`col_metas`、`compression`（Lz4Raw/Zstd/Snappy）。

**为什么三层**：(1) 分层裁剪减少 IO——segment 级统计跳过整段多块，大表（百万 blocks）下指数级减 IO；(2) 管理复杂性——每层元数据大小可控（每 segment ~1000 blocks）；(3) merge/compact 可在 segment 或 block 级别进行。注释（`snapshot.rs:54`）："We rely on background merge tasks to keep merging segments, so that the size of this vector could be kept reasonable"。

### MVCC 与 Copy-on-Write 快照

`TableSnapshot::from_previous`（`snapshot.rs:96`）克隆前一个快照的 schema/segments，替换 segments 列表，生成新 UUID——旧快照通过 `prev_snapshot_id` 链接成版本链。提交时 `update_table_meta`（`commit.rs:237`）用 `MatchSeq::Exact(table_version)` CAS 更新元服务中的快照位置。

```rust title="commit.rs — MVCC 提交冲突处理"
loop {
    snapshot_tobe_committed = TableSnapshot::try_from_previous(latest_snapshot, ...);
    // merge_with_base() 合并 base segments + 并发追加 segments
    match commit_to_meta_server().await {
        Err(TABLE_VERSION_MISMATCHED) => { /* 乐观锁冲突，重试 */ }
        Ok(_) => break,
        Err(other) => return Err(other),
    }
}
```

冲突时 `merge_with_base()`（`commit.rs:361`）合并 base segments 与并发追加的 segments 后重试。Time Travel 通过 `NavigationDescriptor` 遍历 `prev_snapshot_id` 链定位历史版本。

### 两阶段裁剪

**段级裁剪**（`pruning/segment_pruner.rs:52`）：读 `CompactSegmentInfo.summary.col_stats`，用 `RangePruner` 检查 min/max 范围是否与过滤条件相交，不相交跳过整段。**块级裁剪**（`pruning/block_pruner.rs:50`）：对通过段级裁剪的 blocks 用多种 pruner 细粒度裁剪——`RangePruner`（min/max）、`BloomPruner`（布隆过滤器）、`InvertedIndexPruner`（倒排索引）、`VectorIndexPruner`（向量索引）、`SpatialIndexPruner`（空间索引）。

**Lazy Partition**（`fuse_part.rs:147` `FuseLazyPartInfo`）：当 segment 数 > 集群节点数且启用 `distributed_pruning` 时，返回仅含 segment 位置的 `FuseLazyPartInfo`，将裁剪推迟到执行阶段（`do_build_prune_pipeline`），减少协调器负担。

### Parquet 列式存储

存储格式统一到 Parquet（`fuse_type.rs:47`，v1.2.925 已移除 native 格式）。列式存储使 `BlockReader` 的 `Projection` 只反序列化查询涉及的列，大幅减 IO；列式数据同类型连续，压缩率高（Lz4Raw/Zstd/Snappy）。Parquet 是大数据生态标准格式，可被 Spark/Presto 直接读取。

### Compact / Recluster

频繁小写入产生大量小 block，导致元数据膨胀和查询 IO 效率低。`compact.rs` 提供 block 级压缩（`BlockCompactMutator` 合并小块）和 segment 级压缩（`SegmentCompactMutator` 合并段）。`recluster.rs` 基于聚簇键重新组织数据改善局部性（Linear 和 Hilbert 两种）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Copy-on-Write 快照 | `snapshot.rs:96` `from_previous` | 写不改已有数据，支持 MVCC 与 Time Travel |
| MVCC 乐观锁 | `commit.rs:237` `MatchSeq::Exact` | CAS 避免写锁争用，冲突自动重试合并 |
| Table with Options 工厂 | `fuse_table.rs:188` `try_create` | 从 options BTreeMap 类型安全解析配置 |
| 两阶段裁剪 | `segment_pruner.rs` + `block_pruner.rs` | 段级粗筛减 IO，块级细筛 |
| Lazy Partition | `fuse_part.rs:147` `FuseLazyPartInfo` | 分布式裁剪推迟到执行阶段 |

## 模块间交互

Fuse 依赖 `databend-common-storage`（`DataOperator`/OpenDAL 对象存储）、`databend-common-expression`（`TableSchema`/`DataBlock`/`Scalar`）、`databend-common-catalog`（`Table` trait/`PartInfo`）。被 catalog/executor 通过 `Table` trait 调用 `read_partitions`/`read_data`/`append_data`/`commit_insertion`。Fuse 通过 `Pipeline` 构建数据处理管道（`add_transform`/`add_source`/`add_sink`）。

`FuseTable` 通过 `Operator`（OpenDAL）抽象底层存储，`init_operator`（`fuse_table.rs:246`）支持 S3/Azure/GCS/本地等后端，`StorageMetricsLayer` 包装收集 IO 指标。

## 扩展方式

**新增一种存储格式**：在 `fuse_type.rs` 的 `FuseStorageFormat` 枚举添加变体 → 在 `operations/read/` 新增 `DataSource` 实现 → 在 `build_fuse_source_pipeline` 按 `storage_format` 分发 → 在 `io/write/` 新增 `BlockBuilder`。

**修改裁剪逻辑**（新增自定义索引裁剪）：在 `pruning/` 新建 pruner 实现 trait → 在 `fuse_pruner.rs` 的 `PruningContext` 添加字段并初始化 → 在 `block_pruner.rs` 的 `pruning()` 加入裁剪链 → 如需 pipeline 级裁剪在 `pruning_pipeline/` 新增 Transform。
