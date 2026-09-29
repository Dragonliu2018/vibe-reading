---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "导入栈"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "数据导入"]
description: "TiDB 新一代导入栈解读：ingestor SST 直写、global sort 三步流水线、DXF 分布式任务框架与 objstore 抽象"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/ingestor/` + `pkg/dxf/` + `pkg/objstore/` 是 2024-2026 逐步成型的**新一代导入基础设施**，服务于 `IMPORT INTO`、Lightning、分布式 add-index 三类场景。三者分工：ingestor 是数据平面（把编码好的 KV 排序成 SST 直写 TiKV）；dxf 是控制平面（长任务的分布式调度与资源管理）；objstore 是外部存储统一抽象（S3/OSS/GCS/Azure/HDFS/local）。`pkg/ingestor/doc.go:15-23` 写明出身：*"currently most of the code is in pkg/lightning/backend, we will try to move them to this package gradually"*——ingestctrl 就是 Lightning local backend 的迁出新家。

## 模块架构

```
pkg/ingestor/
├── doc.go                 # 模块定位注释
├── ingestctrl/            # 本地引擎控制面（原 lightning local backend）
│   ├── local.go           # Backend：OpenEngine/CloseEngine/ImportEngine（:546/:1405）
│   ├── engine.go          # Engine：本地 pebble 引擎 + SST 管理（:95）
│   └── region_job.go      # regionJob：region 级导入状态机（:117）
├── globalsort/            # 外部排序引擎：对象存储上的已排序数据（engine.go:132）
├── simplesst/             # 轻量 sorted-KV 文件读写器（global sort 中间格式）
├── ingestcli/             # TiKV ingest 客户端（WriteClient 流式 + Ingest）
└── globalsort/merge.go split.go   # 归并与 range 切分
pkg/dxf/
├── framework/             # 调度核心：owner 调度 / task executor / slot 配额
├── operator/             # AsyncOperator + AsyncPipeline（数据管道积木）
├── importinto/           # IMPORT INTO 的 step 实现（task_executor.go 等）
└── example/              # 新任务类型的官方模板
pkg/objstore/
├── storage.go parse.go   # 工厂：按 StorageBackend URL 分派（:73/:60）
├── storeapi/             # Storage 接口（storage.go:142）
├── s3store/ ossstore/ gcs/ azblob/ local/ hdfs/ memstore/  # 各后端
└── locking.go recording/ metering/  # 分布式锁、访问计量
```

## 调用链路

一次 IMPORT INTO（global sort 模式）：

```
ImportIntoExec.Next → submitTask                       pkg/executor/import_into.go
└─ importinto.SubmitTask（写 DXF meta 表）
[DXF 调度到某节点，每步一个 subtask]
① Step EncodeAndSort：
   importStepExecutor.RunSubtask                     dxf/importinto/task_executor.go:72
   └─ NewAsyncPipeline(encodeAndSortOperator, ...)    # operator/pipeline.go:24
       └─ chunkWorker.HandleTask → 编码 KV
           → simplesst.NewWriterBuilder 写 /{taskID}/{subtaskID}/data|index/   # 局部排序直写对象存储
② Step MergeSort：
   mergeSortStepExecutor → MergeOverlappingFiles      ingestor/globalsort/merge.go:179
   └─ RangeSplitter.SplitOneRangesGroup               split.go:80（切出 region 级 range）
③ Step WriteAndIngest：
   writeAndIngestStepExecutor (task_executor.go:673)
   └─ localBackend.CloseEngine(External config) → globalsort.NewExternalEngine
       └─ Backend.ImportEngine                        ingestctrl/local.go:1405
           ├─ pause PD scheduler + split/scatter region
           ├─ Engine.LoadIngestData（按内存限额批量加载 range）globalsort/engine.go:551
           └─ newRegionJob → doWrite（gRPC 或 ingestcli HTTP）→ doIngest
[收尾] OnDuplicateKeyRecord → CollectConflicts；postProcessStepExecutor 做 admin checksum
```

| 结构 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Backend` in `ingestctrl/local.go:546` | local 引擎生命周期 | 同时管理本地 Engine 与 external engine |
| `regionJob` in `region_job.go:117` | 一个 region 的导入单元 | 双协议兼容（grpc SSTMeta + nextGen HTTP） |
| `globalsort.Engine` in `engine.go:132` | 对象存储上的有序 KV 视图 | dataFiles/statsFiles/splitKeys 全套元信息 |
| `Operator` in `dxf/operator/operator.go:25` | 管道节点抽象 | SetSource/SetSink 用 channel 串成 AsyncPipeline |

## 核心实现

### 为什么需要 global sort

Lightning 的 local backend 要求**单节点本地磁盘放下全部排序数据**——超大规模导入（TB 级单表）会撞上磁盘与内存瓶颈。global sort 把排序搬到对象存储：编码阶段各 worker 局部排序直写云存储（不占本地盘），merge 阶段多路归并成全局有序并切出 region 级 range，ingest 阶段按 range **流式加载**（`globalsort/engine.go` 的 membuf pool + `loadRangeBatchData`，按 memLimit 分批进内存即转写 TiKV）。副产品：多节点分布式归并天然成立，与 DXF 的多节点 subtask 分发互相咬合。

### regionJob：失败恢复的最小单元

`regionJob`（`region_job.go:117`）只管一个 region 的 `[start,end)` 数据，带 stage 状态机（`regionScanned → wrote → ingested`，回退边 `needRescan`，完整状态图见概览「状态流」）。**部分写入失败时更新 keyRange 回到 regionScanned 续传**，而非整个任务重跑——配合 `regionJobRetryHeap`（优先级重试堆）处理"某个 region 的 peer 不健康"这类局部故障。`tikvWriteResult` 同时容纳两代协议：旧 gRPC `sst.SSTMeta` 与 nextGen `ingestcli.WriteResponse`（注释："for cloud generation store engine ... written by tikv-worker"）——TiKV 侧协议演进的过渡期兼容。

### DXF：控制平面与数据平面分离

`pkg/dxf/framework/doc.go:17-23` 定义 DXF 的目标：统一调度、分布式执行、统一资源管理。集群角色二分：**owner 节点**跑 scheduler manager/task scheduler/node manager/balancer（从 meta 表读任务，按 slot 配额分发），**其余节点**跑 task executor manager/slot manager（认领 subtask 执行）。资源抽象为 slot（每核 1 个），任务抽象为 task→step→subtask 三级。`dxf/operator` 提供数据平面积木：`AsyncOperator` 包装 workerpool，`SetSource/SetSink(DataChannel)` 把多个 operator 用 channel 串成 `AsyncPipeline`，`TunableOperator` 支持运行时调 worker 数。分布式 add-index（见 [05-ddl](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/05-ddl)）与 IMPORT INTO 都是 DXF 的任务类型——**一套调度底座，多种长任务复用**。

### objstore：为什么自己抽象一层

直接用各云 SDK 的问题：语义不齐（原子写、range 读、分片上限各不相同）与运维需求（访问计量、分布式锁）。`storeapi.Storage` 接口（`storage.go:142`：`WriteFile/ReadFile/PresignFile/WalkDir/CopyFrom`...）统一了语义（如 `MaxUploadParts=10000` 统一限制）、统一 HTTP 连接复用（`GetDefaultHTTPClient`）、内置分布式锁（`locking.go`）与访问记录（`recording/`，`NewObjStoreWithRecording` 被 subtask summary 使用）。工厂 `New()`（`storage.go:73`）按 `backuppb.StorageBackend` 分派；`s3like` 包让 OSS/KS3 复用 S3 兼容实现——**BR/Lightning/导入栈全部经由这一层访问对象存储**（BR 篇的"新增存储后端 BR 零改动"正是这个设计的收益）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `objstore.New()` switch in `storage.go:73` | 存储后端可枚举替换 |
| 管道 | `AsyncPipeline` in `dxf/operator/pipeline.go:24` | 编码/排序/写盘分阶段并行 |
| 控制/数据平面分离 | DXF framework vs ingestctrl.Backend | 调度可复用，数据平面可独立演进 |
| 状态机 | `regionJob.stage` in `region_job.go` | 局部失败局部恢复 |
| 测试注入 | `regionJob.injectedBehaviour` in `region_job.go:154` | 状态机行为可桩化 |

## 模块间交互

上游：executor 的 `ImportIntoExec`（`pkg/executor/import_into.go`）与 DDL 的分布式 backfill（`pkg/ddl/ingest/backend_mgr.go`、`pkg/ddl/backfilling_dist_*.go`）都直接用 ingestctrl/globalsort；Lightning local backend 同样直调 `ingestctrl.NewBackend`（见 [12-br-lightning](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/12-br-lightning)）。meta：DXF 任务与 subtask 状态记在 meta 表，跨节点经共享存储协调。TiKV：`ingestcli.Client` 用 HTTP chunked request 直连 tikv-worker（区别于旧 gRPC `ImportSST`）。

## 扩展方式

新增 objstore 后端：实现 `storeapi.Storage` → 新建 `pkg/objstore/<backend>.go`（模板：`azblob.go`）→ `parse.go:60` 的 `parseBackend` 加 URL scheme → `storage.go:73` 的 `New()` switch 加 case；非 S3 兼容后端还需扩 kvproto 的 `StorageBackend`。新增 DXF 任务类型：照抄 `pkg/dxf/example/`（doc.go + proto.go + scheduler.go + task_executor.go）定义 step meta 与 StepExecutor。为 importinto 加 step：`planner.go`（`planForStep` switch）+ `proto.go` + `task_executor.go` 新 StepExecutor。
