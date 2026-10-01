---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "Version 与 Manifest"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "MVCC", "Copy-on-Write"]
description: "Version 不可变版本链与双级引用计数、VersionSet::LogAndApply 的组提交协议、VersionBuilder 的 delta 归并、obsolete 文件延迟删除与 pending_outputs_ 防误删。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

`db/version_set.cc`（7575 行，全库最大非测试文件）是 LSM 元数据的权威：**Version** 是一个 CF 在某时刻的不可变 SST 文件视图，**VersionSet** 管理全部 CF 的 Version 链与 MANIFEST 持久化，**VersionEdit** 是增量编辑记录（AddFile/DeleteFile 等），**VersionBuilder** 把 edit 序列归并成新 Version。所有 flush/compaction 结果都要经 `VersionSet::LogAndApply` 这一个提交点。

先纠正三处旧版知识（9.11.1 核实）：旧文档的 `VersionSet::Builder` 内嵌 LevelBuilder 类**已不存在**——v5.11 起拆出独立的 `db/version_builder.cc`，用 `VersionBuilder::Rep` 的 LevelState delta + 排序归并取代；`manifest_ops.cc` 是 v8.x 拆出的小文件（只含 `GetCurrentManifestPath`）。

## 模块架构

```
ColumnFamilyData                    VersionSet
  dummy_versions_ ──环形链──> Version_1 → Version_2 → ... → current
  （current = dummy->prev_）      │ 每个版本持有 VersionStorageInfo：
                                 │   files_（L0 按 epoch 新→旧，L1+ 按 smallest key 升序）
                                 │   file_locations_ / level_files_brief_（Arena 连续快照）
                                 │   compaction_score_（每层触发分）
  flush/compaction 完成             │
       │ VersionEdit              │ LogAndApply（唯一提交点）
       ▼                          ▼
  [AddFile/DeleteFile/WalAddition...]
       └──── Builder delta（unordered_map per level）──SaveTo 归并──> 新 Version
            → MANIFEST 写入（log::Writer 32KB 分段）→ CURRENT 原子切换 → AppendVersion 上链
```

## 调用链路

```
flush/compaction 完成
├─ FlushJob：edit_->AddFile(0, meta)（flush_job.cc:1073）
├─ CompactionJob::InstallCompactionResults（compaction_job.cc:1802）
│    ├─ compaction->AddInputDeletions(edit)：每个输入文件一条 DeleteFile
│    ├─ sub_compact.AddOutputsEdit(edit)：每个输出 AddFile(output_level, meta)
│    └─ manifest_wcb = ReleaseCompactionFiles（写盘完成后解除 being_compacted）
└─ versions_->LogAndApply(cfd, ..., edit, ...)（version_set.cc:5910）
     1. ManifestWriter{cv, cfd, edit_list, wcb} 入 manifest_writers_ 队列；
        非队首则 cv.Wait() 睡眠（组提交）
     2. 队首成为 leader → ProcessManifestWrites（:5276）
        ├─ 批量吸收后续 writer（CF 增删不允许合并）
        ├─ LogAndApplyHelper → builder->Apply(edit) 塞进 delta
        ├─ builder->SaveTo(versions[i]->storage_info())：base+delta 排序归并
        ├─ [解锁] LoadTableHandlers 预取 table reader
        ├─ MANIFEST 过大 → WriteCurrentStateToManifest 全量快照滚动新文件
        ├─ 逐条 edit->EncodeTo + AddRecord → SyncManifest fsync
        └─ SetCurrentFile 原子切换 CURRENT 指针（:5670）
     3. [回锁] AppendVersion（:5248）：ComputeCompactionScore → SetFinalized
        → 旧 current Unref → SetCurrent(v) + Ref → 挂链尾
     4. 唤醒全部覆盖的 writer + 新队首

DB::Open 的 Recover（version_set.cc:6055）
└─ GetCurrentManifestPath（manifest_ops.cc:13）读 CURRENT
   → log::Reader 逐条 edit.DecodeFrom → VersionEditHandler::Iterate
   → builder->Apply(&edit)（回放进 delta，不产生中间 Version）
   → CheckIterationResult 末尾一次性 SaveTo 落出初始 Version
```

方法速查：

<details>
<summary>关键方法速查表</summary>

| 方法 | 位置 | 一行职责 |
| --- | --- | --- |
| `LogAndApply` | `version_set.cc:5910` | 版本提交唯一入口（排队→leader 批量→MANIFEST→上链） |
| `ProcessManifestWrites` | `:5276` | leader 的批量提交主体 |
| `AppendVersion` | `:5248` | 新 Version 上链 + 旧 current 降引用 |
| `VersionBuilder::Apply` | `version_builder.cc:934` | edit 回放进 LevelState delta |
| `VersionBuilder::SaveTo` | `:1429` | base+delta 排序二路归并出新 Version |
| `Version::Ref/Unref` | `version_set.cc:4275` | 版本级引用计数 |
| `WriteCurrentStateToManifest` | `:6596` | MANIFEST 滚动时的全量快照重写 |
| `GetObsoleteFiles` | `:7263` | 延迟删除队列的出队过滤 |
| `Recover` | `:6055` | Open 时回放 MANIFEST 建初始 Version |

</details>

## 核心实现

### FileMetaData 与 VersionStorageInfo

```cpp title="db/version_edit.h:178（节选）"
struct FileMetaData {
  FileDescriptor fd;              // file number+path_id、file_size、smallest/largest_seqno
  InternalKey smallest, largest;  // 文件 key 边界
  uint64_t compensated_file_size; // 删除条目补偿后的"有效"大小（compaction 优先级用）
  int refs = 0;                   // 跨多 Version 共享同一对象的引用计数
  bool being_compacted = false;
  uint64_t epoch_number;          // L0 中越大越新
  UniqueId64x2 unique_id{};       // SST 去重 id
};
```

`VersionStorageInfo`（`version_set.h:130`）的派生结构全部在 `PrepareForVersionAppend`（`:3080`）一次性构建：`level_files_brief_` 把文件元数据拷进**连续 Arena 内存**（读路径 FindFile 二分只摸这片，cache 友好）；`file_locations_` 支持 file_number → (level, position) 的 O(1) 反查（Builder 用它校验"从 L3 删一个实际在 L5 的文件"这类损坏）；`compaction_score_` 每层触发分。

### Version 为什么不可变

文件头注释直说（`version_set.h:10`）：older versions "provide a consistent view to live iterators"。机制推论：`Version::Get/AddIterators` 全程不持 DB mutex（`version_set.h:915` 的 REQUIRES），读线程只需拿引用瞬间持锁，之后遍历的结构永远不被修改；**未变化的文件在新旧 Version 间直接共享同一个 `FileMetaData*`**（Builder 归并传指针），COW 的拷贝成本正比于变更文件数。可变状态被刻意隔离：`being_compacted` 由 compaction 线程持 mutex 写，`num_reads_sampled` 是 atomic，文件统计"只能由单线程 LogAndApply 线程读写"（`version_edit.h:196` 注释）。

### 一个 MANIFEST 全 CF 共享的三个理由

每条记录带 `column_family_` tag（默认 0 不写），回放时按 CF 分流到各自的 VersionBuilder。为什么不用 per-CF manifest：(a) **跨 CF 原子性**——多 CF 批量 LogAndApply + `kInAtomicGroup` 原子组（2PC 跨 CF 提交用）保证要么全部可见要么全不可见；(b) **单一提交点**——CURRENT 一个指针，`SetCurrentFile` 一次 rename 原子生效，per-CF 需要 N 文件两阶段提交；(c) **组提交摊薄 fsync**。代价：MANIFEST 滚动时 `WriteCurrentStateToManifest`（`:6596`）要重写所有 CF 的全量快照——代码里留着 TODO 承认 CF 很多时的重写放大。

### 双级引用计数与延迟删除

`Version::refs_` 保护版本对象（current 链头 1 + 每个活 SuperVersion/迭代器/snapshot 各 1）；`FileMetaData::refs` 保护文件元数据与物理文件生存期（同一文件跨版本是同一对象）。`~Version`（`:846-873`）归零时不删文件而是**push 进 `vset_->obsolete_files_` 待删队列**——把"元数据死亡"与"物理删除"解耦。删除链：`FindObsoleteFiles`（`db_impl_files.cc:124`）→ `GetObsoleteFiles` 的过滤规则是 **`file_number < min_pending_output`** 才交给删除者——`min_pending_output = *pending_outputs_.begin()`，每个后台 job 启动时把当时的 file number 插进集合。`db_impl.h:2899` 注释解释这个设计的巧妙：**正在被 compaction 写、还没提交进任何 Version 的输出文件，编号必然大于所有在册文件**——用"编号单调"一个不变量挡住全部 in-flight 文件，无需精确登记。另有两条防线：MANIFEST 写失败时 `files_to_quarantine_` 隔离新文件；trivial move 场景 `only_delete_metadata` 只删元数据不删文件。

### VersionBuilder：delta 归并与零中间版本

每个 level 维护 `LevelState{deleted_files(集合), added_files(map)}`；`Apply(edit)` 顺序处理文件删除（先查当前位置防跨层误删）与新增；`SaveTo` 把 added 排序（L0 按 epoch 新→旧、L1+ 按 smallest key）后与 base 双指针归并，`MaybeAddFile` 过滤 deleted 命中者。**回放 10 万条 edit 也只建 1 个 Version**——`version_set.h:33` 注释点明动机。归并完跑 `CheckConsistency`（L0 排序合法、同 epoch 不重叠、L1+ 严格排序不重叠）——对"MANIFEST 被写坏"的第一道运行时防线。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| COW 不可变版本 + 环形链表 | `dummy_versions_` 双向环 | O(1) 头尾插删，读无锁 |
| Builder 增量归并 | `version_builder.cc:99` 的 LevelState | 零中间版本物化 |
| Writer 队列 + 组提交 | `ManifestWriter` + `manifest_writers_` | MANIFEST fsync 摊薄 |
| 模板方法 | `VersionEditHandlerBase::Iterate` 骨架 + 派生（正常恢复/时点恢复/ManifestTailer/Dump） | 回放逻辑复用 |
| 前向兼容 tag | `kTagSafeIgnoreMask`（`version_edit.h:104`） | 未知 tag 跳过，降级打开 |

## 模块间交互

**compaction/flush**：产出 edit 经 LogAndApply 提交；`manifest_wcb` 回调在写盘后解除输入文件占用。**table_cache**：`FileMetaData::fd.table_reader` 是 pin 在 table cache 的句柄；`LoadTableHandlers` 在解锁阶段批量预取（限容量 1/4）。**db_impl**：`InstallSuperVersionAndScheduleWork` 让新 current 经 SuperVersion 原子对读者可见；`FindObsoleteFiles/PurgeObsoleteFiles` 消费 obsolete 队列。**snapshot/迭代器**：对旧 Version `Ref()`，使旧文件在迭代器存活期间不被删除。**WAL**：WAL 的创建/删除本身也以 `kWalAddition2/kWalDeletion2` 记进 MANIFEST（`wal_edit.cc`）。

## 扩展方式

**给 FileMetaData 加持久化字段**：`version_edit.h` 加字段（手动更新 `ApproximateMemoryUsage`）→ `version_edit.cc` 的 kNewFile4 自定义字段循环加 tag（**新 tag 必须不带 `kCustomTagNonSafeIgnoreMask`** 才允许旧版本降级打开）→ `DecodeNewFile4From` 的 switch 加分支 → `VersionEdit::AddFile` 重载与 ~20 处调用点同步。

**改 MANIFEST 提交/失败语义**：重读 `ProcessManifestWrites` 失败分支（`:5794-5849`）——完整回滚语义的现成范例：builder_guards 析构自动 Unref、`descriptor_log_.reset()` 强制换新 MANIFEST、区分"追加失败（可删新文件）"与"CURRENT rename 失败（非本地 FS 上远端可能已成功，必须保留）"。
