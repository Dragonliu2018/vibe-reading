---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "插件系统"
date: "2026-09-25T00:16:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "cgo", "dlopen", "C ABI", "插件"]
description: "插件系统：自研语言中立 C ABI（dlopen + JSON RPC 双函数表）、22 类能力扩展点、崩溃守卫双层 recover + 熔断、quiesce 热替换与失败回滚、sha256 安装校验与 zip 路径穿越防御、Go/Rust/C 三语言等价插件"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`internal/pluginhost/`（40 个非测试文件 ~12.3k 行，全项目密度最高的子系统之一）+ `sdk/pluginabi/`（ABI 契约）+ `sdk/pluginapi/`（插件作者 API）+ `internal/pluginstore/`（安装与校验）构成 v7 的招牌能力：**语言中立的原生插件系统**。Go/Rust/C 写的 `.so` 经 dlopen 加载，与宿主只交换 JSON 消息——一个 Rust 插件可以注册新 executor、参与凭据调度、拦截请求流，而宿主对它的内部实现一无所知。

分层的边界值得先讲清楚：`sdk/pluginabi`（版本常量 + Envelope）与 `sdk/pluginapi`（能力接口 + 请求响应 schema）是**对外稳定契约**——嵌入方和插件作者都只依赖这两个包；`internal/pluginhost` 是实现；`sdk/pluginhost/host.go:61-64` 用薄包装 `Host{inner *internalpluginhost.Host}` 把实现收窄成公共 API，防 internal 细节泄漏进 SDK 面。

## 模块架构

```
C ABI 边界（loader_unix.go:20-38，两张函数表）：
  cliproxy_host_api{abi_version, host_ctx, call, free_buffer}    宿主 → 插件持有
  cliproxy_plugin_api{abi_version, call, free_buffer, shutdown}  插件 → 宿主持有
  统一调用形状：int call(method, req, len, *resp)   ← JSON RPC over C ABI

Host（host.go:63-95）
  ├── applyMu（串行化 ApplyConfig）
  ├── loaded / retired / loading / fused 四张 map（活跃/退役/加载中/熔断）
  ├── snapshot atomic.Value（无锁读快照）
  ├── 五个流桥（streams/httpStreams/httpOperations/modelStreams/callbackContexts）
  └── callFromPlugin 分发 18 个 host.* 回调方法

插件注册：plugin.register（带 ConfigYAML + 宿主 SchemaVersion）
  └── rpcCapabilities 布尔位 → 逐项装配 Go 接口适配器（adapters_*）
      22 个能力：Executor / AuthProvider / Scheduler / ModelRouter /
      RequestInterceptor / StreamChunkInterceptor / ThinkingApplier /
      ManagementAPI / QuotaProvider / UsagePlugin / …

pluginstore（安装）：GitHub Release + checksums.txt / registry.json + sha256
```

ABI 与 Schema 是两个独立版本轴（`sdk/pluginabi/types.go:5-33`）：`ABIVersion = 1` 管**原生 C 符号形状**（硬相等，不兼容即拒载）；`SchemaVersion = 6` 管 **JSON RPC 契约**（单向兼容：插件版本 ≤ 宿主即接受，0 视为 legacy 1）。Schema 演进以注释逐版本记录（v2 请求生命周期、v3/v5 流 chunk 字段省略、v4 WebSocket 观察、v6 管理响应保留 raw JSON），并保留里程碑常量供插件按需降级。

## 调用链路

三条主链路：

```
发现→加载→注册（Host.ApplyConfig，host.go:205-415）：
lockApply（host.go:810 抢串行信号量）
└── runtimeConfigFromConfig（config.go:29）解析 plugins.dir + enabled/priority/version
    └── selectPluginFiles（platform.go:114）
        # 扫描 plugins/<goos>/<goarch>/ 与根目录，按 "id-v<version>.so" 文件名约定
        └── 逐文件 startPluginLoad（host.go:454，goroutine）
            └── loader.Open（loader_unix.go:114）
                # dlopen(RTLD_NOW|RTLD_LOCAL) → dlsym cliproxy_plugin_init
                # → 调 init 交换函数表 → ABI 版本硬校验（:162）
                └── newGuardedPluginClient（client_guard.go:19，崩溃守卫）
                    └── callRegister（host.go:1035）
                        └── registerRPCPlugin（rpc_client.go:65）
                            # 发 plugin.register；按 rpcCapabilities 布尔位装配适配器
                            # resp.SchemaVersion > 宿主版本拒绝（:76-84）
                            └── validPlugin 校验（host.go:1116，四元数据必填 + 至少一能力）
                                └── sortRecords（snapshot.go:149）→ snapshot.Store 原子发布

一次插件调用（Executor 为例）：
Host.ExecutePluginExecutor（executor_route.go:86）
└── executorAdapter（adapters_executors.go:372）
    # 输入/输出格式协商 selectExecutorInputFormat/OutputFormat + 响应回译
    └── rpcPluginAdapter.Execute（rpc_client.go:497）
        └── callPlugin[T]（rpc_client.go:185：marshal→调用→解 Envelope）
            └── guardedPluginClient.Call（goroutine 内执行 + ctx 取消）
                └── dynamicLibraryClient.Call（loader_unix.go:180）
                    # cliproxy_call_plugin 跨 C 边界 → 插件 plugin_call
插件→宿主回调：
host_api.call → cliproxyHostCall（host_callbacks_unix.go:24）
└── 以 hostCtx 自增 ID 查 hostCallbackEntries sync.Map（loader_unix.go:93）
    └── Host.callFromPlugin（host_callbacks.go:143）
        # 分发 18 个 host.* 方法：HTTP do/stream、model execute/stream、
        # auth list/get/save、affinity lookup、log…
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `ApplyConfig` in `internal/pluginhost/host.go:205` | 发现/加载/注册/热替换总入口 | applyMu 串行 + 快照原子发布 |
| `loader.Open` in `loader_unix.go:114` | dlopen + 函数表交换 | ABI 硬校验（`:162`） |
| `registerRPCPlugin` in `rpc_client.go:65` | register RPC + 适配器装配 | 能力位为 false 的槽位零开销 |
| `validPlugin` in `host.go:1116` | 元数据校验 | Name/Version/Author/GitHubRepository 必填 |
| `callQuiesce` in `host.go:942` | 热替换前静默旧实例 | 插件可声明不支持 |
| `rollbackReplacement` in `host.go:998` | 替换失败回滚 | 重新注册旧实例兜底 |
| `guardedPluginClient.Call` in `client_guard.go` | 守卫每次调用 | panic 重放 + 计数在飞调用 |
| `fusePlugin` in `adapters_usage_translation.go:96` | 熔断崩溃插件 | 写 fused map + 全栈日志 |
| `ExecutePluginExecutor` in `executor_route.go:86` | 插件 executor 入口 | 与原生 executor 冲突仲裁 |
| `VerifyChecksum` in `pluginstore/checksum.go:34` | 安装校验 | 双资产 checksums.txt 比对 |
</details>

## 核心实现

### 为什么放弃 Go plugin.Open 换自研 C ABI

Go 标准库 `plugin.Open` 的三宗罪：仅 Linux、要求宿主/插件工具链与依赖版本严格一致（跨版本升级即碎）、无法跨语言。v7 的替代是 dlopen + 纯 C 符号两张函数表（`loader_unix.go:20-38`）：宿主与插件之间**只有方法名字符串 + 字节缓冲**，任何能编 C ABI 动态库的语言都能写插件。`examples/plugin/simple/` 用三语言证明等价性：Go 用 `//export` + `-buildmode=c-shared`；Rust 用 `#[no_mangle] extern "C"` 手写 `#[repr(C)]` 结构 + base64 响应；C 直接字符串常量——三者的 registration/capabilities JSON 逐字段一致。Windows 有独立 `loader_windows.go`（LoadLibrary 等价实现）。

### JSON RPC 而非直接函数调用

所有跨边界调用统一为 `int call(const char* method, const uint8_t* req, size_t len, cliproxy_buffer* resp)`，payload 是 JSON `Envelope{OK, Result, Error}`（`pluginabi/types.go:115-128`）。三个理由：**语言中立**（JSON 任何语言都能编解码）；**错误显式建模**（`Error` 带 Code/Message/Retryable/HTTPStatus——401/429 能透传给客户端，`types.go:125`）；**契约可演进**（SchemaVersion 协商，无需重编 C ABI）。能力枚举靠 registration JSON 里的布尔位（`rpc_schema.go:21` 的 `rpcCapabilities`）：宿主只在为 true 的槽位放适配器——插件未声明的能力零开销，遍历时判 nil 即可。实际能力清单是 **22 个接口字段**（`host.go:1130-1151` 的 `validPlugin` 清单）：ModelRegistrar、ModelProvider、AuthProvider、FrontendAuthProvider、Scheduler、ModelRouter、Executor、RequestTranslator、RequestNormalizer、RequestInterceptor、RequestLifecyclePlugin、ResponseTranslator、ResponseBeforeTranslator、ResponseAfterTranslator、ResponseInterceptor、StreamChunkInterceptor、WebSocketResponseObserver、ThinkingApplier、UsagePlugin、CommandLinePlugin、ManagementAPI、QuotaProvider，另加三个标量修饰位（FrontendAuthProviderExclusive / SchedulerAcrossPriorities / ExecutorModelScope+Formats）。

### 崩溃守卫：双层 recover + 熔断

链路：cgo panic 沿 `guardedPluginClient.Call` 的 goroutine recover 后**在调用方协程重放 panic**（`client_guard.go:55-69`）→ 外层各 `safePluginCall`/适配器 defer（如 `scheduler.go:64`、`adapters.go:453`）recover → `fusePlugin`（`adapters_usage_translation.go:96`）写入 `fused` map、注销其 thinking provider、打全栈日志；此后 `isPluginFused` 短路该插件的一切调用点（快照遍历处处可见）。熔断只在热替换成功时清除（`host.go:350`）——**熔断的插件保持加载**，因为不能 dlclose 正在执行的代码。诚实的边界：guard 只覆盖 Go panic；C/Rust 侧真段错误仍会带走整个进程（防御深度有限）。

### 热替换：quiesce → retire → 回滚

同 ID 换新版本时：`callQuiesce`（`host.go:942`，`plugin.quiesce` RPC，插件可声明不支持）静默旧实例 → 旧实例进 `retired` → 新版本加载注册；失败则 `rollbackReplacement`（`host.go:998`）重新注册旧实例兜底。快照读取处处做**世代校验**：`activeRecordsFromSnapshot` 再经 `recordCurrent`（`host.go:860`）用 path+version 双查，防止"已被替换的旧插件记录"继续生效——典型的 epoch 双检。配置侧联动：禁用/消失的插件出快照、`cleanupUnselectedPluginFiles`（`host.go:411`）清旧文件（详见 [07-config-watcher](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/07-config-watcher)）。

### 安装校验：防篡改、防穿越、防 token 泄漏

`internal/pluginstore/` 两条安装路线：GitHub Release（下载 archive + `checksums.txt` 双资产，`VerifyChecksum` in `checksum.go:34` 防下载篡改/CDN 损坏）与 direct（registry.json，默认官方源 `registry.go:15`，可配多源）。direct 路线的硬约束：每个 artifact **必带 sha256**（`registry.go:327`）；zip 路径穿越防御（`cleanZipName` in `install.go:375` 拒绝绝对路径/`..`/反斜杠）；动态库必须在 zip 根（`:318`）；artifact URL **禁带 token 类查询参数**（`registry.go:394`）；repository 必须是纯 https github.com 两段式（`:415`）。写入用 `writeFileAtomic`（temp+rename，`install.go:519`）；Windows 禁止覆盖已加载 dll（`loadedPluginInstallBlocked`，`:576`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 桥接（C ABI） | 两张函数表 in `loader_unix.go:20-38` | 语言中立的唯一边界 |
| 适配器 | `registerRPCPlugin` in `rpc_client.go:95-181`；`executorAdapter`/`usageAdapter`/`thinkingAdapter` | 线路布尔 → Go 接口 → 宿主子系统 |
| 快照 + 世代校验 | `snapshot atomic.Value`（`host.go:94`）+ `recordCurrent`（`:864`） | 无锁读 + 防旧记录复活 |
| 装饰器（守卫） | `guardedPluginClient` in `client_guard.go:19` | 计数在飞调用，Shutdown 先摘除再等在飞调用收尾（`:104-150`） |
| 熔断器 | `fused` map + `fusePlugin` | 崩溃插件不再拖累请求路径 |

## 模块间交互

与 Service/Conductor 的接线单点在 `syncPluginRuntimeConfigForConfig`（`sdk/cliproxy/service_plugins.go:95-133`）：`ApplyConfig` → `coreManager.SetPluginScheduler`（调度器即 Host 本身）→ `registerPluginAuthParser` → `RegisterFrontendAuthProviders` → `RegisterUsagePlugins` → `sdktranslator.SetPluginHooks` → `RefreshPluginManagementRoutes`。插件 executor 经 `registerPluginExecutors`（`service_plugins.go:45`）→ `Host.RegisterExecutors`（`adapters_executors.go:34`，含与原生 executor 的 provider/model 冲突仲裁，原生优先原则见 [01-service-core](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/01-service-core)）→ `Manager.RegisterExecutor`（Conductor 注册点）。Management API 侧：`ListPlugins`（`management/plugins.go:67`）合并目录 + 注册快照视图；`InstallPluginFromStore`（`plugin_store.go:220`）安装后写回 config 触发热重载（详见 [11-management](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/11-management)）。thinking 插件可注册同名 provider 抢占（见 [09-thinking](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/09-thinking)）。

## 扩展方式

**写一个最小插件**：复制 `examples/plugin/simple/go/main.go`（112 行的 `cliproxy_plugin_init` + `handleMethod` switch 即全部骨架），在 `exampleRegistration()` 里只开需要的能力位，`go build -buildmode=c-shared`；Rust/C 照 `examples/plugin/simple/{rust/src/lib.rs, c/src/plugin.c}`。**宿主侧零改动**。

**新增一类扩展点**（加 `FooPlugin` 为例）：`sdk/pluginabi/types.go` 加 `MethodFooXxx` 常量 → `sdk/pluginapi/types.go` 加接口 + `Capabilities` 字段 → `rpc_schema.go:21` 加布尔位 → `rpc_client.go` 的 `registerRPCPlugin` 装配 + 适配器方法 → 宿主分发入口（仿 `scheduler.go` 的 `Host.PickAuth`）→ `service_plugins.go` 接线 + `host.go:1116` 的 `validPlugin` 清单加一行。

**新增宿主回调**（给插件新能力）：`pluginabi` 加 `MethodHostFoo` 常量 → `host_callbacks.go:147` 的 `callFromPlugin` 加 case + 实现函数 → 插件侧即可经 host_api 调用。
