---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "服务器装配与插件加载"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "Guice", "classloader", "节点发现"]
description: "Trino 483 服务器装配：Server 启动时序、Coordinator/Worker 模块分化、PluginManager 目录扫描与 ANNOUNCE 节点发现"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

进程怎么从 `main()` 变成一个可服务的 Trino 节点：**Guice Bootstrap 装配 19 个 Module → 插件目录扫描 → catalog 加载 → 各 Manager 依次初始化 → Announcer 对外宣告**。coordinator/worker 的角色分化、认证授权体系、Web UI 与发行版打包也在这里。

范围：`server/`（根包：Server、ServerMainModule、CoordinatorModule、WorkerModule、PluginManager、PluginClassLoader、security/、NodeStateManager）+ `core/trino-server(-main/-core)` 装配关系 + web-ui 打包。

## 模块架构

核心思想：**单二进制双角色**——`ServerConfig.isCoordinator()` 在 Guice 装配期选择安装 `CoordinatorModule` 还是 `WorkerModule`，配置驱动模块图。插件加载是目录扫描 + 独立 classloader（依赖隔离）。认证全部 Manager + Factory 晚绑定（实现来自插件目录，必须等扫描完成才能实例化）。

## 调用链路

```
TrinoServer.main（校验 build.properties target.jdk）
 └─ Server.doStart (server/Server.java:80)
     ├─ 19 个 Guice Module：
     │   Airlift 基础（Node/HttpServer/Json/Jaxrs/MBean/Jmx/Tracing…）
     │   + Trino 领域（ServerSecurity/AccessControl/EventListener/Exchange/
     │     Catalog/Transaction/NodeManager/ServerMain/NodeStateManager/WarningCollector）
     ├─ Bootstrap("io.trino.bootstrap.engine").loadSecretsPlugins().initialize()
     │   └─ ServerMainModule.setup (:203)
     │       ├─ isCoordinator() ? install(CoordinatorModule) : install(WorkerModule)
     │       └─ 双角色共有绑定：SqlParser、SqlTaskManager+TaskResource+TaskExecutor
     │           （TaskManagerConfig 开关选 ThreadPerDriver/TimeSharing）、
     │           LocalExecutionPlanner+ExpressionCompiler/JoinCompiler、
     │           LocalMemoryManager、DirectExchangeClientFactory、MetadataManager
     │           （再包 TracingMetadata）、FunctionManager+GlobalFunctionCatalog
     │           （RegisterFunctionBundles eager singleton）、TypeRegistry、
     │           SplitManager+PageSourceManager/PageSinkManager、PluginInstaller
     ├─ PluginInstaller.loadPlugins()
     │   └─ ServerPluginsProvider：扫 plugin.dir（默认 plugin/）下每子目录全部 jar
     │       → PluginClassLoader + ThreadContextClassLoader
     │       → ServiceLoader.load(Plugin.class) → installPluginInternal
     ├─ CatalogStoreManager.loadConfiguredCatalogStore
     ├─ ConnectorServicesProvider.loadInitialCatalogs
     ├─ 依序：SessionPropertyDefaults → ResourceGroupManager → AccessControlManager
     │   → PasswordAuthenticatorManager → GroupProvider → ExchangeManagerRegistry
     │   → SpoolingManagerRegistry → CertificateAuthenticatorManager →
     │     HeaderAuthenticatorManager（各 load）
     ├─ [coordinator] EventListenerManager.loadEventListeners
     ├─ OAuth2Client.load
     ├─ Announcer.start()          # 最后才对外宣告存活
     └─ StartupStatus.startupComplete  # ===== SERVER STARTED =====
```

<details>
<summary>ServerConfig 关键配置</summary>

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `coordinator` | true | 角色开关（装配期驱动模块图） |
| `experimental.concurrent-startup` | false | 并行启动插件 |
| `http.include-exception-in-response` | — | 异常细节透出 |
| `shutdown.grace-period` | 2min | 优雅停机窗口 |
| `query-results.compression-enabled` | — | 响应压缩 |
| `query.info-url-template` | — | 外部查询链接模板 |

</details>

## 核心实现

### CoordinatorModule vs WorkerModule

CoordinatorModule（25.2K）绑定查询提交链：`jaxrsBinder(QueuedStatementResource)`（@Path /v1/statement）→ `DispatchManager` → `LocalDispatchQueryFactory` → `QueryExecutionFactoryModule`（SqlQueryExecutionFactory + 约 60 个 DataDefinitionTask 的 MapBinder）→ `QueryManager` → `NodeScheduler`/NodeSelector（UNIFORM/TOPOLOGY 配置切换）→ `HttpRemoteTaskFactory`。WorkerModule（仅 5 个绑定）全部绑 NoOp：`NoOpSessionSupplier`、`NoOpResourceGroupManager`、`NoOpFailureDetector`、`NoWebUiAuthenticationFilter`——worker 内存里仍实例化 planner 等代码路径但不绑定，NoOp 占位保依赖图完整。`NodeManagerModule` 同理绑 CoordinatorNodeManager vs WorkerInternalNodeManager。

### PluginClassLoader：platform parent 的深意

```java title="server/PluginManager.java（SPI_PACKAGES 白名单）"
private static final List<String> SPI_PACKAGES = // io.trino.spi., jackson 注解,
        blackbird 叶子函数接口, io.airlift.slice., opentelemetry api/context, jts
```

`loadClass`（PluginClassLoader.java:100）：SPI_PACKAGES 命中 → 只从 engine classloader 加载（插件自带 SPI 类副本直接报错）；其余走 `super.loadClass`——但构造时 parent 传的是 **platform classloader 而非 app classloader**（源码注释："plugins should not have access to the system class loader"）。效果：引擎与插件的 Guava/Jackson 互不可见——不同连接器可携带互相冲突的依赖版本，真正的依赖隔离；SPI 白名单保证跨 classloader 类型同一性。

### 认证体系：Manager + Factory 晚绑定

`ServerSecurityModule.setup` 按 `SecurityConfig.getAuthenticationTypes()`（http-server.authentication.type 列表）用 `authenticatorModule` 向 MapBinder<String, Authenticator> 注册选中的类型：certificate/kerberos/password/header/jwt/oauth2/insecure。运行时 `AuthenticationFilter`（@Priority(AUTHENTICATION) 的 JAX-RS ContainerRequestFilter）顺序尝试各 Authenticator，成功即 `setAuthenticatedIdentity`。节点间 internal 请求走 `InternalAuthenticationManager`（internal-communication.shared-secret HMAC）。PasswordAuthenticatorManager 两阶段：插件先 `addPasswordAuthenticatorFactory` 注册，启动后期按 `etc/password-authenticator.properties` 的 `password-authenticator.name` 选 factory 实例化（`loadPasswordAuthenticator` in security/PasswordAuthenticatorManager.java）。

### 节点发现：483 已重构

`NodeInventoryConfig.getType()`（配置 `discovery.type`）三选一，**默认 ANNOUNCE**：`AnnounceNodeAnnouncer`（node/AnnounceNodeAnnouncer.java）周期 POST 自身 URI 到各 coordinator 的 `/v1/announce`（AnnounceNodeResource，INTERNAL_ONLY），coordinator 用 AnnounceNodeInventory 维护节点集，`CoordinatorNodeManager.startPollingNodeStates` 每 5s 轮询 RemoteNodeState。`airlift-discovery` 为 opt-in：`AirliftNodeInventoryModule` 可在 coordinator 内嵌 EmbeddedDiscoveryModule，但 `EmbeddedDiscoveryConfig` 已标 @Deprecated；**in-repo 的 service/discovery 模块在 483 已不存在**（service/ 仅剩 trino-proxy、trino-verifier），改由 trino-main pom 直接依赖 io.airlift.discovery:discovery-server。另有 DNS 模式。语义动机：worker 本来就要知道 coordinator 地址（etc/config.properties），反向通告即可，去掉中心 discovery 单点。

### Web UI 与发行版

core/trino-web-ui：React 前端（webapp/ 新版 + webapp-legacy/ 旧版），`frontend-maven-plugin` 的 **bun goal** 在 generate-resources 阶段构建，产物 dist/ 打进 jar；`WebUiStaticResource`（server/ui/）以 @Path("/ui") serve。`WebUiModule.setup` 按 WebUiConfig 决定是否装 ClusterResource/UiQueryResource 及认证（WebUiFrontendModule 按认证类型选 LoginResource/FixedUserResource/OAuth2WebUiResource，无显式配置且含 password 时默认 form）。发行版：trino-server 用 **provisio** 打包（src/main/provisio/trino.xml）——trino-server-core tar.gz（bin/ Airlift launcher、lib/、secrets-plugin/、7 个内置 plugin）+ 约 45 个 `plugin/<name>` 目录，对齐 ServerPluginsProvider 的目录扫描。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| DI 装配分层 | Airlift 基础 / Trino 领域 / coordinator-worker / 各 Manager | 装配逻辑集中，角色差异配置化 |
| classloader 隔离 | PluginManager + PluginClassLoader | 插件依赖冲突隔离的最小共享面 |
| Manager 聚合 | PasswordAuthenticatorManager 等一族 | 插件实现的晚绑定注册表 |
| 条件绑定 | ServerMainModule.setup 的 isCoordinator 分支 | 装配期静态决策，无运行时判断开销 |

## 模块间交互

- **查询链 binding 串线**：CoordinatorModule 把 [客户端协议](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/10-client-protocol) → [查询生命周期](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/03-query-lifecycle) → [调度](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/04-scheduler) 的对象全部装配成图；
- **插件体系**：PluginManager 与 [SPI](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/07-spi-connector-framework) 的 Plugin 接口对接（installPluginInternal 注册 ~15 类 Factory 进各 Manager）；
- **节点生命周期**：NodeStateManager 管理 ACTIVE/DRAINING/DRAINED/SHUTTING_DOWN 状态机与优雅停机（drain→gracePeriod→LifeCycleManager.stop）。

## 扩展方式

**新增 server 配置项**：仿 ServerConfig——`@Config("xxx")` 链式 setter + Module 内 `configBinder(binder).bindConfig(XxxConfig.class)`，Guice @Inject 构造器自动获得。

**新增内置认证**：ServerSecurityModule 里 `install(authenticatorModule(securityConfig, "名字", XxxAuthenticator.class, module))`；可插拔式则写 plugin 提供 `getPasswordAuthenticatorFactories` + PluginManager.installPluginInternal 加注册循环。

**coordinator 专属服务**：放 CoordinatorModule（子模块同理）；worker 侧需在 WorkerModule 绑 NoOp 防依赖图缺口。
