---
title: "修复 Homebrew MySQL 版本号不显示"
source:
  project: "MyCLI"
  type: "PR"
  id: "1916"
  url: "https://github.com/dbcli/mycli/pull/1916"
  prType: "fix"
date: "2026-07-04"
category: [Database, 生态, mycli, Contributions]
tags: ["MySQL", "Regex"]
description: "修复通过 Homebrew 安装的 MySQL 启动时版本号不显示的问题：正则漏匹配了无后缀的纯 X.Y.Z 版本字符串。"
readingTime: "5 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1916](https://github.com/dbcli/mycli/pull/1916) · **Issue** `-` · **commit** [966a54a](https://github.com/dbcli/mycli/commit/966a54ae9e36ce4fa8fd7721a544234d3065323d) · **首发版本** v1.74.0 · **变更行数** +5 行 · **合并时间** 2026-06-06

---

## 背景

通过 Homebrew 安装的 MySQL（以及部分其他发行版）在握手阶段返回的版本字符串是纯粹的 `X.Y.Z` 格式，例如：

```text title="MySQL Homebrew 握手版本字符串示例"
9.6.0
```

而官方二进制包、Debian 包或开启了特定选项的 MySQL 通常会携带后缀，例如：

```text title="常见的带后缀版本字符串"
9.6.0-log
8.0.32-debian
5.7.32-0ubuntu0.18.04.1
```

mycli 在连接成功后会打印欢迎横幅，包含数据库类型和版本号。受此 bug 影响时，横幅输出如下：

```text title="bug 复现：欢迎横幅中版本号消失"
MySQL 
mycli 1.73.0
```

`MySQL` 后面跟着一个多余的空格，版本号完全丢失。修复后：

```text title="修复后：正确显示版本号"
MySQL 9.6.0
mycli 1.73.0
```

---

## 前置知识

### Python for/else 循环

Python 的 `for` 语句支持 `else` 子句：当循环**正常结束**（未触发 `break`）时执行 `else` 块；若循环因 `break` 提前退出，则 `else` 块被跳过。

```python title="for/else 示意"
for item in items:
    if condition(item):
        result = item
        break
else:
    result = default  # 仅在未 break 时执行
```

mycli 的版本解析逻辑正是利用了这个特性：按顺序尝试各数据库类型的正则，第一个命中的就 `break`；若全部失败则进入 `else` 分支。

---

## 实现

### 调用链路

mycli 建立连接时，版本信息经过以下路径最终呈现在终端：

```text title="版本信息调用链"
pymysql 握手 → conn.server_version（原始字符串）
  ↓ sqlexecute.py:313
ServerInfo.from_version_string()   # 解析 species + version_str
  ↓ sqlexecute.py:317
SQLExecute.server_info             # 存储解析结果
  ↓ main_modes/repl.py:149
print(sqlexecute.server_info)      # __str__ 输出欢迎横幅
```

### ServerInfo 数据结构

`ServerInfo`（`mycli/sqlexecute.py`）持有两个核心字段：

```python title="mycli/sqlexecute.py"
class ServerSpecies(enum.Enum):
    MySQL = "MySQL"
    MariaDB = "MariaDB"
    Percona = "Percona"
    TiDB = "TiDB"
    Doris = "Doris"
    Unknown = "Unknown"


class ServerInfo:
    def __init__(self, species: ServerSpecies | None, version_str: str) -> None:
        self.species = species
        self.version_str = version_str
        self.version = self.calc_mysql_version_value(version_str)

    def __str__(self) -> str:
        if self.species:
            return f"{self.species.value} {self.version_str}"
        else:
            return self.version_str
```

`__str__` 拼接 `species.value`（如 `"MySQL"`）与 `version_str`。当 `version_str` 为空字符串时，结果就是 `"MySQL "`——这正是 bug 的直接原因。

### 版本解析正则（修复前后对比）

`from_version_string()` 依次对原始版本字符串尝试以下正则，首个命中即 `break`：

```python title="mycli/sqlexecute.py（修复前）"
re_species = (
    (r"(?P<version>[0-9\.]+)-MariaDB", ServerSpecies.MariaDB),
    (r"[0-9\.]*-TiDB-v(?P<version>[0-9\.]+)-?(?P<comment>[a-z0-9\-]*)", ServerSpecies.TiDB),
    (r"(?P<version>[0-9\.]+)[a-z0-9]*-(?P<comment>[0-9]+$)", ServerSpecies.Percona),
    # ↓ 旧的 MySQL 兜底正则：要求必须有 - 分隔符
    (r"(?P<version>[0-9\.]+)[a-z0-9]*-(?P<comment>[A-Za-z0-9_]+)", ServerSpecies.MySQL),
)
```

旧正则最后一条要求 `-` 必须存在（`-(?P<comment>...)`），纯 `9.6.0` 无法匹配，循环到 `else` 分支：

```python title="mycli/sqlexecute.py（else 分支——修复前的兜底）"
else:
    detected_species = ServerSpecies.MySQL
    parsed_version = ""      # ← version_str 被置为空字符串
```

**修复**：将最后一条 MySQL 正则的后缀部分改为可选（`(-...)?`），同时将版本号模式从宽松的 `[0-9\.]+` 收窄为严格的 `[0-9]+\.[0-9]+\.[0-9]+`：

```python title="mycli/sqlexecute.py（修复后）"
re_species = (
    (r"(?P<version>[0-9\.]+)-MariaDB", ServerSpecies.MariaDB),
    (r"[0-9\.]*-TiDB-v(?P<version>[0-9\.]+)-?(?P<comment>[a-z0-9\-]*)", ServerSpecies.TiDB),
    (r"(?P<version>[0-9\.]+)[a-z0-9]*-(?P<comment>[0-9]+$)", ServerSpecies.Percona),
    # ↓ 新的 MySQL 兜底正则：后缀 - 分隔符改为可选，同时收窄版本号格式
    # Also matches plain "X.Y.Z" with no suffix (e.g. Homebrew MySQL).
    (r"(?P<version>[0-9]+\.[0-9]+\.[0-9]+)[a-z0-9]*(-(?P<comment>[A-Za-z0-9_]+))?", ServerSpecies.MySQL),
)
```

两处关键改动：

| 改动 | 旧模式 | 新模式 | 说明 |
| --- | --- | --- | --- |
| 后缀分隔符 | `-(?P<comment>[A-Za-z0-9_]+)` | `(-(?P<comment>[A-Za-z0-9_]+))?` | `?` 使整个后缀组变为可选 |
| 版本号格式 | `[0-9\.]+` | `[0-9]+\.[0-9]+\.[0-9]+` | 明确要求三段式，避免误匹配单纯数字 |

修复后，`9.6.0` 直接命中最后一条 MySQL 正则，`parsed_version = "9.6.0"`，循环 `break`，不再落入 `else`。

---

## 测试

### 单元测试

测试文件 `test/pytests/test_sqlexecute.py` 中的参数化测试 `test_version_parsing` 新增了一条 Homebrew 场景用例：

```python title="test/pytests/test_sqlexecute.py"
@pytest.mark.parametrize(
    "version_string, species, parsed_version_string, version",
    (
        ("5.7.25-TiDB-v6.1.0", "TiDB", "6.1.0", 60100),
        ("8.0.11-TiDB-v7.2.0-alpha-69-g96e9e68daa", "TiDB", "7.2.0", 70200),
        ("5.7.32-35", "Percona", "5.7.32", 50732),
        ("5.7.32-0ubuntu0.18.04.1", "MySQL", "5.7.32", 50732),
        ("10.5.8-MariaDB-1:10.5.8+maria~focal", "MariaDB", "10.5.8", 100508),
        ("5.5.5-10.5.8-MariaDB-1:10.5.8+maria~focal", "MariaDB", "10.5.8", 100508),
        ("5.0.16-pro-nt-log", "MySQL", "5.0.16", 50016),
        ("5.1.5a-alpha", "MySQL", "5.1.5", 50105),
        # Plain X.Y.Z with no suffix (e.g. Homebrew MySQL)   ← 新增
        ("5.7.99", "MySQL", "5.7.99", 50799),
        ("unexpected version string", None, "", 0),
        ("", None, "", 0),
        (None, None, "", 0),
    ),
)
def test_version_parsing(version_string, species, parsed_version_string, version):
    server_info = ServerInfo.from_version_string(version_string)
    assert (server_info.species and server_info.species.name) == species or ServerSpecies.MySQL
    assert server_info.version_str == parsed_version_string
    assert server_info.version == version
```

新增的 `("5.7.99", "MySQL", "5.7.99", 50799)` 覆盖了纯 `X.Y.Z` 格式，验证 species 为 `MySQL`、解析出的版本字符串完整、整数化版本值正确。

---

## 意义与影响

这是一个典型的正则边界漏洞：现有模式覆盖了绝大多数真实环境，唯独遗漏了"版本字符串无后缀"这一合法但少见的格式。Homebrew 维护的 MySQL 二进制包恰好属于这一类型，导致用户在 macOS 上使用 mycli 时欢迎横幅版本号静默丢失。

修复仅改动**一条正则**（MySQL 兜底规则），且改动是严格向后兼容的——将必选的后缀改为可选，不影响任何已能匹配的版本字符串。同时收窄版本号格式（`[0-9\.]+` → `[0-9]+\.[0-9]+\.[0-9]+`），使模式语义更精确。

版本号不仅用于显示：`ServerInfo.version`（整数化值，如 `90600`）在 `completion_refresher.py` 等处被用于按服务器版本做功能分支，`version_str` 为空会导致 `calc_mysql_version_value` 返回 `0`，可能影响依赖版本比较的逻辑。此修复一并消除了这一隐患。
