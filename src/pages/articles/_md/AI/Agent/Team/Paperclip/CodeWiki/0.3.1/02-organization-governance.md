---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "组织与治理"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 组织与治理子系统——agent 组织架构、身份鉴权、预算与审批门"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview)

---

## 子系统定位

组织与治理回答"谁能在什么约束下做什么"。Paperclip 的核心隐喻是"公司"——agent 有角色（role）、title、汇报线（reportsTo）、权限、预算；每个 mutating request 追溯到一个 actor（board user / agent / 短生命周期 run JWT）；超支自动停摆、审批门强制人工决策。这个子系统独立存在，是因为治理逻辑（身份、权限、预算、审批）是跨切面的——它们约束全部其他模块的执行，但自身不包含业务编排逻辑，故单独成域。

## 挂载模块

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| Agents & Org Chart | agent 生命周期与组织架构 | `agentService(db)` (`agents.ts:222`) | agent 是被编排的主体，org chart 是公司隐喻的核心 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/02-organization-governance-01-agents) |
| Identity & Access | 身份认证与权限决策 | `authorizationService(db)` (`authorization.ts:404`) | actor 追溯与多租户隔离是安全基石 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/02-organization-governance-02-identity-access) |
| Budget & Governance | 成本控制与审批门 | `budgetService(db)` (`budgets.ts:496`) | 防 runaway spend 的硬停 + 审批 enforcement | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/02-organization-governance-03-budget-governance) |

## 子系统内模块关系

三个模块形成"主体 → 权限 → 约束"的治理链：Agents 定义"谁"（agent 的 role/permission/adapterType），Identity & Access 定义"能否"（actor 鉴权 + scope 校验），Budget & Governance 定义"限额"（cost 追踪 + 硬停 + 审批）。Heartbeat 在 run 前后调 `getInvocationBlock` 检查预算、调 `actorMiddleware` 校验身份、调 `assertCanAssignTasks` 校验权限——三者共同构成 run 的守卫链。
