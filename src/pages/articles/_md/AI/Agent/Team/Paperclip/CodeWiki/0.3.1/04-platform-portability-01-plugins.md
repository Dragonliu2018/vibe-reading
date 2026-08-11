---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Plugin System"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 插件系统——out-of-process worker、capability-gated host service、UI contribution"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 平台扩展与可移植](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/04-platform-portability)

---

## 模块定位

本模块属于平台扩展与可移植子系统。Plugin System 让你无需 fork 即可扩展 Paperclip——out-of-process worker 隔离、capability-gated host service 最小权限、tool/job/UI/driver 多维贡献。`PluginLoader`/`PluginWorkerManager`/`PluginLifecycleManager` 是 graphify god nodes（34/29/27 边）。它独立存在，是因为"扩展一个系统"需要统一的进程隔离、权限模型与生命周期管理。

## 模块架构

四个核心组件：`PluginLoader`（`plugin-loader.ts:1068` 工厂）发现/安装/激活插件；`PluginWorkerManager`（`plugin-worker-manager.ts:1356` 工厂）fork 子进程并管理 JSON-RPC 通信；`PluginLifecycleManager`（`plugin-lifecycle.ts:304` 工厂）状态机管理（installed→ready→enabled）；`buildHostServices`（`plugin-host-services.ts:490`）返回全部 platform service adapter（config/state/entities/events/http/secrets/activity/metrics/companies/projects/issues/agents/managedAgents/routines/skills/localFolders/heartbeat）。

插件可贡献的能力：Agent Tool（manifest `tools[]`）、UI Contribution（`ui.slots[]`+`ui.launchers[]`）、Job Scheduling（`jobs[]`）、Managed Agents/Routines/Skills、Environment Driver（`environment.drivers[]`）、Webhook（`webhooks[]`）。

## 调用链路

插件从发现到运行的链（行号见 `plugin-loader.ts` 与 `app.ts`）：

```
app.ts:206  createPluginWorkerManager()
app.ts:257  pluginLifecycleManager(db, {workerManager})
app.ts:263  createPluginToolDispatcher / createPluginJobScheduler
app.ts:276  pluginLoader(db, {...}, {workerManager, eventBus, jobScheduler, ...})
app.ts:541  loader.loadAll()
  └─ plugin-loader.ts:1869 loadAll()
       └─ :2074 activatePlugin() per plugin:
            1. resolveWorkerEntrypoint()                    :2118
            2. pluginDatabaseService.applyMigrations()      :2127  DB migration
            3. buildHostHandlers(pluginId, manifest)        :2133
               └─ app.ts:295-310:
                    buildHostServices() → createHostClientHandlers({capabilities, services})
            4. workerManager.startWorker(pluginId, opts)     :2171
               └─ worker-manager.ts:730 fork(entrypointPath)  stdio+ipc child process
            5. jobStore.syncJobDeclarations + jobScheduler.registerPlugin  :2184-2185
            6. eventBus.forPlugin(pluginKey)                 :2208  scoped event handle
            7. toolDispatcher.registerPluginTools(...)       :2242
```

## 核心实现

### Out-of-process worker

`PluginWorkerManager`（`:730` `fork()`）每个插件一个子进程，stdio NDJSON JSON-RPC 通信。env 只传 `PATH/NODE_PATH/PAPERCLIP_PLUGIN_ID/NODE_ENV/TZ`，剥离 `DATABASE_URL` 等敏感变量（`:720-728`）。**为什么**：插件代码崩溃不影响主进程；进程级隔离防止插件访问 DB 凭证。crash recovery 用指数退避自动重启（`:844-848`）。

### Capability-gated host service

`host-client-factory.ts:354` `METHOD_CAPABILITY_MAP` 把每个 RPC method 映射到所需 capability，`requireCapability()`（`:597`）在 handler 执行前检查，缺 capability 抛 `CapabilityDeniedError`。`config.get`/`log` 无需 capability（`:356`/`:400`），`state.get` 需 `plugin.state.read`（`:368`），`http.fetch` 需 `http.outbound`（`:385`）。**为什么**：最小权限——插件 manifest 声明 capabilities，host handler 每次调用前检查。

### UI contribution

manifest `ui.slots[]` + `ui.launchers[]` → `PluginUiContributionMetadata`（`plugin-loader.ts:377-386`），host 从 `entrypoints.ui` 目录静态服务 bundle。**为什么**：插件声明 UI slot + 提供 bundle，扩展 UI 无需 fork 主仓库。

### npm install 安全

`fetchAndValidate`（`:1128`）用 `--ignore-scripts` 安装（`:1170-1177`）。**为什么**：阻止 preinstall/postinstall hook 在 manifest 验证前执行任意代码。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Out-of-process Worker | `fork()` (`worker-manager.ts:730`) | 进程隔离 |
| Registry | `Map<pluginId, PluginWorkerHandle>` (`:1360`) | worker 注册表 |
| Capability Gate | `METHOD_CAPABILITY_MAP` (`host-client-factory.ts:354`) | 最小权限 |
| Dispatcher | `plugin-tool-dispatcher.ts:228` | agent tool 发现 + RPC 分发 |
| 状态机 | `assertTransition()` (`plugin-lifecycle.ts:339`) | 插件状态转换强制合法 |
| Event Bus | `eventBus.forPlugin(pluginKey)` | per-plugin scoped subscription |

## 模块间交互

启动装配在 `app.ts:206-312`：`createPluginWorkerManager` → `pluginLifecycleManager(db, {workerManager})` → `createPluginJobScheduler`/`createPluginToolDispatcher` → `pluginLoader(db, opts, runtimeServices)`，其中 `buildHostHandlers` 回调闭包引用 `workerManager` 和 `buildHostServices`。插件可经 host service 调用 `managedAgentService`/`routineService`/`skillService`（`buildHostServices:504/523/529`）管理 agent/routine/skill 生命周期。

## 扩展方式

**新增 host capability（如 `notifications.send`）**：`packages/plugins/sdk/src/host-client-factory.ts` 的 `METHOD_CAPABILITY_MAP`（`:354`）加映射；`plugin-capability-validator.ts` 的 `OPERATION_CAPABILITIES`（`:36`）和 `FEATURE_CAPABILITY_MAP`（`:184`）加项；`plugin-host-services.ts` 的 `buildHostServices()`（`:490`）加 service adapter；SDK `types.ts` 的 `WorkerToHostMethods` 加方法签名。

**新增插件工具类型**：SDK `types.ts` manifest schema 加 tool type；`plugin-tool-registry.ts` 注册逻辑支持新 type；`plugin-tool-dispatcher.ts` 的 `toAgentDescriptor()`（`:395`）映射新 type 到 agent descriptor；无需改 loader——`registerPluginTools()`（`:435`）已通用读 manifest `tools[]`。
