---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "写入路径"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "Group Commit", "WAL", "WriteBatch"]
description: "DBImpl::Write 的完整写入链路：writers_ FIFO 队列、BuildBatchGroup 成组合并、MakeRoomForWrite 三级背压、WAL 先行与 memtable 无锁插入。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

写入路径解决一个问题：**把任意并发的写请求变成严格串行的 WAL 追加**，同时不让慢写者互相拖累。它由三块协作构成——`DBImpl::Write` 的队列协议（`db/db_impl.cc:1206`）、`BuildBatchGroup` 的成组优化（`db_impl.cc:1281`）、`MakeRoomForWrite` 的背压闸（`db_impl.cc:1331`），横跨 `WriteBatch` 序列化（`db/write_batch.cc`）与 `log::Writer`（`db/log_writer.cc`，详见 [WAL 与恢复](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/08-wal-recovery)）。

它是理解 LevelDB "写全顺序"主张的钥匙：磁盘上唯一被写入的文件是当前 WAL（追加式）和 compaction 输出（新文件），不存在任何原地修改。

## 模块架构

![写入数据流](/vibe-reading/images/articles/leveldb-codewiki-main-2026-03/write-path.svg)

三个组件的分工有清晰的层次：**队列协议**解决"谁有权写"——`writers_` 是一个 `std::deque<Writer*>`，每个 `Writer`（`db_impl.cc:43`）自带一个 `CondVar`，只有队首能前进，形成廉价的"传递锁"；**成组器**解决"一次能写多少"——队首回头扫队列，把后续 writer 的 batch 拼进 `tmp_batch_`，摊薄单次 WAL 追加的固定成本；**背压闸**解决"写不动了怎么办"——它站在成组之前，保证 memtable 不爆内存、L0 不堆文件。三者全部跑在调用者线程上（group commit 的工作由幸运的队首完成），后台线程只负责 `imm_` 落盘。

## 调用链路

```
Put/Delete(WriteOptions, k, v)          db_impl.cc:1198
 └─ WriteBatch 单条封装
DBImpl::Write(options, updates)         db_impl.cc:1206
 ├─ Writer w; writers_.push_back(&w)
 ├─ while (!w.done && &w != front) w.cv.Wait()   ← 非队首在此睡眠
 ├─ MakeRoomForWrite(force)             db_impl.cc:1331   [持锁]
 │   ├─ L0 ≥ 8 → sleep 1ms（每写最多一次）
 │   ├─ mem 未满 4MB → 通过
 │   ├─ imm_ 未落盘完 → 等 background_work_finished_signal_
 │   ├─ L0 ≥ 12 → 停写等待
 │   └─ 否则：新 log 文件、imm_ = mem_、mem_ = new MemTable
 ├─ BuildBatchGroup(&last_writer)       db_impl.cc:1281   [持锁]
 │   └─ 队首起合并：sync 不混组、总量 ≤ max_size(1MB 或 size+128KB)
 ├─ SetSequence(batch, last_sequence+1)
 ├─ [解锁] log_->AddRecord(batch)        → WAL 物理记录
 │         options.sync ? logfile_->Sync() : —
 │         WriteBatchInternal::InsertInto(batch, mem_)  → 跳表
 ├─ [加锁] SetLastSequence(last_sequence + count)
 └─ 逐个唤醒已完成的 writer（status 回填）+ 通知新队首
```

数据形态三级转换：`WriteBatch`（内存字符串 `rep_`：12B 头 + 记录流）→ WAL 物理记录（32KB 分块 + crc32c）→ memtable 条目（varint 前缀 + InternalKey + value，Arena 分配）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `DBImpl::Put/Delete` in `db_impl.cc:1198/1202` | 单条语法糖 | 包成 WriteBatch 复用主路径 |
| `DBImpl::Write` in `db_impl.cc:1206` | 队列协议 + 编排 | 解锁区间只信任队首身份 |
| `DBImpl::BuildBatchGroup` in `db_impl.cc:1281` | 合并队列批次 | sync 边界不跨界；小组限增量 128KB |
| `DBImpl::MakeRoomForWrite` in `db_impl.cc:1331` | 背压与切表 | 三级背压防 L0 堆积与 OOM |
| `WriteBatchInternal::InsertInto` in `db/write_batch.cc` | batch 重放进 memtable | 复用 `Iterate(Handler)` 恢复逻辑同源 |
| `WriteBatchInternal::Append` in `db/write_batch.cc` | 批次拼接 | O(n) 直拼字节流，count 相加 |
| `log::Writer::AddRecord` in `db/log_writer.cc` | WAL 分块追加 | 见 08 篇 |
</details>

## 核心实现

### Writer 队列：把锁变成队首身份

`DBImpl::Write` 开头 8 行就是整个并发协议（`db_impl.cc:1213-1220`）：

```cpp title="db/db_impl.cc"
Writer w(&mutex_);
w.batch = updates; w.sync = options.sync; w.done = false;
MutexLock l(&mutex_);
writers_.push_back(&w);
while (!w.done && &w != writers_.front()) {
  w.cv.Wait();
}
if (w.done) return w.status;
```

每个写者构造一个栈上 `Writer` 入队，非队首者睡自己的条件变量。当队首完成一轮，它从队头逐个 `pop`、给已并入本轮的 writer 回填 `status` 并 `Signal`（`db_impl.cc:1262-1271`），最后叫醒新队首。**锁本身在成组后即释放**——真正保护 WAL 与 memtable 的是"队首身份"这一逻辑互斥：写日志和插跳表期间解锁（`db_impl.cc:1232-1255`），让 `Get`、`RemoveObsoleteFiles` 等持锁操作不被 IO 阻塞。这个设计后来被 RocksDB 原样继承（`WriteThread`）。

代价是公平性由 FIFO 保证但延迟由队长决定——一个 1MB 大写后面跟着的小写必须等它完成；`BuildBatchGroup` 的存在正是为了让队首"顺手带走"后面的积压。

### BuildBatchGroup：成组的四条规则

```cpp title="db/db_impl.cc"
size_t max_size = 1 << 20;
if (size <= (128 << 10)) {
  max_size = size + (128 << 10);
}
for (; iter != writers_.end(); ++iter) {
  Writer* w = *iter;
  if (w->sync && !first->sync) break;   // 规则1：sync 不混入非 sync 组
  if (w->batch != nullptr) {
    size += WriteBatchInternal::ByteSize(w->batch);
    if (size > max_size) break;          // 规则2：总量封顶
    if (result == first->batch) {
      result = tmp_batch_;               // 规则3：拷贝到复用缓冲
      WriteBatchInternal::Append(result, first->batch);
    }
    WriteBatchInternal::Append(result, w->batch);
  }
  *last_writer = w;
}
```

四条规则的设计意图：**sync 边界**——一个 sync 写的持久化承诺不能被非 sync 队首"搭便车"提前返回；**双重封顶**——首轮 ≤128KB 的小组最多长到 `size+128KB`（防大组饿死小写延迟），大组则允许到 1MB（吞吐优先），这是延迟-吞吐的显式权衡；**tmp_batch_ 复用**——队首自己的 batch 属于调用者不能改，拼组时切到 `DBImpl::tmp_batch_` 这个成员复用缓冲（用完 `Clear()`，`db_impl.cc:1258`）；**O(n) 拼接**——`WriteBatchInternal::Append`（`db/write_batch.cc` 尾部）直接把 src 的记录字节段 `append` 进 dst 并把 count 相加，不做逐条解释。

### MakeRoomForWrite：三级背压闸

`db_impl.cc:1331` 的 `while(true)` 是写路径唯一的等待点，四个出口构成漏斗：

| 条件 | 行为 | 防什么 |
| --- | --- | --- |
| `bg_error_` 非空 | 直接返回错误 | 后台出错后拒绝继续写坏数据 |
| L0 ≥ 8（`kL0_SlowdownWritesTrigger`） | 解锁 `sleep 1ms`，`allow_delay=false` 只罚一次 | 提前泄洪，把 CPU 让给 compaction 线程 |
| mem 未满 `write_buffer_size`(4MB) | `break` 放行 | 正常路径 |
| `imm_` 非空 / L0 ≥ 12（`kL0_StopWritesTrigger`） | `background_work_finished_signal_.Wait()` | 硬背压：memtable 只有两个槽位，L0 太多会毁读放大 |

最后的 else 分支做切换，顺序有讲究：`NewFileNumber` 分配新 log 号 → `NewWritableFile` 打开（失败时 `ReuseFileNumber`（`version_set.h`）回收文件号，防 tight-loop 里烧穿号段）→ **旧 `log_` 先 delete、旧 `logfile_->Close()`**（失败则 `RecordBackgroundError` 后仍切换——"可能丢了部分数据"，宁停不错，`db_impl.cc:1386-1394`）→ `imm_ = mem_`、`mem_ = new MemTable` → 置原子 `has_imm_`（release store，供后台线程无锁探测）→ `MaybeScheduleCompaction()`。

1ms 延迟那段的注释（原文）道破设计动机："Rather than delaying a single write by several seconds when we hit the hard limit, start delaying each individual write by 1ms to reduce latency variance"——**用许多小延迟替代一次大停顿**，方差友好。

### WriteBatch：同一份编码服务三条链路

`rep_` 格式（`db/write_batch.cc` 头部注释）：`sequence fixed64 + count fixed32 + 记录流`——即 12 字节头（`kHeader = 12`，`write_batch.cc:27`），记录 = `kTypeValue`/`kTypeDeletion` tag + length-prefixed key(+value)。这个编码被三处消费：写入时 `InsertInto` 重放进 memtable；恢复时 `RecoverLogFile` 同样 `InsertInto`（同一个 `MemTableInserter` Handler，`db/write_batch.cc:115`）；`BuildBatchGroup` 直接按字节拼接。批内序列号的赋予机制全在 `MemTableInserter`：`sequence_` 初值取自 batch 头（`WriteBatchInternal::Sequence(b)`，外层 `DBImpl::Write` 刚用 `SetSequence(batch, last_sequence + 1)` 写进去），`Iterate` 每重放一条 Put/Delete 就 `sequence_++`——**批内第 i 条记录拿到 `last_sequence + 1 + i`**，与外层 `last_sequence += Count(write_batch)` 的水位推进严丝合缝。**写、恢复、拼组共享一套序列化**是这个小模块最经济的设计——没有"内存版/磁盘版"两套表示。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| Leader-follower 队列 | `db_impl.cc` `DBImpl::Write` | 用队首身份替代持锁贯穿 IO，天然形成 group commit |
| 对象池（复用） | `db_impl.cc` `tmp_batch_` 成员 | 成组拼接零分配 |
| Handler 回调 | `write_batch.cc` `MemTableInserter` | 序列化格式单一消费点，写/恢复共用 |
| 状态回填 | `db_impl.cc` Write 尾部的 `ready->status` | 异步化对调用者透明：每个 writer 像同步完成一样拿到结果 |

## 模块间交互

上游是公共 API（`Put/Delete/Write`），下游三路：**WAL**（`log::Writer::AddRecord`，格式细节见 [08 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/08-wal-recovery)）；**MemTable**（`InsertInto` → `SkipList::Insert`，见 [03 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/03-memtable)）；**版本管理**（切表时 `NewFileNumber`/`LogAndApply` 经 `CompactMemTable` 间接发生，`SetLastSequence` 直写）。背压闸与后台 compaction 线程通过 `background_work_finished_signal_` 握手——写停了就在这等，compaction 完成一次就 `SignalAll`。所有交互都是直接函数调用，无事件总线；唯一跨线程共享的 mutable 状态（`imm_` 与 `has_imm_`）用锁 + 原子双层表达。

## 扩展方式

- **改批量上限/背压阈值**：`BuildBatchGroup` 的 `max_size`（`db_impl.cc:1286`）与 `config::kL0_*Trigger`（`db/dbformat.h:28-34`）——RocksDB 把这两个都做成了 Options
- **加写时间戳/来源标记**：`WriteBatch` 记录 tag 扩展（`db/write_batch.cc` 的 kTypeValue/kTypeDeletion 枚举），`MemTableInserter::Put` 同步改
- **多 memtable 流水线**（写不停顿）：`MakeRoomForWrite` 的 `imm_` 单槽改数组——RocksDB 的 `mutable/immutable memtable list` 演进路线
- 对应测试：`db/db_test.cc` 的 `WriteBatch`/并发系列、`db/log_test.cc`
