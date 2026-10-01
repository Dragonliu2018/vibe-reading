---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "DBImpl 与 ColumnFamily"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "Architecture"]
description: "DBImpl 中枢编排：Open/Close 阶段链、flush 与 compaction 分池调度、ColumnFamilyData 延迟删除、SuperVersion 线程本地发布、五种实例形态。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

`db/db_impl/`（16 文件 ~24.5k 行）+ `db/column_family.cc/h`（2808 行）。头文件自述（`db_impl.h:182`）："While DB is the public interface of RocksDB, DBImpl is the actual class implementing it. It's the entrance of the core RocksDB engine"——TransactionDB/BlobDB 都在内部包一个 DBImpl。DBImpl 是单中枢：持有全部子系统指针（VersionSet/WriteThread/WriteController/WalManager/ErrorHandler/线程池），文件按职责裂变为 `db_impl_{write,open,compaction_flush,files,secondary,follower}.cc`。

## 模块架构

```
DBImpl（成员按职责分区：选项/版本核心/锁/写路径/WAL 状态/后台队列/快照/清理）
  mutex_（CacheAlignedInstrumentedMutex，主锁——hot lock 独占 cacheline）
  ├─ versions_（VersionSet）+ table_cache_
  ├─ write_thread_ / nonmem_write_thread_（双队列）+ write_controller_
  ├─ flush_queue_ / compaction_queue_ + unscheduled_/bg_scheduled_/num_running_ 计数
  ├─ snapshots_（SnapshotList）+ periodic_task_scheduler_
  └─ error_handler_ + pending_outputs_（in-flight 文件保护）

ColumnFamilyData（每 CF）
  ├─ mem_ / imm_ / super_version_（+ ThreadLocalPtr local_sv_ 线程本地缓存）
  ├─ dummy_versions_ 环形链（Version 链锚点）
  ├─ mutable_cf_options_（DB mutex 保护，SetOptions 热改目标）
  └─ compaction_picker_（按 compaction_style 选定）

SuperVersion = {mem, imm, current Version} 三元组
  读路径经 GetThreadLocalSuperVersion 免 DB mutex 取快照
```

## 调用链路

```
DB::Open（db_impl_open.cc:2319，13 步）
  校验 → new DBImpl → Recover（锁文件/回放 MANIFEST+WAL，见 08）
  → 新建 WAL → LogAndApplyForRecovery（恢复期 edit 原子提交）
  → 各 CF InstallSuperVersion → DeleteObsoleteFiles
  → MaybeScheduleFlushOrCompaction（首次调度）→ 周期任务启动

后台调度 MaybeScheduleFlushOrCompaction（db_impl_compaction_flush.cc:2834）
  ├─ 闸门：!opened_successfully_ / bg_work_paused_ / bg error / shutting_down_
  ├─ flush 侧：while (bg_flush_scheduled_ < max_flushes && unscheduled_flushes_ > 0)
  │     env_->Schedule(BGWorkFlush, Env::Priority::HIGH)
  │     （特例：HIGH 池空则 flush 借 LOW 池——兼容降级，:2879 注释）
  └─ compaction 侧：while (bg_compaction_scheduled_ + bg_bottom_compaction_scheduled_
              < max_compactions && unscheduled_compactions_ > 0)
        env_->Schedule(BGWorkCompaction, Env::Priority::LOW)

BackgroundCallFlush（:3307）循环
  持锁 num_running_flushes_++ → BackgroundFlush（PopFirstFromFlushQueue
  → FlushJob 执行 → cfd->UnrefAndTryDelete）
  → 失败则解锁睡 1s 重锁（防环境故障空转）
  → FindObsoleteFiles → 解锁 PurgeObsoleteFiles + job_context.Clean()
  → MaybeScheduleFlushOrCompaction ★ 做完再调度，直至队列空
  → bg_cv_.SignalAll（:3395 注释：SignalAll 之后不得再碰 DB 成员——
     可能唤醒 ~DBImpl 立即析构）

Close 逆序（db_impl.cc:540）
  shutdown_initiated_ → CancelAllBackgroundWork → 三池 UnSchedule
  → 等 bg_*_scheduled_ 归零 → 排空队列逐个 UnrefAndTryDelete
  → 最终 FindObsoleteFiles+Purge → versions_->Close() → UnlockFile
```

## 核心实现

### flush 与 compaction 为什么分线程池

flush 慢会**直接卡死写路径**（memtable 满必须 flush 才能切表、才能删旧 WAL、才能继续写）；compaction 是长时任务且可积压。所以 flush 进 HIGH 池、compaction 进 LOW 池（`:2862-2877`），bottommost compaction 另有 BOTTOM 池。`GetBGJobLimits`（`:2935`）：`max_background_flushes == -1 && max_background_compactions == -1` 时按 **`max_flushes = max(1, max_background_jobs/4)`** 推导、余量全给 compaction；**写反压与 compaction 并发度联动**——`write_controller_.NeedSpeedupCompaction()` 为 false 时 max_compactions 压到 1（写没压力就不浪费 IO）。

### unscheduled_ 计数：调度可见性

没有它，调度器无法知道"队列里有活但还没派线程"（`db_impl.h:2926` 注释原文）。它还让 `WaitForCompact` 能区分"没活"与"活还没被领走"。**错误路径必须把计数加回去**（BackgroundCompaction 失败 `:3577`、独占 manual 冲突 `:3648`、TaskLimiter 节流 `:3657`）——否则计数泄漏导致永久少派线程，这是该状态机最容易漏改的地方。

### ColumnFamilyData 的延迟删除

`SetDropped`（`column_family.cc:773`）只摘 map 不删对象——头注释（`h:322`）：dropped CF 的文件与内存保留到客户 drop handle，期间**还能读**。原因：CFD 被三方可持有——用户 handle、flush/compaction 队列（入队即 Ref）、SuperVersion（`SuperVersion::Init` 反向 Ref，Cleanup 时解）。`UnrefAndTryDelete` 的 `old_refs==2` 分支专门处理"只剩 SV 持有"的 CFD↔SV 双向引用环收尾。

### SuperVersion：读免锁的发布协议

`GetThreadLocalSuperVersion`（`column_family.cc:1323`）：`local_sv_->Swap(kSVInUse)` 取线程本地缓存；被后台 Scrape 换成 `kSVObsolete` 则加锁取 `super_version_->Ref()`。`InstallSuperVersion`（`:1371`）的顺序：新 SV Init → 换 `super_version_` → `ResetThreadLocalSuperVersions()`（Scrape 全部线程本地）→ 旧 SV Unref——**先 Scrape 再 Unref**，保证线程本地永不持最后引用（`:1400` 注释）。`db/column_family.h:80-130` 的 ASCII 图是理解整套引用网的最好材料。

### 五种实例形态（同一骨架的模板方法）

`Recover/GetImpl/CloseImpl/OwnTablesAndLogs` 是 virtual 钩子，四个子类只换姿态：**ReadOnly**（写接口全返回 NotSupported）、**Secondary**（`ReactiveVersionSet::Recover` 增量 tail MANIFEST + WAL 尾部回放，`TryCatchUpWithPrimary` 拉平；文件可能被 primary 删掉 → IOError 契约）、**Follower**（2024 新增，继承 Secondary：`NewOnDemandFileSystem` 按需从 leader 拉 SST 建本地链接 + 常驻 catch-up 线程）、**CompactedDBImpl**（compacted 只读形态）。secondary/follower 的意义：**读扩展不需要逻辑复制**——副本一致性由 MANIFEST 回放天然保证。

### JobContext 与 pending_outputs_

`JobContext`（`job_context.h:111`）是单个后台任务的"垃圾集"——把分配/析构/listener 通知推到 DB mutex 之外（`h:25` 注释），`Clean()` 必须在锁外至少调一次。`pending_outputs_`（`db_impl.h:2899` 注释）："This technique avoids the need for tracking the exact numbers of files pending creation"——文件号单调递增，只需记住每个在跑 job 的起点号，删除永不越过最小在途号。保守但 O(1)。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单中枢 + 子系统 | DBImpl 持有全部子系统指针 | 内部协作的总线 |
| 模板方法 | virtual 钩子 + 四形态子类 | 换姿态不换骨架 |
| 线程池分池 + 优先级 | HIGH=flush/LOW=compaction/BOTTOM | 防互相饿死 |
| 三层引用网 | CFD refs + SuperVersion refs + ThreadLocalPtr 协议 | 无锁读的地基 |
| 两阶段锁外清理 | JobContext 锁内记账 + 锁外 Clean | 缩短临界区 |
| 计数器状态机 | unscheduled → scheduled → running | 调度/等待/关闭全部无锁可见 |

## 模块间交互

**write**：`WriteImpl → PreprocessWrite → ScheduleFlushes/SwitchWAL`；`write_controller_.NeedSpeedupCompaction()` 反向改变 compaction 并发上限。**memtable**：`flush_scheduler_.ScheduleWork` 五处调用点。**version**：产物经 LogAndApply 装 Version，再经 `InstallSuperVersionAndScheduleWork`（`db_impl_compaction_flush.cc:4275`，**所有 CF 状态变化的统一收口**：装 SV → 入队 → 调度 → 更新内存统计）。**文件层**：`FindObsoleteFiles/PurgeObsoleteFiles` 联动 SstFileManager/DeleteScheduler 限速删除。

## 扩展方式

**新增后台触发源**（如新 flush reason）：`FlushReason` 枚举加值 → `GenerateFlushRequest` 与 `BackgroundFlush` 的放行/重排检查（`:3189-3235`，参照 UDT retain 的 `Status::TryAgain` 重排模式）→ 计数器自动覆盖。现成范例：v9.x 的 `kErrorRecoveryRetryFlush`。

**新增周期任务**：`PeriodicTaskType` 加枚举 + 两张默认表 + DBImpl 构造 `periodic_task_functions_.emplace` + `StartPeriodicTaskScheduler` 注册——参照 `kRecordSeqnoTime` 的完整接线。

**调整后台并发策略**：改 `GetBGJobLimits` 的切分公式或调度 while 条件，同时**审计 `UnscheduleCompactionCallback`（`:3120`）与错误回补路径的计数一致性**——最易漏改处。
