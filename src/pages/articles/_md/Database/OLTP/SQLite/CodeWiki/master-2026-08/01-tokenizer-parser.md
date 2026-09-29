---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "分词与语法分析"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "Lemon", "LALR"]
description: "tokenize.c 查表分词、parse.y 文法、Lemon LALR(1) 生成器：零拷贝 Token、%destructor 错误路径内存安全、%fallback 关键字降级"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

SQL 文本进入 SQLite 的唯一入口。本模块把 `const char *zSql` 变成语法树：`tokenize.c`（899 行）是手写分词器，`parse.y`（2163 行）是 Lemon 文法文件，`tool/lemon.c`（6078 行）是自研 LALR(1) 生成器，`tool/lempar.c`（1097 行）是运行时引擎模板。仓库里**没有** `parse.c`——它是构建期由 lemon 从 parse.y 生成的（main.mk:1465-1467），`keywordhash.h` 同理由 `tool/mkkeywordhash.c` 生成。

## 模块架构

```text title="编译流水线"
src/parse.y ──(lemon -S)──► parse.c + parse.h (TK_* 码)
tool/mkkeywordhash.c ──► keywordhash.h (关键字哈希)
                                        │
SQL 文本 ─► sqlite3RunParser ─┬─► sqlite3GetToken (查 aiClass 表)
                              └─► sqlite3Parser (LALR 表驱动归约)
                                        │ 归约动作（parse.y 里写死）
                                        ▼
                          Select* / Expr* / SrcList*（语法树）
```

分词器与解析器的关系不是"先扫一趟再解析"，而是**拉取式单趟**：LALR 主循环每需要一个 token 才调 `sqlite3GetToken()`，token 只是 `(指针, 长度)`——零拷贝、零中间列表。

## 调用链路

```text
sqlite3Prepare (prepare.c:700)
└─ sqlite3RunParser (tokenize.c:600)
   ├─ yyParser sEngine（栈上分配，parse.y:98 的 ENGINEALWAYSONSTACK 宏）
   └─ 循环: sqlite3GetToken (tokenize.c:273) → sqlite3Parser (LALR 引擎)
        ├─ TK_SPACE/TK_COMMENT 跳过
        ├─ EOF 时伪造 TK_SEMI + 0 两个 token（tokenize.c:674，让无分号语句也能归约）
        ├─ WINDOW/OVER/FILTER 超前扫描消歧 (analyzeWindowKeyword :246)
        └─ 归约动作 → sqlite3SelectNew / sqlite3PExpr / sqlite3StartTable …
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `sqlite3GetToken` in tokenize.c:273 | 单 token 分类，返回字节长度 | `switch(aiClass[*z])` 查表跳转而非字符二分（tokenize.c:22 注释） |
| `sqlite3RunParser` in tokenize.c:600 | 分词+解析主循环 | EOF 伪造分号；长度超限即 `SQLITE_TOOBIG` 早失败 |
| `keywordCode` in keywordhash.h | 标识符→关键字码 | 构建期生成完美哈希 |
| `sqlite3Parser` in parse.c | LALR 归约引擎 | lempar.c 模板展开，纯数据驱动 |
| `yy_find_shift_action` in lempar.c:549 | 查动作表 | fallback/wildcard/default 三级兜底 |

</details>

## 核心实现

### 查表分词：aiClass 与 31 个字符类

`tokenize.c:29-59` 定义 `CC_*` 宏把 256 个字符归入 31 类（`CC_KYWD0` 关键字首字母、`CC_QUOTE` 三种引号、`CC_VARALPHA` `@#:` 前缀等），`aiClass[]`（:61-100）是 256 字节查找表，ASCII/EBCDIC 双版本。选查表而非对字符值 switch 的原因写在 tokenize.c:22-27：**对数组下标 switch 编译器生成跳转表，对任意字符值 switch 是二分搜索**。

`sqlite3GetToken()`（:273-595）按首字符类分派：`--` 注释、最长匹配操作符（`<=`/`<>`/`<<`）、`''` 转义字符串、`0x` 十六进制、`_` 数字分隔符升级 `TK_QNUMBER`、`x'..'` BLOB 字面量（tokenize.c:566 注释：**没有任何 SQL 关键字以 x 开头**，所以 x 可以特判后 fall through）。

### Lemon：为什么不用 yacc/bison

四个硬理由，全部能在源码里找到出处：

1. **`%destructor` 错误路径零泄漏**（lemon.c:341、lempar.c:401-424）：SQLite 的解析动作在值栈上挂 `Select*`/`Expr*` 真实堆对象，语法错误时栈被逐层弹出，每个元素按符号类型调用 `sqlite3SelectDelete` 等释放代码（parse.y:531 的 `%destructor select`）。bison 的同名机制是后补的且功能弱。
2. **关闭错误恢复**：parse.y:76 `#define YYNOERRORRECOVERY 1`。SQLite 语义上一条语句失败即整体失败，bison 风格的 error token 恢复只会继续消费 token 制造"垃圾归约"，在半途可能触发越界写。
3. **`%fallback`**（parse.y:272-296）：60+ 个关键字可降级为 `TK_ID`——传统 SQL 文法要为"每个可作标识符的关键字"写一条规则，SQLite 只需 `nm ::= idj`（parse.y:339）两条。运行时是 `yyFallback[]` 表（lempar.c:570）。
4. **表更小 + 自包含**：SHIFTREDUCE 合并动作（lemon.c:416）、默认归约、token 码聚簇（parse.y:258 注释：比较运算符 `TK_` 码必须相邻，供 `sqlite3ExprIfFalse()` 做 ±1 快速跳转）。lemon 单文件零依赖无 GPL 问题。

lemon 本身的六步流水线在 lemon.c:1741 的 main()：`FindRulePrecedences` → `FindFirstSets`(:919) → `FindStates`(:982) → `FindLinks`(:1157) → `FindFollowSets`(:1192) → `FindActions`(:1230)，然后 `CompressTables` + `ResortStates` 压缩，`ReportTable`(:4426) 按 lempar.c 的 `%%` 占位符填空产出 parse.c。**冲突数非零即构建失败**（lemon.c:1913）——与 yacc 默认 shift 优先的静默通过相反。

### 栈上解析器与资源限制

`%stack_size 50`（parse.y:25）让解析器引擎初始就在栈上；深递归 SQL 触发 `yyGrowStack`（lempar.c:297）扩容，上限 `SQLITE_LIMIT_PARSER_DEPTH`（parse.y:603）——**深嵌套被当作资源限制报错而非栈溢出崩溃**。扩容路径注入了 `sqlite3FaultSim`（parse.y:588）以测试 OOM。

### Parse 结构的三区内存语义

`Parse`（sqliteInt.h:3919 起）显式划分三个区域（注释见 :3981-4017）：必须清零区（`db`/`rc`/`pVdbe`…）、递归间恒定区（`pOuterParse`/`sNameToken`）、**每次递归重置区**（以 `offsetof(Parse,sLastToken)` 为界：`sLastToken`、`nVar`、`zTail`、`pNewTable`…）。嵌套 parse（`sqlite3NestedParse`）复用同一结构时靠这个边界判断哪些字段要重置。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 生成器模式 | parse.y 是唯一权威源（:15 警告不许改生成的 parse.c） | 文法与动作同文件维护；feature flag 生成不同文法（`%ifdef SQLITE_OMIT_*`，parse.y:280） |
| 查表驱动 | `aiClass[]`、`yy_action[]`、`yyFallback[]` | 热路径无分支预测惩罚 |
| 协程式拉取 | 分词器是被调用的无状态函数 | 零中间表示、早失败、支持 WINDOW 超前扫描 |

## 模块间交互

parse.y 全文 414 处调用下游构造函数，归为四类：**build.c**（`sqlite3StartTable` :209 / `sqlite3EndTable` :224 / `sqlite3FinishCoding` :176）、**select.c**（`sqlite3SelectNew` :654 七元组组装 / `sqlite3Select` :525）、**expr.c**（`sqlite3PExpr` / `sqlite3ExprListAppend`）、**resolve/prepare 侧通道**（`parseDoubleLinkSelect` :543 复合 SELECT 双链）。错误消息经 `sqlite3ErrorMsg` 写 `pParse->zErrMsg`，prepare 退出时转 `db->pErr`。

## 扩展方式

新增一个 SQL 关键字（历史上 3.31 的 `GENERATED` 就是这么加的）：

1. `tool/mkkeywordhash.c` 的 `aKeyword[]` 表加一行（mask 决定随哪些 feature flag 编入）——不改这里关键字永远只是 `TK_ID`；
2. `src/parse.y` 加 `%token`（可作标识符还需进 `%fallback ID` 列表）+ 使用它的规则；
3. 下游构造函数（build.c/select.c）；
4. 重新构建——lemon 冲突即失败；注意 token 码相邻约束（parse.y:258）。
