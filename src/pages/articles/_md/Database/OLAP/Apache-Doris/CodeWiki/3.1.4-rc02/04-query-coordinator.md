---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "查询协调"
date: "2026-08-23T18:59:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Coordinator", "两阶段调度", "RuntimeFilter", "MySQL 协议"]
description: "Doris 3.1.4 查询协调：Coordinator 两阶段调度（scanRange 分配 + Fragment 下发）+ MySQL/Arrow Flight 协议接入。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

查询协调模块由 `qe/`（~3 万行）+ `mysql/`（~1.5 万行）组成，核心是 `Coordinator`（`qe/Coordinator.java:172`，3437 行）与 `ConnectProcessor`。它是 FE 与 BE 的桥：把优化器产出的物理计划切分成 Fragment，做 scanRange 到 BE 的分配，经 gRPC 下发，收集结果回传客户端。独立成文是因为"调度"是独立于"优化"与"执行"的决策域——副本选择、负载均衡、数据局部性都在此决策，且要同时协调 Nereids 与 legacy 两条规划路径的产物。

## 模块架构

```
MySQL/Arrow Flight Client
   │  MysqlServer (qe/QeService)
   ▼
ConnectProcessor (qe/ConnectProcessor.java) ── 会话级，生命周期=连接
   │  handleQuery / handleCompanionStmt
   ▼
StmtExecutor (qe/StmtExecutor.java) ── 单语句级
   │  executeByNereids/Legacy → 选 Planner
   ▼
Coordinator (qe/Coordinator.java:172) ── 查询级
   ├─ computeScanRangeAssignment (:616/2108) ── scan → BE 副本分配
   ├─ computeFragmentExecParams (:618/1345)   ── Fragment 参数计算
   ├─ deliverExecRPCFragment                 ── gRPC 下发到 BE
   ├─ RuntimeFilter 分配 (ridToTargetParam)
   └─ 结果汇总 send_report
   │
   ▼ (gRPC exec_plan_fragment)
BE FragmentMgr
```

`Coordinator` 持有 `distributedPlans`（FragmentIdMapping）、`fragmentExecParamsMap`（`:221`）、`beToPipelineExecCtxs`（`:225`，BE→执行上下文）、`assignedRuntimeFilters`（`:274`）等。

## 调用链路

```
ConnectProcessor.handleQuery (StmtExecutor.execute)
  └─ planner = new NereidsPlanner(...)  (StmtExecutor.java:862)
  └─ planner.plan(...)                  // 产出 distributedPlans
  └─ coordinator = new Coordinator(context, planner) (Coordinator.java)
  └─ coordinator.exec() (Coordinator.java:664)
       ├─ computeScanRangeAssignment() (:616/2108)
       │    ├─ Colocate 副本分配 (:2189)
       │    ├─ Bucket Shuffle 分配 (:2178/2660)
       │    └─ 通用 Scheduler 分配 (:2182/2323)
       ├─ computeFragmentExecParams() (:618/1345)
       ├─ 分配 RuntimeFilter (Builder→Target)
       └─ deliverExecRPCFragment  ── gRPC 下发到选定 BE
            └─ BE FragmentMgr.exec_plan_fragment
  └─ 结果经 exchange send_report 回 Coordinator → 回客户端
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Coordinator.exec` (`:664`) | 编排两阶段调度 | 先分配 scanRange 再下发，保证局部性 |
| `computeScanRangeAssignment` (`:2108`) | scan→BE 分配 | 多策略：Colocate/Bucket/通用，优化数据局部性 |
| `computeFragmentExecParams` (`:1345`) | Fragment 参数 | 算 instance 数、Exchange 目标 |
| `cancel` (`:1278`) | 取消查询 | 下发 cancel RPC 到所有 BE |

</details>

## 核心实现

### 两阶段调度

`exec` 的两阶段设计：第一阶段 `computeScanRangeAssignment`（`:616`/`:2108`）决定每个 scan 的数据范围由哪个 BE 副本读——这是数据局部性决策；第二阶段 `computeFragmentExecParams`（`:618`/`:1345`）计算各 Fragment instance 的参数与 Exchange 路由。两阶段分离使得局部性决策与执行编排解耦，scanRange 分配可独立调优。

设计决策：**为何 scanRange 分配有三种策略**——Colocate Join（`:2189`）保证 join 两表同 bucket 落同 BE 避免 Shuffle；Bucket Shuffle（`:2660`）按分桶定位省网络；通用 Scheduler（`:2323`）兜底按负载均衡。三者按表特性自动选择，不同 join 模式下最小化数据移动。

### RuntimeFilter 协调

`Coordinator` 管理运行时过滤器的分配：`assignedRuntimeFilters`（`:274`）记录要构建的 filter，`ridToTargetParam`（`:272`）记录 filter 到目标（probe 侧）的映射，`ridToBuilderNum`（`:277`）记录每个 filter 的 builder 数。构建侧在 BE 侧 scan 时生成 BloomFilter 等，经 Exchange 发往 probe 侧注入。`NereidsPlanner.configRuntimeFilterWaitTime`（`:319`）按表行数自适应设置等待时间——小表 1s，大表 20s+，避免小查询被 filter 等待拖慢。

### MySQL/Arrow Flight 协议接入

`QeService`（`DorisFE.start` 中 `new QeService(query_port, arrow_flight_port)`）监听两个端口：MySQL 协议（`query_port`）与 Arrow Flight SQL（`arrow_flight_sql_port`）。`ConnectProcessor` 是抽象类（`:96`），`ConnectType` 枚举区分 MYSQL 与 ARROW_FLIGHT_SQL（`:97`），`MysqlConnectProcessor` 是 MySQL 实现。会话级状态（变量、当前库、查询 ID）在 `ConnectContext`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 协调者（Coordinator） | `Coordinator.exec` | 集中编排多 BE 的 Fragment 下发与结果汇总 |
| 策略 | scanRange 三种分配策略 | 按 join/分桶特性选最优局部性方案 |
| 模板方法 | `ConnectProcessor` 抽象 + 子类 | 协议差异隔离，会话流程复用 |

## 模块间交互

`Coordinator` **依赖** `nereids/` 或 `planner/`（取 distributedPlans + RuntimeFilter）、`catalog/`（查副本位置、表分桶）、`rpc/`（gRPC 下发）。**被** `qe/StmtExecutor` 调用。下游对接 BE 的 `FragmentMgr`（经 `internal_service` gRPC）。结果回传经 `exchange` 与 `send_report`。

## 扩展方式

新增一种 scanRange 分配策略：在 `Coordinator` 增加 `computeScanRangeAssignmentByXxx` 方法，在 `computeScanRangeAssignment` 主流程按表特性分派。调整 RuntimeFilter 行为改 `NereidsPlanner.configRuntimeFilterWaitTime` 与 `RuntimeFilter` 类。对应测试：`regression-test/suites/query_p0/`。
