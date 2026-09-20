---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "应用骨架"
date: "2026-09-20T18:05:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "Studio", "TanStack Start", "Next.js", "valtio"]
description: "Studio 应用骨架：Next.js → TanStack Start 双框架并行迁移、compat/next shim 层、valtio 全局状态与 withAuth 认证门控。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

Studio（`apps/studio`，~58.7 万行）是 Supabase 的 Dashboard 控制台，也是本仓库的绝对主体。它当前最特殊的架构状态是：**正处在 Next.js pages router → TanStack Start 的双框架并行迁移期**——两套路由树同时出货、两个构建管线同时可跑、E2E 每次 PR 双轨验证。理解这个骨架是读其它 Studio 模块（数据层、SQL Editor、Grid）的前置条件：它们的代码都同时被两个运行时加载。

本模块覆盖路由与运行时分发（`routes/` + `pages/` + `compat/`）、全局状态（`state/`）与认证（`hooks/misc/withAuth.tsx`）。

## 模块架构

![Studio 双框架并行](/vibe-reading/images/articles/supabase-internals/skeleton-dual-framework.svg)

骨架由四个正交部分组成。**运行时分发**：`scripts/dispatch.js` 读 `STUDIO_FRAMEWORK` env（默认 next），把 `pnpm dev/build/start` 转发到 `next:*` 或 `tanstack:*` 脚本。**双路由树**：`pages/` 是 Next 旧路由（迁移期禁止删除——大多数 `routes/` 文件以 re-export 方式复用它的默认导出），`routes/` 是 TanStack 文件路由（`routeTree.gen.ts` 由 Vite 插件生成，禁止手编）。**兼容 shim 层**：`compat/next/` 把 `next/router`、`next/link` 等十余个模块重定向到 TanStack 实现，仅对 Vite 生效（Next 构建直接用真 next 包）。**状态层**：valtio 全局状态 + nuqs URL 状态 + react-hook-form 表单，服务器状态归 react-query。

## 调用链路

启动分流链（`scripts/dispatch.js`，64 行）：

```
pnpm dev
└─ dispatch.js
    ├─ readEnvFiles(studioRoot, ['.env', '.env.local'])
    ├─ framework = STUDIO_FRAMEWORK === 'tanstack' ? 'tanstack' : 'next'
    └─ spawn('pnpm', ['run', `dev:${framework}`])
         ├─ next:next    → next dev -p 8082 → pages/ 路由
         └─ dev:tanstack → vite dev → routes/ 路由树
              └─ start:tanstack → scripts/serve.js
                   （standalone HTTP：静态资源 + dist/server fetch handler）
```

TanStack 侧请求链：

```
浏览器请求
└─ routes/__root.tsx beforeLoad
│    └─ matchRedirect(...) → throw redirect({ to, search, hash })   // 必须 to 而非 href，否则 Link preload 递归（TanStack issue #7141）
└─ RootComponent：~18 层 Provider 链 → ClientOnly(ShellFallback) → Outlet
└─ routes/index.tsx beforeLoad（"/" 永不渲染）
│    ├─ IS_PLATFORM → redirect('/org' 或 '/new/new-project')
│    └─ 自托管 → redirect('/project/default')
└─ routes/_app.tsx AppShell → DefaultLayout → Outlet
└─ 叶子路由，如 routes/project.[_].tsx
     └─ re-export pages/project/_/[[...routeSlug]] 的默认导出（Path A）
```

认证链（`hooks/misc/withAuth.tsx`）在页面级介入：平台模式下检查 `useAuth()` session → MFA AAL（`useAuthenticatorAssuranceLevelQuery`，超时 10s 弹 SessionTimeoutModal）→ 不满足则 `redirectToSignIn()`；自托管下 `if (!IS_PLATFORM) return WrappedComponent` 一行短路，零开销放行。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `dispatch.js` 主流程 | env 读取 + 框架分流 + spawn | 故意不注入整个 .env——子进程 serve.js/vite 要自己加载并保留覆盖权 |
| `createRootRouteWithContext` in `routes/__root.tsx` | 根路由 + RouterContext（含 queryClient） | SSR query 集成 `setupRouterSsrQueryIntegration` in `router.tsx` |
| `parseSearch/stringifySearch` in `router.tsx` | Next 风格 search params | "2" 不强转数字；TanStack 默认 JSON 序列化会破坏全 app 语义 |
| `toWebHandler` in `compat/next/api.ts` | Next API handler → Web Request/Response | 迁移 `pages/api/**` 到 TanStack server route 的桥 |
| `withAuth` in `hooks/misc/withAuth.tsx` | 认证 + MFA AAL HOC | `isNextPageWithLayout` 时透传 getLayout |
| `registerChunkErrorBackstop` in `router.tsx` | vite:preloadError → 防循环 reload | 10s 防抖避免刷新风暴 |

</details>

## 核心实现

### 双框架迁移的工程纪律

`TANSTACK_MIGRATION.md`（581+ 行的临时跟踪文档）开篇即定下运行时模型：Next build 保留作 fallback，用于 **bisect 回归与双轨出货**。三条铁律：

1. **迁移期禁止删除任何 `pages/` 文件**——Path A 路由 re-export 其默认导出，Next 文件对两个运行时都是 load-bearing 的，删除即双断。
2. **body-move 与 pages 删除只发生在最终 cleanup pass**（FE-3106 跟踪）——不折进单路由 PR。
3. **新代码禁止 `next/router` / `next/link`**——只用原生 TanStack API；`compat/next/` shim 只服务存量页面。

配套的防退化护栏值得注意：Vite 插件 `studio-next-compat`（`vite.config.ts:51`）对**未注册**的 `next/*` import 打构建警告；路由文件名用 path-as-filename（如 `project.[_].tsx` 而非目录 + index）绕过 TanStack router-generator 的 `originalRoutePath` 抹除 bug（文件内注释引用 `getRouteNodes.js:132`）。

### compat/next shim 层

`vite.config.ts:30-39` 的 alias 表把 `next/router`、`next/link`、`next/head`、`next/image`、`next/legacy/image`、`next/dynamic`、`next/navigation`、`next/script`、`next/server`、`next/compat/router` 全部重定向到 `compat/next/` 下的自研实现。工作量最大的是 `router.ts`：`useRouter/useLocation/useParams/useSearch` 重映射到 TanStack hook，`toNextPathPattern` 把 TanStack route id `_app/org/$slug` 还原成 Next 的 `/org/[slug]`（剥掉 `_` 前缀 pathless 段）。`link.tsx` 的 `resolveHref` 摊平 Next `UrlObject`，`mapPrefetch` 把 Next 的 `true/'auto'` 映射为 TanStack 的 `'intent'`。`compat/sentry-nextjs.ts` re-export `@sentry/react`，保持 Next webpack 侧 import specifier 可用——**Next 构建不走 shim，直接用真 next 包**，shim 只对 Vite 生效。

### valtio 全局状态

`state/CLAUDE.md` 记录了官方约定：*"valtio for global state (`state/`), nuqs for URL state, react-hook-form + zod for forms"*。最小样板是 `state/app-state.ts`：

```ts title="apps/studio/state/app-state.ts"
export const appState = proxy({
  showProjectApiDocs: false,
  setShowProjectApiDocs: (value: boolean) => { appState.showProjectApiDocs = value },
  isOptedInTelemetry: false,
  mobileMenuOpen: false,
  showSidebar: true,
  // ...各字段配套 setter（自引用闭包）
})
export const useAppStateSnapshot = (options?) => useSnapshot(appState, options)
```

更复杂的 `state/sidebar-manager-state.tsx` 是工厂单例模式：`createSidebarManagerState()` 返回带方法的 proxy 对象，注册侧面板（`registerSidebar`/`unregisterSidebar`）、开关与最大化。其 `openSidebar` 实现了 pending-queue 状态机：目标侧栏尚未注册时先记 `pendingSidebarOpen`，注册时补触发——解决「先 open 后 register」的时序问题。快捷键子系统（`state/shortcuts/registry.ts` 的 `SHORTCUT_IDS` + `SHORTCUT_DEFINITIONS`，约 40 个 `registry/*.ts` 分组文件）偏好持久化走 `useLocalStorageQuery` 而非 valtio——存储性质决定归属。

### withAuth 与 IS_PLATFORM

`IS_PLATFORM` 在 `lib/constants/index.ts` 定义并被构建期内联，是全 Studio 的平台/自托管分流开关。认证相关 gate 点：`withAuth`（非平台直接返回原组件）、`lib/auth.tsx` 的 `AuthProviderInternal alwaysLoggedIn={!IS_PLATFORM}`、`routes/index.tsx` 的重定向目标、`start.ts` 的 `platformApiGuard`（平台模式下非 allowlist 的 `/api/*` 直接 404）。平台侧叠加 MFA：`useHighestAAL` 选项允许 support 页等在 AAL1 可达，AAL2 不足时跳 `/sign-in-mfa?returnTo=...` 保留 session 而不是强制 signOut。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Strangler Fig（绞杀者） | `routes/` re-export `pages/` | 逐路由迁移，双运行时可跑可退 |
| Shim / 适配层 | `compat/next/` + vite alias | 存量页面零改动换运行时 |
| 工厂单例 | `createSidebarManagerState` in `state/sidebar-manager-state.tsx` | 模块级导出唯一实例，含 pending-queue 状态机 |
| Provider 链 | `routes/__root.tsx` RootComponent | 18 层有序装配（auth → flags → profile → …） |
| 编译期常量 gate | `IS_PLATFORM` in `lib/constants/index.ts` | 分支被构建期内联消除，自托管构建不含平台代码路径 |

## 模块间交互

`state/` 的消费者是 87 个 components 文件（`DefaultLayout`、`ProjectLayout`、`BranchDropdown` 等）与 `__root.tsx` 自身（`AiAssistantStateContextProvider`）。`routes/` 与 `pages/` 是 re-export 关系：`routes/project.[_].tsx` 与 `routes/project.[_].$.tsx` 共享 `@/pages/project/_/[[...routeSlug]]` 的默认导出。SQL Editor 与 Table Editor 模块的状态 store（`state/sql-editor/`、`state/table-editor*`）挂在本骨架的 valtio 约定之下，但自成体系（见对应模块文档）。权限 hook（数据层模块）的 `useIsLoggedIn` 未登录直接 `can: false`，与认证骨架衔接。

## 扩展方式

**新增页面路由**（迁移期规则）：照常写 `pages/foo/bar.tsx`（可包 `withAuth`）→ 新增 `routes/_app/foo/bar.tsx` 以 Path A 包装（`createFileRoute` + `staticData: { defaultLayoutHeaderTitle: 'Bar' }`，由 `routes/_app.tsx` 的 `useMatches({ select })` 读取）→ `TANSTACK_MIGRATION.md` checklist 登记。路径含字面 `_` 段时必须用 path-as-filename 命名。

**新增全局状态 store**：仿 `state/sidebar-manager-state.tsx`——`const state = proxy({ ...data, ...methods })`，导出 `useXxxSnapshot`；纯开关类直接仿 `state/app-state.ts`。涉及快捷键往 `SHORTCUT_IDS` / `SHORTCUT_DEFINITIONS` 添加，ID 约定 `<surface>.<action>`。

**让某个 Next API 在 TanStack 下工作**：`pages/api/xxx.ts` 的 handler 用 `toWebHandler()`（`compat/next/api.ts`）包一层挂到 TanStack server route；引入新 `next/*` API 面时需在 `compat/next/` 加 shim 并注册 alias，否则 `studio-next-compat` 插件构建警告。
