---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "连接与会话层"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "C++", "连接管理", "THD", "协议"]
description: "mysqld 启动装配、socket 监听与 per-thread 连接模型、THD 会话上下文、经典协议编解码全解"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

连接与会话层是客户端进入服务器的第一道关卡：它把操作系统 socket 上的一串字节，变成一个有身份、有权限、有事务状态的会话（`THD`），并把线程模型（每连接一线程 vs 线程池）与协议（classic text/binary、X）隔离成可替换的策略。这一层独立存在的理由是：**连接生命周期与 SQL 语义完全正交**——无论上层跑什么语句，连接建立、认证、心跳、超时、断连清理的逻辑是同一套；而线程模型决定了服务器的并发扩展形态（26.x 把企业版 thread_pool 插件社区化，正是利用了这层的可替换性）。

涉及目录：`sql/conn_handler/`（监听与调度）、`sql/sql_class.*`（THD）、`sql/protocol_classic.*`（协议）、`sql/mysqld_thd_manager.*`（全局 THD 注册表）、`sql/current_thd.*`（线程局部指针）、`plugin/thread_pool/`（可替换调度器）。

## 模块架构

内部组件的静态关系（本模块无独立 SVG，配合[全局架构图](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)理解）：

```text
mysqld_main ──装配──► Connection_handler_manager (单例)
                          └── Connection_handler (策略接口)
                                ├── Per_thread_connection_handler   # 默认：每连接一线程
                                └── One_thread_connection_handler   # --thread-handling=no-threads

socket_conn_event_handler ──► Connection_acceptor<Mysqld_socket_listener>
                              └── connection_event_loop()           # accept 循环
                                    └── process_new_connection → add_connection
                                          └── handle_connection     # 每连接入口
                                                └── THD + Protocol
```

`Connection_handler_manager::init()`（`sql/conn_handler/connection_handler_manager.cc:147`）按 `thread_handling` 系统变量选择策略类——这是标准的策略模式装配点；thread_pool 插件启用时会替换整个 manager 的行为。监听侧三个 `*_conn_event_handler`（`sql/mysqld.cc:3488-3520`）分别处理 TCP socket、Windows 命名管道与共享内存，每个起一个独立线程跑 `connection_event_loop()`，底层 `Mysqld_socket_listener`（`sql/conn_handler/socket_connection.h:106`）用 `poll()` 等待多路监听 socket（`socket_connection.cc:1351`）。

## 调用链路

一次连接从 accept 到 do_command 的完整链路（数据类型标注在箭头上）：

```text
poll() 就绪 (socket_connection.cc:1351)
└─ Mysqld_socket_listener::listen_for_connection_event → Channel_info_tcp_socket
   └─ Connection_handler_manager::process_new_connection (connection_handler_manager.cc:256)
      └─ Per_thread_connection_handler::add_connection
         └─ handle_connection (connection_handler_per_thread.cc:246)   [新 pthread]
            ├─ init_new_thd(channel_info) → THD*                        # 绑定 VIO 与 Protocol
            ├─ thd_prepare_connection(thd)                              # 认证 + 权限装配
            └─ while (thd_connection_alive(thd))
               │    do_command(thd) (sql/sql_parse.cc:1347)
               │      └─ dispatch_command(thd, &com_data, command)      # COM_QUERY/COM_STMT_*...
               └─ end_connection / close_connection                     # 断连清理
```

方法速查（点击展开）：

<details>
<summary>连接层方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `handle_connection` in `connection_handler_per_thread.cc:246` | 每连接线程主循环 | 线程退出前循环复用可缓存的 THD |
| `init_new_thd` | Channel_info → THD | PSI 线程插桩与 socket 所有权绑定 |
| `do_command` in `sql/sql_parse.cc:1347` | 读一个协议包并分发 | 空闲计时（idle instrumentation）在此更新 |
| `Protocol_classic::get_command` in `protocol_classic.cc:2890` | 解包头/解包体 → COM_DATA | `net` 层缓冲与压缩透明处理 |
| `Global_THD_manager::add_thd` | 全局 THD 注册 | `LOCK_thd_remove` 保证 SHOW PROCESSLIST 一致性 |
| `current_thd` in `sql/current_thd.cc:34` | `thread_local THD *` | 比函数调用更快的会话寻址 |

</details>

## 核心实现

### THD：会话的"万物容器"

`THD`（`sql/sql_class.h:953`）用三重继承聚合了会话需要的三个维度：

```cpp
class THD : public MDL_context_owner,   // 元数据锁上下文（参与全局锁等待图）
            public Query_arena,          // MEM_ROOT 场地（解析/执行期对象分配）
            public Open_tables_state {   // 打开表状态机（事务中表的游标状态）
```

关键成员：`LEX *lex`（`:1006`，当前语句的解析产物）、`std::unique_ptr<Transaction_ctx> m_transaction`（`:2033`，两阶段提交状态与 XID）、`MDL_context mdl_context`（`:971`）、`std::unique_ptr<Protocol_text> protocol_text` / `Protocol_binary`（`:1383-1384`，同一连接上 text/binary 协议共存，prepare 语句切 binary）。全局寻址用 `thread_local THD *current_thd`（`sql/current_thd.cc:34`）——server 代码里随处可见的 `current_thd` 宏就是它，避免了到处传 `THD*` 参数；赋值入口是 `THD::store_globals()`（`sql/sql_class.h`），在 THD 绑定线程时把自身写入 thread-local，因此 per-thread 与 no-threads 两种调度模型都能正确寻址。全局注册表 `Global_THD_manager`（`sql/mysqld_thd_manager.h:201`）把 THD 列表分成 **8 个分区 `thd_list`**（`NUM_PARTITIONS`）降低 `SHOW PROCESSLIST` 遍历的锁竞争；thread_id 由 `get_new_thread_id()` 分配，`remove_thd()` 回收，`reserved_thread_id = 0` 永不分配（保留给内部会话）。

为什么 THD 这么大（5000+ 行头文件）：MySQL 的线程模型是"线程即会话"，所有 per-session 状态（变量副本 `system_variables`、安全上下文 `Security_context`、诊断区 `Diagnostics_area`、临时表、保存点、GTID 上下文）都挂在 THD 上；thread pool 插件要做的最难的事就是在线程间迁移 THD（`mysqld_thd_manager` 与 `plugin/thread_pool` 的 attach/detach）。

### 协议层：Protocol 家族

```cpp
class Protocol {...};                                    // sql/protocol.h:46 抽象
class Protocol_classic : public Protocol {...};          // protocol_classic.h:54 经典协议
class Protocol_text : public Protocol_classic {...};     // :220 文本子协议（COM_QUERY）
class Protocol_binary final : public Protocol_text {...};// :242 二进制子协议（COM_STMT_EXECUTE）
```

`Protocol_classic::get_command`（`sql/protocol_classic.cc:2890`）完成包头（4 字节：3 长度 + 1 命令）与包体的解码，产出 `COM_DATA` 联合体交给 `dispatch_command` 的巨型 switch；`bad_packet` 标志构造时初值为 `true`（读到完整合法包才清除）。设计决策：**text 与 binary 共享 Protocol_text 基类**，因为两者的差异只在结果集行编码（binary 用长度前缀 + 类型标记），握手、错误包、列定义完全一致——复用大于分支；`Protocol_binary` 甚至用 `using Protocol_text::store_decimal` 沿用 decimal 的文本编码（二进制协议不需要单独的 decimal 线格式）。X 协议（`plugin/x/`）则完全独立（protobuf 帧、33060 端口、自带调度器），通过内部 session 服务与 THD 桥接，见[插件组件模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/09-plugins-components)。

### 线程模型：per-thread 与 thread_pool 的替换点

默认 `Per_thread_connection_handler` 为每个连接起一个 pthread，线程数=连接数。**线程缓存握手**：会话结束后线程不直接退出，而是 `block_until_new_connection()`（`connection_handler_per_thread.cc`）睡在 `COND_thread_cache` 上；新连接到来时 `add_connection` 先试 `check_idle_thread_and_enqueue_connection()`——把 `Channel_info` 挂入 `waiting_channel_info_list` 并 `wake_pthread++` 唤醒一个阻塞线程，失败才真正 `mysql_thread_create` 新线程。`slow_launch_threads` 状态变量度量启动慢的线程：仅当 `get_prior_thr_create_utime() != 0`（确实新建了 pthread，时间戳由 `channel_info.h` 的 `set_prior_thr_create_utime` 预存）时，用 `thd->start_utime - prior_thr_create_utime` 与 `slow_launch_time` 比较。

**连接数上限与预留**：`Connection_handler_manager::check_and_incr_conn_count()`（`connection_handler_manager.cc`）在递增**之前**检查 `connection_count > max_connections && !is_admin_connection`——即允许 max+1 个连接，最后 1 个留给 admin 接口/SUPER 用户。当 admin 端口与普通端口共用同一 listener 时，`Mysqld_socket_listener` 把 admin socket 固定排在 `m_poll_info.m_fds[0]`，`get_listen_socket()` 先检查它再遍历其余——poll 返回后 admin 连接天然优先。

**优雅关停**：信号线程收到 SIGTERM/SIGINT 后置 `set_connection_events_loop_aborted(true)`（`sql/mysqld.cc`）并向主线程 `pthread_kill(main_thread_id, SIGALRM)`——用信号打断阻塞在 `poll()` 上的监听线程；`Connection_acceptor::connection_event_loop()`（`sql/conn_handler/connection_acceptor.h`）的循环条件就是该标志。

26.x 的标志性变化是 thread_pool 插件进入社区版（`plugin/thread_pool/src/thread_pool_plugin.cc:1116`，DAEMON 插件）：连接按 connection id 哈希到最多 512 个 thread group（`MAX_NORMAL_THREAD_GROUPS`），组内正常时刻单线程活跃，`threadpool_stall_limit`（默认 6s）检测长查询后追加 worker——用少量线程服务大量连接，上下文切换与内存占用大幅下降。server 侧为它预留的边界是 `include/mysql/thread_pool_priv.h` 显式列出插件可访问的 server 内部符号。两模型的共同前提是 `handle_connection` 循环内所有状态都在 THD 而非线程栈上。

### 启动装配顺序

连接相关初始化的顺序约束（`sql/mysqld.cc`）：`network_init()`（`:9998`，绑定监听 socket）必须在 `Connection_handler_manager::init()`（`:13467` 调用，实现在 `connection_handler_manager.cc:147`）之后；而真正 accept 的 `setup_conn_event_handler_threads()` 在权限表 `acl_init`（`:10073`）之后才启动——避免权限未就绪时放进连接。引擎（`ha_init`）与 DD（`dd::init`）就绪更早，因为认证需要读取 `mysql.user`（一张 InnoDB DD 表）。

## 模块间交互

- **向解析器**：`do_command` 的 `COM_QUERY` 分支把 SQL 文本交给 `dispatch_sql_command`（`sql/sql_parse.cc:5303`），见[解析器模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/02-parser)；
- **向引擎层**：认证读 `mysql.user` 走完整查询路径（THD 上的内部查询），见[存储引擎 API 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/05-storage-engine-api)；
- **被可观测性消费**：`Global_THD_manager` 维护的 THD 注册表是 `SHOW PROCESSLIST` / `performance_schema.threads` 的数据源；
- **被 kill 机制穿透**：`THD::killed` 标志被 InnoDB（`general_fetch` 检查 `transaction_rollback_request`）与执行器循环（`ExecuteIteratorQuery` 检查 `thd->killed`）协同轮询。

## 扩展方式

- **新增一种连接方式**：参照 `sql/conn_handler/socket_connection.cc`，实现 `Channel_info` 子类 + listener，接入对应的 `*_conn_event_handler`；
- **替换线程模型**：实现 `Connection_handler` 子类并在 `Connection_handler_manager::init` 的 switch 注册（或如 thread_pool 那样整体接管 `process_new_connection` 路径）；
- **新增协议命令**：`include/mysql/com_data.h` 加 COM_DATA 字段 → `dispatch_command` 的 switch 加 case → `sql_parse.cc` 对应 handler；注意复制命令（`COM_BINLOG_DUMP` 等）已有专属分支。
