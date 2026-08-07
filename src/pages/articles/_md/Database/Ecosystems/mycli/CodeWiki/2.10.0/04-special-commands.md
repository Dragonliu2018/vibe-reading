---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "特殊命令详解"
date: "2026-08-07T01:40:00+08:00"
category: [Database, Ecosystems, mycli, CodeWiki, "2.10.0"]
tags: ["mycli", "Python", "特殊命令", "装饰器注册", "Favorite Query"]
description: "mycli 特殊命令模块深度解读：@special_command 装饰器注册、execute() 调度、ArgType 策略、Favorite Query 模板渲染。"
readingTime: "7 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/mycli/CodeWiki/2.10.0/00-overview)

---

## 调用链路

```
execute(cur, sql)
├── parse_special_command(sql)               # 拆分 command / verbosity / arg
├── COMMANDS[command] → SpecialCommand     # O(1) 查找
├── [特殊分支] help <keyword>
│   ├── _show_special_help()
│   └── _show_mysql_help()
└── 按 arg_type 分发:
    ├── NO_ARGUMENT  → handler()
    ├── PARSED_QUERY → handler(cur=, arg=, ...)
    └── RAW_QUERY   → handler(cur=, query=sql)

execute_favorite_query(cur, arg)            # \f 命令
├── parse_favorite_query_args(arg)
├── FavoriteQueries.instance.get(name)
├── prepare_favorite_query_args()           # $1/$2 → UUID marker
├── render_favorite_query()                # Jinja2 模板渲染
├── restore_favorite_query_args()          # marker → 真实值
└── for sql in sqlparse.split(query):
    ├── special command → execute(cur, sql)  # 递归回到 execute()
    └── 普通 SQL → cur.execute(sql)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|-------------|
| `execute(cur, sql)` | 命令调度入口，查找并执行 special command | ArgType 三策略选择调用签名 |
| `parse_special_command()` | 拆分命令词 + verbosity + 参数 | 检测 `+`/`-` 后缀 → CommandVerbosity |
| `register_special_command()` | 注册命令到 COMMANDS 字典 | backslash + forwardslash 双注册 + alias |
| `execute_favorite_query()` | 执行收藏查询 | UUID marker 防止 `$1` 与 Jinja2 冲突 |
| `status()` | 聚合服务器状态信息 | 多源查询（SHOW STATUS + VARIABLES + SELECT） |

</details>

---

## @special_command 装饰器注册

mycli 没有在一个大函数里写 `if command == '\dt': ...`，而是用 `@special_command` 装饰器让每个命令的实现紧邻其注册元数据：

```python title="mycli/packages/special/main.py"
@dataclass(frozen=True)
class SpecialCommand:
    handler: Callable
    command: str
    usage: str
    description: str
    arg_type: ArgType
    hidden: bool | None
    aliases: list[SpecialCommandAlias] | None
    backslash_only: bool

def special_command(command, usage, description, arg_type=ArgType.PARSED_QUERY, ...):
    def wrapper(wrapped):
        register_special_command(wrapped, command, usage, ...)
        return wrapped
    return wrapper
```

`register_special_command` 同时注册三种形式：`\command`（backslash）、`/command`（forwardslash，hidden=True）、所有 alias 的双形式。这让用户无论输入 `\dt` 还是 `/dt` 都能工作，而 `\help` 只显示一次。

新增命令只需在任意文件加一个装饰器，自动进入 `\help` 列表，命令的 usage/description/aliases/arg_type 等元数据与 handler 在同一处。

## execute() 调度器

```python title="mycli/packages/special/main.py — execute()"
def execute(cur, sql):
    command, arg, verbosity = parse_special_command(sql)
    special_cmd = COMMANDS[command]  # O(1) 查找
    # 特殊分支：help <keyword>
    if command == 'help': ...
    # 按 arg_type 策略分发
    if special_cmd.arg_type == ArgType.NO_ARGUMENT:
        return special_cmd.handler()
    elif special_cmd.arg_type == ArgType.PARSED_QUERY:
        return special_cmd.handler(cur=cur, arg=arg, ...)
    elif special_cmd.arg_type == ArgType.RAW_QUERY:
        return special_cmd.handler(cur=cur, query=sql)
```

`ArgType` 枚举定义了三种调用策略，handler 只接收自己需要的参数，避免了所有 handler 都带 `cur=None, arg=None, query=None` 的臃肿签名。

## 命令分类

| 类别 | 文件 | 命令示例 |
|------|------|----------|
| 数据库元命令 | `dbcommands.py` | `\dt`（表列表）、`\l`（库列表）、`status`（服务器状态）、`\u`（切库） |
| IO 控制 | `iocommands.py` | `pager`、`tee`、`system`、`watch`、`\f`（favorite query） |
| 收藏查询 | `favoritequeries.py` | `\fs`（保存）、`\fd`（删除）、`\f`（执行） |
| DSN 别名 | `dsn_aliases.py` | `\ds`（保存别名）、`\dl`（列表） |
| LLM 集成 | `llm.py` | `\llm`（自然语言转 SQL） |
| 分隔符 | `delimitercommand.py` | `delimiter`（修改 SQL 分隔符） |

## Stub 命令：元数据与实现分离

`\edit`、`\G`、`\g`、`\x`、`\clip`、`\llm` 在 special 模块中注册为 `stub()`（抛 `NotImplementedError`），真实逻辑在 REPL 层拦截：

```python title="mycli/packages/special/main.py"
@special_command('\\edit', '\\edit', 'Open an editor.', arg_type=ArgType.NO_ARGUMENT)
def stub(): raise NotImplementedError
```

这样 `\help` 能完整列出所有命令（包括需要接管终端/编辑器的命令），而 special 模块保持纯粹的"命令注册 + DB 可执行命令"职责，不引入对 `prompt_toolkit`/`click.edit` 的强依赖。

## Favorite Query：模板系统

`\f` 命令支持位置参数 `$1`/`$2` 和 Jinja2 模板变量 `{{ name }}`：

```sql
-- 保存
\fs find_user SELECT * FROM users WHERE name = '$1' AND age > {{ min_age }}

-- 执行
\f find_user alice min_age=18
```

两套模板系统共存的关键是 **UUID marker 防冲突**：`prepare_favorite_query_args` 将 `$1`/`$2` 替换为 `__mycli_favorite_arg_<uuid>_<n>__` marker，再交给 Jinja2 渲染，最后还原。这解决了位置参数语法 `$1` 与 Jinja2 模板变量同存的冲突。

## 模块级单例状态

`iocommands.py` 用模块级全局变量 + setter/getter 对管理可变状态：

```python title="mycli/packages/special/iocommands.py"
TIMING_ENABLED = False
use_expanded_output = False
PAGER_ENABLED = True
tee_file = None
delimiter_command = DelimiterCommand()
favoritequeries = FavoriteQueries(ConfigObj())
```

任何模块都能直接 `from mycli.packages.special.iocommands import is_pager_enabled` 读取状态，无需传递上下文对象。对单进程 CLI 工具来说是合理的简化。

## 关键设计决策

**装饰器注册 vs 集中分发表**：命令元数据与 handler 在同一处，不会漂移。不同类别的命令可以分散到 `dbcommands.py`、`iocommands.py` 等文件，按职责拆分。

**backslash + forwardslash 双注册**：自动注册 `\x` 和 `/x` 两种形式，`/x` 标记为 hidden 不在 `\help` 显示。代价是 `COMMANDS` 字典有大量 hidden 条目，但查找是 O(1)。

**ArgType 三策略**：不同命令对 cursor 和参数的需求差异很大。用 `ArgType` 枚举让 `execute()` 按策略选择调用签名，handler 只接收自己需要的参数。

**UUID marker 防冲突**：两套模板系统（`$1` 位置参数 + Jinja2 `{{ }}`）共存的工程妥协，通过 UUID marker 隔离两套语法的解析。
