---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "SQL 执行引擎详解"
date: "2026-08-09T10:20:00+08:00"
category: [Database, Ecosystems, mycli, CodeWiki, "2.10.0"]
tags: ["mycli", "Python", "pymysql", "SQL", "Generator"]
description: "mycli SQL 执行引擎深度解读：SQLExecute 封装 pymysql、Generator 流式执行、连接管理、三级重连策略、沙箱模式。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/mycli/CodeWiki/2.10.0/00-overview)

---

## 模块定位

SQL 执行引擎是 mycli 与 MySQL 服务器交互的唯一入口，封装了连接管理、SQL 执行和元数据查询。它对上层提供统一的 `Generator[SQLResult]` 接口，隔离 pymysql 协议细节，使 REPL 和 batch 模式无需关心数据库驱动的具体实现。

## 模块架构

![SQL 执行引擎模块架构](/vibe-reading/images/articles/mycli-internals/sql-engine-architecture.svg)

`ClientConnectionMixin` 和 `ClientQueryMixin` 位于客户端层，负责连接管理和查询执行的协调。`SQLExecute` 是执行层核心，封装 `pymysql.Connection`，提供 `run()`/`get_result()`/元数据查询方法。`ServerInfo`/`ServerSpecies` 通过工厂方法从版本字符串探测数据库类型（MySQL/MariaDB/Doris 等）。

## 调用链路

![SQL 执行引擎调用链路](/vibe-reading/images/articles/mycli-internals/sql-engine-call-chain.svg)

路径 A（查询执行）：`run_query(str)` → `SQLExecute.run()` 返回 `Generator[SQLResult]`，内部先 `split_queries()` 拆分多语句，逐条尝试 `special.execute()` 分发（`CommandNotFound` 则降级为 `cur.execute(sql)`），通过 `get_result(cursor)` 提取 `SQLResult`，`cur.nextset()` 循环处理多结果集。路径 B（重连）：三级渐进——`ping(reconnect=False)` 轻量探测 → `ping(reconnect=True)` 保 session → `connect()` 全新连接。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|-------------|
| `SQLExecute.run()` in `sqlexecute.py:357` | 执行 SQL，返回结果流 | Generator 流式 yield，支持多语句+多结果集 |
| `SQLExecute.get_result()` in `sqlexecute.py:408` | 从 cursor 提取 SQLResult | rows 直接持有 Cursor，不 fetchall |
| `SQLExecute.connect()` in `sqlexecute.py:196` | 建立 pymysql 连接 | 沙箱模式 + SSL 自动降级 + Doris 探测 |
| `ClientConnectionMixin.connect()` in `client_connection.py:49` | 多源密码 + SSH + 连接 | _connect() 闭包递归降级重试 |
| `ClientConnectionMixin.reconnect()` in `client_connection.py:403` | 断线重连 | 三级渐进：ping → ping(reconnect) → 全新连接 |

</details>

---

## 核心实现

### SQLExecute：pymysql 封装核心

`SQLExecute` 封装连接管理、SQL 执行和元数据查询：

```python title="mycli/sqlexecute.py"
class SQLExecute:
    def __init__(self, database, user, password, host, port, socket,
                 character_set, local_infile, ssl, init_command=None, ...): ...

    def run(self, statement: str) -> Generator[SQLResult, None, None]: ...
    def get_result(self, cursor: Cursor) -> SQLResult: ...
    def tables(self) -> Generator[tuple[str], ...]: ...
    def table_columns(self, schema=None) -> Generator[tuple[str, str], ...]: ...
```

关键属性：`self.conn`（pymysql Connection）、`self.dbname`、`self.server_info`（ServerInfo）、`self.connection_id`、`self.sandbox_mode`。

### Generator 流式执行

`run()` 返回 `Generator[SQLResult]` 而非 `list[SQLResult]`，解决三个问题：

```python title="mycli/sqlexecute.py — run()"
def run(self, statement: str) -> Generator[SQLResult, None, None]:
    components = iocommands.split_queries(statement)  # 拆分多语句
    for sql in components:
        try:
            yield from execute(cur, sql)       # 先尝试 special command
        except CommandNotFound:
            cur.execute(sql)                    # 降级为普通 SQL
            while True:
                yield self.get_result(cur)     # 多结果集（存储过程）
                if not cur.nextset(): break
```

- **多语句**：`split_queries()` 拆分后逐个 yield
- **存储过程多结果集**：`cur.nextset()` 循环 yield
- **大结果集内存**：`SQLResult.rows` 直接持有 Cursor（不 fetchall），配合 `SSCursor` 实现流式处理

### SQLResult：统一结果结构

```python title="mycli/packages/sqlresult.py"
@dataclass
class SQLResult:
    preamble: str | None = None        # 前言文本
    header: list[str] | str | None = None  # 列名
    rows: Cursor | list[tuple] | None = None  # 数据行（Cursor 不 fetch）
    postamble: str | None = None       # 后言文本
    status: str | FormattedText | None = None  # 状态信息（如 "3 rows in set"）
    command: dict[str, str | float] | None = None  # 命令元数据
    image: bytes | None = None         # 图片输出（iTerm2/Kitty）
```

`SQLResult` 是执行引擎与输出层之间的契约——special command 和普通 SQL 都产出相同结构，输出层无需区分来源。

### 连接管理

**服务器类型探测**：`ServerInfo.from_version_string()` 用正则匹配 MySQL/MariaDB/Percona/TiDB。Doris 的版本字符串伪装成 MySQL 格式，正则无法区分——连接成功后主动执行 `SELECT @@version_comment, @@version` 探测是否为 Doris。

**三级渐进重连**：

```python title="mycli/client_connection.py — reconnect()"
def reconnect(self, database=""):
    # 第1级: 轻量探测，零副作用
    self.sqlexecute.conn.ping(reconnect=False)
    # 第2级: pymysql 内部重连，可能保留 session 状态
    self.sqlexecute.conn.ping(reconnect=True)
    self.sqlexecute.select_db(dbname)
    # 第3级: 完全重建，session 状态丢失
    self.sqlexecute.connect()
```

每一级降级输出更严重的警告。"最小副作用"原则在不可靠网络下保证可用性，同时尽可能保留用户 session 状态（`@变量`、`USE` 的库等）。

**沙箱模式**：`connect()` 捕获 `ER_MUST_CHANGE_PASSWORD` 后，通过 `_connect_sandbox()` 重新连接——临时将 `set_character_set` 替换为 no-op，跳过所有 post-handshake 查询。让用户在密码过期时仍能执行 `ALTER USER` 修改密码。

**SSL 自动降级**：`_connect()` 闭包捕获 `HANDSHAKE_ERROR`，当 SSL mode 为 `auto` 时自动禁用 SSL 重试，用户不需要手动指定 `--ssl-mode=off`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Generator 流式 | `sqlexecute.py:357` run() | 大结果集不一次性加载内存 |
| Chain of Responsibility | `sqlexecute.py` run() | 先尝试 special，CommandNotFound 降级为 SQL |
| 工厂方法 | `sqlexecute.py:57` ServerInfo.from_version_string | 封装版本字符串正则匹配 |
| 递归重试 | `client_connection.py:284` _connect() 闭包 | SSL 降级 + 密码 fallback，递归比循环更清晰 |
| 策略模式 | `password_sources.py` PasswordCandidates | 按优先级链遍历密码源 |

## 模块间交互

![SQL 执行引擎模块交互](/vibe-reading/images/articles/mycli-internals/sql-engine-interactions.svg)

`sqlexecute.py` import `pymysql`（DB 驱动）、`packages.special.iocommands`（`split_queries`）、`packages.special.main`（`execute`/`CommandNotFound`）、`packages.sqlresult`（`SQLResult`）。`sqlexecute` 是扇入最高的模块（8 个生产文件引用），是整个 mycli 的核心枢纽。`client_connection.py` import `ssh_tunnel.SshTunnel`、`password_sources.PasswordCandidates`、`sqlexecute.SQLExecute`。

## 扩展方式

- **新增数据库物种支持**：`ServerSpecies` 枚举加值 → `ServerInfo.from_version_string()` 加正则 → 如需主动探测（如 Doris），在 `connect()` 中加探测逻辑
- **新增补全元数据类型**：`sqlexecute.py` 加 Generator 查询方法 → `completion_refresher.py` 加 `@refresher` 函数调用它
- **新增密码源**：`client_connection.py:connect()` 中 `password_candidates.add_loader()` 注册新源
