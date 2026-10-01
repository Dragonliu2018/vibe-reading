---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "存储引擎"
date: "2026-10-01T20:55:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "LSM", "TsFile", "Compaction"]
description: "DataRegion 存算核心：sequence/unsequence 双队列写入路由、memtable 即 WAL entry、TsFileProcessor 生命周期、两级 Compaction 调度与三重限速、TVList 分段原生数组。"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

存储引擎（`datanode/.../db/storageengine`，约 8.2 万行）是 DataRegion 的存算核心——**DataRegion 是数据共识组的状态机载体，一个 database 的一个分片**。它管的是 LSM 式写入路径：内存 memtable → WAL → 异步 flush 封口 TsFile → 后台 compaction 合并，以及删除标记（modification）与崩溃恢复。真正的 TsFile 文件格式（列式编码、chunk/page 结构、统计量）在外部 repo `apache/tsfile` 2.3.1——存储引擎只管"什么时候写、写到哪个文件、文件之间怎么合并"，这是刻意的外部解耦（新增压缩算法甚至不需要改本仓库）。

这一模块区别于教科书 LSM 的两个关键点：**用 sequence/unsequence 双队列替代 L0**（写入瞬间路由，而非事后分层），和**memtable 本身就是一条 WAL entry**（`IMemTable extends WALEntryValue`，与 IoT 共识共享同一份物理日志）。

## 模块架构

![存储引擎架构](/vibe-reading/images/articles/iotdb-2.0.10/storage-architecture.svg)

`StorageEngine` 是门面（懒加载单例，`dataRegionMap` 注册表 + `blockInsertionIfReject()` 内存反压入口）。每个 `DataRegion`（约 200KB 的 god class）持两列 `TreeMap<Long, TsFileProcessor>`——`workSequenceTsFileProcessors` 与 `workUnsequenceTsFileProcessors`，按 timePartitionId 组织。`TsFileProcessor`（92KB）封装"未封口 TsFile + 唯一可写的 workMemTable + 不可变的 flushingMemTables 队列"，一个 (timePartition, sequence) 组合对应一个。文件层是 `TsFileManager`：`TreeMap<Long, TsFileResourceList>` 按分区组织，`TsFileResource` 是每个 TsFile 的内存索引（device→时间范围的 `ITimeIndex`、`.resource` 序列化），`TsFileResourceList` 是**侵入式双链表**（`TsFileResource` 自带 prev/next 指针）。

## 调用链路

![写入与恢复调用链](/vibe-reading/images/articles/iotdb-2.0.10/storage-write-path.svg)

一条 InsertTabletNode 的完整链路：共识状态机 `DataRegionStateMachine.write(PlanNode)`（带 MAX_WRITE_RETRY_TIMES 重试，仅对 `WRITE_PROCESS_REJECT`）→ `planNode.accept(new DataExecutionVisitor(), region)` 分发 → `DataRegion.insertTablet`（L1378）：反压检查 → 写锁 → TTL 检查 → `split()`（L1261）逐行用 `TimePartitionUtils.getTimePartitionId(time)` 切时间分区、用 `getLastFlushTime()` 判定 seq/unseq——**`time > lastFlushTime` 即 sequence，乱序/迟到数据进 unsequence** → `getOrCreateTsFileProcessor(timePartitionId, sequence)` → `TsFileProcessor.insertTablet`（L569）：类型检查 → `scheduleMemoryBlock()` 内存记账（预估 TVList/ChunkMetadata/Binary 增量，超限自旋直至抛异常）→ `walNode.log(memTableId, ...)` + `walFlushListener.waitForResult()`（**SYNC 模式 WAL 落盘成功才继续**，失败回滚内存记账）→ pipe 挂载点 → `workMemTable.insertTablet` 落 TVList → 末尾 `shouldFlush()` 触发 `DirectFlushPolicy` 异步封口。类型冲突（`DataTypeInconsistentException`）会 `asyncCloseAllWorkingTsFileProcessors()` **全量 flush 后重试一次**——冲突类型可能写到本 region 其它 processor，不能只 flush 当前。

崩溃恢复走右侧链：`WALNodeRecoverTask` 三步——`readLastFileInfoAndRepairIt()`（L156，`WALRepairWriter` 截断损坏的最后一个 .wal）→ `recoverInfoFromCheckpoints()`（L211，恢复 memTableId→info 映射）→ `recoverTsFiles()`（L238，按 versionId 升序重放、只重放活跃 memtable 的 entry、`UnsealedTsFileRecoverPerformer` 续写未封口 TsFile 后 flush 封口）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `StorageEngine.blockInsertionIfReject()` | 全局写入反压 | 三级内存管控 |
| `DataRegion.insertTablet`（L1378） | 写入入口 | 写锁粒度到 region |
| `DataRegion.split()`（L1261） | 时间分区 + seq/unseq 路由 | 写入瞬间分流而非事后分层 |
| `TsFileProcessor.insertTablet`（L569） | 落 memtable + WAL | SYNC 等待 + 失败回滚内存记账 |
| `TsFileProcessor.shouldFlush()`（L1243） | flush 触发 | memtable 内存阈值或显式置位 |
| `MemTableFlushTask.syncFlushMemTable()`（L130） | 刷盘执行 | sort→encode→IO 三阶段流水线 |
| `CompactionScheduler.scheduleCompaction()`（L98） | 选 compaction 任务 | seq inner → unseq inner → cross 优先级 |
| `TsFileResource.transformStatus()`（L963） | 文件状态 CAS | COMPACTION_CANDIDATE→COMPACTING 防并发 |
| `TsFileResourceList.keepOrderInsert()`（L140） | 文件入链 | 时间戳升序、version 升序 |
| `TVList.sort()` | 乱序排序 | 只重排 indices 不动数据 |
</details>

## 核心实现

### sequence/unsequence：为什么不用 L0

时序场景写多读少且绝大多数写入是 append（时间单调），只有少量乱序。`split()` 用 `lastFlushTimeMap` 在写入瞬间把迟到数据路由到 unsequence processor 后：sequence 文件天然按时间有序、查询 merge 代价极小；且 sequence 文件的 endTime **延迟到关闭时才更新**（L650 注释），unsequence 每次插入都更新（时间范围散乱）——省掉顺序写路径上的索引更新代价。unsequence 的回收靠 cross space compaction 回填合并进 sequence 文件（`CrossSpaceCompactionTask` L58），删除标记经 `ModificationFile`（merge 后 chunk 版本号为 0，mod 文件版本从 1 起才生效——`MERGE_MOD_START_VERSION_NUM=1` 注释）。

### memtable 即 WAL entry

`IMemTable extends WALEntryValue`：memtable 的创建与 flush 被写成 checkpoint 日志（`logCreateMemTable`/`flushEnd`），WAL 重放精确到"哪个未封口 TsFile 的哪个 memtable"而不是全量重放。更关键的是 IoT 共识下 **WAL 日志即共识日志**：`WALManager` 构造器按协议选择 `NodeAllocationStrategy`——IoT consensus 用 `FirstCreateStrategy`（每 DataRegion 一个 WALNode，follower 的 LogDispatcher 直接读 leader 的 WAL 目录，物理日志复用）；Ratis 协议下 WAL 整体关闭（`WALMode.DISABLE`，返回 `WALFakeNode` Null Object，Raft log 已覆盖）；`WALNode` 内部是环形 `WALBuffer` + 后台刷盘线程 + `CheckpointManager` 按水位滚动删除旧 .wal 文件。

### 两级 Compaction：调度层 + 执行层

调度层 `CompactionScheduleTaskManager`（单例 IService）提交 N 个 `CompactionScheduleTaskWorker` 按 workerId 取模瓜分 dataRegionList；`CompactionScheduler.scheduleCompaction()`（L98）依次尝试 inner seq → inner unseq → insertion → cross → settle，选择器是策略模式（`SizeTieredCompactionSelector`/`NewSizeTieredCompactionSelector` 按文件大小分 tier——后者用 `selectTaskBaseOnLevel()` 从 level 0 到 `searchMaxFileLevel()` 逐层尝试返回首个非空结果，`checkIsActiveTimePartition()` 以 `2 * compactionScheduleIntervalInMs` 判定活跃分区，选文件时 `canSelectMoreFilesInMemoryBudget()` 对照 `SystemInfo.getMemorySizeForCompaction()` 做内存预算，`isTaskTooLarge()` 设文件总量与数量双上限）。执行层 `CompactionTaskManager` 用固定容量**优先级阻塞队列**（低优任务可被逐出并重置源文件状态，不丢一致性）+ 常驻 `CompactionWorker`（默认 10 个）+ **三个 Guava RateLimiter**（merge 写吞吐 / 读 IOPS / 读吞吐）——面向工业场景的写入 SLA 保护是 IoTDB compaction 最鲜明的工程特征。执行器另有策略选择：`FastCompactionPerformer`（默认，多文件并发归并）/`ReadChunkCompactionPerformer`/`ReadPointCompactionPerformer`，按内存估算决定。崩溃恢复靠 `CompactionLogger`/`CompactionLogAnalyzer` 从 .log 还原源/目标文件集合继续或回滚。

Flush 侧是三阶段流水线：`MemTableFlushTask.syncFlushMemTable()`（L130）主线程先排序并产出子任务，经 `encodingTaskQueue`/`ioTaskQueue` 两级队列交给 `encodingTask`/`ioTask` 后台子线程（`FlushTaskPoolManager`/`FlushSubTaskPoolManager`），主线程按 `encodingTaskFuture.get()` → `ioTaskFuture.get()` 顺序等待。内存自适应：刷盘前读 `SystemInfo.isEncodingFasterThanIo()` 决定是否 `applyTemporaryMemoryForFlushing()` 额外申请临时内存，结束时 `SystemInfo.setEncodingFasterThanIo(ioTime >= memSerializeTime)` 回写。

`TsFileProcessor` 的刷盘生命周期由 `asyncFlush()` 驱动：`addAMemtableIntoFlushingList(IMemTable)` 把 workMemTable 移入 `flushingMemTables`（ConcurrentLinkedDeque）并新建工作 memtable；并发保护有两层——`flushQueryLock`（ReentrantReadWriteLock）协调结构性变更，TVList 的 `queryContextSet` 引用计数保护数据本体。WAL 清理侧还有个值得读的细节：`WALNode` 的 `shouldSnapshotOrFlush()`（effectiveInfoRatio < `walMinEffectiveInfoRatio` 或节流中）触发 `trySnapshotOrFlushMemTable()`，按三个条件决定直接 flush 而非 snapshot——最老 memtable 属于旧时间分区、snapshot 次数达 `maxWalMemTableSnapshotNum()`、或 `TVListsRamCost()` 超 `walMemTableSnapshotThreshold()`；`memTableSnapshotCount` 这个 Map 专为避免频繁 snapshot 的写放大而设（memtable flush 完成后在 `onMemTableFlushed()` 移除计数）。

### TVList：分段原生数组 + 懒排序

`TVList`（`db/utils/datastructure/TVList.java`）是 memtable 的列式内存结构，按类型子类化（工厂 `TVList.newList(TSDataType)`）。两个要点：**分段原生数组**（`List<long[]>` 按 `PrimitiveArrayManager.ARRAY_SIZE` 分块、池化回收，避免大数组 GC 压力——`tvListArrayMemCost()` 是内存记账的计量单位）；**乱序懒排序**（新数据直接 append，`rowCount >= TVLIST_SORT_THRESHOLD` 时 `handoverTvList()`：sort 后移入 sortedList、新开 TVList 继续写——把批量乱序写 amortize 成小段排序，且 `sort()` 只重排 `indices` 不搬数据）。`queryContextSet` 引用计数保证查询在用的工作 memtable 不被 flush 破坏。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例（Holder） | StorageEngine / FlushManager / WALManager / CompactionTaskManager | 全局服务 |
| 策略 | FlushPolicy / NodeAllocationStrategy / CompactionSelector / Performer | flush 时机、WAL 分配、合并算法可插拔 |
| Visitor | `DataExecutionVisitor` | 写入计划节点分发，十几种写操作不改状态机骨架 |
| 模板方法 | `AbstractMemTable` / `AbstractCompactionTask` | 状态流转骨架固定 |
| 侵入式双链表 | `TsFileResourceList` | compaction 高频插删，O(1) 且天然有序 |
| Null Object | `WALFakeNode` | DISABLE 模式零分支 |
| 生产者-消费者 | sort→encode→IO 流水线 / WALBuffer | 流水线并行 |

## 模块间交互

向上被共识层驱动（DataRegion 就是状态机本体）；与 schemaengine 交互在表模型写入（`registerToTsFile()` 注册 `TableSchema`，`TABLE_SCHEMA_CACHE` Caffeine 缓存 ConfigNode 下发）；与 pipe 的挂载点在写入热路径（`listenToInsertNode` 同时把数据推给 pipe extractor，`isTotallyGeneratedByPipe` 标记纯 pipe 生成的文件）；删除走 `ModificationFile`（树/表两条入口），memtable 内直接 `delete()`，flushing memtable 只记 `modsToMemtable`。follower 侧不更新 last cache（`isGeneratedByRemoteConsensusLeader()` 判断，L1465）。

## 扩展方式

新增 compaction 触发条件：实现 `IInnerSeqSpaceSelector`/`IInnerUnseqSpaceSelector`，在 `selectInnerSpaceTask()` 返回任务；新任务类型继承 `AbstractCompactionTask` 实现 `doCompaction()` 并在 `CompactionScheduler.scheduleCompaction()` 追加。新增 WAL 条目类型：`WALNode` 加 log 重载 + `WALEntryType` 加类型 + `WALNodeRecoverTask.recoverTsFiles()` 加反序列化分支。调整内存管控：任何 memtable 结构改动必须同步改 `scheduleMemoryBlock()/updateMemoryInfo()` 的增量估算，**否则内存反压失效**——这是本模块最容易踩的坑。新增压缩算法只在外部 tsfile repo 做（`CompressionType` 扩展），Datanode 侧只在 `CompressionRatio` 注册统计。

> ⚠️ 待核实：`PrimitiveArraySize` 默认值。
