---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "版本管理与 Manifest"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "Version", "MANIFEST", "元数据"]
description: "VersionSet/Version/VersionEdit 三层版本模型：MANIFEST 重放日志、Builder 增量装配、Finalize 压实评分、AppendVersion 环链与引用计数。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

这一模块回答 LSM 的元数据问题：**"磁盘上此刻有哪些文件、属于哪一层"由谁记账、如何原子地变更、崩溃后如何找回**。答案是一套三层模型（全在 `db/version_set.h` 头部 20 行注释里写得明明白白）：

- **`Version`**：一份不可变的层视图（`files_[7]`），读操作在它上面无锁运行
- **`VersionSet`**：全部 Version 的持有者 + MANIFEST 的读写者
- **`VersionEdit`**（`db/version_edit.h`）：一次变更的差异记录（加了哪些文件、删了哪些、水位线挪到哪）

它是读、写、compaction 三条链路的交汇点——`Get` 从 `current_` 取视图，compaction 产出的新文件经 `LogAndApply` 变成新 Version，恢复时从 MANIFEST 重放出生时的视图。`db/version_set.cc` 1569 行是引擎第二大文件，但结构对称清晰。

## 模块架构

```
                    VersionSet（每 DB 一个）
                    ├─ dummy_versions_ ⇄ Version ⇄ Version ⇄ ...（环形双链，尾=最老）
                    │                        └─ current_ = dummy_versions_.prev_
                    ├─ Builder（每次 LogAndApply 一个）
                    │     levels_[7]: { deleted_files:set, added_files:FileSet(按smallest排序) }
                    ├─ descriptor_file_ + descriptor_log_   ← MANIFEST 打开的句柄
                    ├─ next_file_number_ / manifest_file_number_
                    ├─ last_sequence_ / log_number_ / prev_log_number_
                    └─ compact_pointer_[7]                  ← 每层下次 compaction 起点
VersionEdit（一次性差异）                FileMetaData（文件卡）
  new_files_ (level, FileMetaData)        refs / allowed_seeks / number / file_size
  deleted_files_ (level, number)          smallest / largest (InternalKey)
  compact_pointers_ / 水位线四元组
```

内部结构的设计主线是**不可变 + 引用计数**：Version 一旦上线永不修改（files_ 只在构造时经 `Builder::SaveTo` 填充），旧 Version 只要有活跃读/迭代器引用就活着，引用归零自毁并给 `FileMetaData::refs` 减一——文件删除（`RemoveObsoleteFiles`）因此天然安全：它只需要问 `AddLiveFiles`（扫全部 Version）"还有哪只活 Version 提到你"。

## 调用链路

```
LogAndApply(edit, mu)                        version_set.cc:777
 ├─ 补全水位线（log_number/next_file/last_sequence 默认填当前值）
 ├─ Builder builder(this, current_)
 │   ├─ builder.Apply(edit)                  version_set.cc:637
 │   │    └─ 逐 level：删号入 set、新 FileMetaData(带 allowed_seeks 配额) 入 FileSet
 │   └─ builder.SaveTo(v)                    version_set.cc:653
 │        └─ 每 level 归并 base_ 旧文件与 added，跳过 deleted → v->files_[level]
 ├─ Finalize(v)                              version_set.cc:1031
 │   └─ 每 level 算 score（L0: 文件数/4；L+: 字节/10^L MB），取最大者存入 v
 ├─ [首个 edit] 新 MANIFEST 文件 + WriteSnapshot(全量 VersionEdit)
 ├─ mu->Unlock()
 │   ├─ edit->EncodeTo(&record); descriptor_log_->AddRecord(record)
 │   └─ descriptor_file_->Sync()
 │   └─ [新 MANIFEST] SetCurrentFile(tmp 写 + rename 原子切换)   filename.cc:123
 ├─ mu->Lock()
 └─ AppendVersion(v)（current_ 切换 + 环链挂接 + 旧 current Unref）
```

MANIFEST 的原子性在最后一步：新记录先落盘 Sync，**CURRENT 文件的 rename 才是提交点**（`SetCurrentFile` in `db/filename.cc:123`：写 `.dbtmp` 同步后 rename 成 CURRENT）——崩溃在任何一步，重启都能从旧 CURRENT 指向的完整 MANIFEST 状态恢复，最多丢弃最后一条未提交的 edit。失败路径同样闭环（`version_set.cc:849-856`）：`AppendVersion` 没执行（`v` 被 `delete`），若本轮恰好新建了 MANIFEST，刚打开的 `descriptor_log_`/`descriptor_file_` 被销毁、新文件 `RemoveFile` 删掉、句柄置空——下轮 `LogAndApply` 从头再来，不留半成品。`SetCurrentFile` 写入的内容是**去掉 `dbname/` 前缀的 MANIFEST 文件名 + 换行符**（如 `MANIFEST-000002\n`，`filename.cc:127-131`），失败时同样 `RemoveFile(tmp)` 清理。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `VersionSet::LogAndApply` in `version_set.cc:777` | edit→新 Version→落盘→上线 | 解锁写盘；失败回滚 v |
| `VersionSet::Builder::Apply` in `version_set.cc:637` | 把差异累进 per-level 结构 | FileSet 按 smallest 排序天然去重 |
| `VersionSet::Builder::SaveTo` in `version_set.cc:653` | 归并新旧产出 files_[level] | upper_bound 线性归并；NDEBUG 断言 L1+ 无重叠 |
| `VersionSet::Finalize` in `version_set.cc:1031` | 算每层 compaction score | L0 用文件数不用字节：读要逐文件归并 |
| `VersionSet::Recover` in `version_set.cc:861` | 重放 MANIFEST 建初始 Version | 校验 comparator 名防误开 |
| `VersionSet::AppendVersion` in `version_set.cc` | current_ 切换 + 环链挂接 | assert(refs_==0)：上线时无人引用 |
| `VersionSet::WriteSnapshot` in `version_set.cc:1069` | 新 MANIFEST 起始全量快照 | 一条大记录装下所有文件 |
| `VersionSet::ReuseManifest` in `version_set.cc:1000` | reuse_logs 时续用旧 MANIFEST | 尺寸 < max_file_size 才续 |
| `Version::Ref/Unref` in `version_set.cc:414` | 视图引用计数 | 0 引用自毁并给文件减引用 |
| `VersionEdit::EncodeTo/DecodeFrom` in `db/version_edit.cc` | 差异记录的序列化 | tag 分字段的紧凑编码 |
</details>

## 核心实现

### Builder：差异的累积与归并

`Builder`（`version_set.cc:569`）是 LogAndApply 的装配车间。`Apply` 把 edit 的删除记入 `deleted_files`（set）、新增构造成新 `FileMetaData`（含配额 `allowed_seeks = file_size/16384`，下限 100——那条著名的"1 次 seek ≈ 40KB compaction 成本"注释就在 `Apply` 里）插入 `added_files`（`std::set` 按 `BySmallestKey` 排序，同名删除先抵消）。`SaveTo` 对每层做**三路归并**：按 smallest 序把 added 文件与 base 文件交错放进新 Version 的 `files_[level]`，同时跳过 deleted。这个设计的妙处是**同一 edit 可多次 Apply**（恢复时重放一整串 edit，Builder 是累积器），且 O(新增 + 旧文件) 而非 O(全量重排)。

NDEBUG 段（`version_set.cc:700` 附近）有个硬断言：L1+ 每层文件必须区间互斥——把"level>0 不重叠"这一 LSM 核心不变量做成编译期开关的运行时验证。

### Finalize：给每层打一个"该压了"的分数

```cpp title="db/version_set.cc"
if (level == 0) {
  score = v->files_[level].size() /
          static_cast<double>(config::kL0_CompactionTrigger);   // 4
} else {
  const uint64_t level_bytes = TotalFileSize(v->files_[level]);
  score = level_bytes / MaxBytesForLevel(options_, level);      // 10MB × 10^(L-1)
}
```

L0 特殊处理的理由写在注释里：L0 文件是**读路径要逐个归并**的，文件个数（不是字节）直接决定读代价；且大 write_buffer 下每个文件都不小，按字节会过度触发。`MaxBytesForLevel`（`version_set.cc:41`）给出著名的阶梯：L1=10MB、L2=100MB、…L6=10TB——10 倍的层间比是"单次 compaction 的读写量 ≤ 层容量的 1/10"这一摊销分析的来源。**循环只到 `kNumLevels - 1`**：score 衡量的是"L 层该向 L+1 层合并"的紧迫度，而最深层 L6 没有下一层可去——永远不产出 L7。分数挂在 Version 上（`compaction_score_`/`compaction_level_`），`NeedsCompaction()` 只是读两个字段。

### AppendVersion 与引用计数：无锁读的地基

```cpp title="db/version_set.cc"
void VersionSet::AppendVersion(Version* v) {
  if (current_ != nullptr) current_->Unref();
  current_ = v;
  v->Ref();
  v->prev_ = dummy_versions_.prev_;
  v->next_ = &dummy_versions_;
  ...
}
```

环链（`dummy_versions_` 作头，尾部即最老）的意义是**遍历全部活 Version**：`AddLiveFiles` 沿环收集所有层的文件引用，供 `RemoveObsoleteFiles` 判定"哪些 .ldb 可以删"；`~Version`（`version_set.cc:65`）自毁时把自己摘出环链、给每个文件 refs 减一。`VersionSet` 构造函数（`version_set.cc:733`）自举的方式干脆：`next_file_number_` 从 2 起步（1 留给首个 MANIFEST），然后 `AppendVersion(new Version(this))` 直接挂一个空 Version——**一个空库也有合法的 current_**，Recover/首个 LogAndApply 都在它之上叠加。读侧的配合在 `DBImpl::Get`：持锁 `current->Ref()`，解锁做全部 IO，`Unref` 收尾——**Version 的存活期就是一次读的一致性期**。快照（`snapshots_`）只保护数据内容（sequence 水位），版本结构保护文件存在性，两者正交。

### Recover 与 MANIFEST 重放

`VersionSet::Recover`（`version_set.cc:861`）读 CURRENT（内容必须以 `\n` 结尾，否则 `Corruption("CURRENT file does not end with newline")`——一个最便宜的前置完整性检查）→ 打开 MANIFEST → `log::Reader` 逐条 `VersionEdit::DecodeFrom` → `builder.Apply` 累积 → `SaveTo` 出初始 Version。三个必检字段（next_file/log_number/last_sequence）缺失即 Corruption；comparator 名不匹配直接 `InvalidArgument`——**用 MANIFEST 里存的 `Comparator::Name()` 防止换比较器打开旧库**（名字变了排序就变了，全库索引作废）。成功路径的收尾（`version_set.cc:960-966`）：`manifest_file_number_ = next_file`、`next_file_number_ = next_file + 1`，并经 `MarkFileNumberUsed` 把 log/prev_log 号也计入已用——**文件号分配器从此不会与磁盘上已有文件冲突**。`ReuseManifest`（`version_set.cc:1000`）是 Chrome 贡献的场景：`Options::reuse_logs = true` 且 MANIFEST 尺寸 < `TargetFileSize`（即 `options->max_file_size`，2MB）时，以 `NewAppendableFile` 续写同一文件（`manifest_file_number_` 保持原号不变），省去每次打开都换新 MANIFEST。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| 不可变快照 + 引用计数 | `version_set.cc` `Version::Ref/Unref`、`AppendVersion` | 读不加长锁的前提；对象生命周期即一致性窗口 |
| Builder（增量装配） | `version_set.cc` `VersionSet::Builder` | 恢复时重放 N 条 edit 与单条提交共用一套装配 |
| Command/WAL（差异记录） | `db/version_edit.cc` `EncodeTo/DecodeFrom` | 元数据变更可重放，崩溃恢复即重放 |
| 原子提交点（tmp+rename） | `db/filename.cc` `SetCurrentFile` | 文件系统无事务，rename 原子性是最低成本提交原语 |

## 模块间交互

上游：compaction（`InstallCompactionResults`/`CompactMemTable` 提交产出）、写入路径（`NewFileNumber` 分配文件号、`SetLastSequence`）、恢复（`DBImpl::Recover` 调 `VersionSet::Recover`）。下游：读取路径（`current()` 供 `Get`/`AddIterators` 取层视图）、文件删除（`AddLiveFiles` 供 `RemoveObsoleteFiles`）。与 `log::Writer` 复用同一分块日志实现写 MANIFEST（`descriptor_log_`）；与 `table_cache_` 协作——`Version::Get` 直接调 `table_cache_->Get`。交互全部同步函数调用，共享状态都在 `DBImpl::mutex_` 保护下（VersionSet 本身 thread-compatible 不自带锁，见头文件注释）。

## 扩展方式

- **加每文件统计**（读次数/时间戳）：`FileMetaData`（`db/version_edit.h`）加字段，`Builder::Apply` 填充，`VersionEdit::EncodeTo` 补 tag——注意老 MANIFEST 解码兼容
- **改层容量曲线**：`MaxBytesForLevel` in `version_set.cc:41`——RocksDB 的 `level_compaction_dynamic_level_bytes` 就从这里出发
- **加 Version 级缓存**（如每层 key range 摘要）：`Version` 构造处（`Builder::SaveTo` 之后）预计算，读路径直接消费
- 对应测试：`db/version_set_test.cc`（Builder/edit 编解码）、`db/recovery_test.cc`（重放正确性）
