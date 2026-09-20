---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "pg-meta 元数据引擎"
date: "2026-09-20T18:25:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "PostgreSQL", "pg_catalog", "SQL 生成", "zod"]
description: "@supabase/pg-meta：SafeSqlFragment 品牌 DSL 防注入、pg_catalog 直查内省、CTE 两段式截断与 fluent Query builder。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

`packages/pg-meta`（~30k 行 TS，runtime 依赖仅 `zod` 一个）把 Postgres 系统目录抽象成 TS API：introspection 查询生成 + DDL/DML SQL 生成。先澄清一个容易混淆的关系——**本包是纯 TS 库，不含任何服务代码**（`package.json` 的 `pg` 只在 devDependencies 供测试用）；独立仓库 supabase/postgres-meta 是一个 Go 服务，在自托管栈中以镜像 `supabase/postgres-meta:v0.96.6` 运行。分工是：**TS 库生成 SQL + zod schema，Go 服务执行 SQL**——测试基建注释（`test/db/utils.ts` L5-7）直接点明二者靠「SQL 文本 + 解析约定」耦合，`executeQuery` 甚至复刻了 Go 侧「多语句返回最后一个有行结果」的语义。

## 模块架构

包内三层：`pg-format/`（叶子模块，安全 SQL DSL，被全包依赖——god nodes 的来源：`safeSql` 281 边 / `literal()` 174 / `ident()` 113 / `joinSqlFragments()` 86 是全包 SQL 拼装的必经点，属「核心 DSL 被广泛复用」而非坏味道）；`sql/`（introspection SQL 模板 + `sql/studio/` 8 个 Studio 专属业务域）；每对象类型一个 `pg-meta-<type>.ts`（18 个：tables/roles/columns/policies/triggers/...，统一 `list/retrieve/create/update/remove` 五件套），`src/index.ts` 聚合成 default export。

关键形态：每个方法**返回 `{ sql: SafeSqlFragment; zod: ZodType }` 而不是执行结果**——调用方（Studio / Go 服务 / 测试）自选执行器，解析契约显式化。

## 调用链路

一条完整链路（Table Editor 行查询）：

```
Studio 的 useTableRowsQuery（data/table-rows/table-rows-query.ts）
  → getTableRowsSql({table, filters, sorts, limit, page})
      │   src/query/table-row-query.ts
      ├─ new Query().from(table.name, table.schema).select()   （fluent 链）
      ├─ filters 逐条 .filter()，空串值非文本列映射 null
      ├─ 无 sorts 且 live_rows_estimate ≤ 100000 → 默认主键排序
      ├─ .range(from, to).toSql() → 基础查询
      └─ CTE 两段式包装（见下）
  → Studio 侧 wrapWithRoleImpersonation → executeSql
  → POST /platform/pg-meta/{ref}/query → Go 服务解密连接串直连库
  → 结果过 zod（如 pgTableZod.parse）
```

结果整形发生在 **SQL 层而非 JS 层**：`helpers.ts` 的 `coalesceRowsToArray(source, filter, orderBy?)` 生成 `COALESCE((SELECT array_agg(row_to_json(t)) FILTER (WHERE ...) FROM t), '{}')`——introspection SQL 用多个 CTE + `array_agg(row_to_json(...))` 在**数据库内**完成 1:N 嵌套组装，一条 SQL 直接返回形如 `{...table, columns: [...]}` 的 JSON 行。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `safeSql` in `src/pg-format/index.ts` | tagged template 组合碎片 | 插值类型限定 `Array<SafeSqlFragment>`，普通 string 编译期报错 |
| `ident()` | 标识符转义 | 合法裸标识符直通，否则加双引号并 `"` 翻倍；移植自 PG 9.2.4 `fe-exec.c` |
| `literal()` | 字面量转义 | `'` 翻倍；对象 `JSON.stringify` + `::jsonb` 显式 cast；数组递归展开 |
| `keyword()` | 控制短语白名单 | 只收单词或 `ALLOWED_MULTI_WORD_KEYWORDS`——堵死 "DROP TABLE" 借道注入 |
| `joinSqlFragments()` | 碎片组合 | 分隔符是 15 种字面量联合类型 |
| `applyFilters` in `src/query/Query.utils.ts` | Filter[] → where | `~~*` 类 like 先 `ident(col)::text` cast；复合列走行值比较 `(a,b)=(x,y)` |
| `parseArrayLiteral` | 手写 ARRAY[...] 解析 | 带引号状态机逐项 re-`literal()`（数组值不能整体 literal） |
| `getTableRowsSql` in `src/query/table-row-query.ts` | 表格数据查询生成 | CTE 两段式截断 |
| `getTablesSql(targetOid)` in `src/sql/tables.ts` | 表内省 SQL | targetOid 以标量子查询注入，planner 当 initplan 常量一次求值 |

</details>

## 核心实现

### SafeSqlFragment：把注入防护编码进类型系统

```ts title="packages/pg-meta/src/pg-format/index.ts"
export type SafeSqlFragment = string & { readonly __safeSqlFragmentBrand: never }
```

`never` 字段无法被任何对象字面量满足，因此**任何普通 string 都不能赋给 SafeSqlFragment**，只能通过准入函数获得。信任分级是三人分工（源码 L29-39 注释写得很清楚）：

![SafeSqlFragment 信任分级](/vibe-reading/images/articles/supabase-internals/safe-sql-dsl.svg)

- `SafeSqlFragment`：源码静态字符串 / 转义函数输出 / safeSql 组合；
- `UntrustedSqlFragment`（`untrustedSql()`）：来自 URL 参数、**AI 输出**、外部内容的 SQL，只能展示；
- `acceptUntrustedSql()`：唯一提升通道，**只允许在用户显式动作的事件处理器里调用**（注释明令禁止在 useEffect/render 中调用）——把「运行 = 用户授权」语义做成了类型级闸门；
- `rawSql()`：用户亲手键入 SQL 的准入口。

为什么能防注入：不是运行时过滤，而是「类型品牌 + 单一准入函数」的 dataflow 约束——运行时 `safeSql` 只是字符串 reduce（零开销），安全性由 TS 编译器保证「到达拼接点的每个碎片要么是常量、要么已被 ident/literal/keyword 清洗」。唯一漏点是 `rawSql/acceptUntrustedSql` 两个显式 escape hatch，靠使用纪律约束。另一个常被低估的收益是**可组合性**：introspection SQL 由模块（tables CTE / columns CTE / coalesce 表达式 / where 过滤）层层组装，纯字符串拼接在动态组合（`includeColumns` 开关、scoped 参数注入空碎片）时极易产生双重空格/悬挂逗号类 bug 且无法静态检查。

### pg_catalog 直查而非 information_schema

`sql/tables.ts` 全程用 `pg_class/pg_namespace/pg_index/pg_attribute/pg_constraint` + `pg_stat_get_live_tuples`、`obj_description`、`pg_has_role/has_table_privilege`。原因：information_schema 是 SQL 标准视图层，缺少 `relrowsecurity`（RLS 状态）、`relreplident`（replica identity）、`pg_total_relation_size`、死/活元组估计、`indisprimary` 原始顺序等 PG 特有字段。

一个记载了真实事故的优化：`getTablesSql(targetOid)` 的注释（L7-15）说明 targetOid 以标量子查询注入，planner 当 initplan 常量一次求值，驱动 pg_class 的 INDEX 扫描——**若用 CTE 会被物化成优化屏障，退化为全目录 seq scan**，注释记载了「数百 schema 库上 58s 超时」的事故。

### CTE 两段式：截断只对当页数据做

![getTableRowsSql 两段式](/vibe-reading/images/articles/supabase-internals/table-row-query.svg)

`getTableRowsSql()`（`table-row-query.ts` L132-260）的结构：`with _base_query as (过滤+排序+分页)` 先收敛行集，外层再对每列做截断——`octet_length(col::text) > 10240` 时 `left(col::text, 10240) || '...'`；数组列 `array_cat(col[1:50], array['...'])` 截断 50 元素；JSON 数组列补 `array['{"truncated": true}'::json]`。关键设计：**截断只在分页后的子集上做**，避免全表 `::text` 物化。这解释了 Table Editor 为什么能在浏览器里安全浏览大表：昂贵的类型物化被限制在当页 100 行。

### fluent Query builder 与 Filter 模型

`src/query/` 四层类链：`Query.from(name, schema)` → `QueryAction.select()/insert()/update()/delete()...` → `QueryFilter.filter(col, op, val).match(dict).order(...)` → `QueryModifier.range(from,to).toSql()`——仿 PostgREST 客户端链式 API 但产出 SQL。`Filter`（`types.ts`）的 `column: string | Array<string>` 支持复合元组过滤（外键行选择），`FilterOperator` 是 13 种白名单枚举，`applyFilters` 中操作符以 `filter.operator as SafeSqlFragment` 内插——枚举扩张即安全。

### DDL 生成的事务性

`pg-meta-tables.ts` 的 `update()` 把 RLS、replica identity、主键重建、comment 等多语句包进 `BEGIN; ... COMMIT;` 事务；主键重建用 `DO $$ ... EXECUTE` 动态 SQL（L268-282）——保证 Table Editor 里改表结构时的原子性。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Branded type + tagged template DSL | `pg-format/index.ts` | 注入防护进类型系统，运行时零成本 |
| SQL + zod 随行返回 | 各 `pg-meta-*.ts` | 执行器自选，解析契约显式 |
| 五件套统一方法面 | 18 个对象类型文件 | 新增对象类型是模板复制 |
| 执行式测试 | `test/db/utils.ts` 的 `createTestDatabase` | 不用字节级 SQL 快照断言（`sql/tables.ts` 注释明言）；每用例真实 PG + 随机库名 + 用完 DROP |
| 冻结遗留路径 | `TABLES_SQL = getTablesSql()` 标注 "FROZEN legacy path" | 新 scoped 形态并存渐进切换 |
| 类型参数化返回 | `TableBasedOnIncludeColumns<T>` | `includeColumns` 选项在类型层影响返回 zod |

## 模块间交互

依赖方向极简（runtime 仅 zod）。被 Studio 以 `@supabase/pg-meta` import（数据层各资源目录把生成的 SQL 喂 `executeSql`，含 `sqlKeys` query key）。`src/index.ts` 专门为 Studio re-export `sql/studio/*`（advisor/auth/storage/database/table-editor/sql-editor/role-impersonation/integrations 八个域）——**Studio 专属业务 SQL 也长在这个包里**，注释自嘲"如果变臃肿可拆 path export"（`sql/studio/table-editor/table.ts` 已长到 26.3k 字节，正是担心的情形）。与 Go 服务的关系是分工而非替代：历史上 Studio 曾直接用 Go 服务的 REST API，现演进为「客户端生成 SQL、服务退化为执行代理」——收益是 SQL 生成随前端发版迭代快、生成的 SQL 可直接展示给用户、类型安全 DSL 只有 TS 能表达；代价是信任边界后移，靠网关 key-auth + Go 侧权限兜底。

## 扩展方式

**支持新 PG 对象类型**（如 queues）：新建 `src/sql/queues.ts`（pg_catalog / 扩展表 introspection，用 safeSql 模板）→ 新建 `src/pg-meta-queues.ts`（定义 `pgQueueZod` + 五件套，list 用 `generateEnrichedSql + coalesceRowsToArray` 模式）→ `src/index.ts` 注册。参照最近的同类 `pg-meta-foreign-tables.ts`（3.3k 字节）——工作量集中在 SQL 正确性，方法面与注册是模板复制。

**Table Editor 加新过滤操作符**（如全文搜索 `@@`）：`src/query/types.ts` 的 `FilterOperator` 加值 → `Query.utils.ts` `applyFilters` 加 case（操作符白名单内插即安全）→ 必要时 `table-row-query.ts` 处理列类型适配（如 `to_tsvector`）；多词操作符还需 `keyword()` 的 `ALLOWED_MULTI_WORD_KEYWORDS` 白名单。

**Studio 新功能需要复杂业务 SQL**：`src/sql/studio/<domain>/` 加文件导出 `SafeSqlFragment` 常量/工厂，`src/index.ts` re-export。对应测试：`test/` 下按对象类型的集成测试（`run-tests.sh` 起 docker-compose 真实 PG，端口探测 5432-5531）。
