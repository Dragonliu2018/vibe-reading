---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "启动与依赖注入"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "wire", "依赖注入", "多协议路由"]
description: "Harness 启动链路：kingpin CLI → google/wire 编译期注入 ~150 个 WireSet → bootstrap 初始化 service principal → errgroup 并行启动 HTTP/SSH/metric 三类 server"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

本模块是 Harness 进程的"装配车间"——把四大产品面（代码托管、CI、Gitspace、制品仓库）和十余个横切基础设施（锁、事件、日志、缓存、作业）从几百个 provider 函数编织成一个可运行的 `*cliserver.System`。它解决的核心问题是：一个单进程要同时对外提供 HTTP API、Smart HTTP Git、SSH、Docker Registry、Maven 等多协议入口，且各协议背后共享同一套认证、存储、事件总线——靠手写构造函数会让初始化代码膨胀到无法维护。Harness 用 google/wire 在**编译期**完成依赖图的拓扑排序与代码生成，把运行时开销降到零，并把多协议入口收敛到一条路由器链。

模块边界：入口 `cmd/gitness/`、装配 `app/bootstrap/` + `app/server/` + `app/router/`、配置 `app/config/` + `cli/operations/server/config.go`。它不包含业务逻辑，只负责"把对象造出来、按协议分发流量、启动监听"。

## 模块架构

```
cmd/gitness/main.go        kingpin CLI 入口，注册子命令
        │
        ▼
cli/operations/server/     server 子命令：LoadConfig → initSystem(wire) → bootstrap → 启动
        │
        ▼
wire.go / wire_gen.go      ~150 个 WireSet 拓扑排序 → *cliserver.System
        │
        ├─→ bootstrap.Bootstrap   system/pipeline/gitspace principal + admin user
        ├─→ app/router.Router      [GitRouter, RegistryRouter, APIRouter, WebRouter]
        ├─→ app/server             HTTP server (3000)
        ├─→ ssh.Server             SSH server (3022)
        ├─→ metricServer           Prometheus
        ├─→ pipeline poller        CI 调度
        └─→ services.JobScheduler  后台作业
```

wire 的组织单位是 `WireSet`——每个包的 `wire.go` 用 `wire.NewSet(ProviderFunc1, ProviderFunc2, ...)` 声明本包所有 provider，`cmd/gitness/wire.go:175` 的 `initSystem` 用 `wire.Build(database.WireSet, router.WireSet, services.WireSet, ...)` 把它们喂给 wire 编译器。编译器分析依赖图后生成 `wire_gen.go` 中的 `initSystem()`，自底向上逐行调用 provider：database → stores → caches → controllers → services → router → server → System。关键聚合点在 `wire_gen.go:892`：`server.NewSystem(bootstrap, server, sshServer, poller, resolverManager, services, listenAndServeServer)`。

## 调用链路

启动主链路（标注 `函数名 in 路径`）：

```
main() in cmd/gitness/main.go:37
  └─ cli.GetArguments() in cli/cli.go
  └─ server.Register(app, initSystem) in cli/operations/server/server.go:231
        └─ initSystem 作为 initializer 存入 command 结构体
  └─ kingpin.MustParse(app.Parse(args))  → command.run()

command.run() in cli/operations/server/server.go:44
  ├─ godotenv.Load(c.envfile)                    .env → os.environ
  ├─ LoadConfig() in cli/operations/server/config.go:60
  │     envconfig.Process → *types.Config（struct tag 映射）
  │     backfillURLs() 派生 URL（config.go:107）
  ├─ c.initializer(ctx, config) = initSystem() in cmd/gitness/wire.go:175
  │     └─ wire.Build(...) → wire_gen.go:202 生成的 initSystem()
  ├─ system.bootstrap(ctx)  = bootstrap.System()
  │     in app/bootstrap/bootstrap.go:69
  │     ├─ SystemService()    → systemServicePrincipal
  │     ├─ PipelineService()  → pipelineServicePrincipal
  │     ├─ GitspaceService()  → gitspaceServicePrincipal
  │     └─ AdminUser()        → 创建 admin（若配置了密码）
  └─ errgroup 并行启动：
        ├─ system.server.ListenAndServe()       HTTP (3000)
        ├─ system.metricServer.ListenAndServe() Prometheus
        ├─ system.sshServer.ListenAndServe()    SSH (3022, if config.SSH.Enable)
        ├─ services.JobScheduler.Run()           后台作业循环
        ├─ Cleanup.Register / MetricCollector.Register
        └─ CI poller + resolver plugin 预填充（if enableCI）
  └─ 优雅关闭：shutdownHTTP / sshServer.Shutdown / Instrumentation.Close
```

<details>
<summary>方法速查表</summary>

| 方法 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `main` | `cmd/gitness/main.go:37` | kingpin CLI 入口 | 子命令各自 Register |
| `command.run` | `cli/operations/server/server.go:44` | server 启动主流程 | errgroup 并行启多 server |
| `initSystem` | `cmd/gitness/wire.go:175` | wire 注入入口 | `//go:build wireinject` |
| `bootstrap.System` | `app/bootstrap/bootstrap.go:69` | service principal 初始化 | 幂等（duplicate 容忍） |
| `ProvideRouter` | `app/router/wire.go:80` | 构造路由器链 | 有序切片，特异性高在前 |
| `Router.ServeHTTP` | `app/router/router.go:45` | 多协议分发 | 首个 IsEligibleTraffic 命中 |
| `LoadConfig` | `cli/operations/server/config.go:60` | 配置加载 | envconfig + backfillURLs |

</details>

## 核心实现

### Bootstrap 函数与 service principal

`bootstrap.Bootstrap` 是一个函数类型抽象 `type Bootstrap func(context.Context) error` in `app/bootstrap/bootstrap.go:67`，由 `ProvideBootstrap` in `app/bootstrap/wire.go:28` 通过 `System()` 构造。它封装了四步幂等初始化：`SystemService` / `PipelineService` / `GitspaceService` / `AdminUser`。

三个 service principal 是包级变量（`systemServicePrincipal` / `pipelineServicePrincipal` / `gitspaceServicePrincipal`，`*types.Principal`），在 `bootstrap` 阶段一次性赋值、进程级常驻。`NewSystemServiceSession()` in `bootstrap.go:37` 返回基于该变量的 `*auth.Session`，供系统内部操作（如自动创建资源）使用。这种"进程级 service 账户"设计避免了每次系统操作都要模拟一个用户 session——`pipelineServicePrincipal` 让 CI 执行时容器内能回调 Harness API，`gitspaceServicePrincipal` 让 Gitspace 凭证注入能代用户签发 PAT（见 [Gitspaces 模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/07-gitspace)）。

幂等性靠 `errors.Is(err, store.ErrDuplicate)` 实现：若服务 principal 已被另一实例创建，`createServicePrincipal` in `bootstrap.go:243` 会回退到 `FindNoAuth` 查回已有记录，保证多实例启动不冲突。

### 多协议路由器链

`router.Router` in `app/router/router.go:31` 实现 `http.Handler`，在 `ServeHTTP` 中遍历 `routers []Interface` 切片，第一个 `IsEligibleTraffic(req)` 返回 true 的路由器处理请求，未匹配返回 400。`ProvideRouter` in `app/router/wire.go:80` 构造有序切片：

| 顺序 | 路由器 | 文件 | IsEligibleTraffic 判定 |
|------|--------|------|----------------------|
| 0 | GitRouter | `app/router/git_router.go` | 前缀 `/git/` 或 Host 匹配 gitRoutingHost |
| 1 | RegistryRouter | `registry/app/api/router/registry_router.go` | 前缀 `/api/v1/registry`、`/v2/`、`/maven/`、`/generic/`、`/pkg/` 等 |
| 2 | APIRouter | `app/router/api_router.go` | 前缀 `/api/` |
| 3 | WebRouter | `app/router/web_router.go` | 始终 true（catch-all 兜底） |

顺序很关键——特异性高的在前，catch-all 在后，否则 WebRouter 会吞掉所有流量。SSH 协议独立于这条 HTTP 链：`ssh.Server` in `ssh/server.go:88` 有自己的 `ListenAndServe`，在 `command.run()` 中通过 errgroup 并行启动。设计动机是单进程多协议共用 3000 端口靠路径/Host 区分，避免多进程部署复杂度，而 SSH 走独立 3022 listener 但**共享同一套 `RepoCtrl`/`LFSCtrl` 业务逻辑层**——传输层不同，业务层统一。

### google/wire 编译期注入

选用 google/wire 而非运行时 DI（Uber fx）的原因是**编译期生成**：wire 在 `//go:build wireinject` 标记下运行代码生成器产出 `wire_gen.go`，编译后即为普通 Go 代码，无反射开销、无启动时解析开销、依赖错误在编译期暴露。`wire.Bind` 用于接口到实现的绑定（如把 `orchestrator.Orchestrator` 绑定到 event service 的窄接口）。

`initSystem` 输入 `context.Context` + `*types.Config`，输出 `(*cliserver.System, error)`。`System` in `cli/operations/server/system.go:29` 聚合七个顶层组件：bootstrap、server、sshServer、resolverManager、poller、services、metricServer。

### 配置加载

`LoadConfig` in `cli/operations/server/config.go:60` 用 `envconfig.Process("", config)` 从环境变量按 struct tag 映射到 `types.Config`。优先级：`.env` 文件（`godotenv.Load` 先注入 `os.environ`）→ 环境变量 → struct 默认值。无 YAML、无 kingpin flag 直接配置（flag 仅 `--enable-ci` 和 envfile 路径）。`backfillURLs` in `config.go:107` 在 envconfig 之后补全 URL 派生字段（Internal/Container/API/Git/UI/Registry），`config.URL.Base` 显式覆盖优先级最高。各子系统 Config（database/lock/pubsub/job/git/blob 等）由 `ProvideXxxConfig` 从 `*types.Config` 提取（如 `ProvideDatabaseConfig` in `config.go:271`）。

## 模块间交互

该模块装配了几乎所有其他模块：`app/api`（controller）、`app/services`、`app/store`、`git`（`git.Interface`）、`app/pipeline`、`app/gitspace`、`registry`、`ssh`、`events`、`encrypt`/`lock`/`pubsub`/`job`/`blob`/`audit`。bootstrap 依赖 `user.Controller` 和 `service.Controller` 来创建 admin user 和 service principal，形成与 [API 层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/02-api)的单向依赖。模块间的动态调用顺序见概览「运行时行为 > 核心运行流程」。

## 扩展方式

**新增 CLI 子命令**：创建 `cli/operations/<name>/` 包，实现 `func Register(app *kingpin.Application, ...)`（参照 `server.Register` in `cli/operations/server/server.go:231`），在 `cmd/gitness/main.go:37` 的 `main()` 中调用 `<name>.Register(app)`；若需依赖注入，在 `cmd/gitness/wire.go` 新增 `init<Name>System` 函数传给 Register。

**新增 API handler 并接入 wire**：在 `app/api/controller/<name>/` 创建 `Controller` + `WireSet`；在 `app/router/api.go` 的 `NewAPIHandler` 参数列表追加 `*<name>.Controller`；在 `app/router/wire.go:80` 的 `ProvideRouter` 追加参数并传入 `NewAPIHandler`；在 `cmd/gitness/wire.go:176` 的 `wire.Build()` 追加 `<name>.WireSet`；运行 `go generate ./cmd/gitness/` 重新生成 `wire_gen.go`。

**新增子路由器**：在 `app/router/` 创建 `xxx_router.go` 实现 `Interface`（`Handle`/`IsEligibleTraffic`/`Name`），在 `ProvideRouter` 中插入 `routers` 切片（注意顺序：特异性高的在前）。
