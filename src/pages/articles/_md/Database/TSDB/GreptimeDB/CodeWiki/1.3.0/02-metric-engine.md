---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "metric-engine 引擎"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "metric-engine", "TSID", "多路复用"]
description: "metric-engine——mito2 之上的 metrics 专用多路复用引擎：metadata region + data region 分离、TSID 聚合、auto-partition 与逻辑/物理表映射。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`metric-engine`（`src/metric-engine/`，~1.3 万行）面向 metrics 场景的专用引擎，实现 `RegionEngine` trait，在 `mito2` 之上做 metric 专用分层。`lib.rs` 文档注释明确称自己为"multiplexer over the Mito engine"——多个逻辑 region 复用同一组物理 region（data + metadata），通过 `__table_id` 列区分数据归属。它解决 Prometheus 等 metrics 场景的海量小表问题：如果每个 metric 都有独立 region，元数据开销远大于数据本身。

## 模块架构

`MetricEngine`（`engine.rs:131`）是对 `MetricEngineInner`（`engine.rs:584`）的 `Arc` 包装。Inner 持有：`MitoEngine` clone（共享底层存储引擎）、`MetadataRegion`（`metadata_region.rs:71`，元信息 KV 存储 + moka LRU cache）、`DataRegion`（`data_region.rs:42`，对 mito2 的薄封装）、`MetricEngineState`（`engine/state.rs:98`，逻辑/物理 region 映射，`Arc<RwLock<>>`）、`RowModifier`（行改写）、`RepeatedTask`（周期 flush metadata region）。

`MetricEngineState` 维护三张表：`physical_regions`（物理 region → 物理列 schema + 逻辑 region 集合）、`logical_regions`（逻辑 → 物理 region id）、`logical_columns`（逻辑 region → 列 metadata）。`MetadataRegion` 以 KV 形式存元信息：`__region_<ID>` 标记存在性，`__column_<ID>_<BASE64_NAME>` 存列 schema，用 moka cache（128MB / 5min TTL）避免频繁扫 mito。

## 调用链路

**写入（put）**：`MetricEngine::handle_request`（`engine.rs:232`）→ `put_region`（`put.rs:44`）。判断是物理 region 直接拒写（`ForbiddenPhysicalWriteSnafu`，`put.rs:52`，保护 `__table_id` 隔离）；逻辑 region 走 `put_logical_region`（`put.rs:425`）：① `find_data_region_meta`（`put.rs:501`）查物理→data region id + 编码方式；② `verify_rows`（`put.rs:531`）校验列存在/类型 + `fill_missing_field_column` 补齐缺失 field 列；③ `modify_rows`（`put.rs:734`）经 `RowModifier` 改写——Sparse 编码把所有 tag 编进 `__primary_key` binary（table_id + tsid + tag values），Dense 追加 `__table_id`/`__tsid` 列，`TsidGenerator` 对 tag value 做 FxHash 生成 tsid；④ `data_region.write_data`（`data_region.rs:194`）→ `mito.handle_request`。批量写 `put_regions_batch`（`put.rs:73`）按物理 region 分组合并减少 RPC。

**查询（read）**：`handle_query`（`engine.rs:328`）→ `read_region`（`read.rs:36`）。逻辑读走 `read_logical_region`（`read.rs:69`）：① `get_physical_region_id`；② `transform_request`（`read.rs:141`）做 projection 转换（逻辑列索引→物理列索引）+ 注入 `__table_id = logical_region_id.table_id()` 过滤；③ `mito.handle_query`；④ scanner 标记 logical region 做列裁剪。关键：metadata region 只存 KV 元数据，**不参与数据查询**——数据全在 data region，靠 `__table_id` 过滤实现逻辑隔离。

**创建（create）**：`handle_batch_ddl_requests`（`engine.rs:170`）→ `create_regions`（`create.rs:62`）。物理表创建（`create.rs:123`）：`transform_region_id` 拆出 data_region_id + metadata_region_id，建 metadata region（ts/key/val 三列，TTL=forever）+ data region（tag 列变 nullable，加 `__table_id` 带 BloomFilter skipping index + `__tsid` 列，设 memtable=bulk/sst_format=flat/compaction=twcs），注册到 state。逻辑表创建（`create.rs:203`）：`extract_new_columns` 找新列→`data_region.add_columns`→`metadata_region.add_logical_regions` 写 KV→更新 state。

## 核心实现

### 逻辑/物理表分离与多路复用

拆分动机（`engine.rs:70-101` doc）：metrics 场景海量小表，独立 region 元数据开销 > 数据。data region 是一张"宽"物理表存所有逻辑表数据，靠 `__table_id`/`__tsid` 区分；metadata region 用 KV 存列映射，添加新逻辑表/列不必 alter 物理表 schema（除非物理表缺该列）。metadata region TTL=forever（`create.rs:647`），data region 可独立设 TTL/compaction。

### TSID 生成

`TsidGenerator`（`row_modifier.rs:228`）对 tag value 做 FxHash 聚集同组 tag 数据到同一主键。先对 tag **name** 排序后 hash（`label_name_hash`，`row_modifier.rs:323`）确保不同列顺序产生相同 TSID；再对 tag **value** hash；null tag 忽略（`row_modifier.rs:183`），确保 `a=A,b=B,c=null` 与 `a=A,b=B` 产生相同 TSID。

### Sparse vs Dense 主键编码

`set_data_region_options`（`options.rs:63`）默认 `primary_key_encoding=sparse`。Sparse（`row_modifier.rs:72`）把 tag 编进 `__primary_key` binary，适合 tag 稀疏多变的场景；Dense 保留原 tag 列 + 追加 `__table_id`/`__tsid`，适合所有逻辑表 tag 一致的密集场景。配合 `memtable.type=bulk` + `sst_format=flat`。

### `__table_id` Skipping Index

`__table_id` 是逻辑查询的关键过滤列，为其配 BloomFilter skipping index（granularity=1024, fpr=0.01，`create.rs:560`），SST 扫描时快速跳过不含目标 table_id 的 data block，大幅减少 IO。

### 操作权限矩阵

逻辑 region 允许 Create/Drop/Write/Read/Alter(AddColumns)；物理 region 仅允许 Create/Drop(仅当无逻辑 region)/Read/Alter(options)，**禁止直接写**（破坏隔离）。Drop 物理 region force=true 可绕过（`engine.rs` test test_drop_region）。

### metadata region 定期 flush

`FlushMetadataRegionTask`（`repeated_task.rs:32`）每 `flush_metadata_region_interval`（默认 30s）对所有非 Follower 物理表的 metadata region 发 flush，避免故障恢复时重放过多 WAL 条目。Follower 跳过（`repeated_task.rs:59`），只 Leader 执行。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 代理/装饰器 | `MetadataRegion`/`DataRegion` 持 `mito: MitoEngine`（`metadata_region.rs:72`） | 不重写存储，在 mito2 之上分层代理 |
| 多路复用 | `lib.rs:16-20` doc | 多逻辑 region 复用物理 region，`__table_id` 区分 |
| 后台任务调度 | `RepeatedTask` + `FlushMetadataRegionTask`（`engine.rs:504`） | 周期 flush metadata region |
| 读写锁 + Cache | `moka` LRU + `CacheAccessLockRegistry`（`metadata_region.rs:487`） | 写时失效、读时填充 |

## 模块间交互

完全构建在 mito2 之上，不直接操作文件或 WAL——所有底层存储委托 `mito.handle_request`/`mito.scan_to_stream`。被 `datanode`（`src/datanode/src/datanode.rs:533` 构造、`:544` 注册）、`RegionServer`（`region_server.rs:651` 调 `put_regions_batch`）调用。与 meta-srv 协作：region 迁移（`meta-srv/src/procedure/region_migration.rs`）、repartition（`procedure/repartition/dispatch.rs` 识别 `METRIC_ENGINE_NAME`）、心跳同步（`heartbeat/handler/sync_region.rs:65`）都需同时处理 data + metadata region。`RegionId` 的 group 字段区分 data/metadata region（`METRIC_DATA_REGION_GROUP`/`METRIC_METADATA_REGION_GROUP`，`utils.rs:29`）。

## 扩展方式

- **新增 index 类型**：`engine/options.rs` `IndexOptions` enum 加 variant，`data_region.rs:95` `assemble_alter_request` 的 match 加分支，`options.rs` `PhysicalRegionOptions::try_from` 解析。
- **改 auto-partition 策略**：`create.rs:203` `create_logical_regions` 的 `parse_physical_region_id`（当前从 option 读物理 region id）改为按规则计算，`put.rs:425`/`read.rs:69` 适配多物理 region 路由，`state.rs` 的 `logical_regions` 映射改为一对多。

> 注：rollup / continuous aggregation 功能在当前代码中未见实现（`repeated_task.rs` 仅 `FlushMetadataRegionTask`），可能属后续版本规划。
