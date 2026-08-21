---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "Overview"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "时序数据库", "列式压缩"]
description: "TimescaleDB 2.29.2 源码架构解读——基于 PostgreSQL 的高性能时序数据库扩展，hypertable 双层分区模型、CrossModuleFunctions 双许可 ABI 桥、列存压缩引擎、连续聚合与向量化执行内核全解"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 2.29.2 · **协议** Apache 2.0（src/）+ Timescale License（tsl/） · **语言** C（PostgreSQL 扩展） · **代码量** ~88,000 行 · **仓库** [GitHub](https://github.com/timescale/timescaledb)

---

## 总览

### 项目简介

TimescaleDB 是一个 **PostgreSQL 扩展**（extension），为时序数据（time-series）与事件数据提供高性能实时分析能力。它不 fork PostgreSQL 内核，而是以 `shared_preload_libraries` + extension 的方式寄生在标准 PG 之上——所有数据仍是普通 PG 表，所有 SQL/索引/连接器/工具链都兼容，但 TimescaleDB 通过钩子（hook）拦截 DDL 与查询规划，把一张逻辑表（hypertable）拆成按时间分区的多个物理子表（chunk），并叠加列式压缩、连续聚合、向量化执行等时序数据库的标志性能力。

它解决的核心问题：原生 PG 处理时序写入时会遇到单表 B-tree 膨胀、历史数据查询慢、聚合无法增量物化等瓶颈。TimescaleDB 的核心价值是——**在不牺牲 PostgreSQL 事务/SQL 生态的前提下，让时序场景的写入吞吐、压缩率与聚合查询性能接近专用时序数据库**。核心使用场景包括 IoT/传感器监控、金融行情、应用事件、可观测性指标等。

**项目当前边界**：TimescaleDB 负责时序数据的分区、压缩、聚合与后台运维；它**不**是分布式数据库（2.0 起已移除分布式 hypertable/data node 架构，回归单机扩展定位），也不接管存储引擎底层（仍走 PG 的 heap 表 + 自己的列存压缩层）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| Hypertable（逻辑分区表） | `src/hypertable.c` `src/dimension.c` | 按时间/空间维度把表切成 chunk |
| Chunk 自动创建与路由 | `src/chunk.c` `src/chunk_tuple_routing.c` | 插入时按 Point 定位/创建 chunk |
| DDL 透明拦截 | `src/process_utility.c` | CREATE/ALTER/DROP 传播到所有 chunk |
| 查询规划重写 | `src/planner/planner.c` `src/planner/expand_hypertable.c` | 约束排除剪枝 + ChunkAppend 节点 |
| 列存压缩（columnstore） | `tsl/src/compression/` | gorilla/deltadelta/dictionary 等列式算法 + sparse index |
| 连续聚合（Continuous Aggregates） | `tsl/src/continuous_aggs/` | 实时增量物化视图 + 失效日志 |
| 向量化执行 | `tsl/src/nodes/columnar_scan/` `tsl/src/nodes/vector_agg/` | Arrow 批次列处理 + 谓词下推 |
| 后台任务调度 | `src/bgw/` `tsl/src/bgw_policy/` | 压缩/刷新/保留策略自动执行 |
| Chunk 运维 | `tsl/src/chunk_merge.c` `tsl/src/chunk_split.c` `tsl/src/reorder.c` | 合并/拆分/重排 chunk |
| 元数据目录 | `src/ts_catalog/` | 自有 catalog 表 + Scanner 抽象 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| PostgreSQL 16/17/18 | 核心 | 寄生宿主，提供 heap 表、WAL、MVCC、planner/executor 钩子 |
| C（C99） | 核心 | 扩展主体语言，与 PG 内核 C ABI 对接 |
| CMake ≥ 3.15 | 构建 | 多目标构建（loader/apache/tsl 三个 .so） |
| Apache Arrow 列式格式 | 核心 | 列存压缩/向量化执行的内存布局 |
| OpenSSL | 可选 | 远程连接 TLS（`net/`） |
| Python | 测试 | regress/隔离/模糊测试框架 |

## 快速上手

最快看到 TimescaleDB 跑起来的方式是用官方 Docker 镜像（映射到非标准端口 6543 避免与本地 PG 冲突）：

```bash title="启动 TimescaleDB 容器"
docker run -d --name timescaledb \
    -p 6543:5432 \
    -e POSTGRES_PASSWORD=password \
    timescale/timescaledb-ha:pg18
```

连接后验证扩展并创建第一张 hypertable：

```sql title="创建带列存的 hypertable"
SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';

CREATE TABLE sensor_data (
    time TIMESTAMPTZ NOT NULL,
    sensor_id TEXT NOT NULL,
    temperature DOUBLE PRECISION
) WITH (tsdb.hypertable);   -- 2.29 新语法：WITH 子句直接建 hypertable
```

`WITH (tsdb.hypertable)` 是 2.29 引入的建表语法，等价于传统的 `SELECT create_hypertable('sensor_data','time')`。插入数据后用 `time_bucket()` 做时间聚合即可验证端到端可用：

```sql title="按小时分桶聚合"
SELECT time_bucket('1 hour', time) AS hour, sensor_id, AVG(temperature)
FROM sensor_data WHERE time > NOW() - INTERVAL '24 hours'
GROUP BY hour, sensor_id ORDER BY hour DESC LIMIT 20;
```

预期：返回最近 24 小时内每传感器每小时的平均温度。`time_bucket()` 是 TimescaleDB 的核心超函数（hyperfunction），背后由 `src/time_bucket.c` 实现。

---

## 架构设计解析

### 系统架构

TimescaleDB 的架构思想可以一句话概括：**用 PostgreSQL 的钩子机制做"手术式"扩展，而非 fork 内核**。它把自身拆成三个独立 `.so`——loader、apache 主体、TSL 企业模块——通过一张运行时函数指针表（`CrossModuleFunctions`）桥接，既保持 Apache 2.0 开源代码与 Timescale License 企业代码的许可证隔离，又让开源侧能透明调用企业功能。这张"双许可桥"是整个项目最独特的架构决策。

围绕这张桥，代码自上而下分为五层：加载引导层负责在 `shared_preload_libraries` 阶段注册钩子并延迟加载主体；SQL 拦截与规划层通过 `ProcessUtility_hook`/planner hook 接管所有 DDL/DML；核心数据模型层用 hypertable + dimension + chunk + 自有 catalog 表描述分区结构；执行引擎层用一组 PG CustomScan 自定义节点（ChunkAppend、ColumnarScan、VectorAgg 等）替代原生 Append；存储与后台层提供列存压缩、连续聚合与 BGW 调度。

![TimescaleDB 分层架构](/vibe-reading/images/articles/timescaledb-internals/architecture.svg)

分层解决了"如何在不动 PG 内核的前提下叠加时序能力"这个根本问题：每一层都通过标准 PG 扩展点（hook、CustomScan、Background Worker、extension 表）接入，层间靠函数调用或 catalog 表解耦，可独立演进。Apache 与 TSL 的纵向切割则解决了商业模式——开源核心足够建立生态，企业功能（压缩、连续聚合、向量化、chunk 运维）通过 ABI 桥按许可加载，社区版调用时只会命中默认桩并报"license required"。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 加载引导层 | `src/loader/` `src/init.c` | 在 PG 还没有数据库连接的 preload 阶段注册钩子，延迟到首条 SQL 时加载主体 |
| SQL 拦截与规划层 | `src/process_utility.c` `src/planner/` `src/cross_module_fn.c` | 拦截 DDL/DML，把对逻辑表的操作改写为对物理 chunk 的操作，并通过 ABI 桥委托 TSL |
| 核心数据模型层 | `src/hypertable.c` `src/dimension*.c` `src/chunk.c` `src/ts_catalog/` | 描述 hypertable/dimension/chunk 的分区结构与持久化元数据 |
| 执行引擎层 | `src/nodes/` `tsl/src/nodes/` | 用 CustomScan 节点实现并行 chunk 扫描、列存解压、向量化聚合 |
| 存储与后台层 | `tsl/src/compression/` `tsl/src/continuous_aggs/` `src/bgw/` `tsl/src/chunk_*.c` | 列存压缩、增量物化、后台策略调度与 chunk 运维 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 函数指针表（vtable） | `CrossModuleFunctions` in `src/cross_module_fn.h` | Apache 侧定义接口，TSL 侧运行时注入实现，实现许可证隔离的双许可桥 |
| 钩子链（hook chain） | `prev_ProcessUtility_hook` in `src/process_utility.c:108` | 保存前一个 hook 再叠加自身，与其他扩展（pg_partman 等）共存 |
| CustomScan 自定义节点 | `ChunkAppendPath`/`ColumnarScanState`/`VectorAggState` | 复用 PG 执行器框架，注入自定义并行/剪枝/向量化逻辑而不改内核 |
| 对象缓存（pin/release） | `Cache` in `src/cache.h` | hypertable 元数据高频访问，dynahash 缓存 oid→Hypertable，引用计数管理生命周期 |
| 策略模式 | `GroupingPolicy` in `tsl/src/nodes/vector_agg/grouping_policy.h` | 向量化聚合按分组特征选 hash/batch 策略；压缩按列类型选算法 |
| 失效日志（invalidation log） | `tsl/src/continuous_aggs/invalidation.c` | 连续聚合增量刷新：只记录变更范围，避免全量重算 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| Hypertable | 逻辑分区表，用户眼中的"一张表" | 建表时创建，DROP 时删除 | 含 N 个 Dimension，映射到多个 Chunk |
| Dimension | 分区维度（时间=open / 空间=closed） | 随 hypertable 创建 | 属于 Hypertable，切出 DimensionSlice |
| DimensionSlice | 维度上的一个区间 [start, end) | chunk 创建时分配 | 组成 Hypercube，归属于一个 Chunk |
| Chunk | 物理子表（标准 PG 表） | 插入新时间区间时自动创建 | 属于 Hypertable，含一个 Hypercube |
| BgwJob | 后台调度任务 | add_*_policy 时创建 | 关联一个 hypertable，经 ABI 桥执行 |
| ContinuousAgg | 连续聚合（实时物化视图） | CREATE MATERIALIZED VIEW 时创建 | 关联 raw ht + mat ht + watermark |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `CrossModuleFunctions` | `src/cross_module_fn.h:41` | `ts_cm_functions_default`（Apache 桩）/ `tsl_cm_functions`（TSL 实现） | `tsl/src/init.c` 的 `ts_module_init` 把 `ts_cm_functions` 指针切到 `&tsl_cm_functions` |
| `Compressor`（列压缩器接口） | `tsl/src/compression/compression.h:66` | Gorilla/DeltaDelta/Dictionary/Array/Bool/UUID 各一个 | `compression.c:71` 的 `definitions[]` 按算法枚举分发 |
| `CustomScanMethods` | PG 内核 | ChunkAppend/ConstraintAwareAppend/ModifyHypertable/ColumnarScan/VectorAgg/GapFill/SkipScan | 各 `*_init` 中注册到 PG 扩展节点表 |
| `GroupingPolicy` | `tsl/src/nodes/vector_agg/grouping_policy.h` | `GroupingPolicyBatch` / `GroupingPolicyHash` | `vector_agg_begin` 按分组特征选择 |

## 代码目录

```shell
timescaledb/
├── src/                         # Apache 2.0 开源核心（~44k 行 + 子目录）
│   ├── init.c                   # Apache 主体 _PG_init，注册所有钩子
│   ├── loader/                  # timescaledb-loader.so，shared_preload 入口
│   ├── process_utility.c        # DDL 拦截器（6554 行，全库最大）
│   ├── hypertable.c / dimension*.c / chunk.c   # 核心数据模型
│   ├── planner/                 # 查询规划钩子 + hypertable 展开
│   ├── nodes/                   # Apache 自定义执行节点（chunk_append 等）
│   ├── bgw/                     # 后台 worker 调度器
│   ├── ts_catalog/              # 自有元数据 catalog 表 + Scanner 抽象
│   ├── cross_module_fn.c/.h     # 双许可 ABI 桥（函数指针表）
│   └── guc.c                    # ~98 个 GUC 配置项
├── tsl/                         # Timescale License 企业模块（~42k 行）
│   └── src/
│       ├── init.c               # TSL _PG_init，填充 ts_cm_functions
│       ├── compression/         # 列存压缩引擎（26k 行）
│       ├── continuous_aggs/     # 连续聚合（11k 行）
│       ├── nodes/               # 列存扫描/向量化/gapfill/skip_scan 节点
│       ├── bgw_policy/          # 压缩/刷新/保留策略执行
│       └── chunk_merge.c / chunk_split.c / reorder.c   # chunk 运维
├── sql/                         # 扩展 SQL 脚本（建表/函数注册/版本迁移）
└── test/  tsl/test/             # regress + 隔离 + 模糊测试
```

一级目录只有 `src/`（Apache）与 `tsl/`（Timescale License）两个代码根——这个划分本身就是双许可架构的物理体现。`sql/` 与 `test/` 是配套。`src/loader/` 是唯一在 `shared_preload_libraries` 阶段加载的 `.so`，它负责引导后加载另两个主体。

---

## 模块地图

TimescaleDB 的职责分化自然形成 11 个模块，单层组织——模块数由项目客观职责决定，不分层。Apache 侧 7 个（含加载桥、数据模型、DDL、规划、后台、元数据），TSL 侧 4 个（压缩、连续聚合、列存执行、chunk 运维）。它们通过 `CrossModuleFunctions` ABI 桥协作：Apache 侧调用 `ts_cm_functions->func`，运行时指针指向 TSL 实现时走真实逻辑，否则走默认报错桩。

![模块依赖关系](/vibe-reading/images/articles/timescaledb-internals/module-dependencies.svg)

模块间的依赖方向是单向的：上层 SQL/规划模块依赖数据模型与 catalog；执行节点依赖规划器注入与压缩解压；后台调度经 ABI 桥触发 TSL 策略。跨 Apache↔TSL 的调用全部经 `ts_cm_functions` 函数指针表，不存在静态链接。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 扩展加载与双许可桥 | 引导加载、钩子注册、ABI 桥 | `_PG_init` in `src/init.c:88` | 解决双许可证隔离下的运行时绑定 | [01-加载与双许可桥](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/01-loader-and-cross-module-bridge) |
| Hypertable 数据模型 | 逻辑表与维度分区抽象 | `ts_hypertable_create` in `src/hypertable.c:1546` | 时序分区的核心抽象，独立于物理 chunk | [02-Hypertable 数据模型](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/02-hypertable-data-model) |
| Chunk 管理 | 物理 chunk 的查找/创建/路由 | `ts_chunk_find_or_create_for_point` in `src/chunk.c` | 物理分区表有独立的约束/索引/状态生命周期 | [03-Chunk 管理](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/03-chunk-management) |
| DDL 拦截器 | 拦截所有 DDL 适配 hypertable 语义 | `timescaledb_ddl_command_start` in `src/process_utility.c:6350` | PG 不理解 hypertable，必须统一拦截传播到 chunk | [04-DDL 拦截器](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/04-process-utility) |
| 查询规划器与自定义节点 | hypertable 展开与剪枝、自定义 scan | `timescaledb_planner` in `src/planner/planner.c:629` | 查询性能依赖专门的剪枝/并行/向量化节点 | [05-查询规划器](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/05-planner-and-custom-nodes) |
| 后台任务调度 | BGW 调度器与作业执行 | `ts_bgw_scheduler_main` in `src/bgw/scheduler.c:1028` | 压缩/刷新/保留需异步执行，独立调度器协调 worker | [06-后台任务调度](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/06-background-workers) |
| TS Catalog 元数据 | 自有 catalog 表与 Scanner 抽象 | `ts_catalog_get` in `src/ts_catalog/catalog.c:481` | 元数据是所有模块的持久化基座，独立于 PG syscatalog | [07-TS Catalog](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/07-ts-catalog) |
| 压缩引擎 | 列存压缩与 sparse index | `compress_chunk_impl` in `tsl/src/compression/api.c:402` | 列式压缩是商业核心，有独立算法栈与 DML 解压路径 | [08-压缩引擎](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/08-compression-engine) |
| 连续聚合 | 实时增量物化视图 | `process_cagg_viewstmt` in `tsl/src/continuous_aggs/create.c` | 增量刷新+查询重写是独立子系统，依赖失效日志 | [09-连续聚合](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/09-continuous-aggregates) |
| 列存查询执行 | 列存扫描/向量化/gapfill/skip_scan | `columnar_scan_exec_impl` in `tsl/src/nodes/columnar_scan/exec.c:445` | 压缩态查询需专门的向量化执行节点，独立于行存 | [10-列存查询执行](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/10-columnar-scan-and-vectorized-nodes) |
| Chunk 运维操作 | chunk 合并/拆分/重排 | `chunk_merge_chunks` in `tsl/src/chunk_merge.c:1007` | 运维操作复用 heap rewrite，有独立并发控制 | [11-Chunk 运维](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/11-chunk-ops) |

---

## 运行时行为

### 启动流程

TimescaleDB 的启动是三层 `.so` 的接力加载，由 `shared_preload_libraries` 触发：

```
PG 进程启动（shared_preload_libraries = 'timescaledb'）
  └─ 加载 timescaledb-loader.so → loader _PG_init (loader.c:674)
       ├─ 注册 post_parse_analyze_hook（延迟触发点）
       ├─ ts_bgw_cluster_launcher_init()（拉起集群级 BGW launcher）
       └─ 注册 shmem/版本 GUC
  └─ 用户执行首条 SQL → post_parse_analyze_hook (loader.c:492)
       └─ extension_check → do_load (loader.c:736)
            └─ load_external_function("timescaledb-2.29.2.so", "ts_post_load_init")
                 └─ ts_post_load_init (src/init.c:132)
                      └─ ts_license_enable_module_loading()
                           └─ license GUC assign_hook → tsl_module_init (tsl/src/init.c:213)
                                └─ ts_cm_functions = &tsl_cm_functions（指针切换！）
                                └─ Apache _PG_init (src/init.c:88)
                                     ├─ _cache_init / _hypertable_cache_init
                                     ├─ _planner_init / _chunk_append_init
                                     ├─ _process_utility_init（注册 ProcessUtility_hook）
                                     ├─ _guc_init（含 license GUC）
                                     └─ _executor_init
```

对象装配的关键决策：loader 不在 `_PG_init` 加载主体（因为 preload 阶段还没有数据库连接，无法查 `pg_extension`），而是延迟到首条 SQL 解析后触发；TSL 也不在 Apache `_PG_init` 加载（因为并行 worker 可能先于主体加载 TSL 导致链接错误），而是再延迟到 `ts_post_load_init`。三层延迟是规避 PG 生命周期约束的精心设计。`ts_cm_functions` 全局指针初始指向 `ts_cm_functions_default`（全报错桩），TSL 加载后切换到 `&tsl_cm_functions`——这一行赋值就是双许可桥的"合闸"。

### 核心运行流程

下面三条链路覆盖了 TimescaleDB 最核心的运行模式：写入路由、查询剪枝、后台压缩。模块间的动态调用顺序见下，单条链路的状态细节见对应模块文档。

#### 写入：INSERT 逐行路由到 chunk

业务流程：用户 INSERT 一行 → 规划器替换为 ModifyHypertable 节点 → 逐行计算分区 Point → 按维度区间定位/创建 chunk → 若 chunk 已压缩则解压冲突 batch → 写入 → 记录连续聚合失效。

![写入数据流](/vibe-reading/images/articles/timescaledb-internals/data-flow.svg)

文字描述：从 `modify_hypertable_exec.c` 的 `ExecModifyTable` 出发，每行先经 `ts_hyperspace_calculate_point()` 把 TupleTableSlot 转成 N 维 int64 坐标（时间维度经 `ts_time_value_to_internal` 转微秒，空间维度经 `ts_get_partition_hash` 取 hash），再由 `chunk_tuple_routing` 沿 `(dimension_id, range_start, range_end)` 复合 B-tree 扫描 `dimension_slice` 定位 chunk。命中缓存（SubspaceStore）则直接复用 `ChunkInsertState`，未命中则 `ts_chunk_create_for_point` 建 chunk（建表+约束+索引）。若目标 chunk 已压缩，经 ABI 桥调 `decompress_batches_for_insert()` 解压可能与插入冲突的 batch 使行可见；写入后经 `continuous_agg_dml_invalidate()` 记录变更时间范围到失效日志。整条链路把"对逻辑 hypertable 的写入"透明地落到了物理 chunk，并联动了压缩与连续聚合两个 TSL 子系统。

#### 查询：SELECT 的约束排除剪枝

业务流程：PG planner 钩子 → 识别 hypertable → 用 WHERE 条件对 dimension_slice 做范围排除 → 展开命中的 chunk 子表 → 注入 ChunkAppend/ColumnarScan 节点 → 执行器扫描。

文字描述：`timescaledb_planner` → `timescaledb_set_rel_pathlist` 拦截 RTE，`ts_classify_relation` 判断是否 hypertable；若是则 `expand_hypertable.c` 的 `ts_plan_expand_hypertable_chunks` 用 `HypertableRestrictInfo` 把 WHERE 按维度拆解，`ts_hypertable_restrict_info_get_chunks` 交叉所有维度的 slice 得到命中 chunk 列表——**在展开前就排除不相关 chunk**，避免 PG 原生"先全展开再排除"的规划期开销。对压缩 chunk，经 ABI 桥 `set_rel_pathlist_query` 注入 `ColumnarScanPath`；含 mutable 函数（如 `now()`）的查询用 `constify_now` 常量化后做启动/运行时排除。最终 `ChunkAppend` 节点在执行期还能按参数变化动态剪枝 chunk，支持并行 worker 协调。

#### 后台：BGW 压缩策略执行

业务流程：scheduler worker 唤醒 → 查 bgw_job 表取到期 job → 启动 job worker → 经 ABI 桥 `job_execute` 路由到 TSL 策略 → 压缩/刷新/保留对应 chunk → 更新 job_stat。

文字描述：`ts_bgw_scheduler_main` 主循环从 `_timescaledb_catalog.bgw_job` 按 `next_start` 取到期作业，`ts_bgw_start_worker` 拉起一个 PG Background Worker（`BgwParams` 经 `bgw_extra` 传递），worker 在 `ts_bgw_job_entrypoint` 里以 job owner 身份建连，调 `ts_cm_functions->job_execute(job)`——这一步经 ABI 桥落到 TSL 的 `tsl/src/bgw_policy/job.c`，按 `proc_schema/proc_name` 构造 `SELECT proc(job_id, config)` 或 `CALL` 执行具体策略（如 `policy_recompression_proc` 压缩未压缩 chunk、`policy_refresh_cagg_proc` 刷新连续聚合）。执行结果写 `bgw_job_stat`/`bgw_job_stat_history`。失败走 `PG_CATCH` 回滚、记录 jsonb 错误、按 `max_retries` 决定是否继续调度。

### 状态流

Chunk 在其生命周期中有一组明确的状态标志（`status` 位掩码，定义于 `src/chunk.h`），驱动压缩/DML/运维的行为分支：

- **DEFAULT（0）**：未压缩的普通 chunk，可正常读写。
- **COMPRESSED**：已整体压缩为列存，DML 插入需先解压相关 batch。
- **COMPRESSED_PARTIAL**：压缩 chunk 上有未压缩的新数据（DML 插入或重组未完成），查询需合并压缩与未压缩部分，重组后清除该标志。
- **COMPRESSED_UNORDERED**：压缩 chunk 内 batch 顺序被打乱（如多次插入），`compact_chunk` 重组后清除。
- **FROZEN**：冻结 chunk，禁止写入（INSERT 报 `ERRCODE_FEATURE_NOT_SUPPORTED`），用于归档。

状态转换由压缩/解压/重组操作触发：未压缩 →（`compress_chunk`）→ COMPRESSED →（DML 插入）→ COMPRESSED_PARTIAL →（`recompress_chunk_segmentwise`）→ COMPRESSED。相关代码：状态枚举在 `src/chunk.h`，校验在 `ts_chunk_validate_chunk_status_for_operation`（`src/chunk_insert_state.c:452`），转换在 `tsl/src/compression/recompress.c` 与 `tsl/src/chunk_merge.c`。

## 典型修改场景

#### 场景 1：新增一个跨模块（TSL）功能

以新增一个 SQL 可调用的企业功能 `my_feature` 为例，需同步改三处（注释明确写在 `src/cross_module_fn.h:24`）：

- `src/cross_module_fn.h`：在 `CrossModuleFunctions` 结构体加字段 `PGFunction my_feature;`
- `src/cross_module_fn.c`：加 `CROSSMODULE_WRAPPER(my_feature);` 生成 `ts_my_feature` 包装函数，并在 `ts_cm_functions_default` 赋 `.my_feature = error_no_default_fn_pg_community`
- `tsl/src/init.c`：在 `tsl_cm_functions` 赋 `.my_feature = my_feature` 指向 TSL 实现
- 对应 `.sql`：`CREATE FUNCTION my_feature(...) AS 'timescaledb', 'ts_my_feature' LANGUAGE C`

社区版调用时命中默认桩报 "not supported under current license"，企业版经 ABI 桥走真实实现。对应测试：`tsl/test/sql/`。

#### 场景 2：新增一种压缩算法

- `tsl/src/compression/compression.c:71` 的 `definitions[]` 数组加一项 `[COMPRESSION_ALGORITHM_NEW] = NEW_ALGORITHM_DEFINITION`
- 在 `tsl/src/compression/algorithms/` 实现算法（提供 `Compressor` 接口的 `append_val`/`finish` 与 `DecompressionIterator`）
- `src/cross_module_fn.h` 的 `bloom1_get_hash_function` 等若涉及 sparse index 同步扩展

对应测试：`tsl/test/fuzzing/compression/`（每个算法有独立模糊测试目录）。

#### 场景 3：拦截一种新的 DDL 命令

- `src/process_utility.c` 的 `process_ddl_command_start` switch（约 6042 行）加 `case T_NewStmt: handler = process_new;`
- 实现 `process_new(ProcessUtilityArgs *)` 返回 `DDL_CONTINUE` 或 `DDL_DONE`
- 需要后处理则在 `process_ddl_command_end` 的 switch 加 case

对应测试：`test/sql/` 下按命令类型组织。

## 测试体系

TimescaleDB 的测试是 PG regress 风格，分两个目录对应双许可：

```
test/            # Apache 核心测试
├── sql/         # regress SQL 测试（.sql + .expected）
├── iso/         # 隔离测试（并发场景，.spec）
└── ...

tsl/test/        # TSL 企业功能测试
├── sql/         # 含 compression/continuous_agg 等专项
├── iso/         # 隔离测试
├── fuzzing/     # 压缩算法模糊测试（按算法分子目录）
└── shared/      # 跨许可共享测试
```

| 代码层 | 测试类型 | 目录 |
| --- | --- | --- |
| Apache 核心（hypertable/chunk/DDL/planner） | regress SQL | `test/sql/` |
| 企业功能（compression/cagg/vector_agg） | regress SQL | `tsl/test/sql/` |
| 并发安全 | 隔离测试 | `test/iso/` `tsl/test/iso/` |
| 压缩算法健壮性 | 模糊测试 | `tsl/test/fuzzing/compression/` |

想理解某个特性的行为，优先看它对应的 `.sql` 测试——TimescaleDB 的测试本身就是"可执行文档"。

## 阅读源码推荐路线

- **第一遍：理解启动与双许可桥**
  `src/loader/loader.c` 的 `_PG_init`（行 674）→ `post_analyze_hook`（行 492）→ `src/init.c` 的 `ts_post_load_init`（行 132）→ `tsl/src/init.c` 的 `ts_module_init`（行 213，看 `ts_cm_functions = &tsl_cm_functions` 这一行）→ `src/cross_module_fn.h` 的 `CrossModuleFunctions` 结构体
- **第二遍：理解核心数据模型**
  `src/hypertable.c` 的 `ts_hypertable_create`（行 1546）→ `src/dimension.c` 的 `ts_hyperspace_calculate_point`（行 974，Point 如何算出来）→ `src/dimension_slice.c` 的 `ts_dimension_slice_scan_limit`（行 440，B-tree 区间扫描）→ `src/chunk.c` 的 `ts_chunk_find_or_create_for_point`
- **第三遍：理解 DDL 拦截**
  `src/process_utility.c` 的 `timescaledb_ddl_command_start`（行 6350）→ `process_ddl_command_start` 的 switch → 挑 `process_altertable_start_table`（行 4720）和 `process_create_table_end`（行 4226）读
- **第四遍：选重点子系统深入阅读**
  写入链 `src/nodes/modify_hypertable_exec.c` 的 `ExecModifyTable`；查询链 `src/planner/expand_hypertable.c` 的 `ts_plan_expand_hypertable_chunks`；压缩链 `tsl/src/compression/api.c` 的 `compress_chunk_impl`（行 402）；连续聚合链 `tsl/src/continuous_aggs/refresh.c` 的三事务刷新流程

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| hypertable | 逻辑分区表，用户视角的"一张表"，由多个 chunk 组成 |
| chunk | hypertable 的物理子表，标准 PG 表，按时间/空间维度区间划分 |
| dimension | 分区维度，open=时间维度（按 interval 切区间），closed=空间维度（按 hash 等分） |
| dimension_slice | 维度上的一个 [start, end) 区间，多个 slice 组成 chunk 的 hypercube |
| columnstore | 列存压缩格式，chunk 压缩后的列式存储 + sparse index |
| continuous aggregate (cagg) | 连续聚合，增量刷新的实时物化视图 |
| BGW | PostgreSQL Background Worker，TimescaleDB 用它跑 scheduler/job |
| GUC | PostgreSQL 的 Grand Unified Configuration 参数，TimescaleDB 注册了 ~98 个 |
| ABI 桥 | CrossModuleFunctions 函数指针表，Apache 经它运行时调用 TSL |

### 参考资料

- [TimescaleDB 官方文档](https://docs.tigerdata.com/)
- [TimescaleDB GitHub 仓库](https://github.com/timescale/timescaledb)
- PostgreSQL 扩展开发文档（CustomScan/ProcessUtility_hook/Background Worker）
