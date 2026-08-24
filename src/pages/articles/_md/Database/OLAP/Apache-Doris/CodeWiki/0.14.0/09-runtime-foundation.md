---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "运行时基础"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "runtime", "ExecEnv", "RuntimeState", "MemTracker", "brpc"]
description: "Doris 0.14.0 运行时基础：ExecEnv god class 服务定位器、RuntimeState 片段状态、MemTracker 内存追踪、FragmentMgr/DataStreamMgr、doris_main 四服务启动。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块由 `be/src/runtime/`（~4.8 万行）、`service/`（`doris_main` + brpc/thrift/http 服务）、`agent/`（BE↔FE 心跳与任务代理）、`common/`（`Daemon`/`config`）组成，是 BE 的**运行时基础与资源管理层**，跨模块共享。`ExecEnv` 是 BE 侧 god class 服务定位器，`RuntimeState` 是单 fragment 运行状态，`MemTracker` 追踪内存。

## 模块架构

```
doris_main.cpp:80 main() ── BE 进程入口
   ├─ config::init (be.conf + be_custom.conf)
   ├─ Daemon.init/start (硬件信息/UDF 缓存/函数注册)
   ├─ StorageEngine::open() (:200) → engine
   ├─ ExecEnv::GetInstance() (:207) + ExecEnv::init() (:208) ── BE god class 装配
   │   └─ set_storage_engine(engine)
   ├─ engine->start_bg_threads() (:214)  ── 必须在 ExecEnv init 后
   ├─ ThriftServer be_server (be_port) (:222)       ── BackendService Thrift
   ├─ BRpcService brpc_service (brpc_port) (:230)    ── brpc 热路径
   ├─ HttpService http_service (webserver_port) (:239) ── HTTP + Stream Load
   └─ heartbeat server (heartbeat_service_port) (:251) ── HeartbeatService Thrift

ExecEnv (runtime/exec_env.h:71) ── BE god class 单例
   ├─ StorageEngine (经 set_storage_engine)
   ├─ FragmentMgr (exec_env.h:36 前向声明) ── fragment 执行调度
   ├─ DataStreamMgr (exec_env.h:31 前向声明) ── fragment 间数据流
   ├─ MemTracker 五级                          ── 内存追踪
   ├─ 线程池 × 多个 + client cache
   └─ heartbeat_flags

RuntimeState (runtime/runtime_state.h:63) ── 单 fragment 运行状态
MemTracker (runtime/mem_tracker.h:84 : public enable_shared_from_this) ── 内存追踪
agent/ (heartbeat_server / topic_subscriber) ── BE↔FE 心跳与 tablet 报告
```

## 调用链路

```
BE 启动 (doris_main.cpp:80):
  config::init → Daemon.init/start → ResourceTls::init → BackendOptions::init
  → StorageEngine::open(options, &engine) (:200)
  → ExecEnv::GetInstance() (:207) + ExecEnv::init(exec_env, paths) (:208)
       → 装配 FragmentMgr/DataStreamMgr/MemTracker/线程池
  → engine->set_heartbeat_flags(exec_env->heartbeat_flags())
  → engine->start_bg_threads() (:214)   ── Compaction/Flush/GC，必须在 ExecEnv init 后
  → ThriftRpcHelper::setup
  → 启动四服务: be_server(:222) / brpc(:230) / http(:239) / heartbeat(:251)
  → while(!k_doris_exit) sleep(10) (:268)

fragment 执行期:
  brpc exec_plan_fragment → FragmentMgr(exec_env) → PlanFragmentExecutor
       → RuntimeState 装配 → ExecNode 树 → get_next 拉取
       MemTracker 追踪内存，超限 RETURN_IF_LIMIT_EXCEEDED (exec_node.h:373)
       DataStreamMgr 管 fragment 间数据流（ExchangeNode）
```

<details>
<summary>方法速查表</summary>

| 方法/类 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `doris_main`（`doris_main.cpp:80`） | BE 入口 | 严格装配顺序：Engine→ExecEnv→bg_threads→四服务 |
| `ExecEnv`（`exec_env.h:71`） | BE god class | 单例 `GetInstance`，集中持有所有运行时依赖 |
| `ExecEnv::init`（`:208`） | 装配 ExecEnv | 在 `StorageEngine::open` 之后、`start_bg_threads` 之前 |
| `RuntimeState`（`runtime_state.h:63`） | fragment 状态 | 每 fragment 一个，持有 MemTracker/对象池 |
| `MemTracker`（`mem_tracker.h:84`） | 内存追踪 | `enable_shared_from_this`，五级，超限报错 |
| `start_bg_threads`（`:214`） | 后台线程 | 必须在 ExecEnv init 后（依赖其资源） |

</details>

## 核心实现

### ExecEnv：BE 侧 god class 服务定位器

`ExecEnv`（`runtime/exec_env.h:71`）是 BE 的服务定位器——`GetInstance()`（`:207`）单例，集中持有 `StorageEngine`（经 `set_storage_engine`）、`FragmentMgr`（前向声明 `:36`）、`DataStreamMgr`（`:31`）、五级 `MemTracker`、多个线程池、client cache、`heartbeat_flags`。任何模块经 `ExecEnv::GetInstance()->getXxx()` 取依赖。与 FE 的 `Catalog` 对称——两者分别是各自进程的 god class。`ExecEnv::init`（`:208`）在 `StorageEngine::open`（`:200`）之后装配，再调 `engine->start_bg_threads`（`:214`）——**顺序硬约束**：后台线程依赖 ExecEnv 持有的资源。

### doris_main：严格装配顺序

`doris_main`（`service/doris_main.cpp:80`）的启动顺序是硬约束：`config::init`（be.conf + be_custom.conf）→ `Daemon.init/start`（硬件信息、UDF 缓存、函数注册）→ `StorageEngine::open`（`:200`，恢复 Tablet）→ `ExecEnv::GetInstance`+`ExecEnv::init`（`:207/208`，装配 god class）+ `set_storage_engine` → `start_bg_threads`（`:214`，Compaction/Flush/GC，必须在 ExecEnv init 后）→ 四类服务：Thrift `be_server`（`be_port`，`:222`，`BackendService`）、brpc `brpc_service`（`brpc_port`，`:230`，执行热路径）、HTTP `http_service`（`webserver_port`，`:239`，含 Stream Load）、heartbeat（`heartbeat_service_port`，`:251`，Thrift `HeartbeatService`）→ 主循环 `while(!k_doris_exit) sleep(10)`（`:268`）。TCMalloc 启动设 aggressive decommit 释放空闲页。

### RuntimeState + MemTracker

`RuntimeState`（`runtime/runtime_state.h:63`）是单 fragment 的运行状态——每 fragment 一个，持有 `MemTracker`、对象池、查询选项。`MemTracker`（`runtime/mem_tracker.h:84`，`public std::enable_shared_from_this<MemTracker>`）五级追踪内存，超限时 `RETURN_IF_LIMIT_EXCEEDED`（`exec/exec_node.h:373`）报 `MemoryLimitExceeded`。`agent/` 模块的 heartbeat server 处理 FE↔BE 心跳与 tablet 报告（`topic_subscriber`），`Daemon`（`common/daemon.h`）做硬件信息采集与函数注册。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `ExecEnv`（`exec_env.h:71`） | BE 全局单例，对称于 FE 的 `Catalog` |
| 单例 | `ExecEnv::GetInstance`（`:207`） | 进程唯一 |
| 共享指针 | `MemTracker`（`enable_shared_from_this`） | 内存追踪对象共享生命周期 |
| 模板方法 | `doris_main` 启动顺序 | 固定装配骨架，顺序是硬约束 |

## 模块间交互

`runtime` 是 BE 的底座——`exec`（`ExecNode`/`PlanFragmentExecutor`/`RowBatch`）、`olap`（`StorageEngine` 挂在 `ExecEnv`）、`exprs`（`ExprContext` 用 `MemPool`）都依赖它。`service/doris_main` 装配并启动四服务，`agent` 经 heartbeat 与 FE 交互。`MemTracker` 被 `exec` 的算子用 `RETURN_IF_LIMIT_EXCEEDED` 兜底内存。

## 扩展方式

新增 BE 全局资源：在 `ExecEnv`（`exec_env.h:71`）加字段 + `ExecEnv::init`（`init` 路径）初始化 + `doris_main` 启动顺序对齐。新增后台线程：在 `StorageEngine::start_bg_threads` 或 `ExecEnv` 注册。改内存限制策略：动 `MemTracker`（`mem_tracker.h:84`）与 `RETURN_IF_LIMIT_EXCEEDED`（`exec_node.h:373`）。新增 RPC 服务：在 `service/` 加 brpc/thrift 实现 + `doris_main` 启动。
