---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "存储引擎抽象层"
date: "2026-09-22T22:32:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "handler", "handlerton", "存储引擎", "插件", "两阶段提交", "分区"]
description: "MariaDB 存储引擎抽象层解读——transaction_participant/handlerton/handler 三层结构、ha_ 前缀包装模式、ha_partition 元 handler 扇出、TC_LOG 两阶段提交、discovery API 全解"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

handler 抽象层是 MariaDB「可插拔存储引擎」架构的支点——server 与 22 个存储引擎之间的全部协议都经过 `sql/handler.h`（6155 行）与 `sql/handler.cc`（9773 行）。它回答三个问题：引擎怎么注册进 server（插件机制）、一次表操作怎么从 SQL 层落到引擎（ha_ 包装模式）、跨引擎事务怎么保证原子性（TC_LOG 两阶段提交）。god node 数据说明这层的枢纽地位：`handler` degree 475/419（全库第 4）、`ha_partition` degree 406、`TABLE` 281、`TABLE_SHARE` 192。

## 模块架构

MariaDB 13.x 把 MySQL 的 `handlerton` 拆成了**两层**，这是理解本模块的第一把钥匙：

- **`transaction_participant`**（`sql/handler.h:1267`）——"参与事务者"抽象：只有事务级回调（commit/rollback/prepare/savepoint_*/commit_ordered/prepare_ordered/recover/commit_by_xid）+ 连接级状态（slot、savepoint_offset、flags）。**binlog 和 MHNSW 向量索引都以这个身份参与两阶段提交**——它们不是存储引擎
- **`handlerton`**（`sql/handler.h:1505`）——引擎单例，公有继承 transaction_participant 并追加"全局"回调：create（handler 工厂）、kill_query、drop_table、partition_flags、discover_table 族、binlog_* 回调（13.x 新方向）
- **`handler`**（`sql/handler.h:3405`）——每表每实例对象：`table`/`table_share`/`ref`（行位置）/`active_index`/`pushed_idx_cond`（ICP）

```cpp
// sql/handler.h:1505 头注释
/*
  handlerton is a singleton structure - one instance per storage engine -
  to provide access to storage engine functionality that works on the
  "global" level (unlike handler class that works on a per-table basis)
*/
```

## 调用链路

**插件注册链路**（从 CMake 到运行时）：

```
storage/foo/CMakeLists.txt: MYSQL_ADD_PLUGIN(foo ... STORAGE_ENGINE [DEFAULT|MANDATORY])
  ↓ cmake/plugin.cmake:202
STATIC: builtin_maria_foo_plugin 追加进 mysql_mandatory/optional_plugins
        → configure 生成 sql/sql_builtin.cc（链接进 mariadbd）
DYNAMIC: 产出 ha_foo.so，内含 maria_declare_plugin(foo) 展开的 _maria_plugin_declarations_[]
  ↓ 启动
plugin_init (sql/sql_plugin.cc:1577)
  → plugin_initialize (:1495) → plugin_type_initialize[type]
     分发表 sql_plugin.cc:123：{ 0, ha_initialize_handlerton, 0, 0, initialize_schema_table, ... }
  → ha_initialize_handlerton (sql/handler.cc:715)
     my_malloc(handlerton) → plugin->plugin->init(hton)   ← 引擎填 create/flags/exts
     → db_type 冲突仲裁（installed_htons[]）
     → setup_transaction_participant (sql/handler.cc:672)  ← 分配 slot，prepare!=0 则 total_ha_2pc++
```

**典型 SELECT 的 handler 调用序列**（全表扫描，`sql/records.cc` 驱动）：

```
rr_sequential (sql/records.cc:508)
├─ table->file->ha_rnd_init_with_error(1)  → handler::ha_rnd_init (handler.h:3733) → rnd_init() 虚函数
└─ loop: table->file->ha_rnd_next(buf)     (sql/handler.cc:4032)
    ├─ TABLE_IO_WAIT(tracker, PSI_TABLE_FETCH_ROW, ..., result, { result= rnd_next(buf); })
    ├─ result == HA_ERR_RECORD_DELETED → 跳过继续（引擎标记的已删行）
    ├─ table->vfield && buf == record[0] → update_virtual_fields()
    └─ increment_statistics(&SSV::ha_read_rnd_next_count)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
|---|---|---|
| `ha_initialize_handlerton` | 引擎注册 | handler.cc:715；db_type 冲突时分配 `DB_TYPE_FIRST_DYNAMIC` 起的空位 |
| `setup_transaction_participant` | 事务参与者登记 | handler.cc:672；`prepare != 0` 才计入 `total_ha_2pc` |
| `ha_rnd_next` | 全表扫描取行 | handler.cc:4032；PSI/统计/虚拟列回填全在包装层 |
| `ha_write_row` | 写行 | handler.cc:8511；`mark_trx_read_write()` 触发 `trans_register_ha` 注册事务 |
| `position` / `ha_rnd_pos` | 行位置协议 | 引擎把 rowid 写 `this->ref`；filesort/join buffer 按 ref 回读 |
| `ha_commit_trans` | 两阶段提交状态机 | handler.cc:1756 |
| `ha_discover_table` | 表发现 | handler.cc:7013；逐引擎问"这表在你那吗" |

</details>

## 核心实现

### ha_ 包装：横切逻辑的统一收口

SQL 层永远调 `ha_rnd_next`/`ha_index_read_map`/`ha_write_row`（inline 于 `sql/handler.h`），包装层统一做五件事再调引擎虚函数：**PSI 计时、kill 检查、统计计数、虚拟列回填、binlog row 事件**。以 `ha_rnd_next` 为例（`sql/handler.cc:4032`）：`do { result = rnd_next(buf); } while (!thd->check_killed(1))` 的循环让引擎返回的 `HA_ERR_RECORD_DELETED` 被上层透明跳过。**Why**：把与引擎无关的横切逻辑收在 server 侧，引擎实现保持最小——代价是 handler.h 膨胀（degree 475 的来源）。

### 表打开与对象池化

```
open_table (sql/sql_base.cc:1961)
→ tdc_acquire_share (sql/table_cache.h:85)     TDC: TABLE_SHARE 缓存
→ tc_acquire_table (sql/table_cache.cc:398)    命中则整个 TABLE+handler 直接复用
→ 未命中: TABLE_SHARE::init_from_binary_frm_image (sql/table.cc:1843)
   → get_new_handler (sql/handler.cc:381)      db_type->create() 工厂
   → file->ha_open (sql/handler.cc:3905)       ref/dup_ref 分配 + flags 缓存
```

`TABLE_SHARE` 每表一份（frm 解析结果、`Handler_share*` 引擎挂钩），`TABLE` 持 share + handler，TDC 按线程哈希分多 cache 实例缓存**整个打开的 TABLE**。**Why**：绕开重复 open/frm 解析/handler 构造是 OLTP 热路径的关键；代价是 DDL 后要 `tdc_wait_for_old_version` 等旧版本释放。`get_new_handler` 发现引擎不可用时静默回退默认引擎（`ha_default_handlerton`）——服务"CREATE TABLE 指定不存在引擎时替换建表"的语义。

### 两阶段提交与 TC_LOG

`ha_commit_trans`（`sql/handler.cc:1756`）的状态机：

1. 统计 `rw_ha_count`（有实际写的引擎数），只读事务快速路径
2. 多引擎：逐引擎 `prepare_or_error` → **`tc_log->log_and_order()`** → 逐引擎 commit
3. 崩溃恢复对偶：`ha_recover()`（handler.cc:3171）由 `tc_log->open()` 驱动，commit_list 里的 XID `commit_by_xid`，不在的 `rollback_by_xid`

协调者选择器（`sql/log.h:1553`）揭示了 MariaDB 的一个核心设计：**binlog 开启时它本身就是事务协调日志**（`MYSQL_BIN_LOG : public TC_LOG`），组提交 + `commit_ordered` 定序都在 binlog 侧；binlog 关闭但多引擎 2PC 时退化到 `TC_LOG_MMAP`。`commit_ordered`/`prepare_ordered` 是 MariaDB 相对 MySQL 的扩展——保证"提交顺序"在引擎和 binlog 之间全局一致，且引擎可借此省一次 fsync（`sql/handler.h:1500` 附近长注释有完整论证）。

### ha_partition：包装 N 个 handler 的"元 handler"

`ha_partition : public handler`（`sql/ha_partition.h`，12.7k 行，degree 406）是"包装器扇出"的教科书案例：

- **构造即建数组**：`create_handlers()`（ha_partition.cc:3002）对每分区 `m_file[i] = get_new_handler(...)` ——分区层复用与普通表完全相同的工厂
- **write_row = 路由**（:4592）：`m_part_info->get_partition_id(...)` 算出 part_id → 检查 `lock_partitions` 位图 → `m_file[part_id]->ha_write_row(buf)`（注意调子 handler 的 **ha_ 包装**，不丢统计/PSI）
- **rnd_next = 顺序迭代**（:5360）：当前分区 EOF 就 `bitmap_get_next_set(&m_part_info->read_partitions)` 切下一个——**partition pruning 直接体现为位图跳过**
- **position 编码分区号**（:5459）：`int2store(ref, m_last_part)` + 子 handler ref，SQL 层无感知地拿到"分区号+行位置"复合 rowid（`PARTITION_BYTES_IN_POS == 2`，ha_partition.h:37）

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 工厂方法 | `handlerton::create` + `get_new_handler`（handler.cc:381） | server 不感知具体引擎类；不可用回退默认引擎 |
| 桥接 | `ha_innobase : public handler` 持 `row_prebuilt_t` | SQL 行格式与引擎内部格式的转换模板 |
| 装饰器 | `ha_partition` 包装 `m_file[]` 数组 | 分区语义对 SQL 层与子引擎双向透明 |
| 状态机 | `handler::init_stat`（NONE/INDEX/RND） | 禁止 rnd/index 混用，协议错误早暴露 |
| 观察者 | `trans_register_ha` 把引擎挂进 `thd->transaction->all` 链表 | 首次写入才注册，两阶段提交知道参与者集合 |

## 模块间交互

- **上游**：优化器经 `best_access_path` 读 `table_flags()`/`index_flags()` 估价（见[优化器与执行器](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/02-optimizer)）；执行循环经 `ha_rnd_next`/`ha_index_next` 拉行
- **下游**：22 个 `storage/` 引擎实现 handler 虚函数（InnoDB 见[InnoDB](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/04-innodb)）
- **横切**：binlog 作为 transaction_participant（`log.cc:2007` 手工填 `binlog_tp`）参与 2PC；wsrep 的 observer hook 埋在 `prepare_or_error`/`ha_commit_trans` 的 `#ifdef WITH_WSREP` 缝里；MHNSW 向量索引也注册了 transaction participant（`vector_mhnsw.cc:1773`）——13.x 的 2PC 参与者不只是存储引擎
- **13.x 实验方向**：`handlerton::binlog_init`/`binlog_write_direct_ordered` 回调（`sql/handler.h:1643-1712`）+"binlog 引擎化"（binlog 存进 InnoDB 表空间）——细节待核实，属进行中工作

## 扩展方式

**新增一个存储引擎**（最小集，参考 `storage/example/ha_example.cc` 模板）：

1. `storage/foo/ha_foo.h/cc`：`class ha_foo final : public handler`，纯虚必实现：`open`/`close`/`rnd_init`/`rnd_next`/`position`/`info(uint)`/`create`；可选：`index_read_map`/`index_next`（索引）、`write_row`/`update_row`/`delete_row`（写）
2. `foo_init_func(void *p)`：填 handlerton（create 工厂、flags、`tablefile_extensions`、`table_options`）
3. `maria_declare_plugin(foo){ MYSQL_STORAGE_ENGINE_PLUGIN, &foo_storage_engine, "FOO", ..., foo_init_func, ... }`
4. `CMakeLists.txt`：`MYSQL_ADD_PLUGIN(foo ha_foo.cc STORAGE_ENGINE ...)`
5. 事务引擎再加 `transaction_participant::commit/rollback/prepare`，并记住**引擎内部起写事务时必须调 `trans_register_ha()`**（handler.cc:1429）

**新增一个 handler API 方法的影响面**：`sql/handler.h` 虚函数 + ha_ wrapper → 所有引擎默认实现（degree 475 的 fan-out）→ `ha_partition.cc` 包装器 fan-out → `MYSQL_HANDLERTON_INTERFACE_VERSION`（plugin.h:630，`= MYSQL_VERSION_ID << 8`）版本号变更，所有动态 .so 必须重编。
