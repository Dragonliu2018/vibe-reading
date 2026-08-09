---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "特殊命令详解"
date: "2026-08-09T10:40:00+08:00"
category: [Database, Ecosystems, mycli, CodeWiki, "2.10.0"]
tags: ["mycli", "Python", "特殊命令", "装饰器注册", "Favorite Query"]
description: "mycli 特殊命令模块深度解读：@special_command 装饰器注册、execute() 调度、ArgType 策略、Favorite Query 模板渲染。"
readingTime: "7 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/mycli/CodeWiki/2.10.0/00-overview)

---

## 模块定位

特殊命令模块处理所有 `\` 前缀的客户端命令（如 `\dt`、`\l`、`status`、`\f`），将命令注册、调度和实现解耦。它让 SQLExecute 的 `run()` 通过 `execute()` 入口统一分发客户端命令和普通 SQL，使上层无需区分命令来源。

## 模块架构

![特殊命令模块架构](/vibe-reading/images/articles/mycli-internals/special-commands-architecture.svg)

`special/main.py` 是调度核心，持有 `COMMANDS` 字典、`execute()` 调度器、`@special_command` 装饰器和 `ArgType` 枚举。6 个命令实现模块（`dbcommands`、`iocommands`、`favoritequeries`、`dsn_aliases`、`llm`、`delimitercommand`）通过装饰器单向注册到 `COMMANDS`，不反向依赖 `main.py`。

## 调用链路

![特殊命令调用链路](/vibe-reading/images/articles/mycli-internals/special-commands-call-chain.svg)

路径 A（命令调度）：`execute(cur, sql)` → `parse_special_command()` 拆分命令词 → `COMMANDS[command]` O(1) 查找 → 按 `ArgType` 分发到 handler，返回 `list[SQLResult]`。路径 B（Favorite Query）：`execute_favorite_query()` → 解析参数 → 取模板 → UUID marker 替换 `$1` → Jinja2 渲染 → marker 还原 → 逐条执行 SQL 或递归 `execute()`。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|-------------|
| `execute(cur, sql)` in `main.py` | 命令调度入口 | ArgType 三策略选择调用签名 |
| `parse_special_command()` | 拆分命令词 + verbosity + 参数 | 检测 `+`/`-` 后缀 → CommandVerbosity |
| `register_special_command()` | 注册命令到 COMMANDS 字典 | backslash + forwardslash 双注册 + alias |
| `execute_favorite_query()` | 执行收藏查询 | UUID marker 防止 `$1` 与 Jinja2 冲突 |
| `status()` | 聚合服务器状态信息 | 多源查询（SHOW STATUS + VARIABLES + SELECT） |

</details>

---

## 核心实现

### @special_command 装饰器注册

mycli 用 `@special_command` 装饰器让每个命令的实现紧邻其注册元数据：

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

### execute() 调度器

```python title="mycli/packages/special/main.py — execute()"
def execute(cur, sql):
    command, arg, verbosity = parse_special_command(sql)
    special_cmd = COMMANDS[command]  # O(1) 查找
    if command == 'help': ...
    if special_cmd.arg_type == ArgType.NO_ARGUMENT:
        return special_cmd.handler()
    elif special_cmd.arg_type == ArgType.PARSED_QUERY:
        return special_cmd.handler(cur=cur, arg=arg, ...)
    elif special_cmd.arg_type == ArgType.RAW_QUERY:
        return special_cmd.handler(cur=cur, query=sql)
```

`ArgType` 枚举定义了三种调用策略，handler 只接收自己需要的参数，避免了所有 handler 都带 `cur=None, arg=None, query=None` 的臃肿签名。

### 命令分类

| 类别 | 文件 | 命令示例 |
|------|------|----------|
| 数据库元命令 | `dbcommands.py` | `\dt`（表列表）、`\l`（库列表）、`status`、`\u`（切库） |
| IO 控制 | `iocommands.py` | `pager`、`tee`、`system`、`watch`、`\f` |
| 收藏查询 | `favoritequeries.py` | `\fs`（保存）、`\fd`（删除）、`\f`（执行） |
| DSN 别名 | `dsn_aliases.py` | `\ds`（保存别名）、`\dl`（列表） |
| LLM 集成 | `llm.py` | `\llm`（自然语言转 SQL） |
| 分隔符 | `delimitercommand.py` | `delimiter`（修改 SQL 分隔符） |

### Stub 命令：元数据与实现分离

`\edit`、`\G`、`\g`、`\x`、`\clip`、`\llm` 在 special 模块中注册为 `stub()`（抛 `NotImplementedError`），真实逻辑在 REPL 层拦截。这样 `\help` 能完整列出所有命令（包括需要接管终端/编辑器的命令），而 special 模块保持纯粹的"命令注册 + DB 可执行命令"职责，不引入对 `prompt_toolkit`/`click.edit` 的强依赖。

### Favorite Query：模板系统

`\f` 命令支持位置参数 `$1`/`$2` 和 Jinja2 模板变量 `{{ name }}`：

```sql
-- 保存
\fs find_user SELECT * FROM users WHERE name = '$1' AND age > {{ min_age }}

-- 执行
\f find_user alice min_age=18
```

两套模板系统共存的关键是 **UUID marker 防冲突**：`prepare_favorite_query_args` 将 `$1`/`$2` 替换为 `__mycli_favorite_arg_<uuid>_<n>__` marker，再交给 Jinja2 渲染，最后还原。这解决了位置参数语法 `$1` 与 Jinja2 模板变量同存的冲突。

Favorite Query 的数据流经历 4 次字符串变换：原始模板 → UUID marker 替换 → Jinja2 渲染 → marker 恢复 → 最终 SQL。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 装饰器注册 | `main.py` @special_command | 命令元数据与 handler 在同一处，不漂移 |
| 策略模式 | `main.py` ArgType | 不同命令对参数需求不同，按策略选择签名 |
| Stub/分离 | `main.py` stub() | 元数据完整但实现延迟到 REPL 层 |
| 模板方法 | `iocommands.py` Favorite Query | prepare→render→restore 固定流程 |

## 模块间交互

![特殊命令模块交互](/vibe-reading/images/articles/mycli-internals/special-commands-interactions.svg)

`special/main.py` 被 `sqlexecute.py`（`execute`/`CommandNotFound`）、`sqlcompleter.py`（`COMMANDS`）、`completion_engine.py`（`COMMANDS`/`parse_special_command`）、`completion_refresher.py`（`COMMANDS`）、`repl.py`（`handle_llm` 等）引用。`dbcommands.py` 和 `iocommands.py` 通过 `@special_command` 装饰器注册到 `main.py` 的 `COMMANDS` 字典，不反向依赖。`iocommands.py` 用模块级全局变量 + setter/getter 管理可变状态（`TIMING_ENABLED`、`PAGER_ENABLED`、`tee_file` 等），任何模块能直接读取，无需传递上下文对象。

## 扩展方式

- **新增特殊命令**：在 `dbcommands.py` 或 `iocommands.py` 中加 `@special_command('\\xxx', ...)` 装饰的 handler 函数 → 自动注册到 `COMMANDS` 字典
- **新增命令别名**：在 `@special_command` 的 `aliases` 参数中加 `SpecialCommandAlias`
- **修改 Favorite Query 模板语法**：`iocommands.py` 的 `prepare_favorite_query_args` / `render_favorite_query` / `restore_favorite_query_args`
