---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "Renderer UI"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "React", "zustand", "性能"]
description: "167 万行 React 的组织法：单 store 45 个 slice、selector identity 纪律变成 CI 性能门、copy-on-write record、表面级可恢复错误边界与 overlap 式启动水合。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

`src/renderer/src/`（~167 万行 React）是呈现层。它回答的问题不是"怎么写 UI"，而是"**167 万行的 renderer 怎么保持可维护与可测量**"——答案不是拆成多个库，而是把性能预算变成纪律（CI gate + 探针），把崩溃隔离做到表面粒度。

## 模块架构

![Renderer 结构](/vibe-reading/images/articles/orca-internals/renderer-structure.svg)

`main.tsx` 入口极薄（85 行）：先以 import-free shim 顺序安装 `react-commit-cascade-observer`（注释解释为什么必须在 react-dom 求值前注入 global），`applyDocumentTheme('system')`，最后 render。`App.tsx`（117 行）几乎不含 JSX——是一组 always-mounted 的 `use*` service hooks，渲染三层表面：`AppBackgroundServices`（无 UI 后台容器）、`AppWorkspaceShell`（主工作区：Sidebar + Titlebar + `TerminalWorkbenchContainer` + lazy 的 `ActivePage` 与 `RightSidebar`——注释明说右栏"keep the shell mounted for layout stability, heavy panels disconnect while closed"）、`AppRootSurfaces`（全屏 portaled 表面如 quick-open）。页面全部 `lazyWithRetry`；`WindowControls` 最后渲染（注释：Electron drag-region hit-test 按 DOM 顺序忽略 z-index）。

store 侧是**单一 zustand store**：`useAppStore` 由 ~45 个 `create*Slice` StateCreator 组合，经 `withDevelopmentStoreProbes`（dev-only identity churn 探针）和**无条件**的 `withReactCommitCascadeWriteProbe` 包装。

## 调用链路

renderer 的 boot chain（`hooks/use-app-startup-hydration.ts`，368 行高注释密度）：

```text
1. ensureLocalRuntimeCapabilities()    # #19154：pre-hydration 建 agent session 否则降级裸 terminal
2. fetchSettings → publishTerminalViewAttributesAtAppStart
   → ui.get() + hydratePersistedUIAfterStartupRead
   # #1158：UI writer 只被 persistedUIReady 门控，hybrid 前延迟会让默认值
   # 序列化写回磁盘；失败走 recoverFromDegradedStartup 的 degraded no-save 模式
3. 并行重叠 IPC：keybindings/onboarding 先发、repo 扫描重叠
   → fetchReposForAllHosts({remoteHosts:'skip'}) 只拉本地 catalog 保证 first paint
4. fetchWorktrees（mapWithConcurrency + 先 await Git barrier）
5. hydrateSessionStores 同步块：workspace/tabs/editor/browser session 依次 hydrate
   → reconcileHydratedWorkspaceTabModels：所有 tabsByWorktree key
     【一次批量】reconcile——"one store write for the whole session instead
      of one per workspace, each fanning out to every non-React store subscriber"
6. SSH 重连 → reconnectPersistedTerminals → sweepRestoredCodexPanesForStaleAccounts
   → setHydrationSucceeded(true)
7. 远程 catalog/worktree 全量刷新甩进后台 async IIFE，不挡终端恢复
```

每步有 `timeRendererStartupStep` 计时、`cancelled` flag + AbortController 防 StrictMode 双跑。renderer → main 的通道是单一 `window.api`（`preload/api/` 按域分组）；进化层 `callRuntimeRpc(target, 'project.update', …)` 走 `window.api.runtime.call`——还能路由到远程 runtime host。

方法速查表：

<details>
<summary>renderer 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `useAppStartupHydration()` | boot chain | 全程 overlap + degraded 降级保护 |
| `reconcileWorktreeTabModels(ids)` | tab 模型对账 | 批量一次写，控制 fanout |
| `copyOnWriteRecord(source)` | 惰性克隆 record | 未触碰的 source 保持 identity |
| `updateProject()` in store/projects | 双路由更新 | local 走 IPC，远程走 RPC；回程经 `normalizeProjectRow` 防御 |
| `createAgentSessionCreateOperation()` | 会话创建操作 | ambiguous failure 同 ID 重放 ≤2 次，host 侧幂等去重 |
| `resolveMountedLazyModalIds()` | lazy modal 状态 | 单向 ratchet，未触发永不进 bundle 执行路径 |

</details>

## 核心实现

### selector 纪律：性能问题变成 CI 回归

这是整个 renderer 的核心决策。500+ 文件、40+ slice 的单 store，任何一处 selector 返回新引用（如 `state.xs.map(...)`）都会让全部订阅者重跑。Orca 的做法不是拆 store，而是三层防线：

- **`config/scripts/zustand-selector-fanout-benchmark.mjs`**——CI gate（`check:zustand-selector-fanout`）：2500 subscribers × 2000 writes，**每次 write 上限 5ms** 硬阈值，把"selector 必须返回稳定 identity"变成可量化回归测试；
- **`store/react-commit-cascade-write-probe.ts`**——zustand middleware，在疑似 React commit cascade 期间采样 store write，让 crash report 直接点名肇事先代码（注释解释为什么必须是 creator 包装而非事后 patch `useAppStore.setState`：slices 内部 `set` 闭包抓不到）；
- **`always-mounted-selector-scan-cost.test.ts`**——常驻表面只准用廉价 selector。

### copy-on-write record：写次数也是预算

```ts title="src/renderer/src/store/copy-on-write-record.ts（32 行）"
copyOnWriteRecord<T>(source) → { read, delete, set }
// 首次写才 { ...source } 克隆，之后复用同一 mutable 对象
// delete 不存在的 key 是 no-op 不触发克隆
```

源码注释给出 why："an untouched source keeps its identity, so identity-keyed selectors and persist gates stay quiet"——store patch 只在真的有变化时才产生新 record identity，与 fanout 纪律配套。

### 表面级可恢复错误边界

`RecoverableRenderErrorBoundary` 带 `boundaryId`/`resetKey`，每个表面（sidebar、terminal workbench、page、right-sidebar）独立崩溃可重试。`AppWorkspaceShell.tsx:104` 注释明说 workspace activation 是热路径，`activeWorktreeId` **不进 reset keys** 以免 wake 时整面 remount。

### runtime/ 目录：操作编排层

`src/renderer/src/runtime/` 不是 UI 也不是 IPC 薄封装，而是**操作（operation）模式**。`agent-session-create-operation.ts` 的 `createAgentSessionCreateOperation()` 生成 `clientOperationId`，`run(invoke)` 对 **ambiguous failure**（非 `RuntimeRpcCallError`、非 AbortError，即传输丢失、创建结果未知）最多重放 `MAX_AMBIGUOUS_CREATE_ATTEMPTS = 2` 次，且复用同一 operation ID 保证 host 侧幂等去重；RPC 明确报错则直接抛。

### 可观测性内建

`registerRendererMemoryProfileContributor('store'/'storeKB', …)` 让 OOM crash breadcrumb 直接点名"最肥的 20 个 collection"——注释引用真实事故（"97b9e86d leaked ~700MB while its biggest slice grew by 4 entries"）。几乎每个非组件文件带同名 `.test.ts` 同居测试，行为契约在文件级锁定。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单 store 多 slice | `store/index.ts` 的 ~45 个 `create*Slice` | 状态一处可审计，性能靠纪律 |
| 性能即 CI gate | fanout benchmark + write probe | 人盯不住的纪律交给机器 |
| copy-on-write record | `store/copy-on-write-record.ts` | identity 稳定优先于不可变性教条 |
| 单向 ratchet lazy mount | `lazy-modal-mount-state.ts` | 未触发的 modal 永不进执行路径 |
| 操作模式 + 幂等重放 | `runtime/agent-session-create-operation.ts` | ambiguous failure 的确定性收敛 |

## 模块间交互

对 main：单一 `window.api`（preload contextBridge）+ 进化层 `callRuntimeRpc`（本地/远程双路由，见[统一 RPC 层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/02-rpc)）。对启动：与主进程的 `app:awaitFirstWindowStartupServices` / `app:awaitGitEnvironmentStartupBarrier` 形成双向 barrier（见[主进程启动与生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/01-startup)）。agent 状态经 `agentStatus:set` 推送进 `agentStatusByPaneKey`（单一 renderer 侧投影，权威源见[会话数据层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/07-session-data)）。UI 设计系统：shadcn primitives + `assets/main.css` tokens（`docs/STYLEGUIDE.md` 是唯一权威，禁止发明新色值/字号）。

## 扩展方式

**新增一个右侧栏面板**（以现有 `vault`/`checks` 为模板）：

1. `src/shared/ui-chrome-types.ts`（约 L100）：`ActiveRightSidebarTab` 联合类型加新 tab 值；
2. `store/right-sidebar-route.ts`：`resolveRightSidebarRoute` 归一化——处理 legacy/持久化值映射，注意 plugin panel key fencing（`isPluginPanelTabKey`）；
3. `components/right-sidebar/right-sidebar-panel-content.tsx`：`lazy(() => import('./NewPanel'))` + 分支（重面板参考 `PortsPanel` 传 `isVisible` 做 disconnect-while-closed）；
4. `components/right-sidebar/index.tsx`（217 行）：activity bar 加 entry——该文件 7 处 `useAppStore(` selector 必须保持稳定 identity，否则过不了 fanout 基准；
5. 需要持久化状态则加 slice 或 selector 文件 + 同名 `.test.ts`，并检查 `AppWorkspaceShell.tsx:228` 的布局条件。
