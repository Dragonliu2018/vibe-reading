---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Secrets · Storage · Activity"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 密钥存储与审计——secret scrubbing、scoped run 注入、provider 抽象、不可变 activity log"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 平台扩展与可移植](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/04-platform-portability)

---

## 模块定位

本模块属于平台扩展与可移植子系统。Secrets · Storage · Activity 回答"如何保护与审计"——instance/company secrets、encrypted local storage、provider-backed object storage、scoped run 注入（敏感值不进 prompt 除非显式需要）、不可变 activity log。`logActivity`/`secretService()` 是 graphify god nodes（36/29 边）。它独立存在，是因为密钥保护与审计是横向的跨切面能力——被全部 run 使用、被导出 scrub、被 mutating action 记录。

## 模块架构

`secretService(db)`（`secrets.ts:313`，返回大对象 `:1045`）：Provider 配置管理（listProviders/checkProviders/listProviderConfigs/createProviderConfig/setDefaultProviderConfig/checkProviderConfigHealth）、Secret CRUD（list/create/rotate/update/remove + listBindings/listAccessEvents）、运行期解析（resolveSecretValue/resolveEnvBindings/resolveAdapterConfigForRuntime/collectMissingRuntimeBindings/normalizeEnvConfig）。

`activityService(db)`（`activity.ts:37`，返回 `:327`）：list(filters)/forIssue/runsForIssue/issuesForRun/create。`logActivity`（`activity-log.ts:65`）是被十余处调用的审计入口。

`createStorageService(provider)`（`storage/service.ts:90`）：putFile/getObject/headObject/deleteObject，`StorageProvider` 接口见 `storage/types.ts:35`。

Secret 数据结构：`companySecrets`（id/companyId/name/key/provider/providerConfigId/latestVersion/status/externalRef）、`companySecretVersions`（secretId/version/material 加密/providerVersionRef/status/revokedAt）、`companySecretBindings`（companyId/secretId/targetType(agent|project|environment|routine)/targetId/configPath）、`secretAccessEvents`（actorType/actorId/consumerType/consumerId/configPath/issueId/heartbeatRunId/pluginId/outcome/errorCode）。

## 调用链路

Secret 注入链（heartbeat run，行号见 `heartbeat.ts`）：

```
1. 预派发校验门 :550-628
   对 environment/agent/project/routine 四类 env 调
   secretsSvc.collectMissingRuntimeBindings
   缺绑定 → ConfigurationIncompleteFailure (reason: secret_binding_missing)
2. 解析 :630-710
   resolveEnvBindings (environment :631 / project :672 / routine :698)
   + resolveAdapterConfigForRuntime (agent :647)
   每次传 SecretConsumerContext (consumerType/Id, actorType=agent, actorId,
     issueId, heartbeatRunId, allowedBindingIds 低信任边界)
   内部 resolveSecretValueInternal (secrets.ts:579):
     getById → 公司校验 → assertBindingContext (绑定须在 allowedBindingIds 内)
     → getSecretVersion → getSelectableRuntimeProviderConfig
     → provider.resolveVersion (provider-registry 分发)
     → 并行 recordAccessEvent(success) + 更新 lastResolvedAt
     catch → recordAccessEvent(failure, errorCode)
3. 解析出的 env 并入 resolvedConfig.env 传给 adapter
   secretKeys 集合标记哪些 key 派生自 secret → prompt/log 脱敏
```

Activity 记录链（`activity-log.ts:65` `logActivity`）：`sanitizeRecord`(脱敏) → `redactCurrentUserValue`(按 censorUsernameInLogs 抹用户名) → `db.insert(activityLog)` → `publishLiveEvent(activity.logged)` → `publishPluginDomainEvent`。

## 核心实现

### Secret scrubbing / 导出脱敏

`company-portability.ts:499-548` 将 env binding 标 `kind:"secret"|"plain"`；secret_ref 导出只带引用不带值，导入侧 `materializeImportEnvInputValues`（`:3062`）必须显式收 `secretValues`。**为什么**：跨实例迁移不泄露密钥——bundle 可公开分享。

### Scoped run 注入 / 低信任边界

`SecretConsumerContext.allowedBindingIds` + `assertBindingContext`（`secrets.ts:398`，"outside the active low-trust boundary"）；`SENSITIVE_ENV_KEY_RE`（`:60`）+ strictMode（`:747`）拒绝敏感 key 的明文。**为什么**：secret 只在显式绑定且边界内暴露，不进 prompt 除非 scoped run 显式需要。

### Secret access event 审计

`recordAccessEvent`（`:410`）成功/失败均落 `secretAccessEvents`，带 actor/consumer/run/issue/plugin 全链路上下文。**为什么**：可追溯每次取值，每次 secret 解析都有审计记录。

### Provider 抽象可替换

`SecretProviderModule`（resolveVersion/linkExternalSecret/listRemoteSecrets/healthCheck/deleteOrArchive）+ `COMING_SOON` 锁（`:63`）+ `assertSelectableProviderConfig`（`:298`）。`secrets/provider-registry.ts:22-32` 的 `providers` 数组含 localEncrypted/aws/gcp-stub/vault-stub。**为什么**：local_encrypted 与 aws_secrets_manager 平等可换，未就绪 provider 草稿可存但解析禁用。Storage 同理：`storage/provider-registry.ts:6` 按 `config.storageProvider` 选 local_disk/s3。

### Immutable activity log

`logActivity` 只 insert，从不 update；写入前 `sanitizeRecord`+`redactCurrentUserValue`。**为什么**：审计不可篡改——mutating actions/heartbeat state changes/cost events/approvals/comments/work products 全部记为 durable activity。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Provider / Registry | `secrets/provider-registry.ts:22` / `storage/provider-registry.ts:6` | local/aws/s3 可替换 |
| Observer / Event-bus | `setPluginEventBus` + `logActivity` 扇出 (`activity-log.ts:32/65`) | live-events + PluginEventBus.emit |
| Facade | `secretService` 单一大对象 (29 方法) | 聚合 CRUD+解析+远程导入 |

## 模块间交互

`heartbeatService` 构造期 `secretService(db)`（`heartbeat.ts:3392`）并取 `resolveAdapterConfigForRuntime|resolveEnvBindings|collectMissingRuntimeBindings` 子集（`:406`）注入 run setup。`company-portability.ts:3001` 复用 `secretService`，导出包不携带 secret material。`routes/secrets.ts` 调 secretService 做 CRUD；`routes/activity.ts` 调 activityService。`logActivity` 被 budgets/companies/heartbeat/environment-run-orchestrator/external-objects/plugin-host-services 调用；`storageService` 被 attachments/work products 使用（`ensureCompanyPrefix` 强制 object key 归属公司，`service.ts:46`）。

## 扩展方式

**新增 storage provider（如 azure-blob）**：新建 `server/src/storage/azure-blob-provider.ts` 实现 `StorageProvider` 接口（`types.ts:35`）；在 `storage/provider-registry.ts:6` `createStorageProviderFromConfig` 加 `config.storageProvider` 分支；在 `@paperclipai/shared` 补 provider id 枚举。

**新增 secret provider 类型（如 gcp_secret_manager 从 coming_soon 转正）**：新建 `server/src/secrets/gcp-secret-manager-provider.ts` 导出 `SecretProviderModule`（resolveVersion/linkExternalSecret/healthCheck/deleteOrArchive）；在 `secrets/provider-registry.ts:8` `providers` 数组注册；从 `secrets.ts:63` `COMING_SOON_SECRET_PROVIDERS` 移除。
