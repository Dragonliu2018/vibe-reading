---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "CLI shell 与官方扩展"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "FTS5", "R-Tree"]
description: "shell.c.in 模板拼接哲学（mkshellc.tcl 拼入 28 个扩展）、FTS5 五张影子表与 segment merge、R-Tree 约束协商、session/RBU 与 56 个 misc 小扩展"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

CLI（`shell.c.in` 14747 行模板 + `ext/` ~93k 行官方扩展）是 SQLite 的"门面 + 试验场"：所有扩展机制（loadext/vtab/函数注册）在这里以最激进的方式组合——CLI 本身静态拼入了 28 个扩展源文件。ext/ 下的 FTS5/rtree/session/rbu 是四个各自独立的完整子系统。

## 核心实现

### shell.c.in：为什么是模板

`shell.c` 不是手写文件，由 `tool/mkshellc.tcl` 生成（main.mk:2375）：第一遍收集 `** USAGE: .cmd` 注释生成 dot 命令 usage 表；第二遍把 28 条 `INCLUDE <path>` 行（shell.c.in:259-316）替换为对应扩展源文件全文，同时去重 typedef、注释掉 `#include "sqlite3..."`。

**Why amalgamation 分发哲学**：`sqlite-amalgamation.zip` 只带 shell.c + sqlite3.c + sqlite3.h + sqlite3ext.h 四个文件，用户 `gcc shell.c sqlite3.c` 即可编出 CLI——无需源码树、无需 Tcl。所有扩展以 `SQLITE_INTERNAL_LINKAGE static` + `SQLITE_EXTENSION_INIT1` 空转（shell.c.in:266-275）静态拼入单编译单元避免符号冲突。**维护面是多文件（每扩展一个 .c），分发面是单文件**。生成的 shell.c 头部明令禁止直接编辑——改 `.in` 后 `make shell.c`。

条件拼接受宏保护：zlib 才拼 zipfile/sqlar、非 FIDDLE 才拼 fileio/completion、`SQLITE_SHELL_HAVE_RECOVER` 才拼 recover；`SQLITE_SHELL_EXTSRC` 钩子允许第三方注入自己的扩展。Fiddle 变体（:59-66）为 WASM 浏览器版裁剪 I/O。

### meta 命令与 REPL

`do_meta_command()`（:9829）是按首字符分桶 + strncmp 前缀匹配的 if 链（`.q` ≡ `.quit`）。**why 不用函数指针表**：大量 handler 受编译宏条件包裹（`.session`/`.archive`/`.recover`），if 链让条件编译零成本；C89 习惯。帮助文本是 `azHelp[]` 表 + 从注释自动提取的 `aUsage[]`；首字符 `,` 的命令是隐藏命令（`,selftest`）。

REPL 三选一：readline/editline/linenoise，全收敛到 `shell_readline` 宏族；裸退化为 `local_getline`。主循环 `process_input`（~:13295）：行首 `.`/`#` 走 meta 命令，否则累积到 `sqlite3_complete()` 判定完整后交 `runOneSqlLine`。**补全不是硬编码关键字表**——查询 `completion` 虚拟表（ext/misc/completion.c），运行时枚举关键字 + 当前 schema 对象，所以能补表名列名。

**输出格式化**已重构为 QRF（Query Result Formatter，ext/qrf/，2025-10）：`shell_exec` 填 `sqlite3_qrf_spec` 后调 `sqlite3_format_query_result`——23 个内建模式 + 25 个用户自定义模式的全部格式化变成可复用库。

**安全模式**（`.safe`）：默认对未知来源 db 开启，`.nonce` 是唯一白名单后门，`failIfSafeMode` 挡危险命令——2022 年 SQLite 钓鱼攻击（恶意 db 注入 dot 命令）的直接产物。

**静态注册全家桶**（`open_db` :5135-5155）：sha1/shathree/uint/decimal/base64/regexp/ieee754/series/fileio/completion 等——**why 在 open_db 而非 main**：`.open` 换库后新连接也要有这些函数。`.expert` 走 ext/expert（用授权回调截获 SQL 分析索引建议）。

### FTS5：影子表 + 分层 segment merge

FTS5 是 iVersion 4 虚拟表（fts5_main.c:3764），`xShadowName` 返回五张影子表——**core 的 DEFENSIVE 模式靠它阻止用户绕过 vtab 直接写影子表**：

| 影子表 | 内容 |
| --- | --- |
| `%_content` | 原始行（可换 external 表或 contentless） |
| `%_docsize` | 每行各列 token 数——bm25 文档长度来源 |
| `%_data` | **倒排索引本体**：structure record、averages record、全部 segment 页 |
| `%_idx` | doclist index 页的定位表 |
| `%_config` | 版本号等元数据 |

**Why 影子表而非私有文件格式**：倒排索引的事务性、崩溃恢复、备份**免费复用** SQLite 的 b-tree/WAL，FTS5 只需在 vtab 事务回调里 flush 写缓冲。

存储格式（fts5_index.c:20-232 头注释，教科书级）：term 前缀压缩 + doclist（rowid delta + poslist）；大 doclist 跨多页且附带 rowid 索引页（入口即 %_idx 表）——无需整载入内存即可 seek。merge 是分层结构（`Fts5Structure` :407）：写入先进内存 hash，flush 成顶层 segment；某层超阈值触发 `fts5IndexMergeLevel()`（:4785）多路归并（最小堆），incremental merge 允许分段推进不阻塞写事务。bm25（fts5_aux.c:589）经 `xGetAuxdata` 每查询缓存一次，IDF 公式注明来自 Wikipedia 的标准 BM25。

### R-Tree：约束协商的典型样本

r-tree 与 r\*-tree 同文件实现（头注释 :14；`ChooseSubTree` 按 r\* 语义择枝、`RTREE_REINSERT` 重插入策略）。三张影子表（`%_node/%_parent/%_rowid`）存 BLOB 节点——又是"复用 b-tree 事务"模式。`rtreeBestIndex`（:~2057）把每维坐标约束编码为**单字符操作码 + 列号**序列进 idxStr（`RTREE_EQ=0x41`…:356-362）——与 FTS5 的 idxStr 字符串协议同为 xBestIndex 协商的最佳教材。`geopoly.c` 不独立编译而是 `#include` 进 rtree.c 末尾（:4348）——直接复用内部结构避免导出符号。

### session 与 RBU

**session**（11.7k 行）：`sqlite3session_create` 挂 `preupdate_hook` 逐行记录 old/new 镜像，序列化为二进制 changeset；apply 时五类冲突（DATA/NOTFOUND/CONFLICT/FOREIGN_KEY/CONSTRAINT）交 xConflict 回调（OMIT/REPLACE/ABORT）。**rebaser** 是两阶段同步的关键：B 先 apply A 的 changeset 并产生 rebase blob，再用 rebaser 变换 B 自己的 changeset 回传——冲突已被 B 的决策吸收，A 端不再撞车。

**RBU**（Resumable Bulk Update）：大事务随机更新索引叶页会反复换页；RBU 把每个索引的更新**按键排序后线性扫**（CREATE INDEX 同款技巧），并切成可续传子事务——场景就是 OTA 更新到经常重启的手机。最精彩的 \*-oal 三阶段机制（sqlite3rbu.c:20-80 头注释）：(1) 更新写进 `<db>-oal`（**格式同 WAL 但文件名不同**，普通客户端不认这个名字，继续读旧快照完全不感知）；(2) `rbuMoveOalFile()`（:3260）拿 EXCLUSIVE 锁后 rename 成 `-wal`——**一次原子文件名切换，全体读者瞬间看到新库**；(3) 增量 checkpoint，每次 step 只回填一帧，任意时刻可被下一个进程续跑。头注释还自曝 POTENTIAL PROBLEMS——SQLite 源码里少见的坦诚文档风格。

### ext/misc：56 个单文件扩展

原则（README）：一扩展一 .c，头部注释即文档。要者：`csv.c`（CSV vtab）、`fileio.c`（SQL 直接操作文件系统）、`completion.c`（REPL 补全引擎）、`appendvfs.c`（db 追加在任意文件尾部——`.open --append` 的底座）、`zipfile.c/sqlar.c`、`series.c`（**README 明说是新 vtab 的模板**）、`rot13.c`（新 SQL 函数的模板）、`spellfix.c`（101.8K，misc 最大）、`unionvtab.c`（一表横跨多 db）、观测性全家（memtrace/pcachetrace/vfstrace/vfsstat/memstat）、`cksumvfs.c`（整库校验和装饰器 VFS）、`qpvtab.c`（把 sqlite3_index_info 以表暴露——**调试 xBestIndex 的利器**）。

shathree.c 的存在解释了一个 ABI 细节：**入口点 = 文件名去数字**，sha3 会与 sha1 撞——所以文件名叫 shathree。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双扩展协议 | 全部 ext/：loadext 协议（双形态生存——.so 或静态拼入）+ vtab 协议 | 一份代码同时满足动态库与 amalgamation 两种产品形态 |
| 宏拼接 | mkshellc.tcl | 维护多文件、分发单文件 |
| 文档与代码同源 | `** USAGE:` 注释生成帮助 | 不会漂移的文档 |
| 影子表 | FTS5/rtree | 复用宿主事务与备份 |
| 装饰器 | cksumvfs/vfstrace | 包裹默认 VFS 增强观测 |

## 扩展方式

**加一个 `.dot` 命令**：只改 `shell.c.in`（生成的 shell.c 禁改）——do_meta_command 的 if 链按首字符插分支（strncmp+`n` 自动获得前缀缩写）；azHelp[] 加帮助行，要 `.help <cmd>` 多行详情则写 `** USAGE:` 块；依赖新扩展源码就加 INCLUDE 行 + open_db 里注册 + 补进 main.mk 的 SHELL_DEP。

**写最简 vtab**：抄 series.c——单文件 + `sqlite3_module` 最小集（只读表可 xCreate=xConnect）→ xBestIndex 里设 `argvIndex/omit` 并给 estimatedCost → idxNum/idxStr 编码计划 → 编译成 .so 用 `.load` 加载（文件名即入口点，别带数字）。调试期用 qpvtab 看 core 实际给的查询计划、vtablog 打印全部回调序列。
