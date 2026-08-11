---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Workspace Runtime"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 工作区运行时——git worktree 隔离、runtime service 跨 heartbeat 复用、unsafe cwd 检测"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 工作区与运行时](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/03-workspace-runtime)

---

## 模块定位

本模块属于工作区与运行时子系统。Workspace Runtime 回答"agent 用什么做"——每个 heartbeat run 需要一个隔离的 git worktree（文件/git 状态不互相污染）和 runtime service（dev server 跨 heartbeat 复用）。它独立存在，是因为执行环境的准备与回收是 I/O 密集型操作（git 操作、服务启停），与业务编排正交；worktree 隔离让多 run 并行不互相污染。

## 模块架构

两个核心组件：`executionWorkspaceService(db)`（`execution-workspaces.ts:397`）工厂返回闭包对象（list/getById/getCloseReadiness/create/update）；`workspace-runtime.ts` 是模块级有状态单例（`runtimeServicesById`/`runtimeServicesByReuseKey`/`runtimeServiceLeasesByRun` Map，`:118-120`），导出函数 `realizeExecutionWorkspace`/`ensureRuntimeServicesForRun`/`releaseRuntimeServicesForRun`。`workspaceOperationService(db)`（`workspace-operations.ts:73`）用 `WorkspaceOperationRecorder` 捕获 git/shell 操作 stdout/stderr 并脱敏。

## 调用链路

heartbeat run 执行前准备 execution workspace（行号见 `workspace-runtime.ts` 与 `heartbeat.ts`）：

```
heartbeat.ts executeRun
  ├─ ensurePersistedExecutionWorkspaceAvailable   heartbeat.ts:8858
  │   └─ 若已存在持久化 workspace 且路径存活 → 刷新 base ref + provision
  │   └─ 否则 realizeExecutionWorkspace            :8891
  │       └─ git worktree add -b <branch> <path> <baseRef>  workspace-runtime.ts:1361
  ├─ executionWorkspacesSvc.update/create          heartbeat.ts:8916/8928  持久化
  ├─ [失败] cleanupExecutionWorkspaceArtifacts      :8958
  ├─ envOrchestrator.acquireForRun + realizeForRun  :9043/9083  (与 environmentService 协作)
  ├─ ensureRuntimeServicesForRun                    :9456  runtime service 启动
  │   └─ 注入 context.paperclipRuntimeServices + paperclipRuntimePrimaryUrl  :9472
  └─ [run 结束] releaseRuntimeServicesForRun         :10122  lease 释放
      └─ ephemeral 立即 stop · persistent 走 scheduleIdleStop (1800s)
```

## 核心实现

### git worktree 隔离

`realizeExecutionWorkspace`（`:1214`/`:1236-1428`）每个 issue/agent 组合在 `<repoRoot>/.paperclip/worktrees/<branch>` 下独立 worktree，`branchTemplate` 默认 `{{issue.identifier}}-{{slug}`（`:1237`）。**为什么**：每个 run 独立工作区不互相污染文件/git 状态，且可并行。`workspaceStrategy.type`（`git_worktree` vs `project_primary`，`:1222`）在 `realizeExecutionWorkspace` 分支。

### runtime service 持久化与跨 heartbeat 复用

`persistRuntimeServiceRecord`（`:2130`）`onConflictDoUpdate` upsert 到 `workspaceRuntimeServices` 表；`findStoppedRuntimeServiceReuseCandidate`（`:2167`）从 DB 找已 stop 的同 reuseKey 服务复用端口；`scheduleIdleStop`（`:2540`）`stopPolicy.type==="idle_timeout"` 默认 1800s。**为什么**：dev server 启动慢，跨 run 复用降低延迟——agent 下次 heartbeat 时 dev server 还活着，直接复用。

### unsafe cwd 检测

`session-workspace-cwd.ts:19` `isUnsafeSessionWorkspaceCwd` 屏蔽 `/`、`/tmp`、`/var`、`/proc`、`/sys`、`/dev`、`/run`、`/private/tmp` 等系统根。**为什么**：防止 agent 把 session cwd 设到系统敏感目录导致误删/泄露，配合 `cleanupExecutionWorkspaceArtifacts` 的 `rm -rf` 与 `containsProjectWorkspace` 守卫（`:1739-1748`）。

### 关闭就绪检测

`getCloseReadiness`（`execution-workspaces.ts:489`）关闭前检查 git dirty/ahead/behind/merged、linked issues、runtime services 状态，产出 `plannedActions`（archive/stop/cleanup/teardown/worktree_remove/branch_delete/rm -rf）与 `blockingReasons`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模块级单例 + lease registry | `runtimeServicesByReuseKey` Map (`:118`) | run→services 多对多 lease |
| reuseKey 策略 | `resolveRuntimeServiceReuseIdentity` | 跨 run 复用同一 dev server |
| Recorder | `WorkspaceOperationRecorder` (operations.ts:55) | 统一日志/脱敏/phase |
| 工厂 + 闭包 | `executionWorkspaceService(db)` (`:397`) | db 注入 |

## 模块间交互

`heartbeat.ts` 构造期引用 `executionWorkspacesSvc`（`:3396`）、`envOrchestrator`（`:3401`，内部 `environmentRunOrchestrator` 再调 `executionWorkspaceService` 与 `environmentService`）。`workspace-runtime.ts` 通过 `runGit`（`:516`）直接调 git CLI；`ensureServerWorkspaceLinksCurrent`（`:249`）修 pnpm workspace 符号链接。`execution-workspaces.ts` 读 `workspaceRuntimeServices` 表做只读视图。

## 扩展方式

**新增 runtime service 类型（如 docker compose）**：改 `workspace-runtime.ts` 的 `startLocalRuntimeService`（`:2269`）内 provider 分派（当前 `local_process`/`adapter_managed`，`:90`），新增 `docker_compose` provider 的 start/stop/readiness 探测；同步 `toPersistedWorkspaceRuntimeService`（`:2099`）与 `stopRuntimeService`（`:2549`）的 terminate 分支；改 `workspaceRuntimeServices` schema 的 `provider` enum。

**修改 worktree 策略（如 shallow clone）**：改 `realizeExecutionWorkspace`（`:1214`）的 `recordGitOperation` args（`:1361`），将 `worktree add` 换为 `clone --depth=1`；同步 `cleanupExecutionWorkspaceArtifacts`（`:1620`）的 `git_worktree_remove`→`rm -rf clone dir` 分支（`:1689-1713`）；`getCloseReadiness` 的 `plannedActions` 更新 `git_worktree_remove` kind（`:680-685`）。
