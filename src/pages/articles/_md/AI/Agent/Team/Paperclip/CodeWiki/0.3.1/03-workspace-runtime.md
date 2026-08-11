---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "工作区与运行时"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 工作区与运行时子系统——git worktree 隔离、sandbox 环境租约、项目文档版本化"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview)

---

## 子系统定位

工作区与运行时回答"agent 在哪、用什么资源工作"。每次 heartbeat run 需要一个隔离的执行环境——git worktree（文件/git 状态不互相污染）、环境租约（防多 run 抢同一 sandbox）、runtime service（dev server 跨 heartbeat 复用）。这个子系统独立存在，是因为执行环境的准备与回收是一组高度内聚的 I/O 密集型操作（git 操作、租约获取、服务启停），与业务编排逻辑正交，单独成域便于复用与替换（local/sandbox/cloud driver 可换）。

## 挂载模块

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| Workspace Runtime | git worktree 隔离与 runtime service 复用 | `realizeExecutionWorkspace` (`workspace-runtime.ts:1214`) | 每个 run 需要独立工作区，runtime service 启停跨 run 复用 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/03-workspace-runtime-01-workspace) |
| Environments & Cloud | sandbox 环境与云上游对账 | `environmentRunOrchestrator(db)` (`environment-run-orchestrator.ts:148`) | driver 抽象让 local/ssh/sandbox/cloud 可替换 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/03-workspace-runtime-02-environments) |
| Projects & Documents | 项目工作区与文档版本化 | `projectService(db)` (`projects.ts:543`) | project-goal-issue 三级 ancestry + 文档 revision 审计 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/03-workspace-runtime-03-projects-documents) |

## 子系统内模块关系

三个模块形成"项目 → 环境 → 工作区"的执行上下文：Projects 提供项目定义与 goal 关联（agent 知道"为什么做"），Environments 提供可替换的执行环境与租约（agent 知道"在哪做"），Workspace Runtime 在环境内创建 git worktree 并管理 runtime service（agent 知道"用什么做"）。Heartbeat 的 `executeRun` 按 `acquireForRun` → `realizeForRun` → `realizeExecutionWorkspace` → `ensureRuntimeServicesForRun` 顺序装配全部上下文。
