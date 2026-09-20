---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "SQL 解析器"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "C++", "Bison", "解析器", "Item 表达式"]
description: "sql_yacc.yy 文法、PT_* 解析树、LEX/Query_block/Query_term 查询块树与 Item 表达式系统的源码解读"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

解析器把 SQL 文本变成服务器内部的语义对象：`PT_*` 语法树 → `Sql_cmd` 命令对象 → `Query_block`/`Query_expression` 查询块树 + `Item` 表达式树。它独立成模块是因为这是一个**纯编译问题**——从 8.0 重构后，解析与语义彻底分层：bison 只负责"形状"（语法），`Parse_tree_node:: contextualize` 负责"含义"（符号解析、作用域），两者用统一的 `make_cmd` 收口。理解这条流水线是读优化器与执行器的前置条件。

涉及文件：`sql/sql_yacc.yy`（~19,300 行文法）、`sql/sql_lex.*`（LEX 与查询块树）、`sql/parse_tree_*.h/cc`（解析树节点，~285 个 PT_ 类）、`sql/item*.h/cc`（Item 表达式体系，`item.h` 一文件 7,598 行）、`sql/sql_prepare.cc`（预编译）、`sql/sp_head.cc`（存储过程）。

## 模块架构

```text
SQL 文本
  │  Lex_input_stream (sql_lex.h:3473)     词法：按 charset 切 token
  ▼
my_sql_parser_parse（bison 生成，sql_yacc.yy）
  │  产生 PT_* 节点树（Parse_tree_node 基类）
  ▼
Parse_tree_root::make_cmd (parse_tree_nodes.h:175)   收口
  │  contextualize：符号解析 → Item 树 → Sql_cmd 对象
  ▼
LEX（sql_lex.h） ── 持有 ──► Query_expression (unit)
                              └── Query_term 树（query_term.h:216）
                                    └── Query_block（叶子，sql_lex.h:1198）
                                          └── Item 表达式（select list / WHERE / …）
```

## 调用链路

```text
dispatch_sql_command (sql/sql_parse.cc:5303)
├─ invoke_pre_parse_rewrite_plugins / invoke_post_parse_rewrite_plugins   # query rewrite 钩子
├─ parse_sql → THD::sql_parser (sql/sql_class.cc:3180)
│    └─ my_sql_parser_parse(thd, &root)      # bison yyparse（api.prefix=my_sql_parser_，sql_yacc.yy:561）
│         ├─ 文法归约时 new PT_* 节点（MEM_ROOT 分配）
│         └─ 语义动作宏（均受 lex->will_contextualize 门控）：
│              CONTEXTUALIZE(x) —— 构造 Parse_context 后调 (x)->contextualize(&pc)
│                                    并 pc.finalize_query_expression()（sql_yacc.yy:231）
│              ITEMIZE(x, y)     —— 调 (x)->itemize(&pc, &y) 把表达式 Item 挂到 y（:254）
│              MAKE_CMD(x)       —— 调 Lex->make_sql_cmd(x)（x 可为 nullptr，OOM 场景）
├─ LEX::make_sql_cmd (sql/sql_lex.cc:5178)
│    └─ root == nullptr ? 解析器已在 MAKE_CMD 宏内调过 make_sql_cmd（直接成功返回）
│                       : parse_tree->make_cmd(thd) → Sql_cmd_dml / Sql_cmd_ddl / ...
└─ mysql_execute_command (sql/sql_parse.cc:3027)
```

`root` 空指针的双重含义是这条链最微妙的契约（`THD::sql_parser` 的注释原话）：解析器在归约到语句根时可能已经通过 `MAKE_CMD` 内部调用了 `make_sql_cmd`——此时输出参数 `root` 保持 nullptr；否则由 `THD::sql_parser` 自己补调。`will_contextualize` 门控的用途：`PREPARE` 等路径只需"形状"不需要完整语义装配时，跳过 contextualize 与 make_cmd。

方法速查：

<details>
<summary>解析器方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `THD::sql_parser` in `sql_class.cc:3180` | 驱动 bison 并收口 root | 解析错误后 `cleanup_after_parse_error` 保证 THD 无副作用 |
| `LEX::make_sql_cmd` in `sql_lex.cc:5178` | `root->make_cmd(thd)` 产出 Sql_cmd | 断言 `sql_command_code()==sql_command` 保证类型一致 |
| `Parse_tree_node::contextualize` | 递归语义解析 | 错误用 `PPRINT` 报出 token 位置 |
| `PT_query_expression::make_cmd` | DML 语句的最终装配 | 8.0 后 SELECT 语句的 Sql_cmd 由 PT 树现场构造 |
| `Query_block::prepare` in `sql_resolver.cc:184` | 语义 prepare（下一步） | 见优化器模块 |

</details>

## 核心实现

### 文法层：sql_yacc.yy 的组织

bison 文件用 `%define api.prefix {my_sql_parser_}`（`sql_yacc.yy:561`）避免符号冲突，`%parse-param { class THD *YYTHD }` 把会话指针传入每个语义动作。动作宏把上下文缩短为局部名：`#define Lex (YYTHD->lex)`、`#define Select Lex->current_query_block()`（文件头 `:50-60`）——所以文法动作里的 `Select->add_item(...)` 实际是往当前 Query_block 添加 Item。`YYMAXDEPTH 3200` 限制栈深防深递归炸栈。多语句（`a; b; c`）不重新 parse：`dispatch_sql_command` 用 `parser_state->m_lip.found_semicolon`（`sql_parse.cc:5334`）切出下一条语句的起点，循环调 `mysql_parse`。

### 语义层：PT_* 树与 contextualize

解析树节点基类是 `Parse_tree_node_tmpl`（`sql/parse_tree_node_base.h:231` 的模板）：`operator new(size, MEM_ROOT*, nothrow)` 直接 `mem_root->Alloc(size)`（placement new 语义），debug 构建下带 `contextualized` 标志防止重复装配；派生接口 `Parse_tree_root` 约定两个虚函数：`contextualize(THD)`（语义解析）与 `make_cmd(THD)`（`parse_tree_nodes.h:175`，仅根节点实现，且拷贝构造/赋值被 delete）。~285 个 `PT_`/`PTI_` 类（`parse_tree_nodes.h` + `parse_tree_items.h`）按语句类型组织：`PT_query_expression`（SELECT 语句根，`parse_tree_nodes.h:1685`）、`PT_create_table_stmt`、`PT_item_list`、`PTI_simple_ident_q_3d`（限定名 `db.tbl.col`，`parse_tree_items.h:131`）等。**为什么引入 PT 层**（8.0 重构的核心动机）：老解析器在 bison 动作里直接改 LEX 全局状态，错误的语句会留下半成品；PT 层让"构造"（parse 无副作用）与"装配"（contextualize 一次性完成）分离，prepared statement 的重复执行不再依赖重新解析。

### 查询块树：Query_expression / Query_term / Query_block

`LEX`（`sql/sql_lex.h:2787` 附近）持有 `Query_expression *unit` 与当前 `Query_block`。8.0.31+ 引入 `Query_term` 树（`sql/query_term.h:216`）表达集合操作的结构：

```cpp
class Query_term {...};                        // 基类
class Query_term_set_op : public Query_term;   // 集合操作节点
class Query_term_union / Query_term_intersect / Query_term_except
    : public Query_term_set_op;               // :720/:733/:746
class Query_block : public Query_term {...};   // :1198 in sql_lex.h，叶子查询块
```

`SELECT a UNION SELECT b INTERSECT SELECT c` 被解析成带优先级的 Query_term 树，每个叶子是一个 `Query_block`（含自己的 select list、WHERE、GROUP BY）。统一表达靠 `Query_expression::m_query_term` 指针（`sql/sql_lex.h:679`）指向查询项树根：`is_simple()` 的判定就是 `m_query_term->term_type() == QT_QUERY_BLOCK`（`:812`）——单 SELECT 时树根即唯一的 Query_block 叶子。`Query_expression::prepare/optimize/execute`（`sql/sql_union.cc:363/504/1211`）沿树递归派发。这个结构是优化器逐块规划（`JOIN` per Query_block）与执行器 streaming/物化选择的基础。

### Item：表达式即对象

```cpp
class Item : public Parse_tree_node {...};        // sql/item.h:929 一切表达式的根
class Item_ident : public Item {...};             // :4263 限定/非限定名字
class Item_field : public Item_ident {...};       // :4534 解析后的列引用
class Item_result_field : public Item {...};      // :6025 有结果缓冲的（函数类）
class Item_func : public Item_result_field {...}; // item_func.h:101 内置函数
class Item_sum : public Item_func {...};          // item_sum.h:399 聚合函数
class Item_subselect : public Item_result_field;  // item_subselect.h:80 子查询
```

Item 既是编译期对象（常量折叠、类型推导、写集分析）也是执行期对象（`val_int()/val_str()/val_real()` 求值接口）——**一个节点两种身份**是 MySQL 执行模型的决定性特征：优化器在 Item 树上做条件化简（`sql/sql_const_folding.cc`）与等价类合并（`COND_EQUAL`），执行器逐行对同一棵树求值。700+ 子类散布在 `item_func.h`、`item_cmpfunc.h`（`Item_func_eq` in `:1111`）、`item_strfunc.h`、`item_timefunc.h`、`item_json_func.h`、`item_geofunc.h`、`item_sum.h` 等按领域的文件里。两个易被忽略的成员：`str_value`（内嵌 `String` 缓冲，`val_str` 路径复用避免每行分配）与 `item_name`（`Item_name_string`，保存列别名/表达式文本，供客户端展示与 ORDER BY 别名解析）——析构函数 `~Item()` 特意 `item_name.set(0)` 清空指针防悬垂（`sql/item.h:1179`）。与 Item 并列的另一个大族是 `Field`（`sql/field.h:573`，列的存储格式与编解码，`Field_vector` in `:3791` 支持 26.x 的向量类型），Item 运行时从 Field 取数。

### 内存模型：MEM_ROOT 场地

解析与执行期对象全部从 `MEM_ROOT`（`include/my_alloc.h:83`）批量分配、语句结束整体释放。内部组织是 `Block` 单链表（`my_alloc.h:85` 的 `Block *prev`，释放即沿链归还），两个回收入口：`Clear()` 全量释放、`ClearForReuse()` 保留第一块供下一条语句复用（`my_alloc.h:226`）。分配用 placement new：`operator new(size_t, MEM_ROOT*, nothrow)` 直接调 `mem_root->Alloc(size)`（`:439`），配合 `make_unique_destroy_only` 使用的析构式容器。`Query_arena`（`sql/sql_class.h:352`）封装"当前用哪个 root"，prepared statement 体系在 PREPARE 时切换到语句级 arena，EXECUTE 临时对象用另一个，避免重复解析。arena 切换是 `sql_prepare.cc` 最微妙的部分（`Prepared_stmt_arena_holder`）。

### 预编译与存储过程

- **prepared statement**：`COM_STMT_PREPARE` → `mysql_sql_stmt_prepare`（`sql/sql_prepare.cc`）在内部 THD 上跑一遍解析，缓存 `Prepared_statement`（LEX + Item 树）；EXECUTE 时跳过解析只重新 contextualize 变量占位；
- **存储过程**：`sp_head`（`sql/sp_head.cc`）把过程体编译成 `sp_instr` 指令序列（`sp_instr.cc`），过程调用是执行这组指令，每条指令内部再走标准解析/执行管线——所以 SP 里的 SELECT 与顶层的 SELECT 走完全相同的路径。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 解释器 | Item 树 + `val_*` 接口 | 表达式求值的经典模式，优化器与执行器共享同一棵树 |
| 建造者 | `PT_*::contextualize` 逐节点装配 LEX | 把"怎么构造查询块"的知识局部化到每个语法节点 |
| 工厂方法 | `Parse_tree_root::make_cmd`（`parse_tree_nodes.h:175`） | 每种语句根节点自己知道产出哪种 Sql_cmd |
| ARENA | `Query_arena`（`sql_class.h:352`） | 语句级批量内存，防泄漏免逐个析构 |

## 模块间交互

- **上游**：`dispatch_sql_command`（连接层）送入 SQL 文本与 `Parser_state`；
- **下游**：产出的 `Sql_cmd` 交给 `mysql_execute_command` 分发（见[优化器](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/03-optimizer)与[执行器](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/04-executor)）；
- **旁路**：`invoke_pre_parse_rewrite_plugins`（`sql_parse.cc:5318`）允许 query rewrite 插件在解析前改写文本（如 `plugin/rewriter`）；general log 与 digest（`sql/sql_digest.cc`）也在此取样；
- **复制**：Row 格式下 binlog 记录行镜像而非语句（见[复制模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication)），但 `Query_log_event`（SBR）保存原始文本，replica 侧要重新走本模块。

## 扩展方式

- **新增一种 SQL 语句**：`sql/lex.h` 加 token → `sql_yacc.yy` 加产生式与 PT 节点 → `make_cmd` 返回新 `Sql_cmd` 子类（`sql/sql_cmd.h:83` 基类）→ `mysql_execute_command` 或 `Sql_cmd::execute` 实现语义；
- **新增内置函数**：`sql/item_create.cc`（函数注册表）加 resolver + `item_func.h` 新 `Item_func_xxx`——优化与执行自动获得；
- **新增表达式优化**：在 `sql/sql_optimizer.cc` 的条件处理阶段对 Item 树做变换（常量折叠入口 `sql_const_folding.cc`）。
