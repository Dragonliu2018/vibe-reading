---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "统计信息"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "CBO"]
description: "TiDB 统计信息解读：直方图+TopN 双结构、系统表+内存双层缓存、auto-analyze 与按需加载"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/statistics/` 负责 CBO 的燃料：统计信息的收集（ANALYZE）、存储（`mysql.stats_*` 系统表 + 内存缓存）与消费（planner 行数估算）。它的架构与 schema 元数据同构——**系统表持久化 + 内存缓存 + lease 增量轮询**——因为面对的是同一个分布式问题：多节点共享一份可变数据。任何节点执行 ANALYZE 后，其余节点在一个 lease 周期内自动可见，无需各自分析。本快照的结构变化：旧 `statsupdate` 目录已拆散并入 `handle/` 下按职责命名的子包（`cache/ storage/ syncload/ autoanalyze/ history/ usage/ lockstats/ globalstats/ ddl/`）。

## 模块架构

```
pkg/statistics/
├── table.go               # Table 统计结构（内嵌 HistColl）+ GetStatsHealthy
├── histogram.go column.go index.go cmsketch.go   # 直方图/TopN/CMSketch/FMSketch
├── sample.go row_sampler.go                      # 采样器（TiKV 协处理采样回传）
└── handle/
    ├── handle.go           # Handle：组合式聚合（嵌入各接口实现）
    ├── cache/statscache.go # StatsCache：内存缓存 + 增量 Update + TriggerEvict
    ├── storage/save.go gc.go                     # 写 mysql.stats_* / 统计 GC
    ├── syncload/stats_syncload.go                # planner 估算时阻塞按需加载
    ├── autoanalyze/autoanalyze.go                 # 自动分析触发
    └── globalstats/ lockstats/ ddl/ history/ usage/ ...
```

`Handle`（`handle.go:70`）是**组合优于继承**的范例：它嵌入 `StatsCache`/`StatsReadWriter`/`StatsGC`/`StatsAnalyze`/`StatsSyncLoad` 等接口，各实现在子包里独立演进——统计模块职责太多（收集/缓存/加载/GC/锁/分区 global stats），单一 struct 会膨胀成上帝对象。

## 调用链路

ANALYZE 链路：

```
AnalyzeExec.Next                             pkg/executor/analyze.go:300
├─ flushStatsDeltaForAnalyze                 # 先广播 FLUSH STATS_DELTA CLUSTER
├─ analyzeWorker（buildStatsConcurrency 个 goroutine）
│   └─ SampleBuilder.CollectColumnStats      pkg/statistics/sample.go:221
│       └─ TiKV 端 coprocessor 采样回传 SampleCollector（sample.go:68）
└─ trySendAnalyzeResult → Handle.SaveAnalyzeResultToStorage
    └─ storage/save.go:119                   # 写 stats_top_n / stats_buckets /
                                             #     stats_histograms / stats_meta
[后续] domain 的 loadStatsWorker 按 lease 周期调
    StatsCacheImpl.Update                    handle/cache/statscache.go:122
    # SQL: select ... from mysql.stats_meta where version > lastVersion（增量拉取）
```

估算链路：

```
planner Selectivity                          pkg/planner/cardinality/selectivity.go:51
├─ GetUsableSetsByGreedy                     # 按 expression 覆盖度贪心挑列/索引
└─ statistics.GetRowCountByIndexRanges       # 函数指针，cardinality 包 init() 注入
    └─ equalRowCountOnIndex                  row_count_index.go
        # ① TopN.QueryTopN 精确命中 → ② bucket 上界 → ③ 均匀假设兜底
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `StatsCacheImpl.Update` in `cache/statscache.go:122` | 增量刷新内存缓存 | `version > lastVersion` 只拉新增 |
| `SendLoadRequests` in `syncload/stats_syncload.go:114` | 估算时按需加载直方图 | 阻塞等待，超内存配额驱逐 |
| `HandleAutoAnalyze` in `autoanalyze/autoanalyze.go:286` | 自动分析入口 | 随机选表避免多节点重复 |
| `equalRowCountOnColumn` in `cardinality/row_count_column.go:72` | 等值行数估算 | TopN → 直方图 → 均匀兜底三级 |

## 核心实现

### 直方图 + TopN 双结构

`Table`（`pkg/statistics/table.go:81`）内嵌 `HistColl`（`table.go:213`）：每列/每索引一个 `Histogram`（`histogram.go:65`，等深桶 `Bounds *chunk.Chunk` + `Buckets`）+ `TopN`（`cmsketch.go:486`，高频值-精确计数）。这两个结构**怎么构建**（SortedBuilder 的桶满合并、同值不跨桶）、**怎么估算**（LocateBucket 的成对 Bounds 定位、EqualRowCount 的三分支公式）与 FMSketch 的 NDV 公式，展开在深度附件 [直方图与 TopN 构建](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/06a-statistics-histogram-topn)。为什么两套并存：等值点查若只靠等宽直方图误差极大（热点值可能占一半行数）；TopN 精确记录 top 高频值，直方图覆盖长尾。`equalRowCountOnColumn`（`row_count_column.go:72`）的查找顺序即设计意图：① TopN 命中直接返回精确值 → ② 直方图 bucket 上界（含 `IsLastBucketEndValueUnderrepresented` 防末桶误判零）→ ③ `estimateRowCountWithUniformDistribution` 均匀假设兜底。旧版 `CMSketch` 自 StatsVer2 起不再为列构建，等值职责由 TopN 接管；`FMSketch` 仅用于 NDV 估计。

### 双层存储与三态加载

统计放系统表是**唯一的多节点共享点**（TiKV 是集群共享存储）；内存缓存让估算不打 KV。刷新是拉模式：`mysql.stats_meta.version` 是毫秒级时间戳，`StatsCacheImpl.Update` 只 `where version > lastVersion` 增量拉。加载分三态：meta（行数/修改计数）常驻内存；直方图可 sync load（planner 估算时 `SendLoadRequests` 阻塞等，见 `rule_collect_plan_stats.go` 的 `CollectPlanStats` 触发点）或 async 后台加载；超过 `tidb_stats_cache_mem_quota` 时 `TriggerEvict` 按健康度驱逐。DDL 之后用 `LastStatsHistVersion`（`table.go`）跳过未变更部分的冗余重载。

### auto-analyze 与统计健康度

触发主体是 domain 的 stats worker 周期调用 `HandleAutoAnalyze` → `handleAutoAnalyze`（`autoanalyze.go:329`）：读 `tidb_auto_analyze_ratio` 与时间窗（`checkAutoAnalyzeWindow`），`RandomPickOneTableAndTryAutoAnalyze`（:411）决定是否分析——随机选表是为了多节点同时跑 auto-analyze 时不撞车；阈值是 `ModifyCount/RealtimeCount > ratio` 且行数 ≥ `AutoAnalyzeMinCnt=1000`（`statistics/table.go:67`）。新路径（`EnableAutoAnalyzePriorityQueue`）按 `Table.GetStatsHealthy`（`table.go:806`，基于修改占比）构造优先队列，从"最不健康"的表开始补统计——把有限的分析预算花在估算收益最大的地方。

### 与 SPM 的同构

`pkg/bindinfo` 的执行计划绑定与统计信息是同一套模式：`mysql.bind_info` 系统表 + `BindingCache` 内存缓存 + lease 轮询 + normalize digest 匹配（`MatchSQLBinding` in `bindinfo/binding.go:137`）。读到 statistics 的双层架构时可以把 bindinfo 当第二个实例互相印证——TiDB 所有"集群共享、lease 增量同步"的子系统都是这个形状。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合聚合 | `Handle` 嵌入多接口 in `handle.go:70` | 十余种职责分家，避免上帝对象 |
| 分级缓存/懒加载 | meta 常驻 + 直方图 sync/async + 配额驱逐 | 大集群不可能全量驻内存 |
| 函数指针注入 | `GetRowCountByIndexRanges` in `table.go:74` | statistics ↔ planner 解环（cardinality `init()` 注册） |
| 策略 | `SampleCollector` 并发合并采样 in `sample.go:68` | 采样并发度与 merge 语义可配 |

## 模块间交互

消费方：planner（`RecursiveDeriveStats`/`Selectivity`，估算失败退回 `pseudoSelectivity` 伪统计）。生产方：executor 的 `AnalyzeExec`。事件源：DDL owner 经 `notifier` 推 add/drop column/index 事件，`handle/ddl` 的 `HandleDDLEvent` 同步维护 stats 表（`handle.go:174-184` 注册）。GC 协作：统计 GC（`storage/gc.go:53` 的 `GCStats`）由 domain 周期驱动删 drop 表残留；历史统计写 `mysql.stats_history` 供 flashback 式查看，GC redo 后由 `UpdateStatsMetaVersionForGC`（`stats_read_writer.go:67`）推进版本。

## 扩展方式

改估算策略：`pkg/planner/cardinality/row_count_column.go` 的 `equalRowCountOnColumn` 与 `row_count_index.go`（多条件组合在 `selectivity.go` 的 `Selectivity`）。加采样方式：`pkg/statistics/sample.go`/`row_sampler.go` + `pkg/executor/analyze.go` 的 worker 构建。调 auto-analyze：`handle/autoanalyze/autoanalyze.go`（阈值/窗口/优先队列）。改缓存加载策略：`handle/cache/statscache.go` 与 `handle/syncload/stats_syncload.go`。
