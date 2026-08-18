---
source:
  type: "源码解读"
  project: "Langfuse"
  url: "https://github.com/langfuse/langfuse"
title: "前端架构与 Tracing UI"
date: "2026-08-18T16:35:50+08:00"
category: ["AI", "Agent", "Observability", "Langfuse", CodeWiki, "4.11.0"]
tags: ["Langfuse", "Next.js", "tRPC", "Feature-based", "React Table"]
description: "Langfuse 前端：76 feature 垂直切片、tRPC 端到端类型、共享 filter/table 基础设施、列式访问原则落地。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Langfuse/CodeWiki/4.11.0/00-overview)

---

## 模块定位

这是 Langfuse 的观察产品面——用户在浏览器里看 trace 树、配 eval、跑实验、迭代 prompt。职责边界：UI 渲染 + 前端到 server 的类型安全 API 调用（tRPC）+ 共享列表/过滤/分页基础设施。它是代码量最大的部分（`web/src/features/` 76 个 feature ~294k 行），但大部分是垂直业务切片，横向基础设施集中在 `features/filters/`、`components/table/`、`server/api/`。

## 模块架构

```
web/src/
├── pages/                 # Next.js pages router（project/[projectId]/traces/…）
├── features/              # 76 个 feature 垂直切片
│   ├── traces/ (40k)      # trace 列表+详情+AdvancedJsonViewer+TraceTree
│   ├── evals/ (23k)       # eval 配置与执行
│   ├── datasets/ (16k), widgets/ (16k), experiments/ (12k)
│   ├── filters/ (11k)     # ★ 共享过滤器基础设施
│   ├── score-analytics/ (10k), dashboard/ (9k), prompts/ (8k)
│   ├── playground/ (5.8k) # LLM playground（SSE 流式，独立 handler）
│   └── …（76 个）
├── components/table/      # ★ 通用 DataTable（@tanstack/react-table）
├── server/api/
│   ├── root.ts            # ★ appRouter 聚合 ~60 feature router
│   ├── trpc.ts            # ★ createTRPCContext + procedure 层级
│   └── routers/           # 历史位置 router（traces/scores/observations）
├── stores/, hooks/, utils/
└── ee/features/           # 企业版 router（billing/sso/uiCustomization/adminApi）
```

## 调用链路

trace 列表页查询链路（典型）：

```
web/src/pages/project/[projectId]/traces/index.tsx
  └─ <TracesTable> (components/table/use-cases/traces.tsx)
       └─ api.traces.all.useQuery({projectId, filter, ...})  // tRPC client hook
            └─ createTRPCNext<AppRouter> → splitLink(httpBatch/http) → POST /api/trpc
                 └─ [trpc].ts createNextApiHandler({router: appRouter, createContext})
                      └─ createTRPCContext: getServerAuthSession() → {session, headers, prisma}
                      └─ appRouter.traces.all (protectedProjectProcedure)
                           ├─ enforceUserIsAuthedAndProjectMember（解析 projectId，注入 orgId/projectRole）
                           └─ traces.ts all() → getTracesTable (shared/server/services/traces-ui-table-service.ts)
                                ├─ createFilterFromFilterState (FilterState → CH filter)
                                ├─ sqlSelect = "rows" 窄列（12 列，不含 input/output）
                                └─ queryClickhouse({query, params}) → ClickHouse traces 表
```

trace 详情页链路：

```
pages/.../traces/[traceId].tsx
  └─ useTraceDetailData (features/traces/hooks/useTraceDetailData.ts)
       └─ api.traces.byIdWithObservationsAndScores.useQuery()
            → protectedGetTraceProcedure
                 └─ enforceTraceAccess 中间件（预取 trace，excludeInputOutput:true）
                      → getTraceByIdFromEventsTable + parseIO(verbosity)
            → traces.byIdWithObservationsAndScores
                 ├─ getObservationsForTrace({includeIO: false})  # 先查列表不含 IO
                 └─ getScoresAndCorrectionsForTraces()
```

## 核心实现

### tRPC 端到端类型安全

`server/api/root.ts` 手动聚合 ~60 feature router（traces/evals/datasets/dashboard/prompts/experiments/observations/scores/sessions/organizations/projects/table/batchAction/automations/monitors/… + ee 的 cloudBilling/ssoConfig/verifiedDomain/uiCustomization/adminApi）。`export type AppRouter = typeof appRouter` 是前端类型推断的唯一来源——无 OpenAPI codegen 步骤。

```typescript title="web/src/utils/api.ts"
export const api = createTRPCNext<AppRouter>({
  config() {
    return {
      links: [
        buildIdLink(),
        requestTooLargeDiagnosticsLink(),
        loggerLink({ enabled: () => process.env.NODE_ENV === "development" }),
        splitLink({
          condition(op) { return op.context.skipBatch === true || true; },
          true: splitLink({
            condition: shouldSendQueryAsPost,  // 大 payload 走 POST 避免 HTTP 431
            true: httpLink({ url: `${getBaseUrl()}/api/trpc`, transformer: superjson, methodOverride: "POST" }),
            false: httpLink({ url: `${getBaseUrl()}/api/trpc`, transformer: superjson }),
          }),
          false: httpBatchLink({ url: `${getBaseUrl()}/api/trpc`, maxURLLength: 2083 }),
        }),
      ],
      transformer: superjson,  // 支持 Date/BigInt/Decimal 等 CH 返回类型
    };
  },
});
```

前端 `api.traces.all.useQuery()` 的输入/输出类型由 `AppRouter` 推断，`.input(z.object({...}))` 的 zod schema 既是类型定义又是运行时校验。`superjson` 处理 ClickHouse 返回的 `BigInt`/`Decimal`/`Date`。`splitLink` 把大 payload（如 batchIO 查询）切到 POST 避免 URL 过长触发 HTTP 431。

### Feature-based 架构

每个 feature 是自包含垂直切片：

```
web/src/features/traces/
├── server/          # tRPC router 辅助逻辑（buildTraceExport.ts, legacyIoSearch.ts）
├── components/      # TraceTree, TraceDetailBody, AdvancedJsonViewer/ 等
├── hooks/           # useTraceDetailData, useSelectedObservation
├── stores/, contexts/, fns/, types.ts, TracePage.tsx
```

> **历史例外**：早期 router（traces/scores/observations）在 `server/api/routers/` 下（早于 feature 重构就存在）；新建 feature 的 router 在 feature 内（如 `evals/server/router.ts`）。

### 共享 Filter/Table/Pagination 基础设施

76 个 feature 都要列表+过滤+分页，抽象一次复用：

- `packages/shared/src/interfaces/filters.ts` — `singleFilter` discriminatedUnion（12 种 filter 类型）+ `filterOperators` + `paginationZod` + `orderBy`
- `web/src/features/filters/lib/filter-config.ts` — `FilterConfig`（8 种 Facet 类型：Categorical/Boolean/Numeric/String/KeyValue…）
- `web/src/features/filters/config/` — 每 feature 一个 config（`traces-config.ts` ~100 行即可得完整过滤侧边栏）
- `packages/shared/src/server/queries/clickhouse-sql/factory.ts` — `createFilterFromFilterState` 把前端 `FilterState` 转 ClickHouse SQL filter（参数化防注入）
- `web/src/components/table/` — 通用 `DataTable`（`data-table.tsx` 基于 @tanstack/react-table）+ `data-table-controls.tsx`（列可见性/行高/导出）+ `use-cases/traces.tsx` 等 feature 专用配置

### 列式访问原则落地

这是前端贯彻 ARCHITECTURE_PRINCIPLES 的核心——list 用窄列、详情才查 raw。三层控制：

1. **SQL SELECT 列控制**（`traces-ui-table-service.ts`）：
   - `select: "rows"` → 12 个窄列（id/name/timestamp/tags/bookmarked/release/version/user_id/environment/session_id/public），不含 input/output/metadata
   - `select: "identifiers"` → 3 列（id/projectId/timestamp），批量操作用
   - `select: "metrics"` → JOIN 聚合列（latency/cost/usage/scores_avg），仍不含 raw IO
   - `select: "count"` → `uniqExact(t.id) as count`

2. **trace 详情预取排除大字段**（`enforceTraceAccess` 中间件）：
   ```typescript
   await getTraceByIdFromEventsTable({
     traceId, projectId,
     excludeInputOutput: true,   // 权限校验不需要 IO
     excludeMetadata: true,     // 权限校验不需要 metadata
     renderingProps: { truncated: true, shouldJsonParse: false },
   })
   // 然后 parseIO(clickhouseTrace.input, verbosity) 按 compact/truncated/full 控制
   ```

3. **observation 查询分两步**：`byIdWithObservationsAndScores` 先查列表 `getObservationsForTrace({includeIO: false})`；用户点某 observation 才单独查其 IO。

4. **JOIN 惰性化**：`requiresObservationsJoin` / `requiresScoresJoin` 只在 filter/orderBy 命中 observations/scores 表时才 JOIN，默认排序 + 无 score filter 时不 JOIN。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Feature-based 架构 | `web/src/features/*` 垂直切片 | feature 内聚，改一个功能不动别的，76 feature 并行开发不冲突 |
| tRPC 端到端类型 | `appRouter` + `createTRPCNext` | 无 codegen，schema 即类型，开发迭代快 |
| superjson transformer | `utils/api.ts` | 处理 CH 返回的 BigInt/Decimal/Date |
| splitLink 请求路由 | 大 payload 走 POST | 避免 HTTP 431 URL 过长 |
| 共享 FilterConfig + DataTable | `features/filters/` + `components/table/` | 抽象一次，每 feature 只写 config |
| 列式访问（窄列/详情分层） | `traces-ui-table-service.ts` select 分支 | 列表快，raw payload 只在详情查 |
| JOIN 惰性化 | `requiresObservationsJoin`/`requiresScoresJoin` | 默认不 JOIN，命中才 JOIN |
| 中间件预取资源 | `enforceTraceAccess` | 权限校验顺便预取，router 不重复查 |
| procedure 层级 | public/authed/project/org/admin/trace | 权限递增，声明式组合 |

## 模块间交互

依赖 `@langfuse/shared`（repositories、domain、interfaces/filters、tableDefinitions）、`@langfuse/ee`（SSO/RBAC/billing router 混入 appRouter）。`features/filters/`、`components/table/` 是横切基础设施被 76 feature 复用。playground 的 `chatCompletionHandler.ts` 走独立 Next.js API route + 自定义 auth + SSE 流式（tRPC 不原生支持 SSE streaming，是 feature-based 的有意例外）。

## 核心设计决策

**为什么 tRPC 而非 REST+OpenAPI**：端到端类型安全无 codegen（新增 procedure 前端立即获类型提示）、zod schema 即类型即运行时校验不分离、superjson 处理 CH 特殊类型、开发迭代快（改 procedure 不用同步 spec→生成→前端三步）。

**为什么 feature-based 而非按技术分层**：feature 内聚（改 traces 功能时组件/hooks/stores/types 都在 `features/traces/`，不跨目录跳转）、76 feature 并行开发不 merge conflict、feature 内 server+client 共存（router 辅助逻辑与组件放一起逻辑完整）。

**为什么共享 filters/table 基础设施**：76 feature 都要列表+过滤+分页，抽象 `FilterConfig` + `DataTable` + `paginationZod` 一次，每 feature 只写一个 config 文件（~100 行）就得完整过滤侧边栏；`singleFilter` 在 shared 定义一次，前端到 CH 全链路类型安全，`createFilterFromFilterState` 带 SQL 注入防护。

**为什么 traces feature 40k 行最大**：核心观测面包含——自研 `AdvancedJsonViewer`（~30 文件，虚拟化 JSON 查看器，`byteJsonIndex.ts` 字节级索引、搜索、高亮、懒加载大 JSON、input/output/metadata 分 tab、评论标注 `commentRanges`）、`TraceTree`+`VirtualizedTree`（树状 trace 渲染虚拟化滚动）、`SpanContent`/`ToolCallInvocationsView`（agent 工具调用展示）、`buildTraceExport`（trace 导出）、`legacyIoSearch`（旧版 IO 搜索兼容）。

**前端如何贯彻"list 用窄列、详情才查 raw"**：见上文"列式访问原则落地"四层控制——SQL SELECT 列控制 + 详情预取排除大字段 + observation 查询分两步 + JOIN 惰性化。这是 ARCHITECTURE_PRINCIPLES "keep list views on compact query-optimized representations, fetch large raw payloads only for focused detail views" 在前端的直接落地。

## 扩展方式

**新增一个 feature**（如 `agents`）：
1. 创建 `web/src/features/agents/`（含 `components/` `hooks/` `server/router.ts`）
2. `server/router.ts` 用 `protectedProjectProcedure.input(...).query(...)` 定义 router
3. `server/api/root.ts` 导入注册：`agents: agentRouter`
4. `pages/project/[projectId]/agents/index.tsx` 创建页面
5. 如需列表页：`features/filters/config/agents-config.ts` 复用 `FilterConfig` + `DataTable`
6. 前端 `api.agents.all.useQuery(...)`——类型自动推断

**新增一个 tRPC procedure**：对应 router 加 `protectedProjectProcedure.input(z.object({...})).query(async ({input, ctx}) => {...})`，前端立即 `api.<feature>.<proc>.useQuery(...)`。

**加一个过滤器操作符**（如 string 的 `regex`）：
1. `packages/shared/src/interfaces/filters.ts`：`filterOperators.string` 加 `"regex"`
2. 前端 filter UI 更新操作符选项
3. `packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts`：`StringFilter` 加 `regex` 分支生成 `match(field, {value:String})`
4. `packages/shared/src/server/filterToPrisma.ts`：Prisma 转换加分支
5. 各 feature 的 filter-config 可选更新

> `web/src/stores/` 推测为 Zustand 全局 stores（如 column-visibility、version-update），未逐一深入。`web/src/hooks/` 全局 hooks 同理。这两个目录是次要基础设施，主要 state 在 feature 内。
