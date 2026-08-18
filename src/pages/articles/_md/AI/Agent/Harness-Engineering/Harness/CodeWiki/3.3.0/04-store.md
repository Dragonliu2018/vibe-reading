---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "持久化层"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "sqlx", "数据库", "迁移", "缓存", "乐观锁"]
description: "Harness 持久化层：sqlx + dbtx 事务抽象、内联 SQL + squirrel 动态查询、embed.FS 双方言迁移、TTL 缓存跨实例失效、乐观锁重试"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

持久化层是 Harness 的数据地基——把 Postgres（生产）/SQLite（开发与嵌入式）两种方言统一成一套 store 接口，供上层 service 透明调用。它解决的核心问题是：同一个代码库要同时支持单机嵌入式部署（docker run 起一个 SQLite）和生产集群部署（Postgres + 多实例），且要管理 ~389 个迁移文件的双方言演进、跨实例缓存一致性、乐观/悲观并发控制。本层不碰业务规则——service 层开启事务、store 层执行 SQL，事务边界由 service 控制，store 对事务无感知。

## 模块架构

```
store/ (顶层)                错误模型 + dbtx 抽象
  ├─ dbtx/                   Accessor/Transaction/Transactor 接口
  │     ├─ ctx.go            GetAccessor(ctx, db) 从 context 取事务
  │     ├─ runner.go         runnerDB 实现 WithTx（注入 ctx）
  │     ├─ locker.go         postgres nop / sqlite 全局 RWMutex
  │     └─ tx.go             TxDefault/TxRepeatableRead/TxSerializable
  ├─ errors.go               ErrResourceNotFound/ErrDuplicate/ErrForeignKeyViolation...
  └─ database/               util_sqlite.go（唯一约束转译）等

app/store/
  ├─ database/               Store 实现（pullreq/repo/space... 各一文件）
  │     ├─ database.go        Store 接口定义（PullReqStore/SpaceStore/...）
  │     ├─ wire.go           Provide*Store WireSet
  │     ├─ mapping.go         DB struct ↔ types.* 双向映射
  │     ├─ primaries.go       主键
  │     └─ migrate/           双方言迁移（embed.FS）
  ├─ cache/                  refcache 的缓存包装（Evictor 跨实例失效）
  └─ logs/                   step 日志持久化
```

## 调用链路

一次带事务的多表写入（以 [API 层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/02-api)的 `controller.TxOptLock` 创建 PR 为例）：

```
controller.TxOptLock(ctx, mutateFn)  in app/api/controller/pullreq/tx.go:36
  └─ dbtx.Transactor.WithTx(ctx, txFn, opts...)  in store/database/dbtx/runner.go:34
        ├─ 开启 DB 事务 → TransactionAccessor
        ├─ context.WithValue(ctx, ctxKeyTx{}, txAccessor)   事务注入 context
        ├─ txFn(ctx):
        │     ├─ repoStore.Find/Update(ctx, ...)   递增 PullReqSeq
        │     │     └─ dbtx.GetAccessor(ctx, s.db)  从 context 取事务 accessor
        │     ├─ pullreqStore.Create(ctx, pr)
        │     │     └─ BindNamed → QueryRowContext().Scan(&id)  RETURNING 回填
        │     ├─ reviewerStore.Create(ctx, ...)
        │     └─ git.UpdateRef(...)                 事务内最后
        ├─ 提交 / 回滚
        └─ 返回（事务 accessor 从 context 移除）
```

store 方法始终调用 `dbtx.GetAccessor(ctx, s.db)` 获取 accessor——若 context 里有事务就用事务，否则用裸 DB runner。这让 store 对事务边界完全无感知。

<details>
<summary>方法速查表</summary>

| 方法 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `Transactor.WithTx` | `store/database/dbtx/runner.go:34` | 开启事务注入 ctx | 自动 commit/rollback |
| `dbtx.GetAccessor` | `store/database/dbtx/ctx.go` | 取事务/裸 DB | context 传递事务 |
| `ProcessSQLErrorf` | `store/database/util.go:55` | SQL error 转译 | `errors.Is` sentinel |
| `pullReqStore.Create` | `app/store/database/pullreq.go:214` | INSERT PR | `RETURNING` 回填 ID |
| `SpaceStore` 递归 CTE | `app/store/database/space.go` | 查祖先链 | `spaceAncestorsQuery` |
| `UpdateOptLock` | `app/store/database/*.go` | 乐观锁重试 | version 冲突重试 |
| `Evictor.Evict` | `app/store/cache/evictor.go` | 跨实例缓存失效 | pubsub 广播 key |

</details>

## 核心实现

### dbtx 事务抽象

底层基于 **sqlx**（`jmoiron/sqlx`）而非裸 `database/sql`。`dbtx.Accessor` in `store/database/dbtx/interface.go` 组合 `sqlx.ExtContext` 及 `GetContext`/`SelectContext`/`NamedExecContext`，是所有 DB 操作的统一入口。`dbtx.Transaction` 提供 `Commit`/`Rollback`。`dbtx.AccessorTx = Accessor + Transactor`，`Transactor.WithTx(ctx, txFn, opts...)` 是事务开启的唯一接口。

`dbtx.GetAccessor(ctx, db)` in `store/database/dbtx/ctx.go` 是关键：从 context 中取 `ctxKeyTx{}` 对应的 `TransactionAccessor`，若不存在则用 `dbtx.New(db)` 返回裸 DB runner——store 方法无需感知事务，始终调用此函数获取 accessor。`runnerDB` in `runner.go` 是 `AccessorTx` 的实现：`WithTx` 开启事务后将 `TransactionAccessor` 注入 context 并自动 commit/rollback。`locker.go` 中 postgres 用 `lockerNop{}`（依赖 DB 自身并发控制），sqlite 用全局 `sync.RWMutex`（因 sqlite 不支持并发写）。事务选项在 `tx.go` 预定义：`TxDefault`、`TxRepeatableRead`、`TxSerializable`。

### Store 实现模式：内联 SQL + 双层映射

以 `PullReqStore` in `app/store/database/pullreq.go` 为例：结构持有 `db *sqlx.DB` + 可选缓存（如 `pCache store.PrincipalInfoCache`）。**SQL 是内联字符串**而非外部 `.sql` 文件——简单查询用 `const sqlQuery`，复杂动态查询用 `squirrel` builder（`database.Builder = squirrel.Dollar`，生成 `$1,$2` 占位符）。列定义用 const 字符串拼接（如 `pullReqColumns`）保证 SELECT 列与映射一致。

行→对象映射分两层：先用 **sqlx struct tags**（`db:"pullreq_id"`）scan 到内部 DB struct（如 `pullReq`），再通过手写 `mapPullReq`/`mapInternalPullReq` 双向映射到 `types.PullReq`。这样 DB struct 与 API model 解耦，且可做 null 处理（`guregu/null`）。CRUD 模式：`Find` 用 `db.GetContext`；`Create` 用 `BindNamed` + `QueryRowContext().Scan(&id)` 取 `RETURNING` 的主键；`Update` 用 `BindNamed` + `ExecContext` + 检查 `RowsAffected`。`SpaceStore` in `space.go` 额外展示递归 CTE 查询（`spaceAncestorsQuery`）和 `squirrel` 动态条件拼接。

### 双方言迁移

`app/store/database/migrate/migrate.go` 用 `github.com/maragudk/migrate` 库。`//go:embed postgres/*.sql` 和 `//go:embed sqlite/*.sql` 把两套并行目录（各约 389 个文件，命名 `NNNN_description.up.sql`/`.down.sql`，按数字前缀排序执行）嵌入二进制，自包含部署。版本表 `migrations` 含 `version` 列（PK）。数据迁移 hook：`After` 回调按 version 分发到 Go 函数（如 `migrate_0160.go` 的 `MigrateAfter_0160`），执行 SQL 之外的数据修复；sqlite 迁移期间临时关闭 `PRAGMA foreign_keys`。入口 `ConnectAndMigrate` in `store.go` → `migrate.Migrate(ctx, db)`。

### 缓存层与跨实例失效

`cache.Cache[K, V]` 接口 in `cache/cache.go`（`Get`/`Evict`/`Stats`），`TTLCache` in `ttl_cache.go` 是主实现：**无容量上限、纯 TTL 驱逐**，后台 goroutine 每分钟扫描过期项，命中不刷新 TTL（确保短时效）。缓存对象类型在 `app/store/cache.go`：`PrincipalInfoCache`(30s)、`SpaceIDCache`/`SpacePathCache`(15min)、`RepoIDCache`/`RepoRefCache`(15min)、`InfraProviderResourceCache`(5min)。

跨实例失效靠 `Evictor[T]` in `app/store/cache/evictor.go`——通过 `pubsub.PubSub` 发布/订阅 gob 编码的 key，实现多实例缓存一致性。`repoIDCacheGetter.Find` 委托 `repoStore.Find` → `repo.Core()`，只缓存不可变核心数据。space 变更时全量清空 repo 缓存（`EvictAll`），因为逐条排查代价过高。

### 错误模型与并发控制

`store/errors.go` 定义 sentinel errors：`ErrResourceNotFound`、`ErrDuplicate`、`ErrForeignKeyViolation`、`ErrVersionConflict` 等。store 层通过 `ProcessSQLErrorf` in `store/database/util.go:55` 统一转译——对 sqlite 检查 `ErrConstraintUnique`/`ErrConstraintPrimaryKey`，对 postgres 检查 `pq.Error.Code == "23505"`，分别映射为对应 sentinel，用 `fmt.Errorf("%s: %w", msg, translatedError)` 包装保留可被 `errors.Is` 匹配。向上传递到 API 层 `usererror.Translate` 用 `errors.Is` 匹配 sentinel → HTTP 状态码（`ErrResourceNotFound`→404、`ErrDuplicate`→409）。

并发控制两种：**乐观锁** `WHERE version = :version - 1` + `RowsAffected == 0` → `ErrVersionConflict`，`UpdateOptLock` 实现重试循环（`mutateFn` → `Update` → 冲突则 `Find` 重新加载后重试，最多 5 次，即 [API 层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/02-api) `TxOptLock` 的基础）；**悲观锁** `SELECT ... FOR UPDATE`（const `SQLForUpdate`），sqlite 不支持故跳过。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Repository | `app/store/database.go` 接口 + `app/store/database/*.go` 实现 | 隔离 SQL 与业务，可 mock |
| 事务边界在 service | `service.tx.WithTx` | 多 store 共享一事务，store 无感知 |
| 乐观锁重试 | `UpdateOptLock` | 避免 `SELECT FOR UPDATE` 的锁竞争 |
| 双层映射 | `mapPullReq`/`mapInternalPullReq` | DB struct 与 API model 解耦 |
| DI 切换方言 | `ProvideXxxStore` WireSet | postgres/sqlite 同接口不同实现 |

## 模块间交互

被 `app/services/*` 和 `app/api/controller/*` 广泛依赖（持 store 接口 + `dbtx.Transactor`）。依赖 `lock`（部分场景）、`cache`（refcache 包装）、`pubsub`（Evictor 跨实例失效）。与 [基础设施层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/09-infra)的 pubsub/lock 协作实现跨实例一致性。

## 扩展方式

**新增表 + Store**：① 在 `migrate/postgres/` 和 `migrate/sqlite/` 各加 `0NNN_create_table_xxx.up/down.sql`（SERIAL PK + version 列 + FK 约束）；② 在 `app/store/database.go` 加 `XxxStore interface{}`；③ 在 `app/store/database/xxx.go` 实现：定义 DB struct（`db:"xxx_id"` tags）+ 列 const + `mapXxx`/`mapInternalXxx` + CRUD 方法，每方法用 `dbtx.GetAccessor(ctx, s.db)` + `ProcessSQLErrorf`；④ 在 `app/store/database/wire.go` 加 `ProvideXxxStore`。

**加带事务的多表操作**：在 service 层用 `s.tx.WithTx(ctx, func(ctx) error { storeA.Create(ctx, ...); storeB.Delete(ctx, ...) })`，回调内 context 自动携带事务，`ProcessSQLErrorf` 把唯一冲突转 `ErrDuplicate` 供 `errors.Is` 判断。

**加缓存**：在 `app/store/cache.go` 加 `XxxCache` 类型别名；在 `app/store/cache/` 写 getter（实现 `cache.Getter`，委托 store 的 Find）；在 `wire.go` 注册 Provider 指定 TTL；跨实例失效则创建 `Evictor[T]` 并在 store 写操作后调 `Evict`。
