---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "服务核心与装配"
date: "2026-09-24T16:12:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "Builder", "Facade"]
description: "Service 门面与 Builder 装配：15 个 With 注入点、控制面与数据面分离、executionregistry 三态生命周期、WatcherWrapper 函数字段解耦"
readingTime: "15 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`sdk/cliproxy/` 根目录（`service*.go`、`builder.go`、`providers.go`、`types.go` 等）是整个代理进程的**组合根**：`Service` 是门面——持有配置、Conductor、executor 注册表、watcher、HTTP server、插件宿主、Home 订阅等全部运行时组件；`Builder` 负责装配；`executionregistry` 单独成包管理 Home 集群模式的执行资源生命周期；`pipeline` 定义对外 SDK 的执行契约。

它在架构里的位置是"嵌入入口 + 控制面"：仓库内只有两个调用方——`internal/cmd/run.go`（主程序）和 `examples/custom-provider/main.go`（嵌入示例）。最关键的边界决策是：**Service 不在请求路径上**。`Run()` 把 coreManager/accessManager 注入 `api.NewServer` 之后，HTTP 请求直接走 handler → Conductor，Service 只管生命周期。好处是 Service 关停/重启不影响 in-flight 请求，且 api 包可独立测试。

## 模块架构

```
Builder（15 个 With* 链式注入）
   │ Build() 验证 + 填默认值 + 组件连线
   ▼
Service（门面，~40 个私有字段）
   ├── coreManager    sdk/cliproxy/auth.Manager   ← 请求路径真正经过的调度器
   ├── accessManager  sdk/access.Manager           ← 入站 API key 鉴权
   ├── pluginHost     internal/pluginhost.Host
   ├── watcherFactory → WatcherWrapper（函数字段包装 internal/watcher）
   ├── server         internal/api.Server（Run 期注入 coreManager）
   └── homeRegistry   executionregistry.Registry（Home 模式）
```

组件间协作的组织方式是"**装配期连线、运行期回调**"：`Build()` 把 `api.WithConfigReloadHook(→ service.reloadConfigFromWatcher)`、`WithPostAuthPersistHook(→ service.runtimeAuthSyncHook)` 注进 serverOptions，让 api server 的事件回灌进 Service，形成闭环；而 watcher 用 `WatcherWrapper` 的函数字段（非 interface）间接持有 internal 实现——10 个 `func` 字段让 SDK 层持闭包而非具体类型，internal watcher 演进时旧包装可用 nil 检查优雅降级，比接口更宽松的版本兼容策略（`WatcherWrapper` in `types.go:103`）。

## 调用链路

装配与启动两段链路：

- **Build 段**（`Build` in `builder.go:199`）：`NewBuilder()` → 调用方链式 `With*` → 校验（`cfg.ValidateCredentialWeights()`、`ResolvePluginsDir()`）→ 填默认 provider（`NewFileTokenClientProvider`/`NewAPIKeyClientProvider` in `providers.go`、`defaultWatcherFactory` in `watcher.go`）→ `pluginhost.New()` + `RegisterFrontendAuthProviders` → 若未注入 coreManager 则 `coreauth.NewManager(tokenStore, newRoutingSelector(routingState), nil)`（selector 按 `routing.strategy` 配置装配，可包 `SessionAffinitySelector`）→ 组装 Service struct。
- **Run 段**（`Run` in `service_lifecycle.go:32`，阻塞至 ctx 取消）：`coreManager.Load` 装载凭据 → `registerAvailableExecutors`（下节）→ `StartAutoRefresh(ctx, 15min)` → `api.NewServer` → goroutine 里 `server.Start()` → watcher 启动 → `select` 阻塞 → `Shutdown()` 幂等关闭（homeRegistry.Drain → watcher → coreManager → wsGateway → pprof → discovery → server → pluginHost，顺序固定）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `Build` in `builder.go:199` | 验证 + 默认值 + 组件连线 | 全依赖可注入可默认，嵌入方零成本起步 |
| `Run` in `service_lifecycle.go:32` | 启动全部子系统并阻塞 | Home/非 Home 双分支 |
| `Shutdown` in `service_lifecycle.go:228` | 逆序幂等关闭 | `sync.Once` + 固定顺序 |
| `registerAvailableExecutors` in `service_executors.go:176` | executor 注册单点收口 | 原生/插件/compat 三路径统一绑定顺序 |
| `reloadConfigFromWatcher` in `service_config.go:243` | Management/文件 reload 统一入口 | 两条写路径收敛防漂移 |
| `runtimeAuthSyncHook` in `builder.go:308` | 凭据落盘后回灌 watcher 队列 | 多实例/文件状态同步 |
| `runHomeSubscriber` in `service_home.go:484` | Home 订阅循环 | 订阅者切换时 Drain 重建 registry |
</details>

## 核心实现

### Service：40 字段门面与"不碰请求"边界

`Service struct` in `service.go` 全部字段私有，只通过方法暴露。核心字段：`cfg`（RWMutex 保护）、`coreManager`、`accessManager`、`pluginHost`、`watcher`（WatcherWrapper）、`server`、`homeRegistry`、`shutdownOnce`，以及大量 `mu/hook/generation` 字段管理 watcher + home 双源并发配置更新。

为什么 Service 不参与请求执行：`Build()` 只传回调给 server，`Run()` 才把 `coreManager`/`accessManager` 注入 `api.NewServer`（`service_lifecycle.go:126`）。此后请求路径是 handler → `coreManager.Execute`（`conductor_execution.go:121`），Service 不感知。这个边界让"配置热更、凭据注册、executor 绑定"（Service 的职责）与"请求执行"（Conductor 的职责）可以并发演进互不拖累——全局插件重建可能持锁数分钟，绝不能挡住在途请求。

### registerAvailableExecutors：注册收口与所有权仲裁

`registerAvailableExecutors` in `service_executors.go:176` 是全仓库 executor 注册的唯一收口（注释明言 "Keep all Service-owned executor registration paths here"）。流程：`baselineExecutorAuths()`（`service_executors.go:201`）构造 codex/claude/gemini/vertex/antigravity/kimi/xai/devin/meta 等 15 个合成 baseline Auth → `registerExecutorForAuth` 逐个 switch 到 `executor.NewCodexAutoExecutor/NewClaudeExecutor/NewGeminiExecutor…` → `coreManager.RegisterExecutor`。插件 executor 走 `registerPluginExecutors` 汇入同一处，`executorRegistrationMu` 串行化。

这层的难点是**所有权仲裁**（配置重载时插件/原生/compat executor 互相覆盖的风险）：`shouldKeepExistingOpenAICompatExecutor`（`service_executors.go:392`）判定已有 compat executor 是否保留；`shouldUpgradeOpenAICompatToPluginRefresh`（`service_executors.go:417`）实现"裸 executor 升级为插件 refresh 包装"——同一凭据后来装了带 AuthProvider 的插件时，把原生 OpenAICompatExecutor 外包一层 `pluginhost.NewPluginRefreshCompatExecutor`（装饰器），让刷新走插件。

### executionregistry：Home 执行资源的三态生命周期

`Registry` in `sdk/cliproxy/executionregistry/registry.go:32` 跟踪"一次 Home 订阅生命周期内"的所有执行：

```go
// sdk/cliproxy/executionregistry/registry.go:32
type Registry struct {
    state atomic.Uint32                  // StateAccepting → StateDraining → StateClosed
    pending map[uint64]*PendingDispatch  // 已接受未安装的 Home dispatch
    scopes  map[uint64]*Scope            // 已安装的活跃执行
    releaseSequences map[ReleaseGroup]int64 // 每个 (credential, model) 的累计释放序号
    changed chan struct{}                // 条件变量广播（close+remake）
}
```

执行流：`BeginDispatch` 保留槽位 → `Install` 原子转正为 `Scope` → `Bind(closeFn)` 挂接资源释放 → `EndWithRelease(reason)` 向 Home 上报**累计释放序号**（`markReleasedLocked` in `registry.go:334`）换取 `ReleaseTicket` 确认。`signalLocked`（`registry.go:467`）用 `close(ch); ch = make(ch)` 实现无 timer 的等待唤醒；三态状态机配 `CompareAndSwap` 提供无锁快速路径。

为什么单独成包：它被 `sdk/cliproxy/auth`（执行时挂 scope，`conductor_home.go` 等 4 文件）和 `internal/home`（释放上报 flusher，`concurrency_release.go`）**两侧共用**，放进任何一侧都会造成循环依赖或不当耦合；且订阅者切换时它要整体 `Drain` → `executionregistry.New()` 重建（`runHomeSubscriber` in `service_home.go:484/601`），逻辑自洽适合隔离测试（配套 3048 行的 `service_executionregistry_test.go`）。

### pipeline.Context：留给外部嵌入者的 ABI

`pipeline/context.go` 全文仅 64 行，聚合一次执行的全部状态：

```go
// sdk/cliproxy/pipeline/context.go:13
type Context struct {
    Request    cliproxyexecutor.Request   // provider 侧请求载荷
    Options    cliproxyexecutor.Options
    Auth       *cliproxyauth.Auth         // 选中的凭证
    Translator *sdktranslator.Pipeline    // schema 适配管线
    HTTPClient *http.Client               // middleware 可改的出站 transport
}
type Hook interface {
    BeforeExecute(ctx context.Context, execCtx *Context)
    AfterExecute(ctx, execCtx *Context, resp, err)
    OnStreamChunk(ctx, execCtx *Context, chunk)
}
```

值得注意：**仓库内没有任何 importer**（全库 grep 仅自身文件）——它是留给外部嵌入者/插件作者的稳定公共契约（配套 `RoundTripperProvider` 定义出站 transport 扩展点）。graphify 报其 degree 1127 是因为聚合的四个重量级类型（Request/Options/Auth/Pipeline）在全库的引用扇出，Context 本身只是它们的交汇点。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Builder | `NewBuilder`/`Build` in `builder.go` | 依赖全可注入，嵌入示例 20 行起步 |
| Facade | `Service` + `Run`/`Shutdown` | 10+ 子系统的唯一生命周期入口 |
| Registry | `RegisterExecutor`（核心执行）；`executionregistry.Registry`（Home 资源）；`GlobalModelRegistry`（模型） | 三层注册表各管一摊 |
| 工厂方法 | `WatcherFactory` in `types.go`；`defaultWatcherFactory` in `watcher.go` | watcher 可替换（测试注入假 watcher） |
| 装饰器 | `NewPluginRefreshCompatExecutor` in `service_executors.go:355` | 插件 OAuth refresh 能力叠加到原生 compat executor |
| 条件变量广播 | `signalLocked` in `executionregistry/registry.go:467` | 无 timer 等待唤醒 |

## 模块间交互

出向：import `internal/`（api、home、watcher、pluginhost、wsrelay、redisqueue、registry、runtime/executor、config）+ `sdk/`（config、access、auth、pluginstore、translator）——SDK 核心包**反向依赖 internal**，说明它是"官方嵌入入口"而非纯下沉层。入向：仅 `internal/cmd/run.go` 和 `examples/custom-provider/main.go`。交互方式：Service→coreManager 是直接方法调用 + 回调注入；Service↔api.Server 是 option 回调；Service↔watcher 是函数字段间接调用；Home 模式下 auth 层通过共享的 `executionregistry` 实例做并发记账。

## 扩展方式

**嵌入 SDK 自定义装配**（参考 `examples/custom-provider/main.go`）：`cliproxy.NewBuilder().WithConfig(cfg).WithConfigPath(path)` → 实现 `coreauth.ProviderExecutor` → `s.RegisterExecutor` 或注入 `WithCoreAuthManager` → `GlobalModelRegistry().RegisterClient` 注册模型 + `sdktr.Register` 注册翻译器 → `service.Run(ctx)`。全程不动 internal 代码。

**新增内置 provider**：只改两处——`baselineExecutorAuths()` in `service_executors.go:201` 加名字；`registerExecutorForAuth` 的 switch 加 case。executor 本体放 `internal/runtime/executor/`（见 [04-executors](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/04-executors)）。

**调整 Home 并发释放语义**：改 `executionregistry/registry.go` 的 `ReleaseGroup`/`markReleasedLocked` 与 `internal/home/concurrency_release.go` 的消费侧；订阅者重建语义在 `runHomeSubscriber`。
