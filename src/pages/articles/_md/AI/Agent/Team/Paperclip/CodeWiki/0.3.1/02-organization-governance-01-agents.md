---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Agents & Org Chart"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip agent 组织架构——角色、汇报线、Bring Your Own Agent、AGENTS.md 运行时技能注入"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 组织与治理](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/02-organization-governance)

---

## 模块定位

本模块属于组织与治理子系统。Agents & Org Chart 定义"谁"——agent 有 role、title、汇报线（reportsTo）、权限、预算、adapterType。`agentService()` 是 graphify god node（28 边）。它独立存在，是因为 agent 是被编排的主体，而 org chart（汇报线树）是"公司"隐喻的核心——支持权限下放、汇报审批流、`orgChainHealth` 影响 work eligibility。

## 模块架构

`agentService(db)`（`agents.ts:222`）工厂返回 22 个方法：CRUD（create/update/remove/list/getById）、生命周期（pause/resume/clearError/terminate/activatePendingApproval）、权限（updatePermissions）、配置版本（listConfigRevisions/getConfigRevision/rollbackConfigRevision）、API key（createApiKey/listKeys/revokeKey）、org chart（orgForCompany/getChainOfCommand）、查询（runningForAgent/resolveByReference）。

agent 核心数据结构（`CONFIG_REVISION_FIELDS`，`:40-52`）：`name`、`role`、`title`、`reportsTo`(=managerId)、`capabilities`、`adapterType`、`adapterConfig`、`runtimeConfig`、`defaultEnvironmentId`、`budgetMonthlyCents`、`metadata`。`reportsTo` 构成 org chart 边。

辅助服务：`agentInstructionsService()`（`agent-instructions.ts:454`）管 AGENTS.md 与 instructions 目录树（managed/external 双模式）；`externalObjectService(db)`（`external-objects.ts:352`）sync issue/comment/document 中的外部对象引用。

## 调用链路

创建 agent 并挂到 org chart：

```
routes/agents.ts:175  agentService(db)
  ↓ svc.create(companyId, data)                      agents.ts:492
1. ensureManager(companyId, reportsTo)               :332  校验 manager 同公司 + 存在
2. deduplicateAgentName(name, existing)              :501  shortname 去重
3. normalizeAgentPermissions(permissions, role)     :504  按 role 规范权限
4. normalizeRuntimeConfigForNewAgent                 :505  注入 maxConcurrentRuns 默认
5. tx.transaction                                    :506
   ├─ insert(agents)                                 :508
   ├─ syncAgentSecretBindings                        :513  → agent-secret-bindings 同步
   └─ agentService(txDb).getById                     :514  事务内重取
```

汇报线由 `data.reportsTo` 写入；改汇报线走 `update(id, {reportsTo})`（`:411`），触发 `ensureManager` + `assertNoCycle`（`:341`，沿 reportsTo 上溯防环）。adapter 关联通过 `adapterType`+`adapterConfig` 字段存于 agent 行，heartbeat 运行时 `getServerAdapter(agent.adapterType)`（`heartbeat.ts:3210`）解析。

## 核心实现

### Org chart 层级化

agent 有 `role`（如 `general`，`:503` 默认）、`title`、`reportsTo`、`job description`（capabilities/metadata）。`orgForCompany`（`:801`）递归 `build(managerId)` 构树（reports 子数组嵌套）；`getChainOfCommand`（`:824`）沿 `reportsTo` 上溯最多 50 层返回 boss 链；`assertNoCycle`（`:341`）同向防环。**为什么**：支持权限下放、汇报审批流，`orgChainHealth` 影响 `getAgentWorkEligibility`（`:264`）。

### Bring Your Own Agent（adapterType 解耦）

agent 行只存 `adapterType` 字符串 + `adapterConfig` JSON，runtime 由 `adapters/registry.ts` 的 `getServerAdapter` 按 type 解析。`BUILTIN_ADAPTER_TYPES`（`builtin-adapter-types.ts:4`：claude_local/codex_local/cursor/cursor_cloud/gemini_local/grok_local/acpx_local/hermes_local/http）+ 外部插件 adapter 可覆盖内置（`:613` override 逻辑，`builtinFallbacks` 保底）。**为什么**：Claude Code/Codex/Cursor/HTTP bot 等异构 runtime 可插拔，agent 数据模型不随 adapter 增多而改 schema。

### AGENTS.md 运行时 skill 注入

`agentInstructionsService` 双模式：`managed` 落盘到 `companies/{cid}/agents/{aid}/instructions/`（`:133`）；`external` 指向仓库内路径。`plugin-managed-agents.ts:335` `materializeManagedBundle` 把插件声明的多文件 bundle 写盘并回写 `adapterConfig`。**为什么**：agent 启动时 adapter 从 `adapterConfig.instructionsEntryFile` 读 AGENTS.md 作为 system prompt，skills/配置随 agent 走而非随 runtime 走——agent 不重训即可学 Paperclip workflow。

### 配置版本审计

`buildConfigSnapshot` + `diffConfigSnapshot` + `agentConfigRevisions` 表实现可回滚配置审计（`:86`/`:146`/`:458`）。`rollbackConfigRevision` 支持回滚到历史版本。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 工厂 + 闭包 | `agentService(db)` (`:222`) | db 注入 |
| Adapter | `adapters/registry.ts` + `BUILTIN_ADAPTER_TYPES` | agent 数据模型与 runtime 解耦 |
| 组合模式 | `orgForCompany` 递归构树 (`:813`) | org chart 嵌套结构 |
| Chain of Command | `getChainOfCommand` 上溯 (`:824`) | 命令链查询 |
| Memento | `agentConfigRevisions` 版本快照 (`:86`) | 可回滚配置审计 |

## 模块间交互

被 `routes/agents.ts:175` 实例化（与 `agentInstructionsService` 组合）。被 `routes/access.ts`/`companies.ts`/`issues.ts`/`costs.ts`/`llms.ts`/`teams-catalog.ts`/`company-skills.ts` 各自取 agent/org 数据。`heartbeat.ts` 不直接 import `agentService`，但通过 `agent.adapterType`（`:2163`）+ `getServerAdapter`（`:3210`）取 adapter 执行 run。`agentInstructionsService` 被 `feedback.ts:109`（feedback 报告读 bundle）、`plugin-managed-agents.ts:335`（插件 materialize）、`company-portability.ts:2996`（导入导出）调用。

## 扩展方式

**新增 agent role**（如 `reviewer`）：改 `agent-permissions.ts` 的 `normalizeAgentPermissions`（`agents.ts:244/429/504` 调用，按 role 给默认权限）；若 role 需特殊 runtimeConfig 默认，改 `normalizeRuntimeConfigForNewAgent`（`:134`）。

**修改汇报线规则**（如限制层级深度）：改 `assertNoCycle`（`:341`，当前仅防自环，加深度上限）；若需跨公司校验，改 `ensureManager`（`:332`，当前只查同公司）；`getChainOfCommand` 的 `chain.length < 50` 上限（`:829`）同步调整。
