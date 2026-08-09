---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "SQL 执行引擎"
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

SQL 执行引擎的内部设计要回答一个核心问题：**如何在保持 MySQL 协议封装的同时，让连接管理和 SQL 执行各自独立演化？** 答案是 Mixin 分离——`ClientConnectionMixin` 和 `ClientQueryMixin` 位于客户端层，前者专注于连接生命周期（多源密码、SSH 隧道、重连），后者负责查询执行的协调。两者分离的逻辑在于：连接管理需要处理网络不可靠、认证降级等基础设施问题，而查询执行关注的是 SQL 语义和多结果集处理，两者的变更频率和关注点完全不同，放在同一个类中会导致职责膨胀。

`SQLExecute` 是执行层核心，选择封装 `pymysql.Connection` 而非直接暴露驱动，有三个考量：其一，pymysql 的 `Cursor`/`Connection` API 细节（如 `nextset()` 多结果集遍历、`ping(reconnect)` 语义）不应渗透到上层；其二，`run()` 返回 `Generator[SQLResult]` 而非 `list`，让大结果集可以流式处理而不一次性占满内存；其三，元数据查询（`tables()`/`table_columns()`）与 SQL 执行共享同一个连接和 cursor 生命周期，封装后上层无需关心 cursor 复用策略。

`ServerInfo`/`ServerSpecies` 解决的是**服务器类型探测的可靠性问题**。`from_version_string()` 通过工厂方法用正则匹配 MySQL/MariaDB/Percona/TiDB 的版本字符串——之所以需要独立探测，是因为不同数据库物种在 SQL 方言、补全规则、特殊命令支持上差异显著，上层需要据此选择正确的行为分支。Doris 的特殊情况（版本字符串伪装成 MySQL 格式）更说明：仅靠协议握手不足以判断真实物种，连接后必须主动执行 `SELECT @@version_comment` 二次验证。

## 调用链路

![SQL 执行引擎调用链路](/vibe-reading/images/articles/mycli-internals/sql-engine-call-chain.svg)

SQL 执行引擎有两条核心调用路径，分别回答"用户输入的 SQL 如何执行"和"连接断开如何恢复"两个问题。

**查询执行路径**（路径 A）从 `run_query(str)` 进入 `SQLExecute.run()`，返回 `Generator[SQLResult]`。这条路径有三个关键设计决策。第一，`run()` 返回 Generator 而非 list——这样多语句拆分后逐条 yield、存储过程多结果集逐个 yield、大结果集不一次性 fetchall，三种场景统一用惰性求值解决内存压力。第二，每条语句先尝试 `special.execute()` 分发，抛出 `CommandNotFound` 才降级为 `cur.execute(sql)`——这是 Chain of Responsibility 模式，让 special command（如 `\d`、`\dt`）和普通 SQL 共用同一条入口，上层无需区分。第三，`get_result(cursor)` 让 `SQLResult.rows` 直接持有 Cursor 而非 fetchall，配合 `SSCursor` 实现真正的流式输出。

**重连路径**（路径 B）采用三级渐进策略，核心原则是**最小副作用**——每级只在上一级失败时才升级，尽可能保留用户 session 状态。第 1 级 `ping(reconnect=False)` 是轻量探测，零副作用，如果连接还活着就直接返回，不丢失任何 `@变量` 或 `USE` 的库。第 2 级 `ping(reconnect=True)` 让 pymysql 内部重连，可能保留 session 状态但成功率取决于服务端是否维护了会话。第 3 级 `connect()` 完全重建连接，session 状态全部丢失——这是最后的手段。之所以渐进而非直接重建，是因为在不可靠网络（如 SSH 隧道断流）下，多数"断线"只是暂时的 TCP 心跳丢失，连接本身可能仍有效，直接重建会不必要地丢失用户的临时表、会话变量等状态。

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

SQL 执行引擎在 mycli 的模块依赖图中扮演**核心枢纽**角色——`sqlexecute.py` 是扇入最高的模块（8 个生产文件引用它），几乎所有上层组件最终都要通过它才能与数据库交互。理解这个枢纽的依赖关系，就能理解整个 mycli 的协作架构。

**谁依赖 sqlexecute**：REPL 主循环（`main.py`）通过 `run_query()` 调用它执行用户输入；补全刷新器（`completion_refresher.py`）调用它的 `tables()`/`table_columns()` 等元数据方法构建补全索引；`client_connection.py` 的重连逻辑直接操作它的 `conn` 属性和 `connect()` 方法。sqlexecute 对外暴露的接口是稳定的 `Generator[SQLResult]` 和元数据查询方法，内部如何管理 pymysql 的 cursor 和连接对调用方不可见——这种封装让上层组件可以独立演化。

**sqlexecute 依赖了什么**：它 import `pymysql`（DB 驱动，负责底层协议）、`packages.special.iocommands` 的 `split_queries`（语句拆分）、`packages.special.main` 的 `execute`/`CommandNotFound`（special command 分发）、`packages.sqlresult` 的 `SQLResult`（统一结果契约）。这条依赖链回答了"SQL 从输入到执行经历了什么"：`split_queries` 先拆分多语句，`execute` 尝试 special command 分发，失败则降级为 `cur.execute(sql)`，结果统一封装为 `SQLResult`。

**special 模块如何融入执行流程**：`split_queries` 和 `execute` 来自 `packages.special`，它们不是 sqlexecute 的内部方法而是独立模块。这种设计让 special command（如 `\d table`、`system` shell 命令）可以独立扩展——新增 special command 只需在 special 模块注册，不需要修改 sqlexecute。`CommandNotFound` 作为降级信号是这条协作链的关键：special 模块用异常告诉 sqlexecute"这条不是我能处理的"，sqlexecute据此降级为普通 SQL 执行，两个模块通过异常实现了松耦合的职责分发。

## 扩展方式

- **新增数据库物种支持**：`ServerSpecies` 枚举加值 → `ServerInfo.from_version_string()` 加正则 → 如需主动探测（如 Doris），在 `connect()` 中加探测逻辑
- **新增补全元数据类型**：`sqlexecute.py` 加 Generator 查询方法 → `completion_refresher.py` 加 `@refresher` 函数调用它
- **新增密码源**：`client_connection.py:connect()` 中 `password_candidates.add_loader()` 注册新源
