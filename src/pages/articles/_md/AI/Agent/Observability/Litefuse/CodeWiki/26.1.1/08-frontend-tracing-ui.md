---
source:
  type: "源码解读"
  project: "Litefuse"
  url: "https://github.com/litefuse/litefuse"
title: "前端 Tracing UI"
date: "2026-08-18T18:00:56+08:00"
category: ["AI", "Agent", "Observability", "Litefuse", CodeWiki, "26.1.1"]
tags: ["Litefuse", "Next.js", "tRPC", "React", "Tracing UI"]
description: "Litefuse 前端 Tracing UI：Next.js Pages Router、trace2 v2 组件 6 层 Context Provider、tRPC 端到端类型 API、声明式 tableDefinitions+sqlInterface 查询。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Observability/Litefuse/CodeWiki/26.1.1/00-overview)

---

## 模块定位

这是读路径的 UI 与 API 编排层——Next.js（Pages Router）Web 应用，把浏览器请求经 tRPC 转为 Doris 查询并渲染 trace 树、dashboard、evals、prompts 等。它独立成模块，是因为前端组件组合、tRPC 类型契约、声明式查询编译都有专门逻辑，且与写侧后台（worker）完全解耦——读路径 web 直连 Doris，跳过队列与 worker。

## 模块架构

三层：`pages/`（Pages Router 路由即文件）→ `server/api/routers/`（tRPC，约 40 个子 router 聚合在 `root.ts`）→ `server/api/services/`（`tableDefinitions` 声明式表定义 + `sqlInterface` Zod 查询 schema，编译为参数化 SQL 经 `queryDoris` 执行）。前端 `components/trace2/` 是 trace UI v2，用 6 层 Context Provider 解耦数据/状态/UI。`features/` 按领域组织（dashboard/trace2/evals/prompts 各自含 components/server/lib）。

## 调用链路

```
浏览器 /trace/[traceId]
  → [traceId].tsx:10 getServerSideProps → getTracesByIdsForAnyProject([traceId]) 查 PG 拿 projectId → redirect /project/[projectId]/traces/[traceId]
  → TracePage.tsx:29 api.traces.byIdWithObservationsAndScores.useQuery()
  → tRPC traceRouter.byIdWithObservationsAndScores (traces.ts:340-416)
      → protectedGetTraceProcedure (trpc.ts:518, enforceTraceAccess 中间件)
      → getTraceById (trpc.ts:440 → repositories/traces.ts:462)
          ├─ buildTraceAggregationQuery (traces.ts:57, CTE trace_scalars + trace_root, FROM events_full, WHERE trace_id+project_id)
          └─ queryDoris (repositories/doris.ts:119) → DorisParameterProcessor → dorisClient().queryWithParams → DorisClient.query (client.ts:280)
  → Promise.all (traces.ts:388): getObservationsForTrace + getScoresAndCorrectionsForTraces
  → convertDorisToDomain → Trace 组件渲染 trace 树 (components/trace2/Trace.tsx → TraceTree.tsx)

Dashboard 查询:
  → api.dashboard.scoreHistogram.useQuery() → dashboard-router.ts:421 scoreHistogram
  → sqlInterface.extend({...}) 校验 → executeQuery(projectId, query, "v2") (queryExecutor.ts:22)
  → QueryBuilder.build() 编译 SQL → queryDoris (queryExecutor.ts:50) → DatabaseRow[]
```

## 核心实现

### Trace 组件 6 层 Context Provider

```tsx title="web/src/components/trace2/Trace.tsx"
export function Trace({ trace, observations, scores, corrections, projectId, context }: TraceProps) {
  return (
    <ViewPreferencesProvider>
      <TraceDataProvider trace={trace} observations={observations} ...>
        <TraceGraphDataProvider>
          <SelectionProvider>
            <SearchProvider>
              <JsonExpansionProvider>
                <TraceContent />
              </JsonExpansionProvider>
            </SearchProvider>
          </SelectionProvider>
        </TraceGraphDataProvider>
      </TraceDataProvider>
    </ViewPreferencesProvider>
  );
}
```

每层职责单一：TraceData=只读数据、Selection=选中状态、Search=搜索、JsonExpansion=JSON 折叠、ViewPreferences=视图偏好、TraceGraphData=图数据。`TracePage`（`TracePage.tsx:29`）负责 tRPC 数据获取与页面布局，`api.traces.byIdWithObservationsAndScores.useQuery` 拉取后渲染 `<Trace>`。`TraceDataContext` 调 `buildTraceUiData`（`tree-building.ts`）用**显式队列拓扑排序（非递归）** O(N) 构建 trace 树，支持 10k+ 深度树防栈溢出。

### tRPC router 与 service 层

`tRPC routers`：`traceRouter`（`traces.ts`，`all`/`countAll`/`metrics`/`filterOptions`/`byId`/`byIdWithObservationsAndScores`/`deleteMany`/`bookmark`/`publish`/`updateTags`/`getAgentGraphData`）、`dashboardWidgetRouter`、`observationsRouter`。Service 层 `tableDefinitions.ts` 声明式表定义（每个 table 声明 `table`(FROM) + `columns`(ColumnDefinition[])，如 `traces_observations: { table: 'traces t LEFT JOIN observations o ON ...' }`）；`sqlInterface.ts` Zod 定义查询结构 `from`(枚举表名) + `filter` + `groupBy` + `select` + `orderBy` + `limit`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pages Router | `web/src/pages/trace/[traceId].tsx` 即路由，`getServerSideProps` SSR 重定向 | 路由即文件，SSR 做 project 归属重定向 |
| tRPC | `protectedProjectProcedure`（`trpc.ts:251` enforceUserIsAuthedAndProjectMember） | 端到端类型安全，前后端同仓无需维护 OpenAPI/客户端 SDK；superjson 保证 Date/Decimal 序列化 |
| Feature-based | `features/dashboard`、`features/trace2`、`features/evals` 各含 components/server/lib | feature 内聚，降低跨 feature 耦合 |
| 声明式表定义 + SQL 接口 | `tableDefinitions.ts` + `sqlInterface.ts` + `queryBuilder.ts` 编译 | 统一多表 JOIN 定义，避免散落 SQL 字符串；Zod 校验防注入；编译逻辑集中可维护 |
| Context Provider 组合 | `Trace.tsx` 六层 Provider 嵌套 | 解耦数据/状态/UI 三层，替代 v1 prop drilling |
| 迭代式树构建 | `tree-building.ts` 显式队列拓扑排序 | O(N) 防 10k+ 深树栈溢出 |

## 模块间交互

前端组件（TracePage/DashboardTable）→ tRPC useQuery/useMutation → tRPC router → service 分两路：`queryDoris` → Doris（事实数据）+ `prisma` → PostgreSQL（project/user/dashboard 元数据）。trace2/dashboard/evals/prompts/datasets 等 features 并列于 `features/`，各自独立 server router + 前端组件，`root.ts:62` `appRouter` 统一聚合。`traces.ts` 的 `bookmark`/`publish`/`updateTags` 同时写 `traces` 表和 `events_full` 表（OTel 迁移双写）。

## 扩展方式

加 trace 详情一个 tab：① `trace2/config/trace-view-config.ts` 新增 tab 定义；② `trace2/components/_layout/TracePanelNavigation.tsx` 添加导航入口；③ `trace2/components/_layout/TracePanelDetail.tsx` 根据选中 tab 渲染新面板；④ 如需新数据，`TracePage.tsx:29` 添加 `api.traces.xxx.useQuery`，`traces.ts` 添加对应 procedure。加一个 tRPC 查询：`traces.ts` 在 `traceRouter` 内添加 `protectedProjectProcedure.input(z.object({...})).query(async ({input, ctx}) => {...})`，调用 `getTracesTable` 或 `queryDoris`，前端 `api.traces.xxx.useQuery()` 直接使用（类型自动推导）。对应测试：`web/src/__tests__/` + `web/src/__e2e__/`（Playwright）。
