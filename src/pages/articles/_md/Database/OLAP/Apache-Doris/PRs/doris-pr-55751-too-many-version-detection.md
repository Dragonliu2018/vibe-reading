---
title: "版本数超限检查被内存软限与关闭 compaction 短路的修复"
source:
  project: "Doris"
  type: "PR"
  id: "55751"
  url: "https://github.com/apache/doris/pull/55751"
  prType: "fix"
date: "2026-09-03T11:21:12+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["RowsetBuilder", "Compaction", "TOO_MANY_VERSION", "Load", "Storage"]
description: "Doris 版本数超限错误 TOO_MANY_VERSION 被内存软限提前返回与 disable_auto_compaction 跳过整个检查双重掩盖，本 PR 将错误判定前置为无条件分支，并补上回归测试。"
readingTime: "8 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PR** [#55751](https://github.com/apache/doris/pull/55751) · **Issue** `-` · **commit** [b0123fa](https://github.com/apache/doris/commit/b0123faa0e67db295e0cc7da7b785e56838e62fb) · **首发版本** 3.1.4 · **变更行数** +61 行 · **合并时间** 2025-09-18

---

## 背景

Doris 每完成一次导入，tablet 上就多一个 rowset，即一个新 version。version 数量越多，查询时需要归并的 rowset 越多，元数据也越大，所以 BE 用 `max_tablet_version_num`（默认 2000，时序表走 `time_series_max_tablet_version_num`，默认 20000）给单个 tablet 的版本数设了上限。写入路径上的**版本数检查**由 `RowsetBuilder::check_tablet_version_count()` 承担，它同时做两件事：

1. 版本数逼近上限（`max − 100`）时，提前触发 cumulative compaction 合并版本；
2. 版本数真正超过上限时，返回 `TOO_MANY_VERSION` 错误拒绝本次导入。

这个 PR 修复的 bug 是：**第 2 件事在两类常见场景下永远不会发生**。

**场景一：内存高压短路**。旧代码把「触发 compaction」和「报错」放在同一个条件块里，只要 `GlobalMemoryArbitrator::is_exceed_soft_mem_limit()` 判断 BE 已超过内存软限，函数就直接 `return Status::OK()`——哪怕 version_count 已经远超上限。这会形成恶性循环：版本越多 → 内存压力越大 → 检查被跳过 → 版本继续增长。

**场景二：关闭自动 compaction 跳过整个检查**。`RowsetBuilder::init()` 里对 `check_tablet_version_count()` 的调用被 `disable_auto_compaction`（BE 配置或表属性）包住。用户显式关闭自动 compaction 的表，版本数检查整个消失，版本可以无上限增长，直到内存或元数据先撑爆。

PR 描述中提到该 bug 导致回归测试 `too_many_versions_detection` 失败——正确行为本应是第 2001 次导入撞上 2000 的上限报错，实际却全部成功。

## 前置知识

先交代写入路径上这个检查的位置，以及几个关键符号：

```text
FE 导入事务
  → BE LoadChannel / TabletsChannel
    → DeltaWriter::init()                [load/delta_writer/delta_writer.cpp]
      → RowsetBuilder::init()            [storage/rowset_builder.cpp]
        → check_tablet_version_count()   ← 本 PR 改动
        → prepare_txn() → MemTable 写入 → flush 生成 rowset → publish version
```

![BE 导入写入路径与检查位置](/vibe-reading/images/articles/doris-pr-55751-too-many-version-detection/write-path.svg)

上图是 BE 侧一次导入的调用链：`DeltaWriter::init()` 最早经 `_rowset_builder->init()` 进入 `RowsetBuilder`，版本数检查发生在 MemTable 写入**之前**——超限的导入在还没写数据时就被拒绝。黄色高亮的 `check_tablet_version_count()` 是本 PR 的改动位置，它在「拒绝导入」与「触发后台 compaction」之间做分流。

几个关键函数：

- **`BaseTablet::max_version_config()`**（`base_tablet.cpp`）：返回该 tablet 的版本上限。compaction policy 为 `CUMULATIVE_TIME_SERIES_POLICY` 时取 `max(time_series_max_tablet_version_num, max_tablet_version_num)`，否则取 `max_tablet_version_num`。
- **`Tablet::exceed_version_limit(limit)`**（`tablet.cpp`）：判断 `_tablet_meta->version_count() > limit`，超过则累加 bvar 计数器并返回 true。
- **`GlobalMemoryArbitrator::is_exceed_soft_mem_limit(bytes)`**：进程内存用量 + 待分配字节是否超过软限，或系统可用内存低于告警水位。软限之上还有硬限，超软限时 BE 会开始拒绝可重试的内存申请。

> 本 PR 时代文件路径是 `be/src/olap/rowset_builder.cpp`；其后 [#61107](https://github.com/apache/doris/pull/61107) 的 BE 目录重构把它挪到了 `be/src/storage/rowset_builder.cpp`，本文引用的当前 master 代码以后者为准。

## 实现

改动集中在 `rowset_builder.cpp` 的两个函数，核心是**把错误判定从条件块的末尾提到函数开头，变成无条件分支**。

### 旧代码：错误检查被三层条件包住

```cpp title="be/src/olap/rowset_builder.cpp（改动前）"
Status RowsetBuilder::check_tablet_version_count() {
    bool injection = false;
    DBUG_EXECUTE_IF("RowsetBuilder.check_tablet_version_count.too_many_version",
                    { injection = true; });
    int32_t max_version_config = _tablet->max_version_config();
    if (injection) {
        // do not return if injection
    } else if (!_tablet->exceed_version_limit(max_version_config - 100) ||
               GlobalMemoryArbitrator::is_exceed_soft_mem_limit(GB_EXCHANGE_BYTE)) {
        return Status::OK();               // ← 超限时也可能从这里提前返回
    }
    //trigger compaction
    auto st = _engine.submit_compaction_task(tablet_sptr(), CompactionType::CUMULATIVE_COMPACTION,
                                             true);
    if (!st.ok()) [[unlikely]] { LOG(WARNING) << ...; }
    auto version_count = tablet()->version_count();
    DBUG_EXECUTE_IF("RowsetBuilder.check_tablet_version_count.too_many_version",
                    { version_count = INT_MAX; });
    if (version_count > max_version_config) {
        return Status::Error<TOO_MANY_VERSION>(...);
    }
    return Status::OK();
}
```

`TOO_MANY_VERSION` 的判定排在最后，且只有走过前面所有关卡才能到达。逐条看这些关卡：

- **内存软限**：`is_exceed_soft_mem_limit()` 为 true 时提前 `return OK`，此时即使 `version_count > max` 也不报错——这就是场景一；
- **`injection` 标志**：这是 [#44713](https://github.com/apache/doris/pull/44713) 为故障注入测试加的补丁——因为存在上面的提前返回，注入测试（把 `version_count` 设成 `INT_MAX`）必须靠一个独立标志先绕过它，才能走到报错分支。测试基础设施自己就在「绕 bug」；
- 调用侧 `init()` 的 `disable_auto_compaction` guard 则在函数之外又挡掉了场景二。

这段结构不是一次性写坏的，git blame 能看到完整的演化轨迹：

| 时间 | PR | 变化 |
| --- | --- | --- |
| 2023-08 | [#22805](https://github.com/apache/doris/pull/22805)（从 delta_writer 拆出 RowsetBuilder） | 原始逻辑就是嵌套 if：`if (auto compaction 开 && 逼近上限 && 内存未超软限) { 触发 compaction; if (超上限) 报错; }`——**报错从第一天起就被嵌在内存条件里** |
| 2023-10 | [#24929](https://github.com/apache/doris/pull/24929)（抽象 BaseTablet） | 嵌套 if 反转成提前返回的卫语句，语义原样保留 |
| 2024-12 | [#44713](https://github.com/apache/doris/pull/44713) | 加 `injection` 标志，让故障注入测试能绕过提前返回 |
| 2025-09 | 本 PR | 把错误判定提出来无条件执行 |

### 新代码：错误优先，compaction 条件化

```cpp title="be/src/olap/rowset_builder.cpp（改动后）"
Status RowsetBuilder::check_tablet_version_count() {
    auto max_version_config = _tablet->max_version_config();
    auto version_count = tablet()->version_count();
    DBUG_EXECUTE_IF("RowsetBuilder.check_tablet_version_count.too_many_version",
                    { version_count = INT_MAX; });
    // Trigger TOO MANY VERSION error first
    if (version_count > max_version_config) {
        return Status::Error<TOO_MANY_VERSION>(...);
    }
    // (TODO Refrain) Maybe we can use a configurable param instead of hardcoded values '100'.
    // max_version_config must > 100, otherwise silent errors will occur.
    if ((!config::disable_auto_compaction &&
         !_tablet->tablet_meta()->tablet_schema()->disable_auto_compaction()) &&
        (version_count > max_version_config - 100) &&
        !GlobalMemoryArbitrator::is_exceed_soft_mem_limit(GB_EXCHANGE_BYTE)) {
        // Trigger compaction
        auto st = _engine.submit_compaction_task(tablet_sptr(),
                                                 CompactionType::CUMULATIVE_COMPACTION, true);
        if (!st.ok()) [[unlikely]] { LOG(WARNING) << ...; }
    }
    return Status::OK();
}
```

三处关键变化：

1. **`version_count > max_version_config` 成为第一个判定**，任何条件都拦不住它。内存超软限、compaction 开关、`injection` 标志全部不再影响报错，`injection` 变量随之删除——注入测试直接把 `version_count` 置为 `INT_MAX` 就能命中报错分支。
2. **触发 compaction 的三个条件被合并进一个 if**：自动 compaction 开启（BE 配置与表属性都未关闭）、版本数超过 `max − 100`、内存未超软限。语义与旧代码一致——内存高压时不主动提交 compaction 任务（compaction 本身也要消耗内存），只是不再连带吞掉错误。
3. **`init()` 里的 guard 移除**：

```cpp title="be/src/olap/rowset_builder.cpp（init() 调用点）"
-    if (!config::disable_auto_compaction &&
-        !_tablet->tablet_meta()->tablet_schema()->disable_auto_compaction()) {
-        RETURN_IF_ERROR(check_tablet_version_count());
-    }
+    RETURN_IF_ERROR(check_tablet_version_count());
```

   `disable_auto_compaction` 从「是否检查」降级为「是否触发 compaction」——关闭自动 compaction 的表同样受版本上限保护，只是不再有主动合并。

改动前后控制流对比如下：

![改动前后控制流对比](/vibe-reading/images/articles/doris-pr-55751-too-many-version-detection/before-after.svg)

左图两条红路径就是 bug 的全部出口：auto compaction 关闭时整个检查被跳过（`init()` 层的 guard），内存超软限或版本数未逼近上限时提前 `return OK`——两条路都到不了底部的 `TOO_MANY_VERSION` 判定。右图把超限判定提到最前且无条件执行（绿），compaction 触发条件整体下移为独立分支，不再影响错误语义。

顺带一提，cloud 模式的 `CloudRowsetBuilder::check_tablet_version_count()` 从一开始就是「先查 `version_count > max_version_config` 直接报错」的写法（只是用 `fetch_add_approximate_num_rowsets` 从 meta service 取近似版本数）。本 PR 让存算一体实现回到了与 cloud 一致的结构。

## 测试

### 回归测试

新增 `regression-test/suites/load/insert/test_too_many_versions_detection.groovy`，44 行，构造的正是「场景二」：

```groovy title="test_too_many_versions_detection.groovy"
suite("too_many_versions_detection") {
    sql """ DROP TABLE IF EXISTS t """
    sql """
        create table t(a int)
        DUPLICATE KEY(a)
        DISTRIBUTED BY HASH(a)
        BUCKETS 10 PROPERTIES("replication_num" = "1", "disable_auto_compaction" = "true");
    """

    for (int i = 1; i <= 2000; i++) {
        sql """ INSERT INTO t VALUES (${i}) """
    }

    try {
        sql """ INSERT INTO t VALUES (2001) """
        assertTrue(false, "Expected TOO_MANY_VERSION error but none occurred")
    } catch (SQLException e) {
        def expectedError = "failed to init rowset builder. version count: 2001, exceed limit: 2000, tablet:"
        assertTrue(e.getMessage().contains(expectedError), ...)
    }
    sql """ DROP TABLE IF EXISTS t """
}
```

测试的版本数算术：建表本身产生 1 个初始 version，2000 次单行 INSERT 各产生 1 个，共 2001 个 version。第 2001 次 INSERT（值为 2001）在 `RowsetBuilder::init()` 时看到 `version_count = 2001 > 2000`，被拒绝，错误信息精确断言到 `"version count: 2001, exceed limit: 2000"`。

两个设计点值得注意：

- 表属性显式设置 `disable_auto_compaction = true`，精确打在旧代码 `init()` guard 的跳过路径上——旧代码下这 2001 次导入全部成功，`assertTrue(false)` 失败暴露 bug；同时关掉 compaction 也让测试不必等待后台合并，2000 次导入内版本数单调递增，结果确定；
- 用默认的 `max_tablet_version_num = 2000` 而不是调小配置，避免测试对 BE 配置的依赖。

### 已有故障注入测试

`fault_injection_p0/test_load_stream_fault_injection.groovy` 和 `load_p0/routine_load/test_routine_load_delay_schedule.groovy` 一直在用 `RowsetBuilder.check_tablet_version_count.too_many_version` 这个 debug point 验证超限报错链路。改动后 `injection` 标志删除，注入直接改写 `version_count`，这些测试继续有效。

## Review

review 过程中的一段有信息量的交换，围绕被删除的 `injection` 标志（[liaoxin01](https://github.com/liaoxin01) 在新代码的 `DBUG_EXECUTE_IF` 行上评论）：

> **liaoxin01**：`injection` is useless, it is not needed here.

> **0AyanamiRei**（作者，回复）：That means when we write injection test we must set `disable_auto_compaction` to be false (open the auto compact).

作者的回复点出了行为差异：旧代码里注入测试只要不碰 `disable_auto_compaction` 就一定走到报错（`injection` 标志硬开通道）；新代码下注入无条件生效，但如果注入测试的表同时关着 auto compaction，行为与旧版本不同——所以写这类测试时需要保证 auto compaction 是开启的。

## 意义与影响

- **版本上限在所有场景下真正生效**。此前「内存高压」和「关闭自动 compaction」两类场景下 `TOO_MANY_VERSION` 形同虚设，本 PR 之后版本上限成为无条件硬约束——尤其是打破了内存高压下「不报错 → 版本更多 → 内存更高」的正反馈。
- **对显式关闭自动 compaction 的表是行为收窄**。这类表此前可以无限累积版本（用户既然关了 compaction，可能确实有外部合并策略），现在同样会在 `max_tablet_version_num` 处被拒绝。这是恢复本应有的保护语义，错误信息中也提示了调大配置的出口。
- **与 cloud 模式实现结构对齐**，降低了后续维护两套写入路径的心智负担。
- 内存软限对 compaction 触发的抑制被保留——内存高压下不主动提交 compaction 任务的原意没有受损，被修正的只是它错误地连带吞掉了报错。

## TODO

- [ ] 用可配置参数替代硬编码的 `100`（版本数预警提前量）。代码中作者留有 `(TODO Refrain)` 注释，同时提醒 `max_version_config` 必须大于 100，否则 `max − 100` 阈值会出现静默错误。该 TODO 在当前 master（2026-09）仍未落地。

## 相关阅读

- [存储引擎与写入路径](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.11-rc01/07-storage-engine) — Doris 2.1.11 CodeWiki 存储引擎篇，`olap` 模块的写入调用链（`delta_writer` / `rowset_builder` / compaction）全景，是本 PR 所处子系统的架构上下文。
- [Doris BE 配置项文档](/vibe-reading/articles/Database/OLAP/Apache-Doris/Docs/3.x/doris-official-be-config) — `max_tablet_version_num`、`time_series_max_tablet_version_num`、`disable_auto_compaction` 三个本 PR 直接涉及的 BE 配置项官方说明。
