---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "表达式与名称解析"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "表达式树", "Walker"]
description: "Expr 单 struct+union 的三层截断设计、resolve.c 的 NameContext 链名称绑定、walker.c 共享遍历引擎与三值返回协议"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`Expr` 是 SQLite 全库最核心的数据结构：语法树的节点、schema 里的默认值/CHECK/索引表达式、优化器的改写对象、代码生成的输入——全部是同一棵 `Expr` 树。本模块负责它的**生命周期四阶段**：构建（expr.c 前半）、名称绑定（resolve.c）、遍历（walker.c）、以及代码生成（expr.c 后半 ~4400-6600 行本身就是表达式编译器）。`treeview.c` 仅调试输出，`attach.c` 是 Walker 的次要消费者。

## 模块架构

```text title="Expr 生命周期"
parse.c 归约动作 ──sqlite3ExprAlloc──► Expr 树（op + union + flags）
        │
        ├─ resolve.c: NameContext 链名称解析（TK_ID → TK_COLUMN，绑游标+列号）
        ├─ walker.c: 共享遍历引擎（resolve/attach/优化/DDL 钉死全用它）
        ├─ sqlite3ExprDup: 深拷贝（schema 长期驻留用 EXPRDUP_REDUCE 压缩档）
        └─ expr.c 后半: sqlite3ExprCodeTarget → VDBE opcode
        最终 sqlite3ExprDelete 深度释放（一元链 goto 消栈）
```

## 调用链路

```text
sqlite3SelectPrep (select.c:6518)
├─ sqlite3SelectExpand (select.c:6431)      # '*' 展开、子查询展开
└─ sqlite3ResolveSelectNames (resolve.c:2196)
   └─ Walker{resolveExprStep, resolveSelectStep} + sqlite3WalkSelect
      ├─ TK_ID/TK_DOT → lookupName (resolve.c:278)     # 名称绑定心脏
      │    沿 NameContext.pNext 链向外找 SrcItem → 改写为 TK_COLUMN
      ├─ TK_FUNCTION → sqlite3FindFunction → 聚合则改 TK_AGG_FUNCTION
      └─ TK_IN/SELECT/EXISTS → 递归进子查询，nRef 差值判定相关性
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `sqlite3ExprAlloc` in expr.c:944 | 节点分配器 | 一次 malloc 同时装 struct+token 字符串（`u.zToken=(char*)&pNew[1]`） |
| `sqlite3PExpr` in expr.c:1056 | 二元节点 | 挂子树时向上传播 `EP_Propagate` 位 |
| `lookupName` in resolve.c:278 | 名称→(游标,列号)绑定 | 沿 NameContext 链逐层 `nRef++` 免费判定相关子查询 |
| `resolveExprStep` in resolve.c:995 | Walker 表达式回调 | 聚合改写 op；返回 `WRC_Prune` 阻止重复下降 |
| `sqlite3WalkExprNN` in walker.c:64 | 遍历引擎 | 前序；右链 continue 循环代替递归不耗栈 |
| `sqlite3ExprDup` in expr.c:1624 | 深拷贝 | `EXPRDUP_REDUCE` 整树单次分配（EdupBuf） |
| `sqlite3ExprDelete` in expr.c:1405 | 深度释放 | 遵守截断 flags；一元链 goto 消栈 |

</details>

## 核心实现

### Expr：单 struct + op + union，三层可截断

`Expr`（sqliteInt.h:3069-3131）不是类继承体系——一个 struct 承载所有表达式节点，`op`（u8 的 `TK_*` 码）+ `u32 flags`（32 个 `EP_*` 位，:3139-3170）+ 四组 union 复用存储。关键在**三条截断线**（sqliteInt.h:3225）：

```c title="sqliteInt.h —— 三层可变长度"
EXPR_FULLSIZE       // 完整节点
EXPR_REDUCEDSIZE = offsetof(Expr, iTable)   // 叶子节点截断（无需绑定信息）
EXPR_TOKENONLYSIZE = offsetof(Expr, pLeft)  // 极简节点（无子树）
```

sqliteInt.h:3054-3060 的 "ALLOCATION NOTES" 给出 why：**schema 中 Expr 数量巨大**——每个索引表达式、默认值、CHECK、触发器 WHEN 都长期驻留一份 Expr，一个节点必须能截断成 8/24/32 字节三档。OO 方案（每类一个 vtable 指针 + 独立 malloc）在内存上不可接受；且解析期频繁"原地变形"（`TK_ID`→`TK_COLUMN`、`TK_FUNCTION`→`TK_AGG_FUNCTION`），同型结构才可能零分配换头。

安全访问 union 靠 9 个判别宏（`ExprUseXList` 等，sqliteInt.h:3191-3199）——C 没有 language-level 的 tagged union 保护，SQLite 用宏 + DEBUG 断言自己造了一个。

### lookupName：名称绑定的心脏

`lookupName()`（resolve.c:278-867）把 `a.b.c` 拆三段，从最内层 NameContext 沿 `pNext` 链向外扫每个 `SrcItem` 匹配列名。命中即三连写：`pExpr->iTable = 游标号`、`pExpr->y.pTab = Table*`、`pExpr->iColumn = j`（**rowid 统一编为 -1**，让 `OP_Column` 一个 opcode 覆盖 rowid 与普通列），并置 `pMatch->colUsed` 位掩码供覆盖索引判定。

两个精妙的副产品：

- **`nRef` 计数**：每次匹配沿 NameContext 链逐层 `nRef++`（:855-862）。子查询解析前后 `nRef` 差值非零 ⇒ 相关子查询 ⇒ 置 `EP_VarSelect`——相关性判定是名称解析的免费搭车。
- **双引号字符串 hack**（:719-749）：无匹配的 `"z"` 回退成字符串字面量并 `sqlite3_log` 告警——源码注释原话 *"I now sorely regret putting in this hack"*。

### walker.c：261 行的共享遍历引擎

`sqlite3WalkExprNN`（:64）是唯一引擎：**先回调后下降**（前序），右子树用 `continue` 循环代替递归（二元运算链不耗栈）。回调返回三值：`WRC_Continue` 继续下降 / `WRC_Prune` 不下降但走兄弟 / `WRC_Abort` 整体退栈。

这 261 行被全库复用：resolve.c（名称解析）、attach.c 的 `fixExprCb`（DbFixer 把 DDL 中的表引用钉死到本库 schema）、where.c（常量传播）、alter.c（RENAME token 重映射）、expr.c 自身（常量判定、窗口收集）——每个消费者只写自己的回调。

### EP_Propagate：O(1) 的树上性质查询

`EP_Collate|EP_Subquery|EP_HasFunc` 在挂子树时自动向上传播（sqliteInt.h:3172，expr.c:1030）。父节点不必下降就能 O(1) 回答"这棵子树含不含子查询/函数/COLLATE"——这是常量折叠与索引可用性判定的热路径。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Walker（Visitor + 显式控制流） | walker.c 三值协议 | 遍历算法与语义回调彻底解耦；回调能改写遍历本身 |
| 判别联合 + flags | Expr / SrcItem / ExprList 三处同构 | 无虚表开销的 tagged union；union 成员守卫宏统一 |
| 栈上值对象上下文 | Walker/NameContext/DbFixer 局部变量 | 无引用计数无线程问题，解析完即弃 |
| 集中式 switch 分派 | resolveExprStep / sqlite3ExprCodeTarget / sqlite3TreeViewExpr 三处对同一 op 全集 | 行为按编译阶段正交 |

## 模块间交互

- **上游**：parse.c 归约动作直接调构造函数（`sqlite3ExprFunction`、`sqlite3ExprListAppend`——首次分配 4 槽满后翻倍）。
- **下游消费**：select.c（`sqlite3ExprDup` 用于 WHERE 下推）、where.c（colUsed 掩码驱动覆盖索引）、expr.c 后半 `sqlite3ExprCodeTarget`（expr.c:5012）把树翻译成 opcode、vdbe.c 运行时执行 `OP_Function`。
- **schema 长期驻留**：`sqlite3ExprDup(EXPRDUP_REDUCE)` 把整棵子树打包进单次分配 + `EP_Static` 免逐节点释放，供 build.c:1780（默认值）和 trigger.c:284（触发器 WHEN）使用。

## 扩展方式

新增一个标量函数调用走表达式路径的全景：parse.y 的 `expr ::= idj LP distinct exprlist RP`（:1235）→ `sqlite3ExprFunction`（此时聚合与否未知）→ resolve 的 TK_FUNCTION 分支查 FuncDef（**标量函数不改 op，聚合才改写 TK_AGG_FUNCTION**；funcFlags 决定 `EP_ConstFunc`/UNSAFE/DIRECT）→ 代码生成 `sqlite3ExprCodeTarget` case TK_FUNCTION（expr.c:5408：常量则 `sqlite3ExprCodeRunJustOnce` 缓存寄存器；否则 `sqlite3VdbeAddFunctionCall` 发 OP_Function，P4 挂编译期构造好的 sqlite3_context）→ vdbe.c 执行时调 `pDef->xSFunc`。

函数本身注册进 SQLite 本体要改 func.c 的 `aBuiltinFunc[]` 表——但从表达式模块视角，一次调用在树上只是"一个带名字 token 和实参 ExprList 的 TK_FUNCTION 节点"，语义完全延迟到 resolve（查表定性）和 codegen（查表发码）两个阶段。
