---
source:
  type: "源码解读"
  project: "Druid"
  url: "https://github.com/apache/druid"
title: "节点启动与服务发现"
date: "2026-08-21T15:52:35+08:00"
category: [Database, OLAP, Druid, CodeWiki, "37.0.0"]
tags: ["Druid", "Guice", "服务发现", "ZooKeeper", "Leader"]
description: "Druid 节点启动——Main/Cli 入口、三层 InjectorBuilder Guice 装配、DruidNode/NodeRole、Curator ZK 服务发现/LeaderLatch、Jetty、DiscoverySideEffectsProvider。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Druid/CodeWiki/37.0.0/00-overview)

---

## 模块定位

本模块（`services/.../cli/` + `server/.../discovery/`、`initialization/`、`guice/`）是所有 Druid 节点的**启动引导与集群成员基础**：CLI 入口、Guice 依赖注入装配、HTTP/Jetty 服务器、ZK 服务发现与 Leader 选举。职责边界：**一个节点如何启动、装配对象、加入集群并（对 leader 角色）竞选**；各节点内部的业务（查询/调度/均衡）见对应模块。

## 模块架构

```
Main（命令注册）→ CliBroker/CliCoordinator/...（extends ServerRunnable）
  → ServerInjectorBuilder（三层）
       CoreInjectorBuilder（~30 核心 module）
       ServiceInjectorBuilder（Modules.override 覆盖层）
       ExtensionInjectorBuilder（扩展 module 覆盖层，@LoadScope 过滤）
  → ServerModule（@Self DruidNode 绑定 + ZkPathsConfig）
  → JettyServerModule（HTTP server 创建/挂载 resource）
  → DiscoveryModule（PolyBind 发现+选举策略）
  → AnnouncerModule（segment announcer）
节点启动后：
  DruidNodeAnnouncer（ZK ephemeral 节点） + DruidNodeDiscoveryProvider（PathChildrenCache 监听）
  DruidLeaderSelector（LeaderLatch）→ Coordinator/Overlord HA
```

## 调用链路

```
main → services/.../cli/Main（注册命令）→ Cli*.run（GuiceRunnable）
  → makeInjector（ServerInjectorBuilder 三层组装，注册 NodeRole）
  → ServerRunnable.initLifecycle
    → ServerModule 绑定 DruidNode（host/port/serviceName）
    → JettyServerModule 创建 Jetty、挂 QueryResource/SqlResource
    → DiscoverySideEffectsProvider.get（ServerRunnable.java:160）
       for nodeRole: 收集 @Self Set<DruidService> → 构造 DiscoveryDruidNode
       lifecycle.addHandler(ANNOUNCEMENTS 阶段):
         start: announcer.announce(DiscoveryDruidNode)  # CuratorDruidNodeAnnouncer 写 ZK
                serviceAnnouncementState.markReady()
         stop:  unannounce + markNotReady
Leader 角色（Coordinator/Overlord）：
  DruidCoordinator.start → leaderSelector.registerListener
    → CuratorDruidLeaderSelector（LeaderLatch.start）
       → LeaderLatchListener.isLeader → term++ → becomeLeader()
       → notLeader → stopAndCreateNewLeaderLatch（随机 sleep 1-5s 重加入）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `GuiceRunnable.makeInjector` | 组装 injector | 三层 builder |
| `ServerInjectorBuilder` | 三层注入 | Core/Service/Extension 覆盖 |
| `DruidNodeAnnouncer.announce` | 注册节点 | ZK ephemeral 节点 |
| `DruidNodeDiscoveryProvider.get` | 发现节点 | PathChildrenCache 监听 |
| `DruidLeaderSelector.registerListener` | leader 选举 | LeaderLatch + localTerm |
| `DiscoverySideEffectsProvider.get` | 组装发现元数据 | 按 NodeRole 聚合 DruidService |

</details>

## 核心实现

### CLI 入口与 GuiceRunnable

`services/.../cli/Main.java` 是 CLI 入口、注册命令。`CliBroker`/`CliCoordinator`/`CliHistorical`/`CliIndexer`/`CliMiddleManager`/`CliOverlord`/`CliPeon`/`CliRouter` 是各节点入口（如 `CliBroker` 8082、`CliCoordinator` 8081、`CliHistorical` 8083）。它们继承 `GuiceRunnable`/`ServerRunnable`，`GuiceRunnable.makeInjector` 组装 injector，`ServerRunnable.initLifecycle` 启动生命周期。

### 三层 InjectorBuilder

`server/.../initialization/ServerInjectorBuilder.java` 三层组装：`CoreInjectorBuilder`（`server/.../initialization/CoreInjectorBuilder.java`，~30 核心 module 注册）、`ServiceInjectorBuilder`（`Modules.override` 覆盖配置层）、`ExtensionInjectorBuilder`（扩展 module 覆盖层）。基类 `DruidInjectorBuilder`（`server/.../guice/`）按 `@LoadScope` 过滤 module（只加载当前节点角色需要的）。`StartupInjectorBuilder`（`processing/.../guice/`）是启动 injector，加载并校验 Properties。节点差异靠组合不同 module——例如 `CliCoordinator` 支持 `druid.coordinator.asOverlord.enabled=true`，此时 `getNodeRoles` 返回 `{COORDINATOR, OVERLORD}`、`getModules` 合并 `CliOverlord.getModules(false)`、`RedirectInfo` 绑到 `CoordinatorOverlordRedirectInfo`，一个进程兼任两职。

### DruidNode / NodeRole / 服务发现

`server/.../server/DruidNode.java` 是节点身份（host/port/serviceName）。`server/.../discovery/NodeRole.java`（8 种内置角色 + 自定义扩展）。`DiscoveryDruidNode`（`server/.../discovery/DiscoveryDruidNode.java`）是发现节点完整元数据（DruidNode + NodeRole + services map）。`DruidService`（`discovery/DruidService.java`）服务元数据抽象（如 `DataNodeService`）。`DruidNodeDiscovery`（`discovery/DruidNodeDiscovery.java`）节点发现接口，`DruidNodeDiscoveryProvider`（`discovery/DruidNodeDiscoveryProvider.java`）发现 Provider 抽象 + service 聚合。`AbstractDruidServiceModule`（`services/.../guice/`）把 `DruidService`→`NodeRole` 经 MapBinder 注册，`DruidBinders`（`server/.../guice/DruidBinders.java`）提供 Multibinder 工厂方法集。

### ZK 实现（Curator）

`server/.../curator/discovery/`：`CuratorDruidNodeDiscoveryProvider`（ZK 实现，`PathChildrenCache` 监听 `NodeRoleWatcher` 解析 JSON 为 `DiscoveryDruidNode`）、`CuratorDruidNodeAnnouncer`（写 ephemeral node 到 `{internalDiscoveryPath}/{nodeRole}/{host:port}`，L39-41）、`CuratorDruidLeaderSelector`（`LeaderLatch`）。`DiscoveryModule`（`curator/discovery/DiscoveryModule.java`）用 `PolyBind` 绑定发现+选举策略（可替换 ZK 为其他后端）。

### Leader 选举与 localTerm

以 Coordinator 为例（见调用链路）：`CuratorDruidLeaderSelector` 创建 `LeaderLatch(curator, latchPath, selfId)`（latchPath = `ZkPaths.getCoordinatorPath() + "/_COORDINATOR"`，selfId = `http://host:port`）。`isLeader` 时 `term.incrementAndGet()`（`localTerm()`），`becomeLeader` 起职责。`DruidCoordinator` 执行长任务时间歇检查 `leaderSelector.localTerm()` 是否变化，防脑裂后旧 leader 续跑。`notLeader` 时 `stopAndCreateNewLeaderLatch` 重建、随机 sleep 1-5s 重加入选举（避免羊群效应）。

### Jetty 与 DiscoverySideEffectsProvider

`JettyServerModule`（`server/.../server/initialization/jetty/`）创建并初始化 Jetty server、挂载 resource。`DiscoverySideEffectsProvider.get`（`ServerRunnable.java:160-209`）按 NodeRole 收集 `@Self Set<Class<? extends DruidService>>` 注入的 service 类，`isDiscoverable` 的构造 `DiscoveryDruidNode`，`lifecycle.addHandler` 在 `Stage.ANNOUNCEMENTS` 启停：start 时 `announcer.announce` + `markReady`，stop 时 `markNotReady` + `unannounce`（兼容 legacy `CuratorServiceAnnouncer`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| DI 容器 | 三层 `InjectorBuilder` + Multibinder | 扩展点统一注册，节点差异靠组合 |
| 策略 | `DruidNodeDiscoveryProvider`/`DruidLeaderSelector` | 发现/选举后端可换 |
| 单例/leader | `DruidLeaderSelector` | HA，防脑裂 |
| 生命周期 | `Lifecycle.Stage`（NORMAL/ANNOUNCEMENTS） | 启停有序 |

## 模块间交互

被所有节点依赖（`cli` 是入口）。依赖 `curator`（ZK）。为 `coordinator`/`overlord` 提供 leader 选举，为 `broker` 提供 Historical discovery（`BrokerServerView` 经 `FilteredServerInventoryView` 监听 server 上下线）。`DruidBinders` 的 Multibinder 是扩展点注册的统一入口。

## 扩展方式

- **新增节点类型**：仿 `Cli*` 继承 `ServerRunnable`，`getNodeRoles` 加自定义 `NodeRole`（8 种内置外可扩展），`getModules` 组合需要的 module，`AbstractDruidServiceModule` 注册该角色的 `DruidService`。
- **更换服务发现后端**：实现 `DruidNodeDiscoveryProvider`/`DruidNodeAnnouncer`/`DruidLeaderSelector`，`DiscoveryModule` 用 `PolyBind` 绑定。
- **新增 Guice binding**：写 `DruidModule` 注册，经 `druid.extensions.loadList` 加载或直接加入节点 module 列表；用 `DruidBinders` 的 Multibinder 工厂注册扩展点。
