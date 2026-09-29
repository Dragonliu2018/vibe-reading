---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "Overview"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "嵌入式数据库", "OLTP"]
description: "SQLite 3.54.0 master 分支 2026-08 快照源码解读概览：分层架构、12 大模块地图、编译-执行-存储三段链路与状态机全景"
readingTime: "50 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** master-2026-08（VERSION 文件为 3.54.0）· **解读基线** commit [`a7969a001d`](https://github.com/sqlite/sqlite/commit/a7969a001d790c738971d9c9d79cad5438fb731f)（2026-08-21，master 分支快照，SQLite 用 Fossil 管理版本，Git 仓库为官方镜像）· **协议** Public Domain · **语言** C（C89/C99 兼容）· **代码量** src/ 核心源码 ~17.8 万行（不含 test 脚本与 tcl 接口），含 CLI 与扩展 ~22 万行 · **仓库** [GitHub 镜像](https://github.com/sqlite/sqlite)（正源 [sqlite.org/src](https://sqlite.org/src)）

---

## 总览

### 项目简介

SQLite 是世界上部署量最大的数据库引擎——自包含、无服务器、零配置、单文件。它不是一个独立运行的数据库服务进程，而是一个**直接链接进宿主程序的 C 库**：整个数据库（表、索引、数据）存放在一个普通的磁盘文件里，读写都通过进程内的函数调用完成，不需要任何跨进程通信。手机、浏览器、飞机娱乐系统、每一个主流操作系统里都有它的身影。

它解决的问题是"**给应用程序一个零运维的本地 SQL 存储**"：没有服务端进程要安装、配置、监控、重启；没有网络往返的开销；数据就是一个文件，备份就是复制文件。核心价值在于把 SQL 的表达能力和嵌入式软件的资源约束（几百 KB 内存的设备也能跑）同时满足。

**项目当前边界**：SQLite 是单连接内嵌、单写者并发模型的 OLTP 引擎——负责单机单文件的事务性 SQL 存储；不负责多机分布式、不内置服务器网络协议（要外接代理）、也不追求重度分析型负载（无向量化执行、无列式存储、优化器走轻量路线）。超过 ~100 GB 或高并发写多路扩展的场景不是它的主场。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| SQL 编译（分词/语法/语义） | `src/tokenize.c`、`src/parse.y`、`src/resolve.c` | Lemon LALR(1) 生成 parser |
| 字节码虚拟机 | `src/vdbe.c`、`src/vdbeaux.c` | ~200 个 opcode 的寄存器机 |
| 查询优化器 | `src/where.c`、`src/whereexpr.c`、`src/select.c` | beam search 近似 DP + LogEst 对数代价 |
| B-Tree 存储 | `src/btree.c`、`src/btreeInt.h` | 单文件多 B-Tree，页级 MVCC 无（靠 journal） |
| 事务与页缓存 | `src/pager.c`、`src/pcache.c`、`src/pcache1.c` | rollback journal 六模式 + savepoint |
| WAL 模式 | `src/wal.c` | append-only 日志 + shm 哈希索引 + checkpoint |
| OS 抽象 | `src/os_unix.c`、`src/os_win.c`、`src/os_kv.c` | VFS 双对象 + syscall 注入 |
| 扩展机制 | `src/loadext.c`、`src/vtab.c`、`src/func.c` | 动态库/虚拟表/自定义函数三套 |
| CLI shell | `src/shell.c.in` + `tool/mkshellc.tcl` | 模板拼接生成单文件 shell.c |
| 全文检索 FTS5 | `ext/fts5/` | 影子表倒排索引 + bm25 |
| 空间索引 R-Tree | `ext/rtree/` | r-tree/r\*-tree + geopoly |
| 变更复制 session | `ext/session/` | changeset 捕获/apply/rebase |
| 批量更新 RBU | `ext/rbu/` | \*-oal 三阶段可续传 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C 编译器（C89 起） | 核心 | 唯一语言，无任何运行时库强依赖 |
| Tcl 8.6+ | 可选 | 构建期代码生成（lemon/opcode/pragma/shell 全用 Tcl 脚本拼装）与测试驱动 |
| POSIX / Win32 | 核心 | VFS 两套平台实现，编译期二选一 |
| zlib | 可选 | zipfile/sqlar 归档扩展 |
| ICU | 可选 | 国际化 collation |

值得注意的"负依赖"：SQLite **自实现** printf（`src/printf.c`，带 `%q`/`%Q` SQL 转义）、自实现随机数（ChaCha20）、不依赖 libc 的 locale——一切为了可嵌入与可预期。

### 版本历史

SQLite 3.x 文件格式自 3.3（2006）起保持兼容——今天的新版仍能读 19 年前的库文件。3.7.0（2010）引入 WAL；3.8.11+ 引入 STAT4；3.24（2018）UPSERT；3.25 窗口函数；3.31 生成列；3.34 RETURNING；3.35 (2021) `->`/`->>` JSON 运算符与 materialized CTE 大改；3.45（2024）JSONB 二进制内部格式。本次解读的 3.54.0 处于主线常规演进位置。

---

## 快速上手

从源码到跑起来（Unix）：

```bash title="最简构建"
apt install gcc make tcl-dev     # tcl-dev 只有跑测试才需要
tar xzf sqlite.tar.gz && mkdir bld && cd bld
../sqlite/configure              # autosetup（非 GNU autoconf）
make sqlite3                     # CLI shell
./sqlite3                        # 进入 REPL
```

端到端验证：

```sql title="sqlite3 REPL"
sqlite> CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT);
sqlite> INSERT INTO t VALUES(1,'hello'),(2,'world');
sqlite> SELECT b FROM t WHERE a=2;
world
sqlite> EXPLAIN SELECT b FROM t WHERE a=2;
addr  opcode         p1  p2  p3
0     Init           0   0   0
1     Transaction    0   0   1
2     OpenRead       0   2   0
3     Integer        2   1   0
4     SeekGE         1   6   1
5     Column         0   1   2
6     ResultRow      2   1   0
7     Halt           0   0   0
```

`EXPLAIN` 打印的就是 VDBE 字节码——本系列后续所有模块文章都在解释这张表是怎么生成、怎么执行的。`make sqlite3.c` 生成 amalgamation（单文件分发形态，编译后比分离编译快约 5%，README.md:288）。

---

## 架构设计解析

### 系统架构

SQLite 的整体设计思想是**"编译器 + 栈式虚拟机 + 分层存储"**：每条 SQL 在 prepare 阶段被完整编译成字节码程序，执行阶段由虚拟机解释，虚拟机再逐层调用 B-Tree → Pager → VFS。分层的关键约束是**每一层只依赖下一层的同步函数接口**，层与层之间没有回调地狱，这使得整个引擎可以做成单线程、无全局锁的纯过程式 C 代码（并发控制交给文件锁/WAL，交给用户自己开多连接）。

![SQLite 分层架构](/vibe-reading/images/articles/sqlite-internals/architecture.svg)

八层的职责与依赖方向自上而下：

| 架构层 | 包含目录/文件 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 接口层 | `main.c`、`prepare.c`、`vdbeapi.c`、`loadext.c`、`vtab.c`、`func.c` | 定义进程外可见的 ABI：连接生命周期、prepare/step 协议、三套扩展点 |
| SQL 编译器 | `tokenize.c`、`parse.y`、`resolve.c`、`expr.c`、`select.c`、`where*.c`、`build.c` 等 | 把 SQL 文本翻译成字节码；语法/语义分析与计划选择都在这层 |
| 虚拟机 VDBE | `vdbe.c`、`vdbeaux.c`、`vdbemem.c`、`vdbesort.c` | 唯一的执行引擎；也是 prepared statement 的载体 |
| B-Tree | `btree.c`、`btreeInt.h`、`btmutex.c` | 单文件内的多棵 B-Tree 布局与游标协议 |
| Pager | `pager.c`、`pcache.c`、`pcache1.c`、`memjournal.c` | 事务边界：journal、锁、页缓存——ACID 的全部秘密 |
| WAL | `wal.c` | 与 rollback journal 并列的另一种事务后端 |
| VFS | `os*.c`、`mutex*.c` | 可替换的 OS 抽象，29 项 syscall 都可注入 |
| 基础设施 | `malloc.c`、`mem*.c`、`util.c`、`hash.c`、`printf.c` | 内存分配、错误消息、公共数据结构，被所有层共享 |

这样分层解决的三个问题：**(a) 可移植**——换一个 OS 只重写 VFS 层；**(b) 可裁剪**——`SQLITE_OMIT_*` 编译宏能按层砍功能，裁到几十 KB；**(c) 可替换**——内存/互斥/页缓存三张方法表运行时注入，嵌入设备可整体换掉堆分配器。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 生成器（Parser Generator） | `tool/lemon.c` 从 `src/parse.y` 生成 `parse.c` | `%destructor` 保证语法错误路径零内存泄漏 |
| 方法表注入（Strategy） | `sqlite3_mem_methods`/`sqlite3_mutex_methods`/`sqlite3_pcache_methods2`，经 `sqlite3_config()` 注入 | 嵌入式设备整体替换分配器/锁而不用改引擎 |
| 跳板表（Thunk） | `sqlite3Apis`（loadext.c:133）+ `sqlite3_module` 的 iVersion 尾部追加 | 结构体即 ABI：只追加不重排，动态扩展二进制兼容 |
| Walker/Visitor | `walker.c` 的 `sqlite3WalkExpr()` + 三值返回协议 | 名称解析/常量传播/DDL 钉死等所有树遍历共用一个引擎 |
| 状态机 | `Pager.eState` 七态（pager.c:644）、`Vdbe.eVdbeState` 四态、文件锁五级 | 把"哪些变量何时可信"变成 assert 可验证的不变式 |
| 世代计数器缓存失效 | `Vdbe.cacheCtr` + `VdbeCursor.cacheStatus` | O(1) 失效整行解码缓存，替代逐项清除 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `sqlite3` | 一个数据库连接 | open 到 close | 持有 `aDb[]`（main/temp/attach）、lookaside、回调 |
| `sqlite3_stmt`（= `Vdbe`） | 一条 prepared 语句的 VM | prepare 到 finalize | 持有 aOp/aMem/apCsr；vdbeInt.h:455 明言二者同体 |
| `VdbeCursor` | 表/索引/排序器/虚拟表游标的统一包装 | 一条语句内 | union 指向 BtCursor 或 VdbeSorter 或 vtab cursor |
| `Mem`（= `sqlite3_value`） | 动态类型值单元，寄存器堆的细胞 | 一条语句内 | flags 位编码类型与所有权 |
| `BtShared` / `Btree` | 数据库文件级共享体 / 连接级句柄 | 文件打开期间 | shared-cache 时一个 BtShared 多个 Btree |
| `Pager` / `PgHdr` | 事务管理器 / 缓存中的一页 | 连接期间 | Pager 持有 PCache，PgHdr 的 extra 区放 MemPage |
| `Wal` | WAL 连接对象 | journal_mode=WAL 时 | 持有 wal-index 快照 `hdr.mxFrame` |
| `Expr` / `Select` / `SrcList` | 语法树节点 | prepare 期间（schema 中长期驻留一份副本） | Walker 遍历的目标 |
| `Schema` / `Table` / `Index` | 内存 schema 元数据 | 连接期间，cookie 变更即重建 | 从 sqlite_schema 根页 1 自举加载 |

#### 核心抽象（扩展点的契约）

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `sqlite3_vfs` + `sqlite3_file`/`sqlite3_io_methods` | `sqlite.h.in` | unix/win/kvvfs/memdb/appendvfs/cksumvfs | `sqlite3_vfs_register()` |
| `sqlite3_module`（虚拟表协议） | `sqlite.h.in:7730` | FTS5、rtree、csv、series、json_each 等 | `sqlite3_create_module()` |
| `sqlite3_mem_methods` | `sqlite.h.in:1814` | mem1/mem2/mem3/mem5/自定义 | `sqlite3_config(SQLITE_CONFIG_MALLOC)` |
| `sqlite3_pcache_methods2` | `sqlite.h.in` | pcache1/自定义 | `sqlite3_config(SQLITE_CONFIG_PAGECACHE)` |
| `FuncDef`（函数） | `sqliteInt.h` | 内建函数表 + 用户注册 | `sqlite3_create_function()` |
| 回调族（busy/auth/progress/trace/wal/preupdate） | `main.c` 各注册函数 | 宿主程序 | 逐个 setter |

#### 对象关系

```
sqlite3 ─ aDb[0..n] ─ Btree ─ BtShared ─ BtCursor ←── VdbeCursor ←── Vdbe(=sqlite3_stmt)
                │                   │                                     │ aOp[] aMem[] apCsr[]
                │                   └─ Pager ─ PCache ─ PgHdr(extra=MemPage)  │
                │                        └─ Wal ─ shm wal-index              ├─ OP_Function → FuncDef
                ├─ aFunc(FuncDef 哈希)                                        └─ OP_VFilter → sqlite3_module
                ├─ aModule(sqlite3_module 哈希)
                └─ lookaside 池 ── Expr/Token 快速分配
```

---

## 代码目录

```shell
sqlite/
├── src/                 # 核心源码（~178k 行，见下方模块地图）
│   ├── tokenize.c       #   分词器（899 行）
│   ├── parse.y          #   Lemon 语法（2163 行，构建期生成 parse.c）
│   ├── vdbe.c           #   虚拟机主文件（9574 行）
│   ├── btree.c          #   B-Tree（11655 行，全库最大单文件）
│   ├── pager.c          #   事务管理（7896 行）
│   ├── wal.c            #   WAL（4649 行）
│   └── test*.c          #   测试钩子 C 模块（不属于核心）
├── ext/                 # 官方扩展（~93k 行）
│   ├── fts5/            #   全文检索（28k 行）
│   ├── rtree/           #   空间索引（6.8k 行）
│   ├── session/         #   changeset 复制（11.7k 行）
│   ├── rbu/             #   可续传批量更新（6k 行）
│   ├── misc/            #   56 个单文件小扩展（35k 行）
│   └── expert/ qrf/ intck/ recover/ jni/ wasm/ icu/
├── tool/                # 构建期代码生成器（Tcl 脚本 + lemon.c）
├── test/                # Tcl 测试脚本（1194 个 .test）
├── mptest/              # 多进程崩溃测试
├── doc/                 # 内部文档（lemon.html、wal-lock.md 等）
├── main.mk / Makefile.in / configure   # autosetup 构建系统
├── VERSION              # 3.54.0
└── manifest.uuid        # Fossil check-in 哈希（生成 SQLITE_SOURCE_ID）
```

**构建期生成的代码**是这个仓库的显著特色（README.md:226 起完整列出）：`parse.c`（lemon 从 parse.y 生成）、`opcodes.h/c`（mkopcodeh.tcl 扫描 vdbe.c 的 `case OP_` 注释生成——**代码排版即 ABI**）、`keywordhash.h`（关键字哈希）、`pragma.h`（mkpragmatab.tcl）、`sqlite3.h`（mksqlite3h.tcl 模板展开）、`shell.c`（mkshellc.tcl 拼接 28 个扩展源文件）。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/sqlite-internals/module-dependencies.svg)

| 模块 | 路径 | 代码量 | 为什么独立 |
| --- | --- | --- | --- |
| [分词与语法分析](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/01-tokenizer-parser) | `tokenize.c` + `parse.y` + `tool/lemon.c` | ~3k + 6k | SQL 进入引擎的唯一入口；Lemon 是自研生成器，自带 %destructor 错误路径内存安全 |
| [表达式与名称解析](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/02-expr-resolve) | `expr.c`、`resolve.c`、`walker.c` | ~10k | Expr 是全库最核心数据结构（schema/优化/代码生成共用）；解析是独立 pass |
| [SELECT 与查询计划](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/03-select-planner) | `select.c`、`where*.c`、`window.c` | ~23k | 优化器是编译器里最大的独立子系统；LogEst 代价模型自成体系 |
| [DDL 与写语句生成](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/04-ddl-dml) | `build.c`、`insert.c`、`alter.c` 等 | ~17k | schema 持久化（语句原文存 sqlite_schema）+ 全部写路径代码生成 |
| [VDBE 虚拟机](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/05-vdbe) | `vdbe*.c` | ~26k | 唯一执行引擎；prepare/step 两段的枢纽；opcode 是全库中枢 IR |
| [B-Tree 存储](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/06-btree) | `btree.c`、`btreeInt.h` | ~13k | 页面格式、游标协议、balance 家族——磁盘格式的唯一权威 |
| [Pager 与事务](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/07-pager) | `pager.c`、`pcache*.c` | ~13k | ACID 正确性全部在此；七态状态机 + 六种 journal 模式 |
| [WAL](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/08-wal) | `wal.c` | ~4.6k | 与 rollback journal 并列的第二种事务后端；读写并发的来源 |
| [VFS OS 抽象层](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/09-vfs) | `os*.c`、`mutex*.c` | ~16k | 可移植性的全部边界；五级文件锁与 shm 原语的平台差异封装 |
| [内存与公共设施](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/10-memory-infra) | `malloc.c`、`mem*.c`、`util.c` 等 | ~11.5k | 全库最高扇入（sqlite3_free 321 edges）；四种可换分配器 |
| [API 层与扩展机制](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/11-api-extensions) | `main.c`、`prepare.c`、`loadext.c`、`vtab.c`、`func.c`、`pragma.c` | ~15k | 对外 ABI 的全部定义；三套扩展协议；PRAGMA 分发 |
| [CLI shell 与官方扩展](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/12-shell-ext) | `shell.c.in`、`ext/` | ~93k | 模板拼接哲学；FTS5/rtree/session/rbu 四大扩展自成模块 |

耦合点提示：`expr.c` 后半部本身就是表达式代码生成器（直接发 opcode），与 VDBE 是"生产者-消费者"关系而非干净分层；`pragma.c` 横切 btree/pager/global 配置；扩展（ext/）全部通过 API 层的两套协议（loadext/vtab）与 core 解耦，唯一例外是 shell 静态拼入。

---

## 运行时行为

### 启动流程

`sqlite3_open_v2()` → `openDatabase()`（main.c:3385）七步：`sqlite3_initialize()`（全局一次性：mutex 层、`sqlite3RegisterBuiltinFunctions()` 灌入全局函数哈希、`sqlite3OsInit()` 注册默认 VFS）→ 线程模式裁定并分配 db mutex → flags 清洗 → `sqlite3` 结构装配（`nDb=2`、`autoCommit=1`、硬限制拷贝）→ 内建 collation → **URI 解析 + `sqlite3BtreeOpen()`——此处刻意不读 schema**（main.c:3667 注释：schema 加载延迟到首次访问）→ 注册 per-connection 函数、自动加载扩展、lookaside 池、`sqlite3_wal_autocheckpoint(db, 1000)`。

延迟加载的闭环：首次 prepare 时 `sqlite3ReadSchema` → `sqlite3InitOne`（prepare.c:210）先手工伪造 sqlite_schema 的 CREATE 语句自举，再 `sqlite3_exec("SELECT * FROM sqlite_schema", sqlite3InitCallback)` 逐行把 CREATE 原文**重新送回 parser**（`db->init.busy=1`，只建内存结构不生成代码）。

### 核心运行流程

#### 主链路 1：一条 SELECT 的编译与执行

![SELECT 端到端数据流](/vibe-reading/images/articles/sqlite-internals/data-flow.svg)

```text title="SELECT name FROM users WHERE id=42（rowid 精确查找）"
prepare: sqlite3_prepare_v2 → sqlite3Prepare → sqlite3RunParser
  → sqlite3GetToken(逐 token) → Lemon 归约 → Select/Expr 树
  → sqlite3SelectPrep(展开+名称解析: Expr.iTable/iColumn)
  → sqlite3WhereBegin(whereShortCut 快路径: rowid 等值直接出计划)
  → sqlite3VdbeAddOp*(Init/Transaction/OpenRead/Integer/SeekGE/Column/ResultRow/Halt)
  → sqlite3VdbeMakeReady(反填跳转+分配寄存器堆)
step:   sqlite3_step → sqlite3VdbeExec 主循环 switch
  → OP_Transaction → BtreeBeginTrans → PagerSharedLock → (WAL) walTryBeginRead 拿快照
  → OP_SeekGE → sqlite3BtreeTableMoveto 页内二分
  → OP_Column → PayloadFetch(页内零拷贝指针) → serial type 解码 → Mem 寄存器
  → OP_ResultRow → pResultRow 锚定 → 返回 SQLITE_ROW
取数:    sqlite3_column_text → columnMem → Mem.z（就是寄存器里的指针）
```

业务↔代码↔数据流映射：SQL 文本（用户）→ Token→树→opcode（编译器三模块）→ Mem 值流（VDBE）→ cell 字节（B-Tree）→ 4KiB 页（Pager）→ pread（VFS）。

#### 主链路 2：一条 UPDATE 的写事务（rollback journal）

```text title="UPDATE 的 commit 顺序"
OP_Transaction → BtreeBeginTrans(写) → PagerBegin(RESERVED 锁)
改页: sqlite3PagerWrite → pager_write → 懒开 journal
     → 原页内容追加进 journal（pgno+pageSize+cksum）→ 置 NEED_SYNC
OP_Halt → VdbeHalt → BtreeCommit
  → CommitPhaseOne: 更新 change-counter → syncJournal(fsync journal!)
     → 脏页按 pgno 排序写 db 文件 → fsync db
  → CommitPhaseTwo: journal finalize(DELETE/TRUNCATE/PERSIST) → 解锁回 READER
```

**journal 先于数据库 fsync** 是 ACID 持久性的全部：断电后任何半写状态都能被 hot journal 回放还原（pager.c:37-99 的不变式 (5)-(7)）。

#### 主链路 3：WAL 写事务与 checkpoint

```text title="WAL 模式的提交"
写:    sqlite3WalFrames → walWriteOneFrame 追加帧(salt+累计校验和)
     → 同事务重复页就地覆盖旧帧 → commit 帧带 nTruncate≠0
     → walIndexAppend 更新 shm 哈希 → walIndexWriteHdr 发布新 mxFrame
读:    walTryBeginRead → aReadMark[i] 快照 → walFindFrame 查哈希定位帧
checkpoint: 页号升序回填 WAL→db → nBackfill 推进 → 1000 页自动触发(PASSIVE)
```

#### 状态流

![运行时状态流](/vibe-reading/images/articles/sqlite-internals/state-flow.svg)

三个关键状态机：**Pager 七态**（OPEN→READER→WRITER_LOCKED→CACHEMOD→DBMOD→FINISHED，IO 错误进 ERROR 态拒绝继续服务——pager.c:280 注释解释了为什么"宁可不服务也不能把不一致缓存当真"）；**文件锁五级**（NO→SHARED→RESERVED→PENDING→EXCLUSIVE，PENDING 是防写者饿死的闸门锁）；**VDBE 语句四态**（INIT→READY→RUN→HALT，reset 后回 READY 复用程序体）。

### 典型修改场景

#### 场景 1：新增一个 SQL 关键字

改 `tool/mkkeywordhash.c` 的 `aKeyword[]` 表 → 改 `src/parse.y` 加 `%token` + 规则（允许作标识符还要进 `%fallback ID` 列表）→ 下游构造函数（`build.c`/`select.c`）→ 重新构建（lemon 有冲突即构建失败，main.mk:1465）。

#### 场景 2：新增一个 VDBE opcode

改 `src/vdbe.c`：写 `/* Opcode: ... */` 文档注释块 + `case OP_NewName`（注释格式是 mkopcodeh.tcl 的输入，**排版即 ABI**）→ 需要时在 `vdbeaux.c` 的 `resolveP2Values()` 和 `mkopcodeh.tcl` 同步登记 → 代码生成侧用 `sqlite3VdbeAddOp3()` emit。opcode 枚举不用手写，工具链自动生成。

#### 场景 3：写一个最简虚拟表扩展

抄 `ext/misc/series.c`（README 指定的模板）：单文件 + `sqlite3_module` 方法表 + xBestIndex 里给 `estimatedCost`（默认 `SQLITE_BIG_DBL/2` 会被当不可用计划）→ `sqlite3_create_module()` 注册 → 文件名即入口点（`sqlite3_myvtab_init`，**文件名不能带数字**——shathree.c 的存在就是因为这个）。

---

## 测试体系

```text
test/                # 1194 个 .test（Tcl 脚本，跑在增强 Tcl 解释器 testfixture 上）
├── *.test           # 单元+功能测试（每个子系统数十个文件）
├── malloc*.test     # OOM 注入测试（每个分配失败路径都要验证恢复）
├── corrupt*.test    # 损坏数据库测试
├── fts*.test wal*.test …
├── fuzz*.test / dbfuzz2.c   # 模糊测试
└── swift.test       # TH3 之外的补充
mptest/              # 多进程崩溃一致性（crash01/02 等）
tool/testrunner.tcl  # 统一测试驱动（doc/testrunner.md）
```

| 代码层 | 测试类型 |
| --- | --- |
| 全部核心代码 | TH3（闭源 100% 分支覆盖测试套件，SQLite 商业测试资产）+ `test/*.test` |
| VFS/锁/journal | mptest 崩溃测试 + `test_journal.c` 故障注入 VFS |
| OOM 路径 | `src/fault.c` 的 `sqlite3FaultSim()` 35 处撒点 + mallocfailure 系列 .test |
| syscall 边界 | `src/test_syscall.c` 运行时替换 29 项 syscall |

SQLite 的测试哲学值得注意：`vdbe.c:153` 的 `VdbeBranchTaken`/`testcase()` 约定让**分支覆盖率可被工具校验**；TH3 宣称 MC/DC 覆盖。想理解某个子系统，优先读同名 .test 文件——它们是可执行的规格说明。

---

## 阅读源码推荐路线

- **第一遍：主流程（编译→执行）**
  `src/tokenize.c` 的 `sqlite3RunParser()`（:600）主循环 → `src/prepare.c` 的 `sqlite3Prepare()`（:700）→ `src/select.c` 的 `sqlite3Select()` 头部 outline（:7617 的 tag-select-0100）→ `src/vdbe.c` 的 `sqlite3VdbeExec()` 主循环（:902 起，挑 `OP_Column`（:3035）、`OP_Next`（:6663）、`OP_ResultRow`（:1806）读）
- **第二遍：核心数据结构**
  `src/vdbeInt.h` 全文（Vdbe/Mem/VdbeCursor，764 行）→ `src/sqliteInt.h` 的 `Expr`（:3069）与 `Parse`（:3919）→ `src/whereInt.h` 全文（优化器四层对象模型）
- **第三遍：存储与事务**
  `src/btreeInt.h` 头部 1-215 行（页面格式官方文档）→ `src/btree.c` 的 `balance_nonroot()`（:8277）→ `src/pager.c` 头部 134-357 行（状态机不变式）→ `src/wal.c` 头部 16-98 行（WAL 文件格式）
- **第四遍：扩展机制与选读模块**
  `src/loadext.c` 的 `sqlite3Apis` 跳板表（:133）→ `src/vtab.c` 头部协议注释 → `ext/misc/series.c`（最简 vtab 模板）→ 按兴趣进 FTS5（`fts5_index.c:20-232` 教科书级格式注释）或 RBU（`sqlite3rbu.c:20-80` 的 \*-oal 机制）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| amalgamation | 把全部源码拼成单个 `sqlite3.c` 的分发形态，编译快 ~5% |
| VDBE | Virtual Database Engine，SQLite 的字节码虚拟机，`sqlite3_stmt` 的本体 |
| record | B-Tree cell 里的行编码：varint 头 + serial type 串 + 数据 |
| serial type | record 头里每列的类型码（0=NULL、1-6=变长整数、7=float、≥12=BLOB/TEXT） |
| rowid | 表 B-Tree 的整型主键；`INTEGER PRIMARY KEY` 列是它的别名 |
| wal-index | WAL 的共享内存哈希索引（-shm 文件），可随时从 WAL 重建 |
| hot journal | 崩溃后遗留的 rollback journal，被下一个拿锁者检测并回放 |
| eponymous virtual table | 不需要 CREATE 就能 SELECT 的虚拟表（如 json_each） |
| LogEst | log2(x)×10 的整数代价表示，乘法变加法 |
| ptrmap | auto-vacuum 库的父指针映射页，页搬迁的寻址索引 |

### 参考资料

- [SQLite 官方文档](https://sqlite.org/docs.html)——架构、文件格式、VDBE opcode 说明均以官网为准
- 仓库内文档：`doc/lemon.html`（生成器手册）、`doc/wal-lock.md`、`doc/pager-invariants.txt`、`doc/vdbesort-memory.md`、`doc/jsonb.md`
- `src/btreeInt.h:1-215` 与 `src/wal.c:16-98`——源码内嵌的权威格式文档
- [The SQLite Database File Format](https://www.sqlite.org/fileformat2.html)
