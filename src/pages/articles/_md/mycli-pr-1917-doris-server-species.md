---
title: "识别 Apache Doris：连接后探测替代握手识别"
source:
  project: "MyCLI"
  type: "PR"
  id: "1917"
  url: "https://github.com/dbcli/mycli/pull/1917"
  prType: "feat"
date: "2026-07-04"
category: [Database, 生态, mycli, Contributions]
tags: ["Apache Doris", "MySQL Protocol"]
description: "Apache Doris 伪装成 MySQL 5.7.99 与客户端握手，无法从版本字符串区分。本文记录如何在连接后用一条 SQL 探测 @@version_comment 来识别 Doris 并显示真实版本。"
readingTime: "7 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1917](https://github.com/dbcli/mycli/pull/1917) · **Issue** `-` · **commit** [9d32067](https://github.com/dbcli/mycli/commit/9d32067d3c6e7cf13f5ad52d0f0180226fcc1e88) · **首发版本** v1.74.0 · **变更行数** +38 行 · **合并时间** 2026-06-06

---

## 背景

Apache Doris 是一款兼容 MySQL 协议的 OLAP 数据库。"兼容"在握手层意味着：Doris 在 MySQL 握手报文的 `server_version` 字段中硬编码了 `5.7.99`，让所有 MySQL 客户端都能无缝接入。

这给 mycli 带来了识别难题。mycli 连接时会解析握手版本字符串来判断数据库类型（MySQL / MariaDB / TiDB / Percona），然后在欢迎横幅和提示符中显示。由于 Doris 发来的是 `5.7.99`，mycli 将其识别为普通 MySQL，欢迎横幅显示如下：

```text title="修复前：Doris 被误认为 MySQL"
MySQL
MySQL root@doris-host:(none)>
```

版本号为空，数据库类型错误。修复后：

```text title="修复后：正确识别 Doris"
Doris 2.1.7
Doris root@doris-host:(none)>
```

---

## 前置知识

### MySQL 握手版本字段的局限

MySQL 协议握手阶段（Handshake v10 包）中 `server_version` 是一个以 `\0` 结尾的字符串，供客户端判断服务端类型和能力集。各数据库在此字段各有约定：

| 数据库 | 握手版本字段示例 |
| --- | --- |
| MySQL（官方）| `8.0.32-debian` / `9.6.0` |
| MariaDB | `10.5.8-MariaDB-1:10.5.8+maria~focal` |
| TiDB | `5.7.25-TiDB-v6.1.0` |
| Percona | `5.7.32-35` |
| **Apache Doris** | `5.7.99`（硬编码，故意模仿 MySQL）|

Doris 选择 `5.7.99` 是为了声明"我兼容 MySQL 5.7"，这让所有依赖握手字段区分数据库的方案都失效了。

### @@version_comment：协议层之外的后门

虽然 Doris 在握手层伪装成 MySQL，但它的系统变量暴露了真实身份：

```sql title="在 Doris 上执行"
SELECT @@version_comment, @@version;
-- @@version_comment: 'doris-2.1.7-rc01'
-- @@version:         '5.7.99'
```

`@@version_comment` 通常由数据库厂商写入构建信息，Doris 会在这里留下"doris"字样；`@@version` 仍是 `5.7.99`，但也可能在某些部署中含有"doris"。这是连接后识别 Doris 的可靠入口。

---

## 实现

### 整体思路

握手层无法区分 Doris 和 MySQL，因此识别窗口移到连接建立之后——用一条轻量 SQL 查询两个系统变量，用"doris"关键字判定，再用正则提取真实版本号。

识别只在握手结果为 `MySQL` 时触发，其他类型（MariaDB、TiDB、Percona）不做额外探测，保证对非 Doris 用户无感知。

### `ServerSpecies` 新增枚举值

`ServerSpecies`（`mycli/sqlexecute.py`）是 mycli 内部表示数据库类型的枚举：

```python title="mycli/sqlexecute.py"
class ServerSpecies(enum.Enum):
    MySQL = "MySQL"
    MariaDB = "MariaDB"
    Percona = "Percona"
    TiDB = "TiDB"
    Doris = "Doris"    # ← 新增
    Unknown = "Unknown"
```

枚举值字符串 `"Doris"` 直接用于欢迎横幅和提示符（`ServerInfo.__str__` 返回 `f"{self.species.value} {self.version_str}"`）。

### `connect()` 中的探测分支

连接成功后，原先只有一行赋值；现在变成了条件探测：

```python title="mycli/sqlexecute.py — connect() 方法节选（修复后）"
# retrieve connection id (skip in sandbox mode as queries will fail)
if not self.sandbox_mode:
    self.reset_connection_id()
    server_info = ServerInfo.from_version_string(conn.server_version)
    if server_info.species == ServerSpecies.MySQL:          # ① 握手结果是 MySQL 才探测
        if (doris_version := self._probe_doris_version()) is not None:  # ② 探测不为 None
            server_info = ServerInfo(ServerSpecies.Doris, doris_version)  # ③ 覆盖为 Doris
    self.server_info = server_info
```

三步逻辑：
1. 握手版本字符串解析结果是 `MySQL` → 进入探测（其他类型直接跳过）
2. `_probe_doris_version()` 返回 `None` 表示"确认不是 Doris 或探测失败"，返回非 `None`（含空字符串 `""`）表示"确认是 Doris"
3. 用新的 `ServerInfo(Doris, version)` 替换握手结果

海象运算符（`:=`）在 `if` 条件里同时完成赋值和判断，避免重复调用。

### `_probe_doris_version()` 实现细节

```python title="mycli/sqlexecute.py — _probe_doris_version()"
def _probe_doris_version(self) -> str | None:
    """Query the server to check if it is Doris. Returns the Doris version string
    (e.g. '2.1.7') if confirmed, or None if the server is not Doris."""
    if self.sandbox_mode or self.conn is None:
        return None
    try:
        with self.conn.cursor() as cur:
            cur.execute("SELECT @@version_comment, @@version")
            row = cur.fetchone()
        if not row:
            return None
        version_comment = str(row[0] or "")
        version = str(row[1] or "")
        if "doris" not in version_comment.lower() and "doris" not in version.lower():
            return None
        # Prefer @@version_comment which usually carries the real Doris version string
        # (e.g. "doris-2.1.7-rc01"), then fall back to @@version.
        for candidate in (version_comment, version):
            ver_match = re.search(r"([0-9]+\.[0-9]+\.[0-9]+)", candidate)
            if ver_match:
                return ver_match.group(1)
        # Doris confirmed but couldn't parse a version number
        return ""
    except Exception as e:
        _logger.debug("Doris detection failed: %s", e)
    return None
```

几个关键设计决策：

**返回值语义区分"不是 Doris"和"是 Doris 但无版本"：**

| 返回值 | 含义 |
| --- | --- |
| `None` | 不是 Doris，或探测失败（网络错误等） |
| `""` | 确认是 Doris，但无法提取版本号 |
| `"2.1.7"` | 确认是 Doris，真实版本号 |

调用侧 `if ... is not None` 只排除 `None`，所以空字符串 `""` 也会触发 Doris 识别——欢迎横幅显示 `Doris`（无版本号），比误显示 `MySQL` 更准确。

**双字段探测顺序：**

`@@version_comment` 优先，因为 Doris 通常在这里保存完整构建版本 `"doris-2.1.7-rc01"`，能提取出 `2.1.7`；`@@version` 作为兜底，应对少数部署中 `version_comment` 不含版本号的情况。

**大小写不敏感匹配：**

```python
if "doris" not in version_comment.lower() and "doris" not in version.lower():
    return None
```

`.lower()` 确保 `"Apache Doris"` `"DORIS"` 等变体均能被识别。

**静默异常处理：**

```python
except Exception as e:
    _logger.debug("Doris detection failed: %s", e)
return None
```

捕获所有异常并以 `debug` 级别记录，对用户完全透明。探测失败时 mycli 继续以 MySQL 身份使用，不影响正常功能。

### 调用链全景

```text title="Doris 识别完整调用链"
pymysql 握手 → conn.server_version = "5.7.99"
  ↓ sqlexecute.py:313  ServerInfo.from_version_string("5.7.99")
  →  ServerInfo(species=MySQL, version_str="5.7.99")

  ↓ sqlexecute.py:314  species == MySQL → 触发探测
  ↓ sqlexecute.py:315  _probe_doris_version()
      SELECT @@version_comment, @@version
      → ("doris-2.1.7-rc01", "5.7.99")
      → "doris" 在 version_comment → 提取 "2.1.7"
      → return "2.1.7"

  ↓ sqlexecute.py:316  ServerInfo(species=Doris, version_str="2.1.7")
  ↓ sqlexecute.py:317  self.server_info = server_info

  ↓ repl.py:149        print(sqlexecute.server_info)  →  "Doris 2.1.7"
  ↓ repl.py:291        species_name = "Doris"          →  提示符 \t = "Doris"
```

`\t` 是 mycli 提示符模板中表示数据库类型的占位符。Doris 识别后，提示符会从 `MySQL root@host:(none)>` 变为 `Doris root@host:(none)>`。

---

## Review

PR 提交后，维护者 rolandwalker 在合并前提出了一条意见：

> "In this PR, we could also update the list of supported servers in the README."

README 第 12 行原文为 `Mycli is compatible with MySQL, MariaDB, Percona, and TiDB.`，未列出 Doris。作者随即更新：

```diff title="README.md"
-Mycli is compatible with MySQL, MariaDB, Percona, and TiDB.
+Mycli is compatible with MySQL, MariaDB, Percona, TiDB, and Doris.
```

维护者回复 `"Perfect!"` 后合并。

---

## 测试

PR 本身未包含针对 `_probe_doris_version` 的单元测试。维护者 rolandwalker 在两天后提交了 [PR #1927](https://github.com/dbcli/mycli/pull/1927)，专门补充测试覆盖，包含以下场景：

| 测试函数 | 覆盖场景 |
| --- | --- |
| `test_connect_replaces_mysql_server_info_when_doris_probe_succeeds` | 探测成功时 `server_info` 被替换为 Doris |
| `test_probe_doris_version_returns_none_without_connection` | `conn` 为 `None` 时返回 `None` |
| `test_probe_doris_version_returns_none_in_sandbox_mode` | sandbox 模式下返回 `None` |
| `test_probe_doris_version_returns_none_when_query_has_no_rows` | 查询无行时返回 `None` |
| `test_probe_doris_version_returns_none_when_server_is_not_doris` | 普通 MySQL 版本注释不触发识别 |
| `test_probe_doris_version_extracts_version_from_comment` | 从 `version_comment` 提取版本号 |
| `test_probe_doris_version_falls_back_to_server_version` | `version_comment` 无版本时降级读 `@@version` |

---

## 意义与影响

Doris 的 MySQL 协议兼容策略是一把双刃剑：让所有 MySQL 工具开箱即用，但也让工具无法感知自己连接的是 OLAP 引擎而非 MySQL。mycli 通过"连接后探测"绕开了握手层的限制，以一条 `SELECT @@version_comment, @@version` 换来了准确的数据库标识。

此方案具有良好的扩展性——若未来需要支持其他伪装成 MySQL 的数据库，可以在同一个 `if server_info.species == MySQL` 分支下追加类似的 `_probe_xxx_version()` 函数，无需修改握手解析逻辑。

探测查询仅在每次连接时执行一次，对交互性能无可感知影响；异常被静默捕获，不影响普通 MySQL 用户的使用体验。
