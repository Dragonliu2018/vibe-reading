---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "Cordis 插件内核"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Cordis", "Plugin", "TypeScript"]
description: "dsh 的底座——vendored Cordis 如何用 Context/Service/Fiber/Events 实现 everything is a plugin：reversible effects、typed events、waterfall 与 scope。"
readingTime: "16 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

Cordis 是 dsh "everything is a plugin" 成立的底座。dsh 把整个 Cordis 框架 vendor 进 `vendor/`（`cordis`、`cosmokit`、`schemastery`、`loader`、`include`、`group`、`hmr`、`timer`、`logger-console`），rename 到 `@deepseek-ai` scope 防止上游名 squat。它提供三件事：插件向共享 `ctx` 贡献 services / typed events / reversible effects 的范式；插件生命周期状态机（mount/unload + 依赖追踪）；以及 `cordis.yml` loader 把声明式插件树 mount 成运行时。这一层与产品逻辑完全正交——dsh 的 agent loop、工具、session 都建在其上，但 Cordis 本身不知道 agent 为何物。

## 模块架构

Cordis 内部四个核心组件协作：

```
Context (ctx)  ──持有──▶  Service 实例（ctx.tools / ctx.llm / ctx.sessions ...）
     ▲                            ▲
     │ extend/isolate/intercept   │ super(ctx, name) 自注册
     │                            │
   Fiber ──持有──▶ _disposables (Effect 列表)  ◀──register──  Events (on/waterfall)
  (插件运行实例,                     ▲
   状态机)                           │ dispose 逆序 unwind
                                  Registry ──以 callback 为 key──▶ Plugin.Runtime
```

- **`Context`**（`vendor/cordis/src/context.ts:42`）是服务仓库 + scope 载体。构造时把自己包成 `Proxy`，所有属性读走 `ReflectService.handler`，使 `ctx.tools` 这类读取经服务解析器返回当前 scope 下的实现。`extend()`/`isolate()`/`intercept()` 创建子 context 而不改父级（原型链 + `symbols.isolate`/`symbols.intercept`）。
- **`Service`** 基类（`service.ts:11`）是所有 ctx 服务的抽象。子类构造器调 `super(ctx, name)`，内部 `ctx.reflect.provide(name, this, ...)` 立即注册，服务随拥有它的 fiber 卸载自动注销。
- **`Fiber`**（`fiber.ts:184`）是插件运行实例，状态机 `PENDING→LOADING→ACTIVE→FAILED/UNLOADING→DISPOSED`。`_refresh()` 拼 `epoch`（依赖服务 fiber uid 串），依赖变化时 `_setEpoch()` 触发 `_reload()`/`_unload()`。
- **`Events`**（`events.ts:131`）支持 5 种 dispatch：`emit`/`waterfall`/`parallel`/`serial`/`bail`。`on()` 的 `register()` 把监听器挂为 fiber 的 effect。

## 调用链路

一次插件挂载到事件触发的路径：

```
cordis.yml entry
  └─ Loader (vendor/loader/src/index.ts) 解析 Entry/EntryGroup/EntryTree
     └─ include (vendor/include) 解析 !!js 表达式 + patch overlay
        └─ RegistryService.plugin() (registry.ts:316) 归一化 callback → new Plugin.Runtime → new Fiber
           └─ Fiber._refresh() 等 inject 声明服务就绪 → 执行 plugin callback(ctx, config)
              └─ ctx.effect(on/register/provide) → 挂 _disposables
                 └─ ctx.waterfall('some/event', payload, () => default)
                    └─ listeners outermost-first，每个调 next() 委派到内层 → built-in default
```

关键数据类型：`Plugin` 三种形态（function / class constructor / `{ apply }` 对象）；`Fiber.effect(execute: () => Effect): AsyncDisposable`（`fiber.ts:415`），返回的 disposer/Promise/iterable 产出都被收集；`waterfall` 最后参数是 `next`，不调即 veto。

## 核心实现

### Reversible Effects 与确定性 unwind

`Fiber.effect()`（`fiber.ts:415`）是 dsh 插件范式的支点。`execute` 立即执行；它返回的 disposer 函数、`Promise<disposer>`、或 sync/async iterable 产出的 disposer 都被收集进 `_disposables`。卸载时 `_unload()`（`fiber.ts:675`）`clear()` 全部 disposables 并**逆序**执行 `runDisposable`——`disposables.splice(0).reverse()`（`fiber.ts:431`）保证后注册的先回滚。

这让"扩展靠在旁挂载插件"成立：任何 registration（prompt section / tool schema / listener / provider）都是 effect，插件卸载时确定性 unwind，不需手工 teardown。`ctx.on()` 的 `register()`（`events.ts:256`）直接调 `ctx.fiber.effect(...)`；`Service` 构造器调 `ctx.reflect.provide()` 同样挂 fiber disposables。dsh 在此基础上做了 **lifecycle hardening**（`vendor/README.md` 第 6 条）：effect owner-list wrapper 在 setup 前注册、async teardown 保持 owner-visible、`UNLOADING` 时拒绝新 effect，闭合三类 reentrant disposal 竞态。

### Typed Events（declaration merging）

Cordis 的事件类型用 TypeScript declaration merging 扩展，而非集中式枚举。某包在 `src/index.ts` 顶部声明：

```typescript title="loader/src/index.ts"
declare module '@deepseek-ai/cordis' {
  interface Events {
    'some/event'(payload: SomeType): void
  }
}
```

dispatch 时 `ctx.emit`/`ctx.waterfall` 按事件名查找合并后的 `Events` 接口得到类型。`events.ts:329` 定义内置 `Events` 接口，dispatch 模式（`emit`/`waterfall`/`parallel`/`serial`/`bail`，`events.ts:32`）是事件公共契约的一部分。dsh 约定：事件 JSDoc 需 `@mode`，payload `@param`，scoped keys 缺省需 `@dshScopeScan unsupported`。

### Waterfall 语义与 next()

`ctx.waterfall()`（`EventsService.waterfall` in `events.ts:234`）是 around-middleware：最后一个参数是 `inner` 的 `next`，监听器按 outermost-first 执行；调 `next()` 委派给下一层（最终到 built-in behavior），不调则 veto。这是 dsh"单决策事件允许多插件包裹默认行为"的机制——policy listener 可 short-circuit veto。dsh 的 `Fiber.update()` 把 `internal/update` waterfall 结果直接返回，让 Loader 调用方能 await restart 并保留同步 config 校验。dsh 规约（`AGENTS.md`）：**Waterfall listeners MUST call `next()`** to delegate；returning without it short-circuits the chain。

### Loader 与 cordis.yml 组合

`vendor/loader/src/index.ts` 读 `cordis.yml`，`Entry`/`EntryGroup`/`EntryTree` 构成插件树。`include` 解析 `!!js` 表达式节点并做 patch overlay；`group` 做事务化子树更新；`hmr` 做文件监听与 fiber restart。config 延迟解析（`vendor/README.md` 第 15 条）：保留 raw fiber config，只在 declared injections 激活后经 `internal/config` waterfall 解析，让 `!!js` 表达式在该 row 自己的 fiber context 下惰性求值。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Plugin-host / Registry | `registry.ts:195` `RegistryService` | 以 callback 为 identity key 管理所有插件 runtime |
| Disposable / Reversible-effect | `utils.ts:5` `DisposableList` + `Fiber._disposables` | effect 返回 disposer，卸载逆序 unwind |
| Event-emitter + Middleware-waterfall | `events.ts:131` `EventsService` | 5 种 dispatch，waterfall 是 around-middleware |
| Service Locator / DI | `registry.ts:19` `Inject` + `ctx.<key>` 读取 | `inject` 声明驱动加载顺序 |
| Scope 原语 | `context.ts:121` `isolate` / `:141` `intercept` | per-agent / per-session 隔离与配置拦截 |

## 模块间交互

Cordis 是所有 dsh 包的 peerDependency（`@deepseek-ai/cordis: workspace:^`），219 个包声明之。vendored 包间依赖：`cordis` peer-deps `cordis-plugin-include` 与 `cordis-plugin-loader`，源码 import `@deepseek-ai/cosmokit`；`loader` import cordis 的 `Context/Service/Fiber/Inject`；`include`/`group`/`hmr` 均构建在 cordis + loader 之上。`cosmokit`（1.8.1）是零依赖工具库，`schemastery`（3.18.0）提供 config schema。dsh 的核心引擎层（agent-loop/tools/session）通过 `ctx.effect()`/`ctx.on()`/`ctx.waterfall()` 注册自身，能力生态层的每个 provider 是一个 plugin。

## 扩展方式

- **新增一个 Cordis 插件**：在 `packages/<group>/<pkg>/` 写 function/class plugin，`inject` 声明依赖，`ctx.effect()`/`ctx.on()` 注册；在对应 `cordis.yml` preset 加 entry。
- **新增一个 typed event**：包 `src/index.ts` 顶部 `declare module '@deepseek-ai/cordis' { interface Events { 'my/event'(x: T): void } }`，dispatcher 处用 `ctx.emit`/`ctx.waterfall`，文档加 `@mode` tag。
- **扩展 Service 定义**：新建 `class XService extends Service`，`super(ctx, 'x')`；用 `declare module` 扩展 `interface Context { x: XService }`；在插件里 `ctx.provide('x', new XService(ctx))` 或让 Service 子类自注册。

## 重要设计决策

为什么 vendor 而不用 npm：dsh 要"fully owns its framework layer (auditable, patchable, pinned)"，并 rename 到 `@deepseek-ai` scope 防上游名 squat；`verify-vendored-links` 门禁强制 `link: workspace`。为什么 reversible effects：让"扩展靠在旁挂载插件"成立——插件卸载确定性 unwind，不需手工 teardown。为什么 waterfall `next()` 关键：单一决策事件允许多插件包裹默认行为，policy listener 可 veto，而 `agent/turn-stopping` 用 serial 保证 listener order 不改变 outcome。
