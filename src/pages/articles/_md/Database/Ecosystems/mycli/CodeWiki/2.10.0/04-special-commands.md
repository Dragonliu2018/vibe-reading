---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "特殊命令"
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

这一节回答的问题是：**特殊命令模块的内部代码是怎么组织的，为什么这样拆分？**

`main.py` 承担调度核心角色，但它并不集中维护命令分发表——没有一份 "if command == 'dt' then ..." 的巨型 dispatch 代码。取而代之的是 `@special_command` 装饰器：每个 handler 函数在定义处就声明自己的命令名、usage、aliases、arg_type 等元数据，装饰器内部调用 `register_special_command()` 将 `(command → SpecialCommand)` 写入 `COMMANDS` 字典。这种"就近注册"的关键好处是**元数据与 handler 不漂移**——修改命令的参数策略或别名时，编辑器光标就在 handler 上方一行，不用跨文件跳转去同步另一份表。

命令实现按职责拆分到 6 个文件：`dbcommands.py` 放数据库元查询（`\dt`/`\l`/`status`），`iocommands.py` 放终端 IO 控制（`pager`/`tee`/`watch`），`favoritequeries.py` 放收藏查询的存取与渲染，`dsn_aliases.py`、`llm.py`、`delimitercommand.py` 各管一域。这样拆分的动机不是文件大小，而是**依赖隔离**——`dbcommands` 需要游标查询系统表，`iocommands` 需要 `os.system`/`subprocess`，`llm.py` 需要 LLM client。按职责分文件后，`main.py` 只依赖装饰器机制本身，不 import 任何实现模块，新增或删除一个命令域不会触碰调度核心。

注册是**单向的**：各实现模块 import `main.py` 的 `special_command` 装饰器并完成注册，但 `main.py` 不反向 import 任何实现模块。这意味着调度核心可以独立演进，而 `COMMANDS` 字典在运行时被各模块的 import 副作用填充就绪——谁被加载，谁的命令就可用，天然支持按需引入或替换实现。

## 调用链路

![特殊命令调用链路](/vibe-reading/images/articles/mycli-internals/special-commands-call-chain.svg)

这一节回答的问题是：**用户输入一条 `\` 命令或执行一条 Favorite Query 时，代码走的是哪条路径，每条路径上有哪些设计取舍？**

模块对外暴露两条核心路径，它们共享 `parse_special_command()` 做词法拆分，但之后的处理逻辑完全不同。

**命令调度路径**（`execute(cur, sql)`）是模块的主入口，解决"如何把一条字符串命令路由到正确的 handler 并以正确的方式调用它"这个问题。关键设计有三处：第一，`ArgType` 枚举定义 `NO_ARGUMENT`/`PARSED_QUERY`/`RAW_QUERY` 三种调用策略——`status()` 不需要参数就 `handler()`，`\dt` 需要解析后的过滤条件就 `handler(cur=cur, arg=arg)`，而 `watch` 需要原始未拆分的整行就 `handler(cur=cur, query=sql)`。这让每个 handler 只声明并接收自己真正需要的参数，而不是所有 handler 都背一个 `cur=None, arg=None, query=None` 的臃肿签名。第二，`COMMANDS[command]` 是 O(1) 字典查找，不需要线性扫描命令列表或 if-elif 链——注册时装饰器已经把 key 写入字典，调度时直接取出 `SpecialCommand` 对象。第三，`register_special_command()` 对每个命令同时注册 backslash（`\dt`）和 forwardslash（`/dt`，hidden=True）两种形式，外加所有 alias 的双形式。这让用户输入 `\dt` 或 `/dt` 都能命中同一个 handler，而 `\help` 列表因为 hidden 标记只展示一次，不会出现重复条目。

**Favorite Query 路径**（`execute_favorite_query()`）解决的是"如何把用户保存的参数化模板安全地渲染成可执行 SQL"这个问题。它的难点在于两套模板语法共存：位置参数 `$1`/`$2` 和 Jinja2 模板变量 `{{ name }}`，而 `$1` 这种写法会被 Jinja2 当作表达式尝试解析导致报错。模块的解法是**引入 UUID marker 做隔离层**——`prepare_favorite_query_args` 先把 `$1`/`$2` 替换成 `__mycli_favorite_arg_<uuid>_<n>__` 这种绝不与 Jinja2 语法冲突的临时标记，再交给 Jinja2 渲染模板变量，最后用 `restore_favorite_query_args()` 把 marker 还原为真实参数值。整条数据流经历 4 次字符串变换：原始模板 → UUID marker 替换 → Jinja2 渲染 → marker 恢复 → 最终 SQL。渲染出的 SQL 如果含分号会被拆成多条，逐条走 `execute()` 或直接提交游标——这意味着 Favorite Query 可以嵌套调用其他特殊命令，复用已有的调度路径。

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

这一节回答的问题是：**特殊命令模块在整个 mycli 进程中被谁依赖，各自拿它做什么，模块之间怎么共享可变状态？**

`main.py` 作为一个"注册表 + 调度器"，被上层多个模块消费，但每个消费者只取自己需要的那一面。`sqlexecute.py` 是最重要的消费者：它的 `run()` 方法在解析出 SQL 是 `\` 命令时委托 `special.execute()` 执行，更关键的是当遇到 `CommandNotFound`（用户输入了未注册的命令词）时，降级到 special 模块的命令列表做"你是否想输入 …"提示——这要求 special 模块作为唯一的命令真相源，不能让 sqlexecute 自己再维护一份命令清单，否则两份会漂移。`sqlcompleter.py` 和 `completion_engine.py` 读取 `COMMANDS` 字典来生成自动补全候选词——用户输入 `\d` 时补全器遍历所有以 `d` 开头的命令名，这依赖 special 模块导出的就是一份可直接迭代的注册表，而不是一个需要查询的 service。`repl.py` 的依赖更特殊：它不是来调度普通命令的，而是处理 `\llm` 这类 **stub 命令**——这些命令在 special 模块中只注册了元数据（handler 抛 `NotImplementedError`），真实逻辑在 REPL 层拦截，因为它们需要接管终端或调用编辑器，超出了 special 模块"注册 + DB 可执行命令"的职责边界。

注册方向依然是单向的：`dbcommands.py`、`iocommands.py` 等实现模块通过 `@special_command` 装饰器把自身写入 `main.py` 的 `COMMANDS`，但 `main.py` 不 import 它们。这种依赖方向保证了一个有趣的特性——**调度核心不认识任何具体命令**，它只认识字典和 `SpecialCommand` 数据类，谁被加载谁就注册，未加载的命令域对应的位置在字典里根本不存在，`execute()` 会自然报 `CommandNotFound`。

`iocommands.py` 的状态管理模式值得单独说：它用**模块级全局变量 + setter/getter** 管理跨调用的可变状态，如 `TIMING_ENABLED`（是否输出执行耗时）、`PAGER_ENABLED`（是否启用分页器）、`tee_file`（输出同时写文件的目标）。这些状态在模块 import 时初始化，setter 函数（如 `enable_pager()`/`disable_pager()`）直接改写全局变量，任何模块读取时拿到的都是当前值。相比"通过 context 对象层层传递状态"的方案，模块级全局的好处是调用方零成本——`pager` 命令改了 `PAGER_ENABLED` 后，下一次查询执行时 sqlexecute 自然就读到了新值，不需要把状态对象穿透多层调用栈。代价是隐式依赖和并发风险，但在单线程 REPL 场景下这个取舍是合理的。

## 扩展方式

- **新增特殊命令**：在 `dbcommands.py` 或 `iocommands.py` 中加 `@special_command('\\xxx', ...)` 装饰的 handler 函数 → 自动注册到 `COMMANDS` 字典
- **新增命令别名**：在 `@special_command` 的 `aliases` 参数中加 `SpecialCommandAlias`
- **修改 Favorite Query 模板语法**：`iocommands.py` 的 `prepare_favorite_query_args` / `render_favorite_query` / `restore_favorite_query_args`
