---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "查询协调与协议"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "Coordinator", "MySQL 协议", "NIO", "两阶段调度", "SimpleScheduler"]
description: "Doris 1.1.5 查询协调与协议：Coordinator（2402 行）两阶段 Fragment 调度、MySQL NIO 非阻塞协议、SimpleScheduler 轮询+黑名单选 BE、StmtExecutor 执行模板。1.x 单 Coordinator 类，2.x 才拆分。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

本模块由 `fe/.../qe/`（~1.7 万行）、`mysql/`（~0.8 万行）、`service/`（~0.14 万行）组成，是 FE 与外部客户端、FE 与 BE 之间的桥梁：MySQL 协议接入与会话管理、SQL 语句执行编排、Fragment 两阶段调度下发、结果拉取回传。`Coordinator`（2402 行）是 1.x 的单体协调类（2.x 才拆分为 Coordinator/FragmentExecParams/BackendExecState 等），承载调度、结果拉取、状态管理、负载管理、Runtime Filter 分配、Colocate/Bucket Shuffle Join 分配等多重职责。

## 模块架构

```
MySQL 客户端
   │  TCP
   ▼
NMysqlServer (mysql/nio/NMysqlServer.java:39) ── Xnio NIO
   ├─ xnioWorker (IO 线程池, :42)
   ├─ taskService (任务线程池, :49)
   └─ AcceptListener.handleEvent() ── 建连 → ConnectScheduler.submit()
        └─ MysqlProto.negotiate(context) ── 认证握手 (mysql/MysqlProto.java:159)
        └─ ConnectProcessor processor = new ConnectProcessor(context)
        └─ context.startAcceptQuery(processor)
             └─ ReadListener.handleEvent()  [mysql/nio/ReadListener.java:41]
                  ├─ ctx.suspendAcceptQuery()   ── IO 线程同步 suspend 防重复触发
                  └─ taskService.execute(() -> processOnce())  ── 任务线程异步处理
                       │  处理完
                       └─ ctx.resumeAcceptQuery()  ── 恢复读监听
   │
   ▼
ConnectProcessor (qe/ConnectProcessor.java:71)
   ├─ processOnce() (:521)  ── 读 MySQL 包
   ├─ dispatch() (:333)     ── switch 命令分发 (COM_QUERY→handleQuery)
   ├─ handleQuery() (:171)  ── 解析+new StmtExecutor+execute
   └─ proxyExecute() (:412) ── Follower 转发 Master
   │
   ▼
StmtExecutor (qe/StmtExecutor.java:149)
   ├─ execute(queryId) (:331) ── 模板: analyze → 分发 handler
   ├─ analyze() (:557)        ── 解析+语义分析+改写+计划生成
   ├─ handleQueryStmt() (:939)
   ├─ sendResult() (:980)    ── new Coordinator + exec + 拉结果回包
   └─ forwardToMaster() (:533) ── MasterOpExecutor 转发
   │
   ▼
Coordinator (qe/Coordinator.java:133)
   ├─ exec() (:476) ── 两阶段调度总控
   │    ├─ prepare() (:488)
   │    ├─ computeScanRangeAssignment() (:1441) ── 阶段1a: scanRange→host
   │    ├─ computeFragmentExecParams() (:929)   ── 阶段1b: instance 参数
   │    │    └─ computeFragmentHosts() (:1129) + assignRuntimeFilterAddr()
   │    └─ sendFragment() (:567)                ── 阶段2: 下发 BE
   │         ├─ (fragments.size()>=2) twoPhaseExecution (:585)
   │         │    ├─ execRemoteFragmentsAsync() (:649) ── prepare RPC
   │         │    └─ execPlanFragmentStartAsync() (:658) ── start RPC
   │         └─ 按 BE 分组 (beToExecStates, :612)
   ├─ getNext() (:834) ── 拉结果: receiver.getNext → sendOnePacket
   ├─ updateFragmentExecStatus() (:1597) ── BE 上报
   └─ cancelInternal() (:911)
   │
   ▼
ResultReceiver → BE (fetch_data brpc) → MysqlChannel.sendOnePacket → 客户端
```

## 调用链路

```
NMysqlServer.start()                                 [NMysqlServer.java:64]
  → AcceptListener → ConnectScheduler.submit()
  → MysqlProto.negotiate(context)                   [认证]
  → ConnectProcessor.processOnce()                  [ConnectProcessor.java:521]
    → dispatch() (:333) → handleQuery() (:171)
      → analyze(originStmt)                         [:263 → SqlParser]
      → new StmtExecutor(ctx, parsedStmt); executor.execute()  [StmtExecutor.java:331]
        → analyze(sessionVariable.toThrift())       [:557]
        → handleQueryStmt() (:939) → sendResult() (:980)
          → coord = new Coordinator(context, analyzer, planner)  [:990]
          → coord.exec()                            [Coordinator.java:476]
            1. prepare()                            ── descTable.toThrift, queryOptions
            2. computeScanRangeAssignment()         ── scanRange→BE 分配 (SimpleScheduler.getHost:1572)
            3. computeFragmentExecParams()         ── 选 host, 分配 instanceId
            4. sendFragment()                       ── 按 BE 分组下发:
               [twoPhase] execRemoteFragmentsAsync (prepare) → execPlanFragmentStartAsync (start)
               [single]   exec_plan_fragments
          → while(true) { batch = coord.getNext(); channel.sendOnePacket(row) }  [:997]
            → receiver.getNext(status)              [ResultReceiver.java:58 → brpc fetch_data]
        → finalizeCommand() → channel.sendAndFlush()
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `ConnectProcessor.dispatch` | 命令分发 | switch MySQL 命令类型（命令模式变体） |
| `StmtExecutor.execute` | 执行模板 | analyze→handler 分发 |
| `Coordinator.exec` | 两阶段调度 | prepare→assign→sendFragment |
| `Coordinator.computeScanRangeAssignment` | scanRange 分配 | SimpleScheduler 轮询选 BE |
| `Coordinator.sendFragment` | 下发 BE | 两阶段 RPC（prepare+start），按 BE 分组省 RPC |
| `Coordinator.getNext` | 拉结果 | receiver.getNext → sendOnePacket |
| `SimpleScheduler.getHost` | 选 BE | 轮询 + isAvailable + 黑名单 TTL |
| `ConnectProcessor.proxyExecute` | Master 代理 | Follower→Master 转发 |

</details>

## 核心实现

### Coordinator 两阶段 RPC 调度

`sendFragment()`（`Coordinator.java:567`）当 `fragments.size() >= 2`（`:585` `twoPhaseExecution`）走两阶段：先 `execRemoteFragmentsAsync()`（`:649`）让所有 fragment 只 prepare 不执行，再 `execPlanFragmentStartAsync()`（`:658`）统一触发 start。**为什么**：fragment 间有依赖（A 发数据给 B 的 ExchangeNode），单 RPC 顺序发送会导致 B 在 A 未就绪时开始接收出错。`< 2` 个 fragment 时直接单 RPC 省往返。优化：按 BE 分组 `beToExecStates`（`:612`），同 BE 的 instance 合并一次 RPC，`unsetFields()`（`:647`）去重复 DescriptorTable 减体积。

### SimpleScheduler 选 BE

`SimpleScheduler.getHost`（`SimpleScheduler.java:127`）无指定 BE 时轮询 `nextId.getAndIncrement() % backendSize`（`:134`），选中后 `isAvailable()`（`:199`，`backend != null && isQueryAvailable() && !blacklist`）检查，不可用顺序找下一个。**黑名单**（`:190`）：故障 BE 加入，TTL `heartbeat_interval_second + 1` 秒，`UpdateBlacklistThread`（`:203`）每秒递减到期移除。

### 1.x 单 Coordinator vs 2.x 拆分

1.1.5 的 `Coordinator`（2402 行）承载调度、结果拉取、状态管理、负载、Runtime Filter、Colocate/Bucket Shuffle Join 分配（内含 `BucketShuffleJoinController` 内部类）。2.x 拆为 `Coordinator`/`FragmentExecParams`/`BackendExecState` 等。1.x 单体耦合高但调用链简单（所有状态一类内可见，无需跨类传递），代价是难维护测试。

### NIO 非阻塞

`NMysqlServer`（`:39`）基于 Xnio。`ReadListener.handleEvent()`（`:41`）IO 线程检测可读后 `suspendAcceptQuery()`（`:45`，必须在 IO 线程同步调 `XnioIoThread.requireCurrentThread()`，否则一个查询唤醒多个任务线程），提交 task 线程处理（`:47`），处理完 `resumeAcceptQuery()`（`:52`）。**为什么**：阻塞模式每连接独占线程，`fetchOnePacket` 时阻塞，高并发线程开销大；NIO 的 IO 线程数（`mysql_service_io_threads_num`）远小于连接数，task 线程池处理实际命令。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 会话/上下文 | `ConnectContext` ThreadLocal in `ConnectContext.java:55,267` | 线程内单例访问会话状态 |
| 命令分发 | `ConnectProcessor.dispatch` switch in `:333` | 按 MySQL 命令类型分发（命令模式变体） |
| 模板方法 | `StmtExecutor.execute` in `:331`、`Coordinator.exec` in `:476` | 执行骨架→handler；调度骨架→assign→send |
| 代理 | `ConnectProcessor.proxyExecute`/`StmtExecutor.forwardToMaster`/`FrontendServiceImpl.forward` in `:412,533,659` | Follower→Master 转发 |

## 模块间交互

依赖 `analysis`（SqlParser/Analyzer）、`planner`（Planner/PlanFragment）、`catalog`（Catalog 单例、`Coordinator.prepare` 经 `Catalog.getCurrentSystemInfo().getIdToBackend()` 取 BE）、`task`（BackendServiceProxy 发 Thrift/brpc）、`thrift`（FrontendServiceImpl）。被 `mysql` 入口与 `load`（LoadLoadingTask 复用 Coordinator 执行导入计划）调用。

## 扩展方式

**修改 fragment 分配策略**（如负载感知选 BE）：`SimpleScheduler.getHost`（`:127`）改轮询为按 BE 实时负载选最空闲，`isAvailable()`（`:199`）加负载阈值。**新增会话变量**：`SessionVariable.java` 加 `@VariableAttr` 字段，`Coordinator.java:316` `queryOptions.setEnableVectorizedEngine` 类似自动下发 BE，并在 `TQueryOptions` Thrift 加字段。**修改两阶段触发条件**：`Coordinator.java:585` `twoPhaseExecution` 改为 false 强制单阶段（注意 fragment 依赖可能导致数据丢失，应经 Config 控制）。
