---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "DDL 与写语句生成"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "DDL", "schema"]
description: "CREATE TABLE 三段式回调与 sqlite_schema 占位记录、INSERT 四模板、ALTER TABLE 文本级重写策略、触发器子程序与 UPSERT 单遍实现"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

build.c 头部注释（:1-23）自我定位："parser 语法归约时调用的 C 回调例程"。本模块覆盖所有 DDL/DML 的**代码生成**：`build.c`（CREATE/DROP）、`insert.c`（+update.c/delete.c 复用其插入引擎）、`alter.c`（RENAME/ADD COLUMN）、`trigger.c`、`upsert.c`、`fkey.c`、`vacuum.c`、`analyze.c`。核心设计是**统一代码生成器模式**：DDL 与 DML 一律编译为 VDBE 程序——连"写 schema"本身都是一段字节码（OP_CreateBtree → OP_Insert 占位 → UPDATE 回填 → OP_SetCookie → OP_ParseSchema）。

## 模块架构

```text title="schema 的两条腿"
写路径: parse.y 回调 → sqlite3StartTable/AddColumn/EndTable
        → VDBE 程序: 占位 sqlite_schema 记录 → 回填 type/name/rootpage/sql
        → OP_SetCookie 递增 schema cookie → OP_ParseSchema 运行时重载
读路径: sqlite3InitOne (prepare.c:210) 手工自举 sqlite_schema 定义
        → SELECT * FROM sqlite_schema → sqlite3InitCallback (:96)
        → db->init.busy=1 重新 parse CREATE 原文（不生成代码）
```

**schema 存的是语句原文**：表/视图存用户敲的 CREATE 文本（build.c:2923-2931 直接从 token 流切片），不是编译后的元数据——打开连接要 parse 全部 schema，靠 cookie + prepared statement 缓存摊销。收益是极简自描述、免掉二进制 schema 格式迁移、ALTER 可做文本级 splice；`sqlite3InitCallback` 甚至意外获得安全边界：**只有 CREATE 以 C+R 两个字母开头**，损坏的 schema 也无法执行任意语句（prepare.c:108-115 注释）。

## 调用链路

```text title="CREATE TABLE 的三段式回调"
① sqlite3StartTable (build.c:1225)   # 见到 CREATE TABLE <名>
   ├─ 撞名检查 + Table 结构挂 pParse->pNewTable
   ├─ OP_CreateBtree 拿根页号 → 存 u1.cr.regRoot
   └─ 立即在 sqlite_schema 预留 rowid 槽位（OP_NewRowid+OP_Insert 占位）
      # why 提前占位 (build.c:1362-1371): 表记录必须先于其隐含索引出现，
      # 而 PRIMARY KEY 关键字此刻还没被 parse 到
② sqlite3AddColumn/AddPrimaryKey/…   # 逐列填充 Table
③ sqlite3EndTable (build.c:2670)     # 见到收尾 ')'
   ├─ 持久化语句原文（token 切片）
   ├─ sqlite3NestedParse("UPDATE %Q.sqlite_schema SET … WHERE rowid=#%d")
   │   # #%d 是"寄存器 NNN 的值"语法糖——编译期引用运行期根页号
   ├─ sqlite3ChangeCookie → OP_SetCookie
   └─ OP_ParseSchema（运行时增量重载内存 schema）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `sqlite3StartTable` in build.c:1225 | CREATE 表头回调 | 提前占位 rowid |
| `sqlite3EndTable` in build.c:2670 | 收尾+落盘 | init.busy 时走 tblHash 分支不写盘 |
| `sqlite3NestedParse` in build.c:294 | 嵌套 SQL 拼进当前程序 | "用 SQL 实现 SQL"——DDL 落盘全靠它 |
| `sqlite3Insert` in insert.c:888 | INSERT 代码生成 | 头部 :799-868 四模板注释 |
| `sqlite3GenerateConstraintChecks` in insert.c:1889 | 约束检查+冲突分派 | UPSERT 检测嵌在这里 |
| `sqlite3CompleteInsertion` in insert.c:2796 | 逐索引 OP_IdxInsert | partial index 有 OP_IsNull 跳过 |
| `xferOptimization` in insert.c:3067 | btree 层原始 record 拷贝 | VACUUM 提速的来源 |
| `sqlite3AlterRenameColumn` in alter.c:593 | RENAME COLUMN | 重新 parse + RenameToken 偏移定位 |

</details>

## 核心实现

### INSERT：四个代码模板

`sqlite3Insert()` 头部注释（insert.c:799-868）列出四模板：**(1)** 单行 VALUES 直线执行；**(2)** `INSERT INTO t1 SELECT * FROM t2`（schema 全同）走 `xferOptimization`——btree 层原始 record 拷贝不拆解重组；**(3)** SELECT 编译为 co-routine（`OP_InitCoroutine`/`OP_Yield`）逐行 yield 插入；**(4)** SELECT 读目标表或有行级触发器时先物化临时表。

主流程要点：`sqlite3OpenTableAndIndices`（insert.c:1269）对表和**全部索引**发 `OP_OpenWrite`；IPK 槽位放 `OP_SoftNull` NULL 省空间；rowid 生成 `OP_NewRowid`（insert.c:1509/1522/1533 三分支）；`sqlite3GenerateConstraintChecks` 为每个索引用 `OP_MakeRecord` 构造索引键、冲突时按 onError 决定跳转/中止/REPLACE/**转 upsert**；最后 `sqlite3CompleteInsertion` 逐索引 `OP_IdxInsert`，rowid 表 `OP_Insert` 带 `OPFLAG_NCHANGE|OPFLAG_LASTROWID|OPFLAG_APPEND`。

**UPSERT 的实现位置是精髓**（insert.c:2377/2609）：唯一性检查本来就要先 seek 索引，检测到已存在**直接跳去执行 DO UPDATE**——单遍完成，避免"先 INSERT 失败再 UPDATE"两遍执行。upsert.c 只做目标分析（`sqlite3UpsertAnalyzeTarget` 把 ON CONFLICT(列) 匹配到索引）。

### ALTER TABLE：文本级重写而非原地改

SQLite 的三种原生命令都是**重写 sqlite_schema 的 sql 列文本**：

- **RENAME TO**（alter.c:124）：四条嵌套 SQL 重写所有引用 + `renameReloadSchema` 全量重建 schema + `renameTestSchema` 验证仍可解析。
- **RENAME COLUMN**（alter.c:593）：`sqlite_rename_column()` SQL 函数（alter.c:1529）把存下来的 CREATE 语句**重新 parse 一遍**（`db->init.busy=1`），靠 parse 期间登记的 `RenameToken` 链表（:685——记录"哪个 token 生成了哪个树节点"）定位所有需替换 token 的字节偏移，然后按偏移拼接新文本。触发器体、外键列、索引表达式全覆盖。
- **ADD COLUMN**（两段式 :483/:313）：先拷贝 Table 到 `sqlite_altertab_` 前缀副本上 parse 新列（借用户不允许的 `sqlite_` 前缀避免撞名），再嵌套 SQL 直接**在原文 addColOffset 字节处切开拼接**——这个偏移在建表时预记录（build.c:3007：`13 + (pCons->z - pParse->sNameToken.z)`，13 = "CREATE TABLE " 长度）。

Why 文本重写而非原地改：(a) schema 的唯一真源就是 CREATE 原文，没有独立列元数据区可打补丁；(b) 修改列类型会改变既有 record 物理编码，必然重写全部数据页——SQLite 干脆只实现"安全"子集（ADD COLUMN 要求常量默认值，因为**旧 record 可以合法地比新 schema 短**，读旧行时尾部缺列按默认处理），其余场景让用户走文档里的 12 步"建新表-拷贝-改名"流程，xfer 优化使这条路成本可控。

### 触发器 = VDBE 子程序

`codeRowTrigger`（trigger.c:1232）为每个 (trigger, orconf) 组合创建独立 Parse/Vdbe 编译触发器体，体内 TK_INSERT/UPDATE/DELETE 递归调用 sqlite3Insert 等。宿主语句经 `OP_Program`（P4_SUBPROGRAM）调用，OLD.\*/NEW.\* 以寄存器数组传入（布局见 trigger.c:1474-1500 注释）。Why 子程序而非内联：同一触发器一条语句里可能对每行触发 N 次，子程序避免按行复制代码；`TriggerPrg` 按 (trigger, orconf) 缓存防重复编译。**外键动作也是同一机制生成的"无名触发器"**（trigger.c:1419 注释）。递归深度受 `SQLITE_LIMIT_TRIGGER_DEPTH` 限制。

### 外键延迟检查

fkey.c:20-40 头注释：每连接挂一个计数器，事务开启清零；语句造成违例 +1、消除违例 -1，commit 时非零即失败。Why 延迟：允许事务内以任意顺序插父/子行。头注释也坦承两个缺点：commit 失败不指明违例行、计数器只是保守近似。立即型外键则每语句内联扫父表（`OP_FkIfZero` 短路，fkey.c:350）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 统一代码生成器 | 全模块 | DDL 的副作用也是事务性的——VDBE 程序可 rollback |
| `sqlite3NestedParse` | build.c:294 | 嵌套 SQL 的代码直接拼进外层程序，`#NNN` 寄存器语法糖连通两趟编译 |
| 子程序复用 | trigger.c TriggerPrg 缓存 | 每行触发不复制代码 |
| Token 偏移登记 | alter.c RenameToken | RENAME 的重写精度来源 |

## 模块间交互

- **↔ vdbe**：本组只产指令不执行。关键 opcode：`OP_CreateBtree/OP_Destroy/OP_NewRowid/OP_MakeRecord/OP_Insert/OP_IdxInsert/OP_SetCookie/OP_ParseSchema`（vdbe.c:7293）/`OP_Program/OP_Vacuum`。
- **↔ btree**：建表走 `OP_CreateBtree`（INTKEY vs BLOBKEY）；删表走 `OP_Destroy`，**按根页号从大到小**发（防 auto-vacuum 页搬迁踩空，build.c:3348 注释）。
- **↔ prepare.c**：schema 加载回调 `sqlite3InitCallback`（:96）与 `OP_ParseSchema` 复用同一套 parser/build 路径，靠 `db->init.busy` 门闩区分"建内存结构"与"生成代码"。
- **↔ vacuum/analyze**：VACUUM 只编译成一条 `OP_Vacuum`，真正逻辑 `sqlite3RunVacuum`（vacuum.c:141）执行期跑（ATTACH 临时库 + xfer 拷贝 + `sqlite3BtreeCopyFile`）；ANALYZE 相反——生成完整 VDBE 程序写 sqlite_stat1..4。

## 扩展方式

新增一种 CREATE XXX 语句的步骤：parse.y 加规则（照抄 Start/End 两段式）→ build.c 写两个回调（名称检查 + VDBE 生成：OP_CreateBtree → NestedParse 写五元组 → ChangeCookie → ParseSchemaOp）→ `sqlite3InitCallback` 的 type 字符串路由要保证新语句以 "CR" 开头不变量 → sqliteInt.h 加内存结构 + `sqlite3SchemaClear`（callback.c:495）加释放 → alter.c 的 rename 函数需识别新语句类型 → `OP_Expire` 使既有 prepared statement 失效 → corrupt schema 注入测试覆盖错误路径。
