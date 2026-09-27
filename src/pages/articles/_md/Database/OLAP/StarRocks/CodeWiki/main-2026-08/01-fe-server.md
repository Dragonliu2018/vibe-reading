---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "FE 骨架与服务"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "FE", "GlobalStateMgr", "服务定位器", "守护线程"]
description: "StarRocks FE 进程骨架：StarRocksFEServer 启动序列、GlobalStateMgr 服务定位器 god class、四种对外服务与角色模型。"
readingTime: "15 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

FE 进程的"装配车间"：管启动顺序、管全局单例的聚合、管四种对外服务的生命周期、管后台守护线程的分层启动。它不包含任何 SQL 逻辑或元数据语义（那些在 `sql/` 与 `catalog/`），但所有业务模块都从这里拿到彼此——`server/GlobalStateMgr` 被全库 import 676 次，是事实上的服务定位器。读懂这一篇才能回答"这个 Manager 是谁 new 出来的、什么时候可用"。

## 模块架构

模块核心是三件套：启动入口 `StarRocksFEServer`（`fe/StarRocksFEServer.java`）、god class `server/GlobalStateMgr.java`（3484 行）、守护线程框架 `common/util/Daemon.java`。`GlobalStateMgr` 用懒加载 holder 单例（`SingletonHolder`，`GlobalStateMgr.java:683-685`）保证全进程唯一，`getCurrentState()`（:967）是获取入口，checkpoint 场景另有 `getServingState()`（:990）区分。

`GlobalStateMgr` 聚合约 80 个 Manager/Daemon 字段（:315-574），按域分组：

| 域 | 代表字段 |
| --- | --- |
| 系统层 | `NodeMgr`、`HeartbeatMgr`、`SystemInfoService`、`HistoricalNodeMgr` |
| 元数据层 | `LocalMetastore`（5984 行，真正的元数据读写）、`MetadataMgr`（内/外 catalog 统一入口）、`CatalogMgr`、`ConnectorMgr`、`StorageVolumeMgr`、`WarehouseManager` |
| 负载层 | `LoadMgr`、`RoutineLoadMgr`、`StreamLoadMgr`、`PipeManager`、`ExportMgr` |
| 副本均衡 | `TabletScheduler`、`TabletChecker`、`ColocateTableBalancer`、`DynamicPartitionScheduler` |
| 事务/统计 | `GlobalTransactionMgr`、`PublishVersionDaemon`、`AnalyzeMgr`、`ResourceGroupMgr` |
| 共享数据 | `StarOSAgent`、`CompactionMgr`、`AutovacuumDaemon`（RunMode 判定 :709） |

## 调用链路

### 启动序列

`StarRocksFEServer.start()`（:87-212）的顺序即依赖序：

```text
1. createAndLockPidFile()                # pid 文件锁，防双开
2. new Config().init(conf/fe.conf)       # 反射加载配置
3. FrontendOptions.init() / ExecuteEnv.setup()
4. GlobalStateMgr.getCurrentState().initialize(helpers)
     NodeMgr 初始化 → 建目录 → getClusterIdAndRoleOnStartup() 定角色
     → initJournal()（BDBJE）→ loadImage() → 建守护线程
5. shared-data 时：StarMgrServer（第二个元数据域，同 BDBEnvironment 不同 Database）
6. StateChangeExecutor.start() + waitForReady()
7. QeService(9030) → FrontendThriftServer(9020) → HttpServer(8030) → ArrowFlightSqlService
8. handleGracefulExit()：SIGUSR1 触发 drain 查询连接后退出
```

就绪语义由 `isReady`/`canRead` 两个 AtomicBoolean（:353-357）表达：Observer 掉到 UNKNOWN 时 `isReady=false` 但 `canRead` 保持 true 继续提供读服务（:1996-2004）。

### 角色转换

`transferToLeader()`（:1371）/ `transferToNonLeader()`（:1993）由 `StateChangeExecutor` 单线程串行驱动（BDBJE 选举事件 → `BDBStateChangeListener` → 入队），保证一次只处理一个转换。Leader 侧再分两层拉线程：`startLeaderOnlyDaemonThreads()` 与 `startAllNodeTypeDaemonThreads()`（:1444-1446）。

## 核心实现

### 守护线程框架

```java title="common/util/Daemon.java（派生体系）"
Daemon                       # daemon=true 的循环线程，抽象 runOneCycle()
 ├── LeaderDaemon            # 仅 Leader 跑（txnTimeoutChecker 等）
 └── FrontendDaemon          # 所有节点跑，含 runAfterCatalogReady() 钩子
```

`FrontendDaemon` 的 `runAfterCatalogReady()` 钩子在 `isReady` 前不执行——新写后台线程选这个基类即可天然避开"元数据未就绪就干活"的竞态。典型实例：`ConfigRefreshDaemon`（10s 周期热更新配置并 `appendPersistedProperties` 持久化，:480）。

### HTTP 路由注册

`http/` 用 ActionController 注册表：每个 Action 类静态块 `controller.registerHandler(HttpMethod.GET, "/xxx", new XxxAction(controller))`，Netty 实现的 `HttpServer` 分发到 `BaseAction.executeGet/Post`。新增端点零中心化修改——路由即注册。

### 无回滚的 Leader 激活

`transferToLeader()` 失败直接 `System.exit(-1)`（:1414-1418，注释明言"半完成的 activation 无法可靠回滚"）；Leader 降级拆 7 个 stage（`executeLeaderDemotionStages`，:2032-2043）任一失败同样 exit。这是"宁可重启、不要不确定状态"的取舍。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `GlobalStateMgr.getCurrentState()` | 免 DI 框架；代价是 god class，社区正逐步拆分（NodeMgr/LocalMetastore/MetadataMgr 即拆分产物，目录留有痕迹） |
| 懒加载 holder 单例 | `SingletonHolder`（:683） | 线程安全的延迟初始化 |
| 观察者 | `JournalObservable` 通知 journal 追平；`GlobalLoadJobListenerBus` | 元数据追平是多个组件的共同前置条件 |
| 工厂 | `journal/JournalFactory.create(nodeName)` | Journal 后端可替换（BDBJE 仅为实现之一） |

## 模块间交互

- **被谁用**：`sql/analyzer`（解析期取 catalog/auth）、`qe`（ConnectProcessor、DDLStmtExecutor）、`http/action`（如 `VariableAction` 直接 `getCurrentState().getVariableMgr().dump()`）——几乎所有 FE 业务包。
- **出站**：`rpc/BackendServiceClient`（Thrift 连接池 + guava ListenableFuture，`getInstance()` :110）向 BE 发控制面请求；`rpc/BrpcProxy` 走 brpc。
- 元数据一致性依赖 [02 元数据与 HA](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/02-catalog-ha) 的 EditLog 写读同路径机制。

## 扩展方式

**新增 FE 配置项**：`common/Config.java` 加 `public static` 字段（注释即文档），`fe.conf` 按名覆盖；需热更则标 mutable，`ConfigRefreshDaemon` 自动生效并持久化。

**新增 HTTP 端点**：`http/action/` 新建类继承 `BaseAction` 覆写 `executeGet/Post`，静态块注册路由。

**新增后台守护线程**：仅 Leader 跑继承 `LeaderDaemon`；全节点跑继承 `FrontendDaemon` 并重写 `runAfterCatalogReady()`；字段挂 GlobalStateMgr 构造器，在对应分层启动方法里 start。

**待核实**：`StarMgrServer` 与主 GlobalStateMgr 的双 journal 协同细节（共享 BDBEnvironment 但独立 Database 的 commit 时序）。
