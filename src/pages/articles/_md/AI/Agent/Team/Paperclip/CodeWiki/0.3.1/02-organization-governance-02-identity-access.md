---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Identity & Access"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 身份与权限——两种部署模式、actor 追溯、短生命周期 run JWT、company-scoped 隔离"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 组织与治理](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/02-organization-governance)

---

## 模块定位

本模块属于组织与治理子系统。Identity & Access 回答"能否"——每个 mutating request 追溯到一个 actor（board user / agent / 短生命周期 run JWT），company-scoped 数据隔离。`authorizationService()` 是 graphify god node（22 边）。它独立存在，是因为身份认证与权限决策是跨切面的安全基石——约束全部其他模块的 mutating 操作，但自身不含业务逻辑。

## 模块架构

三个核心服务：`accessService(db)`（`access.ts:28`，22 方法，company membership + permission grants 管理）、`authorizationService(db)`（`authorization.ts:404`，2 方法，核心策略引擎）、`boardAuthService(db)`（board API key 管理）。

Principal 类型（`AuthorizationActor.type`，`authorization.ts:23-41`）：`"board"`（board user，含 `source` 子类型 `local_implicit`/`session`/`board_key`/`cloud_tenant`）、`"agent"`（`source`: `agent_key`/`agent_jwt`）、`"none"`（未认证）。

## 调用链路

mutating request 鉴权链（以 issue assign 为例）：

```
HTTP Request
  → actorMiddleware (middleware/auth.ts:22)          解析 req.actor
    → 责任链: board key → agent API key → run JWT → session → cloud tenant
  → route handler (routes/issues.ts:1833)
    → assertCanAssignTasks → access.decide({
        actor: req.actor,
        action: "tasks:assign",
        resource: {type:"issue", companyId, ...},
      })
      → authorization.decide()  authorization.ts:958
        → permissionForAction() → permissionKey 映射         :112
        → board actor: local_implicit → allow               :1024
                     instance_admin → allow                 :1034
                     cloud_tenant → company-scoped 校验     :1049
                     普通 user → membership + grant 校验     :1095-1158
        → agent actor: company boundary 校验                :1169
                       → low-trust boundary 校验            :1186
                       → assignment policy effect           :1251
                       → decidePrincipalGrant               :1309
        → 返回 AuthorizationDecision {allowed, reason, explanation}
  → decision.allowed ? 继续 : throw forbidden(decision.explanation)
```

Run JWT 签发与校验链：签发在 `heartbeat.ts:9521`（`createLocalAgentJwt`），签名用 `deriveCompanySigningKey`（`agent-auth-jwt.ts:91`）派生 per-company HMAC key（`:59`），TTL 60 分钟（`:40`）；校验在 `middleware/auth.ts:140`（`verifyLocalAgentJwt`），验证签名 + exp/iss/aud + 查 agent 表确认 companyId 匹配 + status 非 terminated → 设 `req.actor = {type:"agent", source:"agent_jwt", runId}`。

## 核心实现

### 两种部署模式

`local_trusted`（`better-auth.ts:57` + `auth.ts:26`）：loopback 请求直接赋予 `local_implicit` board actor + `isInstanceAdmin:true`，跳过所有认证。`authenticated`：要求 BetterAuth session / board key / agent key / JWT / cloud tenant header。**为什么**：本地单用户部署无需认证开销，多用户/云部署需要严格身份验证。

### Actor 追溯

每个 mutating request 的 `req.actor` 携带 `source` 字段（`authorization.ts:33-40`），`grantedByUserId` 记录在 `principalPermissionGrants` 表（`access.ts:153`）。**为什么**：审计需求——每个 grant 可追溯到授予者，每个 request 可追溯到 actor 来源。

### 短生命周期 run JWT

默认 TTL 60 分钟，per-company signing key（`agent-auth-jwt.ts:59`），run-scoped `run_id` claim。**为什么**：最小权限原则——agent 执行 run 时获得临时凭证，TTL 到期自动失效；per-company key 防止跨 tenant token 重放。

### Company-scoped 数据隔离

`authorizationService.decide()`（`:1169`）校验 `actor.companyId !== companyId → deny_company_boundary`；cloud tenant actor 被主动 purge instance_admin（`auth.ts:246`）并降级为 company-scoped membership（`authorization.ts:1049`）。**为什么**：多租户隔离——防跨 company 数据泄露，修正早期 cloud tenant 过度授权的安全债。

### Low-trust boundary

`decideLowTrustAccess`（`:700`）：low-trust agent 只能访问 boundary 内的 issue/project/agent，禁止 `company_scope:read`/`runtime:manage`/`secrets:read`（`:729-737`）。**为什么**：沙箱化不受信任的 agent 执行环境。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 策略 | `authorizationService.decide()` (`:958`) | 按 actor.type 分派策略分支 |
| 中间件 | `actorMiddleware` (auth.ts:22) | 统一 actor 解析 |
| 责任链 | middleware token 类型按序尝试 | board key → agent key → JWT → session |
| Scope-based 权限 | `scopeAllows()` (`:319`) | projectId/agentId/subtree 级 scope 约束 |

## 模块间交互

`authorizationService` 被 `secrets.ts:314`（secrets 读取权限校验）、`plugin-host-services.ts:543`（插件 host 权限代理）、各 route（通过 `access.decide()`）调用。`accessService` 被 `routes/issues.ts`/`agents.ts`/`projects.ts`/`costs.ts`/`activity.ts` 调用。`actorMiddleware` 被 Express app 全局注册。`createLocalAgentJwt` 仅被 `heartbeat.ts:9521` 调用。

## 扩展方式

**新增 principal 类型**（如 service account）：改 `AuthorizationActor.type` 联合类型（`:23`）；`authorizationService.decide()`（`:958`）新增分支；`actorMiddleware`（`auth.ts:22`）新增 token 解析路径；`accessService.ensureMembership()`（`:535`）支持新 principalType。

**新增权限规则**（如 `agents:delete`）：`AuthorizationAction`（`:43`）加值；`permissionForAction()`（`:112`）加 action→permissionKey 映射；`decide()` board/agent 分支加处理逻辑；`PermissionKey` 类型加 key。
