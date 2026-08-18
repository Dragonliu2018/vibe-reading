---
source:
  type: "源码解读"
  project: "vscode"
  url: "https://github.com/microsoft/vscode"
title: "扩展系统"
date: "2026-08-18T15:19:54+08:00"
category: [Tools, IDE, VSCode, CodeWiki, "1.135.0"]
tags: ["vscode", "扩展", "Extension Host", "RPC", "activationEvents"]
description: "VS Code 扩展系统——多宿主隔离、RPC 协议配对、顾客模式与懒激活"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/00-overview)

---

## 模块定位

扩展是 VS Code 生态的命脉，但扩展代码不可信——它会崩溃、会阻塞、会访问不该访问的资源。`src/vs/workbench/services/extensions/` + `src/vs/workbench/api/` 用「多宿主隔离 + RPC 协议配对 + 懒激活」把扩展执行关进独立进程的笼子，同时给扩展一套类型安全的 `vscode.d.ts` API。本模块覆盖扩展宿主架构、RPC 协议机制、激活流程与贡献点解析。它依赖 platform（instantiation/rpc/extensions），被 contrib 各处调用（扩展提供的命令/视图/语言特性）。

## 模块架构

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer: AbstractExtensionService                           │
│  ├─ ExtensionRunningLocationTracker (分配扩展到宿主)         │
│  ├─ ExtensionHostCollection<ExtensionHostManager>             │
│  └─ LockableExtensionDescriptionRegistry                     │
└───────────┬──────────────────┬──────────────────┬───────────┘
            │ RPC              │ RPC              │ RPC
            ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ LocalProcess │  │ LocalWebWorker   │  │ Remote           │
│ ExtensionHost│  │ ExtensionHost    │  │ ExtensionHost    │
│ (Node fork)  │  │ (Web Worker)     │  │ (SSH/WSL 远端)   │
│  ExtHost API │  │  ExtHost API     │  │  ExtHost API     │
└──────┬───────┘  └──────────────────┘  └──────────────────┘
       │ MessagePort
       ▼
┌──────────────────────────────────────────────────────────────┐
│ RPCProtocol (extHost.protocol.ts 定义 Shape 接口配对)        │
│  MainContext.MainThreadXxx ↔ ExtHostContext.ExtHostXxx       │
│  MainThread 顾客 (@extHostNamedCustomer) 路由到主进程服务    │
└──────────────────────────────────────────────────────────────┘
```

核心组件：`AbstractExtensionService`（~1500 行抽象基类）管理扩展注册表、宿主管理器集合、激活队列；`ExtensionHostKind`（三种宿主枚举）；`ExtensionHostManager`（每宿主一个，封装 RPC 和激活）；`RPCProtocol` + `extHost.protocol.ts`（协议接口配对）；`extHostCustomers.ts`（顾客模式，ExtHost→Main 调用路由到主进程服务）。

## 调用链路

扩展宿主启动与握手：

```
ExtensionService._initialize()
 → _startExtensionHostsIfNecessary(true, [])           启动 EagerAutoStart 宿主
 → _resolveAndProcessExtensions()                      扫描扩展
 → _runningLocations.initializeRunningLocation()        分配宿主
 → _createExtensionHostManager()                       L845
    → _extensionHostFactory.createExtensionHost()       创建 IExtensionHost
    → new ExtensionHostManager(host, ...)
       → extensionHost.start()                          fork 进程 + MessagePort
       → _establishProtocol() → _performHandshake()     Ready → initData → Initialized
       → _createExtensionHostCustomers()                L249 创建 RPCProtocol + 所有 MainThread 顾客
```

扩展激活：

```
某事件触发 (onLanguage:python / onCommand:git.clone)
 → AbstractExtensionService.activateByEvent(event)      L992
 → 检查 _registry.containsActivationEvent(event)
 → _activateByEvent()                                   L1026
    → 所有 ExtensionHostManager.activateByEvent()
       → proxy.activateByEvent()  RPC 调 ExtHost
 → _activateById(id)                                    L1266
    → 遍历所有宿主 manager.activate(extensionId)        任一成功即完成
```

<details>
<summary>核心接口/类速查表</summary>

| 类型 | 文件 | 关键设计 |
|------|------|----------|
| `IExtensionDescription` | `platform/extensions/common/extensions.ts` | manifest + 运行时元信息，`IExtensionContributions` 枚举 30+ 贡献点 |
| `AbstractExtensionService` | `abstractExtensionService.ts:60` | `_registry` + `_extensionHostManagers` + `_runningLocations` |
| `ExtensionHostKind` | `extensionHostKind.ts:9` | `LocalProcess=1` `LocalWebWorker=2` `Remote=3` |
| `ExtensionHostManager` | `extensionHostManager.ts:58` | `_rpcProtocol` + `_customers` + `_proxy` |
| `MainContext`/`ExtHostContext` | `extHost.protocol.ts:4045,4136` | ~80 个 `ProxyIdentifier` 配对 |
| `@extHostNamedCustomer` | `extHostCustomers.ts:28` | 装饰器声明 MainThread 顾客 |

</details>

## 核心实现

### 多宿主隔离

三种扩展宿主各有隔离目的：

- **LocalProcess**：Electron 桌面端 `IExtensionHostStarter.createExtensionHost()` fork Node.js 子进程（`NativeLocalProcessExtensionHost`，`localProcessExtensionHost.ts:96`），用 MessagePort 通信。崩溃不影响渲染进程。
- **LocalWebWorker**：浏览器/桌面端 Web Worker 扩展（`WebWorkerExtensionHost`），沙箱隔离无 Node API。
- **Remote**：远程场景在 SSH/WSL/Container 远端 fork 进程，扩展直接访问远程文件系统。

扩展分配策略：`determineExtensionHostKinds()`（`extensionHostKind.ts:47`）合并本地和远程安装的扩展，依据 manifest 的 `extensionKind`（`ui`/`workspace`/`web`）和安装位置，经 `IExtensionHostKindPicker.pickExtensionHostKind()` 决策——`ui` 倾向本地、`workspace` 倾向远程。`ExtensionHostKind.Immediate` 特殊激活模式不等待远程宿主 ready，仅本地立即激活，远程事件缓存到 `_pendingRemoteActivationEvents` 待远程 ready 后 `_activateDeferredRemoteEvents()` 重放。

### RPC 协议配对

`extHost.protocol.ts`（4000+ 行）定义所有 MainThread↔ExtHost 通信接口，每个领域一对 Shape 接口：

```typescript title="src/vs/workbench/api/common/extHost.protocol.ts"
export interface MainThreadCommandsShape extends IDisposable {
  $registerCommand(id: string): void;
  $executeCommand(id: string, args: ..., retry: boolean): Promise<unknown>;
}
export interface ExtHostCommandsShape extends IDisposable {
  $executeContributedCommand(id: string, ...args: any[]): Promise<unknown>;
}
export const MainContext = {
  MainThreadCommands: createProxyIdentifier<MainThreadCommandsShape>('MainThreadCommands'),
  // ... ~80 个
};
```

`$` 前缀约定区分 RPC 方法与本地方法。序列化用 `JSON.stringify`，`VSBuffer` 经 `stringifyJsonWithBufferRefs()` 提取为独立 buffer 数组避免拷贝（`SerializableObjectWithBuffers`）。`Dto<T>` mapped type 自动转换 `toJSON()` 类型、丢弃 Function，`Proxied<T>` 将接口方法签名转为返回 `Promise<Dto<R>>` 的代理调用。**为什么用协议接口而非直接 RPC**：编译时类型安全（Shape 约束两端）、版本兼容（新增方法不破坏旧端）、解耦（顾客通过 DI 注入主进程服务）。

### 顾客模式（Customer Pattern）

`@extHostNamedCustomer(id)` 装饰器（`extHostCustomers.ts:28`）声明每个 MainThread 服务：

```typescript title="src/vs/workbench/api/browser/mainThreadCommands.ts"
@extHostNamedCustomer(MainContext.MainThreadCommands)
export class MainThreadCommands implements MainThreadCommandsShape { ... }
```

`ExtensionHostManager._createExtensionHostCustomers()`（`extensionHostManager.ts:283`）遍历 `ExtHostCustomersRegistry.getNamedCustomers()`，用 `IInstantiationService.createInstance()` 实例化每个顾客，`this._rpcProtocol.set(id, instance)` 注册到 RPC。当 ExtHost 调 `getProxy(MainContext.MainThreadCommands).$registerCommand(...)` 时，`RPCProtocol` 路由到对应顾客实例——顾客再通过 DI 调用真实主进程服务。这是 ExtHost→Main 调用的解耦路由层。

### 懒激活与贡献点解析

扩展在 manifest 声明 `activationEvents`（`onLanguage:python`/`onCommand:git.clone`/`workspaceContains:**/*.py`/`*`）。`ImplicitActivationEvents`（`extensionsRegistry.ts:668`）从 contribution points 自动推断激活事件——扩展不必手写所有 activationEvents。`ExtensionHostManager._activateByEvent` 用 `_cachedActivationEvents` Map 避免重复激活。

贡献点解析：`ExtensionsRegistry.registerExtensionPoint<T>(desc)`（`extensionsRegistry.ts:661`）注册扩展点，各 contrib 模块调用（`debuggersExtPoint`/`customEditorsExtensionPoint`/`chatParticipantExtensionPoint` 等）。`ExtensionPoint.setHandler()` 注册处理器，`acceptUsers()` 在扩展注册时触发 delta 回调（added/removed），`AbstractExtensionService._doHandleExtensionPoints()` 遍历所有扩展点分发。`extensionsProposedApi.ts` 用 `product.json#extensionEnabledApiProposals` 白名单控制 proposed API，开发模式允许全部，发布版必须白名单。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 多宿主隔离 | `extensionHostKind.ts:9` `ExtensionHostCollection` | 扩展崩溃只影响所在宿主，远程扩展直接访问远程资源 |
| RPC 协议接口配对 | `extHost.protocol.ts` MainContext/ExtHostContext | 编译时类型安全，`$` 前缀约定，新增方法不破坏旧端 |
| 顾客模式 | `extHostCustomers.ts:28` `extensionHostManager.ts:283` | ExtHost→Main 经 DI 解耦路由，`@extHostNamedCustomer` 声明式注册 |
| 懒激活 | `abstractExtensionService.ts:992` `extensionHostManager.ts:327` | activationEvents 按需激活，`_cachedActivationEvents` 防重复 |
| proposed API 白名单 | `extensionsProposedApi.ts:20` | `product.json` 白名单控制未稳定 API 访问 |

## 模块间交互

扩展系统依赖 platform（instantiation/rpc/extensions）。被 workbench contrib 层广泛调用：`ExtensionsRegistry.registerExtensionPoint()` 在 debug/tasks/snippets/chat/views/terminal/notebook 等 15+ contrib 模块注册扩展点；`IExtensionService.activateByEvent()` 被文件系统、命令系统、语言特性在需要时触发激活。扩展宿主进程经 MessagePort 直连 renderer（不经 main 中转，避免瓶颈）。

## 扩展方式

**新增扩展 API 方法（协议两端）**：`extHost.protocol.ts` 在 `MainThreadXxxShape` 加 `$newMethod(...)` → `mainThreadXxx.ts` 实现（注入主进程服务）→ `extHostXxx.ts` 调 `getProxy(MainContext.MainThreadXxx).$newMethod(...)` → `vscode.d.ts` 公开声明。

**新增扩展贡献点**：`extensions.ts` 的 `IExtensionContributions` 加字段 → 某 contrib 模块 `ExtensionsRegistry.registerExtensionPoint<T>({ extensionPoint, jsonSchema })` → `setHandler()` 处理扩展贡献调相应服务注册。

**改变扩展宿主分配策略**：`extensionHostKind.ts` 修改 `determineExtensionHostKinds()` 或实现新 `IExtensionHostKindPicker` → `extensionRunningLocationTracker.ts` 的 `initializeRunningLocation()` 分配。
