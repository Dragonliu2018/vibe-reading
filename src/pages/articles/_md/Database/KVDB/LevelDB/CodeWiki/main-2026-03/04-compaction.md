---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "Compaction"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "Compaction", "LSM-Tree", "Leveled Compaction"]
description: "leveled compaction 全流程：三类触发、Finalize 评分、PickCompaction 轮转选文件、SetupOtherInputs 边界扩展、DoCompactionWork drop 规则与 trivial move。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

Compaction 是 LSM 的自稳态机制：把"顺序写入堆积的分层文件"不断归并成更大的、更少重叠的文件，顺带完成三件清理——丢弃被新版本遮蔽的旧值、回收确认无害的墓碑、把数据推向更深的层。LevelDB 实现的是最朴素的 **leveled compaction**（对照 RocksDB 后来加的 universal/fifo），代码横跨两文件：调度与执行在 `db/db_impl.cc`（`MaybeScheduleCompaction` 起的 6 个方法），选择与约束在 `db/version_set.cc`（`PickCompaction`/`SetupOtherInputs`/`Compaction` 谓词族）。

它要平衡的三个量正是 LSM 的经典三角：**写放大**（一次合并读写 20-25 倍数据）、**读放大**（L0 文件堆积时每次读要归并多个文件）、**空间放大**（旧版本和墓碑迟迟不收）。LevelDB 的每个常量（4/8/12 触发器、10 倍层比、2MB 文件、25× 扩展上限、10× 祖先重叠上限）都是对这三者的显式回答。

## 模块架构

![Compaction 流转](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/compaction-flow.svg)

组件分四段接力：**触发判定**散布三处——`Finalize` 算 size score（写满一层）、`Version::UpdateStats` 记 seek 超额（读多触发的反向调节）、`MakeRoomForWrite` 置 `has_imm_`（切表触发落盘）；**调度器** `MaybeScheduleCompaction` 保证全局单后台任务（`background_compaction_scheduled_` 防重入，`PosixEnv` 只有一条工作线程）；**选择器** `PickCompaction` 决定"压哪层、拿哪些文件"；**执行器** `DoCompactionWork` 做真正的归并 IO。提交走 [02 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/02-version-manifest)的 `LogAndApply`——compaction 不改 MANIFEST 之外的任何元数据，产物只是"一组新文件 + 一条 VersionEdit"。

## 调用链路

```
MaybeScheduleCompaction()                   db_impl.cc:668   [持锁判定]
 └─ env_->Schedule(BGWork) → 单后台线程
BackgroundCall()                            db_impl.cc:689
 └─ BackgroundCompaction()                  db_impl.cc:708
     ├─ imm_ != null → CompactMemTable()    db_impl.cc:549  （落盘优先）
     ├─ manual_compaction_ → versions_->CompactRange(level, begin, end)
     ├─ else → VersionSet::PickCompaction() version_set.cc:1252
     │    ├─ size(score≥1) 优先于 seek(file_to_compact_)
     │    ├─ compact_pointer_[L] 之后第一个文件；无则回卷到头
     │    ├─ L0：GetOverlappingInputs 展开全部互相重叠文件
     │    └─ SetupOtherInputs(c)            version_set.cc:1385
     │         ├─ AddBoundaryInputs（同 user_key 的边界文件并入）
     │         ├─ L+1 全部重叠文件入 inputs_[1]
     │         ├─ 尝试零成本扩展 level 侧（≤25×max_file_size）
     │         ├─ L+2 重叠文件入 grandparents_（切文件约束）
     │         └─ compact_pointer_[L] = largest（轮转游标前移）
     ├─ IsTrivialMove() → 只改层号直接 LogAndApply
     └─ else DoCompactionWork(compact)      db_impl.cc:898
          ├─ smallest_snapshot = 最老快照 or LastSequence
          ├─ MakeInputIterator（MergingIterator 归并两层输入）
          ├─ [解锁] 逐条：drop 判定 → builder->Add → 超限切输出文件
          └─ InstallCompactionResults → LogAndApply
BackgroundCall 收尾：SignalAll 唤醒写者 + MaybeScheduleCompaction 链式补刀
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MaybeScheduleCompaction` in `db_impl.cc:668` | 需要就调度后台任务 | 单任务标志防重入 |
| `BackgroundCompaction` in `db_impl.cc:708` | 三分支路由 | imm_ 优先：写路径的堵点先解 |
| `CompactMemTable` in `db_impl.cc:549` | imm_ 落盘成 L0/L1/L2 表 | `PickLevelForMemTableOutput` 可直推 L2 |
| `VersionSet::PickCompaction` in `version_set.cc:1252` | 选层选文件 | size 压 seek；compact_pointer 轮转 |
| `VersionSet::SetupOtherInputs` in `version_set.cc:1385` | 扩展输入+祖先集 | 边界文件防丢数据 |
| `Compaction::IsTrivialMove` in `version_set.cc:1499` | 判可否只挪不写 | 祖先重叠 ≤10×file_size |
| `Compaction::IsBaseLevelForKey` in `version_set.cc:1517` | 墓碑下无深层引用? | `level_ptrs_` 游标线性推进 |
| `Compaction::ShouldStopBefore` in `version_set.cc:1538` | 该切输出文件了吗 | 祖先重叠字节累计超限 |
| `DBImpl::DoCompactionWork` in `db_impl.cc:898` | 归并执行 | 全程解锁做 IO |
| `DBImpl::CompactRange` in `db_impl.cc:582` | 手动全压 | 逐层递进 + ManualCompaction 状态机 |
</details>

## 核心实现

### 触发与评分：两种压力信号

**size 信号**在 `Finalize`（`version_set.cc:1031`，见 [02 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/02-version-manifest)）：L0 按文件数/4，L1+ 按层字节/10^L MB。**seek 信号**走读路径反哺：`Version::Get` 探测多个文件时给第一个文件记 seek（`Version::UpdateStats` in `version_set.cc:402`），迭代扫满 1MB（`kReadBytesPeriod`）也采样一次（`RecordReadSample`）；配额 `allowed_seeks = file_size/16384`（下限 100，`Builder::Apply` 里的换算注释：1 seek ≈ 10ms ≈ 压实 40KB 的 IO，取保守值 16KB/次）。**两种信号合流于 `NeedsCompaction()`**：`score ≥ 1 || file_to_compact_ != null`。

seek compaction 的直觉：一个文件被反复穿透（它下面的层也没命中），说明该把它与下层合并摊平——**读压力转化为布局重排**，这是 leveled compaction 独有的反馈回路。

### PickCompaction：轮转与边界

`version_set.cc:1252` 的选择逻辑两个要点：

**① compact_pointer 轮转**——每层记住上次合并的最大键，下次从它之后选第一个文件，无则回卷。这保证同层各文件雨露均沾，键空间热点区域不会被反复重写（注释原文 "Compactions for a particular level rotate through the key space"）。

**② L0 特殊展开**——L0 文件互相重叠，选了一个必须把与它重叠的都带上（`GetOverlappingInputs(0, ...)`），否则归并流会漏数据。这解释了为什么 L0 的输入可能是"最多 4 个文件"而非 1 个。

`SetupOtherInputs`（`version_set.cc:1385`）接着做三件事，件件防错：

- **`AddBoundaryInputs`**（`version_set.cc:1348`）：若输入集合的最大 user_key 在同层还有一个只含该 user_key 不同版本的相邻文件（边界文件，由 `FindSmallestBoundaryFile` 反复扫描直到收敛），必须并入——否则合并后旧版本在新层、新版本在原层，**同层序破坏会读错数据**。注释里那段 b1/b2 双文件推演就是讲这个坑，来自真实的 issue 修复。它在 `SetupOtherInputs` 里被调用**四次**：`inputs_[0]`（本层）、`inputs_[1]`（L+1 层）、`expanded0`（扩展后的本层）、`expanded1`（扩展后的 L+1）——每一侧候选集变化后都要重查边界。
- **L+1 全量重叠**：level 侧只压了一半时，L+1 侧整文件都要参与——部分重叠的文件不能被"劈开"。
- **零成本扩展**：若把 level 侧再扩几个文件不会增加 L+1 侧的文件数（且总量 ≤ `ExpandedCompactionByteSizeLimit` = 25×2MB），就扩——一次 IO 摊到更多数据。

`grandparents_`（L+2 的重叠文件集）是给执行期的切文件约束预计算的——选择期就算好，执行期 `ShouldStopBefore` 只做增量累计。

### DoCompactionWork：归并主循环与 drop 规则

`db_impl.cc:898` 的主循环是全库密度最高的一段，三段结构：

**准备**：`smallest_snapshot = snapshots_.empty() ? LastSequence() : snapshots_.oldest()->sequence_number()`——快照水位决定哪些旧版本"还有人可能看"。

**逐条处理**（`db_impl.cc:940-1015`），drop 判定两条：

```cpp title="db/db_impl.cc"
if (last_sequence_for_key <= compact->smallest_snapshot) {
  drop = true;                    // (A) 同 user_key 已见过更新的版本，且旧于快照水位
} else if (ikey.type == kTypeDeletion &&
           ikey.sequence <= compact->smallest_snapshot &&
           compact->compaction->IsBaseLevelForKey(ikey.user_key)) {
  drop = true;                    // (B) 墓碑旧于水位，且更深层没有该键 → 永久删除
}
```

规则 (A) 的语义：同一 user_key 在归并流里按 seq 降序到达，第一个到达的（最新）之后，任何 `seq ≤ smallest_snapshot` 的都是可丢的旧版本——**但快照可能还要看它们**，所以水位之前的才丢。规则 (B) 的三条件注释写得很细：本层及以上没有数据、更深层（`IsBaseLevelForKey` 查 level+2..L6，用 `level_ptrs_` 游标免全扫）也没有、下层即使有也必然更新——三者成立时删这个键等于没删。**墓碑是 LSM 里唯一会越积越贵的写**，这条规则是它唯一的出口。

循环里还有个易漏的细节：每个条目间隙检查 `has_imm_`（relaxed load），有就先去把 imm_ 落了盘（`db_impl.cc:945-953`）——**compaction 线程兼职 memtable 救火**，防止写路径在 `MakeRoomForWrite` 等 imm_ 时干等。

**输出切换**：`builder->FileSize() >= MaxOutputFileSize()`（2MB）或 `ShouldStopBefore(key)`（祖先重叠累计 > `MaxGrandParentOverlapBytes` = 10×2MB）就 `FinishCompactionOutputFile` 开新文件。后者的完整机制（`version_set.cc:1538`）：`grandparent_index_` 游标随键推进扫过 `grandparents_`，每越过一个祖先文件就把它的 `file_size` 累进 `overlapped_bytes_`（用 `seen_key_` 防重复计数）；累计超限时**返回 true 且把 `overlapped_bytes_` 清零重启**——新输出文件从零开始自己的祖先账本。调用侧的 `compact->builder != nullptr` 守卫（`db_impl.cc:952`）：`ShouldStopBefore` 在**尚无打开的输出文件**时不必切（第一个文件还没开，切无可切）。这个约束是给未来减负：现在切一刀，下次 L+1→L+2 合并就不用拖太多 L+2 数据。

**收尾**：统计（`CompactionStats` 按 level 记 micros/bytes_read/bytes_written，`GetProperty("leveldb.stats")` 可读）→ 加锁 `InstallCompactionResults`（把 outputs 填进 edit 的 `AddFile`）→ `LogAndApply`。

### trivial move 与手动压缩

`IsTrivialMove`（`version_set.cc:1499`）：单输入文件、L+1 无重叠、祖先重叠 ≤ 10×2MB——三个条件全满足时**不搬运任何字节**，只发一条 `VersionEdit`（`RemoveFile` L 层 + `AddFile` L+1 层，`db_impl.cc:745-748`）把文件改挂 L+1。这是 leveled compaction 的免费午餐，也是"新写入的冷数据快速下沉"的通道。第三个条件（`TotalFileSize(grandparents_) <= MaxGrandParentOverlapBytes`）的存在理由与 `ShouldStopBefore` 同源：注释原文 "Avoid a move if there is lots of overlapping grandparent data. Otherwise, the move could create a parent file that will require a very expensive merge later on"——现在贪这一步零拷贝，落进 L+1 的文件将来与 L+2 大面积重叠，下一次合并要拖巨额数据，**把成本转嫁给未来更贵的一次合并**，不如现在就地重写。手动压缩 `CompactRange(nullptr, nullptr)`（`db_impl.cc:582`）先用 `OverlapInLevel` 从 L1 向上找出**有文件与区间重叠的最大层** `max_level_with_files`（每层试 `TEST_CompactRange(level)`，最后压它下面全部层），然后从 L0 逐层推进 `ManualCompaction` 状态机；一次压不完（`done=false`）就把 `begin` 推到 `manual_end` 下轮再压，出错时 `m->done = true` 终止续压（`db_impl.cc:780`）。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| 状态机 | `db_impl.cc` `ManualCompaction` + `TEST_CompactRange` | 长任务跨多轮后台回调续传 |
| 谓词对象 | `version_set.cc` `Compaction::IsTrivialMove/IsBaseLevelForKey/ShouldStopBefore` | 把约束从执行循环里抽出来可单独推理 |
| 反馈回路 | `version_set.cc` `Version::UpdateStats` → `PickCompaction` | 读行为反哺写布局 |
| 模板方法 | `db_impl.cc` `BackgroundCall` 固定骨架（判定→执行→重调度→广播） | 三类任务共享调度骨架 |

## 模块间交互

上游触发信号来自写入路径（`MakeRoomForWrite`）、读取路径（`UpdateStats`/`RecordReadSample`）、用户 API（`CompactRange`）。执行期拉取 [MemTable](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/03-memtable)（imm_ 落盘）、[SSTable 格式](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/05-sstable-format)（`TableBuilder` 写输出、`MakeInputIterator` 读输入，输入侧复用 [读取路径](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/06-read-path)的全套迭代器）；元数据经 [版本管理](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/02-version-manifest)的 `LogAndApply` 提交；完成后 `RemoveObsoleteFiles` 清理。线程模型上它独占后台线程，与写者通过 `background_work_finished_signal_` 互相同意（写者等背压、它做完广播），`DoCompactionWork` 的 IO 段持锁为零。

## 扩展方式

- **调层比/触发器**：`MaxBytesForLevel` in `version_set.cc:41`、`config::kL0_*Trigger` in `db/dbformat.h:28-34`——RocksDB 把这组全变成 Options 并支持动态层高（`level_compaction_dynamic_level_bytes`）
- **加新策略**（fifo/universal）：`PickCompaction` 加分支 + `BackgroundCompaction` 允许"只删不并"——RocksDB `CompactionPicker` 家族的分化起点
- **限速**（防 compaction 抢 IO）：`DoCompactionWork` 的循环里加节流——RocksDB `rate_limiter` 的插入位就在这
- **并行 compaction**：`background_compaction_scheduled_` 单布尔改计数 + `MaybeScheduleCompaction` 允许多任务——需要先解决 `imm_`/`manual_compaction_` 的互斥
- 对应测试：`db/db_test.cc` 的 `Compact*` 系列、`db/autocompact_test.cc`、`db/version_set_test.cc`
