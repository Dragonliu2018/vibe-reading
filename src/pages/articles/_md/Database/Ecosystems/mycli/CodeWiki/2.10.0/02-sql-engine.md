---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "SQL 执行引擎详解"
date: "2026-08-07T01:20:00+08:00"
category: [Database, Ecosystems, mycli, CodeWiki, "2.10.0"]
tags: ["mycli", "Python", "pymysql", "SQL", "Generator"]
description: "mycli SQL 执行引擎深度解读：SQLExecute 封装 pymysql、Generator 流式执行、连接管理、三级重连策略、沙箱模式。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/mycli/CodeWiki/2.10.0/00-overview)

---

## SQLExecute：pymysql 封装核心

`SQLExecute` 是 mycli 与 MySQL 服务器交互的唯一入口，封装了连接管理、SQL 执行和元数据查询：

```python title="mycli/sqlexecute.py"
class SQLExecute:
    databases_query = "SHOW DATABASES"
    tables_query = "SHOW TABLES"
    table_columns_query = "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns ..."

    def __init__(self, database, user, password, host, port, socket,
                 character_set, local_infile, ssl, init_command=None, ...): ...

    def run(self, statement: str) -> Generator[SQLResult, None, None]: ...
    def get_result(self, cursor: Cursor) -> SQLResult: ...
    def tables(self) -> Generator[tuple[str], ...]: ...
    def table_columns(self, schema=None) -> Generator[tuple[str, str], ...]: ...
    def close(self) -> None: ...
```

关键属性：`self.conn`（pymysql Connection）、`self.dbname`、`self.server_info`（ServerInfo）、`self.connection_id`、`self.sandbox_mode`。

## Generator 流式执行

`run()` 返回 `Generator[SQLResult]` 而非 `list[SQLResult]`，解决三个问题：

```python title="mycli/sqlexecute.py — run()"
def run(self, statement: str) -> Generator[SQLResult, None, None]:
    components = iocommands.split_queries(statement)  # 拆分多语句
    for sql in components:
        # 处理 \G \g \x 后缀标记
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
- **大结果集内存**：配合 `SSCursor`（unbuffered）实现流式处理

## SQLResult：统一结果结构

```python title="mycli/packages/sqlresult.py"
@dataclass
class SQLResult:
    preamble: str | None = None        # 前言文本
    header: list[str] | str | None = None  # 列名
    rows: Cursor | list[tuple] | None = None  # 数据行
    postamble: str | None = None       # 后言文本
    status: str | FormattedText | None = None  # 状态信息（如 "3 rows in set"）
    command: dict[str, str | float] | None = None  # 命令元数据
    image: bytes | None = None         # 图片输出（iTerm2/Kitty）
```

`SQLResult` 是执行引擎与输出层之间的契约——special command 和普通 SQL 都产出相同结构，输出层无需区分来源。

## 连接管理

### 服务器类型探测

```python title="mycli/sqlexecute.py — ServerInfo"
class ServerSpecies(enum.Enum):
    MySQL = "MySQL"
    MariaDB = "MariaDB"
    Percona = "Percona"
    TiDB = "TiDB"
    Doris = "Doris"
    Unknown = "Unknown"

class ServerInfo:
    @classmethod
    def from_version_string(cls, version_string: str) -> ServerInfo:
        # 正则匹配 species
```

Doris 的版本字符串伪装成 MySQL 格式，正则无法区分。连接成功后主动执行 `SELECT @@version_comment, @@version` 探测是否为 Doris——"先正则、后探测"的两阶段策略。

### 三级渐进重连

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

每一级降级输出更严重的警告。这种"最小副作用"原则在不可靠网络环境下保证可用性，同时尽可能保留用户 session 状态（`@变量`、`USE` 的库等）。

### 沙箱模式

`connect()` 捕获 `ER_MUST_CHANGE_PASSWORD` 后，通过 `_connect_sandbox()` 重新连接——临时将 `set_character_set` 替换为 no-op，跳过所有 post-handshake 查询。这让用户在密码过期时仍能进入 CLI 执行 `ALTER USER` 修改密码。

### SSL 自动降级

`_connect()` 捕获 `HANDSHAKE_ERROR`，当 SSL mode 为 `auto` 时自动禁用 SSL 重试。用户不需要手动指定 `--ssl-mode=off`。

## 命令分发：Chain of Responsibility

```python title="mycli/sqlexecute.py — run() 中的命令分发"
try:
    yield from execute(cur, sql)        # 先尝试 special command
except CommandNotFound:                 # 失败则降级为普通 SQL
    cur.execute(sql)
```

`execute()` 来自 `mycli.packages.special.main`，处理所有 `\` 前缀的客户端命令。当命令不匹配时抛出 `CommandNotFound`，由外层 catch 降级为普通 SQL 执行。

## 关键设计决策

**Generator 而非 list**：如果用 list 返回，必须等所有结果集执行完毕才能返回，大查询会导致内存爆炸。Generator 让上层 `run_query()` 可以逐结果格式化输出。

**元数据查询容错**：各 metadata 查询方法（`indexed_columns`、`foreign_keys`、`procedures` 等）单独捕获 `pymysql.DatabaseError`，仅记录日志不传播——补全失败不应影响主流程。

**Mixin + TYPE_CHECKING**：`ClientQueryMixin` 和 `ClientConnectionMixin` 各自独立封装，用 `if TYPE_CHECKING:` 声明对其他 Mixin 属性的依赖，不引入运行时耦合。每个 Mixin 可以独立测试。
