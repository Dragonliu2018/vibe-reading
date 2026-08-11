---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Environments & Cloud"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 环境与云——driver 抽象、租约管理、云上游 run 对账"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 工作区与运行时](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/03-workspace-runtime)

---

## 模块定位

本模块属于工作区与运行时子系统。Environments & Cloud 回答"agent 在哪做"——sandbox 环境、cloud runtimes（cloud/sandbox agents 如 Cursor/e2b/Novita），环境租约管理防多 run 抢同一环境。`cloudUpstreamService()` 是 graphify god node（36 边）。它独立存在，是因为 driver 抽象让 local/ssh/sandbox/cloud 可替换，而租约管理是并发安全的基础。

## 模块架构

三个核心服务：`environmentService(db)`（`environments.ts:166`，环境 + 租约 CRUD）、`environmentRuntimeService(db, options)`（`environment-runtime.ts:1385`，driver 调度）、`environmentRunOrchestrator(db, options)`（`environment-run-orchestrator.ts:148`，run 级编排）。

`EnvironmentRuntimeDriver` 接口（`environment-runtime.ts:175`）定义 `acquireRunLease`/`releaseRunLease`/`realizeWorkspace`/`execute` 等方法，4 个实现按 driver key 注册到 Map：`createLocalEnvironmentDriver`（`:322`）、`createSshEnvironmentDriver`（`:366`）、`createSandboxEnvironmentDriver`（`:428`，最复杂，支持 builtin+plugin 双路径）、`createPluginEnvironmentDriver`（`:1128`，经 PluginWorkerManager RPC 调插件）。

## 调用链路

heartbeat run 环境租约链：

```
heartbeat.ts:9043  envOrchestrator.acquireForRun(...)
  ├─ orchestrator:256  resolveEnvironment (local fallback / status check)
  ├─ orchestrator:274  acquireLease → environmentRuntime.acquireRunLease (runtime:1441)
  │    └─ driver.acquireRunLease (local:328 / ssh:372 / sandbox:529 / plugin:1213)
  │         └─ environmentsSvc.acquireLease (environments.ts:457)  ← DB INSERT
  ├─ orchestrator:285  logActivity("environment.lease_acquired")
  └─ orchestrator:305  resolveTransport

heartbeat.ts:9083  envOrchestrator.realizeForRun(...)
  ├─ orchestrator:380  environmentRuntime.realizeWorkspace
  ├─ orchestrator:418  environmentRuntime.execute (provision command)
  └─ orchestrator:472  resolveEnvironmentExecutionTarget

heartbeat.ts:3428  releaseEnvironmentLeasesForRun → envOrchestrator.releaseForRun
  └─ orchestrator:521  environmentRuntime.releaseRunLeases (runtime:1478)
       └─ driver.releaseRunLease → environmentsSvc.releaseLease  ← DB UPDATE
```

## 核心实现

### 环境租约防多 run 抢同一环境

租约表 `environment_leases` 记录 `heartbeatRunId` + `status='active'`，`releaseRunLeases` 按 runId 批量释放（`runtime:1478`）。sandbox 可复用租约通过 `reuse_by_environment` policy + `reusableSandboxLeaseScope` fingerprint 匹配（`runtime:251-313`），仅同 company+environment+workspace+agent+adapterType+config 的 run 可复用；ad-hoc test（`heartbeatRunId===null`）强制 ephemeral 不可复用（`runtime:574-597`，注释明确：释放 test lease 会销毁共享 sandbox）。

### Driver 抽象（local/ssh/sandbox/plugin 可替换）

`EnvironmentRuntimeDriver` 接口（`runtime:175`），`environmentRuntimeService` 用 Map 注册 driver，`getLeaseDriverKey` 优先从 lease.metadata 读取 driver（支持环境 config 变更后旧 lease 仍用原 driver 释放，`runtime:198`）。sandbox driver 内部再分 builtin provider 和 plugin provider 双路径（`:540` isBuiltinSandboxProvider 判断）。**为什么**：local/ssh/sandbox/cloud 可替换，插件可声明 `environment.drivers` 注册新 driver。

### 云上游 run 对账（重启后恢复）

`reconcileCloudUpstreamRunsOnStartup`（`cloud-upstreams.ts:665`）在 `index.ts:720` 启动时调用。将所有 `status='running'` 的 cloud upstream row 标记为 `failed`，写入 `reconciledAt` 时间戳和 "orphaned_running_run" 错误信息。**为什么**：cloud upstream run 是多步骤 push→verify→activate 的远程同步流程（`:329-419`），服务器重启后无法恢复远程连接上下文，必须标记失败让用户重试。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 策略 / Driver 抽象 | `EnvironmentRuntimeDriver` 接口 (`:175`) | local/ssh/sandbox/plugin 可换 |
| 工厂 | 三个 service 均为 `xxxService(db)` | 每次返回新实例 |
| 编排器 | `environmentRunOrchestrator` (`:148`) | 串联环境解析→租约→实现→传输→释放 |

## 模块间交互

`heartbeatService` 构造时创建 `envOrchestrator`（`heartbeat.ts:3401`）和 `environmentRuntime`（`:3398`），注入 `pluginWorkerManager`。Run 执行时调 `acquireForRun`（`:9043`）、`realizeForRun`（`:9083`）、`releaseForRun`（`:3428`）。`executionWorkspaceService` 在 orchestrator 内部协作：`realizeForRun` 将 workspaceRealization metadata 写回 `executionWorkspace`（`orchestrator:456`）。`cloudUpstreamService` 在 startup reconcile（`index.ts:720`），与 heartbeat 不直接交互。

## 扩展方式

**新增 sandbox provider（如 e2b）**：`environment-runtime.ts` 的 `createSandboxEnvironmentDriver`（`:428`）；若 builtin，在 `sandbox-provider-runtime.ts` 注册新 provider 的 acquire/release/destroy 实现，`isBuiltinSandboxProvider`（`:540`）加入新 key；若 plugin，无需改本文件，插件通过 manifest 声明 `environmentDrivers`，`resolveSandboxProviderPlugin`（`:441`）自动发现。

**修改租约策略（如抢占式释放）**：`environments.ts` 的 `acquireLease`（`:457`）和 `releaseLease`（`:500`）；在 `ENVIRONMENT_LEASE_POLICIES`（shared 包）新增 policy 值；`environment-runtime.ts` sandbox driver 的 `resolvedLeasePolicy` 判断（`:673`/`:789`）支持新 policy；`releaseRunLeases`（`:1478`）的 `inArray(status, ["active"])` 可能需扩展。
