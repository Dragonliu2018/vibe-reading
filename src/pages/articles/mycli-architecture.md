---
layout: ../../layouts/ArticleLayout.astro
title: "mycli 架构解析"
date: "2026-06-24"
tags: ["Python", "MySQL", "CLI", "代码解读"]
description: "mycli v1.73.0 源码架构全面拆解，涵盖补全引擎、连接层、配置管理、REPL、批量执行等核心模块"
---

> **版本** v1.73.0 · **协议** BSD-3-Clause · **Python** ≥ 3.10 · **代码量** ~18,000 行 · **维护** dbcli 社区

mycli 是一个基于 Python 的 MySQL / MariaDB 命令行客户端，核心特性包括智能自动补全、语法高亮、多行编辑、SSH 隧道、结果分页及 LLM 集成。本文对其 v1.73.0 源码架构作全面拆解。

## 项目简介

mycli 属于 **dbcli** 家族（同系列有 pgcli、litecli 等）——一组基于 `prompt_toolkit` 构建的增强型数据库 CLI 工具。相比原生 mysql 命令行，mycli 提供了完整的上下文感知补全、语法高亮、多线程 schema 预取等现代终端体验。

 - **智能 SQL 补全** (`sqlcompleter.py`): 感知上下文的关键字/表/列补全，支持模糊匹配（Rapidfuzz）和 CamelCase 模式，11 级补全优先级
- **多协议连接** (`sqlexecute.py`): 原生 TCP/Socket 连接，可选 SSL/TLS 加密和 SSH 隧道，支持 .mylogin.cnf AES 加密凭证
- **多运行模式** (`main_modes/`): 交互式 REPL / 批量文件执行 / 单次 -e 查询 / 健康检查，统一入口按需分发
- **可扩展特殊命令** (`packages/special/`): 装饰器注册的命令体系，支持 \u \r \# \. 等 MySQL CLI 兼容命令及编程式自定义扩展
- **后台异步刷新** (`completion_refresher.py`): 补全元数据在独立线程中重建，Schema 预取并行进行，主 REPL 循环零阻塞
- **LLM 集成** (`packages/special/`): 通过 llm 库可选接入大语言模型，Ctrl-\ 快捷键触发，支持字段/区段截断配置

---

## 目录结构

### 顶层结构

```
mycli/ # 主包
test/ # 测试套件
doc/ # 文档
.github/ # CI/CD & 模板
pyproject.toml # 元数据 & 依赖
changelog.md
LICENSE.txt # BSD-3-Clause
```

 

### 测试结构

```
test/
 pytests/ # PyTest 单元测试
 test_sqlresult.py
 test_sqlexecute.py
 test_ssh_utils.py
 conftest.py
 features/ # Behave BDD 验收测试
 *.feature
 utils.py
 myclirc # 测试配置
```

 

### 主包文件详解

```
mycli/
 __init__.py # 版本元数据
 main.py # CLI 入口 + MyCli 核心类 (~1400 行)
 sqlexecute.py # 数据库连接 & 查询执行引擎
 sqlcompleter.py # 智能补全引擎 (~900 行)
 config.py # 配置文件解析 + .mylogin.cnf AES 解密
 output.py # 输出格式化 Mixin
 app_state.py # 应用状态 Mixin (my.cnf 读取/SSL 合并)
 clibuffer.py # 多行输入缓冲检测
 clitoolbar.py # 底部状态栏渲染
 clistyle.py # 主题 & 样式工厂
 key_bindings.py # 键盘快捷键
 lexer.py # SQL 语法高亮 (Pygments 扩展)
 types.py # Query namedtuple 等类型定义
 constants.py # URL、默认端口等常量
 completion_refresher.py # 后台补全刷新线程
 schema_prefetcher.py # 多 Schema 元数据预取线程
 cli_args.py # CLI 参数解析 (Dataclass + Click)
 compat.py # 兼容工具
 myclirc # 内置默认配置模板
 packages/ # 工具 & 扩展子包
 sqlresult.py # 查询结果数据类
 completion_engine.py # SQL 语义解析 & 补全上下文
 sql_utils.py # SQL 分析工具函数
 filepaths.py # 路径补全
 ssh_utils.py # SSH 配置读取
 hybrid_redirection.py # > / >> 重定向检测
 special/ # 特殊命令子系统
 main.py # 命令注册中心
 iocommands.py # I/O 控制命令
 dbcommands.py # 数据库元命令
 favoritequeries.py # 收藏查询管理
 ptoolkit/ # Prompt Toolkit 工具
 fzf.py # Fzf 历史搜索
 history.py # 带时间戳的历史记录
 utils.py # UI 安全刷新
 main_modes/ # 各运行模式实现
 repl.py # 交互式 REPL
 batch.py # 批量文件执行
 execute.py # 单次 -e 执行
 checkup.py # --checkup 健康诊断
 list_dsn.py # --list-dsn
 list_ssh_config.py # --list-ssh-config
```

---

## 分层架构

mycli 的架构可划分为 5 个清晰的层次，自顶向下分别负责 UI 交互、应用编排、业务逻辑、数据访问和基础支撑。

 5. **UI 交互层** — `prompt_toolkit` PromptSession · 语法高亮 (Pygments) · 状态栏 · 快捷键绑定 · Fzf 历史搜索
4. **应用编排层** — `MyCli` 核心类 · REPL 主循环 · 配置加载合并 · 运行模式分发 · 审计日志
3. **业务逻辑层** — 特殊命令框架 · 智能补全引擎 · 后台刷新线程 · Schema 预取 · 结果格式化
2. **数据访问层** — `SQLExecute` · PyMySQL 连接 · SQL 分割执行 · Schema 内省查询 · 类型转换
1. **传输/安全层** — SSL/TLS · SSH 隧道 (sshtunnel/paramiko) · .mylogin.cnf AES 解密 · Keyring 密码存储

> **核心设计原则** 各层职责边界清晰，跨层通信通过定义良好的接口进行。UI 层只感知 `prompt_toolkit` 抽象，数据访问层只感知 PyMySQL，两者均不直接耦合。

---

## 入口与启动流程

### CLI 入口链

`pyproject.toml` 中声明 `mycli = "mycli.main:main"`，安装后 `mycli` 命令直接映射到 `main()` 函数。

```python
Python

 # pyproject.toml
[project.scripts]
mycli = "mycli.main:main"

# main.py 入口链
def main():
 click_entrypoint.main() # Click 解析参数

@click.command()
@clickdc.adddc('cli_args', CliArgs) # Dataclass 驱动参数
def click_entrypoint(cli_args: CliArgs):
 mycli = MyCli(cli_args) # 创建核心对象
 mycli.connect(...) # 建立 DB 连接
 # 根据 cli_args 分发到对应模式
```

### 启动时序

 main() → click 解析 CliArgs 数据类 
 → MyCli.__init__() 
 → read_config_files() — 多层配置合并 
 → SQLCompleter 初始化 
 → CompletionRefresher 初始化 
 → SchemaPrefetcher 初始化 
 → mycli.connect() 
 → SSH 隧道建立（可选） 
 → PyMySQL 连接 
 → SQLExecute 实例化 
 → 模式分发 
 ├─ main_repl() — 交互模式 
 ├─ main_batch_*() — 批量模式 
 ├─ main_execute_from_cli() — 单次 -e 
 └─ main_checkup() — 健康诊断 

### CliArgs 数据类（部分关键字段）

CLI 参数通过 `clickdc` 库将 Python `dataclass` 直接映射为 Click 选项，彻底消除手写 `@click.option` 的重复代码，并获得静态类型检查。

```python
# cli_args.py
Python · cli_args.py

 @dataclass(slots=True)
class CliArgs:
 database: str | None # 位置参数：DB名 或 DSN 字符串
 user: str | None # -u
 host: str | None # -h
 port: int | None # -P
 password: str | None # -p（可选值标志）
 execute: str | None # -e 单次查询
 batch: str | None # -B 批量文件
 ssl_mode: str | None # --ssl-mode {off|auto|on}
 ssh_host: str | None # SSH 隧道主机
 checkup: bool # --checkup 诊断模式
 list_dsn: bool # --list-dsn
 # ... 30+ 更多选项
```

### 配置优先级（由低到高）

 
| # | 来源 | 路径 |
| --- | --- | --- |
| 1 | 包内置默认值 | mycli/myclirc（随包发布） |
| 2 | 系统级配置 | /etc/myclirc |
| 3 | XDG 用户配置 | ~/.config/mycli/myclirc |
| 4 | 当前目录配置 | .myclirc |
| 5 | 用户主目录 | ~/.myclirc |
| 6 | MySQL 配置 | my.cnf（多路径搜索） |
| 7 | 加密登录凭证 | ~/.mylogin.cnf（AES ECB 加密） |
| 8 | 系统密钥环 | keyring（Python keyring） |
| 9 ★ | CLI 参数 | 命令行 -u / -h / -p 等 |

---

## 数据库执行层 — SQLExecute

`sqlexecute.py` 是 mycli 与 MySQL 服务器通信的唯一门面，封装了 PyMySQL 连接生命周期、多语句执行、Schema 内省查询及服务器类型检测。

 

### 核心属性

```python
Python
 class SQLExecute:
 conn: pymysql.Connection
 dbname: str
 user: str
 host: str
 port: int
 socket: str | None
 server_info: ServerInfo
 ssl: dict
 sandbox_mode: bool # 密码过期模式
```

### 服务器类型检测

```python
Python
 class ServerSpecies(Enum):
 MySQL = "MySQL"
 MariaDB = "MariaDB"
 Percona = "Percona"
 TiDB = "TiDB"
 Unknown = "Unknown"

# 通过 @@version_comment 检测
# 不同 species 启用不同补全关键字
```

### 查询执行管线

 run(statement) 
 → split_queries() — 按分隔符拆分多语句 
 → for each query: 
 → special.execute(cur, sql) — 特殊命令优先检查 
 │ (若非特殊命令，抛 NotASpecialCommand) 
 → cur.execute(sql) — PyMySQL 执行 
 → get_result(cursor) → SQLResult 
 → yield SQLResult (生成器，延迟消费) 

### Schema 内省接口

SQLExecute 提供完整的 Schema 内省接口，供 SQLCompleter 的后台刷新线程使用：

 
| 方法 | 查询目标 | 用途 |
| --- | --- | --- |
| tables() | information_schema.TABLES | 表名补全 |
| table_columns(schema) | information_schema.COLUMNS | 列名补全 |
| databases() | SHOW DATABASES | 库名补全 |
| functions() | information_schema.ROUTINES | 函数名补全 |
| procedures() | information_schema.ROUTINES | 存储过程补全 |
| enum_values() | information_schema.COLUMNS | 枚举值补全 |
| foreign_keys() | information_schema.KEY_COLUMN_USAGE | 外键关系 |
| users() | mysql.user | 用户名补全 |

### 连接标志

```python
Python
 CLIENT_FLAGS = (
 CLIENT.INTERACTIVE, # 交互式客户端标记
 CLIENT.MULTI_STATEMENTS, # 允许多语句一次发送
 CLIENT.HANDLE_EXPIRED_PASSWORDS, # 密码过期后进入 sandbox_mode
)
```

---

## 智能补全引擎 — SQLCompleter

`sqlcompleter.py` 继承 `prompt_toolkit.Completer`，实现了多层次、上下文感知的 SQL 补全系统。

 

### 补全层次优先级

 
- 特殊命令（\ 开头）

- 数据库名

- 表 / 视图

- 列名

- 函数 / 存储过程

- 枚举值（ENUM）

- MySQL 用户

- 字符集 / 排序规则

- 文件路径（source/load）

- 收藏查询

- SQL 关键字

 

 
### 模糊匹配算法（Fuzziness）

 PERFECT 
 完全前缀匹配，最高优先级 

 
 REGEX 
 正则表达式模式匹配 

 
 UNDER_WORDS 
 下划线分词边界匹配 

 
 CAMEL_CASE 
 驼峰命名大写字母匹配 

 
 RAPIDFUZZ 
 基于 rapidfuzz 的模糊字符串匹配 

 

### 补全流程

 get_completions(doc, complete_event) 
 → completion_engine.suggest_type(text_before_cursor) 
 → tokenize SQL (sqlparse) 
 → 分析最后一个有效 token 的语义位置 
 → 返回 suggestion 类型列表 
 → for each suggestion: 
 → 从 dbmetadata 缓存查候选集合 
 → fuzzify() — 按 Fuzziness 级别过滤排序 
 → yield Completion 对象 

### 补全上下文示例

 
| 输入片段 | 识别上下文 | 补全内容 |
| --- | --- | --- |
| SELECT | column / function | 列名 + 函数名 + 关键字 |
| FROM | table | 表名 + 视图名 |
| FROM mydb. | schema.table | mydb 下的表 |
| WHERE col = ' | enum value | 该列的 ENUM 枚举值 |
| \ | special command | \u \r \# \. 等 |
| source | file path | 本地文件路径 |
| GRANT … TO ' | user | MySQL 用户名 |

### dbmetadata 缓存结构

```python
Python
 dbmetadata = {
 'tables': {schema: [table_names]},
 'views': {schema: [view_names]},
 'columns': {'schema.table': [col_names]},
 'functions': {schema: [func_names]},
 'datatypes': {schema: [type_names]},
 'show_commands': [...],
}
```

---

## 配置管理 — config.py

配置系统基于 `configobj` 库，支持多文件分层合并，对 MySQL 原生的 `.mylogin.cnf` 实现了完整的 AES 解密读取。

 

### myclirc 配置区块

```ini
# myclirc
INI · myclirc
 [main] # UI、格式化、行为控制
[connection] # 默认连接参数
[colors] # 配色方案
[keys] # 按键超时
[search] # 搜索高亮
[alias_dsn] # DSN 别名映射
[init-commands] # 连接后自动执行的 SQL
[llm] # LLM 集成配置
[favorite_queries]
```

### .mylogin.cnf 解密原理

```text
# AES ECB 解密流程
1. 读取文件开头 4 字节（magic）
2. 读取 20 字节 login_key
3. XOR 生成 16 字节 AES 密钥: aes_key[i] ^= login_key[i % 20]
4. AES-128-ECB 解密剩余内容
5. 解析为 INI 格式（[section]）
```

### DSN 别名支持

在 `[alias_dsn]` 中预定义连接串，启动时直接用别名代替完整参数：

```ini
[alias_dsn]
prod = mysql://user:pass@prod-db.example.com:3306/mydb
dev = mysql://root@localhost/devdb

# 使用方式：
$ mycli prod # 等价于使用 prod DSN 连接
```

### 密码凭证获取链

 
 CLI -p 参数 → 
 .mylogin.cnf → 
 系统 Keyring → 
 交互式 prompt 输入 

 

成功连接后，密码会自动存入系统 Keyring，下次无需重复输入。

---

## 特殊命令框架 — packages/special/

特殊命令是 mycli 的可扩展元命令系统，实现 MySQL CLI 兼容的 `\命令` 语法，以及内置数据库管理命令。

### 注册机制

```python
# special/main.py
Python · special/main.py
 # 方式一：装饰器注册
@special_command(
 command="use",
 aliases=[SpecialCommandAlias("\\u", case_sensitive=False)],
 arg_type=ArgType.PARSED_QUERY,
)
def use_database(cur, pattern, verbose):
 ...

# 方式二：编程式注册（在 main.py 中注册实例方法）
register_special_command(
 handler=self.change_table_format,
 command="tableformat",
 aliases=[...],
)
```

### 命令解析管线

 execute(cur, sql) 
 → parse_special_command(sql) 
 → 提取命令词 + 详细程度 + 参数字符串 
 → 查 COMMANDS 注册表（大小写不敏感匹配） 
 → 找到 handler(cur, pattern, verbose) 
 → 未找到 raise NotASpecialCommand → PyMySQL 执行 

### 内置特殊命令一览

 
| 命令 | 别名 | 功能 |
| --- | --- | --- |
| use / connect | \u | 切换数据库 |
| rehash | \# | 重新加载补全元数据 |
| tableformat | \T | 切换输出表格格式 |
| redirectformat | \Tr | 切换重定向格式 |
| prompt | \R | 自定义命令提示符 |
| source | \. | 执行 SQL 文件 |
| tee / notee | — | 输出同时写入文件 / 停止 |
| pager / nopager | — | 设置分页器 / 禁用 |
| \e / \edit | — | 打开外部编辑器编辑 SQL |
| status | \s | 显示服务器 & 连接状态 |
| exit / quit | \q | 退出 |
| \clip | — | 复制查询到剪贴板 |
| \bug | — | 打开 GitHub Issues 页面 |
| delimiter | — | 更改语句分隔符 |

### I/O 控制全局状态（iocommands.py）

```python
# iocommands.py
Python · iocommands.py
 _expanded_output: bool # \G 竖排输出开关
_is_pager_enabled: bool # 分页器开关
_timing_enabled: bool # 查询计时开关
_show_warnings_enabled: bool # 警告显示开关
_is_redirected: bool # 输出重定向状态
_current_delimiter: str # 当前分隔符（默认 ";"）
```

---

## 输出格式化 — OutputMixin

`output.py` 中的 `OutputMixin` 被 `MyCli` 混入，提供统一的结果渲染、分页、日志审计入口。

### 支持的输出格式（由 cli_helpers 提供）

 table（默认） 
 vertical (\G) 
 csv 
 tsv 
 json 
 latex 
 mediawiki 
 rst 
 html 
 jira 
 pretty（Unicode box） 
 ascii 
 double（double-line box） 
 markdown 

### 渲染管线

 SQLResult → TabularOutputFormatter.format_output() 
 → 选择格式化器（table/csv/json/…） 
 → 计算可用宽度（终端宽 − 保留空间） 
 → 生成 FormattedText 行 
 → echo() → 分页器 / 标准输出 / 审计日志 

### SQLResult 数据结构

```python
# packages/sqlresult.py
Python · packages/sqlresult.py
 @dataclass
class SQLResult:
 preamble: str | None # 结果前置消息
 header: list[str] | None # 列头
 rows: Cursor | list # 结果行（延迟消费游标）
 postamble: str | None # 结果后置消息
 status: str | FormattedText # 状态行（受影响行数等）
 command: dict # 元数据（耗时等）

 @cached_property
 def status_plain(self) -> str: ... # 纯文本状态
```

---

## REPL 交互模式 — main_modes/repl.py

交互模式是 mycli 的核心使用场景，基于 `prompt_toolkit` 的 `PromptSession` 构建，实现了丰富的终端交互体验。

### REPL 主循环

 main_repl(mycli) 
 → 构建 PromptSession 
 → DynamicCompleter(mycli.completer) — 线程安全动态绑定 
 → MyCliLexer — Pygments 语法高亮 
 → mycli_bindings() — 自定义快捷键 
 → create_toolbar_tokens_func() — 底部状态栏 
 → 循环: 
 → session.prompt() — 等待用户输入 
 → clibuffer 多行检测 — 不完整则继续读取 
 → 破坏性命令检测 + 确认提示 
 → mycli.run_query(query) 
 → 输出结果 + 更新历史 
 → need_completion_refresh? → 触发后台刷新 

### 多行输入检测规则

`clibuffer.py` 通过一套规则判断用户是否已完成输入：

 
| 规则 | 说明 |
| --- | --- |
| 以分隔符结尾 | 默认 `;`，可通过 delimiter 命令修改 |
| 以 \g / \G 结尾 | 普通 / 竖排输出结束符 |
| 以 \e / \edit 结尾 | 调用外部编辑器 |
| 以 \clip 结尾 | 复制到剪贴板 |
| 特殊元命令 | exit / help 等无需分隔符 |
| 空行回车 | 立即提交当前内容 |

### 底部状态栏内容

 user@host:port 
 当前数据库 
 服务器版本 
 事务状态 
 SSL 标识 
 SSH 标识 
 沙盒模式警告

---

## 批量执行模式 — main_modes/batch.py

批量模式支持从文件或 stdin 读取 SQL 语句依次执行，适用于脚本化部署和数据迁移场景。

 

### 三种批量变体

```python
Python
 main_batch_with_progress_bar()
 # -B 文件 + 检测到 tty
 # 显示进度条（当前行/总行数）

main_batch_without_progress_bar()
 # -B 文件 + 输出被重定向
 # 静默执行，适合脚本 pipe

main_batch_from_stdin()
 # echo "SELECT 1" | mycli
 # 从 stdin 读取，无进度条
```

### 断点续传

```python
Python
 replay_checkpoint_file(mycli, file)
# 记录已执行到的字节偏移量
# 中断重启后从该位置继续
# 避免重复执行已成功的语句

 

> **checkpoint 机制** 以字节偏移量为恢复点，适合长时间运行的迁移脚本，网络中断后无需从头重跑。
```

---

## 后台补全刷新 — CompletionRefresher & SchemaPrefetcher

mycli 设计了两级后台刷新机制，确保补全数据的实时性同时不影响 REPL 响应速度。

 

### CompletionRefresher

每次执行了 DDL/USE/REHASH 后触发，在独立线程中重建整个补全器。

```python
Python
 @refresher()
def refresh_tables(executor, completer):
 completer.extend_relations(
 executor.tables(), kind='tables'
 )

# 全部 @refresher 函数：
# databases / tables / columns
# foreign_keys / functions
# procedures / users
# character_sets / collations
# special_commands / show_commands
```

### SchemaPrefetcher

连接成功后异步预取配置列表中所有 Schema 的元数据，支持跨库补全。

```ini
# myclirc
INI · myclirc
 # 预取模式
prefetch_schemas = always # 始终预取
prefetch_schemas = never # 不预取
prefetch_schemas = listed # 仅预取列表

prefetch_schemas_list = db1, db2

# 通过 _completer_lock 原子更新
# 避免主线程读时的数据竞争
```

### 刷新时序

 USE new_db / CREATE TABLE / rehash 
 → need_completion_refresh(sql) → True 
 → completion_refresher.refresh(executor, callback) 
 → 后台线程: 新建 SQLCompleter 实例 
 → 依序运行所有 @refresher 函数 
 → callback(_on_completions_refreshed) 
 → acquire _completer_lock 
 → 原子替换 mycli.completer 
 → 启动 SchemaPrefetcher

---

## SSH 隧道 & SSL/TLS

### SSL 三种模式

 
| 模式 | 行为 |
| --- | --- |
| `ssl_mode = off` | 禁用 SSL，明文传输 |
| `ssl_mode = auto`（默认） | 尝试 SSL，失败则自动降级为明文 |
| `ssl_mode = on` | 强制 SSL，失败则拒绝连接 |

### SSL 证书选项

 --ssl-ca 
 --ssl-cert 
 --ssl-key 
 --ssl-cipher 
 --ssl-verify-server-cert 
 --tls-version 

### SSH 隧道建立流程

 --ssh-host / ssh config 文件 
 → ssh_utils.read_ssh_config() — 解析 ~/.ssh/config 
 → SSHTunnelForwarder(ssh_host, ssh_port, …) 
 → paramiko SSH 握手（密钥/密码认证） 
 → 本地端口映射: 127.0.0.1:LOCAL_PORT → DB_HOST:DB_PORT 
 → PyMySQL 连接至 127.0.0.1:LOCAL_PORT 

> **可选依赖** SSH 功能依赖 `paramiko` 和 `sshtunnel`，需通过 `pip install mycli[ssh]` 安装。

---

## 按键绑定与样式

### 默认快捷键

 
| 快捷键 | 功能 |
| --- | --- |
| Ctrl-D | 退出（空缓冲区时） |
| Ctrl-T | 转置字符 |
| F1 | 显示帮助 |
| F2 | Fzf 历史搜索 |
| Ctrl-\ | LLM 辅助（可选） |
| Page Up/Down | 在历史记录中翻页 |
| Ctrl-R | 增量历史搜索 |

### 样式系统（clistyle.py）

主题通过两个工厂函数创建，分别供 prompt_toolkit 和 Pygments 使用：

```python
# clistyle.py
Python · clistyle.py
 # 可自定义的样式元素（在 myclirc [colors] 配置）
Token.Menu.Completions.Completion.Current # 当前选中补全项
Token.Menu.Completions.Completion # 普通补全项
Token.Output.Header # 输出表头
Token.Output.OddRow / Token.Output.EvenRow # 交替行颜色
Token.Output.Null # NULL 值颜色
Token.Toolbar # 状态栏背景
Token.Keyword / Token.String / ... # SQL 语法高亮 token
```

---

## 核心设计模式

- **Mixin 组合** (`app_state.py`): MyCli 通过多重继承组合 AppStateMixin（my.cnf 读取、SSL 合并）和 OutputMixin（日志、格式化），避免单一巨型类。
- **装饰器注册表** (`special/main.py`): @special_command() 和 @refresher() 两套装饰器在模块加载时将函数注册到全局字典，实现开放/关闭原则扩展。
- **线程安全互斥锁** (`main.py`): _completer_lock（threading.Lock）保护 completer 实例的替换操作，确保后台刷新线程和主 REPL 线程不产生数据竞争。
- **Dataclass + Click** (`cli_args.py`): 通过 clickdc 库将 CliArgs dataclass 自动映射为 Click 命令选项，减少样板代码并获得完整类型检查。
- **生成器管线** (`sqlexecute.py`): SQLExecute.run() 返回 SQLResult 生成器，下游 formatter 按需消费，支持流式输出大结果集，不需全量加载到内存。
- **工厂函数** (`clistyle.py`): style_factory_ptoolkit()、style_factory_helpers()、create_default_config() 等工厂函数封装复杂对象创建逻辑。
- **策略模式（格式化）** (`cli_helpers`): 输出格式化通过策略模式支持 14 种表格格式（table/csv/json/…），运行时通过 tableformat 命令切换，核心逻辑无需修改。
- **Prompt Toolkit Filter** (`clibuffer.py`): @Condition 装饰器创建 prompt_toolkit 过滤器对象（如 cli_is_multiline），以声明式方式控制 UI 行为，与命令式判断解耦。

---

## 依赖总览

### 核心依赖

 
| 依赖包 | 版本约束 | 用途 |
| --- | --- | --- |
| click | ~8.3 | CLI 框架，参数解析 |
| prompt_toolkit | ≥3.0.41, 

### 可选依赖

 
| 依赖包 | 安装方式 | 用途 |
| --- | --- | --- |
| paramiko | `pip install mycli[ssh]` | SSH 客户端库 |
| sshtunnel | `pip install mycli[ssh]` | SSH 隧道封装 |
| llm | `pip install mycli[llm]` | LLM 集成（Ctrl-\） |
| pydantic_core | `pip install mycli[llm]` | LLM 数据验证 |

---

## 全局数据流

下图展示一次完整用户查询从按键输入到结果渲染的全链路数据流动：

 
┌──────────────────────────────────────────────────────────┐
│ 用户终端 (TTY) │
│ 键入: SELECT * FROM orders WHERE status = 'pend[TAB] │
└──────────────────┬───────────────────────────────────────┘
 │ 按键事件
 ▼
┌──────────────────────────────────────────────────────────┐
│ prompt_toolkit PromptSession │
│ ┌─────────────┐ ┌──────────────┐ ┌─────────────────┐ │
│ │ MyCliLexer │ │SQLCompleter │ │ Key Bindings │ │
│ │ (语法高亮) │ │ (补全菜单) │ │ (Ctrl/F1/F2) │ │
│ └─────────────┘ └──────┬───────┘ └─────────────────┘ │
└─────────────────────────┼────────────────────────────────┘
 │ suggest_type()
 ▼
 ┌────────────────────────┐
 │ completion_engine │
 │ SQL 语义位置分析 │
 │ → enum_value 建议 │
 └────────────┬───────────┘
 │ 查询 dbmetadata 缓存
 ▼
 ┌────────────────────────┐
 │ SQLCompleter 缓存 │
 │ dbmetadata dict │◄── 后台刷新线程
 └────────────────────────┘

用户按回车后:
 │
 ▼
┌──────────────────────────────────────────────────────────┐
│ main_repl() │
│ 1. clibuffer: 多行完整性检测 │
│ 2. 破坏性命令确认 (DROP/TRUNCATE?) │
│ 3. mycli.run_query(query) │
└──────────────────┬───────────────────────────────────────┘
 │
 ▼
┌──────────────────────────────────────────────────────────┐
│ SQLExecute.run() │
│ 1. split_queries() → 按分隔符拆分 │
│ 2. special.execute() → 特殊命令？ │
│ 3. cur.execute() → PyMySQL │
│ 4. get_result() → SQLResult │
└──────────────────┬───────────────────────────────────────┘
 │ via SSL/TLS or SSH Tunnel
 ▼
 ┌──────────────────┐
 │ MySQL Server │
 └────────┬─────────┘
 │ 结果集
 ▼
┌──────────────────────────────────────────────────────────┐
│ OutputMixin │
│ TabularOutputFormatter → 选择格式 (table/csv/json/…) │
│ echo() → 分页器(less/more) / stdout / 审计日志文件 │
└──────────────────────────────────────────────────────────┘
 │
 ▼
 ┌──────────────────┐
 │ 用户终端 (TTY) │
 │ 渲染输出结果表格 │
 └──────────────────┘

并发后台线程:
┌──────────────────────────────────────────────────────────┐
│ CompletionRefresher Thread │
│ DDL/USE/rehash 后重建 SQLCompleter │
│ ┌─────────────────────────────────────────────────┐ │
│ │ @refresher 链: databases→tables→columns→… │ │
│ └─────────────────────────────────────────────────┘ │
│ │
│ SchemaPrefetcher Thread │
│ 异步预取多 Schema 元数据（跨库补全） │
│ 通过 _completer_lock 原子更新主线程补全器 │
└──────────────────────────────────────────────────────────┘ 

> **关键设计亮点** 补全元数据完全异步刷新，主 REPL 循环通过 `DynamicCompleter` 间接引用实际 completer，后台线程替换完成后主线程下一次按 Tab 即可获得新数据，零阻塞。

### 组件依赖关系

 
 ┌─────────────┐
 │ main.py │
 │ MyCli │
 └──────┬──────┘
 ┌───────────────┼──────────────────────┐
 │ │ │
 ▼ ▼ ▼
 ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐
 │ sqlexecute │ │ sqlcompleter │ │ config.py │
 │ SQLExecute │ │ SQLCompleter │ │ ConfigObj 合并 │
 └──────┬──────┘ └──────┬───────┘ └──────────────────┘
 │ │
 │ ┌─────▼────────────────┐
 │ │ packages/ │
 │ │ completion_engine │
 │ │ sql_utils │
 │ │ filepaths │
 │ └──────────────────────┘
 │
 ┌──────▼────────────────────────┐
 │ PyMySQL (conn) │
 │ + SSL/TLS │
 │ + sshtunnel (optional) │
 └────────────────────────────────┘

 ┌─────────────────────────────────────────────┐
 │ packages/special/ │
 │ iocommands + dbcommands + favoritequeries │
 │ ↑ │
 │ register_special_command() 注册表 │
 └─────────────────────────────────────────────┘

 ┌────────────────┐ ┌───────────────────────┐
 │ completion_ │ │ schema_prefetcher.py │
 │ refresher.py │ │ SchemaPrefetcher │
 │ (后台线程) │ │ (后台线程) │
 └───────┬────────┘ └──────────┬─────────────┘
 │ │
 └──────────┬───────────┘
 │ _completer_lock
 ▼
 mycli.completer 原子替换

---

