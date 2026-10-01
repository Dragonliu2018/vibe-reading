---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "Options 与监控"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "Observability"]
description: "Configurable 伪反射注册表（一套元数据撑起解析/序列化/校验/热改）、mutable/immutable 选项分离、per-core 分片统计、thread-local PerfContext 三级门控。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

两个横切层：**配置体系**（`options/`——Options 三层 + Configurable 反射注册表 + mutable 热改）与**观测体系**（`monitoring/` + `db/internal_stats.cc`——Statistics 累计、PerfContext 每查询剖析、InstrumentedMutex 锁计时）。

勘误（9.11.1 核实）：`monitoring/query_perf_context` 不存在（属更新主线）；statistics.cc 无 `TickersAndHistogramsMap`，实际是 `TickersNameMap` 与 `HistogramsNameMap` 两个平行结构。

## 模块架构

```
用户层 Options（options.h:1627 多继承聚合）
  DBOptions + ColumnFamilyOptions（继承 AdvancedColumnFamilyOptions）

内部拆分（真正被 DB 使用）
  ImmutableDBOptions（env/rate_limiter/listeners/db_paths——生命周期内不变）
  MutableDBOptions（19 个热改字段：max_background_*/max_open_files/delayed_write_rate...）
  ImmutableCFOptions（comparator/compaction_style/memtable_factory/cf_paths）
  MutableCFOptions（60+ 字段：write_buffer_size/level0_*/target_file_size_*/compression...）

Configurable 反射（configurable.h:44）
  RegisterOptions(name, 对象内偏移, OptionTypeInfo map)
  → ConfigureFromMap / GetOptionString / AreEquivalent / ValidateOptions
  复用同一套元数据

观测三通道（正交）
  Statistics（进程级累计，DBOptions 配置常开，per-core 分片原子）
  PerfContext/iostats_context（线程级单查询，SetPerfLevel 按需开）
  InternalStats（CF 级 compaction/stall 结构化，供 GetProperty）
```

## 调用链路

```
DB::Open 的校验与规范化
  ValidateOptionsByTable → ValidateOptions（options_helper.cc:41）
    把 DBOptions/CFOptions 包成 Configurable → 遍历注册表逐条 validate
  DBImpl 构造 → SanitizeOptions（db_impl_open.cc:33）
  CF 侧 SanitizeOptions（column_family.cc:203）：
    min_write_buffer_number_to_merge≥1、num_levels<2 补 2、
    强制 level0_stop ≥ slowdown ≥ trigger（:225-337）
  注意：Open 不回读 OPTIONS 文件（信任调用方）；
  OPTIONS 文件的消费方是 RocksDBOptionsParser（ldb --try_load_options）

SetOptions 热改（db_impl.cc:1199）
  options_mutex_ + mutex_ 双锁
  → LogAndApply(pre_cb)（dummy_edit 免写 manifest 的原子版本切换）
      pre_cb → ColumnFamilyData::SetOptions（column_family.cc:1585）
        ConfigOptions.mutable_options_only = true
        → ConfigureFromMap：非可变选项直接 InvalidArgument
        → mutable_cf_options_ 替换 + RefreshDerivedOptions
  → InstallSuperVersionForConfigChange（读路径原子切到新 options）
  → WriteOptionsFile（写完立即回读自校验，options_parser.cc:151）

统计关键路径调用点
  Get：StopWatch(DB_GET) + RecordTick(MEMTABLE_HIT/MISS/BYTES_READ)
  Write：RecordTick(NUMBER_KEYS_WRITTEN/WRITE_DONE_BY_SELF/OTHER)
  Block cache：RecordTick(BLOCK_CACHE_HIT/MISS + index/filter/data 细分)
  DB mutex：InstrumentedMutex 的 Lock 计时 → DB_MUTEX_WAIT_MICROS
```

## 核心实现

### Configurable：一套元数据四处使用

```cpp title="options/db_options.cc:59-62（注册实例）"
{"max_background_jobs",
 {offsetof(struct MutableDBOptions, max_background_jobs), OptionType::kInt,
  OptionVerificationType::kNormal, OptionTypeFlags::kMutable}},
```

`OptionTypeInfo` = `{字段 offsetof、类型、校验方式、标志(kMutable/kShared/kCompareLoose)、parse/serialize/validate 函数}`。构造时 `RegisterOptions` 把 `(name, 对象内 intptr_t 偏移, 类型表)` 存入 `options_`——**存偏移不存指针**使注册信息可随对象拷贝迁移。解析 `ConfigureFromMap → ParseOptionHelper` 的类型 switch **直接按偏移写内存**；序列化/相等比较/校验复用同一张表。`table_factory` 条目的标志组合是 `kShared | kCompareLoose | kStringNameOnly | kDontPrepare | kMutable`（另有 `block_based_table_factory`/`plain_table_factory` 两个 kAlias 别名键），热改走 clone-then-swap（`cf_options.cc:136` 注释明言避免与消费者的竞态）。

### mutable/immutable 分离：为什么热改无需 reopen

Immutable 集合限定"影响 SST 物理布局/对象身份"的字段（comparator、compaction_style、cf_paths——改了会毁掉已有数据）；mutable 集合是"阈值/开关/资源配额"，改它们只需：替换 `mutable_cf_options_` + `RefreshDerivedOptions` + **安装新 SuperVersion**（SuperVersion 引用计数保证在途读用旧配置一致收尾）。生效语义：`write_buffer_size` 只对**下一个** memtable 生效（`CreateNewMemtable` 用最新值）；`disable_auto_compactions` 即时影响调度。

### 统计是 per-core 分片原子（不是全局原子）

`CoreLocalArray<StatisticsData> per_core_stats_`（`statistics_impl.h:106`，`static_assert(sizeof(StatisticsData) % CACHE_LINE_SIZE == 0)`）：按 `port::PhysicalCoreID()` 取本核 slot，`recordTick` 走 `tickers_[t].fetch_add(count, relaxed)`。`StatisticsData` 整体 `ALIGN_AS(CACHE_LINE_SIZE)`——**不同核的计数永不共享 cache line**，把"N 线程对同一原子变量的缓存行弹跳"降为"每核独占行内的 relaxed 自增"。代价是读取需聚合（`getTickerCountLocked` 遍历全部核）；跨核操作（Reset）用 `mutable port::Mutex aggregate_lock_` 串行。Histogram 侧 `HistogramStat::Add` 完全无锁（109 桶对数分布）。

### PerfContext：thread-local + 三级门控

字段是普通 `uint64_t`（非原子）——只有 thread_local 才能无锁累加且并发查询互不污染。配套两级门控控制开销：`PerfLevel` 本身也是 thread_local（按查询/按线程开）；`PerfStepTimer` 构造期一次性判定，禁用时计时宏全 no-op——**关闭时近零开销**。`NPERF_CONTEXT` 编译开关下退化为全局单例并连同全部 PERF 宏禁用。Statistics 与 PerfContext 的分工：前者"全进程累计、开箱常开"（代价必须分片原子），后者"单查询剖析、按需开"（可用非原子普通加法）。

### InstrumentedMutex 与计时开销分级

`InstrumentedMutex` 包装 port 同步原语，锁等待自动进 `DB_MUTEX_WAIT_MICROS` 与 `perf_context.db_mutex_lock_nanos`——门控在 `stats_for_report`（要求 `stats_level > kExceptTimeForMutex`，因为 mutex 内取时间在部分平台昂贵，`kAll` 注释直言 "can reduce scalability"）。`DBImpl::mutex_` 用 `CacheAlignedInstrumentedMutex`——"hot lock deserves dedicated cachelines"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 伪反射注册表 | `Configurable::RegisterOptions` 偏移表 | 解析/序列化/校验/热改一套元数据 |
| 可变/不可变分离 | mutable 表全带 kMutable 标志 | 热改免 reopen；嵌套子字段传染判定 |
| per-core 分片原子 | `CoreLocalArray<StatisticsData>` | 消除缓存行弹跳 |
| 包装器/RAII 惯例 | InstrumentedMutex/PerfStepTimer/StopWatch | 计时压到一行宏 |
| 失败回滚 | `ConfigureOptions` 先序列化当前配置失败回放 | 配置变更原子性 |
| 编译期校验 | PerfContext 的 `static_assert(offsetof)`（perf_context.cc:188） | 加字段漏改直接编译失败 |

## 模块间交互

**db_impl**：`mutex_` 构造为 InstrumentedMutex（全 DB 锁等待自动统计）；`mutable_db_options_` 热改触发 `env_->IncBackgroundThreadsIfNeeded`、`table_cache_->SetCapacity`。**ColumnFamilyData**：`ioptions_` + `mutable_cf_options_`（DB mutex 保护）；SuperVersion 切换让读线程原子换新配置视图。**Statistics 全局下发**：ImmutableDBOptions → TableCache/TableReader/RateLimiter/WritableFileWriter 全部子系统。**持久化闭环**：SetOptions → WriteOptionsFile → 回读自校验；旧字段以 kDeprecated 条目保留仅为兼容旧 OPTIONS 文件。

## 扩展方式

**新增可热改 CF 选项**：`advanced_options.h` 加字段 → `MutableCFOptions` 加成员 → `cf_mutable_options_type_info` 加 `{offsetof, kType, kNormal, kMutable}` 一条 → `UpdateColumnFamilyOptions` 加回写行。**无需手写 setter/序列化/比较**——反射框架自动获得全部能力；派生量记得加进 `RefreshDerivedOptions`。

**新增 ticker**：`statistics.h` 的 `Tickers` 枚举在 MAX 前插入 → `TickersNameMap` 同步加（顺序必须与枚举一致；Java 侧 portal.h 同步）→ 关键路径 `RecordTick`。

**新增 PerfContext 指标**：PerfContextBase 末尾加字段（**禁止重排/删除**）→ `DEF_PERF_CONTEXT_METRICS` 宏加行——`static_assert` 编译期校验会强制两处同步 → 调用点按级别选 `PERF_COUNTER_ADD`/`PERF_TIMER_GUARD`/`PERF_CPU_TIMER_GUARD`，命名惯例 `_count/_byte` vs `_time/_nanos` vs `_cpu_*` 匹配启用级别。
