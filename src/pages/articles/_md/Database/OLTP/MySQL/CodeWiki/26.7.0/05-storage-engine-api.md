---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "存储引擎 API"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "C++", "handlerton", "handler", "MDL", "插件"]
description: "handler/handlerton 双层契约、引擎注册与装载、MDL 元数据锁、表缓存、二级引擎挂点的源码解读"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

存储引擎 API 是 server 层与引擎层的**唯一契约**：`handlerton`（引擎级函数指针表）+ `handler`（每表实例的 ~200 个虚方法）。MySQL 的"可插拔引擎"生态全部建立在这张契约上——InnoDB、MyISAM、CSV、内存临时表、Performance Schema、NDB 平权接入，server 对引擎能力（有无事务、支不支持在线 DDL、二级引擎）只能通过 flags 与运行时探测感知。这一层还包含两个 server 侧的横切设施：**MDL 元数据锁**（DDL/DML 并发的仲裁者）与**表缓存**。

涉及文件：`sql/handler.h`（8,050 行契约定义）、`sql/handler.cc`（9,800 行）、`sql/mdl.*`（4,300+ 行）、`sql/table_cache.*`、`sql/sql_plugin.cc`（插件装载，与[插件组件模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/09-plugins-components)分工：本模块只讲引擎接入路径）。

## 模块架构

```text
server 层                                    引擎层
┌────────────────────────────┐   handlerton（每引擎一份，进程级）
│ 执行器: ha_rnd_next(...)    │ ─────────►  innodb_hton ─┐
│ DDL: ha_create/alter        │ ─────────►  myisam_hton  │ 各自填充 60+ 回调
│ 事务: ha_commit_trans       │ ─────────►  pfs_hton     │ （create/commit/rollback…）
└────────────────────────────┘             temptable_hton ┘
        │ handler（每表打开一份）
        ▼ get_new_handler (handler.cc:614) → db_type->create(hton, share, part, alloc)
┌────────────────────────────┐
│ class handler ~200 虚方法    │ ◄── ha_innobase / ha_myisam / ha_perfschema…
└────────────────────────────┘
MDL（sql/mdl.h，19 namespace）与 Table_cache 环绕在开表路径上
```

## 调用链路

从语句到引擎的请求链（读路径）与装配链（启动期）：

```text
【运行期 · 读】
TableScanIterator::DoRead → ha_rnd_next (handler.cc:3111)
  →（PSI 计时包装）→ handler::rnd_next(buf)     # 纯虚方法 :5983
  → ha_innobase::rnd_next (ha_innodb.cc:11104)

【启动期 · 装配】
mysqld_main → init_server_components (mysqld.cc:8116)
  → ha_init (handler.cc:910)                  # 并计算 opt_using_transactions
     → plugin_initialize (sql_plugin.cc:1298) # init 回调期间临时释放 LOCK_plugin
        → plugin_type_initialize[STORAGE_ENGINE] = ha_initialize_handlerton
           → innodb_init (ha_innodb.cc:5441)   # 填 handlerton 全部回调
```

`ha_init` 除装载引擎外还计算 `opt_using_transactions`（binlog 或任一事务引擎启用即开事务支持）并给 `savepoint_alloc_size` 加上固定开销；`plugin_initialize` 在调插件 init 前临时释放 `LOCK_plugin` 与 `LOCK_system_variables_hash`、结束后重新加回——防止 init 回调里再取锁死锁。

方法速查：

<details>
<summary>引擎 API 方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ha_init` in `handler.cc:910` | 装载全部引擎插件 | 经插件分派表，引擎与 server 无编译期依赖 |
| `get_new_handler` in `handler.cc:614` | handlerton→handler 工厂 | `db_type->create` 失败经 ha_default_handlerton 回落默认引擎 |
| `handler::ha_rnd_next` in `handler.cc:3111` | rnd_next 的插桩包装 | MYSQL_TABLE_IO_WAIT 计时 + 生成列求值统一在此 |
| `ha_commit_trans` in `handler.cc:1686` | 两阶段提交协调 | 详见[复制模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication) |
| `ha_resolve_by_name` in `handler.cc:413` | DDL 的引擎名解析 | `hton2plugin` 反查插件对象 |

</details>

## 核心实现

### handlerton：引擎的单例契约

`struct handlerton`（`sql/handler.h:2852`）是引擎注册时填写的函数指针表，代表性字段：`state`/`db_type`（引擎标识）、`create`（handler 工厂）、事务族 `commit/rollback/prepare/commit_by_xid`、保存点族 `savepoint_set/savepoint_rollback/savepoint_release`（`savepoint_offset` 约定 per-savepoint 存储区大小，如 InnoDB 设为 `sizeof(trx_named_savept_t)`）、连接生命周期 `close_connection/kill_connection`、DDL 族 `log_ddl_create_schema` 等，以及能力 flags（InnoDB 声明 `HTON_SUPPORTS_ATOMIC_DDL | HTON_SUPPORTS_FOREIGN_KEYS` 等）。装载侧 `ha_initialize_handlerton`（`sql/handler.cc`）为 handlerton 在 `se_plugin_array` 中分配 slot（复用空槽而非追加，保证 slot 稳定），把 `savepoint_offset` 累计进全局 `savepoint_alloc_size`，参与两阶段提交的引擎（有 `prepare`/`commit`）计入 `total_ha_2pc`。InnoDB 的填充过程在 `innodb_init`（`storage/innobase/handler/ha_innodb.cc:5441`）——60+ 个回调一次性挂接（含 `start_consistent_snapshot = innobase_start_trx_and_assign_read_view`），此后 server 只认函数指针。26.x 在此之上的新抽象：**接口化改造**把 redo/MVCC/tablespace 等内部机制抽出 `*_interface.h`（如 `log0handler_interface.h`、`read0read_view_interface.h`），为独立工具复用引擎子系统和二级引擎铺路。

### handler：每表实例的行操作协议

`class handler`（`sql/handler.h:4753`）约 200 个虚方法，按功能分组：扫描族（`rnd_init/rnd_next/rnd_end` 纯虚 `:5983`）、索引族（`index_read_map/index_next/index_prev`）、写族（`write_row/update_row/delete_row`）、在线 DDL 三步协议（`prepare_inplace_alter_table :6750 / inplace_alter_table :6787 / commit_inplace_alter_table :6845`，见[DD 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/07-dd-ddl)）。server 侧的 `ha_*` 包装方法统一做三件事：**PSI 插桩**（`MYSQL_TABLE_IO_WAIT`）、**断言**（锁类型与表状态）、**公共后处理**（生成列、错误映射）——例如 `ha_rnd_next`（`handler.cc:3111`）包装后引擎实现里就不会有重复的计时代码。分区表由 `ha_innopart`（`ha_innopart.h:222`，继承 `ha_innobase`）把请求扇出到多个分区 handler。

### MDL：元数据锁的 19 个命名空间

`sql/mdl.h:402` 的 `enum_mdl_namespace` 列出全部锁对象类型：`GLOBAL / BACKUP_LOCK / TABLESPACE / SCHEMA / TABLE / FUNCTION / PROCEDURE / TRIGGER / EVENT / COMMIT / USER_LEVEL_LOCK / LOCKING_SERVICE / … / FOREIGN_KEY / CHECK_CONSTRAINT / LIBRARY`（共 19 个，`NAMESPACE_END` 哨兵不计）。每个 THD 持有 `MDL_context`（`sql_class.h:971`），锁请求构造为 `MDL_request`（`mdl.h:805`）经 `MDL_context::acquire_locks` 提交。**MDL_request 与 MDL_ticket 为什么是两个类**：request 是栈上的"申请单"（默认 `MDL_SHARED` 类型、`MDL_TRANSACTION` 时长），ticket 是锁授权后堆上的"持票凭证"（`MDL_request::ticket` 回指）——request 生命周期只在语句开表期间，ticket 要活到事务结束并由锁系统管理。**为什么 MDL 存在**：DML 拿表的 SHARED_READ/WRITE 锁、DDL 拿 EXCLUSIVE 锁，防止"查询执行到一半表被 DROP"——开表路径（`sql_base.cc` 的 `open_tables`）在 `lock_table_names` 里统一获取，语句结束随语句 arena 释放。死锁检测是全局的（MDL wait graph）。26.x 新增 `BACKUP_LOCK` 相关细化与 `sql/mdl_context_backup.*`（用于在线 clone 时备份锁上下文）。

两阶段提交与 MDL 的交汇：`ha_commit_trans`（`sql/handler.cc:1686`）对多引擎读写事务（`Transaction_ctx::rw_ha_count > 1` 或引擎要求 2PC）先取 `MDL_key::COMMIT` 命名空间的 `MDL_INTENTION_EXCLUSIVE` 锁——序列化并发提交的 prepare 阶段防死锁；引擎 prepare（`tc_log->prepare`）或 `tc_log->commit` 失败时走 `ha_rollback_trans` 回滚。

### 表缓存：TABLE_SHARE 与实例复用

`Table_cache`/`Table_cache_manager`（`sql/table_cache.h:74/206`）缓存已打开的表定义（`TABLE_SHARE`，来自 DD 翻译）与可复用的 `TABLE` 实例（含 handler）。**大多数查询因此不需要碰全局 `LOCK_open`**：每个线程用 `my_thread_id() % instances` 选定自己的 cache 实例（最多 `MAX_TABLE_CACHES` 个分片），分片内自锁；跨分片操作（DDL 失效）才由 manager 协调。空闲实例组织在 `m_unused_tables` 环形 LRU 链上，`free_unused_tables_if_necessary` 在低水位以下才释放。DD 变更（`dd_table_share.cc` 的失效逻辑）与 `FLUSH TABLES` 负责使缓存条目失效。

### 二级引擎挂点

server 为 HeatWave 类加速引擎预留的契约：建表时的 `SECONDARY_ENGINE` 属性（`handler.h:831-835` 的 `HA_CREATE_USED_EXPLICIT_SECONDARY_ENGINE` flags）；查询期的资格判定 `THD::is_secondary_storage_engine_eligible`（`sql/sql_class.cc:3196`）逐项排除：SBR 复制格式下的 CTAS/INSERT...SELECT（行镜像无法从二级引擎采集）、会话已设 `Secondary_engine_optimization::PRIMARY_ONLY`、`use_secondary_engine=OFF`、`LOCK TABLES` 模式、多语句事务中的非 CTAS 语句（CTAS 豁免是因为前后各有隐式 COMMIT）；执行移交 `JOIN::override_executor_func`（`ExecuteIteratorQuery` 里 `sql_union.cc:1101` 的分支——把整个查询交给二级引擎自己的执行器）。社区侧的参考实现是 `storage/secondary_engine_mock/ha_mock.cc`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 + 工厂 | handlerton（策略表）+ `get_new_handler`（工厂） | 引擎可插拔的最小机制 |
| 模板方法 | `ha_*` 包装 + 虚方法 | 插桩/断言/后处理写一次，全部引擎受益 |
| 分层锁 | MDL namespace + 表缓存分片 | 元数据并发与缓存并发解耦 |
| 注册表 | `plugin_type_initialize` 分派表（`sql_plugin.cc:372`） | 插件类型各自决定初始化方式 |

## 模块间交互

- **上游**：[执行器](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/04-executor)的基表算子、[DD/DDL](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/07-dd-ddl) 的建表改表路径；
- **下游**：InnoDB 实现（见[InnoDB 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/06-innodb)）与其他引擎；
- **横向**：两阶段提交由 `TC_LOG` 协调（[复制模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication)）；`extern STL` 级共享统计（`ha_update_stats`）回写 DD 统计表；PFS 对 `MYSQL_TABLE_IO_WAIT` 的消费见[可观测性模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/09-plugins-components)。

## 扩展方式

- **新增存储引擎**：`storage/example/` 是官方模板——实现 handlerton init（填 `db_type/create/commit` 等）+ `handler` 子类（至少 `rnd_init/rnd_next`），`mysql_declare_plugin` 声明 + CMake `MYSQL_ADD_PLUGIN`；需要被 `ENGINE=` 名字解析到则登记 `ha_resolve_by_name` 的名字映射；
- **给现有引擎加能力**：修改对应 `ha_xxx` 的 flags 探测返回（如在线 DDL 的 `check_if_supported_inplace_alter` 返回值）即可让 server 层自动改走不同路径；
- **新增 MDL namespace**：`sql/mdl.h:402` 枚举加值 + key 构造函数——影响 MDL_key 的 packed 表示，需评估 `lock_order_dependencies.txt`（调试锁序）的一致性。
