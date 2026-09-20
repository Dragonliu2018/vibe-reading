---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "common 平台基础"
date: "2026-09-20T18:50:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "Feature Flags", "PostHog", "GDPR", "遥测"]
description: "packages/common：三层 feature flag 体系、consent-first 遥测管道、safe-storage 与 GoTrue 客户端工程。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

`packages/common`（核心 ~9.7k 行 + `telemetry-constants.ts` 3876 行）是跨 app 的平台基础层，被 import 914 次：feature flags、遥测、consent 管理、GoTrue auth 客户端、安全存储。它承载的是「平台语义的物理单点」——遥测事件 vocabulary、flag key 体系、GDPR consent 决策必须单点维护，否则各 app 漂移。

## 模块架构

![三层 feature flag 体系](/vibe-reading/images/articles/supabase-internals/feature-flag-layers.svg)

最重要的架构点是 **flag 不是一套而是三套互补机制**，各有独立 key 体系：

| 层 | 文件 | key 形态 | 载体 | 适用场景 |
| --- | --- | --- | --- | --- |
| ConfigCat 动态 flag | `configcat.ts` + `feature-flags.tsx` | ConfigCat settingKey | SDK（7 分钟 AutoPoll） | 平台运行时开关（可远程切换） |
| PostHog 实验 flag | `posthog-client.ts` | PH flag key | SDK / `/telemetry/feature-flags` | A/B 实验、渐进发布 |
| 静态 enabled-features | `enabled-features/enabled-features.json` | `domain:snake_case`（如 `logs:templates`） | 构建期 JSON，~130 key | self-hosted 裁剪 UI |

静态层是「打包即死」的构建期 flag：`isFeatureEnabled()` 是纯函数，`Feature` 类型 = JSON key ∪ `ProfileResponse['disabled_features']`（**编译期即校验 key 存在**）。`overrides.ts` 的 `getEnabledFeaturesOverrideDisabledList(env)` 把 `ENABLED_FEATURES_LOGS_ALL=false` 这类环境变量映射回 key——**self-hosted 用户改 env 就能关功能，无需重构建镜像**（README 原话）。未知 key 和非法值 warn-and-ignore。

`useIsFeatureEnabled` 定义不在 common 而在 `apps/studio/hooks/misc/useIsFeatureEnabled.ts`（150 文件扇入）：它调用 common 的 `isFeatureEnabled`，叠加两层运行时禁用源——`useProfile()` 的个人级 `disabled_features` + self-hosted env 覆盖查询。即 common 提供纯函数与静态基线，studio 提供 React 数据绑定层。

## 调用链路

### flag 检查链

```
app 根挂 <FeatureFlagProvider API_URL={API_URL}>（7 处：studio/_app、www、docs、learn…）
  └ useEffect: useAuth() isLoading 完成后 processFlags()
      ├ ensureGroupContext(): hasConsented() ? POST /telemetry/identify（org/project 分组）
      ├ getFeatureFlags(API_URL, {organizationSlug, projectRef})   # PostHog 服务端评估
      └ getFlags(userEmail) → configcat.ts getClient()
          ├ 优先 NEXT_PUBLIC_CONFIGCAT_PROXY_URL（自建代理）
          │   └ waitForReady() 若 NoFlagData 则 dispose 回退直连
          └ NEXT_PUBLIC_CONFIGCAT_SDK_KEY 直连；getAllValuesAsync(new configcat.User(email, …, {is_staff}))
  └ setStore({configcat, posthog, hasLoaded: true})
组件: useFlag('dashboard-billing-page-v2') → context store
  ├ store 为空 → false（fail-closed）
  └ key 不存在 → console.error + false（拼错 key 不静默放行）
```

覆盖机制三层叠加：`vercel-flag-overrides` cookie（Vercel Flags 平台）→ `x-cc-flag-overrides`（仅 local/staging DevToolbar）→ ConfigCat 值。

### 遥测双通道

- **产品事件（服务端管道）**：`sendTelemetryEvent(API_URL, {...TelemetryEvent})` → `hasConsented()` false 即静默 return → `getSharedTelemetryData()` → POST `/telemetry/event`（header `Version: 2`，schema 来自 api-types 包）
- **页面浏览（客户端 PostHog 直连）**：`PageTelemetry` 组件（挂 5 个 app 根）——consent 前 first-touch 数据写**纯内存** store（不落设备存储，接受硬刷新丢失）；初始 pageview 解析 `_sb_first_referrer` cookie（跨 app 归因交接，365 天 TTL，edge middleware 写入）+ UTM/click-id（gclid/fbclid/ttclid 等 10 种）+ `$feature/<flagKey>`（flag 曝光随 pageview 上报，`sendBeacon`）；consent 到位才 `posthogClient.init()`，init 前事件进 pending 队列（上限 20，FIFO 淘汰）

**consent 是所有链路的第一道闸**：每个上报函数第一行查 `hasConsent`。自托管时整个 consent 系统跳过（`initUserCentrics` 直接 return）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `isFeatureEnabled` in `enabled-features/index.ts` | 静态 flag 纯函数 | `SnakeToCamelCase` 递归类型让数组调用返回 camelCase 对象 |
| `getFlags` in `configcat.ts` | ConfigCat 拉取 | 自建代理优先，NoFlagData 回退直连 |
| `sendTelemetryEvent` in `telemetry.tsx` | 服务端事件上报 | consent 前置；Unknown 占位 groups 剔除 |
| `detectPriorConsent` in `consent-state.ts:68` | 恢复 consent 决策 | 三态判别联合；**任何 schema 不匹配返回 null**——"过度授权是本域最坏方向的偏差" |
| `fireExposureIfNew` in `posthog-client.ts` | 实验曝光去重 | `safeSessionStorage` 存 `ph_exposed:<experimentId>` ↔ sessionId |
| `createSafeStorage` in `safe-storage.ts` | try/catch 包裹 Storage | 失败 no-op + `kind:action:key` 去重告警 |
| `debuggableNavigatorLock` in `gotrue.ts` | auth 锁诊断 | 超时用 BroadcastChannel('who-is-holding-the-lock') 广播定位持有者 |

</details>

## 核心实现

### 遥测事件类型体系：为什么 3876 行

`telemetry-constants.ts` 每个事件一个带 JSDoc 的 interface：`action`（如 `'cron_job_created'`，**只用已确立的过去式动词，新增动词需 @growth-eng 审核防数据污染**）、强类型 `properties`、`groups: TelemetryGroups`。文件头是命名规约，JSDoc 标 `@source studio, docs` 与 `@page`。末尾 `TelemetryEvent` 是数百成员的可辨识联合——`sendTelemetryEvent` 调用点编译期校验完整 payload；`TABLE_EVENT_ACTIONS` 用 `as const satisfies` 保证常量与 interface 的 action 字面量双向绑定。行数是事件数量的必然结果：studio/www/docs 三个 app 都上报，action 字符串一处拼错即 PostHog 聚合断流。

### fail-closed 的 consent 解析

`detectPriorConsent()` 返回 `PriorConsentDecision` 三态：`null | { kind: 'uniform-accept' } | { kind: 'decisions' }`。注释明确：任何 schema 不匹配返回 null 而非带子集继续——在 consent 域，过度授权（误开遥测）比误关更糟。配套的 PostHog 门面 `class PostHogClient`：防双 init 两阶段、pending 队列（events/groups/identify/exposures 四类，identify 同用户 merge properties 防覆盖）、`ref()` 防穿透（consent-state 用 valtio `ref(UC)` 包 Usercentrics SDK——注释记录过把 AI Assistant message 数组代理损坏的事故）。

### safe-storage 防什么

Safari 隐私模式/安全设置下访问 `localStorage` **直接 throw**（`gotrue.ts:14` 注释原话），iframe 嵌入也 throw。`createSafeStorage(kind)` 工厂返回 try/catch 包裹的同形 Storage API：所有读写变 no-op + 去重 warn，保证遥测/偏好在存储被禁时不崩应用。

### gotrue.ts 的工程深度

Navigator Locks 用于多 tab session 刷新互斥；`debuggableNavigatorLock` 对持有超 10 秒的锁用 BroadcastChannel 定位持有者并挂 Sentry；持久化 debug 日志写 IndexedDB 且 **clone 时删除 user/token/provider_token 字段**（脱敏）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Singleton + 门面 | `posthog-client.ts` 模块级 `posthogClient` | 防双 init + pending 队列 |
| 双读者 store | `consent-state.ts`：模块级 proxy（非 React Context） | 非 hook 路径（纯函数）也要读 consent——`hasConsented()` vs `useConsentState()` |
| Fail-closed 解析器 | `detectPriorConsent` | GDPR 域的偏差方向控制 |
| 版本冲突规避 | `first-referrer-cookie.ts` 用结构化 interface 而非直接 import Next 类型 | 各 app 锁不同 Next 版本（studio 15 / docs-www 16）的共享中间件代码 |
| 构建期类型安全 flag | `satisfies` + 递归条件类型 | key 拼错编译报错 |

## 模块间交互

studio 是最重消费者（`FeatureFlagProvider` 挂 pages/_app 与 TanStack `__root.tsx`；`useFlag()` 113 处）；www/docs 大量用 `posthogClient.getFeatureFlag()` 直读客户端 SDK（服务端评估缺 person context）；docs 用 enabled-features 做导航裁剪（`docs:*` key 群，`ENABLED_FEATURES_OVERRIDE_DISABLE_ALL` 用于生成裁剪版搜索索引）。`hooks/` 子目录的 `useParams` 被 `FeatureFlagProvider` 用来从路由解析 slug/ref，让 flag 加载自动带 org/project 上下文——hooks 既是工具箱也服务遥测/flag。wire format 全部引用 api-types 的 schema，common 不自造。

## 扩展方式

**新增静态 feature flag（self-hosted 可裁剪）**：`enabled-features/enabled-features.json` 加 `"logs:my_feature": true` → 组件 `useIsFeatureEnabled('logs:my_feature')` → self-hosted 用户 `ENABLED_FEATURES_LOGS_MY_FEATURE=false` 容器级关闭。类型系统保证 key 拼错编译报错。

**新增遥测事件**：`telemetry-constants.ts` 新增 interface（action 用已有过去式动词，新动词需 growth-eng 审）→ 加入 `TelemetryEvent` 联合 → 组件 `sendTelemetryEvent(API_URL, { action, properties, groups: { project: ref, organization: slug } })`。consent 过滤自动生效。

**平台可远程开关**：ConfigCat 控制台建 flag → `const myFlag = useFlag('my-flag')` → 需要实验曝光上报时 `posthogClient.captureExperimentExposure(experimentId, props)`（session 级去重自动生效）。对应测试：`consent-state.test.ts`（16.3k）、`first-referrer-cookie.test.ts`（15.4k）、`markdown-negotiation.test.ts`。
