---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Pageserver"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "Pageserver", "Rust", "LSN 分层存储", "Compaction"]
description: "Neon 存储引擎：WAL 物化为不可变 layer、GetPage@LSN 服务、S3 上传下载队列与 walredo 沙箱的实现解析"
readingTime: "40 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

Pageserver 是 Neon 的存储引擎，回答三个问题：**数据长什么样**（WAL 记录物化为不可变 layer 文件的 LSN 标签 KV 树）、**怎么读**（响应 compute 的 GetPage@LSN，跨祖先 timeline 递归重建页面）、**怎么活下来**（本地盘只是缓存，S3 是唯一容错真源，一切状态可重建）。它同时是分支的物理载体——一个用户分支就是一个 `Timeline`，指向祖先的某个 LSN，共享祖先的全部 layer。

职责边界：不管 WAL 的持久化（safekeeper 的事，它只是拉取方）、不管租户放在哪个节点（storcon 的事）、不管 SQL（compute 的事）。127k 行 Rust，是全仓库最大的服务。

## 模块架构

内部组件围绕两条流水线组织——**写流水线**（WAL 进、layer 出）和**读流水线**（请求进、页面出），二者在 `Timeline` 汇合。`TenantShard` 是管理外壳（attach 状态、generation、后台任务），`Timeline` 是真正干活的单元；layer 体系（`LayerMap` + `storage_layer/`）是数据结构核心；`RemoteTimelineClient` + `UploadQueue` 管上行 S3，`DeletionQueue` 管下行删除，`secondary` 位置只保温不做功。walredo 是读流水线的"逃生通道"——当 delta 层只有 WAL 记录没有 image 时，靠真 Postgres 重放出页面。

## 调用链路

写流水线（左）与读流水线（右）的两条主路径，全部方法都能在图中标注的文件里找到：

```
写：walreceiver_connection.rs              读：page_service.rs
  handle_wal_receiver_connection             handle_pagerequests(:1794)
  → WalIngest::new(walingest.rs:198)         → handle_pagerequests_pipelined(:1979 攒批)
  → ingest_record(:234)                       → handle_get_page_at_lsn_request_batched(:2454)
  → DatadirModification.commit                  → wait_lsn（WAL 未到先等）
    (pgdatadir_mapping.rs:2867, 8MiB 批)        → get_rel_page_at_lsn_batched
  → TimelineWriter::put_batch(:7880)              (pgdatadir_mapping.rs:313)
  → InMemoryLayer::put_batch                     → Timeline::get_vectored(:1339)
    (inmemory_layer.rs:571)                        → LayerMap::search(layer_map.rs:448)
  → checkpoint_distance 满足                      → Layer::get_values_reconstruct_data
    → roll_layer → freeze_and_flush               (layer.rs:322, 按需下载)
    (timeline.rs:2041/5158)                      → reconstruct_value(:7090)
  → L0 DeltaLayer 落盘 +                          ├ 有 image 无记录 → 直返
    schedule_layer_file_upload                    └ WalRedoManager::request_redo
  → UploadQueue → remote_timeline_client           (walredo.rs:173)
    (remote_timeline_client.rs)                      ├ apply_batch_neon（Rust 内联）
  → GenericRemoteStorage::upload                     └ apply_batch_postgres（子进程）
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `handle_pagerequests` (`page_service.rs:1794`) | libpq pagestream 协议入口 | 攒批流水线化，摊薄每请求开销 |
| `get_vectored` (`timeline.rs:1339`) | 多 key 单次跨层检索 | keyspace 批量是网络时代的正确读单元 |
| `reconstruct_value` (`timeline.rs:7090`) | 记录/image → 页面 | image 是地板，walredo 是兜底 |
| `ingest_record` (`walingest.rs:234`) | interpreted WAL → KV | 只处理自己 shard 的记录 |
| `freeze_and_flush` (`timeline.rs:2041`) | in-memory 层固化 | 两步协议：先 freeze 再 flush |
| `flush_frozen_layer` (`timeline.rs:5158`) | 写 L0 delta layer | initdb 区间特判产 image 层 |
| `search` (`layer_map.rs:448`) | 层查找 | image > delta > in-mem 优先级 |
| `reconcile` 侧无——上传走 `schedule_layer_file_upload` | 异步上传 | 乱序重排 + 索引合并有 kill switch |

</details>

## 核心实现

### Timeline：LSN 标签的分支树

`Timeline`（`tenant/timeline.rs:206`）一个分支一个实例，核心字段把"数据 + 进度 + 同步原语"分层装在一起：

```rust title="pageserver/src/tenant/timeline.rs:206（节选）"
pub struct Timeline {
    pub(crate) layers: LockedLayerManager,          // LayerMap + LayerFileManager
    pub(crate) generation: Generation,              // 生命周期内不变，防脑裂
    shard_identity: ShardIdentity,                 // key → shard 映射
    walredo_mgr: Option<Arc<WalRedoManager>>,
    last_record_lsn: SeqWait<RecordRsn, Lsn>,      // 支持 wait_lsn
    disk_consistent_lsn: AtomicLsn,                // 崩溃恢复起点
    ancestor_timeline: Option<Arc<Timeline>>,
    ancestor_lsn: Lsn,                             // 分支点
    write_lock: Mutex<Option<TimelineWriterState>>, // 写路径核心锁
    l0_compaction_trigger: Arc<Notify>,            // 提前唤醒 compaction
}
```

为什么 `last_record_lsn` 用 `SeqWait` 而不是普通原子量：读请求到达时 WAL 可能还没拉齐，`wait_lsn` 把"等一个未来 LSN"变成一等公民——这是读写两条流水线并行推进的同步枢纽。祖先链（`ancestor_timeline` + `ancestor_lsn`）就是分支的物理形态：子 timeline 的 layer 只存"分支之后"的变化，读操作沿祖先链向上借数据，因此分支是 O(1) 元数据操作、零数据拷贝。

### 写流水线：从 interpreted WAL 到不可变 layer

`walingest::ingest_record`（`walingest.rs:234`）收到的是 safekeeper 已解码、已按 shard 过滤、已预序列化的 `InterpretedWalRecord`——pageserver 不再自己解原始 WAL（vanilla 路径已从 ingest 移除）。记录按类型分发进 `DatadirModification`（`pgdatadir_mapping.rs:1676`）：这是一个 8MiB 上限的写缓冲（`MAX_PENDING_BYTES`，超限即 commit），把"WAL 记录流"翻译成"Key-Value 批"，再由 `TimelineWriter::put_batch` 写入 `InMemoryLayer`（EphemeralFile + disk_btree 索引）。攒够 `checkpoint_distance`（默认 256MB）后 `roll_layer` 冻结旧层开新层；flush loop（`timeline.rs:5158`）把冻结层写成不可变的 L0 delta layer 并调度上传。

关键决策：**为什么 L0 是"全 keyspace 覆盖"**——它是 WAL 时间序的直接切片，写放大最小但读放大最恶（任何 key 都可能落在任意 L0 里）；compaction 的第一优先级就是把 L0 重组为按 keyspace 切分的 L1。flush 并发受全局闸门约束：`L0FlushConfig::Direct`（`l0_flush.rs:11`）默认 `max_concurrency = num_cpus`，经 `tokio::sync::Semaphore` 实现（`:32`）。L0 堆积时还有两级背压：`l0_flush_delay/stall_threshold` 让 flush 减速（`roll_layer` 中 wait），向上传导为 WAL ingest 减速，再传导到 compute 的复制延迟上限——这是"存储健康优先于写入吞吐"的明确取舍。

### 读流水线：get_vectored 与 image 地板

`get_vectored`（`timeline.rs:1339`）服务 keyspace 批量查询：page_service 把同连接的请求攒批（`handle_pagerequests_pipelined`），同 LSN 的页合成一次跨层检索；key 总数超过 `max_get_vectored_keys` 配置时直接返回 `GetVectoredError::Oversized`（`:1349`）——防止单请求撑爆内存。`LayerMap::search`（`layer_map.rs:448`）的查找优先级 image > delta > in-mem，命中后 `Layer::get_values_reconstruct_data`（`layer.rs:322`）经 `get_or_maybe_download(true)` **按需从 S3 拉回**（ResidentLayer 是 RAII 驻留守卫，存活期间禁止 evict）。跨祖先 timeline 的递归在 `get_vectored_reconstruct_data`（`:4491`）——分支读就是"自己的层 + 祖先的层"拼起来的。

`reconstruct_value`（`:7090`）是语义终点：有 image 且无增量记录直接返回镜像（`records.is_empty()` 分支）；既无 image 又有记录时，能否构造取决于首条记录的 `will_init()`（`timeline.rs:7124`——FPI 全页镜像类记录自带初始状态，才能无基线重放）；否则把记录打包送 walredo。**image 层因此被称为"读放大的地板"**——没有它，任何一次读都要从 timeline 起点重放全部 WAL，compaction/GC 造 image 的本质是"给读路径持续铺地板"。

### WalRedoManager：真 Postgres 当 redo 引擎

delta 层里躺着的是任意 rmgr 的 PG WAL 记录（heap/btree/multixact……上百种 redo），自研重放器不可能正确维护。Neon 的答案（`walredo.rs` 头注释 "We rely on Postgres to perform WAL redo for us"）：spawn 一个 `postgres --wal-redo` 子进程（每 tenant shard 一个，懒启动、空闲超时 quiesce），smgr 换成 `inmem_smgr.c`（纯内存 64 页，零磁盘写），stdin/stdout 走 `BeginRedoForBlock/PushPage/ApplyRecord/GetPage` 四条消息（`walredo/process/protocol.rs:19`）。安全边界用 seccomp allowlist 封死 syscall——WAL 可能被恶意构造，这是把不可信输入关进沙箱。记录分发按 `RedoAttemptType`（`walredo.rs:141`）分三档重试预算：读路径 `ReadPage` 失败重试 2 次并触发 critical、legacy compaction 重试 1 次、GC compaction 不重试（`:186`）；neon 自有记录经 `apply_neon::can_apply_in_neon` 判定后走 Rust 内联 `apply_batch_neon`（`walredo/apply_neon.rs`），省掉进程往返开销。

### 上行下行：UploadQueue 与 DeletionQueue

上行：`UploadQueue`（`upload_queue.rs:32`）是状态机（Uninitialized/Initialized/Stopped），新优化（乱序上传重排、index 写合并）各带环境变量 kill switch 渐进发布。乱序的精细规则在 `UploadOp::can_bypass`（`:513`）：Barrier/Shutdown 谁也不能越（全局保序点）；不同文件的 Upload/Delete 可互相越；Delete 幂等故 Delete 之间任意越；与 `UploadMetadata`（index 上传）交互时要求"被上传 index 与现行 index 都不引用该文件"才能越——index 引用着的文件绝不能被绕过修改或删除；两个 index 上传之间不可越但可合并（`next_ready` 的 coalesce）。下行：`DeletionQueue`（`deletion_queue.rs:68`）三段流水线 `ListWriter → Validator → Deleter`——S3 DeleteObjects 按 1000 key 攒批，删除前列表落盘（重启可恢复），Validator 拿删除清单向 storcon 校验 generation，旧代删除被拒。**为什么删除这么谨慎**：S3 没有 CAS，"僵尸 pageserver"（失去租约但还在跑）的删除如果执行了，会删掉新 owner 刚写的数据——generation 校验是数据安全的最后一道闸。Secondary location（`secondary.rs`）按 attached 节点上传的 heatmap 只保温 layer 缓存，让迁移时 attach 无需大量下载（"秒级迁移"的物质基础）。

### Compaction 双路线

生产路线 `compact_level0`（`compaction.rs:1840`）：L0 merge-sort 重组为 L1 + image compaction，受 `CONCURRENT_L0_COMPACTION_TASKS` 独立信号量约束、`compaction_circuit_breaker` 连续失败熔断 24h。新路线 tiered 已拆成独立 `pageserver/compaction/` crate——`trait CompactionJobExecutor`（`interface.rs:15`）定义五个关联类型把算法与宿主完全解耦，配套 `simulator/` 离线模拟器（`compaction-simulator` 二进制）。这是"算法 crate 化 + 模拟器先行"的重构范式：模拟器上验证分层策略，再接回真实执行器。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 三层状态机 | `TenantState`(`models.rs:60`) / `UploadQueue` / layer 生命周期 | 放置、上传、数据三种状态各自可观测、可等待 |
| Gate + CancellationToken | `timeline.rs:382-386` | 关停安全：长任务持 gate 进入，cancel 即退 |
| 熔断器 | `compaction_circuit_breaker`（`tenant.rs:3135`） | 连续失败任务熔断 24h，防止坏租户拖垮共享节点 |
| trait 解耦 + 模拟器 | `CompactionJobExecutor`（`compaction/src/interface.rs:15`） | 算法可独立开发与验证 |
| RAII 驻留守卫 | `ResidentLayer`（`storage_layer/layer.rs:1882`） | Drop 释放即允许 evict，无泄漏窗口 |
| kill switch 环境变量 | `upload_queue.rs` `DISABLE_*` | 新优化可一键回退 |

## 模块间交互

依赖 `pageserver_api`（Key/KeySpace/ShardIdentity/模型——独立 crate 打破与 storcon 的循环依赖）、`utils`（Lsn/Generation/SeqWait/Gate）、`remote_storage`（多云上传）、`postgres_backend`（pagestream 协议）、`wal_decoder`（InterpretedWalRecord 语义）。向 safekeeper 拉取（物理复制 + broker 发现，见 02 篇）；向 storcon 上报心跳并接受 location_config/generation（见 03 篇）；DeletionQueue Validator 经 `StorageControllerUpcallApi`（`controller_upcall_client.rs`）反向调用 storcon。与 compute 的交互面见 05 篇。

## 扩展方式

- **新增 layer 类型**：扩 `LayerKind`（`storage_layer/layer.rs:1875`）+ `get_values_reconstruct_data` 分派 + 新建 `xxx_layer.rs`；命名/元数据在 `layer_name.rs` 与 `remote_timeline_client/index.rs`；产出侧接 `flush_frozen_layer` 或 compaction。
- **修改 compaction 策略**：核心在 `pageserver/compaction/src/compact_tiered.rs`（先跑模拟器），宿主适配层 `timeline/compaction.rs:2562`；阈值在 `pageserver_api` config defaults。
- **新增 pagestream 消息**：定义加 `libs/pagestream_api`，分发在 `page_service.rs::handle_pagerequests`，数据面落在 `pgdatadir_mapping.rs` 新查询函数。

对应测试：`test_runner/regress/test_pageserver*` 系列、compaction 行为在 `test_pageserver_compaction.py`。
