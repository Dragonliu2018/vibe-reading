---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "mito2 Compaction 合并机制深读"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "LSM", "compaction", "TWCS", "时序"]
description: "mito2 compaction 子系统深读——TWCS 时间窗口合并、状态机调度、filter_deleted 安全性、内存预算与 manifest 原子提交。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回 mito2 存储引擎](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/01-mito2)

---

## 主题定位

compaction 是 LSM 引擎把多次 flush 产生的零散 SST 合并、去过期数据、减少读放大的后台机制。mito2 的 compaction 子系统（`src/mito2/src/compaction/`）针对时序数据特点做了三处关键取舍：只用两级 LSM（L0/L1）、默认用 TWCS（按时间窗口合并）、compaction 状态可序列化恢复。本文逐层展开它的触发、调度、合并算法与一致性保证。

## 核心原理

### 触发条件

compaction 有两个触发时机：(a) **flush 完成后自动触发**——`handle_flush_finished`（`handle_flush.rs:502`）调 `schedule_compaction`；(b) **手动触发**——用户 DDL 请求经 `handle_compaction_request`（`handle_compaction.rs:75`），可指定 `parallelism` 和 `time_range`。受 `min_compaction_interval` 限制避免过频。

跳过条件（`scheduler.rs:448`、`handle_compaction.rs:236`）：Staging 或 EnteringStaging 模式跳过；有 pending DDL（Truncate/EnterStaging）时新 compaction 被 fence 拒绝。

### 状态机调度

`CompactionScheduler`（`compaction/scheduler.rs:52`）为每个 region 维护一个 `CompactionStatus` 状态机：

```
Idle → Picking(plan_id) → Executing(execution identity) → Finished/Cancelled/Failed
                                ↑
                        PendingRequest（manual compaction 排队）
```

关键方法：`schedule_compaction`（`scheduler.rs:434`）入口、`handle_compaction_pick_finished`（`:233`）提交执行任务到 `compact_job_pool`、`on_execution_finished`（`:276`）完成后检查 pending 或 automatic followup。

**身份验证机制**（`scheduler.rs:253 is_current_execution`）：每个 execution 有唯一 identity（plan_id），防止 stale 通知影响新 compaction 周期——region close/reopen 后旧通知自动失效。**Automatic Followup**（`scheduler.rs:608`）：外部触发到达时标记 `reset_automatic_followup()`，当前 compaction 完成后再触发一轮不受限的 pick，确保外部触发不因当前 compaction 正在运行而丢失。DDL（如 Truncate）需取消正在运行的 compaction 时走 `try_cancel_and_add_ddl`（`scheduler.rs:395`）。

### TWCS 合并算法

![TWCS 合并流水线](/vibe-reading/images/articles/greptimedb-internals/compaction-flow.svg)

`TwcsPicker`（`compaction/twcs.rs:50`）是默认策略：

1. **时间窗口分组**（`assign_to_windows`，`twcs.rs:337`）：把所有 SST 按 `max_timestamp` 分到时间窗口。窗口大小优先级：compaction options 的 `time_window_seconds` > version 持久化的 `compaction_time_window` > 从文件推断 `infer_time_bucket`（`buckets.rs`）。
2. **找 sorted runs**（`find_sorted_runs`/`find_sorted_runs_by_time_range`，`run.rs`）：窗口内找重叠文件组。
3. **合并**：多 run 用 `reduce_runs` 合并；单 run 但文件数 ≥ `trigger_file_num`（默认 4）用 `merge_seq_files` 合并小文件。
4. **输出 L1**：所有输出写到 `LEVEL_COMPACTED = 1`（`twcs.rs:115`），受 `max_output_file_size`（默认 2GB，`run.rs:30`）拆分，`DEFAULT_MAX_INPUT_FILE_NUM`（32，`twcs.rs:45`）限制单次输入文件数（按大小排序优先合并小文件）。

关键参数（`region/options.rs CompactionOptions::Twcs`）：`trigger_file_num`、`time_window_seconds`、`max_output_file_size`。另有 `WindowedCompactionPicker`（`compaction/window.rs:37`）支持手动指定精确窗口（`StrictWindow`），并做 transitive dependency closure 处理（`filter_time_windows`，`window.rs:149`）——跨多窗口的 SST 需把所有涉及窗口都纳入。

## 实现细节

### 重叠检测

`FileGroup` 实现 `Ranged` trait，`overlap`（`run.rs:39`）同时检查时间范围和 primary key 范围（`run.rs:222`）——只有时间重叠且 PK 范围重叠才算真正重叠。`find_overlapping_items`（`run.rs:72`）据此分组。

### filter_deleted 安全性

只有当窗口内 found_runs ≤ 2 且非 append mode 且窗口内无重叠时，才安全地过滤 deletion markers（`twcs.rs:172`）。如果窗口内有文件未被选中 compaction 且与选中文件重叠（`overlaps_files_left_behind`，`twcs.rs:217`），则**不能** filter_deleted——因为那些留下的文件可能持有被删除的行，删了 tombstone 会导致删除失效。

### TTL 过期文件

`Picker::pick` 时用 `get_expired_ssts`（`picker.rs:158`）识别 TTL 过期 SST，这些文件不参与合并，而是通过 `remove_expired`（`task.rs:120`）从 manifest 直接移除。移除在 compaction merge 之前执行，失败不阻止 compaction 继续（`task.rs:118` 注释）。

### 内存预算

`CompactionMemoryManager`（`compaction/memory_manager.rs`）控制内存：task 执行前 `acquire_memory_with_policy`（`task.rs:92`）申请预算（`estimated_memory_bytes`），受 `experimental_compaction_memory_limit`（全局）和 `experimental_compaction_on_exhausted`（Wait/Fail）策略控制。支持 cooperative cancellation——申请内存时可被取消（`task.rs:298 CancellableFuture`）。

### manifest 原子提交

compaction merge 完成后构造 `RegionEdit{ files_to_add, files_to_remove, compaction_time_window }`（`compactor.rs:732`），写入 manifest。`UncommittedSsts`（`task.rs:72`）跟踪未提交的输出文件：manifest 写失败且未持久化则清理（`task.ts:366`）；可能已持久化则保留（`task.rs:364 may_have_persisted_manifest_update`）。`mark_commit_started`（`task.ts:344`）：一旦开始提交 manifest 就不再接受取消，保证 compaction 结果一致性。

## 性能与权衡

- **两级 LSM 的取舍**：时序数据天然按时间排序，两级（L0 flush 产物 / L1 合并产物）足够，简化 compaction 逻辑、减少写放大，代价是 L0 文件多时读放大需靠 TWCS 及时合并。
- **TWCS 适配时序**：按时间窗口合并契合时序数据的时间局部性，同窗口文件合并后查询只需扫少量 L1 文件；代价是窗口大小选择敏感——窗口过大单次 compaction 重、过小合并频繁。
- **filter_deleted 保守策略**：为安全牺牲部分空间回收——宁可留着 tombstone 也不能让删除失效，代价是极端情况下读放大略增。
- **内存预算 + cooperative cancellation**：compaction 内存有上界，超限可等待或失败，避免 compaction 挤占写入/查询内存；代价是高负载时 compaction 可能排队延迟。
