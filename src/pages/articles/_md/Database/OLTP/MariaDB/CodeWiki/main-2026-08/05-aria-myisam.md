---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "Aria 与 MyISAM"
date: "2026-09-22T22:45:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C", "Aria", "MyISAM", "S3", "translog", "PAGECACHE", "内部临时表"]
description: "MariaDB Aria/MyISAM/S3 引擎解读——translog+checkpoint 的 crash-safe 恢复模型、BLOCK_RECORD 页格式、内部临时表为何编译期绑定 Aria、S3 归档复用 Aria handler 换 pagecache 后端全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

Aria（`storage/maria/`，~99k 行）是 MariaDB 自研的 crash-safe 引擎——**内部临时表的默认引擎**（SQL 层 GROUP BY/ORDER BY 溢出盘的承载者）+ 系统表（`mysql.global_priv` 等）的事务化存储 + S3 归档的底座。MyISAM（`storage/myisam/`，~41k 行）是 MySQL 血统的老引擎，处于"保留但停止投入"状态。读懂这对引擎的钥匙是**血缘关系**：`_ma_search()`（ma_search.c）与 `_mi_search()`（mi_search.c）逐行相似，`MARIA_SHARE`/`MARIA_HA` 与 `MYISAM_SHARE`/`MI_INFO` 同构——**Aria 是 MyISAM 的 crash-safe 分叉**，且 CMake 上至今 `LINK_LIBRARIES myisam` 复用代码。

## 模块架构

| 维度 | MyISAM | Aria |
|---|---|---|
| 文件 | `.MYI`/`.MYD` | `.MAI`/`.MAD` |
| 崩溃安全 | 无日志；`STATE_CRASHED` 标记 + 事后 `mi_repair*` 修复 | WAL：translog + checkpoint + 启动 `maria_recovery_from_log()` 自动重放 |
| 缓存 | `KEY_CACHE`（仅索引页，`mysys/mf_keycache.c`） | `PAGECACHE`（索引+数据+log 页，支持分段 `aria_pagecache_segments`） |
| 行格式 | STATIC/DYNAMIC/COMPRESSED | 增加 **BLOCK_RECORD**（页式 + bitmap 空间管理；事务表强制，`ma_create.c:144`） |
| handler flags | `HTON_CAN_RECREATE` | 加 `HTON_TRANSACTIONAL_AND_NON_TRANSACTIONAL`（ha_maria.cc:3947） |

Aria 核心结构三层：`MARIA_SHARE`（`maria_def.h:684-875`，表级共享——含 `state_history` **多版本状态链**、`bitmap` 页空间位图、一整套行格式函数指针多态 :715-756、`S3_INFO *s3_path`）、`MARIA_HA`（:941-1061，每次 open——含 `trn` 指针与 `trn_next/trn_prev` 事务链，MyISAM 无此字段）、`TRN`（`trnman.h:44-58`——`trid` 全局事务号、`WT_THD wt` 死锁等待图、`rec_lsn/undo_lsn`）。

## 调用链路

**启动恢复序列**（`ha_maria_init()`，ha_maria.cc:3913-3996）：

```
ma_control_file_open()          控制文件 aria_log_control（<512B 单扇区原子写）
→ multi_init_pagecache() → init_pagecache(maria_log_pagecache)
→ translog_init()               多文件 aria_log.########
→ maria_recovery_from_log() → maria_apply_log() (ma_recovery.c:282)
    ├─ REDO: 从 last_checkpoint_lsn 重放 LOGREC_REDO_*
    └─ UNDO: _ma_apply_undo_row_insert/delete/... (:2335-2583) 回滚未提交事务
→ ma_checkpoint_init(aria_checkpoint_interval)   默认 30s
```

**WAL 强制点**——log-before-page 的单点实现：`ma_pagecache.c:681` 的 `pagecache_fwrite` 写脏页**之前**调 `flush_log_callback` = `maria_flush_log_for_page()`（ma_pagecrc.c:366）——从页头取 LSN，先 `translog_flush(lsn)` 落日志再落数据页。**Why 用 pagecache 钩子单点强制**：页的物理写路径收敛在缓存层（延迟写/换出/checkpoint flush 多条路径），在业务代码里插"先 flush log"必然漏。

**commit 协议**（`ma_commit()`，ma_commit.c:30-82）：先写 `LOGREC_COMMIT` 并 `translog_flush(commit_lsn)`，**再** `trnman_commit_trn()` 内存标记——顺序不可反（否则崩溃窗口内"客户端收到 OK 但事务被回滚"）。

## 核心实现

### translog：逻辑日志 + 短表 ID

多文件页粒度日志（`ma_loghandler.c`）。记录类型四组（`ma_loghandler.h:109-156`）：REDO（行/索引/页分配）、UNDO、PREPARE/COMMIT、CHECKPOINT + DDL 组。两个关键设计：

- **2 字节短表 ID**：每个事务化表首次写时 `translog_assign_id_to_share()`（ma_loghandler.c:8316）分配并写 `LOGREC_FILE_ID`（id→文件名映射），之后所有记录用短 id 引用——恢复时靠它重建 id_to_share
- **索引 redo 是逻辑微操作**：`LOGREC_REDO_INDEX` 记录 `en_key_op`（:161-178：`KEY_OP_OFFSET/SHIFT/CHANGE/ADD_PREFIX/DEL_PREFIX/...`），由 `ma_key_recover.c` 在每次改索引页时生成——**不记整页镜像，日志量小**，但 redo 代码必须与所有页修改点保持同步（Aria 复杂度的主要来源）

### BLOCK_RECORD 页格式（ma_blockrec.c:18-135）

数据文件按 bitmap 页分带：每张 bitmap 页（3 bits/页）管理一批数据页。页类型 `UNALLOCATED/HEAD/TAIL/BLOB`。数据页**行目录在页尾倒序**（每项 Position 2B + Length 2B）——删除只改目录不动行数据。行头带 `TRANSID(6B, 可选) + VER_PTR(7B, 指向 undo 链) + DELETE_TRANSID(6B, 可选)`——页内 MVCC 的载体，commit 后 compaction 可挤掉 optional 字段换空间。

### 内部临时表为何编译期绑定 Aria

```cpp
// sql/sql_class.h:6938-6950
#ifdef USE_ARIA_FOR_TMP_TABLES
#define TMP_ENGINE_COLUMNDEF MARIA_COLUMNDEF
#define TMP_ENGINE_HTON maria_hton
#define TMP_ENGINE_NAME "Aria"
```

`USE_ARIA_FOR_TMP_TABLES` 默认 ON（CMakeLists.txt:107），`mysqld.cc:5775` 明确配置了而 Aria 没起来则**拒绝启动**。这是 2008 年 Maria 引擎奠基时就定下的方向（commit `5ad477f6cb7`）。**Why 三点**：① crash 后不留损坏临时表（MyISAM 临时表 kill -9 后标记 crashed 残留 `#sql_*` 文件；Aria 日志驱动恢复可安全回收）；② PAGECACHE 同时缓存数据页（内部临时表顺序+随机混合访问，MyISAM keycache 只缓存索引）；③ 列定义结构（`TMP_ENGINE_COLUMNDEF`）与键长需编译期匹配引擎 ABI。git 证据同期对照：2024 以来 `storage/myisam/` 非 merge 提交 53 个几乎全是修复，`storage/maria/` 228 个含真实特性（如 MDEV-24 segmented pagecache，2025-05）。

### "Aria transactional"的真实语义

`ha_maria.cc:2974-2981`：`ARIA_HAS_TRANSACTIONS` 在全源码树**从未被定义**，因此 `file->autocommit=1`——每条语句结束即 commit。注释直说："Until Aria has full transactions support, including MVCC support for delete and update and purging of old states, we have to commit for every statement"。**即 crash-safe 的原子语句，非多语句隔离**——系统表用它恰好够了（特权变更原子且崩溃可恢复）。页内 MVCC 设施（TRANSID/VER_PTR、`trnman_can_read_from`、`MARIA_STATE_HISTORY`）都在，但 UPDATE/DELETE 的多版本与 purge 未完成。

### S3 引擎：复用 Aria handler + 换 pagecache 后端

`ha_s3.cc:53-58` 头注释："The s3 engine inherits from the ha_maria handler"。存储格式 = 非事务化 BLOCK_RECORD Aria 表，切 `s3_block_size`（默认 4M）块存为 S3 object：

```
aws_bucket/database/table/frm          .frm（discovery 用，不压缩）
aws_bucket/database/table/aria         索引文件头块（不压缩——需判断后续块是否压缩）
aws_bucket/database/table/index/000001 / data/000001
```

**ALTER TABLE ... ENGINE=S3 流程**：`ha_s3::create` 强制 `row_type=PAGE`、`transactional=NO` 后委托 `ha_maria::create` **先在本地建成 Aria 临时表** → SQL 层逐行 `write_row` 透传 → ALTER 收尾 rename → `move_table_to_s3()`（ha_s3.cc:437）→ `aria_copy_to_s3()`（s3_func.c:340，先传 frm 保证 discovery、再传头块、逐 4M 块 `s3_put_object` 可选 zlib）→ 删本地数据文件保留 .frm。

**读路径**：`ha_s3::open`（:619）把 share 的三个 pagecache 引用换成 `s3_pagecache`，缓存 miss 时 `s3_block_read`（s3_func.c:1619）按块号换算直接 `s3_get_object` 拉取（含解压）——**PAGECACHE 的 miss 粒度从一页变成一个 4M S3 object**（`ma_pagecache.h:189-192` 的 `big_block_read/big_block_free` 就是为 S3 加的扩展点）。`ha_s3` 的 discovery API 从 S3 取 frm，让本地无 .frm 的表也能被 SHOW TABLES 发现。`aria_s3_copy`（独立可执行文件）是服务器外的运维工具：不动服务器做归档/取回，复用同一套 copy 函数。

### MyISAM 侧速览

`mi_lock_database()`（mi_locking.c:30）：POSIX advisory 文件锁进程级互斥；concurrent insert 靠"数据 append 文件尾 + 读方 mmap remap"实现读写并发；**没有任何 redo**——崩溃一致性完全依赖 `.MYI` 头的 `STATE_CRASHED` 标记与事后 `mi_repair*`（这就是 MyISAM 表损坏要 REPAIR TABLE 而 Aria 自动恢复）。KEY_CACHE（`mysys/mf_keycache.c`，6605 行）：三温度 LRU（hot/warm/cold）+ 分区 + 多命名缓存（`CACHE INDEX t1 IN hot_cache`）+ 预热（`LOAD INDEX INTO CACHE`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 函数指针多态 | `MARIA_SHARE` 行格式钩子组（maria_def.h:715-756） | 同一套 B-tree/锁/日志代码适配 5 种行格式；MyISAM 只有 6 个钩子 |
| 钩子层 | `PAGECACHE_FILE` 的 pre/post read/write + flush_log_callback（ma_pagecache.h:101-123） | WAL 与缓存策略的解耦点（S3 也靠它） |
| 继承换后端 | `ha_s3 : ha_maria`（ha_s3.cc:54） | 换数据源只需换 IO 钩子 |
| 包装器 | `ha_sequence : handler` 内嵌 `handler *file`（sql/ha_sequence.cc:54） | SEQUENCE 表 = 单行 Aria 表（强制 `max_rows=min_rows=1` 委托建表） |

## 模块间交互

- **上游**：`ha_maria : public handler`（ha_maria.h:43）实现 handler 抽象（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）；SQL 层临时表经 `TMP_ENGINE_HTON` 宏直接引用 `maria_hton`
- **与 mysys**：PAGECACHE 是 mysys KEY_CACHE 的分叉演进（两套已不共享实现）；`WT_THD` 死锁等待图是 MariaDB 独有组件
- **与复制**：`s3_replicate_alter_as_create_select` 开关把 ALTER 回本地表以 CREATE...SELECT 记 binlog；`s3_slave_ignore_updates` 处理 slave 共享 bucket 场景
- **与插件框架**：Aria 是 `MANDATORY` 插件（不可禁用——临时表依赖它）；S3 是独立可选插件（依赖 CURL）

## 扩展方式

**给 Aria 加一种新页类型**（按依赖顺序，8 步）：① `ma_blockrec.h:77` `enum en_page_type` 加值 + 页头宏；② `ma_bitmap.c` 3-bit 编码档位；③ `ma_blockrec.c` 页读/写/扫描识别 + compaction 策略；④ `ma_pagecrc.c` filler 回调；⑤ **日志与恢复**：`ma_loghandler.h:109-156` 加记录类型（注意 `LOGREC_NUMBER_OF_TYPES 64` 上限）+ `log_record_type_descriptor[]` 注册 + `ma_recovery.c` apply 函数；⑥ `ma_check.c`/`aria_chk.c` 修复工具必须认识新页类型；⑦ 索引页则改 `ma_page.c` + `KEY_OP_*` 微操作；⑧ S3 联动：`s3_func.c:s3_block_read` 块号换算复核。

**改 checkpoint 策略**：`ma_checkpoint.c`（`CHECKPOINT_INDIRECT/MEDIUM/FULL` 三级，ma_checkpoint.h:27-36）；两 checkpoint 之间只刷"上次 checkpoint 时已脏"的页，限制 log 保留量。
