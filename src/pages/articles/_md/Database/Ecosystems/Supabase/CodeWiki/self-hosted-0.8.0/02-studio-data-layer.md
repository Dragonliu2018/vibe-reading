---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "数据层"
date: "2026-09-20T18:10:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "Studio", "react-query", "openapi-fetch", "TypeScript"]
description: "Studio 数据层：openapi-fetch typed client、query key 工厂、三层权限模型与统一错误分类，全部平台数据访问的单一通道。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

`apps/studio/data/`（80+ 资源子目录）+ `hooks/misc/` + `packages/api-types` 构成 Studio 的数据层。它回答一个问题：**UI 组件如何以编译期安全的方式拿到平台数据**。答案是三件事：openapi-fetch typed client（路径/参数/响应全部从生成的 OpenAPI 类型锁定）、react-query + query key 工厂（缓存与失效）、`handleError` 统一错误分类。同时它划出一条重要边界——**平台 API（项目/组织/计费等元数据）与用户数据库（表/列/策略）是两条通道**，后者由 pg-meta 生成 SQL 走 `executeSql` 旁路（见 pg-meta 模块）。

## 模块架构

![Studio 数据层结构](/vibe-reading/images/articles/supabase-internals/data-layer-flow.svg)

主链自左向右：UI 组件 → react-query hooks（query key 工厂）→ 纯 fetcher 函数（资源目录）→ openapi-fetch client → 双中间件 → 平台 API。`api-types` 包（`openapi-typescript` 从 Management API spec 生成，~45k 行类型）以编译期类型身份贯穿 fetcher 层——`data/api.d.ts` 只有一行转发（注释明令 "Avoid importing this file and import the types directly from api-types"）。旁路链：数据库对象 hooks 走 `executeSql`（148 文件扇入的 I/O 总线）。权限门控（`useAsyncCheckPermissions`，271 文件扇入）在组件渲染前 gate。

## 调用链路

以 project detail 查询为例的完整链：

```
组件 useSelectedProjectQuery()                    hooks/misc/useSelectedProject.ts
  └→ useProjectDetailQuery({ ref })                data/projects/project-detail-query.ts
       queryKey: projectKeys.detail(ref)           data/projects/keys.ts
       queryFn → getProjectDetail()
         └→ get('/platform/projects/{ref}', {...})  data/fetchers.ts（createClient<paths>）
              │  '/platform/projects/{ref}' 路径串编译期校验必须是 paths 的 key
              ├─ onRequest 中间件：constructHeaders() 注入 X-Request-Id + Bearer
              │    + pgMetaGuard()：无 x-connection-encrypted 的 pg-meta 请求本地直接拒绝
              ├─ data 类型 = components['schemas']['ProjectDetailResponse']
              └─ onResponse 中间件：错误 body 注入 code/requestId/retryAfter/requestPathname
         if (error) handleError(error)             → throw ResponseError / UnknownAPIResponseError
       react-query retry：data/query-client.ts 全局策略读 error.code/requestPathname
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `client` in `data/fetchers.ts` | openapi-fetch 实例 | `querySerializer: { array: { style: 'form', explode: false } }`；fetchHandler 把 "Failed to fetch" 转友好错误 |
| `handleError` in `data/fetchers.ts` | 错误分类统一抛出（384 文件扇入） | `ERROR_PATTERNS` 正则 → `ClassifiedError`；无 message 的未知错误 Sentry 兜底 |
| `pgMetaGuard` in `data/fetchers.ts` | pg-meta 端点前置校验 | 省一次注定失败的网络往返；补默认 `x-pg-application-name` |
| `normalizeEmptyBodyResponse` | 修 HTTP/3/HEAD 空 body 兼容 | `response.json()` 对无 Content-Length 的空 body 抛错的 workaround |
| `getProjectDetail` in `data/projects/project-detail-query.ts` | 项目详情 fetcher | 含 hibernated 项目自动唤醒 + `setQueryData` 热替换 replicas |
| `useSelectedProjectQuery` in `hooks/misc/useSelectedProject.ts` | URL ref → 项目详情单点封装（431 文件扇入） | `select` 派生 `parentRef`（branch 归属 parent） |
| `doPermissionsCheck` in `hooks/misc/useCheckPermissions.ts` | 三层权限求值 | project 级优先 → org 级回退 → json-logic condition |

</details>

## 核心实现

### openapi-fetch client 与中间件

`data/fetchers.ts`（407 行）的核心是 `createClient<paths>`。openapi-fetch 的返回是 `{ data, error }` 联合——**error 不会 throw**，调用方必须手动 `if (error) handleError(error)`，这是全模块的统一约定。两段中间件（`client.use`）：

- **onRequest**：`constructHeaders()` 注入 `X-Request-Id`（uuidv4）+ `Authorization: Bearer`；然后 `pgMetaGuard(request)`——对 `/platform/pg-meta/` 端点做前置校验，无有效 `x-connection-encrypted` 直接本地 throw 一个 `ResponseError`。
- **onResponse**：成功路径修空 body 兼容 bug；失败路径把 body 重写为带 `code/requestId/retryAfter/requestPathname` 的 JSON 再构造新 Response——**错误元数据在这一层统一注入**，`handleError` 和 `query-client.ts` 的智能重试才能读到。

类型从哪来：`packages/api-types` 的 `codegen` script 用 `openapi-typescript --redocly` 声明两个 API root（管理 API `api.d.ts` 13,474 行 + 平台 API `platform.d.ts` 31,565 行），`index.ts` 用 interface extends 合并成统一 `paths/operations/components`。效果是：后端 spec 变 → `pnpm codegen` → 前端**编译期**发现不匹配的调用。

### query key 工厂

每个资源目录一个 `keys.ts`，导出嵌套数组工厂：

```ts title="apps/studio/data/tables/keys.ts"
export const tableKeys = {
  names: (projectRef) => ['projects', projectRef, 'table-names'] as const,
  list: (projectRef, schema, options) =>
    ['projects', projectRef, 'tables', schema, options].filter(Boolean),
  retrieve: (projectRef, name, schema) =>
    ['projects', projectRef, 'table', schema, name].filter(Boolean),
}
```

要点：第一段是作用域实体（`['projects', projectRef, ...]`）；`retrieve`（单数）vs `list`（复数）区分单查与列表；`.filter(Boolean)` 抹掉 undefined 段，保证 `projectRef` 未就绪时 key 稳定可比较。历史上 `['projects', ref]` 与 `['project', ref]` 两种前缀并存——`data/sql/execute-sql-mutation.ts` 里作者注释承认 "grouping our query keys better" 是待还的债，失效操作需注意前缀匹配。

### 一个资源 hook 的标准三层

`data/tables/table-create-mutation.ts` 展示完整模式：**纯函数 fetcher**（可单测、可 prefetch）→ **类型三元组导出**（`Data = Awaited<ReturnType<typeof getXxx>>`、`Error = ResponseError`、显式 Variables interface）→ **hook 包装**（`useQuery` + 工厂 key + `enabled: enabled && typeof ref !== 'undefined'` + 业务化 staleTime；mutation 默认 `onError` toast + `onSuccess` invalidate）。官方脚手架在 `data/__templates/`（resource-query / resources-query / resource-update-mutation + README），是新资源开发的钦定路径。

### 三层权限模型

`useCheckPermissions` 的 `doPermissionsCheck` 求值顺序：

1. **project 级优先**：`permission.project_refs?.includes(projectRef)` 且 action/resource 都匹配（`toRegexpString` 把 `.` 转义、`%` 变 `.*` 的通配匹配）；
2. 否则回退 **organization 级**（`project_refs` 为空的行）；
3. condition 求值用 **json-logic-js**（`jsonLogic.apply(condition, { resource_name, ...data })`）；
4. **restrictive 语义**：任一 restrictive 权限 condition 为 null 即整体拒绝——blacklist 优先于 whitelist；
5. **profile 级**在入口：未登录直接 `can: false`；branch 项目自动把 `projectRef` 归一到 `parent_project_ref`。

自托管逃生门：`if (!IS_PLATFORM) return true`。平行的 **entitlements 体系**（`useCheckEntitlements` + `data/entitlements/`）按 plan 维度（numeric/set 两型 config）做功能门控，与角色权限互补。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Query key factory | 各资源目录 `keys.ts` | 集中失效面；`.filter(Boolean)` 保稳定 |
| Typed fetch | `data/fetchers.ts` `createClient<paths>` | spec 是唯一真源，删端点 = 编译错误而非运行时 404 |
| 错误分类闸门 | `handleError` + `data/error-patterns.ts`（Map 防重复注册） | `{data, error}` 联合世界 → 异常世界的唯一通道 |
| 缓存写回 | `useSetProjectStatus` in `project-detail-query.ts` | `setQueriesData` 模拟项目状态机，避免轮询闪烁 |
| 全局 retry 策略 | `data/query-client.ts` | 4xx 不重试（429 除外）、特定端点永不重试 |
| 脚手架模板 | `data/__templates/` | 新资源开发路径官方化 |

## 模块间交互

`data/` 是 `packages/api-types` 的唯一运行时消费者（其余资源文件经 fetchers 的 `get/post` 间接获得类型）。数据库对象 hook（`useTablesQuery` 等）用 `@supabase/pg-meta` 生成 SQL 后喂 `executeSql`——同一模块内两种数据来源在 hook 层统一成相同 react-query 形态。权限 hook 被 UI 层 271 个文件消费（典型如 `DisplayApiSettings.tsx:41`），`isLoading` 用于避免布局跳动。SQL Editor 的 mutation hook（`useExecuteSqlMutation`）在 `onSuccess` 里反向失效 `['projects', projectRef]` 前缀下的大量缓存——DDL 执行后 Dashboard 对象展示必须刷新。

## 扩展方式

**新增平台 API 资源**（官方路径 `data/__templates/` 四步）：spec 更新后 `packages/api-types` 跑 `pnpm codegen` → 建 `data/<new-resource>/keys.ts`（`['projects', projectRef, 'new-resources']` 前缀）→ 复制 `__templates/resource-query.ts` 实现 fetcher（端点不在生成的 spec 里直接编译报错）→ `useNewResourceQuery` 包装（`enabled && typeof projectRef !== 'undefined'`）。列表/变更再加 `resources-query.ts` / `resource-update-mutation.ts`，mutation 的 `onSuccess` 用同工厂 key invalidate。

**给页面加权限门控**：`const { can, isLoading } = useAsyncCheckPermissions('api_keys.read', 'projects/{ref}/settings/api-keys')`——action 用 `@supabase/shared-types` 的 `PermissionAction` 字符串，`can` 控制 disabled/隐藏。注意 `data/permissions/permissions-query.ts` 的响应类型尚是 `as unknown as PermissionsResponse` 断言（TODO 注释），新 action 需确认后端已下发。

**平台 spec 新增字段/端点**：`pnpm codegen` 重新生成 → 受影响 `*-query.ts` 的 Data 类型自动更新 → 编译器把不匹配的组件用法标红，逐个修 UI；`fetchers.ts` 零改动。
