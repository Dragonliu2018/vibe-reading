---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "API 层与扩展机制"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "扩展机制", "虚拟表"]
description: "openDatabase 七步装配、sqlite3Prepare 的 schema 自举与 SQLITE_SCHEMA 重试、loadext 跳板表、vtab xBestIndex 协商协议与 PRAGMA 分发"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

进程外可见 ABI 的全部定义：连接生命周期（main.c）、prepare 编译入口（prepare.c）、legacy exec（legacy.c）、三套扩展协议（loadext.c 动态库 / vtab.c 虚拟表 / func.c 函数注册）、PRAGMA 分发（pragma.c）。它同时是**测试与自定义的挂载面**——授权回调、busy handler、progress、trace、wal hook 全在这层注册。

## 调用链路

```text title="sqlite3_prepare_v2 的四层套壳"
sqlite3_prepare_v2 (prepare.c:955)      # 与 _v3 只差 SQLITE_PREPARE_SAVESQL
└─ sqlite3LockAndPrepare (:854)          # mutex 壳 + BtreeEnterAll + 重试环
   └─ sqlite3Prepare (:700)
      ├─ 栈上 Parse 就位（PERSISTENT 时禁 lookaside :736）
      ├─ sqlite3BtreeSchemaLocked (:742) # 共享缓存下别人未提交的 schema 改动 → SQLITE_LOCKED
      ├─ sqlite3RunParser (:797)
      │   └─ 需要时经 sqlite3ReadSchema (:487) 拉起 schema 自举:
      │       sqlite3InitOne (:210) 手工伪造 sqlite_schema 的 CREATE
      │       → exec("SELECT * FROM sqlite_schema", sqlite3InitCallback :96)
      │       → 逐行把 CREATE 原文重新送回 sqlite3Prepare（init.busy=1 不生成代码）
      ├─ schemaIsValid (:509)   # cookie 比对，不等 → SQLITE_SCHEMA + ResetOneSchema
      └─ *ppStmt = (sqlite3_stmt*)sParse.pVdbe
```

**v2 与 v1 的核心差异**（prepare.c:936-941 官方注释）：v1 不保存 SQL 原文，schema 变更时 step 只能报 SQLITE_SCHEMA；v2/v3 保存原文供 `sqlite3Reprepare()`（:904）自动重编。step 侧的重试闭环：`sqlite3_step` 外层（vdbeapi.c:988-1010）捕获 SQLITE_SCHEMA → reprepare → reset → 重跑，上限 `SQLITE_MAX_SCHEMA_RETRY=50`（vdbeInt.h:26）。prepare 期也有自己的重试环（:875-884，ERROR 至多 25 次；SCHEMA 只允许一次 ResetOneSchema 后重试——防 schema 抖动活锁）。

**why SQLITE_SCHEMA 必须重编**：代码生成与 schema 快照绑定（表/列 root page 硬编码进 VDBE 程序），另一连接 ALTER/DROP 后 cookie 变化，旧程序继续跑会读写错误页。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `openDatabase` in main.c:3385 | 连接初始化 | 七步装配；**不读 schema**（:3667 注释——延迟到首次访问） |
| `sqlite3Prepare` in prepare.c:700 | 编译主体 | prepare→exec→prepare 递归由 init.busy 门闩防死循环 |
| `sqlite3InitCallback` in prepare.c:96 | schema 行回调 | "CR 前缀"安全不变量（:108-115） |
| `sqlite3LoadExtension` in loadext.c:561 | 加载动态库 | 入口点协商 + 跳板表交接 |
| `createModule` in vtab.c:87 | vtab 注册 | 重复注册替换旧模块并引用计数回收 |
| `sqlite3CreateFunc` in main.c:1963 | 函数注册 | 覆盖时若有活跃 VM 直接拒绝 SQLITE_BUSY |
| `sqlite3Pragma` in pragma.c:425 | PRAGMA 分发 | VFS 优先 → 查表 → 巨型 switch |

</details>

## 核心实现

### loadext：跳板表防符号冲突

`sqlite3Apis`（loadext.c:133-539）是 250+ 项的函数指针表。加载成功后 `xInit(db, &zErrmsg, &sqlite3Apis)` 把指针交给扩展。**why thunk**：动态库若直接链接 `sqlite3_xxx` 符号，会命中宿主进程内另一份静态链接的 SQLite——产生"两个 db 实例"的状态分裂。扩展改用 `sqlite3ext.h` 的宏：`SQLITE_EXTENSION_INIT1`（sqlite3ext.h:733）定义 `sqlite3_api` 指针并把所有 `sqlite3_foo(...)` 调用重定义为 `sqlite3_api->foo(...)`；入口里 `SQLITE_EXTENSION_INIT2(pApi)` 接上。

**表只追加不重排**（:123-126 注释）：新 API 只能加结构尾部保证旧扩展二进制兼容；被编译裁剪的 API 以 NULL 填槽，扩展调用前须判空。表内条目按版本分段注释，3.54 末尾新增 `sqlite3_incomplete`/`sqlite3_result_str`。

**安全闸门**（:592-597，Ticket #1863 注释）：`SQLITE_LoadExtension` flag 默认关闭——面临 SQL 注入时 `SELECT load_extension(...)` 等于远程代码执行，C API 与 SQL 函数双开关分离。入口点协商（:606-676）：`zProc` → 默认 `sqlite3_extension_init` → 按文件名合成（`libExample5.4.3.so` → `sqlite3_example5_init`）。

### vtab：xBestIndex 协商协议

`sqlite3_module`（sqlite.h.in:7730）：version 1 核心 20 个方法（xCreate/xConnect 建连、**xBestIndex 计划协商**、游标四件套 xOpen/xFilter/xNext/xEof、xColumn/xRowid、写侧 xUpdate、事务侧五件套、xFindFunction/xRename）；v2 加 savepoint、v3 加 xShadowName、v4 加 xIntegrity——**iVersion 版本化尾部追加**与跳板表同一设计哲学。

协商发生在 where.c 的 `vtabBestIndex()`（where.c:1672）。输入 `sqlite3_index_info`：`aConstraint[]`（WHERE 中 column OP expr 的约束，op 用 `SQLITE_INDEX_CONSTRAINT_*` 编码）+ `aOrderBy[]`；输出由模块填：`aConstraintUsage[].argvIndex`（该约束值作为 xFilter 第几个参数）、`.omit`（SQLite 可跳过本地复核）、`idxNum/idxStr`（模块自定义计划 token，原样传回 xFilter）、`orderByConsumed`、`estimatedCost/estimatedRows`。**初始代价 `SQLITE_BIG_DBL/2`**（where.c:4403）——不填就是"巨贵"，与 btree 全表扫描同量纲比较。`SQLITE_CONSTRAINT` 返回值表示该约束组合不可行（:4412 直接丢弃该计划分支）。

**eponymous 表**（vtab.c:1261）：`xCreate==0` 或 `xCreate==xConnect` 的模块自动获得无需 CREATE 的 `pMod->pEpoTab`——json_each、generate_series、pragma_vtab 都走这条路。`xConnect` 内调 `sqlite3_declare_vtab()`（:805）声明列 schema——用一个只接受 CREATE TABLE 关键字的受限 parser 重放文本。

**事务参与**：真正写操作首次发生时 VDBE 才调 `sqlite3VtabBegin()`（vtab.c:1046，vdbe.c:8476）登记进 `aVTrans`，提交/回滚统一调 xSync/xCommit/xRollback。

### func.c：内建与用户函数地位完全平等

`sqlite3RegisterBuiltinFunctions()`（func.c:3311）用宏表 `aBuiltinFunc[]`（:3322）声明：`FUNCTION/AGGREGATE/WAGGREGATE/INLINE_FUNC/MFUNCTION` 各形态，末尾聚合调 date/json/window 的注册。**why 全局表**：FuncDef 进程级共享，每连接只在查不到时才 clone 到 `db->aFunc`——零连接开销、多连接共享只读结构。数组注释（:3316-3327）："最常用的函数放最后"是哈希桶内查找顺序优化。VDBE 的 `OP_Function/OP_AggStep` 无差别调 `p->xSFunc`。

**函数覆盖的防护**（main.c:2042）：覆盖已有函数时若有活跃 VM 直接拒绝——函数指针被换掉后旧 VDBE 程序里内联的函数行为会静默改变，宁可作废重编（`sqlite3ExpirePreparedStatements`）——与 SQLITE_SCHEMA 同属"失效重编"哲学。

### PRAGMA：VFS 优先 + 查表分发

`sqlite3Pragma()`（pragma.c:425）流程：取 Vdbe + `RunOnlyOnce`（PRAGMA 不可 reset 复用）→ 授权检查 → **`sqlite3_file_control(SQLITE_FCNTL_PRAGMA)` 先发 VFS**（:495，返回 OK 即处理完毕）——自定义 VFS 能拦截任意 pragma → `pragmaLocate()`（:311）在 `aPragmaNames[]` 二分查找（**未知 pragma 静默忽略**，兼容旧应用）→ 巨型 switch 分发两大流派：读型用 `VdbeOpList` 静态 opcode 模板生成微程序（如 DEFAULT_CACHE_SIZE 的 9 条指令，:555）；写型 `OP_SetCookie` 改 btree 元数据或即时改 `db->flags/btree/pager` 结构。

彩蛋：`PRAGMA function_list/pragma_list` 本身用**虚拟表实现**（pragmaVtabConnect，:2814-3092）——PRAGMA 用 vtab 反噬自身。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 跳板表 | sqlite3Apis + sqlite3_module iVersion + PragmaName 表 | 结构体即 ABI：只追加不重排 |
| 回调注入 | main.c 的 busy/auth/progress/trace/commit/wal setter | 策略与机制分离；授权是"编译期查询，运行期零开销" |
| prepare/step/finalize 三段式 | 全部公开 API | 编译期代价与 schema 绑定，执行期纯解释 |
| mutex 壳的同构包装 | 每个公开 API：防御→enter mutex→内部实现→ApiExit→leave | 一处模式全库复用 |
| 惰性初始化级联 | 全局 once → 连接 → schema → 模块 xConnect | 首次访问才付出代价 |

## 模块间交互

prepare 是总枢纽：串起 tokenize→parse→resolve→build/select/where→vdbeaux。schema 自举期间 prepare→exec（legacy.c）→prepare 递归，由 `db->init.busy` 门闩防死循环（prepare.c:230-236）。vtab 横切 where/vdbe（计划协商 + OP_VFilter 生成）。backup.c 走 pager 层直接页拷贝绕过 SQL 层；memdb.c 的 `sqlite3_deserialize`（:841）把内存镜像装成 Btree。

## 扩展方式

**注册自定义聚合函数**：写 step/final，step 里 `sqlite3_aggregate_context(context, sizeof(MyCtx))` 拿累积态 → `sqlite3_create_function(db, "myagg", 1, SQLITE_UTF8|SQLITE_DETERMINISTIC, NULL, NULL, xStep, xFinal, NULL)`（注意成对校验 main.c:1974）；窗口版本补 xValue/xInverse。打包成动态库：入口 `sqlite3_extension_init` + 顶部 `SQLITE_EXTENSION_INIT1` + 入口首行 `INIT2(pApi)`。

**创建 eponymous 虚拟表**（最小路径）：填 `sqlite3_module`（`xCreate=0`、`xConnect=myConnect` 即可 eponymous，vtab.c:1264 判定；`estimatedCost` 必填）→ `sqlite3_create_module()` → `myConnect` 内 `sqlite3_declare_vtab(db, "CREATE TABLE x(a,b)")`。仓库内两个最小范本：pragma.c:3092 的 `sqlite3PragmaVtabRegister` 与 json.c:5794 的 `jsonEachModule`。

**向跳板表加 API 的完整动作**（3.54 的 `sqlite3_result_str` 示范）：sqlite.h.in 加声明 → sqlite3ext.h 结构尾加槽 → loadext.c 表尾加函数指针——三处同序追加即完成一次 ABI 扩展。
