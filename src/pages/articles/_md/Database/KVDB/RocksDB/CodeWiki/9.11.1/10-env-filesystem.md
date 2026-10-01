---
source:
  type: "源码解读"
  project: "rocksdb"
  url: "https://github.com/facebook/rocksdb"
title: "Env 与 FileSystem"
date: "2026-10-01T18:44:01+08:00"
category: [Database, KVDB, RocksDB, CodeWiki, "9.11.1"]
contentType: "CodeWiki"
tags: ["RocksDB", "io_uring", "RateLimiter"]
description: "Env/FileSystem 双层抽象（posix/io_uring/可插拔远程 FS）、多优先级令牌桶限速、DeleteScheduler 的 trash 延迟删除、自适应预读。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/RocksDB/CodeWiki/9.11.1/00-overview)

---

## 模块定位

`env/` + `file/` + `util/rate_limiter.cc` 实现"字节如何进出存储"的全部治理：**Env**（时钟/线程/系统调用的 OS 抽象）、**FileSystem**（细粒度 IO 接口 + IOOptions/IOStatus）、**RateLimiter**（多优先级令牌桶）、**DeleteScheduler**（删除限速）、**FilePrefetchBuffer**（自适应预读）。

## 模块架构

```
Env（env.h:151：文件+线程+时钟三类 API，LevelDB 遗产）
  └─ PosixEnv = PosixFileSystem + PosixClock + ThreadPoolImpl（三池）
       CompositeEnv 把文件方法转 file_system_、时间转 system_clock_

FileSystem（file_system.h:292：每个 API 带 IOOptions——细粒度控制）
  ├─ PosixFileSystem（NewRandomAccessFile 分 mmap/direct/buffered 三路）
  │    └─ PosixRandomAccessFile：Read=pread 循环；MultiRead=io_uring 批量
  │       （thread_local_io_urings_：每线程一个 ring，kIoUringDepth=256）
  ├─ Mock / ReadOnly / Remap / Encrypted / Tracer / fault_injection
  └─ 全部经 ObjectLibrary 注册，CreateFromString("posix://") 按名加载

治理三件套
  RateLimiter（token bucket，IO_TOTAL 个优先级队列 + 概率性公平）
  DeleteScheduler（rename .trash → 后台慢删 → 大文件分块 truncate）
  FilePrefetchBuffer（2 次顺序读门槛 → 指数翻倍 → 8KB 线性回缩）
```

## 调用链路

```
一次 block 读的 IO 路径
  BlockBasedTable::Get → BlockFetcher::ReadBlockContents（block_fetcher.cc:357）
  ├─ TryGetFromPrefetchBuffer → FilePrefetchBuffer::TryReadFromCache
  │    命中直接返回（readahead_size_ *= 2，file_prefetch_buffer.cc:874）
  └─ RandomAccessFileReader::Read（random_access_file_reader.cc:107）
      ├─ 对齐判断 → rate_limiter_->RequestToken(n, alignment, pri)（:211）
      └─ file_->Read(offset, allowed, opts, &tmp, scratch) → PosixRandomAccessFile::Read
          └─ while (left > 0) pread(fd_, ptr, left, offset)（io_posix.cc:610）

批量读（MultiGet/compaction）
  PosixRandomAccessFile::MultiRead（io_posix.cc:651）
  ├─ iu = thread_local_io_urings_->Get()（无则 CreateIOUring）
  ├─ 不支持 io_uring → 退化为逐个 Read（串行 pread）
  └─ 支持：按 256 分批 → io_uring_prep_readv 逐个 → io_uring_submit_and_wait
       一次 syscall 提交整批 → 逐 cqe UpdateResult
       （cqe->res==0 歧义处理 + 部分读完成请求下一轮重发）

RateLimiter::Request（rate_limiter.cc:122）
  锁 request_mutex_ → available_bytes_ 够直接扣减
  → 不够则 Req 入 queue_[pri]，第一个等到 refill 时刻的线程执行
     RefillBytesAndGrantRequestsLocked（:273）：
     available = refill_bytes_per_period（不结转余额）
     → GeneratePriorityIterationOrder（:234）：IO_USER 永远最先；
        HIGH/MID/LOW 以 rnd_.OneIn(fairness_) 概率随机排后——防低优先级饿死
     → 按序整单 grant，cv.Signal 唤醒

文件删除
  DBImpl::DeleteObsoleteFileImpl → DeleteDBFile → SstFileManagerImpl
  → DeleteScheduler::DeleteFile（delete_scheduler.cc:60）
      未启用限速 或 trash 占比 > 25% → 立即 unlink
      否则 rename 成 ".trash"（前台立刻返回）→ 入 queue_
  后台 BackgroundEmptyTrash（:269）
      大文件按 chunk ftruncate 分次削（:377——把一次巨大 unlink 拆成小 truncation 削峰）
      → total_penalty = deleted_bytes * 1e6 / rate → TimedWait 限速休眠
```

## 核心实现

### 为什么拆 Env 与 FileSystem 两层

`env.h:9` 的 Env 是 LevelDB 遗产（一个接口包打 OS 全部）；`file_system.h:272` 明说 FileSystem 是 "the interface between RocksDB and storage systems, such as Posix filesystems, **remote filesystems**"。动机双重：(a) **可插拔远程存储**——Env 的时钟/线程语义对远程 FS 无意义，HDFS/Azure 只需换存储面；(b) **测试 mock**——`MockFileSystem`/`EmulatedSystemClock`/fault_injection 可分别替换存储与时间。兼容靠 `CompositeEnvWrapper` + `NewCompositeEnv`——旧 `DBOptions::env` 接口不变，新 `fs_uri` 按名加载。

### io_uring 的收益与边界

`MultiRead` 把 N 个读请求用一次 `io_uring_submit_and_wait` 提交（`io_posix.cc:731`）：省 N-1 次 syscall 内核进出，内核可并行下发多个块请求（NVMe 队列深度友好）。`UpdateResult` 处理 `cqe->res==0` 歧义（EOF vs partial）并回退 pread 保正确性。启用三条件：编译期 `WITH_LIBURING`、运行时弱符号 `RocksDbIOUringEnable()`（宿主可自定义开关）、thread-local ring 初始化成功。**版本勘误**：io_uring 并非 9.4 才有——MultiRead 的 io_uring 路径源自 2020 年 PR #6441；`ReadAsync/Poll/AbortIO` 异步流水线是 7.x 增量。另注意：**随机读已弃用 mmap**（`fs_posix.cc:240` 注释原话 "it kills performance when storage is fast"——快盘上 page fault 开销高于 pread 拷贝）。

### 删除为什么也要限速

compaction 结束瞬间可能释放数十 GB obsolete SST，`unlink` 大文件触发大量元数据 IO 与 page cache 回收，形成"死亡尖峰"抢占正在服务的 WAL fsync 与前台读。对策两段式：先 `rename` 到 `.trash`（纯元数据操作微秒级，前台路径立刻返回），再后台按 penalty 休眠慢删；超大文件按 chunk `ftruncate` 分次削。`max_trash_db_ratio_`(25%) 安全阀防 trash 无限膨胀；open 时 `CleanupDirectory` 扫描上次崩溃残留的 `.trash`。

### 自适应预读的三条规则

`file_prefetch_buffer.cc:874`：每次"缓冲未命中→触发 prefetch"后 `readahead_size_ *= 2`（命中时不增大防浪费）。触发门槛 `IsEligibleForPrefetch`（`h:463`）：`IsBlockSequential`（prev_offset+len==offset）且连续读超过 `num_file_reads_for_auto_readahead`（默认 2）——**随机点查零浪费，顺序扫描指数提速**。反向收缩 `DecreaseReadAheadIfEligible`：块跨出缓冲且仍顺序时每次减 8KB 但不低于初始值；reseek 归零重学。状态可跨文件传递（`ReadaheadFileInfo` 经 `BlockBasedTableIterator::Get/SetReadaheadState` 在换文件/换层时带给下一个迭代器，不从零学起）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 接口多实现（SPI） | FileSystem 8+ 实现，ObjectLibrary 注册 | 存储面可插拔 |
| 装饰器 | FileSystemWrapper（"转发一切，只 override 你关心的"）；加密层先 Read 再 Decrypt | 透明叠加 |
| 组合/桥接 | CompositeEnv = FS + Clock，PosixEnv 补线程 API | 演进与替换兼顾 |
| 令牌桶 + 概率性公平 | GeneratePriorityIterationOrder | 多优先级不饿死 |
| ThreadLocalPtr 池化 | 每线程一个 io_uring ring | 免锁竞争 |
| 生产者-消费者 + 磁盘标记 | `.trash` 后缀即持久化队列 | 崩溃后可恢复清理 |

## 模块间交互

**db_impl**：`env_->Schedule(BGWorkCompaction, Env::Priority::LOW)` 三池调度；`Env::ReserveThreads` 给 bottommost compaction 预留线程。**table reader**：footer/index/data block 读取统一经 `FilePrefetchBuffer::TryReadFromCache`；`OptimizeForCompactionTableRead`（`fs_posix.cc:935`）读 `/sys/block/*/queue/max_sectors_kb` 收敛 compaction_readahead_size。**compaction**：`WritableFileWriter` 的 Append/Flush 前请求 token。**SstFileManager**：DeleteScheduler 删除后回调维护文件账本（trash rename 也算移动以保统计一致）。

## 扩展方式

**接入自研/远程存储**：继承 `FileSystemWrapper`（只 override 差异方法）+ `NewCompositeEnv(fs)` 挂 `DBOptions::env`；需要异步读则 override `ReadAsync/Poll/AbortIO` 并在 `SupportedOps` 置 `kAsyncIO`——RocksDB 自动启用 `FilePrefetchBuffer::PrefetchAsync` 流水线。

**调整 IO 带宽治理**：`NewGenericRateLimiter(bytes_per_sec, refill_period_us, fairness, mode, auto_tuned)`；`auto_tuned` 模式按 drained 统计自动逼近带宽（<50% 降 5%、>90% 升 5%，区间 [max/20, max]）。

**修改删除策略**：调 `SstFileManager` 的 `rate_bytes_per_sec`/`max_trash_db_ratio`/`bytes_max_delete_chunk`；新文件类型需在 `DeleteObsoleteFileImpl` 的白名单补类型，否则直删不经限速。
