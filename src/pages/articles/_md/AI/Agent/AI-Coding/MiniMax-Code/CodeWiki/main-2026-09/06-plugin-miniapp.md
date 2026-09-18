---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "插件系统与 MiniApp"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "插件系统", "MiniApp", "MCP", "Hook"]
description: "plugin-system + miniapp 解读——三来源统一为 ReadPluginPackage（兼容 MINIMAX/CLAUDE/CODEX manifest）、PluginSnapshot deep-frozen 快照经 turn 门闩原子发布、MiniApp 世代/租约子进程管理、plugin-hooks 子进程执行与 Symbol side-channel 供应商兼容"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

`service/plugin-system/`（~1.84 万行）+ `service/miniapp/`（~6.7k）+ `agent-modules/plugin-hooks/` 构成 mcode 的外部扩展生态：官方 marketplace、GitHub 导入、本地目录三种来源的插件，以及插件包可以携带的 Node 子进程（MiniApp）。它独立成模块的理由是**原子性**——插件能力（skill/MCP/hook/工具）必须相对执行中的 turn 原子生效，不能出现"半个插件"状态；这要求快照 + 发布事务 + 世代租约一整套机制，与 turn 执行系统深度咬合但职责正交。

## 模块架构

![插件发布链路](/vibe-reading/images/articles/minimax-code/plugin-flow.svg)

`PluginSystem`（plugin-system.ts:108，实现 `AgentHostTurnCapabilityProvider`）是门面：`prepareTurnCapabilities`/`captureTurnCapabilities`/`retain|releaseTurnCapabilities`（:275-292）三个方法把它接进 turn 的能力预留生命周期。`plugin/package/` 是读取层（package-readers 并发 4 扫描、hook/reader.ts 解析 manifest）；`plugin/runtime/` 是快照与发布（`PluginSnapshotBuilder` + `PluginMiniAppPublicationController`）；`miniapp/supervisor/` 是子进程管理（`DefaultMiniAppSupervisor`，degree 57 的主因是 8 张状态集合 + 全部 transition 方法）。hook 执行体在 `agent-modules/plugin-hooks/`：`PluginHookCoordinator`（会话级激活 + 30min idle SessionEnd）与 `PluginHookRunner`（spawn 子进程）。

## 调用链路

安装到生效（以 `importGithubPlugin` 为例，plugin-system.ts:515）：

```
发现：scanLocalPluginPackages(dataDir/plugins)（并发 4）│ official-reconciler 同步
     │ github-plugin-importer.prepare() 暂存
读取统一化：readImportedPluginPackage → ReadPluginPackage（package/types.ts:115）
     （探测 MiniMax manifest，兼容 MINIMAX / CLAUDE / CODEX 三种 sourceFormat）
快照：readPluginSnapshotInputs → PluginSnapshotBuilder.build()
     → PluginSnapshot{revision, officialPackages, localPlugins, skills, mcpServers, hooks, turnCapabilities}
     （MCP server 名经 McpNameRegistry.assignServers 命名空间分配与冲突诊断）
发布：prepareSnapshotPublication → queuePublication → attemptPublication
     → publicationPort.tryPublish（turn 系统门闩，:247 attach）
     → publishPending：mcpRuntime.reconcile(snapshot.mcpServers) 启停 MCP 子进程
     → adoptPublishedSnapshot 换新 revision
注入 turn：local-agent-host.ts createExecutionInput
     → resolvePluginHooksForTurn(sessionId, capabilities.hooks)（快照式取用，turn 中途不重读）
     → turnCapabilities.runtimeTools 贡献 MCP 工具 / hostBindings 贡献 plugin:<name>:<bindingId> 网关工具
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `importGithubPlugin()` in plugin-system.ts:515 | GitHub 导入 | 暂存→查重（normalizedPluginName）→接受→发布事务 |
| `build()` in runtime/snapshot-builder.ts:120 | 构建快照 | 逐层 Object.freeze |
| `prepareTurnCapabilities()` in plugin-system.ts:275 | turn 能力预留 | 快照引用计数 |
| `run()` in plugin-hooks/src/runner.ts:60 | 执行 hook 命令 | 15s 预算（SessionEnd 3s） |
| `runPluginPreToolHook()` in plugin-hook-tool-lifecycle.ts:421 | PreToolUse 编排 | deny→block，updatedInput 校验后原地改写 |
| `prepare()/acquire()` in miniapp/supervisor/supervisor.ts | MiniApp 进程准备/获取 | PreparedTransition + generation lease |
| `activateScopeBoundary()` in plugin-system.ts:942 | 账号切换 | 降级 custom-only 快照 + 异步退休账号专属 MiniApp |

</details>

## 核心实现

### 来源统一与 scope 边界

官方/GitHub 最终都落为本地磁盘上的 canonical 包根，只靠 `source: 'OFFICIAL'|'LOCAL_MINIMAX'` 标记与 `SqlitePluginRepository` 状态区分。scope = `{principalId, deployment}`：账号切换时 `activateScopeBoundary` 同步降级为 custom-only 快照并异步退休账号专属 MiniApp——**官方包内容跨账号共享但运行态不共享**。市场就两类：official（registry）+ local（`dataDir/plugins` 目录），`LocalPluginDirectoryWatcher` 监听本地目录变更自动触发 `publishExternalLocalPluginChanges`（plugin-system.ts:685）。

### PluginSnapshot 解决什么

插件能力必须相对 turn 原子生效。快照是 deep-frozen + revision 字符串的单一事实，所有消费方（marketplace 列表、turn capabilities、MCP reconcile、MiniApp 接受投影）读同一对象；发布经 turn 系统的 `publicationPort` 门控——**避免执行中换地板**。`PluginCapabilityGenerationRegistry.retain/release` 引用计数保证执行中的 turn 持有的旧快照 MCP runtime 不被销毁。

### MiniApp：世代/租约与 PONR

插件包里的 `miniapp` 贡献声明 Node 进程入口（nodeEntry）、前端 surface、MCP endpoints、hostConnector allowlist。`PluginMiniAppPublicationController.activate()` 触发 supervisor：`prepare(candidate)` → `nodeRuntime.prepare()` 启 Node 子进程 + `createHostConnectorSession`（host-connector.ts:372，NDJSON 帧协议）→ `acquire()` 拿 generation lease（on-demand 冷启动 `ensureOnDemandRuntime`，30s idle 后 `drainIdleRuntime`）。世代机制：`miniAppGeneration`/`processGeneration` 双 UUID + `MiniAppGenerationLease`，旧 generation 进 `retiring` 表等 lease 排空才清理。所有变更是 `PreparedTransition{commit/rollback/finalize}` 两阶段提交——supervisor 的 `rollbackCommittedGeneration` 连内存快照都能恢复（`capturePublicationMemory`）；`crossedPonr`（point of no return）标记决定失败后是否记持久 failure。

### Hook 执行与供应商兼容

`PluginHookRunner.run()` spawn 子进程执行 hook 命令（15s 预算），`mergePluginHookDecisions` 合并决策：deny → `{block:true}`；`updatedInput` 经 `applyPluginToolRewrite` 用 `isRuntimeToolInputValid` 校验后原地改写工具入参；PostToolUse 的 `additionalContext`/`updatedResult` 替换模型可见结果（审计保留原文）。失败一律 fail-open。`withPluginHookCompatibleToolResponse`（agent-tools/src/plugin-hooks/vendor-tool-response.ts:26）解决 CLAUDE 格式插件需要 PostToolUse 精确 JSON（Edit 的 structuredPatch、Bash 的完整 stdout）的问题：模型可见文本可能被截断，工具实现用 **Symbol side-channel**（`Symbol.for('mavis.pluginHooks.compatibleToolResponse')`，非序列化）在 details 上附挂无损 vendor 值——"适配是增强，损坏必须不影响工具成功"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两阶段提交 + 补偿 | `uninstallLocalPlugin` 的 `stageAcceptedLocalRoot` + rollback（plugin-system.ts:478-513） | 涉及磁盘/DB/子进程的变更可回滚 |
| 世代/租约 | MiniApp 双 generation + retiring 表 | 优雅停旧进程不撕裂在飞请求 |
| 责任链 | `createControlledToolHooks`（去重→解析→guard→插件→policy→permissionGuard） | 有序可预测的 hook 管线 |
| 不可变快照 + revision | PluginSnapshot + 引用计数 | 原子生效 |
| Symbol side-channel | vendor-tool-response.ts | 非序列化通道传无损数据 |

## 模块间交互

`createControlledToolHooks`（turn-system/agent-host/execution/plugin-hook-tool-lifecycle.ts:64）把 hook 注入 pi 的 before/afterToolCallHook 链——权限守卫在链尾（见 [Turn 执行系统](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/03-turn-system)）。TUI `/plugin` 命令经 `McodePluginApplication` → CliService → `PluginServiceFacade`（contracts.ts:157）进安装链路。MCP 子进程的启停由 `mcpRuntime.reconcile` 按快照 diff 驱动。

## 扩展方式

- **写一个新插件**：在 `dataDir/plugins/my-plugin/` 放 MiniMax manifest，hook 声明进 manifest（`readPluginHooks` + `parsePluginHookDocuments` 解析），`LocalPluginDirectoryWatcher` 自动触发发布——**无需改码**。
- **新增插件来源**（如 GitLab）：仿 `plugin/import/github-plugin-importer.ts` 的 prepare→staging→canImport 模板，在 `PluginSystem` 加 `importXxxPlugin`（照 :515 的暂存→查重→接受→发布事务），快照侧零改动。
- **给 hook 增加新事件**：`PLUGIN_HOOK_EVENTS`（plugin-hooks/src/contracts.ts:2）+ `PluginHookRunner.run` 的选择/预算逻辑 + turn 侧 `plugin-hook-tool-lifecycle.ts` 新增对应 `runPluginXxxHook` 挂入 hook 数组。
