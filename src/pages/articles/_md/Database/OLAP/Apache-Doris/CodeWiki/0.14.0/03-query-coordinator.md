---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "查询协调与协议"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "coordinator", "MySQL NIO", "brpc", "两阶段调度"]
description: "Doris 0.14.0 查询协调：MySQL NIO 接入、Coordinator 两阶段 Fragment 调度、brpc 下发执行计划、ResultReceiver 拉取结果。FE 与 BE 的桥。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块由 `qe/`（~1.4 万行，`Coordinator`/`StmtExecutor`/`ConnectProcessor`/`QeService`）与 `mysql/`（~0.77 万行，含 `nio/` 非阻塞实现）组成，是 FE 的**查询接入与协调层**。它把 `analysis`/`planner` 生成的 `PlanFragment` 切分下发到 BE，并回传结果——是 FE 与 BE 之间的桥，独立于优化与存储。

## 模块架构

```
MySQL 客户端
  │
  ▼
MysqlServer / NMysqlServer (mysql/nio/) ── Xnio 非阻塞多路复用
  │
  ▼
ConnectProcessor (qe/ConnectProcessor.java)
   ├─ handleQuery() (:158)        ── 解析入口
   └─ handleExecute() / handleStatement...
       │
       ▼
StmtExecutor (qe/StmtExecutor.java)
   ├─ execute() (:240)            ── 执行入口
   ├─ analyze() (:404)            ── 委托 analysis/planner
   └─ handleQueryStmt() (:720)    ── 建协调器并执行
       │
       ▼
Coordinator (qe/Coordinator.java:204) ── 单次查询协调者
   ├─ exec() (:386)
   │   ├─ computeScanRangeAssignment() (:400)  ── scan range 按 BE 分配
   │   ├─ computeFragmentExecParams() (:402/773) ── 为每 fragment 选 host、分配 instanceId
   │   └─ sendFragment() (:450)                 ── 两阶段下发
   ├─ BackendExecState.execRemoteFragmentAsync() (:1814)
   │   └─ BackendServiceProxy.execPlanFragmentAsync(brpcAddr, rpcParams) (:1823)  ── brpc protobuf
   └─ getNext() (:678) → ResultReceiver.getNext() (:686) ── brpc fetch_data 拉结果
```

## 调用链路

```
MysqlServer 收包 → ConnectProcessor.handleQuery()                   [qe/ConnectProcessor.java:158]
  → new StmtExecutor(ctx, parsedStmt)                              [:197]
  → StmtExecutor.execute()                                          [qe/StmtExecutor.java:240]
    → analyze() → Analyzer + Planner 生成 PlanFragment              [:404]
    → handleQueryStmt()                                             [:720]
      → coord = new Coordinator(context, analyzer, planner)         [Coordinator.java:204]
      → coord.exec()                                                [:386]
        → computeScanRangeAssignment()   (scan range→BE，轮询+黑名单)  [:400]
        → computeFragmentExecParams()   (fragment→host+instanceId)   [:402]
        → sendFragment() → execRemoteFragmentAsync()                 [:450 / :1814]
             └─ BackendServiceProxy.execPlanFragmentAsync()          [:1823]  ── brpc PExecPlanFragment
        → [fragments≥2 时两阶段: 先 prepare 全部，再统一 start]
      → coord.getNext() → ResultReceiver.getNext()                  [:678 / :686]  ── brpc fetch_data
      → MysqlChannel.sendOnePacket()  ── 返回客户端
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `ConnectProcessor.handleQuery`（`:158`） | MySQL 协议收 SQL | NIO 非阻塞，按命令分发 |
| `StmtExecutor.execute`（`:240`） | 执行入口 | 串起 analyze → handleQueryStmt |
| `Coordinator.exec`（`:386`） | 调度入口 | 三步：scan 分配→fragment 参数→下发 |
| `computeScanRangeAssignment`（`:400`） | scan range 分 BE | `SimpleScheduler.getHost` 轮询 + 黑名单 |
| `computeFragmentExecParams`（`:773`） | fragment 选 host | 为每个 fragment 选 BE、分配 instanceId |
| `sendFragment`（`:450`） | 下发 fragment | fragments≥2 走两阶段（先 prepare 再 start） |
| `execRemoteFragmentAsync`（`:1814`） | 异步下发 | 返回 `Future<PExecPlanFragmentResult>`（brpc） |
| `getNext`（`:678`） | 拉结果 | 经 `ResultReceiver` brpc fetch_data |

</details>

## 核心实现

### 两阶段调度：prepare 全部，再统一 start

`Coordinator.exec()`（`qe/Coordinator.java:386`）的核心设计是**两阶段下发**：当 `fragments.size() >= 2` 时，先对每个 fragment 调 `execRemoteFragmentAsync()`（`:1814`）只做 prepare（BE 侧 `FragmentMgr::exec_plan_fragment` 建 `PlanFragmentExecutor` 但不启动执行），等全部 prepare 成功后再统一触发 start。这样避免了"上游 fragment 已开始拉数据、下游还没就绪"的死锁。每个 `BackendExecState` 持有 `Future<PExecPlanFragmentResult>`（`:472`），统一 `get(remote_fragment_exec_timeout_ms)` 等待。

### brpc 下发 + Thrift 服务并存

0.14.0 的 FE↔BE 是 **brpc + Thrift 双协议**：执行计划下发走 **brpc**（protobuf `PExecPlanFragmentRequest`，经 `BackendServiceProxy.execPlanFragmentAsync` at `:1823`，热路径低延迟、异步 Future），而 FE 暴露给 BE 的导入事务/管理接口走 **Thrift**（`FrontendService.thrift`，`FeServer` 监听 `rpc_port`）。数据回流也走 brpc（`fetch_data`）。这种分工让查询热路径享受 brpc 的低延迟与异步语义，管理类调用复用 Thrift 的成熟生态。

### MySQL NIO 接入

`mysql/nio/` 用 **Xnio** 实现非阻塞 MySQL 协议服务器（`NMysqlServer`），一个线程处理多连接，避免每连接一线程的开销。`ConnectProcessor` 按 MySQL 命令类型分发——`handleQuery`（`:158`）走查询路径，`handleStatement`/`handleInit` 等走其他。`StmtExecutor` 是执行编排者，持有 `Analyzer`+`Planner`+`Coordinator`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 协调者 | `Coordinator`（`:204`） | 单次查询的临时编排者，封装两阶段调度 |
| 两阶段提交（调度层） | `sendFragment`（`:450`） | prepare 全部→start 统一，避免上下游就绪时差死锁 |
| 代理 | `BackendServiceProxy.execPlanFragmentAsync`（`:1823`） | 屏蔽 brpc 客户端细节，返回 `Future` |
| 反应器（Reactor） | `NMysqlServer`（Xnio） | NIO 多路复用，单线程多连接 |

## 模块间交互

`qe` 上游接 `mysql/`（协议接入）与 `analysis`/`planner`（拿 `PlanFragment`），下游经 brpc 调 BE 的 `exec`（`FragmentMgr::exec_plan_fragment`），经 Thrift 调 `service/FrontendServiceImpl`（导入事务）。`Coordinator` 取 `Catalog` 的 BE 拓扑（`SystemInfoService`）做 scan range 分配。

## 扩展方式

新增 MySQL 命令处理：在 `ConnectProcessor` 加 `handleXxx`。改调度策略（如新 Join 分布方式）：改 `computeScanRangeAssignment`（`:400`）与 `computeFragmentExecParams`（`:773`）。新增结果回传方式：改 `getNext`（`:678`）→ `ResultReceiver`。
