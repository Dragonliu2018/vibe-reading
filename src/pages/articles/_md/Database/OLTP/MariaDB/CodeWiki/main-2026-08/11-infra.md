---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "平台基础库"
date: "2026-09-22T22:55:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C", "IO_CACHE", "字符集", "VIO", "tpool", "DBUG", "MEM_ROOT"]
description: "MariaDB 平台基础库解读——IO_CACHE 五模式统一缓冲、CHARSET_INFO 三层结构与 UCA 权重机器、Vio 函数指针网络抽象、tpool LIFO 唤醒线程池、DBUG 运行期 TRACE 与故障注入全解"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

基础库层是 server、22 个引擎、全部 client 工具、全部动态插件共同链接的**C 语言 ABI 地基**——除 tpool 外全部是 C，这正是插件二进制兼容的前提（C++ vtable/STL 不能跨 .so 边界）。`mysys/ChangeLog` 最早条目是 1999-2000 年 Monty 的手笔——它诞生于 C 标准库尚未统一的年代，如今承担：统一文件包装（PFS 埋点）、`MEM_ROOT` 竞技场分配器（SQL 层语句内存的基石）、getopt/my.cnf 解析、lock-free 哈希、IO_CACHE。

| 目录 | 规模 | 一句话 |
|---|---|---|
| `mysys/` | 58k 行 | C 可移植层：文件/线程/锁原语、MEM_ROOT、DYNAMIC_ARRAY、lf_hash、IO_CACHE、key cache |
| `strings/` | 332k 行 | 字符集/collation（~80% 是生成数据表）+ decimal/dtoa/my_vsnprintf |
| `vio/` | 3.7k 行 | 网络抽象：TCP/socket/pipe/SSL 统一函数指针表 |
| `tpool/` | 3.1k 行 | C++11 线程池 + 跨平台 AIO（模拟/native AIO/libaio/io_uring/IOCP） |
| `dbug/` | 2.7k 行 | 运行期 TRACE 与故障注入 |
| `sql-common/` | 7.4k 行 | client/server 共享的 SQL 语义代码（C API、net 编解码、my_time） |
| `extra/` | ~30k 行 | mariabackup、comp_err、innochecksum 等工具 + wolfssl submodule |
| `include/` | 36k 行 | 公共头 + 插件 ABI 契约（`mysql/plugin.h` + `service_*.h`） |

## 核心实现

### IO_CACHE：统一缓冲抽象（include/my_sys.h:439-525）

一种结构承载 5 种模式（`enum cache_type`），由 `init_functions()`（mysys/mf_iocache.c:133）装配函数指针：

| 模式 | 用途 |
|---|---|
| `READ_CACHE` | 普通文件顺序读（binlog 读、filesort 归并） |
| `WRITE_CACHE` | 普通写缓冲 |
| `SEQ_READ_APPEND` | **一边追加一边顺序读**：先从文件读，读到 `end_of_file` 后切到 write buffer——relay log 即此模式（IO 线程追加、SQL 线程同读） |
| `READ_FIFO` | 读 FIFO（LOAD DATA 判断 `S_ISFIFO`） |
| `READ_NET` | **由调用方注入 read_function**（`_my_b_net_read` 依赖 THD，定义在 sql/mf_iocache.cc:52）——LOAD DATA LOCAL 把客户端网络流伪装成文件 |

三个进阶机制：

- **`open_cached_file`**（mf_cache.c:31）：传 `File=-1` 初始化，**缓冲写满才真正创建临时文件**——binlog 事务缓存的实现基础（`binlog_cache_size` 内存内搞定的事务永远不碰磁盘，`disk_writes` 字段供 `binlog_cache_disk_use`）
- **`IO_CACHE_SHARE`**（mf_iocache.c:1063）：多 reader 线程共享同一读缓冲——并行复制 worker 共享 relay log 读缓存
- **加密钩子**：全局 `_my_b_encr_read/_my_b_encr_write`（:73），file_key_management 插件启用时安装，加密内部临时文件；13.x binlog-in-engine 也把 `write_function` 换成 `binlog_spill_to_engine`（sql/log.cc:7541）——函数指针表的灵活性的直接例证

快路径设计：`my_b_read()`/`my_b_write()` 是 `include/my_sys.h:547/558` 的 **static inline**——数据在缓冲内直接 memcpy 移游标，不碰函数指针；不够才走慢路径。

### strings/：字符集三层结构

332k 行中约 80% 是**生成的权重表**（`conf_to_src` 从 `sql/share/charsets/*.xml` 生成 ctype-extra.c；`uca-dump` 从 Unicode allkeys1400.txt 生成 ctype-uca1400data.h）。三层结构：

1. **数据**：`CHARSET_INFO`（include/m_ctype.h:856）= 256 字节转换表 + `mbminlen/mbmaxlen` + `tailoring` 字符串
2. **`MY_CHARSET_HANDLER`**（:712，~30 个函数指针）——"字符集怎么编解码"：`mb_wc/wc_mb`、`well_formed_char_length`、以及一整套**字符集感知的数字解析**（`strntod/strtoll10`——所以 `'123abc'` 语义转换按 charset 规则进行）
3. **`MY_COLLATION_HANDLER`**（:555）——"字符串怎么比较/排序"：`strnncoll`（含收缩字符如捷克 'ch' 按两字符计数）、`strnxfrm`（生成排序 key——filesort 直接 memcmp 排序 key 而非反复调 coll）、`like_range`（把 `LIKE 'abc%'` 转成 min/max 范围供索引扫描）

UCA collation（`utf8mb4_uca1400_ai_ci` 等）在**启动时**实例化：`create_tailoring()`（ctype-uca.c:34576）解析 `CHARSET_INFO.tailoring` 中的 ICU Collation Customization 规则，按页覆盖生成定制权重——相同 charset+tailoring 共享一个权重结构（:34705）。注册表 `all_charsets[]`（mysys/charset.c:584）按 **collation ID** 索引——ID 是跨版本线上的兼容契约（m_ctype.h:420-431 为 MariaDB 私有段分段保留）。

### VIO：网络传输抽象

`struct st_vio`（include/violite.h:241）= PFS 埋点 socket + 16KB 读缓冲 + **约 20 个函数指针**（read/write/timeout/blocking/peer_addr/shutdown/io_wait...），由 `vio_init()`（vio/vio.c:77）按 type 装配：TCP/Unix socket（viosocket.c）、SSL（viossl.c 的 `SSL_read/SSL_write` 循环）、Windows named pipe（viopipe.c）。`#define vio_read(vio,b,s) ((vio)->read(vio,b,s))`——NET 层之上的协议代码完全不感知底层是 TCP 还是 TLS。**`vio_reset()`**（vio.c:194）把已初始化的 socket 型 Vio **原地重绑**为 SSL 型——SSLRequest 包交换后明文连接原地升级 TLS，不换对象。注意 **MariaDB 没有 shared memory 传输**（MySQL 的 vioshm.c 已删）。

### tpool：LIFO 唤醒 + 僵局检测

`tpool/tpool_generic.cc:146` 的 `thread_pool_generic`——server 的 `thread_handling=pool-of-threads` 与 InnoDB 后台任务（purge/dict_stats）共用它。三个要点：

- **每 worker 自带 condition_variable，`wake()` 精确唤醒 + LIFO 顺序**（文件头注释明说）——让热线程保持热、闲线程保持闲，天然配合空闲超时退出
- **maintenance 线程**（:590）做僵局检测：队列非空且 `m_tasks_dequeued + m_wakeups` 无增长 ⇒ 无进展 ⇒ `add_thread()` 补线程（创建有节流曲线防雪崩，上限 500）
- **wait 协议**（:~870）：任务即将阻塞（等锁/等 IO）时 `wait_begin()` 把自己标记 WAITING 不占并发额度——`sql/threadpool_common.cc` 的 `tp_wait_begin/tp_wait_end` 挂到 THD_WAIT_* 钩子（也经 `service_thd_wait.h` 暴露给存储引擎）。**这是线程池跑数据库必须解决的问题：阻塞在行锁上的连接不能占住 pool 槽位**

AIO 五后端：模拟（线程池）/Linux native AIO/libaio/io_uring/IOCP——InnoDB 直接消费（`storage/innobase/os/os0file.cc:78`）。

### DBUG：运行期 TRACE + 故障注入

Fred Fish 血统（dbug/dbug.c 头注释 1989）+ Monty/Sergei 的扩展。三级开关：

1. **编译期完全关闭**（release 的 `DBUG_OFF`）——所有宏展开为空，零开销
2. **编译期打开**（`-DDBUG_TRACE`）——`DBUG_ENTER("func")`/`DBUG_RETURN(v)`/`DBUG_PRINT("keyword",...)` 生效，输出缩进调用树
3. **运行期**：`SET GLOBAL debug_dbug='+d,name'`——`debug` 变量控制串（`Sys_var_dbug`，sql/sys_vars.cc:1107）：`d`=keyword 列表、`f`=函数过滤（glob）、`t[N]`=trace 限深、`o,file`=输出文件

**`DBUG_EXECUTE_IF("name", {代码})` 是测试的故障注入点**——mtr 用 `SET GLOBAL debug_dbug` 触发。**Why 双档位**：release 零开销，但故障注入点在 `!DBUG_OFF` 下始终可用——数据库的并发 bug 必须靠确定性故障注入复现，不能只在 debug 版可测。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 函数指针虚表 | IO_CACHE/Vio/CHARSET_INFO 全部 | C ABI 的多态——插件二进制兼容的前提 |
| 快路径 inline + 慢路径函数指针 | `my_b_read`（my_sys.h:547） | 热路径零间接开销 |
| 表驱动状态机 | 词法器 `cs->state_map` | 字符集差异由 strings 层吸收 |
| 生成代码 | uca-dump/conf_to_src 产权重表 | 海量数据离线生成，运行期按需加载控制二进制体积 |

## 模块间交互

- **向上**：SQL 层的 `MEM_ROOT` 语句内存、`lf_hash`（`sql/mdl.cc:1531` 元数据锁、`sql/table_cache.cc:545` 表缓存）、IO_CACHE（binlog/relay log/LOAD DATA/filesort）——见各模块文档
- **依赖 vendoring 的不对称策略**：zlib 整棵 vendored（1.3.2，锁版本保证行为一致）；SSL 默认外链 OpenSSL，**fallback 是 wolfSSL**（extra/wolfssl submodule）——wolfSSL 许可与 GPLv2 兼容，保证任何环境都能构建出合规的 SSL 版本（`cmake/ssl.cmake:28`）
- **InnoDB**：purge worker 与 dict_stats 跑在 tpool 上；AIO 五后端

## 扩展方式

**新增一个 service**（给插件暴露 server 能力）：`include/mysql/service_xxx.h` 定义函数表结构 + `libservices/xxx_service.c` 一行占位 + `sql/sql_plugin_services.inl` 的 `list_of_services[]` 登记——7 步模板见 `libservices/HOWTO`。

**新增一个字符集 collation**：8-bit 集优先从 `sql/share/charsets/*.xml` 配置生成（运行期 `my_read_charset_file` 加载）；UCA 定制只写 tailoring 字符串（ICU 规则子集），权重按页覆盖自动生成——**几乎不用写代码**，这是三层分离设计的直接红利。
