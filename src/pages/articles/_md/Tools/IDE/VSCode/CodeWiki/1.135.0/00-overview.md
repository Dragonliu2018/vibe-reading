---
source:
  type: "源码解读"
  project: "vscode"
  url: "https://github.com/microsoft/vscode"
title: "Overview"
date: "2026-08-18T15:19:54+08:00"
category: [Tools, IDE, VSCode, CodeWiki, "1.135.0"]
tags: ["vscode", "TypeScript", "Electron", "code editor", "Monaco", "Extension", "Agent"]
description: "VS Code 1.135 源码架构解读——Electron 多进程、DI 服务脊柱、Monaco 编辑器、扩展系统与 AI Agent"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 1.135.0 · **协议** MIT · **语言** TypeScript (Node 24.18) · **框架** Electron · **代码量** ~2,630,000 行 (8,329 个 .ts 文件) · **仓库** [GitHub](https://github.com/microsoft/vscode)

---

## 总览

### 项目简介

Visual Studio Code（仓库代号 `Code - OSS`）是 Microsoft 用 TypeScript + Electron 开发的开源代码编辑器。它把「代码编辑器」的轻快与「IDE」的功能性合在一起——以 Monaco 文本编辑器内核为底座，靠一套自研的**依赖注入服务架构**和**贡献（Contribution）注册机制**把 99 个内置功能特性与数万个第三方扩展插进同一个工作台 shell 里，再通过多进程 Extension Host 隔离扩展执行。

VS Code 解决的核心问题是：**编辑器要在「功能极其丰富」的同时保持「响应快、崩溃不连累主界面」**。它用三层手段对付这个矛盾——Electron 多进程把扩展、终端、共享后台服务隔离到独立进程；`createDecorator` + `SyncDescriptor` 的 DI 容器让海量服务按需实例化、不阻塞启动；`WorkbenchPhase` / `EditorContributionInstantiation` 把功能初始化拆成若干生命周期阶段，关键路径同步阻塞、非关键路径用 `runWhenGlobalIdle` 在空闲时分片加载。

1.135.0 版本的一个显著变化是 **AI Agent 成为主线**：`src/vs/platform/agentHost`（约 33 万行）和新的 `src/vs/sessions`（约 20.6 万行，"Agents Window"）成为工作台之上独立的新顶层——VS Code 不再只是编辑器，而是承载自治编码 agent 的运行时。**项目边界**：`Code - OSS` 是编辑器内核与平台，Microsoft 产品级 VS Code 在此之上叠加闭源定制（品牌、遥测、市场）发布；本系列解读的是 OSS 内核。

### 功能矩阵

| 特性 | 实现目录 | 说明 |
|------|----------|------|
| 工作台 shell | `src/vs/workbench/browser/` | 布局、Parts（标题栏/活动栏/侧边栏/面板/编辑器/状态栏）、Composite |
| Monaco 编辑器 | `src/vs/editor/` | 文本模型、视图、命令、编辑器贡献，可独立复用 |
| 平台服务层 | `src/vs/platform/` | 配置/命令/上下文键/键绑定/存储/文件/IPC 等跨进程服务 |
| 依赖注入 | `src/vs/platform/instantiation/` | `createDecorator` + `InstantiationService` + `SyncDescriptor` |
| 内置功能 | `src/vs/workbench/contrib/` | 99 个 contrib 特性（chat/debug/files/search/notebook/terminal…） |
| 扩展系统 | `src/vs/workbench/services/extensions/` + `src/vs/workbench/api/` | Extension Host、RPC 协议、扩展 API |
| AI Agent | `src/vs/platform/agentHost/` + `src/vs/sessions/` + `src/vs/platform/chat/` + `src/vs/platform/mcp/` | Agent Host、Agents Window 会话模型、MCP 客户端 |
| 进程模型 | `src/main.ts` + `src/vs/code/electron-main/` + `src/vs/platform/lifecycle/` | Electron 多进程、生命周期阶段 |
| 远程开发 | `src/vs/server/` + `src/vs/platform/remote/` + `src/vs/platform/remoteTunnel/` | SSH/WSL/Container 远程 + 隧道 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| **Electron** | 核心 | 主进程 + 渲染进程 + Utility Process，跨平台桌面壳 |
| **TypeScript** | 核心 | 全量 TS，`tsconfig` 分层（base/monaco/tsec/vscode-dts） |
| **Monaco Editor** | 核心（自研） | 文本编辑内核，也独立发布为 `monaco-editor` npm 包 |
| **esbuild / rollup** | 工具 | 模块打包，`gulpfile.mjs` + `build/` 编排 |
| **ESLint** | 工具 | 含自研 `local/code-import-patterns` 规则强制分层边界 |
| **Playwright / `@vscode/test-electron`** | 工具 | `.vscode-test.js` 端到端测试驱动 |
| **xterm.js** | 可选 | 集成终端渲染（`contrib/terminal`） |
| **Electron Utility Process** | 核心 | Shared Process / Extension Host / Pty Host 隔离执行 |

### 版本历史

VS Code 每月一个迭代版本。1.135.0 处于 `1.133.0` tag 之后的开发主干上（`git describe` 返回 `1.133.0`）。本版本的关键演进是 **Agents Window（`vs/sessions`）作为 `vs/workbench` 之上的新顶层被正式确立**——`LAYERS.md` 用 ESLint 规则固化了 `base → platform → editor → workbench → sessions` 的五层单向依赖，`workbench` 不允许反向 import `sessions`。这标志着 VS Code 从「编辑器 + 扩展」向「编辑器 + 扩展 + 自治 agent 运行时」的架构跃迁。

### 顶层上下文图

VS Code 的外部交互方包括：开发者用户、远程主机（SSH/WSL/Container）、扩展市场（Marketplace）、语言服务器（LSP）/调试适配器（DAP）（经扩展宿主）、MCP server（agent 工具源）、BYOK 模型提供商（用户自带密钥的 LLM API）。内核通过 Extension Host 暴露 `vscode.d.ts` API 给第三方扩展，通过 MCP/agentHost 接入 agent 工具链。

---

## 快速上手

```bash title="构建与运行 (Code - OSS)"
# 前置：Node 24.18（见 .nvmrc）、Yarn、git
git clone https://github.com/microsoft/vscode
cd vscode
yarn install                # 安装依赖 + 构建 built-in 扩展
yarn compile                # 编译 TS → out/
./scripts/code.sh           # Linux/macOS 启动 Code - OSS（Windows 用 scripts\code.bat）
# 或指定平台：
./scripts/code-linux.sh     # Linux
./scripts/code-macos.sh     # macOS
```

验证：启动后打开任意源码文件，`Ctrl/Cmd+Shift+P` 打开命令面板执行命令；`Ctrl/Cmd+Shift+I` 打开 DevTools 确认渲染进程运行。开发调试用 `.vscode/launch.json` 的 "Launch VS Code" 配置。

> 以下为内部调用链，留给「运行时行为」章展开。

---

## 架构设计解析

### 系统架构

VS Code 的架构思想可以概括为一句话：**用分层 + DI + 贡献注册把一个超大代码库组织成可独立演进的积木**。它的分层不是装饰性的——每一层有明确的依赖方向约束（`base → platform → editor → workbench → sessions`，ESLint 强制），上层可以 import 下层，下层绝不反向依赖上层。在这个分层之上，所有「能力」都抽象成**服务**（`createDecorator` 声明标识符，`registerSingleton` 注册实现，DI 容器按需注入），所有「功能」都抽象成**贡献**（`registerWorkbenchContribution2` / `registerEditorContribution` 注册，按生命周期阶段实例化）。这意味着新增一个内置功能和一个第三方扩展走的是几乎相同的机制——内置功能只是「编译期注册的扩展」。

![VS Code 架构分层](/vibe-reading/images/articles/vscode-codewiki/architecture.svg)

六层从下到上，依赖方向严格单向（上层依赖下层）：

1. **Base 层**（`vs/base`）：基础工具库——`common`（Event/Emitter、Disposable、URI、async、LinkedList、错误处理）、`browser`（DOM 工具）、`node`（文件/进程）、`parts`（ipc、sandbox、contextmenu 等可复用部件）。一切的地基，不依赖 VS Code 其他层。
2. **Platform 层**（`vs/platform`）：跨进程复用的服务脊柱——`instantiation`（DI 容器）、`registry`（全局注册表）、`configuration`/`commands`/`contextkey`/`keybinding`/`storage`/`files`/`actions` 等核心服务，以及 `agentHost`/`chat`/`mcp` 等 AI 相关平台服务。每个服务声明接口 + `createDecorator` 标识符，实现按进程分目录（`common`/`node`/`browser`/`electron-main`）。
3. **Editor 层**（`vs/editor`）：Monaco 编辑器内核——Model/ViewModel/View 三层分离，`pieceTreeTextBuffer` 文本存储，编辑器贡献注册机制。可脱离 workbench 独立使用（`standalone`）。
4. **Workbench 层**（`vs/workbench`）：工作台 shell——`browser/layout.ts` 代码计算布局、Parts 抽象、Composite/View 容器、99 个 `contrib/*` 内置功能、`services` 工作台服务、`api` 扩展 API 宿主侧。是代码量最大的一层（143 万行）。
5. **Sessions 层**（`vs/sessions`）：Agents Window——工作台之上的新顶层，会话/chat 模型、provider 契约、独立布局，承载自治 agent 运行时。
6. **Entry Points**：`bootstrap-*.ts`（进程引导）、`main.ts`（Electron 主进程入口）、`cli.ts`/`server-cli.ts`（CLI/远程）、`code/`（各进程 main）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|------------------------|
| Entry Points | `bootstrap-*.ts` `main.ts` `cli.ts` `code/` | 进程引导与入口，安装 ESM loader、沙箱、CLI 解析，装配服务后启动各进程 |
| Sessions 层 | `vs/sessions/` | Agents Window——解耦 agent 工作流与标准编辑器工作流，支持移动端，独立布局与生命周期 |
| Workbench 层 | `vs/workbench/browser/` `contrib/` `services/` `api/` | 工作台 shell 与内置功能——编排 UI、视图、编辑器，承载贡献与扩展宿主 |
| Editor 层 | `vs/editor/` | Monaco 编辑器内核——文本编辑体验，模型/视图分离，可独立复用 |
| Platform 层 | `vs/platform/` | 跨进程服务脊柱——DI、注册表、配置/命令/存储/文件/IPC，上下文键表达式 |
| Base 层 | `vs/base/` | 基础工具库——事件、生命周期、URI、异步、IPC 部件，一切的地基 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| **DI + 服务标识符** | `instantiation.ts` `createDecorator` `InstantiationService` | 海量服务（数百个）解耦声明与实现，按需实例化避免启动全量构造；`SyncDescriptor` + Proxy 实现延迟实例化 |
| **全局 Registry** | `platform/registry/common/platform.ts` `Registry.add/as` | 非服务型声明性数据（配置 schema、视图声明、编辑器工厂）的编译期静态注册，跨进程复用，不依赖 DI 容器启动 |
| **贡献标记接口** | `contributions.ts` `IWorkbenchContribution` `registerWorkbenchContribution2` | 内置功能插件化接入——构造函数副作用即逻辑，与第三方扩展 `activate()` 机制统一 |
| **阶段化实例化** | `WorkbenchPhase` / `EditorContributionInstantiation` + `runWhenGlobalIdle` | 启动性能分级——关键路径同步阻塞、非关键路径空闲分片，超阈值自动 warn |
| **IPC Channel 代理** | `base/parts/ipc/common/ipc.ts` `ProxyChannel.fromService/toService` | 服务跨进程透明暴露——反射 + ES6 Proxy 自动代理方法/事件，消费方无感知 |
| **RPC 协议配对** | `workbench/api/common/extHost.protocol.ts` `MainContext`/`ExtHostContext` | Extension Host↔主进程类型安全通信——`$` 前缀约定 + Shape 接口配对，编译期校验 |
| **Model/View 分离** | `editor/common/model.ts` `textModel.ts` + `viewModel.ts` | 一模型多视图、视图重建不影响数据、虚拟化长行——文本数据与渲染解耦 |
| **多宿主隔离** | `extensionHostKind.ts` `ExtensionHostKind` | 扩展崩溃只影响所在宿主进程不连累 UI；远程扩展直接访问远程资源 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `InstantiationService` | DI 容器 | 进程级（主/渲染/扩展宿主各一份） | 持有 `ServiceCollection`，创建所有服务实例 |
| `ServiceCollection` | 服务注册表 | 容器级 | `Map<ServiceIdentifier, instance \| SyncDescriptor>` |
| `ITextModel` | Monaco 文本模型 | 文档级（同 URI 单例） | 持有 `PieceTreeTextBuffer`，被多个 `IViewModel` 挂载 |
| `Workbench` | 工作台实例 | 窗口级 | 继承 `Layout`，编排 Parts 与服务 |
| `Part` | UI 区域基类 | 工作台级 | 由 `SerializableGrid` 管理位置尺寸 |
| `IExtensionDescription` | 扩展描述符 | 安装级 | manifest + 运行时元信息，分配到某 `ExtensionHostKind` |
| `ExtensionHostManager` | 扩展宿主管理器 | 宿主进程级 | 封装 `RPCProtocol`，管理激活与 MainThread 顾客 |
| `ISession` / `IChat` | agent 会话/对话 | 会话级 | provider 中立 facade，`IObservable` 暴露状态 |
| `Agent` | 自治 agent 后端 | 会话级 | 发射 `AgentSignal` 流式信号，操作 changeset/checkpoint |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|-------------|----------|--------|----------|
| `ServiceIdentifier<T>` | `instantiation.ts` | （类型标识，非实现） | `createDecorator<T>('id')` |
| `IInstantiationService` | `instantiation.ts` | `InstantiationService` | `registerSingleton` / 手动 `new` |
| `IWorkbenchContribution` | `contributions.ts` | 各 contrib class | `registerWorkbenchContribution2(id, ctor, phase)` |
| `IEditorContribution` | `editorCommon.ts` | 各编辑器贡献 class | `registerEditorContribution(id, ctor, instantiation)` |
| `ISessionsProvider` | `sessions/services/sessions/common/sessionsProvider.ts` | `copilotChatSessions`/`agentHost`/`remoteAgentHost` | 从 `sessions.*.main.ts` 注册 |
| `IAgent` | `platform/agentHost/common/agent.ts` | 各 agent backend（Claude/Codex） | provider 内实现 |
| `IChannel` | `base/parts/ipc/common/ipc.ts` | `ProxyChannel` 包装的服务 | `channelServer.registerChannel(name, channel)` |

---

## 代码目录

```text
vscode/
├── src/
│   ├── main.ts                  # Electron 主进程入口
│   ├── bootstrap-*.ts           # 进程引导（node/esm/cli/fork/server/meta）
│   ├── cli.ts / server-cli.ts   # CLI / 远程 server 入口
│   ├── vs/
│   │   ├── base/                # 基础工具库（common/browser/node/parts）
│   │   ├── platform/            # 平台服务层（94 个服务子目录）
│   │   ├── editor/              # Monaco 编辑器内核
│   │   ├── workbench/           # 工作台（browser/common/contrib/services/api）
│   │   ├── sessions/            # Agents Window（workbench 之上的新顶层）
│   │   ├── server/              # 远程 server
│   │   └── code/                # 各进程 main（electron-main/electron-sandbox/node/browser）
│   └── typings/                 # 类型声明
├── extensions/                  # 106 个内置扩展（语法/语言特性/调试器）
├── build/                       # 构建脚本（gulp/esbuild/编译产物配置）
├── remote/                      # 远程 server 资源
├── resources/                   # 平台资源（图标/ plist / 安装脚本）
├── scripts/                     # code.sh / 平台启动脚本
├── cli/                         # 远程 CLI（Rust，tunnel）
├── test/                        # 顶层测试
├── package.json                 # code-oss-dev，1.135.0
└── product.json                 # 产品配置（名称/AppId/builtInExtensions）
```

一级目录职责：`src/vs/base` 是无依赖地基；`platform` 是服务脊柱（按服务名分子目录，每个服务有 `common`/`node`/`browser`/`electron-main` 进程分层）；`editor` 自成体系可独立发布；`workbench` 是代码量最大的应用层，`contrib/` 下 99 个目录每个是一个内置功能；`sessions` 是 1.135 新增的 agent 顶层。特殊目录：`extensions/` 是内置扩展（语法高亮、语言特性，非内核代码）；`cli/` 是 Rust 写的远程隧道 CLI，独立于 TS 代码库。

---

## 模块地图

VS Code 的职责分化自然形成 8 个核心模块。模块间依赖严格遵循分层方向——Sessions/Workbench 依赖 Platform 与 Editor，Platform 依赖 DI 与 Base，反向绝不成立。

![VS Code 模块依赖关系](/vibe-reading/images/articles/vscode-codewiki/module-dependencies.svg)

依赖方向：上层依赖下层，卫星模块（Contrib/Extensions）插接 Workbench，进程入口（进程模型与生命周期）装配服务后实例化 Workbench。`AI Agent 系统`横跨 Sessions 层与 Platform 层（`agentHost`/`chat`/`mcp` 在 Platform，会话模型在 Sessions）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| 进程模型与生命周期 | Electron 多进程、引导、生命周期阶段 | `main.ts` `CodeApplication.startup()` | 进程隔离与启动编排是编辑器可靠性的根基，独立于业务功能 | [01-process-lifecycle](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/01-process-lifecycle) |
| 依赖注入与服务注册 | DI 容器、服务标识符、延迟实例化 | `createDecorator` `InstantiationService` | 是所有服务解耦的地基，被几乎全部模块 import，必须独立成层 | [02-instantiation-di](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/02-instantiation-di) |
| 平台服务层 | 配置/命令/上下文键/存储/文件/IPC 等跨进程服务 | `IConfigurationService` `ICommandService` `IContextKeyService` | 跨进程复用的服务脊柱，定义所有扩展点契约 | [03-platform-services](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/03-platform-services) |
| Monaco 编辑器 | 文本模型/视图/命令/贡献 | `ITextModel` `ICodeEditor` | 可脱离 workbench 独立复用，文本编辑核心自成体系 | [04-monaco-editor](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/04-monaco-editor) |
| Workbench 工作台 | 布局/Parts/Composite/视图容器 | `Workbench.startup()` `Layout` | 工作台 shell 是所有 UI 编排中心，代码量最大 | [05-workbench](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/05-workbench) |
| 扩展系统 | Extension Host、RPC 协议、扩展激活 | `AbstractExtensionService` `ExtensionHostManager` | 扩展在独立进程执行，崩溃隔离 + 远程支持，与内核解耦 | [06-extension-system](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/06-extension-system) |
| Contrib 贡献系统 | 内置功能插件化注册、阶段化实例化 | `registerWorkbenchContribution2` `registerEditorContribution` | 99 个内置功能与第三方扩展共用同一注册机制 | [07-contribution-system](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/07-contribution-system) |
| AI Agent 系统 | Agent Host、会话模型、MCP、BYOK | `IAgent` `ISessionsProvider` `ISession` | 1.135 的新顶层，agent 工作流独立于标准编辑器工作流 | [08-ai-agent](/vibe-reading/articles/Tools/IDE/VSCode/CodeWiki/1.135.0/08-ai-agent) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

VS Code 桌面启动是一条跨三进程（Main / Shared / Renderer）的装配链：主进程引导 → 装配服务集合 → 单实例锁 → 暴露 IPC Channel → 打开 BrowserWindow → preload 桥接配置 → 渲染进程装配服务 → Workbench 启动 → 按阶段实例化贡献 → 渲染 Parts → 恢复状态。全程大量 `Promise.all` 并行（缓存目录与 NLS、状态与配置、machineId 解析、服务初始化与 DOM 就绪），非关键初始化延迟到 `LifecyclePhase.Eventually`。

![VS Code 启动数据流](/vibe-reading/images/articles/vscode-codewiki/data-flow.svg)

关键装配点：`CodeMain.createServices()` 构建主进程首个 `ServiceCollection`（eager 实例 + `SyncDescriptor` 延迟）；`CodeApplication.initChannels()` 用 `ProxyChannel.fromService()` 把每个主进程服务暴露为 IPC Channel；`DesktopMain.initServices()` 在渲染进程用 `ProxyChannel.toService(channelClient.getChannel('xxx'))` 重建透明代理；`Workbench.initServices()` 调 `getSingletonServiceDescriptors()` 批量注入所有 `registerSingleton()` 注册的服务。`SharedProcess` 与主窗口并行启动，但延迟到首个窗口请求连接才 `utilityProcess.fork()`。`restore()` 用 `Promise.race([whenRestored, timeout(2000)])` 防止慢编辑器阻塞贡献点。

### 核心运行流程

下面选 4 条最典型的运行时链路，覆盖编辑、命令、扩展、agent 四种核心场景。

#### 编辑链路：打开文件到像素渲染

业务流程：用户在 Explorer 双击文件 → workbench 解析模型 → 编辑器渲染 → 用户编辑 → 模型通知视图。

`ITextModelService.createModelReference(resource)` 异步解析文件 URI → `IFileService.readFile()` 读盘（经 IPC 代理到主进程的 `DiskFileSystemProvider`）→ `IModelService.createModel()` 创建 `TextModel`（内部 `PieceTreeTextBuffer`）→ `EditorPart` 打开 `CodeEditorWidget` → `ICodeEditor.setModel(model)` → ViewModel 挂载到 model 的 `_viewModels` Set → View 渲染 viewport 内行。用户编辑时 `model.applyEdits(ops)` → `_buffer.applyEdits()` 调整 PieceTree 红黑树 → `_onDidChangeContentOrInjectedText()` 同步通知所有 ViewModel → ViewModel `emitContentChangeEvent` 异步刷新 View。数据结构变化：`URI → ITextBufferFactory → ITextModel(PieceTree) → ViewModel 坐标变换 → View DOM`。

#### 命令链路：按键到命令执行

业务流程：用户按键 → keybinding 解析 → 命令查找 → precondition 上下文求值 → 执行命令 → 服务副作用。

`KeybindingsRegistry` 解析按键 → `IContextKeyService.contextMatchesRules(when)` 在当前 DOM 焦点层级求值上下文键表达式 → `ICommandService.executeCommand(id, args)` → `CommandsRegistry` 查找 handler → `invokeFunction(accessor => ...)` 通过 `ServicesAccessor.get(IService)` 按需获取服务 → 执行。`Action2` 一步注册 command + menu + keybinding（`registerAction2`），`when` 自动叠加 precondition。`ServicesAccessor` 是 DI 入口，命令注册时不持有服务引用，避免循环依赖。

#### 扩展链路：activationEvent 到扩展激活

业务流程：某事件（打开 .py 文件 / 执行命令）触发 activationEvent → 扩展宿主激活 → RPC 调用 ExtHost → 扩展 `activate()` → 注册贡献。

`AbstractExtensionService.activateByEvent(event)` 检查 `_registry.containsActivationEvent` → 分发到所有 `ExtensionHostManager.activateByEvent()` → 经 `RPCProtocol` 调 ExtHost `proxy.activateByEvent()` → ExtHost 加载扩展模块、调 `activate(context)` → 扩展通过 `vscode.*` API 注册命令/视图/语言特性 → MainThread 顾客（如 `MainThreadCommands.$registerCommand`）经反向 RPC 注册到主进程。`extensionKind`（`ui`/`workspace`/`web`）决定扩展分配到 `LocalProcess`/`LocalWebWorker`/`Remote` 哪个宿主。`ImplicitActivationEvents` 从 contribution points 自动推断激活事件。

#### Agent 链路：用户消息到 changeset

业务流程：用户提交消息 → sessions 路由到 provider → agent 执行（plan/act/observe）→ 流式信号 → 文件修改 changeset → checkpoint → UI 更新。

`ISessionsManagementService.sendRequest(session, chat, options)` 路由到 `session.providerId` 对应的 `ISessionsProvider.sendRequest()` → provider 调 `IAgent` 执行 → agent 发射 `AgentSignal`（`action`/`pending_confirmation`/`subagent_*`）经 `onDidChatProgress` → host state manager 分发 → `SessionPermissionManager.getAutoApproval` 决定是否需用户确认 → agent 修改文件 → `IAgentHostChangesetService` 计算 `<session>/changeset/{uncommitted,session,turn/<id>}` diff → `IAgentHostCheckpointService.captureTurnCheckpoint` 用 git `commit-tree` 在 `refs/agents/<sid>/checkpoints/turn/<N>` 建快照 → 会话 observable 更新 → `ISessionsService` 跟随 committed session 切换视图。数据结构：`用户消息 → ChatRequest → AgentSignal 流 → Changeset diff → Checkpoint git ref → UI observable`。

### 状态流

VS Code 运行时有两套关键状态机：**生命周期阶段**和**会话状态**。

生命周期阶段（`LifecyclePhase` 渲染进程 / `LifecycleMainPhase` 主进程）控制服务与贡献的初始化时机，阶段只能前进：

```
Starting(1) ──┬─ 同步阻塞实例化（BlockStartup 贡献）
              ▼
   Ready(2) ──┬─ 同步阻塞（BlockRestore 贡献）
              ▼
 Restored(3) ─┬─ runWhenGlobalIdle（AfterRestored 贡献）  ← restore() Promise.race(2s) 触发
              ▼
Eventually(4) ── runWhenGlobalIdle + 2.5s（非关键初始化）
```

会话状态（`SessionStatus`，`src/vs/sessions/services/sessions/common/session.ts`）描述 agent 会话生命周期：

```
Untitled ──▶ InProgress ──┬──▶ Completed
              │           │
              ▼           ▼
         NeedsInput ──▶ InProgress（用户确认后继续）
              │
              ▼
            Error
```

`ChatInteractivity`（`Full`/`ReadOnly`/`Hidden`）支持 agent-team 模式——lead chat 交互式，worker chat 只读/隐藏。

---

## 典型修改场景

#### 场景 1：新增一个内置功能特性

在 `src/vs/workbench/contrib/myFeature/` 下新建目录，编写 `browser/myFeature.contribution.ts`：定义 `class MyFeatureContribution implements IWorkbenchContribution`（构造函数注入服务、副作用即逻辑），调 `registerWorkbenchContribution2(MyFeatureContribution.ID, MyFeatureContribution, WorkbenchPhase.AfterRestored)`，按需 `registerAction2`/`registerViewContainer`/`configurationRegistry.registerConfiguration`。在 `workbench.common.main.ts` 加 `import './contrib/myFeature/browser/myFeature.contribution.js';`。对应测试：`contrib/myFeature/test/`。

#### 场景 2：新增一个扩展 API 方法（协议两端）

`extHost.protocol.ts` 在 `MainThreadXxxShape` 加 `$newMethod(...)` → `mainThreadXxx.ts` 实现该方法（注入主进程服务）→ ExtHost 侧 `extHostXxx.ts` 调 `getProxy(MainContext.MainThreadXxx).$newMethod(...)` → `vscode.d.ts` 公开 API 声明。对应测试：`src/vs/workbench/api/test/`。

#### 场景 3：新增一个 session provider

实现 `ISessionsProvider`（`contrib/providers/<name>/browser/`），适配后端状态到 `ISession`/`IChat` facade，从 `sessions.*.main.ts` 注册。参考 `SESSIONS.md` "Adding or changing a provider" 7 步清单。对应测试：`src/vs/sessions/test/`。

---

## 测试体系

```text
src/vs/<layer>/<module>/test/      # 各模块自带 test 子目录
test/                              # 顶层集成/e2e 测试
.vscode-test.js                    # @vscode/test-electron 驱动配置
```

| 代码层 | 测试类型 | 说明 |
|--------|----------|------|
| `base/` `platform/` | Unit Test | 纯逻辑单元（DI 图、配置合并、上下文键求值） |
| `editor/` | Unit + Snapshot | 编辑器行为、模型编辑、命令 |
| `workbench/contrib/` | Integration Test | 功能特性集成，常配合 `@vscode/test-electron` |
| 跨进程 / 扩展宿主 | E2E Test | `test/` 顶层，启动真实 Code - OSS 验证 |

VS Code 测试与代码同目录（`<module>/test/`），理解某模块时优先读其 `test/`——很多测试是可执行的规格说明。修改某层代码时按上表找对应测试类型优先阅读。

---

## 阅读源码推荐路线

- 第一遍：理解启动主流程
  `src/main.ts`（主进程入口）→ `src/vs/code/electron-main/main.ts` 的 `CodeMain.startup()` → `src/vs/code/electron-main/app.ts` 的 `CodeApplication.startup()` → `src/vs/workbench/browser/workbench.ts` 的 `Workbench.startup()` → `src/vs/workbench/browser/layout.ts` 的布局
- 第二遍：理解服务架构根基
  `src/vs/platform/instantiation/common/instantiation.ts` 的 `createDecorator` → `instantiationService.ts` 的 `_createInstance`/`_createAndCacheServiceInstance` → `src/vs/platform/registry/common/platform.ts` 的 `Registry` → `src/vs/workbench/common/contributions.ts` 的 `WorkbenchContributionsRegistry`
- 第三遍：理解编辑器与工作台
  `src/vs/editor/common/model.ts` 的 `ITextModel` → `src/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeBase.ts` → `src/vs/editor/browser/editorExtensions.ts` 的贡献注册 → `src/vs/workbench/browser/part.ts` 的 `Part` 基类 → `src/vs/workbench/browser/layout.ts` 的 `SerializableGrid`
- 第四遍：理解扩展与 agent（1.135 重点）
  `src/vs/workbench/services/extensions/common/abstractExtensionService.ts` → `src/vs/workbench/api/common/extHost.protocol.ts`（协议配对）→ `src/vs/sessions/SESSIONS.md` + `LAYERS.md`（设计文档）→ `src/vs/platform/agentHost/common/agent.ts` 的 `IAgent` → `src/vs/sessions/services/sessions/common/sessionsProvider.ts` 的 provider 契约

每遍标注的是文件级入口，读到哪里再按调用链深入。模块文档（01-08）提供更细的类与方法级解读。

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| Code - OSS | 仓库代号，OSS 内核（区别于产品级 VS Code） |
| Part | 工作台 UI 区域基类（标题栏/活动栏/侧边栏/面板/编辑器/状态栏） |
| Composite | 可插拔容器基类，Sidebar/Panel 内的视图容器 |
| Contribution | 贡献——内置功能或扩展注册的能力单元 |
| Extension Host | 扩展宿主进程，隔离执行扩展代码 |
| Agent Host | 自治编码 agent 后端（1.135） |
| Agents Window | `vs/sessions` 层，agent 会话的顶层窗口 |
| BYOK | Bring Your Own Key，用户自带模型密钥 |
| Changeset / Checkpoint | agent 文件修改分组 / per-turn git 快照 |
| activationEvent | 触发扩展激活的事件声明 |
| ServiceIdentifier | DI 服务标识符，`createDecorator` 产物 |

### 参考资料

- [VS Code 仓库](https://github.com/microsoft/vscode) · [How to Contribute wiki](https://github.com/microsoft/vscode/wiki/How-to-Contribute) · [Coding Guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines)
- 源码内设计文档：`src/vs/sessions/README.md`（Agents Window 索引）、`LAYERS.md`（分层规则）、`SESSIONS.md`（会话模型）、`AI_CUSTOMIZATIONS.md`（agent 定制）
- [Electron 文档](https://www.electronjs.org/docs)（Utility Process / MessagePort / contextBridge）

### 工具推荐

- **DevTools**：`Ctrl/Cmd+Shift+I` 打开渲染进程 DevTools，调试 workbench
- **`--inspect-extensions`**：调试扩展宿主进程
- **Performance Mark**：`src/vs/base/common/performance.ts` 的 `mark()`，启动全程埋点，DevTools Performance 面板可看
- **ESLint `local/code-import-patterns`**：静态校验分层边界，改代码前看 `.eslint-plugin-local/`
