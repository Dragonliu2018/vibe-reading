---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Persistence"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "SQLAlchemy", "Alembic", "Postgres"]
description: "DeerFlow 持久化层解析：SQLAlchemy 2.0 async ORM、Repository 模式、bootstrap_schema 三路分支、Alembic 迁移与 SQLite/Postgres 双后端。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 记忆与持久化](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/02-memory-persistence)

---

## 模块定位

本模块属于 **记忆与持久化** 子系统，是 DeerFlow 的应用数据持久层——基于 SQLAlchemy 2.0 async ORM 管理 runs 元数据、thread 归属、channel 连接、cron 任务、users、feedback 等。**与 LangGraph checkpointer 完全分离**：checkpointer 管 graph execution state，本模块管 DeerFlow 自有应用数据（`migrations/env.py` 用 `include_object` 过滤器明确排除 LangGraph 的 `checkpoints`/`checkpoint_blobs` 等表）。模块入口 `__init__.py` 仅导出 4 个符号：`init_engine`/`close_engine`/`get_engine`/`get_session_factory`。

## 核心实现

### DB 引擎

```python title=backend/packages/harness/deerflow/persistence/engine.py
_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None

async def init_engine(backend: str, *, url: str = "", echo: bool = False,
                      pool_size: int = 5, pool_recycle: int = 300,
                      command_timeout: float | None = 30, ...) -> None:
    # memory → no-op; sqlite → PRAGMA WAL+NORMAL+foreign_keys+busy_timeout;
    # postgres → asyncpg + search_path + pool_pre_ping
```

### RunRepository — 短 session 模式

```python title=backend/packages/harness/deerflow/persistence/run/sql.py
class RunRepository(RunStore):   # 实现 runtime/runs/store/base.py 的 RunStore ABC
    def __init__(self, session_factory): self._sf = session_factory
    async def put(self, run_id, *, thread_id, status="pending", ...) -> None:
        # 幂等 insert-or-update
    async def start_run(self, run_id: str) -> bool:   # CAS: UPDATE WHERE status='pending'
    async def update_run_completion(self, run_id, *, status, total_tokens=0, ...) -> bool:
    # 多 worker: update_lease / renew_lease / request_cancel / finalize_if_not_cancelled / claim_for_takeover
```

**每个方法独立获取短 session**（`async with self._sf() as session`），不跨方法持有连接——因为 run status 更新来自可能运行数分钟的 background worker。

### ChannelConnectionRepository — 加密凭证

```python title=backend/packages/harness/deerflow/persistence/channel_connections/sql.py
class ChannelCredentialCipher:
    @classmethod
    def from_key(cls, key: str): ...   # SHA-256 → base64 → Fernet
    def encrypt_text(self, value): ...  # "fernet:v1:" + encrypted
class ChannelConnectionRepository:
    # 管 4 表: channel_connections / channel_conversations / channel_credentials / channel_oauth_states
    # credentials Fernet 对称加密；oauth state SHA-256 hash 为 PK
```

### bootstrap_schema — 三路分支

```python title=backend/packages/harness/deerflow/persistence/bootstrap.py
def bootstrap_schema(engine, ...) -> None:
    # _reflect_state → _decide_state:
    #   "empty"    → create_all() + stamp head
    #   "legacy"   → 补建 baseline 表 + stamp 0001_baseline + upgrade head
    #   "versioned"→ alembic upgrade head
    # postgres 用 pg_advisory_lock 串行化 + SET LOCAL idle_in_transaction_session_timeout=0
```

## 调用链路

```
Gateway lifespan (deps.py)
  └─ init_engine_from_config(config.database)
       └─ create_async_engine + set PRAGMAs/connect_args + async_sessionmaker
       └─ bootstrap_schema(engine):
            ├─ _reflect_state(sync_conn)  # 检查 DeerFlow 表 + alembic_version
            ├─ _decide_state → empty/legacy/versioned
            ├─ acquire lock (pg_advisory_lock / asyncio.Lock)
            ├─ create_all / baseline+stamp / upgrade head
            └─ release lock
  └─ app.state.run_store = RunRepository(sf)  # 注入到各 router

一次 run 持久化:
  RunRepository.put(run_id, status="pending")     # INSERT
  ... agent 执行 ...
  RunRepository.start_run(run_id)                  # UPDATE WHERE status='pending' → running
  ... 完成 ...
  RunRepository.update_run_completion(run_id, status="success", total_tokens=...)  # CAS guard
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| Repository | `run/sql.py`、`channel_connections/sql.py` 等 | 每个 domain 子包一个 Repository，注入 `async_sessionmaker`，封装 SQL |
| DAO / Store 抽象 | `runtime/runs/store/base.py:RunStore` ABC | `MemoryRunStore`（开发）+ `RunRepository`（SQL）双实现 |
| 策略（多后端） | `engine.py:init_engine(backend)` | memory/sqlite/postgres 三分支，Repository 无感知 |
| 迁移 | `migrations/` Alembic | 11 version 文件线性链，`safe_add_column` 幂等 |
| 双重实现 | `agents/file.py:FileAgentStore` + `agents/sql.py:SqlAgentStore` | agent 配置存储 file/db 双后端，配置切换 |
| 全局单例 | `engine.py` `_engine`/`_session_factory` | 模块级单例，`init/close` 管理生命周期 |
| Fernet 加密 | `ChannelCredentialCipher` | 凭证加密，passphrase SHA-256 派生 key |

## 模块间交互

- **依赖**：`config`（`DatabaseConfig` backend/url/pool、`AgentConfig` 路径、`postgres_schema`）、`runtime.user_context`（`resolve_user_id` 多用户隔离）、`utils.time`（`coerce_iso` datetime 序列化）。
- **被调用**：`backend/app/gateway/deps.py` lifespan（初始化 engine + 实例化所有 Repository 到 `app.state`）、`routers/channel_connections.py`（per-request）、`channels/service.py`、`tui/persistence.py`、`runtime/events/store/`（`DbRunEventStore`）。
- **与 checkpointer 分离**：`migrations/env.py` 的 `include_object` 过滤 LangGraph 表，应用数据迁移和 graph state 持久化互不干扰。

## 核心实现（续）

### 为什么用 Repository 而非直接 ORM

(1) 可替换——`MemoryRunStore`/`RunRepository` 实现同一 `RunStore`，开发用 memory 生产用 SQL；(2) 短 session 生命周期——background worker 可能活数分钟，不能跨执行持有连接；(3) user 隔离在 Repository 层统一处理（`resolve_user_id`）。

### 为什么 postgres + sqlite 双后端

SQLite 单节点零配置（开发/小团队/TUI），设 WAL（并发读写不阻塞）+ `synchronous=NORMAL`（checkpoint 边界 fsync）+ `busy_timeout=30000`（跨进程 bootstrap 等待）；Postgres 多实例生产，`pool_pre_ping`（防 stale socket）+ `pool_recycle=300s` + `command_timeout=30s` + advisory lock 跨进程串行化。

### 为什么 json_compat

`metadata_json` 等 JSON 列需按 key 做 WHERE 过滤，但 SQLite（`json_extract`）和 PostgreSQL（`->`/`->>`）语法不同。`JsonMatch(ColumnElement)` 是 dialect-portable 的 `column[key] == value`，通过 `@compiles` 分别编译，处理 bool vs int、NULL vs missing、int64 溢出保护、SQL 注入防护（key 限 `[A-Za-z0-9_-]+`）。

### 为什么 bootstrap 三路分支而非直接 alembic upgrade

空 DB 用 `create_all` 更忠实（JSON/JSONB、server defaults、index 名在 dialect 间自动适配）；legacy DB（pre-alembic）直接 stamp head 会漏掉 baseline 后新 revision 加的表——先 `create_all` 补建 baseline 表再 stamp 再 upgrade。`idle_in_transaction_session_timeout=0` 防 Managed Postgres 在 alembic 长跑时 kill idle session 释放 advisory lock 导致并发 DDL。

### safe_add_column 解决什么

幂等（列已存在 no-op，防御 retry/手动 ALTER）；drift 检测（列存在但 shape 不符时 warning 不自动修复——覆盖真实事故 #3682 手动 ALTER 漏 `NOT NULL DEFAULT`）；type 同义对（JSON vs JSONB 不报警）。

## 扩展方式

### 新增一张表 + Repository

`persistence/<domain>/model.py` 定义 ORM `Row(Base)` + `__table_args__` 索引；注册到 `models/__init__.py`；`<domain>/sql.py` 写 Repository（每方法 `async with sf()`）；`migrations/versions/` 新建 migration（新增列用 `safe_add_column`，新增表用 `op.create_table`）；若属 baseline 更新 `bootstrap.py` 的 `_BASELINE_TABLE_NAMES`；`deps.py` 实例化。

### 给现有表加一列

更新 ORM model 加 `mapped_column`；新建 migration 调 `safe_add_column("table", sa.Column(...))`（自动幂等）；更新 Repository 的 `put()` values。无需改 `bootstrap.py`。

### 换 DB 后端（sqlite→postgres）

纯配置：`config.yaml` 的 `database.backend: postgres` + `url`；`uv sync --extra postgres`；可选 `postgres_schema`。`bootstrap_schema` 自动检测 empty→create_all+stamp。Repository 零改动——dialect 差异由 SQLAlchemy + `json_compat` 抹平。

对应测试：`backend/tests/persistence/` 下各 Repository 单测 + `test_bootstrap.py` + `test_migrations.py`。
