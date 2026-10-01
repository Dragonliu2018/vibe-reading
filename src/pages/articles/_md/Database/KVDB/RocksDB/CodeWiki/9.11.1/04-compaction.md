---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "Compaction"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "LSM-Tree", "Compaction"]
description: "三种 CompactionPicker 策略（leveled score/universal size-ratio/fifo）、CompactionJob 三段式执行、CompactionIterator 的快照约束去重决策链、grandparent overlap 文件切分。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

`db/compaction/`（~29k 行，非测试 ~7.5k）是 LSM 的心脏——所有去重、垃圾回收、空间整理都在这里。职责四件套：**CompactionPicker**（按 leveled/universal/fifo 三种策略挑输入文件）、**CompactionJob**（三段式执行 Prepare→Run→Install，多 subcompaction 并行）、**CompactionIterator**（逐 key 决策：同 user key 旧版本去重、tombstone 底层丢弃、merge 归并）、**CompactionOutputs**（输出 SST 切分）。`db/flush_job.cc` 是同构退化版（flush 也复用 CompactionIterator，但传 `compaction=nullptr`）。

版本勘误：9.11.1 的调度入口是 `MaybeScheduleFlushOrCompaction`（`db_impl_compaction_flush.cc:2834`），旧文档的 `MaybeScheduleFlushCompaction` 已更名。

## 模块架构

```
VersionStorageInfo::ComputeCompactionScore（version_set.cc:3424）
  L0 score = 文件数 / level0_file_num_compaction_trigger（默认 4）
  Ln score = 层字芏 / MaxBytesForLevel(n)
        │ score ≥ 1
        ▼
CompactionPicker（策略模式，按 compaction_style 选定）
  ├─ LevelCompactionPicker → LevelCompactionBuilder（:56）
  │    SetupInitialFiles → SetupOtherL0Files → SetupOtherInputs → GetCompaction
  ├─ UniversalCompactionPicker → UniversalCompactionBuilder（:55）
  │    periodic → size-amp → size-ratio → read-amp 兜底
  └─ FIFOCompactionPicker（TTL/大小淘汰）
        │ Compaction（输入/输出级、grandparents、score 的不可变描述）
        ▼
CompactionJob::Prepare（持锁：GenSubcompactionBoundaries 切 key 区间）
  → Run（无锁：每 subcompaction 一线程）
      ClippingIterator（裁剪边界）→ BlobCountingIterator → CompactionIterator
        （决策状态机：去重/丢 tombstone/merge）→ CompactionOutputs
        （ShouldStopBefore 切文件 + TableBuilder 写 SST）
  → Install（持锁：VersionEdit → LogAndApply → 新 Version）
```

## 调用链路

```
BackgroundCompaction（db_impl_compaction_flush.cc:3526）
├─ PickCompactionFromQueue（score 最高的 CF）
├─ cfd->PickCompaction → LevelCompactionBuilder::PickCompaction
│    ├─ SetupInitialFiles（compaction_picker_level.cc:202）
│    │    首个 score≥1 的层 → PickFileToCompact 选 seed
│    │    失败则回退 intra-L0 / TTL / periodic / blob GC 等次级理由
│    ├─ SetupOtherL0FilesIfNeeded（:328）L0 全量拉入（L0 文件互相重叠）
│    ├─ SetupOtherInputsIfNeeded（:460）
│    │    ├─ GetOverlappingInputs 拉入父层重叠文件
│    │    ├─ CompactionPicker::SetupOtherInputs（compaction_picker.cc:461）
│    │    │    在不增加父层文件数的前提下继续扩 start level（写放大换空间）
│    │    └─ GetGrandparents（:586）output_level+1 的重叠文件
│    └─ GetCompaction（:539）new Compaction + RegisterCompaction
│         （被标记文件 being_compacted=true 防并发冲突）
├─ compaction_job.Prepare（持锁：L0→L1+ 且 max_subcompactions>1 时
│    GenSubcompactionBoundaries（compaction_job.cc:494）——
│    TableReader::ApproximateKeyAnchors 每 SST ~128 个 anchor，
│    按 total_size/N 切出 N-1 个 boundary key）
├─ mutex_.Unlock() → compaction_job.Run()（:669）
│    每个 sub_compact 一线程 ProcessKeyValueCompaction（:1126）
│      ├─ MakeInputIterator（MergingIterator 合并输入层）
│      ├─ new CompactionIterator(input, ..., snapshots, snapshot_checker)
│      ├─ while c_iter->Valid():
│      │    sub_compact->AddToOutput(*c_iter, ...)
│      │    └─ CompactionOutputs::AddToOutput（compaction_outputs.cc:357）
│      │        ShouldStopBefore（:231）→ 切文件或 builder_->Add
│      └─ AddRangeDels：range tombstone 按输出边界截断写入
├─ mutex_.Lock() → compaction_job.Install（:3953）
│    └─ InstallCompactionResults（:1802）
│         AddInputDeletions + AddOutputsEdit → LogAndApply
└─ InstallSuperVersionAndScheduleWork（也许再调度下一个）
```

## 核心实现

### 为什么 leveled 用 score 驱动

`ComputeCompactionScore`（`version_set.cc:3424`）：L0 score 按**文件数**而非字节数（`:3441-3451` 注释：L0 文件每次读都要 merge，且避免大 write buffer 下频繁 compaction）；L1+ score = 层字节 / 目标字节。leveled 的不变量是"L_n 大小 ≤ base × multiplier^n"，score≥1 即不变量被打破——直接度量"离目标形状多远"，天然形成跨层优先级排序。9.x 增强：score>1 后乘 `kScoreScale=10`（`:3436`）放大区分度；`dynamic_level_bytes` 下 L0 `total_size ≥ max_bytes_for_level_base` 时 score 至少抬到 **1.01**（`:3517-3524`，巨型 L0 兜底）；level>0 超限时 score 的**分母**变为 `MaxBytesForLevel(level) + total_downcompact_bytes` 再乘 10（`:3530-3550`——上层正在下压的数据到达时降低本层优先级，避免重复搬移；L0→LBase 的优先级因此高于 LBase→LBase+1）；`compensated_file_size` 把删除条目按 2 倍均值折算进文件大小——tombstone 多的文件"看起来更大"从而优先被 compact（tombstone 只有 compact 才释放空间）。

### clean cut：扩展输入的硬约束

`ExpandInputsToCleanCut`（`compaction_picker.cc:219`）的动机写在头注释（`compaction_picker.h:169`）：如果一个 user key 的新版本被 compact 到 L(n+1) 而旧版本留在 L(n)，Get 会先搜 L(n) 返回 stale 值，还会打乱 merge operand 顺序。所以 do-while 用 `GetOverlappingInputs` 反复扩直到文件集与邻接文件的用户键边界"干净"——**同一 user key 的所有版本要么全进要么全不进**。`SetupOtherInputs`（`:461`）再做第二层扩展：不增加父层文件数且总量小于 `2×max_compaction_bytes` 时尽量多带——一次搬更多数据降写放大，硬约束防 compaction 无限膨胀。

### universal 的 size-ratio 与"连续全家桶"

`UniversalCompactionBuilder::PickCompaction`（`compaction_picker_universal.cc:567`）优先级：periodic → size-amp → size-ratio → read-amp 兜底。size-ratio 逻辑（`PickCompactionToReduceSortedRuns:802`）：从最新 sorted run 往旧扫，只要 `candidate_size × (100+ratio)/100 ≥ 下一个 run 的大小`就继续吸收，凑够 `min_merge_width` 个合并整段。**为什么**：universal 的核心是每个 sorted run 全局有序、新数据总在新 run；合并"大小相近的连续段"保证合并后大文件的下次参与者几何级增长（size-tiered 思想），写放大摊还 O(1)。大小悬殊还合并等于反复重写大文件，ratio 挡住"小黏大"。size-amp 是空间放大硬约束：新数据总量超过最老 run 的 `max_size_amplification_percent` 倍时，从那个 run 到最新全部合并。

### CompactionIterator 的决策链与 snapshot 约束

核心是 `NextFromInput()`（`compaction_iterator.cc:451-1106`）的长决策链。**rule (A)**（`:870`）最关键：

```cpp title="db/compaction/compaction_iterator.cc:870（节选）"
} else if (last_sequence != kMaxSequenceNumber &&
           (last_snapshot == current_user_key_snapshot_ ||
            last_snapshot < current_user_key_snapshot_)) {
  // If the earliest snapshot in which this key is visible in
  // is the same as the visibility of a previous instance of
  // the same key, then this kv is not visible in any snapshot.
  ++iter_stats_.num_record_drop_hidden;   // rule (A)
  AdvanceInputIter();
```

同一 user key 的旧版本，只有当它与"已输出的新版本"落在**同一 snapshot 可见域**（`findEarliestVisibleSnapshot` 返回相同 snapshot，write-prepared 下还要问 `snapshot_checker_->CheckInSnapshot`）时才能删。反之两者隔着某个 snapshot，旧版本必须保留给那个快照读。tombstone 丢弃加码：只有 `DefinitelyInSnapshot(seq, earliest_snapshot)` **且** `KeyNotExistsBeyondOutputLevel(user_key)`（`compaction.cc:645`，用 level_ptrs_ 游标扫输出层之下各层确认没有同 key 旧数据）才可丢。`PrepareOutput`（`:1256`）在 bottommost + 早于最早快照 + 已提交时把 seq 置零——"Zeroing out the sequence number leads to better compression"。

### 输出切分：控制的是下次 compaction 的规模

`CompactionOutputs::ShouldStopBefore`（`compaction_outputs.cc:231`）除 `max_output_file_size` 外有三条 grandfather 规则：(a) `grandparent_overlapped_bytes + 当前输出 > max_compaction_bytes`——注释明说"prevent future bigger than max_compaction_bytes compaction"：这个输出将来下沉时要与 grandparent 层重叠文件合并，现在限制和就是限制未来那次 compaction 的输入规模；(b) 跨 ≥2/3 个 grandparent 边界且新增重叠 > target_file_size/8（注释给出 L0/L1/L2 图示反例）；(c) 自适应预切：阈值 = 50% + 5%×已见边界数封顶 90%（`:344`）。

### trivial move 与 subcompaction

`Compaction::IsTrivialMove`（`compaction.cc:557`）：单输入层、无重叠、路径/压缩一致、与 grandparent 重叠小于 max_compaction_bytes 时，只改 VersionEdit 移动文件零 IO。subcompaction 边界用 anchor **估算**而非精确扫描（`compaction_job.cc:494` 头注释）：精确统计要全量扫输入等于把 compaction 做两遍；边界只是负载均衡提示，正确性由 ClippingIterator 的 clean-cut 边界保证。限定 leveled 下只有 L0→L1+ 或 manual 才并行——L1+ 单个输入文件通常已小于 target_file_size，切分调度开销不划算（`compaction.cc:916`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `CompactionPicker` 基类 + 三实现 + `NullCompactionPicker` | compaction 形态可插拔 |
| Builder | `LevelCompactionBuilder`/`UniversalCompactionBuilder` | 把挑选分解为可回退的步骤链 |
| 迭代器装饰链 | MergingIterator → ClippingIterator → BlobCountingIterator → CompactionIterator | 决策语义逐层叠加，复用 InternalIterator 接口 |
| Proxy/依赖收窄 | `CompactionIterator::CompactionProxy`（`compaction_iterator.h:87`） | 只依赖 9 个方法的窄接口，测试可注入 |
| 回调注入 | `CompactionFileOpenFunc/CloseFunc` lambda | 输出管理层不知道文件怎么开关 |

## 模块间交互

**version_set**（双向）：输入来自 `VersionStorageInfo` 的 score/文件列表/FilesByCompactionPri；结果经 `LogAndApply` 安装，`manifest_wcb` 回调解除 `being_compacted`。**table_builder/table_cache**：输出走 `outputs.NewBuilder()`；输入经 `MakeInputIterator`；subcompaction 边界的 anchor 估算也来自 TableReader。**snapshot 系统**：`GetSnapshotContext` 拿 snapshot_seqs/snapshot_checker 传入——丢弃决策的约束来源。**BlobDB**：`BlobFileBuilder` 在 iterator 中被调用抽大 value；`BlobGarbageMeter` 做进出流量对账。**远程 compaction**：`compaction_service_job.cc:22` 把输入序列化交远端执行，失败回退本地。

## 扩展方式

**新增 compaction 触发理由**：`ComputeXxxFiles()`（`version_set.cc:3630+`）注册被标记文件 → `SetupInitialFiles` 回退链加分支并赋 `CompactionReason` → universal 侧加优先级序。

**调整输出切分策略**：集中改 `ShouldStopBefore`——预切公式（50%+5%/边界）、skippable 阈值（/8）或 sst_partitioner 规则；对应测试 `compaction_job_test.cc`（2413 行）。

**新增 key 版本语义（影响丢弃）**：`NextFromInput` 决策链加分支——现成参照 `kTypeValuePreferredSeqno` 的 seq 换入分支（`:971-1025`，含 range tombstone 交互的安全论证）；同步构造参数与 `compaction_iterator_test.cc`（CompactionProxy 注入点）。
