---
source:
  type: "源码解读"
  project: "vscode"
  url: "https://github.com/microsoft/vscode"
title: "依赖注入与服务注册"
date: "2026-08-18T15:19:54+08:00"
category: [Tools, IDE, VSCode, CodeWiki, "1.135.0"]
tags: ["vscode", "依赖注入", "DI", "TypeScript"]
description: "VS Code 的 createDecorator DI 容器、服务标识符与延迟实例化机制"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/00-overview)

---

## 模块定位

VS Code 有数百个服务，如果每个消费方都手动 `new` 依赖、手动管生命周期，代码会迅速退化成意大利面。`src/vs/platform/instantiation/` 用一套极简的 DI 容器解决这个问题——它的核心只有几个文件、不到 500 行，却被几乎全部 platform/workbench/editor 模块 import，是整个代码库最底层的 platform 模块之一。它只依赖 `base/common`（lifecycle/async/errors/event），位于依赖图最底端。本模块是理解 VS Code 所有服务如何声明、注册、注入、实例化的钥匙。

## 模块架构

```
┌──────────────────────────────────────────────────────────┐
│ 消费方（服务/命令/contribution）                          │
│   constructor(@IFooService foo: IFooService) { ... }     │
└───────────────┬──────────────────────────────────────────┘
                 │ 装饰器参数位置（编译期 storeServiceDependency）
                 ▼
┌──────────────────────────────────────────────────────────┐
│ ServiceIdentifier<T>  (createDecorator 产物)             │
│   _util.serviceIds: Map<string, ServiceIdentifier> 去重  │
└──────────────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────┐   ┌─────────────────────────┐
│ ServiceCollection          │   │ registerSingleton       │
│  Map<ServiceId, instance   │◄──│  (id, ctor, InstantiationType)│
│                | SyncDescriptor│ └─────────────────────────┘
└─────────────┬──────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│ InstantiationService                                     │
│  createInstance(ctor, ...args) → 解析依赖 → 拓扑排序 → Reflect.construct │
│  invokeFunction(fn) → ServicesAccessor 临时取服务        │
│  createChild(services) → 子作用域（继承 + 覆盖）          │
└──────────────────────────────────────────────────────────┘
```

核心组件：`ServiceIdentifier` 是服务的类型安全标识符（一个函数对象，携带幻影 `type` 属性做类型推导）；`ServiceCollection` 是 `Map<ServiceIdentifier, instance | SyncDescriptor>`，存注册项；`SyncDescriptor` 包装构造函数 + 静态参数 + `supportsDelayedInstantiation` 标志；`InstantiationService` 是 DI 容器，`createInstance` 解析依赖并构造，`Graph` 做拓扑排序检测循环依赖；`registerSingleton`（`extensions.ts`）把服务推入全局 `_registry`，启动时批量注入主 `ServiceCollection`。

## 调用链路

```
createInstance(ctorOrDescriptor, ...rest)
 ├─ SyncDescriptor? → _createInstance(desc.ctor, desc.staticArguments + rest)
 └─ ctor?            → _createInstance(ctor, rest)

_createInstance(ctor, args):
  1. serviceDependencies = getServiceDependencies(ctor).sort(by index)   // 读 $di$dependencies
  2. for each dep: _getOrCreateServiceInstance(dep.id)                    // 懒创建
  3. firstServiceArgPos = deps[0]?.index ?? args.length
  4. 校准 args 长度对齐
  5. Reflect.construct(ctor, args.concat(serviceArgs))

_getOrCreateServiceInstance(id):
  thing = _getServiceInstanceOrDescriptor(id)   // 本地 miss 向 parent 查
  ├─ SyncDescriptor → _safeCreateAndCacheServiceInstance  // _activeInstantiations Set 防递归
  └─ instance       → 直接返回

_createAndCacheServiceInstance(id, desc):
  1. 构建 Graph<{id, desc}>，DFS 收集所有未实例化的 SyncDescriptor 依赖
  2. 拓扑排序：roots() → 逐个实例化 → _setCreatedServiceInstance(缓存回 ServiceCollection) → removeNode
  3. roots.length===0 && !graph.isEmpty() → CyclicDependencyError   // 检出循环依赖
```

延迟实例化（`supportsDelayedInstantiation=true`，`instantiationService.ts:292-385`）不直接构造，而是返回一个 `Proxy`，底层用 `GlobalIdleValue` 包装：Proxy 拦截 `get`，若 key 是 `onDid*`/`onWill*` 事件名返回早期监听器桩函数（先缓存回调，待真实实例化后转发），其他属性触发 `idle.value` 真正创建。实例在浏览器空闲时或首次访问时创建，注入消费者时零成本。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `createDecorator` in `instantiation.ts:109` | 创建 ServiceIdentifier | 幂等（`serviceIds` Map 去重），函数本身是参数装饰器 |
| `InstantiationService.createInstance` | 同步构造实例 | 解析 `$di$dependencies` 按参数位置注入 |
| `InstantiationService.invokeFunction` | 闭包内临时取服务 | `ServicesAccessor._done` 防事后访问 |
| `InstantiationService.createChild` | 子作用域 | 继承父服务 + 可覆盖，dispose 仅清理子创建的 |
| `Graph.findCycleSlow` in `graph.ts:86` | DFS 检测循环依赖 | `roots()` 出度为 0 节点逐个移除，非空即有环 |
| `registerSingleton` in `extensions.ts` | 全局注册服务单例 | `InstantiationType.Eager`(0) 立即 / `Delayed`(1) Proxy 延迟 |

</details>

## 核心实现

### createDecorator 机制

`createDecorator` 是**唯一**创建 `ServiceIdentifier` 的途径（`instantiation.ts:109-126`）。它返回的 `id` 函数本身是一个 TC39 Stage 1 参数装饰器：

```typescript title="src/vs/platform/instantiation/common/instantiation.ts"
export function createDecorator<T>(serviceId: string): ServiceIdentifier<T> {
  if (_util.serviceIds.has(serviceId)) {
    return _util.serviceIds.get(serviceId)!;          // 同名去重
  }
  const id = function (target: Function, key: string, index: number) {
    if (arguments.length !== 3) {
      throw new Error('@IServiceName-decorator can only be used to decorate a parameter');
    }
    storeServiceDependency(id, target, index);         // 记录 {id, index} 到 target.$di$dependencies
  } as ServiceIdentifier<T>;
  id.toString = () => serviceId;
  _util.serviceIds.set(serviceId, id);
  return id;
}
```

当 `@IFoo` 标注在构造函数参数上时，TS 编译器调用 `id(target, key, index)`，`storeServiceDependency`（`instantiation.ts:97-104`）把 `{id, index}` 推入 `target[$di$dependencies]`，用 `target[$di$target] = target` 标记已初始化。`_util.serviceIds`（`Map<string, ServiceIdentifier>`）按 serviceId 字符串去重，保证同名 decorator 全局唯一。

**为什么不用 reflect-metadata**：VS Code 用 TS 参数装饰器，编译期已被降级为函数调用，参数 index 直接传入，无需运行时反射；同时避免引入 reflect-metadata polyfill 依赖，性能更可控（手动数组 vs `Reflect.getMetadata` 全表扫描）。这是「编译期已知信息不在运行期重算」的原则。

### BrandedService 品牌类型与参数分离

`BrandedService`（`{ _serviceBrand: undefined }`）是类型系统的「品牌标记」——只有声明了 `_serviceBrand` 的接口才被视为服务参数。`GetLeadingNonServiceArgs`（`instantiation.ts:47-50`）是递归条件类型，从构造参数元组尾部剥离所有 `BrandedService`，剩余即为普通参数：

```typescript
export type GetLeadingNonServiceArgs<TArgs extends any[]> =
  TArgs extends [] ? []
  : TArgs extends [...infer TFirst, BrandedService] ? GetLeadingNonServiceArgs<TFirst>
  : TArgs;
```

这让 `createInstance(MyClass, 'arg1', 42)` 能编译期校验：`'arg1'` 和 `42` 是 leading 非 service 参数，尾部自动用服务填充。品牌类型防止普通参数被误当服务注入——一个 typo 不会把字符串当成 `IFileService`。

### Graph 拓扑排序与循环检测

`Graph<T>`（`graph.ts`）是依赖图的通用实现：`Node` 有 `incoming`/`outgoing` Map，`insertEdge` 双向链入，`roots()` 返回出度为 0 的节点。`_createAndCacheServiceInstance` 构建图后循环 `roots()` 逐个实例化并 `removeNode`——若 `roots.length===0` 且图非空，说明剩余节点互相依赖成环，抛 `CyclicDependencyError`。`findCycleSlow`（`graph.ts:86`）用 DFS 兜底输出环路径。`_activeInstantiations` Set（`instantiationService.ts:197-209`）额外防止单次实例化递归（A 依赖 B 依赖 A），比 Graph 检测更快捕获直接环。

### createChild 服务继承与覆盖

`createChild(services)`（`instantiationService.ts:73-87`）创建子 `InstantiationService`，`_parent` 指向当前。查找链：`_getServiceInstanceOrDescriptor` 本地 miss 则递归向 parent 查；`_setCreatedServiceInstance` 同理向 parent 写。子作用域可 `set` 覆盖父服务（本地优先），但不影响父——子 dispose 时仅清理子创建的服务。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 函数作 ServiceIdentifier | `instantiation.ts:91-113` | 函数对象可携 `type: T` 幻影属性做类型推导；`serviceIds` Map 防重复 |
| 手动 storeServiceDependency | `instantiation.ts:97-104` | TS 参数装饰器编译期传 index，无 polyfill，无运行时反射开销 |
| BrandedService 品牌类型 | `instantiation.ts:31, 47-50` | 编译期分离 service 参数与普通参数，防误注入 |
| Graph 拓扑排序 | `graph.ts:26-34, 86-110` | `roots()` 出度为 0 节点逐移除检测环，DFS 兜底输出环路径 |
| GlobalIdleValue Proxy 延迟 | `instantiationService.ts:292-385` | 事件名桩函数先缓存监听器，空闲或首次访问才真创建 |
| createChild 继承链 | `instantiationService.ts:73-87` | 子作用域覆盖父服务不影响父，支持测试/临时作用域 |

## 模块间交互

instantiation 被**几乎全部** platform/workbench/editor 模块 import——任何声明 `createDecorator` 的服务都依赖它。它自身仅依赖 `base/common`（lifecycle/async/errors/event/linkedList），无外部依赖，位于依赖图最底层。`registerSingleton` 的全局 `_registry` 在 `Workbench.initServices()` 时经 `getSingletonServiceDescriptors()` 批量注入主 `ServiceCollection`。命令系统通过 `invokeFunction` 的 `ServicesAccessor` 间接使用 DI——命令注册时不持有服务引用，执行时才取，避免循环依赖。

## 扩展方式

**声明新服务并注册实现**：定义接口 `export interface IMyService { readonly _serviceBrand: undefined; doWork(): void; }` → `export const IMyService = createDecorator<IMyService>('myService')` → 实现类 `class MyService implements IMyService { declare readonly _serviceBrand: undefined; constructor(@IFileService fs: IFileService) {} }` → `registerSingleton(IMyService, MyService, InstantiationType.Delayed)`。

**命令中用 invokeFunction 取服务**：`commands.registerCommand('my.cmd', accessor => instantiationService.invokeFunction(a => a.get(IMyService).doWork()))`。`accessor.get` 只在闭包存活期有效。

**createChild 覆盖服务**（测试场景）：`const child = instantiationService.createChild(new ServiceCollection([IFileService, new InMemoryFileService()])); child.createInstance(MyConsumer)`——`MyConsumer` 拿到 `InMemoryFileService` 而非父的磁盘实现。
