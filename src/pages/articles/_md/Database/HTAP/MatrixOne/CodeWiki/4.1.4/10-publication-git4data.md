---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "Publication 与 Git for Data"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "Git for Data", "数据版本控制", "快照"]
description: "MatrixOne v4 招牌特性解读：CCPR 对象级差量复制流水线、iteration LSN 状态机、写保护三层防线与 data branch DAG/LCA。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

v4 的招牌特性 **Git for Data**（快照 / 分支 / 合并 / 时间旅行）在代码里由两条腿支撑：① **Publication（代码内叫 CCPR，Cross-Cluster Publication Replication）**——`pkg/publication/`（约 1.3 万行非测试 Go），把源库快照"发布"成可写分支：DDL/DML 过滤、对象级差量复制、写保护、内存控制；② **Data Branch**——`pkg/frontend/data_branch*.go` 与 `databranchutils/`，`CREATE/DROP/DIFF/MERGE/PICK DATA BRANCH` 命令族，基于表克隆 + 保护快照 + 祖先 DAG 实现 diff/merge/cherry-pick。设计论文见 arXiv [Version Control System for Data with MatrixOne](https://arxiv.org/abs/2604.03927)。

它横跨 frontend（命令解析）、tae（snapshot/GC 保护）、taskservice（后台调度）、fileservice（对象复制）四个模块，是全库横切面最宽的特性——也因此值得单独成文。

## 模块架构

![Publication 差量复制流水线](/vibe-reading/images/articles/matrixone-internals/publication-flow.svg)

核心类型：`IterationContext`（`pkg/publication/types.go`，一轮迭代的全上下文：上游/本地 executor、`IterationLSN`、`PrevSnapshotTS/CurrentSnapshotTS`、`AObjectMap`、`TableIDs`、`ErrorMetadata`）；`PublicationTaskExecutor`（executor.go，btree 持有 `TaskEntry{TaskID,LSN,State,SubscriptionState,DropAt}`）；`worker.go` 的三级 worker 池（FilterObject/GetChunk/WriteObject）+ `filter_object_job.go` 的 `Job` 接口（`Execute/WaitDone/GetType`，future 模式）；分支侧的 `DataBranchDAG`（databranchutils/branch_dag.go，`FindLCA/PathFromAncestor` 支持任意深度分支树，深度上界 1024 防环）。持久化状态在系统表 `mo_catalog.mo_ccpr_log`（frontend/predefined.go:287 DDL，18 列）与 `mo_branch_metadata`。

## 调用链路

**发布链**：`frontend/publication_subscription.go:2955` `doCreateCcprSubscription` → 拉上游 DDL 建本地表 → INSERT `mo_ccpr_log` → CN 侧 `cnservice/server_task.go:360` 注册的 `PublicationTaskExecutor`（`executor.go:341` `run()` 双 ticker：SyncTask ticker 走 `applyCcprLog` 增量 + `getCandidateTasks` + lease 检查）→ `worker.Submit` → `iteration.go:1114` **`ExecuteIteration`**（核心 ~430 行）：`InitializeIterationContext`（从 mo_ccpr_log 恢复 context/watermark/AObjectMap）→ `RequestUpstreamSnapshot`（上游执行 `CREATE SNAPSHOT ccpr_<taskID>_<lsn> FOR ... FROM account PUBLICATION`，只保留最近 2 个）→ `WaitForSnapshotFlushed` → `ddl.go:316` `ProcessDDLChanges` → `GetObjectListMap`（内部 `SELECT ... OBJECTLIST` 拿两快照对象差量）→ `RegisterSyncProtectionWithRetry` → `filter_object_submit.go:395` **`ApplyObjects`**（先 DATA 后 TOMBSTONE，每对象经 `filter_object.go:75` `FilterObject`）→ defer 中 `UpdateIterationState` 推进 LSN+1。

**分支链**：`mysql_sql.go:23218+` 解析 DATA BRANCH 语句 → `self_handle.go:697` → `data_branch.go:295` `handleDataBranch` 分发。建分支：`dataBranchCreateDatabase`（配额检查 → 复用 `handleCloneTable` 克隆 → 记 `mo_branch_metadata` → `createBranchProtectSnapshot` 建保护快照 `__mo_branch_<tid>`）。diff/merge/pick：`diffMergeAgency`（data_branch.go:610）→ `decideLCABranchTSFromBranchDAG`（DAG FindLCA 算公共祖先）→ 基于 `BranchHashmap`（分片 + 可 spill 的哈希表，设计见 `databranchutils/BRANCH_HASHMAP_DESIGN.md`）做两侧对比/合并，冲突策略 FAIL/SKIP/ACCEPT。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `PublicationTaskExecutor.run`（executor.go:341） | 双 ticker 主循环 | 包级 CAS 单飞（executor.go:51） |
| `ExecuteIteration`（iteration.go:1114） | 一轮差量复制 | ~430 行核心编排 |
| `RequestUpstreamSnapshot`（iteration.go:853） | 上游打快照 | keep-2 滚动窗口 |
| `GetObjectListFromSnapshotDiff` | 对象差量 | 未变对象零拷贝 |
| `ApplyObjects`（filter_object_submit.go:395） | 两阶段对象复制 | DATA 先、TOMBSTONE 后 |
| `FilterObject`（filter_object.go:75） | 单对象复制单元 | 行过滤 + rowid 重写 |
| `handleDataBranch`（data_branch.go:295） | 分支命令分发 | 纯 frontend 自处理 |
</details>

## 核心实现

### 对象级而非行级差量

`GetObjectListFromSnapshotDiff` 直接比对两个快照的 `ObjectStats` 列表（增/删对象集合）：行级差量需读全部数据比对，代价 O(数据量)；对象级只比对象元数据，代价 O(对象元数据)，未变化对象零拷贝。**aobj 例外**——appendable object 内含多版本行，需按 commitTS 过滤行（`filterBatchBySnapshotTS`）并重写 rowid。

### AObjectMap：对象级复制正确性的关键补丁

上游 appendable object 在下游落成**新 UUID + rowoffset 重排**的非 appendable 对象；tombstone 的 rowid 必须经 `rewriteTombstoneRowids` 改写才能正确指向下游行——没有这层映射，删除会在复制后丢失或误删。

### 写保护三层防线

复制期间上游对象可能被 GC 删除，目标分支也可能被外部写入污染。防线一：上游向 TN 的 DiskCleaner 注册 bloom filter（`BuildBloomFilterFromObjectMap`，sync_protection.go:291，经内部命令 `SELECT mo_ctl('dn','diskcleaner','register_sync_protection.…')`），worker ticker keepalive 续期，TN 侧 `SyncProtectionValidator`（tae/db/controller.go:726）在 commit 时校验。注册的重试边界明确（`RegisterSyncProtectionWithRetry`，sync_protection.go）：**仅 `IsGCRunningError || IsSyncProtectionMaxCountError` 可重试**（:412），`retryOpt.MaxTotalTime <= 0` 时立即失败；jobID 为 `uuid.New()`（:398），bloom 从 objectMap 构建，`ttlExpireTS = time.Now().Add(GetSyncProtectionTTLDuration())`（:409）。防线二：本地 `CCPRTxnCache`（disttae/ccpr_txn_cache.go）保证事务回滚时清理半写文件（`OnFileWritten/OnTxnRollback/gcObjects`）。防线三：分支侧的保护快照 + `BranchReclaimDag.SubtreeAllDeleted` 决定何时可回收。

### iteration 轮次的幂等与断点续传

每轮 `ccpr_<taskID>_<lsn>` 快照（名字由 `GenerateSnapshotName`（iteration.go:767）规则化生成）只保留最近 2 个：LSN≥2 时 DROP 老快照，**DROP 失败只 logutil.Warn 不报错**（保快照优先于清理）；LSN>0 且非 stale 时查不到上一轮快照（"find 0 snapshot records by name"）返回 `moerr.NewErrStaleReadNoCtx`（iteration.go:835/846）——触发上层全量 replay 兜底。失败轮不推 LSN（重跑同 LSN 幂等）；错误经 `error_handle.go` 的 Classifier 区分可重试/不可重试，决定推进 LSN 还是置 error 状态。

`ExecuteIteration`（iteration.go:1114）入口有两个前置校验：ctx 里的 **accountID 必须为 0 或未设置**（:1154，后台任务不应携带租户上下文）、**ctx 必须无 Deadline**（:1159，iteration 自己管理超时）。收尾语义：**成功迭代用 `CurrentSnapshotTS.Physical()` 作 watermark、可重试错误用 `PrevSnapshotTS.Physical()`**（:1370/1376，失败轮的进度基准退回上一快照）；defer 中两处注销同步保护——先 `syncProtectionWorker.UnregisterSyncProtection`（本地 worker，:1248）再 `UnregisterSyncProtection`（软删除 GC 注册，:1256）。状态机全貌见概览[状态流](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview#状态流)。

executor 主循环的窗口与降级：`applyCcprLog` 的 from/to 为 **`ccprLogWm.Next()`（上次水位）到 `LatestLogtailAppliedTime()`**（executor.go:361-362）；返回 `ErrStaleRead` 时触发 `exec.replay` 全量回放兜底（:368/292）；lease 校验失败（`CheckLeaseWithRetry` 返回 !ok）时 `exec.cancel()` 停止执行器（:395）；`getCandidateTasks` 只挑 **`SubscriptionStateRunning && IterationStateCompleted`** 的任务（:476），提交前把状态改为 `IterationStatePending`（:406）再 `worker.Submit`。

### 内存控制器与 worker 池

`memory_controller.go` 的 `MemoryController` 四类内存计量，>10MB 大分配信号量限 10 并发；taskChan 容量 10000 + 三级 worker 池（worker.go:263-278）；Job/Result 对象池化。`RunStatsPrinter` 每 10s 打印 pending/running/top3 耗时——大吞吐复制任务的可观测性内建。

### 分支 diff：表级 DAG + LCA 而非全局 commit graph

表即分支节点（PTableID/CloneTS），diff 收集范围收敛到 LCA→两端的窄区间（`decideCollectRange`），多级嵌套分支统一处理——比全局 commit graph 的实现轻一个数量级。`DataBranchDAG.NewDAG`（branch_dag.go:37）**三趟构建**：第一趟建全部 Node 对象（Parent 后出现也不怕，先入 map）、第二趟连 Parent 指针、第三趟 memo 化算深度（`Depth != -1` 判已算）；`FindLCA`（:132）返回 `(lcaTableID, childTableID1, childTableID2, ok)` 四值——两节点位于不同树（lockstep 上移中任一到达根）时返回全 0/false；`PathFromAncestor` 的 `maxBranchDAGDepth = 1024`（:223）是防御性上界——**Parent 指针成环（元数据损坏）时防无限循环**。`BranchHashmap`（branch_hashmap.go）为分片 + 可 spill 的哈希表（设计见 `BRANCH_HASHMAP_DESIGN.md`），支撑两侧数据对比/合并，冲突策略 FAIL/SKIP/ACCEPT。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Job 状态机 | mo_ccpr_log 双状态字段 + Classifier | 可重试性是复制系统的第一公民 |
| future 模式 | `Job.Execute/WaitDone`（worker.go） | 异步提交-等待统一 |
| 单飞 | `running atomic.Bool` CAS（executor.go:51） | 集群内一个 CN 只跑一份 executor |
| 内存配额 | MemoryController + Job 对象池 | 大对象复制不失控 |

## 模块间交互

frontend（命令解析与 mo_ccpr_log 维护）；tae（snapshot、DiskCleaner 保护校验、分支保护快照）；taskservice（cnservice 注册 executor 工厂，统一后台任务框架调度 lease）；disttae（`SetCCPRTxn/SetCCPRTaskID` 打标绕过共享对象只读检查，iteration.go:1210）；fileservice（各 sinker 直接写 S3 对象）。

## 扩展方式

- **新增发布过滤粒度（如 column 级）**：改 `types.go` SyncLevel 常量、`sql_builder.go` 的 `ObjectListSQL/CreateCcprSnapshotSQL`、`publication_subscription.go:2899` 的 duplicateCheckSQL switch 及上游对应内部命令解析（待核实具体位置）。
- **新增分支命令（如 REBASE）**：`pkg/sql/parsers/dialect/mysql/mysql_sql.go` + `pkg/sql/parsers/tree/` 加 AST → `self_handle.go:697` 附近分发 → `data_branch.go` 的 `handleDataBranch` 加 case，复用 `diffMergeAgency`/`DataBranchDAG`。
- **调整快照保留策略**：`iteration.go:853` 的 keep-2 逻辑与 `executor.go:56-57` 的 `SnapshotThreshold/SnapshotGCThreshold` 常量。

> 待核实：上游 `OBJECTLIST`/`GETOBJECT` 内部命令的解析入口未定位（应在 frontend 内部命令处理或 disttae snapshot 读取路径）；`data_branch_hashdiff.go` 与 branch_hashmap 的分工细节未逐行核对。
