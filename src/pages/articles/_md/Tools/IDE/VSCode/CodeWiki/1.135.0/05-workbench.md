---
source:
  type: "源码解读"
  project: "vscode"
  url: "https://github.com/microsoft/vscode"
title: "Workbench 工作台"
date: "2026-08-18T15:19:54+08:00"
category: [Tools, IDE, VSCode, CodeWiki, "1.135.0"]
tags: ["vscode", "Workbench", "布局", "Parts", "Composite"]
description: "VS Code 工作台 shell——代码计算布局、Part 抽象、Composite/View 容器与启动编排"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/00-overview)

---

## 模块定位

`src/vs/workbench`（约 143 万行，代码量最大的一层）是工作台 shell——它把 Monaco 编辑器、99 个内置 contrib、扩展宿主、无数服务编排成一个连贯的 UI。本模块聚焦 `src/vs/workbench/browser/`——即工作台的「壳」：`Workbench` 启动入口、`Layout` 代码计算布局、`Part` UI 区域基类、`Composite`/`PaneComposite` 可插拔视图容器。`contrib/` 的贡献注册机制见 [07-contribution-system](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/07-contribution-system)，扩展宿主见 [06-extension-system](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/06-extension-system)。

## 模块架构

```
┌─────────────────────────────────────────────────────────────┐
│ Workbench (browser/workbench.ts) extends Layout             │
│  startup() → initServices → Registry.start → render → restore │
└───────────────┬─────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────┐
│ Layout (browser/layout.ts, ~3240 行)                        │
│  实现 IWorkbenchLayoutService                              │
│  └─ SerializableGrid (base/browser/ui/grid) 管理所有 Part   │
└───────────────┬─────────────────────────────────────────────┘
                ▼
┌────────────┬─────────────┬────────────┬──────────┬─────────┐
│ TITLEBAR   │ ACTIVITYBAR │ SIDEBAR    │ EDITOR   │ PANEL   │
│ Part       │ Part        │ (PaneComp) │ Part     │ (PaneC) │
│ 48px       │ 48px        │ min 170    │ (grid)   │ min 300 │
├────────────┴─────────────┴────────────┴──────────┴─────────┤
│ STATUSBAR Part                              AUXILIARYBAR    │
└─────────────────────────────────────────────────────────────┘
```

核心组件：`Workbench`（启动入口，继承 `Layout`）编排服务装配→贡献启动→渲染→恢复；`Layout`（抽象基类，实现 `IWorkbenchLayoutService`）用 `SerializableGrid` 管理所有 Part 的位置尺寸；`Part`（UI 区域基类，继承 `Component`，实现 `ISerializableView`）统一 create/layout/setVisible 生命周期；`Composite`/`PaneComposite`（可插拔容器基类）让 Sidebar/Panel 容纳多个动态注册的视图。

## 调用链路

```
BrowserMain.open()                          web.main.ts:129
 ├─ initServices()                          :272  创建 ServiceCollection + 基础服务
 ├─ Promise.all([initServices, domContentLoaded])   并行
 ├─ new Workbench(dom, services, log)       :261
 └─ workbench.startup()                     workbench.ts:131
     ├─ initServices(serviceCollection)     :192
     │   ├─ serviceCollection.set(IWorkbenchLayoutService, this)   :195
     │   ├─ getSingletonServiceDescriptors() → 注入所有 registerSingleton 服务  :207
     │   └─ new InstantiationService(serviceCollection)            :212
     │        └─ lifecycleService.phase = Ready                     :225
     ├─ Registry.as<IWorkbenchContributionsRegistry>(Workbench).start(accessor)  :162
     ├─ initLayout(accessor)                layout.ts:324
     ├─ renderWorkbench(...)                :320
     │   └─ for each Parts: getPart(id).create(container)   :346-361
     │      顺序: TITLEBAR→BANNER→ACTIVITYBAR→SIDEBAR→EDITOR→PANEL→AUX→STATUSBAR
     ├─ createWorkbenchLayout()             layout.ts:1638  SerializableGrid.deserialize
     ├─ layout()                            layout.ts:1747  getClientArea → grid.layout(w,h)
     └─ restore(lifecycleService)           :412
         ├─ restoreParts()                  各 Part 恢复上次状态
         └─ Promise.race([whenRestored, timeout(2000)])   :431
            → phase = Restored → Eventually
```

`startup()` 全程同步（除 restore 异步），确保 UI 快速呈现；`restore` 用 `Promise.race` 超时 2s 避免慢编辑器阻塞贡献点。`getSingletonServiceDescriptors()` 把所有 `registerSingleton()` 注册的服务批量注入 `ServiceCollection`——这是工作台服务装配的关键一步。

<details>
<summary>核心类速查表</summary>

| 类 | 文件 | 关键设计 |
|------|------|----------|
| `Workbench` | `workbench.ts:67` | extends Layout，`startup()` 编排 |
| `Layout` | `layout.ts:155` | `SerializableGrid` 管理 Part，`createGridDescriptor()` 序列化布局 |
| `Part` | `part.ts:34` | `ISerializableView`，构造时 `registerPart`，模板方法 create |
| `Composite` | `composite.ts:34` | action toolbar 契约，生命周期 create→setVisible→layout→focus |
| `PaneComposite` | `panecomposite.ts:27` | 内嵌 ViewPaneContainer，三个 Registry（Viewlets/Panels/Aux） |
| `ActivitybarPart` | `parts/activitybar/activitybarPart.ts:44` | 固定 48px |
| `SidebarPart` | `parts/sidebar/sidebarPart.ts:42` | min 170px，AbstractPaneCompositePart |
| `EditorPart` | `parts/editor/editorPart.ts` | 内部 SerializableGrid 管理编辑器组 |

</details>

## 核心实现

### 代码计算布局：SerializableGrid

`Layout` 用 `SerializableGrid`（`base/browser/ui/grid/grid.ts`）——一个代码计算的二维网格，非 CSS 布局。`createGridDescriptor()`（`layout.ts:2663`）构建序列化网格描述：

```
root (VERTICAL branch)
 ├─ TITLEBAR_PART leaf (高度 = titleBarHeight)
 ├─ BANNER_PART leaf (初始 hidden)
 ├─ middle section branch (高度 = height - title - status)
 │    └─ arrangeMiddleSectionNodes() 动态排列:
 │        activityBar | sidebar | editor | panel | auxiliaryBar
 └─ STATUSBAR_PART leaf (高度 = statusBarHeight)
```

`createWorkbenchLayout()`（`layout.ts:1638`）调 `SerializableGrid.deserialize()` 从描述构建实际 grid，每个 Part 作为 `ISerializableView` 叶节点。`layout()`（`:1747`）获取 `getClientArea(parent)` 尺寸，调 `workbenchGrid.layout(w, h)`——grid 递归分配空间到各 Part。

**为什么用代码而非 CSS**：精确尺寸控制（每个 Part 声明 `minimumWidth/Height`，grid 据此约束）；拖拽 resize（`resizePart()` 调 `workbenchGrid.resizeView()`）；隐藏/显示（`setPartHidden()` 调 `workbenchGrid.setViewVisible()`，grid 自动重分配）；Zen Mode（`toggleZenMode()` 批量隐藏并保存/恢复状态）；序列化/恢复（grid 支持 `toJSON()/deserialize()`，启动时从 storage 恢复上次布局）。CSS 无法表达 min/max 约束下的空间分配算法。

### Part 架构

`Part` 基类（`part.ts:34`）继承 `Component` 实现 `ISerializableView`，定义统一契约：`create(parent, options)` 调用子类 `createTitleArea`/`createContentArea`（模板方法模式）；`layout(width, height, top, left)` 接收 grid 分配的尺寸；`setVisible(visible)` 可见性切换；`minimumWidth/Height, maximumWidth/Height` grid 布局约束。构造时自动 `layoutService.registerPart(this)`（`part.ts:61`）。`renderWorkbench` 遍历 Parts 枚举为每个创建 DOM 容器并调 `create()`。所有 UI 区域继承同一基类，grid 统一管理尺寸/位置——这是「统一 UI 区域生命周期」的体现。`MultiWindowParts` 基类（`part.ts:292`）支持多窗口。

### Composite/View 模式

`Composite`（`composite.ts:34`）定义 create→setVisible→layout→focus→dispose 生命周期，每个 Composite 有独立 action toolbar（`getActions`/`getSecondaryActions`/`getContextMenuActions`）。`PaneComposite`（`panecomposite.ts:27`）扩展 Composite 内嵌 `ViewPaneContainer`，`createViewPaneContainer()` 是抽象方法让子类决定容器类型，生命周期委托给 viewPaneContainer。

Sidebar/Panel 容纳多视图靠 `AbstractPaneCompositePart`（`paneCompositePart.ts`）——SidebarPart/PanelPart/AuxiliaryBarPart 的共同基类，管理 CompositeBar（顶部标签切换）+ 当前活跃 Composite 显示，同时只显示一个 Composite。视图注册经 `IViewDescriptorService.registerViewContainer(descriptor, location)`（`views.ts:174`），`ViewContainerLocation` 三值（Sidebar/Panel/AuxiliaryBar），`PaneCompositeRegistry` 分三个注册表（`panecomposite.ts:229-231`）。**设计动机**：视图可被扩展注册（扩展经 `viewsExtensionPoint` 声明）、可拖拽、可隐藏/重排、统一 action toolbar 交互。

### 静态副作用 import 聚合

`workbench.common.main.ts` 是聚合入口，纯副作用 import：

```typescript title="src/vs/workbench/workbench.common.main.ts"
import './browser/parts/editor/editor.contribution.js';
import './browser/parts/statusbar/statusbarPart.js';   // 内部 registerSingleton()
import './contrib/files/browser/files.contribution.js';
import './contrib/search/browser/search.contribution.js';
// ... ~100 条 contrib import
```

每个 Part/Service/Contrib 文件内部调 `registerSingleton()` 或 `registerWorkbenchContribution2()`。main.ts 的 import 顺序即注册顺序，无运行时逻辑。Desktop 和 Web 各有 `workbench.desktop.main.ts`/`workbench.web.main.ts` 覆盖差异。**为什么静态 import 而非动态发现**：打包器 tree-shaking + 死代码消除；显式依赖让构建可预测；加载顺序由 import 保证。动态 `import()` 会引入异步边界和 chunk 分割，不适合启动关键路径。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Part 抽象 | `part.ts:34` | 统一 UI 区域生命周期，grid 统一管理尺寸/位置 |
| Composite 模式 | `composite.ts:34` `panecomposite.ts:27` | 容器容纳可插拔视图，动态注册/卸载 |
| 代码计算布局 vs CSS | `layout.ts:1670` SerializableGrid | 精确 min/max 约束、拖拽 resize、序列化恢复 |
| 静态副作用 import | `workbench.common.main.ts` | 显式依赖、可 tree-shake、加载顺序可控 |
| 模板方法 | `part.ts:78` create→createTitleArea/createContentArea | 基类定骨架，子类填内容 |

## 模块间交互

依赖方向：`workbench/browser → workbench/common → editor → platform → base`。`Layout` 实现 `IWorkbenchLayoutService`（`layoutService.ts:19`），通过 `refineServiceDecorator` 扩展 platform 层 `ILayoutService`。Part 通过构造注入 `IWorkbenchLayoutService`。Contrib 通过 `registerWorkbenchContribution2` 接入启动流程，`Registry.start(accessor)` 在 `startup()` 中触发（`workbench.ts:162`）。contrib 之间不直接 import，而通过 Commands/Events/ContextKeys/Services 松耦合通信。

## 扩展方式

**新增侧边栏视图**：`views.ts` 用 `registerViewContainer()` 注册到 `ViewContainerLocation.Sidebar` → `PaneCompositeDescriptor.create()` 注册到 `PaneCompositeRegistry` → 实现 `PaneComposite` 子类提供 `createViewPaneContainer()`。扩展通过 `viewsExtensionPoint` 声明即可注入，无需改 workbench 代码。

**新增状态栏条目**：`IStatusbarService.addEntry(entry, id, alignment, priority)`（`statusbarPart.ts:41`），`StatusbarViewModel` 按 priority/alignment 排列。

**调整布局分区**：改 `SidebarPart.minimumWidth`（`sidebarPart.ts:48`）或 `createGridDescriptor()` 的 `sideBarSize` 初始值（`layout.ts:2665`），grid 据 min/max 约束自动重分配。
