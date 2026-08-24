---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "查询协调"
date: "2026-08-24T10:22:21+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "2.1.7-rc01"]
tags: ["Apache Doris", "Coordinator", "MySQL", "两阶段调度", "Pipeline", "ScanRange"]
description: "Doris 2.1.7 查询协调：Coordinator 两阶段下发（prepare→start）+ ConnectProcessor 模板方法 + 三策略 ScanRange 分配 + 黑名单流量控制。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/2.1.7-rc01/00-overview)

---

## 模块定位

查询协调是 `fe/fe-core/src/main/java/org/apache/doris/qe/`（~2.8 万行）+ `mysql/`（~1.4 万行）+ `service/`，是 FE 与 BE 之间的桥。它接收 MySQL 协议请求，经 `StmtExecutor` 调用优化器产出物理计划，由 `Coordinator` 将 Fragment 切分、两阶段下发到 BE，并汇总结果回传客户端。独立成文是因为"协调"职责独立于"优化"与"存储"——Coordinator 不关心计划如何生成，只负责把计划分发到正确的 BE 并回收结果。

## 模块架构

```
MysqlServer (mysql/MysqlServer.java) ── XNIO NIO，监听 query_port
   └─ AcceptListener.handleEvent()
        ├─ ConnectContext context = new ConnectContext(connection)  ── 会话上下文
        ├─ MysqlProto.negotiate(context)                            ── 握手+鉴权
        └─ MysqlConnectProcessor (qe/MysqlConnectProcessor.java:55)
             └─ loop() → processOnce() → dispatch() (:275)
                  └─ COM_QUERY (:298) → handleQuery() (:263)
                       └─ ConnectProcessor.executeQuery() [ConnectProcessor.java:214]
                            ├─ NereidsParser.parseSQL()  → Nereids 路径
                            └─ StmtExecutor.execute()
                                 → executeByNereids/executeByLegacy
                                 → executeAndSendResult() [:1786]
                                      └─ Coordinator.exec() [Coordinator.java:671]

Coordinator (qe/Coordinator.java:170) implements CoordInterface
   ├─ prepare() [:552]                    ── 建 fragmentExecParamsMap
   ├─ computeScanRangeAssignment() [:2356] ── 三策略分配 scan range
   ├─ computeFragmentExecParams() [:1608]  ── 分配 instance + runtime filter
   ├─ sendFragment() [:807]                ── 非 pipeline 下发
   ├─ sendPipelineCtx() [:934]             ── pipeline 下发
   └─ ResultReceiver receiver              ── root fragment 结果接收
```

## 调用链路

```
Coordinator.exec() [Coordinator.java:671]
  └─ execInternal() [:715]
       ├─ prepare() [:552]                            ── 建 fragmentExecParamsMap
       │    computeScanRangeAssignment() [:2356]      ── colocate/bucket shuffle/普通
       │    computeFragmentExecParams() [:1608]       ── instanceId + destinations + RF
       ├─ registerInstances() [:730]
       ├─ 创建 ResultReceiver
       └─ [enablePipelineEngine] sendPipelineCtx() else sendFragment() [:776]
            sendPipelineCtx() [:934]:
              1. params.toTPipelineParams(backendIdx)  ── PlanFragment → Thrift
              2. 按 BE 聚合 PipelineExecContexts
              3. serializeFragments() (parallelStream 并行序列化)
              4. execRemoteFragmentsAsync(proxy)  ── Phase1: prepare
              5. [twoPhase] execPlanFragmentStartAsync  ── Phase2: start
  └─ while: batch = getNext() → receiver.getNext() → MySQL row
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `ConnectProcessor.executeQuery` | 解析+执行入口 | Nereids 失败回退 legacy parser |
| `Coordinator.execInternal` | 调度核心 | prepare→start 两阶段，按 BE 聚合 RPC |
| `Coordinator.computeScanRangeAssignment` | ScanRange 分配 | colocate/bucket shuffle/普通三策略 |
| `SimpleScheduler.getHost` | BE 选择 | 优先指定 BE，黑名单过滤 |
| `Coordinator.sendPipelineCtx` | Pipeline 下发 | TPipelineParams + 并行序列化 |
| `ResultReceiver.getNext` | 结果拉取 | Pull-based BRPC fetch_data |

</details>

## 核心实现

### Coordinator 两阶段调度（prepare → start）

`Coordinator.execInternal()`（`Coordinator.java:715`）在 `sendFragment()`/`sendPipelineCtx()` 内实现两阶段执行：先 `execRemoteFragmentsAsync`（Phase 1 prepare，BE 只初始化建 receiver、注册 exchange），若 `twoPhaseExecution == true` 再 `execPlanFragmentStartAsync`（Phase 2 start，BE 统一触发执行）。`twoPhaseExecution` 判定是 `fragments.size() >= 2`（`:829`）——单 fragment 查询无跨 fragment 依赖，直接一发即可。

**为什么两阶段**：fragment 间有依赖（如 ExchangeNode 等 TVF 发数据），必须保证下游 Fragment 准备好接收后上游才发数据。注释（`:822`）明确："If #fragments >=2, use twoPhaseExecution with exec_plan_fragments_prepare and exec_plan_fragments_start"，减少因 RPC 过多导致的 timeout 错误。

### 三策略 ScanRange 分配

`computeScanRangeAssignment()`（`Coordinator.java:2356`）按 fragment 特征选三种策略之一：
- `computeScanRangeAssignmentByColocate`（`:2416`）——colocate join，同组表 BE 序列一致
- `bucketShuffleJoinController.computeScanRangeAssignmentByBucket`（`:3025`，`BucketShuffleJoinController` 内部类）——bucket shuffle join
- `computeScanRangeAssignmentByScheduler`（`:2555`）——普通，委托 `SimpleScheduler.getHost`

### Pipeline 双轨与 MySQL 协议兼容

`enablePipelineEngine`/`enablePipelineXEngine`（`SessionVariable.java:986`/`:989`，均默认 `true`）从 `SessionVariable` 读取，决定走 pipeline thrift 结构（`TPipelineParams`）还是非 pipeline（`TExecPlanFragmentParams`）。两种引擎完成跟踪粒度不同：pipelineX 用 `fragmentsDoneLatch`（fragment×backend），普通 pipeline 用 `instancesDoneLatch`（instance）。

MySQL 协议：`MysqlConnectProcessor.dispatch()`（`:275`）覆盖 `COM_QUERY`/`COM_STMT_PREPARE`/`COM_STMT_EXECUTE`/`COM_INIT_DB`/`COM_QUIT` 等全部 MySQL 命令（`:298-300`）。`MysqlChannel`（`mysql/MysqlChannel.java:45`）底层 XNIO `StreamConnection`，支持 SSL。

### 黑名单 + workload group 双层流量控制

`SimpleScheduler.blacklistBackends`（`SimpleScheduler.java:52`）是 `ConcurrentMap<Long, Pair<Integer, String>>`（剩余重试秒数+原因），`UpdateBlacklistThread`（`:188`）每秒递减自动恢复。`shouldQueue()`（`Coordinator.java:649`）在 `Config.enable_query_queue` 且非 bypass workload group 时，走 `queryQueue.getToken().get()` 阻塞获取令牌——workload group 级并发控制。两层设计：黑名单是 BE 级保护（避免往死节点发 RPC），workload group 是用户级公平。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Template Method | `ConnectProcessor` abstract in `qe/ConnectProcessor.java:99` | 通用 SQL 执行路径由父类控制，子类只实现协议细节 |
| 两阶段调度 | `sendFragment`/`sendPipelineCtx` in `Coordinator.java:807/934` | 解决 fragment 依赖，减少 RPC 数 |
| Strategy | `computeScanRangeAssignment` in `Coordinator.java:2356` | colocate/bucket shuffle/普通三种分配策略 |
| 黑名单 + 令牌桶 | `SimpleScheduler.blacklistBackends` + `queryQueue` | BE 级保护 + 用户级公平双层控制 |

## 模块间交互

`qe` 调用 nereids/analysis 优化、调用 catalog 元数据（`Env.getCurrentSystemInfo().getIdToBackend()` 拿 BE 列表）、通过 task 下发 BE。`Coordinator` 与 BE 通过 `BackendServiceProxy` 发 protobuf RPC（`PExecPlanFragmentRequest`），回调异步（`backendRpcCallbackExecutor` 线程池）。BE 上报结果通过 `TReportExecStatusParams` 到 `FrontendServiceImpl.reportExecStatus`（`:964`）转交 `QeProcessorImpl`。FE 间转发：`FrontendServiceImpl.forward`（`:1006`）校验来源 FE 后转发 master，`ConnectContext.isProxy` 标记代理会话让 BE 统计上报回真正接收连接的 FE。

## 扩展方式

**新增一个会话变量**：在 `qe/SessionVariable.java` 新增 `ENABLE_XXX` 常量 + `@VariableMgr.VarAttr` 字段 + getter；若影响调度在 `Coordinator.initQueryOptions` 下发；若需到 BE 在 `toThrift()` 设 `TQueryOptions` 字段，并在 `gensrc/thrift/` 更新 thrift 定义。对应测试：`regression-test/suites/`。
