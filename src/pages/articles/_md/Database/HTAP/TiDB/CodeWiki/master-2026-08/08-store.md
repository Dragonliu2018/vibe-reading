---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "存储客户端"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "Percolator", "gRPC"]
description: "TiDB 存储客户端解读：client-go 外置后的 driver/copr 适配层、Percolator 2PC、Coprocessor 流水线与 region 重试"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/store/` 是 SQL 世界与 TiKV 协议世界之间的适配层。先说本快照最重要的事实：**旧 `pkg/store/tikv/` 目录已不存在**——事务内核（`twoPhaseCommitter`、`RegionCache`、`RegionRequestSender`、`KVStore`）在 2024 年外置为独立模块 `github.com/tikv/client-go/v2`（go.mod 锁定 `v2.0.8-0.20260807103401` 快照），TiDB 仓库内只留两个薄适配包：`driver/`（事务接口适配）与 `copr/`（coprocessor 迭代器）。这个拆分让客户端可独立发版，也让"TiDB 语义"与"TiKV 协议"在代码上划清了边界。Percolator 2PC 的**协调器在 TiDB 侧**（client-go 内），这是理解 TiDB 事务的第一把钥匙。

## 模块架构

```
pkg/store/
├── driver/                     # kv.Storage/kv.Transaction 接口的 TiKV 适配
│   ├── tikv_driver.go          # TiKVDriver.Open → tikvStore（tikv_driver.go:310）
│   ├── txn/txn_driver.go       # tikvTxn：SetOption 大 switch（txn_driver.go:225-318）
│   ├── txn/snapshot.go         # tikvSnapshot：memBuffer 优先再回源
│   ├── backoff/backoff.go      # Backoffer：退避配置包装（backoff.go:26）
│   └── error/error.go          # ToTiDBErr：client-go 错误 → TiDB errno
├── copr/                       # Coprocessor / MPP / BatchCop
│   ├── coprocessor.go          # copIterator/worker/taskSender 流水线（:970-1272）
│   ├── batch_coprocessor.go    # TiFlash 批量 cop（batchCopIterator :1288）
│   ├── mpp.go                  # MPPClient / EstablishMPPConns（:46/:235）
│   └── region_cache.go         # RegionCache 薄封装：split/bucket 切分（:489）
├── gcworker/gc_worker.go       # GCWorker：推进 safe point（:72/:700）
└── mockstore/                  # unistore：单机测试存储（实现同一 kv 接口）
[外部] github.com/tikv/client-go/v2 —— 2PC/RegionCache/RPCClient 内核
```

## 调用链路

事务提交链：

```
session.CommitTxn → doCommit (session.go:531)
└─ tikvTxn.Commit                       driver/txn/txn_driver.go:115
    └─ tikv.KVTxn.Commit                # client-go：构造 twoPhaseCommitter
        ├─ prewrite primary → 并行 prewrite secondaries
        ├─ async commit：prewrite 返回 min_commit_ts 即成功（secondaries 由 TiKV 后台应用）
        ├─ 1PC：TiKV 直接原子合并（无二阶段）
        └─ normal：commit primary（拿到 commit_ts）→ 异步 commit secondaries
```

Coprocessor 读链：

```
distsql.Select → kv.Request
└─ CopClient.BuildCopIterator                  copr/coprocessor.go:124
    └─ buildCopTasks (:525)                    # RegionCache.SplitKeyRangesByLocations/Buckets 切 task
        └─ copIterator.open (:1204)           # N 个 worker goroutine + taskSender（限速）
            └─ copIteratorWorker.handleTaskOnce (:1723)
                ├─ 构造 coprocessor.Request → SendReqCtx（backoff/重试循环）
                └─ handleCopResponse (:2175)   # 错误分类：regionErr → 失效缓存重切任务
                    └─ respChan → selectResult.Next 消费    # 真流式
```

| 结构 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `tikvStore` in `driver/tikv_driver.go:310` | 嵌入 client-go KVStore + coprStore + gcWorker | storeCache 按 cluster+keyspace 去重 |
| `tikvTxn` in `driver/txn/txn_driver.go:47` | 适配 `kv.Transaction` | `SetOption` 大 switch 透传 SQL 层事务决策 |
| `copIterator` in `copr/coprocessor.go:970` | cop 结果流 | 单 task 点查走 lite worker 免 goroutine |
| `GCWorker` in `gcworker/gc_worker.go:72` | 推进 GC safe point | owner 选举 + PD `advanceTxnSafePoint`（:700） |

## 核心实现

### 2PC 协调器为什么在 TiDB 侧

Percolator 论文本就把协调职责放在客户端。工程收益：事务语义的每次演进（async commit、1PC、fair locking、pipelined DML、mutation checker 依赖的 `columnMapsCache`）都只改 SQL 层与 client-go，**不必动 TiKV 协议**。`tikvTxn.SetOption` 的巨型 switch（`txn_driver.go:225-318`）就是证据——`kv.EnableAsyncCommit`/`kv.Enable1PC` 等由 session 按系统变量（`tidb_enable_async_commit`/`tidb_enable_1pc`）置入，一路透传到 client-go 的事务对象。pipelined DML 走独立路径 `MayFlush`（`:449`）调 `GetMemBuffer().Flush`——写路径也能边写边 flush 而非攒到 commit。

### Region 缓存失效与有界自愈

region 是会动的（split、leader 迁移、epoch 变更），一切正确性都建立在"请求失败后能自愈"。三层机制：client-go 内 `RegionRequestSender.SendReqCtx` 的 backoff/换 peer 重试（外部模块）；TiDB 侧 `copr.Backoffer`（`driver/backoff/backoff.go:54`）按 `tikv.BoRegionMiss()` 等配置退避并在出口 `derr.ToTiDBErr` 统一转错误；以及最有代表性的**有界自愈**——`handleCopResponse`（`coprocessor.go:2175-2253`）处理 "Request range exceeds bound"：第一次失效 region cache + backoff + `buildCopTasks(skipBuckets=true)` 重切；若仍复现则进入 `exceedsBoundRetry` 计数预算（`maxExceedsBoundRetries`，超限直接报错）。region 错误的通用模式在 `:2138`：backoff → 重建 tasks → `handleBatchRemainsOnErr` 补做剩余部分，而非整体重跑。

### Coprocessor 流水线与限流

`buildCopTasks` 把 key range 按 region（或更细的 bucket）切成 `copTask`，`copIterator.open` 起 `concurrency + smallTaskConcurrency` 个 worker + 一个 `copIteratorTaskSender` goroutine，用 `util.RateLimit` 令牌限速（inflight 与内存追踪由 memTracker 的 `actionOnExceed` 做 OOM 反压）。结果经 `respChan` 交 `selectResult.Next` 无序消费（KeepOrder 模式用每 task 专用 chan 保序）。**gRPC streaming** 是性能关键：cop 响应可达数十 MB（`coprocessor.go:2376` 注释），streaming 让 TiKV 分批产出、TiDB 边收边算，配合 paging（`handleCopPagingResult`）动态续读。单 region 点查有 `liteCopIteratorWorker`（`:1036`）内联快路径——小查询不值得起 goroutine。TiFlash 走 `batchCopIterator`/`RegionBatchRequestSender`（多 region 打包成 `StoreBatchTask` 一次发送，失败逐 region 换 peer）与 MPP（`EstablishMPPConns` 建长连数据交换）。

### 错误语义化三层转换

client-go 原始错误 → `derr.ToTiDBErr`（`driver/error/error.go`，按 region 错误/写冲突映射 errno）→ `extractKeyErr`（`txn_driver.go:349`，解码 tablecodec key 生成**带表名/索引名**的 Duplicate Key 错误）→ session 层决定重试或报给用户（`generateWriteConflictForLockedWithConflict` in `:391` 转写冲突）。用户看到的 `Duplicate entry 'x' for key 't.a'` 就是这条链的产物——store 层把 KV 噪声翻译回了 SQL 语言。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 适配器 | `tikvTxn`/`tikvSnapshot`/`Backoffer` | client-go 类型不外泄进 SQL 层 |
| 生产者-消费者 + 限流 | taskCh/respCh + `util.RateLimit` | 流水线背压，内存可控 |
| 重试 + 缓存失效 | `handleCopResponse` in `coprocessor.go:2138` | region 移动是常态而非异常 |
| 策略 | keyspace Codec（API V1/V2）in `tikv_driver.go:160-171` | 多租户编码可切换 |

## 模块间交互

PD：`OpenWithOptions`（`tikv_driver.go:127`）建 PD client 并包成 `CodecPDClient`（keyspace 编解码），TSO 由 client-go 在事务首尾获取；`EtcdSafePointKV`（`:278`）存 service safepoint。distsql 层持有本模块的 `kv.Client` 接口实现消费 cop 结果（见 [03-executor](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/03-executor)）。GCWorker 独立成环：owner 选举 + `advanceTxnSafePoint` 推进 + 触发 TiKV 物理 GC。mockstore（unistore）实现同一套 `kv.Storage` 接口，是"接口接缝"的直接受益者。

## 扩展方式

新增一种 region 错误重试策略（以 exceeds bound 为模板）：`copr/coprocessor.go` 的 `handleCopResponse`（:2134）识别新错误 → `copTask`（:287）加 retry 预算字段 → 需重切任务则 `buildCopTasks`/`handleBatchRemainsOnErr`（:2308）→ 错误表现层 `driver/error/error.go` 加映射；若要在 client-go 内先退避/换 leader，改动在外部仓库（本仓库仅 `Backoffer` 增配置）。新增对象存储无关的存储后端不在此模块——走 `kv.RegisterStore`（见 mockstore 模式）。
