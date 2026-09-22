---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "解析器与服务器层"
date: "2026-09-22T22:38:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "bison", "解析器", "THD", "LEX", "Sql_cmd", "多语句"]
description: "MariaDB 解析器与服务器层解读——THD/LEX/SELECT_LEX 核心结构、手写 DFA 词法器、LALR(2) token 收缩、双 yacc 方言构建、Sql_cmd 命令对象渐进迁移全解"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

解析器与服务器层把 SQL 文本变成可执行结构，并承载连接生命周期与权限检查。它由三块组成：**连接/会话层**（`mysqld.cc` 的连接循环、`sql_connect.cc` 的 THD 管理、`sql_acl.cc` 的 ACL）、**解析器**（21k 行 bison 文法 `sql_yacc.yy` + 14k 行手写词法器 `sql_lex.cc`）、**命令分发**（`sql_parse.cc` 的双层 switch）。god node 的分布说明这层的地位：**THD degree 641 全库第一**（每连接一个贯穿全生命周期的上下文）、LEX 549、st_select_lex 299。

## 模块架构

三个核心结构的职责划分：

- **THD**（`sql/sql_class.h:3331`）——每连接一个"宇宙"：`net`（连接）、`protocol`（当前协议）、`variables`（会话系统变量）、`mdl_context`（元数据锁）、`stmt_map`（prepared statements）、内嵌 `main_lex`。`lex` 指针不在 THD 直接声明而在基类 `Statement`（`sql_class.h:1867`）——常规查询永远复用内嵌 `main_lex`，PS/SP 每条独立 `new st_lex_local`（`sql_class.h:6012-6030` 注释是 LEX 生命周期的钥匙）
- **LEX**（`sql/sql_lex.h:3347`）——语句级解析容器，`union-of-fields` 巨型结构：`SELECT_LEX_UNIT unit`（最顶层 unit）+ `current_select` + 几十个命令专属字段（`alter_info`、`sphead`、`many_values`...）+ 新式 `Sql_cmd *m_sql_cmd`
- **SELECT_LEX**（`st_select_lex`，`sql_lex.h:1121`）——查询块：`table_list`（FROM）、`item_list`（SELECT 列）、`where`/`having`、`group_list`/`order_list`；骨架 `st_select_lex_node` 的 `next/prev`（兄弟）+ `master/slave`（父子）+ `link_next/link_prev`（全局）三组链构成 SELECT/UNION 的多链交叉结构

辅助状态都在 `Parser_state`（`sql_lex.h:5494`）：`Lex_input_stream m_lip`（词法）+ `Yacc_state m_yacc`（bison 动态栈）。词法器的**双缓冲设计**值得注意：`m_buf` 保留原始文本（错误消息/视图定义），`m_cpp_buf` 是剥离 `/*! ... */` 特殊注释后的"干净"文本。

## 调用链路

从连接到执行的完整主干：

```
handle_connections_sockets (sql/mysqld.cc:6674)   poll + accept 循环
└─ create_new_thread (:6556) → handle_one_connection (sql/sql_connect.cc:1416)
   └─ do_handle_one_connection (:1466)
      ├─ CONNECT::create_thd  → new THD + vio 挂接 + store_globals() 绑 TLS
      └─ while (thd_is_connection_alive) do_command(thd)
         └─ do_command (sql/sql_parse.cc:1225)
            ├─ my_net_read_packet(net, 1)          4B 头 + payload 协议包
            └─ dispatch_command (:1609)
               └─ case COM_QUERY (:1862)
                  ├─ alloc_query (:2757)             语句字符串拷进 THD mem_root
                  ├─ Parser_state parser_state.init(thd, ...)   栈上对象
                  └─ mysql_parse (:7890)
                     ├─ lex_start(thd) → LEX::start() (sql_lex.cc:1232)
                     ├─ thd->reset_for_next_command (:7460)
                     ├─ parse_sql (:10348)
                     │    └─ MODE_ORACLE ? ORAparse : MYSQLparse (bison)
                     │         每次 yylex() → MYSQLlex (sql_lex.cc:1879)
                     │           → m_lip.lex_token (:1903)   ★LALR(2) 收缩
                     │           → lex_one_token (:2030)      手写 DFA 状态机
                     │         bison 归约直接构造 Item/SELECT_LEX/Sql_cmd
                     └─ mysql_execute_command (:3499)
                        └─ switch (lex->sql_command)
                           SQLCOM_SELECT:3965 → check_table_access → execute_sqlcom_select
                           新式命令 → lex->m_sql_cmd->execute(thd)
```

多语句在**词法层**处理：`query:` 顶层规则（`sql_yacc.yy:2129`）发现分号后 `lip->found_semicolon = lip->get_ptr()` 强制 parser 停在分号，剩余文本留给 `dispatch_command` 的外层循环（`sql_parse.cc:1892-1985`）——"多语句"本质是词法器与 dispatcher 的协作，不是一次 parse 多条。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
|---|---|---|
| `dispatch_command` | 协议命令分发 | sql_parse.cc:1609；COM_* 第一层 switch |
| `mysql_parse` | 解析入口 | :7890；lex_start + reset + parse + execute |
| `parse_sql` | 方言选择 | :10348；MODE_ORACLE 分流到 ORAparse |
| `Lex_input_stream::lex_token` | LALR(2)→LALR(1) token 收缩 | sql_lex.cc:1903；WITH ROLLUP→WITH_ROLLUP_SYM 等 |
| `lex_one_token` | DFA 词法 | sql_lex.cc:2030；`cs->state_map` 表驱动 |
| `mysql_execute_command` | SQL 命令分发 | :3499；SQLCOM_* 第二层巨型 switch |
| `check_table_access` | 表级权限 | sql_parse.cc:7060 → check_grant (sql_acl.cc:9942) |
| `LEX::alloc_select` | 新查询块分配 | sql_lex.cc:6528；编 select_number 进 select_stack |

</details>

## 核心实现

### 手写 DFA 词法器 + LALR(2) 收缩

`lex_one_token`（`sql_lex.cc:2030`）是 `switch(state)` 驱动的表驱动 DFA——状态转移表来自**字符集的 `cs->state_map`**（:2041）。更精彩的是 `lex_token`（:1903）的 **LALR(2)→LALR(1) token 收缩**：`WITH ROLLUP` 合成 `WITH_ROLLUP_SYM`、`FOR SYSTEM_TIME` 合成 `FOR_SYSTEM_TIME_SYM`、`(` 按 follow 语境分派 `LEFT_PAREN_ALT/LEFT_PAREN_LIKE/LEFT_PAREN_WITH`（:1978-2013），未消费 token 存 `lookahead_token`。这是把文法理论问题下推到词法器解冲突的教科书案例——`sql_yacc.yy:13111` 注释自述 "cause LALR(2) conflicts"。

### 双 yacc 方言构建

`sql/gen_yy_files.cmake` 用自实现的 `%ifdef MARIADB / %else / %endif` 文本处理把一份 `sql_yacc.yy`（21k 行）分裂成 `yy_mariadb.yy` 与 `yy_oracle.yy`，bison 分别生成 `MYSQLparse()` 和 `ORAparse()`；运行时 `parse_sql` 按 `sql_mode & MODE_ORACLE` 选择（`sql_parse.cc:10393`）。**Why**：PL/SQL 兼容需要大量语法差异，共享 95% 相同的规则避免双文件漂移，且同一二进制内可按会话切方言。`%expect 72`（sql_yacc.yy:400）把已知 shift/reduce 冲突数钉死为回归防线。

### Sql_cmd：巨型 switch 的渐进偿还

`sql_cmd.h:52-72` 的官方注释直说了这个迁移策略：老命令把属性堆进 LEX（union-of-fields），**新语句一律子类化 `Sql_cmd`**——"improves code modularity (see the 'big switch' in dispatch_command()), and decreases the total size of the LEX structure"。现状是双轨并存：`mysql_execute_command` 里 SQLCOM_INSERT 走 switch + LEX 字段（`many_values`），SQLCOM_UPDATE/DELETE 与 DDL 家族走 `lex->m_sql_cmd->execute(thd)`（:4452/5911）。DML 子类骨架是模板方法：`Sql_cmd_dml` 定义 `precheck() → open_tables_for_query() → prepare_inner() → lock_tables() → execute_inner()`（`sql_select.cc:34954/35015`）。

### 权限检查的位置

统一在 `mysql_execute_command` 每个分支的执行逻辑**之前**（解析后、打开表前）：db 级 + 全局级 `check_access`（sql_parse.cc:6639，含视图 definer 切换 `Switch_to_definer_security_ctx`），表级 `check_grant`（`sql_acl.cc:9942`），列级在 `Item_field::fix_fields` 之后 `check_grant_column`（`sql_acl.cc:10232`）。数据源是启动时 `acl_init`（sql_acl.cc:3278）载入内存的 `acl_users/acl_dbs/acl_hosts` + `acl_cache`（Hash_filo LRU，:726）。

### 视图/CTE/vcol 的延迟重解析

视图表定义只存 SELECT 文本，**每次 open 时** `mysql_make_view`（`sql/sql_view.cc:1331`）new 一个 `st_lex_local` 完整重解析（:1541），靠 `view_creation_ctx` 保存建视图时的 sql_mode 保证语义一致。**Why**：视图文本必须以定义者视角和当时 sql_mode 解释，缓存语法树会在 ALTER 下级表、sql_mode 变化时产生语义漂移。与 SP 的"一次编译成 sp_instr 指令"（`sp_head::create`，sp_head.cc:512）形成对照——**重解析频率高的用指令缓存，语义随环境变的用文本重解析**。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 命令对象 | `Sql_cmd` 纯虚 execute（sql/sql_cmd.h:74） | parser 与 runtime 的接口；渐进替换 LEX 字段堆叠 |
| 表驱动状态机 | `lex_one_token` + `cs->state_map` | 字符集差异（CJK 多字节）由 strings 层吸收 |
| 享元/arena | `Sql_alloc` 全家 + `new(thd->mem_root)` + Query_arena 三态 | 语句结束整棵丢弃，PS/SP 独立 arena |
| 属性表 | `sql_command_flags[]`（sql_parse.cc:477，`init_update_queries` :517 填充） | CF_CHANGES_DATA 等位标志被 binlog/SP/统计多处消费，一处声明多处生效 |
| 栈替代递归 | `select_stack[]` + push/pop_select（sql_lex.h:3927） | 嵌套查询深度受控且可报错 |

## 模块间交互

- **下游**：解析产物直接就是优化器输入——没有独立 AST 层。SELECT 交接点 `execute_sqlcom_select` → `handle_select` → `mysql_select` **逐字段传** `select_lex->table_list/item_list/where/order_list`（见[优化器与执行器](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/02-optimizer)）
- **handler 层**：`LEX::query_tables` 链表（`Query_tables_list`，sql_lex.h:1830）是服务器层→handler 层的表清单契约，`open_and_lock_tables` 经 `handler::ha_open` 真正打开引擎表（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）
- **横切**：bison 栈动态扩容 `my_yyoverflow`（sql_parse.cc:7412）挂进 `Yacc_state::yacc_yyss/yacc_yvs`，深嵌套不炸线程栈

## 扩展方式

**新增一个 SQL 命令 `FOO`** 的完整清单：

1. `sql/sql_command.h`：`enum enum_sql_command` 加 `SQLCOM_FOO`（必须在 SQLCOM_END 前）
2. `sql/lex.h`：`symbols[]` 加关键字
3. `sql/sql_yacc.yy`：`%token FOO_SYM` + `verb_clause:` alternation + 规则本体（参照 `deallocate:` :2253）
4. `sql/sql_cmd.h`：`class Sql_cmd_foo : public Sql_cmd`（官方推荐路径）
5. `sql/sql_parse.cc`：`mysql_execute_command` 加 `case SQLCOM_FOO:`；**`init_update_queries()`（:517）给 `sql_command_flags[SQLCOM_FOO]` 设 CF_* 位——漏了这步 binlog 与 SP 合法性都会错**（`sp_instr.cc:589`、`sql_connect.cc:287` 都在消费此表）
6. `sql/mysqld.cc`：`com_status_vars[]` 加 Com_foo 计数
7. `sql/sp_head.cc`：`sp_get_flags_for_command`（:182）决定能否在 SP/trigger 中执行
8. `sql/sql_acl.cc` 或分支内：权限检查

协议级命令（COM_FOO）完全不动 yacc——只改 `dispatch_command` 的 switch + `server_command_flags[]`。两种"命令"的分界线（SQL 文本进 bison、字节协议进 dispatch_command switch）本身就是这个模块的重要架构事实。
