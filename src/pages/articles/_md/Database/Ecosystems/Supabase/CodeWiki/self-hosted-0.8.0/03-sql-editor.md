---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "SQL 执行与 SQL Editor"
date: "2026-09-20T18:15:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "Studio", "SQL Editor", "Monaco", "react-query"]
description: "executeSql 统一 SQL 执行总线（SafeSqlFragment 强制、EXPLAIN preflight、角色扮演）与 SQL Editor 的 snippet 双轨保存链。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

这一模块覆盖 Studio 的数据库 I/O 心脏：`executeSql`（`data/sql/execute-sql-mutation.ts`，148 个文件引用它——Table Editor、policy、schema、RLS、index advisor 等所有读库界面都用它拿数据，本质是整个 Dashboard 的数据库 I/O 总线）与 SQL Editor 的完整编辑体验（snippet 管理、自动保存、diff、Monaco 集成）。安全是贯穿主题：从 `UntrustedSqlFragment` 到执行的全链路信任分级。

## 模块架构

编辑侧由三个 valtio store 分域 + 一组 React 装配层组成：

| Store | 文件 | 职责域 |
| --- | --- | --- |
| `sqlEditorState` | `state/sql-editor/sql-editor-state.ts` | 持久化域：snippets/folders + 脏队列 `needsSaving: proxyMap` |
| `sqlEditorSessionState` | `state/sql-editor/sql-editor-session-state.ts` | 会话域：查询结果 `results[snippetId]`、行数 limit——**绝不持久化**，只读共享 snippet 也能用 |
| `sqlEditorDiffRequestState` | `state/sql-editor/sql-editor-diff-request.ts` | 一次性命令：`requestDiff()` 入队 / `consumeDiffRequest()` 读后即清 |

React 侧 `SqlEditorSaveCoordinatorProvider`（`sql-editor-save-coordinator.tsx`）注入 react-query invalidate / toast / mutation 函数，`SQLEditorControllersProvider`（`components/interfaces/SQLEditor/SQLEditorControllers.tsx`）把 Snippet/Assistant/Run/Ui 四个 context 分发避免 prop-drilling。

## 调用链路

### 执行链（Run → 结果）

```
用户点击 Run（或 Cmd+Enter）
  → readEditorSql()                    // SQLEditorControllers.tsx：Monaco selection ?? 全文 → UntrustedSqlFragment
  → acceptUntrustedSql(sql)            // ⭐ 用户动作现场晋升为 safe
  → executeQuery(safeSql)              // useSqlEditorExecution.ts
      ├─ analyzeQueryIssues(sql, eventTriggers)   // 静态风险检测（建表无 RLS 等）→ RunQueryWarningModal
      ├─ shouldAutoGenerateTitle → setAiTitle(id, sql)（不 await）
      ├─ resolveConnectionString(databases, selectedDatabaseId)   // 读副本切换
      └─ execute(buildExecuteParams(...))       // SQLEditor.utils.ts
            ├─ applyAutoLimit(sql, limit)        // 无注释 SELECT 且无 limit → 追加 " limit N;"
            └─ wrapWithRoleImpersonation(...)    // lib/role-impersonation.ts
  → executeSql()                        // data/sql/execute-sql-mutation.ts
      → POST /platform/pg-meta/{ref}/query   （header: x-connection-encrypted）
  → onSuccess: sessionSnap.addResult(id, data.result, autoLimit)   // rows 用 ref() 包裹避免 proxy 开销
  → onError: editor.highlightErrorLine(error, hasSelection)   // 解析 "LINE n:" 并做 impersonation 行号回偏移
```

### 保存链（auto / manual 双轨）

```
Monaco onChange → useSnippetEditor.handleEditorChange
  → 首次编辑：createSqlSnippetSkeletonV2 + snapV2.addSnippet + router.push(/project/ref/sql/{id})
  → snapV2.setSql({id, sql, shouldInvalidate})     // status→unsaved（编辑即脏，不依赖瞬态队列）
     → needsSaving.set(id, shouldInvalidate)
     → [Valtio subscribe] createSaveScheduler.start() 注册的订阅
        → drainSnippetQueue → flushSnippet → validateMoveToFolder 检查
        → saveMechanism.saveSnippet({id, projectRef, shouldInvalidate})
           → memoize(id)(debounce(saveSnippet, 1000ms))    // per-snippet debounce
              → upsertContent({projectRef, payload})      // PUT /platform/content
              → shouldInvalidate → invalidate(contentKeys.count/sqlSnippets/folders)
```

手动保存（Cmd/Ctrl+S）：`MonacoEditor.tsx` 的 `editor.addAction('save-query', ...)` → `useSqlEditorSaveCoordinator().requestSave(id)`——删队列、跳过 debounce 立即 flush。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `executeSql` in `data/sql/execute-sql-mutation.ts` | 统一 SQL 执行 | `sql` 只收 `SafeSqlFragment`；`new Blob([sql]).size > 0.98*MB` 拒绝 |
| `wrapWithRoleImpersonation` in `lib/role-impersonation.ts` | GUC 注入包裹 | postgrest 角色伪造完整请求上下文，精确还原 RLS 视角 |
| `getImpersonationSQL` in `packages/pg-meta/src/sql/studio/role-impersonation.ts` | 生成包裹 SQL | `ROLE_IMPERSONATION_SQL_LINE_COUNT = 11`（行号回偏移依据） |
| `applyAutoLimit` in `SQLEditor.utils.ts` | 自动 limit | 单条无注释 SELECT 才追加 |
| `createSaveScheduler` in `state/sql-editor/sql-editor-save-scheduler.ts` | WHEN | 区分 SaveMode.auto / manual；无 React 依赖可纯测 |
| `createSaveMechanism` | HOW | debounce + upsert + 状态转移 + 回滚；顶部注释 "does NOT decide *when*" |
| `analyzeQueryIssues` in `SQLEditor.utils.ts` | 执行前风险检查 | blocking issue 弹警告，`force=true` 可越过 |
| `consumeDiffRequest` in `state/sql-editor/sql-editor-diff-request.ts` | 一次性 diff 命令 | 读后即清，陈旧请求不泄漏到下一个编辑器 |
| `abortQuery` in `data/sql/abort-query-mutation.ts` | 中止查询 | 用 `executeSql` 跑 `getAbortQuerySQL({pid})`——用 SQL 杀 SQL |

</details>

## 核心实现

### executeSql：三道闸门

签名要点（简化）：

```ts title="apps/studio/data/sql/execute-sql-mutation.ts"
async function executeSql<T = any>({
  projectRef, connectionString,
  sql: SafeSqlFragment,               // 强制品牌类型，不接受任意字符串
  isRoleImpersonationEnabled = false,
  isStatementTimeoutDisabled = false,  // SQL Editor 手动查询专用
  preflightCheck = false,              // 先 EXPLAIN，cost ≥ 200_000 拒绝
  ...
}): Promise<{ result: T }>
```

三道闸门：**类型闸**（`SafeSqlFragment` 编译期阻断注入，见 pg-meta 模块）；**大小闸**（>0.98MB 抛 "Query is too large"）；**成本闸**（preflightCheck 时先发 `explain ${sql}`，`ExplainVisualizer.parser` 的 `createNodeTree/calculateSummary` 算 totalCost，超过 `COST_THRESHOLD = 200_000` 拒绝——作者注释：10 万算 heavy、100 万算 dangerous；preflight 失败不阻塞 UI，用户可 "Load data anyway" 把表加入忽略清单重试）。

React 封装 `useExecuteSqlMutation` 的 `onSuccess` 做两件事：`sqlEventParser.getTableEvents(sql)` 解析 CREATE/ALTER/DROP 事件上报 telemetry；`contextualInvalidation && isMutationSQL` 时把 `['projects', projectRef]` 前缀下所有 query cache 失效（排除 branches/settings-v2/addons 等白名单）——DDL 后 Dashboard 对象展示必须刷新，这是它成为 I/O 总线的副作用。

### Role impersonation：不换连接的权限模拟

设计目标是让用户在 SQL Editor 里以 PostgREST 的视角预览 RLS 效果。做法是在同一事务里注入 GUC（`packages/pg-meta/src/sql/studio/role-impersonation.ts` 的 `getImpersonationSQL`）：postgrest 角色注入 `set_config('role', ...)` + `request.jwt.claims` + `request.method` 等，精确模拟 PostgREST 请求上下文；JWT 由 `lib/role-impersonation.ts` 的 `getPostgrestClaims` 合成（exp 强制 1 小时，防长期凭证泄漏）；custom 角色用 `set local role`。三个必须客户端消化的副作用：包裹前缀固定 11 行（报错 `LINE n:` 减 11 还原真实行号）；用户 SQL 无结果时 pg-meta 回落执行包装 SQL 返回 `ROLE_IMPERSONATION_NO_RESULTS = 1` 哨兵；客户端据此改写为空结果集。

### 保存链的 Scheduler / Mechanism 分层

拆分动因写在代码注释里：mechanism 只懂「怎么存」（debounce、upsert、状态转移、失败回滚），scheduler 只懂「何时存」。直接收益是 **manual save Feature Preview**（`useIsSqlEditorManualSaveEnabled`）：只改 scheduler 的 policy（manual 模式扣住队列直到 `requestSave`），persistence 逻辑零改动。两层各有防线：编辑即 `statusOnEdit('saved'→'unsaved')`（durable 脏信号，不依赖瞬态队列）；needsSaving 队列再排空。`SnippetStatus` 状态机（`sql-editor-lifecycle.ts`）把两条正交轴（是否曾持久化 / 保存进度）压成互斥 enum：`new / new_saving / new_save_failed / saved / unsaved / saving / save_failed`，转换函数全是纯函数。

### Untrusted→Safe 晋升点纪律

`readEditorSql()` 永远返回 `UntrustedSqlFragment`，controller 注释明确 "promotion is auditable"——每个 run 按钮站点（toolbar、warning modal confirm、Cmd+Enter）各自调用 `acceptUntrustedSql`。这防止 URL 参数/AI 输出预填的 SQL 被静默自动执行或持久化为「用户作品」。Assistant 的 "Insert code/Replace code"（`components/ui/QueryBlock/EditQueryButton.tsx`）产生编辑器之外的 diff 请求，做成 one-shot 命令并读后即清；编辑器未挂载时保持 pending，等 `editorMountCount` bump 再应用（`useSqlEditorAi.ts` 的 `drainDiffRequest`）。

### 结果集与 tabs

`addResult` 用 `ref(results)` 阻止 valtio 给每行每列建 Proxy（大结果集内存灾难）——数据只读所以安全。`MonacoEditor.tsx` 是薄壳：挂载命令（Escape blur、Cmd+S、Cmd+Enter）、Escape 优先级 precondition 列表、`useAddDefinitions` 注入 schema 补全。coordinator 向 `tabsStore.registerTabTypeHandler('sql', ...)` 注册 VS Code 式未保存圆点、`confirmClose`、`onClose`。一个 auto 模式下的坑（coordinator 长注释）：关闭 tab **绝不能清 store 内容**——null 掉仍挂载编辑器的内容会在 Monaco dispose 时崩溃，`content: undefined` 会静默吞掉下一次编辑导致 autosave 失效。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Scheduler / Mechanism 分层 | `sql-editor-save-scheduler.ts` / `sql-editor-save.ts` | WHEN 与 HOW 正交；纯函数级测试 |
| Coordinator（React 装配） | `sql-editor-save-coordinator.tsx` | deps 注入 + 确定性启停 + requestSave context |
| 状态机（纯函数） | `sql-editor-lifecycle.ts` | 双轴压成互斥 enum + 谓词函数 |
| One-shot command | `sql-editor-diff-request.ts` | 陈旧请求不跨编辑器泄漏 |
| Capability promotion | `acceptUntrustedSql` 调用纪律 | 安全策略编码进类型签名 |
| ref() 防穿透 | `sql-editor-session-state.ts` | valtio 对只读大数组不建 proxy |

## 模块间交互

pg-meta 既是 SQL 生成库（各模块拼 `SafeSqlFragment`）也是运行时服务端点（`POST /platform/pg-meta/{ref}/query`）。Monaco 集成经 `lib/configure-monaco-loader.ts`；错误行高亮的 `parseFormattedErrorLine` 在 `SQLEditor.utils.ts`。react-query 边界清晰：执行用 mutation（不进缓存），结果进 valtio session store；snippet 列表/内容用 react-query（contentKeys），保存成功后失效——**Valtio 管「正在编辑什么」，react-query 管「服务器上有什么」**。

## 扩展方式

**新增快捷操作**：`state/shortcuts/registry.ts` 加 `SHORTCUT_IDS` → `useSqlEditorShortcuts.ts` 里 `useShortcut(SHORTCUT_IDS.XXX, handler, { registerInCommandMenu: true })`；涉及执行 SQL 沿用 `readEditorSql() + acceptUntrustedSql()` 晋升模式。

**新增执行前风险检查**：`SQLEditor.utils.ts` 的 `analyzeQueryIssues` 加规则 → `hasBlockingIssues` 决定弹窗 → `RunQueryWarningModal` 加确认分支（参考 `onConfirmWithRLS` 用 `appendEnableRLSStatements` 重写 SQL）。

**改保存行为**：改 `sql-editor-save.ts` 的 `saveSnippet` 或注入 `buildPayload`（deps 已留测试注入口），不动 scheduler 和 UI。对应测试：`state/sql-editor/sql-editor-{save-scheduler,save,lifecycle,diff-request,rules}.test.ts`。
