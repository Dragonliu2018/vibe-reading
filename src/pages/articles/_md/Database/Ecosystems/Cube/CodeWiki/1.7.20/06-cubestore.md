---
source:
  type: "源码解读"
  project: "Cube"
  url: "https://github.com/cube-js/cube"
title: "CubeStore 存储"
date: "2026-08-17T22:20:51+08:00"
category: [Database, Ecosystems, Cube, CodeWiki, "1.7.20"]
tags: ["Cube", "Rust", "OLAP", "Parquet", "列式存储", "分布式"]
description: "Rust 分布式 OLAP 存储引擎"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/00-overview)

---

## 模块定位

CubeStore 是 Cube.js 的分布式 OLAP 存储引擎，用 Rust 编写（191 文件、114,085 行），专门用于存放和查询**预聚合（pre-aggregation）数据**。它替代了传统关系数据库作为预聚合存储层的角色，为 API 请求提供亚秒级延迟与高并发能力。

在整体架构中 CubeStore 位于存储层：query-orchestrator 的预聚合加载逻辑把构建好的预聚合表写入 CubeStore，查询命中预聚合时从 CubeStore 读取；同时它兼任 query-orchestrator 的 `cacheDriver` 和 `queueDriver`（当 `externalDbType === 'cubestore'` 时 `skipExternalCacheAndQueue: true`）。它通过 `cubejs-cubestore-driver`（WebSocket + FlatBuffers）被 TS 侧驱动解析器选中，与 CubeSQL/Tesseract 不直接相连——后者只生成 SQL 字符串，执行由 orchestrator 的 driver 负责。

**为什么自研而非用 ClickHouse 等现有 OLAP**（`README.md:16-35`）：

1. 高基数 rollup（10 亿+行）性能问题
2. 缺少原生 HyperLogLog 支持——CubeStore 内建 `cubehll`、`cubedatasketches`、`cubezetasketch` 三个 crate
3. 大 `UNION ALL` 查询性能差（多分区预聚合合并场景）
4. 跨 rollup 表 JOIN 性能差
5. 不同数据库的 schema 名长度限制和 SQL 类型差异

结论：用现有数据库修这些问题需要侵入式修改其代码库，不如自研专为预聚合设计的存储。

---

## 模块架构

CubeStore 是一个 Cargo workspace，主实现集中在 `cubestore` crate，辅以若干基础设施 crate：

```
rust/cubestore/
├── cubestore/          # 主实现（分布式存储、查询执行、API）
│   ├── src/
│   │   ├── metastore/  # Table/Partition/Chunk/WAL + MetaStore trait + RocksMetaStore
│   │   ├── store/      # ChunkStore 存储引擎 + Compaction + WAL
│   │   ├── table/      # ParquetTableStore 列式落盘 + data.rs Arrow builder
│   │   ├── cluster/    # Router-Worker 集群 + WorkerPool + Transport
│   │   ├── queryplanner/ # QueryPlanner + QueryExecutor（基于 DataFusion）
│   │   ├── import/     # ImportService CSV/流式导入
│   │   ├── streaming/  # Kafka 流式导入
│   │   ├── sql/        # SqlService + CubeStoreParser
│   │   ├── http/       # warp WebSocket 端点 /ws
│   │   ├── mysql/      # MySQL 协议兼容接口
│   │   ├── remotefs/   # S3/GCS/MinIO/Local 远程文件系统
│   │   └── config/     # ConfigObj + Injector 依赖注入
│   └── src/bin/cubestored.rs  # 主入口
├── cuberpc/            # #[cuberpc::service] 宏，自动生成 RPC client/server/transport
├── cuberockstore/      # RocksDB 封装
├── cubehll/            # HyperLogLog 近似去重
├── cubedatasketches/   # Theta Sketch 近似去重
└── cubezetasketch/     # ZetaSketch 近似去重
```

核心组件协作关系：

```
                ┌──────────────────────────────────────────────┐
                │              SqlService (sql/mod.rs)           │
                │   CubeStoreParser 解析 SQL → AST → 调度执行      │
                └───────┬──────────────────────┬─────────────────┘
                        │                      │
        ┌───────────────▼──────────┐  ┌────────▼──────────────────┐
        │   ImportService          │  │   QueryPlanner             │
        │   CSV/流式 → Arrow 列式   │  │   SqlToRel → LogicalPlan   │
        │   (import/mod.rs)        │  │   → DataFusion optimize     │
        └───────────────┬──────────┘  └────────┬──────────────────┘
                        │                      │
                ┌───────▼────────────────────────▼───────────────┐
                │            ChunkStore (store/mod.rs)            │
                │   partition_data / get_chunk_columns / chunk_exec │
                │   memory_chunks: RwLock<HashMap<String, RecordBatch>> │
                └───────┬──────────────────────┬──────────────────┘
                        │                      │
        ┌───────────────▼──────────┐  ┌────────▼──────────────────┐
        │   MetaStore trait        │  │   Cluster trait             │
        │   RocksMetaStore (RocksDB)│  │   Router-Worker 路由        │
        │   Schema/Table/Partition/│  │   node_name_by_partition    │
        │   Chunk/Index/Job        │  │   WorkerPool 子进程池        │
        └──────────────────────────┘  └─────────────┬──────────────┘
                                                    │
                                          ┌─────────▼──────────┐
                                          │   RemoteFs          │
                                          │   S3 / GCS / MinIO   │
                                          │   / Local            │
                                          └────────────────────┘

  外部入口：HttpServer (warp, /ws WebSocket) ← TS cubestore-driver
            MySqlServer (MySQL 协议)
            cubestored.rs (bin 主入口)
```

**设计主线**：所有服务用 `Arc<dyn Trait>` 抽象 + `Injector` 依赖注入容器组装，`#[cuberpc::service]` 宏从 trait 自动生成可本地也可远程调用的 RPC 层（MetaStore 既能在 Router 本地用 `RocksMetaStore`，也能在 Worker 用 `MetaStoreRpcClient` 远程调用 Router）。查询执行基于 DataFusion，存储基于 Arrow/Parquet 列式 + RocksDB 元数据，集群采用 Router-Worker 分离 + 一致性哈希分片。

---

## 调用链路

### 写入预聚合数据（导入 → 分区 → 列式存储）

```
TS cubestore-driver
  │ WebSocket (FlatBuffers) /ws
  ▼
HttpServer (http/mod.rs:47) — warp 框架
  │ 解析 FlatBuffers → SqlQueryContext
  │ SqlService.exec_query_with_context (sql/mod.rs:781)
  ▼
SqlServiceImpl — CubeStoreParser 解析 SQL
  ├── CREATE TABLE → MetaStore.create_table → RocksDB 存储 Table/Index 元数据
  └── INSERT / CREATE TABLE ... FILES [...] → ImportService.import_table
        ▼
ImportServiceImpl.do_import (import/mod.rs:756)
  │ 1. resolve_location: 下载 HTTP/temp:// 文件到本地
  │ 2. CsvLineStream: 逐行流式读取 CSV（支持 gzip、引号跨行）
  │ 3. CsvImportParser: header 映射 → column position
  │ 4. 按行写入 ArrayBuilder（Arrow 列式 builder）
  │ 5. 达到 wal_split_threshold 或 size_threshold 时切分 batch
  ▼
Ingestion.queue_data_frame (import/mod.rs:1042)
  │ spawn 异步任务 →
  ▼
ChunkStore.partition_data (store/mod.rs:424)
  │ 1. 获取 table 的所有 Index
  │ 2. build_index_chunks: 对每个 index 执行
  ▼
ChunkStore.partition_rows_for_index (store/mod.rs:2669)
  │ 1. 获取 index 的 active partitions
  │ 2. 按 sort key 排序所有行 (RowConverter + sort_unstable_by)
  │ 3. 对每个 partition，按 min/max 范围筛选行
  │ 4. 写入 Parquet 文件 或 内存 RecordBatch
  ├── in_memory=true → ChunkStore.memory_chunks (RwLock<HashMap>)
  └── in_memory=false → ParquetTableStore → ArrowWriter 写 .parquet
        ▼
RemoteFs.upload_file (remotefs/mod.rs:62)
  │ QueueRemoteFs → S3RemoteFs / GCSRemoteFs / MinIORemoteFs / LocalDirRemoteFs
  ▼
MetaStore.activate_chunks — chunk.active = true → 可查询
  ▼ (compaction 触发条件满足时)
CompactionService.compact (store/compaction.rs:64)
  │ 合并多个小 chunk → 大 Parquet 文件
  │ 分裂过大 partition → 两个子 partition
```

### 查询预聚合数据（接收查询 → 定位分区 → 执行 → 返回）

```
TS cubestore-driver
  │ WebSocket /ws，HttpQuery { sql, parameters, responseFormat }
  ▼
HttpServer (http/mod.rs)
  │ 解析 FlatBuffers → SqlQueryContext
  │ SqlService.exec_query_with_context
  ▼
SqlServiceImpl.exec_query_with_context (sql/mod.rs:781)
  │ CubeStoreParser 解析 SQL → AST
  ▼
QueryPlannerImpl.logical_plan (queryplanner/mod.rs:139)
  │ 1. execution_context() → DataFusion SessionContext
  │ 2. MetaStoreSchemaProvider: 从 MetaStore 加载所有表 schema
  │ 3. SqlToRel.statement_to_plan → DataFusion LogicalPlan
  │ 4. state.optimize() → 优化（分区裁剪、谓词下推、rolling 优化等）
  │ 5. 返回 QueryPlan::Select(PreSerializedPlan, workers)
  ▼
SqlServiceImpl (sql/mod.rs:1349)
  │ if workers.is_empty(): QueryExecutor.execute_router_plan(plan, cluster) ← 本地
  │ else: 随机选一个 worker 作为 main
  │   Cluster.route_select(&workers[i], plan) ← 分布式
  ▼
ClusterImpl.route_select (cluster/mod.rs:551)
  │ send_or_process_locally(node_name, NetworkMessage::RouterSelect(plan))
  │   ├── 本地节点 → process_message_on_worker
  │   └── 远程节点 → ClusterTransport.connect_to_worker → TCP 发送
  ▼
QueryExecutorImpl.execute_router_plan (queryplanner/query_executor.rs:173)
  │ router_plan() → 物理计划
  │   ├── 扫描分区/chunk 的 Parquet 文件
  │   ├── ClusterSendExec: 将子计划分发到各 worker
  │   └── SortPreservingMergeExec: 合并各 worker 的有序结果
  ▼
ClusterImpl.run_select (cluster/mod.rs:566)
  │ for each worker with partitions:
  │   send NetworkMessage::Select(worker_plan, params) → TCP
  ▼
QueryExecutorImpl.execute_worker_plan (queryplanner/query_executor.rs:189)
  │ worker_plan() → 物理计划（Parquet 扫描 + 内存 chunk 扫描 + 聚合 + 排序）
  │ collect(physical_plan) → Vec<RecordBatch>
  ▼
返回：Worker RecordBatch → 序列化 → TCP → Router 合并
     → SerializedRecordBatchStream → FlatBuffers → WebSocket → TS
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `exec_query_with_context` | `sql/mod.rs:781` | SQL 执行主入口 |
| `logical_plan` | `queryplanner/mod.rs:139` | SQL AST → DataFusion LogicalPlan + 优化 |
| `execute_router_plan` | `queryplanner/query_executor.rs:173` | Router 物理计划执行（含 ClusterSendExec 分发） |
| `execute_worker_plan` | `queryplanner/query_executor.rs:189` | Worker 物理计划执行（Parquet/内存扫描+聚合） |
| `route_select` | `cluster/mod.rs:551` | 分发查询到 worker 节点 |
| `node_name_by_partition` | `cluster/mod.rs:2236` | 一致性哈希：分区 → worker 映射 |
| `partition_data` | `store/mod.rs:424` | Arrow 行数据 → 分区 → chunk |
| `partition_rows_for_index` | `store/mod.rs:2669` | 按 sort key 排序 + 按 partition min/max 切分 |
| `activate_chunks` | `metastore` (MetaStore trait) | chunk 上传完成后激活为可查询 |
| `compact` | `store/compaction.rs:64` | 合并小 chunk + 分裂大 partition |
| `import_table` / `do_import` | `import/mod.rs:756` | CSV/文件流式导入 |
| `warmup_partition` | `cluster` (Cluster trait) | 预下载 Parquet 到 worker 本地 |

</details>

---

## 核心实现

### Table / Partition / Chunk 三级数据模型

CubeStore 的数据组织分三级，对应预聚合的不同生命周期阶段：

```rust title="rust/cubestore/cubestore/src/metastore/table.rs:133"
pub struct Table {
    table_name: String,
    schema_id: u64,
    columns: Vec<Column>,
    locations: Option<Vec<String>>,          // CSV/数据文件 URL
    import_format: Option<ImportFormat>,     // CSV / CSVNoHeader / CSVOptions
    has_data: bool,
    is_ready: bool,
    created_at: Option<DateTime<Utc>>,
    build_range_end: Option<DateTime<Utc>>,
    seal_at: Option<DateTime<Utc>>,
    sealed: bool,
    select_statement: Option<String>,        // SQL SELECT 物化
    source_columns: Option<Vec<Column>>,
    stream_offset: Option<StreamOffset>,     // Earliest / Latest（Kafka 流式导入）
    unique_key_column_indices: Option<Vec<u64>>,
    aggregate_column_indices: Vec<AggregateColumnIndex>,
    seq_column_index: Option<u64>,           // 非 None 时启用 in-memory ingest
    partition_split_threshold: Option<u64>,
}
```

`Table` 同时承载四种数据来源：外部文件导入（`locations` + `import_format`）、流式导入（`stream_offset`）、SQL SELECT 物化（`select_statement`）、内存写入（`seq_column_index`）。`sealed` 控制表是否可继续写入——compaction 完成后旧 partition 被 seal。

```rust title="rust/cubestore/cubestore/src/metastore/mod.rs:729"
pub struct Partition {
    index_id: u64,
    parent_partition_id: Option<u64>,    // 分裂后的父子关系
    multi_partition_id: Option<u64>,     // 跨 index 的逻辑分区
    min_value: Option<Row>,              // 分区键下界
    max_value: Option<Row>,              // 分区键上界
    active: bool,                        // 是否活跃（可写入）
    warmed_up: bool,                     // 是否已预热到 worker
    main_table_row_count: u64,
    suffix: Option<String>,              // 文件名后缀，避免冲突
    file_size: Option<u64>,
    min: Option<Row>,                    // 实际数据最小值
    max: Option<Row>,                    // 实际数据最大值
}
```

`Partition` 按 index 的 sort key 范围划分。`active=false` 表示分区已 sealed（compaction 后），不再接受新数据。`suffix` 是随机 8 字符，使分区文件名唯一，避免并发写入冲突。`parent_partition_id` 记录分区分裂的谱系。

```rust title="rust/cubestore/cubestore/src/metastore/mod.rs:758"
pub struct Chunk {
    partition_id: u64,
    row_count: u64,
    uploaded: bool,        // Parquet 文件已上传到 RemoteFs
    active: bool,          // 已激活（可查询）
    in_memory: bool,       // 内存 chunk（未持久化为 Parquet）
    created_at: Option<DateTime<Utc>>,
    oldest_insert_at: Option<DateTime<Utc>>,
    deactivated_at: Option<DateTime<Utc>>,
    suffix: Option<String>,
    file_size: Option<u64>,
    replay_handle_id: Option<u64>,    // 幂等重放句柄
    min: Option<Row>,
    max: Option<Row>,
}
```

`Chunk` 是最小的数据管理单元。`in_memory=true` 的 chunk 存于 worker 内存的 `RwLock<HashMap<String, RecordBatch>>`（`ChunkStore.memory_chunks`），用于近期热数据的低延迟写入；compaction 时合并落盘为 Parquet。`uploaded` 与 `active` 分离——chunk 先上传到 RemoteFs（`uploaded=true`），再经 `activate_chunks` 激活（`active=true`），保证查询不会看到未完整的数据。

**设计决策 why**：三级模型把"逻辑表 → 分区 → 物理块"解耦。Table 描述逻辑 schema 与数据来源；Partition 按 sort key 范围切分使查询能做分区裁剪；Chunk 是实际 I/O 单位，内存 chunk 服务热数据、Parquet chunk 服务冷数据。`active`/`sealed` 等状态字段让 compaction 与查询并发进行——已 sealed 的 partition 仍可被查询（`include_inactive` 参数控制），新数据写入新 active partition，实现读写不互斥。

### 列式存储与分区裁剪

预聚合数据本质是按维度分组的聚合结果，天然适合列式存储。导入时直接构建列式数据，避免行转列开销：

```rust title="rust/cubestore/cubestore/src/store/mod.rs:2669 (partition_rows_for_index)"
// 1. 获取 index 的 active partitions
// 2. 按 sort key 排序所有行 (RowConverter + sort_unstable_by)
// 3. 对每个 partition，按 min/max 范围筛选行
// 4. 写入 Parquet 文件 或 内存 RecordBatch
```

`partition_rows_for_index` 用 `RowConverter` 把 Arrow 数组转为可排序的 `Row`，`sort_unstable_by` 按 index 的 sort key 排序后按 `min_value`/`max_value` 切分行到不同分区。每个 Index 定义 sort key（维度列），数据按 sort key 排序后存入 Parquet。

查询时利用 Parquet 的 row group 统计信息（min/max）进行分区裁剪——`queryplanner/partition_filter.rs` 在 DataFusion 优化阶段根据查询谓词排除不相关的分区/chunk，避免全表扫描。`partition_split_threshold`（`config/mod.rs:393`，默认行数阈值）控制分区大小，使单分区数据量适中——太小则 compaction 频繁，太大则裁剪粒度粗。

**设计决策 why**：列式 + 排序 + 分区裁剪三者配合服务预聚合低延迟。预聚合查询通常带维度过滤（如"某时间段某地区"），按 sort key 排序的 Parquet 让 row group 统计信息能有效裁剪；列式存储只读取查询涉及的列，减少 I/O。内存 chunk（`in_memory=true`）用于近期热数据，避免 Parquet 文件 I/O 延迟——这是写入后立即可查的关键，compaction 异步落盘不阻塞查询。

### Router-Worker 集群与一致性哈希

CubeStore 集群采用 Router-Worker 分离架构：

```rust title="rust/cubestore/cubestore/src/cluster/mod.rs:89 (Cluster trait)"
pub trait Cluster: DIService + Send + Sync {
    async fn route_select(&self, node_name: &str, plan: SerializedPlan)
        -> Result<(SchemaRef, Vec<SerializedRecordBatchStream>), CubeError>;
    async fn run_select(&self, node_name: &str, plan: SerializedPlan, worker_planning_params: WorkerPlanningParams)
        -> Result<Vec<RecordBatch>, CubeError>;
    fn node_name_by_partition(&self, p: &IdRow<Partition>) -> String;
    async fn warmup_partition(&self, partition: IdRow<Partition>, chunks: Vec<IdRow<Chunk>>) -> Result<(), CubeError>;
    async fn schedule_repartition(&self, p: &IdRow<Partition>) -> Result<(), CubeError>;
    // ...
}
```

`node_name_by_partition`（`cluster/mod.rs:2236`）使用一致性哈希——`DefaultHasher` 对 partition id 或 `multi_partition_id` 哈希后取模，将分区稳定映射到 worker 节点，保证同一分区总是路由到同一 worker。worker 扩缩容时只影响部分分区，最小化数据迁移。

Router 节点 fork 多个 select worker 子进程（`cluster/worker_pool.rs:34` `WorkerPool`），通过 IPC channel 通信。子进程隔离查询执行，单个查询 panic 不影响主进程——`async_try_with_catch_unwind` 捕获 panic 转为 `CubeError`。`warmup_partition` 提前下载 Parquet 文件到 worker 本地，避免查询时远程下载。

`send_or_process_locally`（`cluster/mod.rs:1918`）是本地路由优化：当 `node_name == server_name` 时直接本地处理，不走网络——单节点部署下零开销。

**节点角色判断**：`is_select_worker()`（`cluster/mod.rs:1276`）——若 `select_workers` 配置为空或设置了 `worker_bind_address`，当前节点是 select worker；否则是 router。Router 监听 metastore 端口和 HTTP/MySQL 端口；Worker 监听 worker 端口。

**设计决策 why**：Router/Worker 分离让元数据管理（Router 的 RocksMetaStore）与数据扫描（Worker 的 Parquet 读取）各司其职。一致性哈希保证分区路由稳定，避免查询时跨节点拉数据。子进程隔离是 Rust 查询引擎的容错底线——DataFusion 的 UDF/plan 可能在某些输入下 panic，子进程模型让故障不扩散。注意 CubeStore **不使用 Raft 共识**：元数据一致性通过 RocksDB WAL + snapshot 机制保证（`metastore/rocks_store.rs`），worker 的 MetaStore 通过 RPC 访问 router 的 `RocksMetaStore`，是"主从"模式而非"多主复制"。

### WAL 与导入幂等

写入先记 WAL 于 RocksDB，再异步 partition 为 chunk 并上传 Parquet：

```rust title="rust/cubestore/cubestore/src/metastore/mod.rs:789"
pub struct WAL {
    table_id: u64,
    row_count: u64,
    uploaded: bool,
}
```

`WALStore`（`store/mod.rs:198`）负责 WAL 的创建和后续 partition 操作。WAL 未 `uploaded` 时可用于恢复——节点崩溃后重启能从 RocksDB 中的 WAL 重建未完成的写入。

`replay_handle_id`（`Chunk` 结构字段）用于幂等重放：导入失败后可按 replay handle 恢复，避免重复写入。`Ingestion.queue_data_frame`（`import/mod.rs:1042`）将每个 batch 的 partition + upload 作为独立异步任务（`JoinHandle`），`wait_completion` 等待所有完成——单个 batch 失败不影响其他 batch。

`activate_chunks` 是最后一步且关键：chunk 先上传到 RemoteFs（`uploaded=true`），再激活（`active=true`），保证查询不会看到未完整的数据。MetaStore 操作通过 RocksDB 事务保证原子性。

**设计决策 why**：预聚合刷新是 Cube.js 的后台批处理，失败重试是常态。WAL + replay_handle_id 让导入幂等——同一批数据重试不会产生重复 chunk。`uploaded`/`active` 两阶段激活避免"部分上传"的 chunk 被查询读到不一致状态。RocksDB 作为元数据存储兼顾持久性（WAL）与高性能（LSM-tree），比外部数据库少一次网络跳。

### cuberpc 宏与依赖注入

CubeStore 最具特色的工程实践是 `#[cuberpc::service]` 宏——从 trait 定义自动生成全部 RPC 基础设施：

```rust title="rust/cubestore/cubestore/src/metastore/mod.rs:811"
#[cuberpc::service(trace_guard = crate::trace::metastore_trace_guard)]
pub trait MetaStore: DIService + Send + Sync {
    async fn create_schema(&self, schema_name: String, if_not_exists: bool) -> Result<IdRow<Schema>, CubeError>;
    async fn create_table(&self, schema_name: String, table_name: String, columns: Vec<Column>, ...) -> Result<IdRow<Table>, CubeError>;
    async fn get_table_by_id(&self, id: u64) -> Result<IdRow<Table>, CubeError>;
    async fn get_active_partitions_by_index_id(&self, index_id: u64) -> Result<Vec<IdRow<Partition>>, CubeError>;
    async fn get_chunks_by_partition(&self, partition_id: u64, include_inactive: bool) -> Result<Vec<IdRow<Chunk>>, CubeError>;
    async fn activate_chunks(&self, table_id: u64, chunk_ids: Vec<(u64, Option<u64>)>, snapshot: Option<u64>) -> Result<(), CubeError>;
    // ... ~80+ 方法，管理 Schema/Table/Partition/Chunk/Index/Job 的全生命周期
}
```

宏（`cuberpc/src/lib.rs:10`）自动生成：
- `MetaStoreRpcMethodCall` / `MetaStoreRpcMethodResult` 枚举（serde 序列化）
- `MetaStoreRpcClient`（客户端代理：trait 方法 → 枚举 → transport.invoke_method → 枚举 → 结果）
- `MetaStoreRpcServer`（服务端分发：枚举 → 调用实际 trait 方法 → 枚举）
- `TracedMetaStore`（带 trace 守卫的装饰器，通过 `trace_guard = path` 参数）

这让 MetaStore 可以本地调用（Router 用 `RocksMetaStore`），也可以远程调用（Worker 用 `MetaStoreRpcClient` + TCP 访问 Router）——同一 trait 两种部署形态，零手写序列化代码。`MetaStore` 有 80+ 方法，全部由宏自动生成 RPC 层。

依赖注入由自定义 `Injector` 容器实现：

```rust title="rust/cubestore/cubestore/src/config/injection.rs:10"
pub struct Injector {
    services: RwLock<HashMap<String, Arc<dyn DIService>>>,
    factories: RwLock<HashMap<String, Box<dyn Fn(Arc<Injector>) -> Pin<Box<dyn Future<Output = Arc<dyn DIService>>> + Send>> + Send + Sync>>>,
}
```

通过 `register_typed` 注册工厂函数，`get_service_typed` 按类型解析（懒初始化 + `Mutex` 防止并发重复初始化）。所有服务用 `Arc<dyn Trait>` 抽象，`di_service!` 宏注册实现类。`Traced` 装饰器（`cuberpc/src/lib.rs:169` `traced_decorator`）包裹服务，每个方法调用前后自动持有 trace guard，实现可观测性。

**设计决策 why**：CubeStore 是分布式系统，服务可能本地调用也可能跨节点。cuberpc 宏把"trait 定义"作为 single source of truth，自动生成两种形态的绑定，避免手写序列化/反序列化/分发代码的重复与错误。Injector 容器让服务组装声明式化——`configure_injector()` 注册所有工厂，按需懒初始化。`Traced` 装饰器与业务逻辑解耦，可观测性统一注入。这套机制让 CubeStore 的 80+ MetaStore 方法 + 多种服务实现的可维护性可控。

---

## 设计模式

| 模式 | 代码位置 | 为什么用 |
|------|----------|----------|
| **列式存储** | `table/parquet.rs`, `store/mod.rs` | 数据以 Arrow 列式格式存储，落盘为 Parquet。`ArrayBuilder` 直接在导入时构建列式数据，避免行转列开销 |
| **分区/分片** | `metastore/partition.rs`, `store/mod.rs:2669` | 按 index sort key 范围分区。`partition_rows_for_index` 用 `RowConverter` 排序后按 `min_value`/`max_value` 切分行到不同分区 |
| **一致性哈希分片** | `cluster/mod.rs:2236` `node_name_by_partition` / `pick_worker_by_ids` | 用 `DefaultHasher` 对 partition id 哈希后取模选择 worker，保证同一分区稳定路由到同一 worker，扩缩容只影响部分分区 |
| **WAL（Write-Ahead Log）** | `metastore/wal.rs`, `store/mod.rs:198` `WALStore` | 写入先记 WAL 于 RocksDB，再异步 partition 为 chunk 并上传 Parquet。WAL 未 uploaded 时可用于恢复 |
| **依赖注入** | `config/injection.rs` `Injector` | 自定义 DI 容器，`register_typed` 注册工厂，`get_service_typed` 懒初始化。`di_service!` 宏注册实现类 |
| **RPC 代码生成** | `cuberpc/src/lib.rs` `#[cuberpc::service]` 宏 | 从 trait 定义自动生成 MethodCall/MethodResult 枚举、RpcClient、RpcServer、Traced 装饰器。serde 序列化 + TCP 传输 |
| **Worker Pool（子进程池）** | `cluster/worker_pool.rs:34` `WorkerPool` | Router fork 多个 select worker 子进程，通过 IPC channel 通信。隔离查询执行，防 panic 影响主进程 |
| **装饰器（Traced）** | `cuberpc/src/lib.rs:169` `traced_decorator` | `TracedMetaStore` 包裹 `Arc<dyn MetaStore>`，每个方法调用前后自动持有 trace guard |
| **Compaction** | `store/compaction.rs:63` `CompactionService` | 合并小 chunk 为大 Parquet 文件；分裂过大 partition。按 chunks_count_threshold / total_size_threshold / in_memory_size_threshold 触发 |
| **查询缓存** | `queryplanner/providers/query_cache.rs`, `sql/cache.rs` `SqlResultCache` | SELECT 结果按 SQL + context 缓存，避免重复计算 |
| **流式导入** | `streaming/` 模块, `import/mod.rs:923` | Kafka 流式数据通过 `StreamingService.stream_table` 持续导入，`stream_offset` 控制起始位置 |

---

## 模块间交互

**与 TS query-orchestrator**：通过 `cubejs-cubestore-driver` 以 WebSocket + FlatBuffers 通信。TS 端 `packages/cubejs-cubestore-driver/src/CubeStoreDriver.ts` 通过 `WebSocketConnection`（`ws://host:3030/ws`）连接；Rust 端 `http/mod.rs` `HttpServer` 使用 `warp` 框架提供 WebSocket 端点。协议用 `cubeshared::codegen` 中的 FlatBuffers schema（`HttpMessage`、`HttpQuery`、`HttpQueryResult`、`HttpRow`）。TS driver 作为 `DriverInterface` 实现，被 Cube.js 通过 `CUBEJS_EXT_DB_TYPE=cubestore` 驱动解析。另有 Rust 版 ws-transport 客户端（`rust/cube/cubestore-ws-transport/src/lib.rs`）供 Rust 原生客户端连接。

**与 CubeSQL / Tesseract**：CubeStore 不直接依赖 CubeSQL/Tesseract。后者生成的是 SQL 字符串 + 参数，返回给 TS orchestrator，由 TS 的 driver（`cubejs-cubestore-driver` 等）发给 CubeStore。两者通过 WebSocket 协议解耦。

**CubeStore 内部 Router ↔ Worker**：TCP + cuberpc 序列化。`cluster/transport.rs:60` `ClusterTransportImpl` 使用 `TcpStream::connect` 连接 worker；消息格式为 `NetworkMessage`（`cluster/message.rs`）枚举，含 `Select` / `RouterSelect` / `SelectResult` 等变体，serde 序列化后通过 TCP 传输。本地路由优化 `send_or_process_locally` 当 `node_name == server_name` 时直接本地处理。

**MetaStore 远程访问**：配置 `CUBESTORE_META_ADDR` 时，worker 节点通过 `MetaStoreTransportImpl`（`cluster/transport.rs:109`）远程调用 router 的 MetaStore。`ClusterMetaStoreClient`（`cluster/mod.rs:2169`）是 MetaStore 的远程代理。Router 本地用 `RocksMetaStore`（基于 RocksDB）。

---

## 扩展方式

### 新增一种数据类型

需改文件：
1. `metastore/mod.rs` — `ColumnType` 枚举添加变体
2. `table/data.rs` — `append_value()` / `create_array_builders()` 添加新类型的 Arrow builder 逻辑
3. `import/mod.rs` — `ImportFormat::parse_column_value_str()` 添加 CSV 解析逻辑
4. `sql/mod.rs` — SQL 类型映射（`GenericTypeToCubeStore` 对应的 Rust 端逻辑）
5. `table/parquet.rs` — `arrow_schema()` 添加 Arrow DataType 映射
6. `queryplanner/mod.rs` — 如果新类型需要特殊 UDF 处理

### 修改分区策略

需改文件：
1. `metastore/partition.rs` — `Partition::new()` 修改分区创建逻辑
2. `store/mod.rs:2669` — `partition_rows_for_index()` 修改行分配到分区的逻辑（当前按 sort key 范围）
3. `store/compaction.rs` — `split_multi_partition()` 修改分区分裂策略
4. `config/mod.rs:393` — `partition_split_threshold()` 调整阈值
5. `queryplanner/partition_filter.rs` — 如果分区策略影响裁剪逻辑

### 调整复制因子 / worker 路由策略

需改文件：
1. `cluster/mod.rs:2236` — `node_name_by_partition()` / `pick_worker_by_ids()` 修改 worker 选择算法（当前简单哈希取模，改为带复制因子需引入多 worker 映射）
2. `cluster/mod.rs:202` — `ClusterImpl` 添加 replication factor 字段
3. `config/mod.rs:464` — `select_workers()` 配置
4. `cluster/worker_pool.rs:34` — `WorkerPool` 如需调整子进程池大小
5. `store/mod.rs:767` — `warmup_partition()` 如需预热到多个副本
