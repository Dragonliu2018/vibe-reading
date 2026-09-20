---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "数据字典与 DDL"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "数据字典", "在线 DDL", "SDI", "原子 DDL"]
description: "DD 三层架构与两级缓存、31 张 mysql.* 系统表、SDI 序列化、I_S 视图化、ALTER 四算法与 instant DDL、CalVer 升级兼容的源码解读"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

数据字典（DD）是 8.0 对 MySQL 做的最深刻的架构重写：全部元数据（表/列/索引/外键/触发器/视图/统计）收进 InnoDB 事务表（`mysql.*` 一族 31 张），替换掉 5.7 时代散落的 `.frm/.par/.TRG/.opt` 文件。它解决的老问题：**元数据无法参与事务**（.frm 写一半崩溃即损坏、DROP TABLE 中途失败留下孤儿文件）、并发访问无统一缓存与锁、I_S 只能靠 server 内部临时表逐行 fill。DD 层之上还承载着 DDL 的执行语义——`mysql_alter_table` 的四种算法（COPY/INPLACE/INSTANT/DEFAULT）与 handler 三步在线 DDL 协议。

涉及文件：`sql/dd/`（~8 万行：types/impl/tables/cache/bootstrap/upgrade/info_schema）、`sql/sql_table.cc`（~21,000 行 DDL 主战场）、`sql/sql_alter.h`、`storage/innobase/handler/handler0alter.cc`（~11,600 行引擎侧实现）。

## 模块架构

```text
THD ──► Dictionary_client（每 session 一个，sql/dd/cache/dictionary_client.h:166）
          │ 本地 Object_registry（未提交 + 已提交两个 registry）
          ▼ miss
       Shared_dictionary_cache（进程级单例，sql/dd/impl/cache/shared_dictionary_cache.h:47）
          │ 每类型一个 Shared_multi_map，锁在各 map 内部（外层不加锁），
          │ 容量硬编码: collation 256 / charset 64 / event 256 / SRS 256 /
          │             column_statistics 32 / resource_group 32（表/视图/schema/tablespace 用默认容量）
          ▼ miss
       Storage_adapter（sql/dd/impl/cache/storage_adapter.h:55）
          │ m_core_registry 保存 bootstrap 期间的核心 DD 对象（charset 等元元数据）；
          │ s_use_fake_storage 在脚手架阶段模拟存储引擎；
          │ store() 时同步调 sdi::store()
          ▼
       mysql.* 系统表（31 张，sql/dd/impl/tables/，InnoDB 事务表）
          │
          ├── InnoDB：SDI B-tree 存表空间内部（dict_sdi_* 回调）
          └── 其他引擎：独立 .sdi 文件（sql/dd/sdi_file.cc）
```

抽象层 `sql/dd/types/`（36 个纯虚接口，如 `class Table : virtual public Abstract_table` in `table.h:47`）、实现层 `sql/dd/impl/types/`（同时实现接口与行持久化）、系统表层 `sql/dd/impl/tables/`（**表结构以 C++ 代码中的 SQL 片段声明**——`Tables::Tables()` 里 `m_target_def.add_field(FIELD_ID, "FIELD_ID", "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT")`，bootstrap 时用这些定义执行 DDL 建表）。

## 调用链路

### 读路径（一次 acquire）

```text
Dictionary_client::acquire (sql/dd/impl/cache/dictionary_client.cc:639)
① 查本地未提交 registry（DDL 读己之写）
② 查本地已提交 registry（Auto_releaser 栈管理作用域）
③ Shared_dictionary_cache::get（进程级共享，引用计数支持 eviction）
④ miss → Storage_adapter 读 mysql.* 表行 → 反序列化为 dd::Table 等对象
```

### CREATE TABLE

```text
Sql_cmd_create_table::execute (sql/sql_cmd_ddl_table.h:62)
→ mysql_create_table (sql/sql_table.cc:10937)        # MDL S→X 升级探测存在性
→ create_table_impl / rea_create_base_table (:1098)
→ dd::create_dd_user_table (sql/dd/dd_table.cc)       # HA_CREATE_INFO/Create_field → dd::Table
→ thd->dd_client()->store()                           # 写 mysql.tables 行 + sdi::store()
→ ha_create_table (sql/handler.cc:5374)               # handlerton::create 建物理表
→ 引擎回填 se_private_id 到 dd::Table，随语句原子提交
```

方法速查：

<details>
<summary>DD/DDL 方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Dictionary_client::acquire` in `dictionary_client.cc:639` | 四级查找 | 未提交对象只存本地——session 级读己之写 |
| `Storage_adapter::store` in `storage_adapter.cc:346` | 写 DD 行 | 同步 `sdi::store()` 保证表空间 SDI 一致 |
| `mysql_create_table` in `sql_table.cc:10937` | 建表编排 | 原子 DDL 引擎下整语句一个事务 |
| `mysql_alter_table` in `sql_table.cc:17317` | 改表编排（四算法判定） | 见下文 |
| `mysql_compare_tables` in `sql_table.cc:13666` | 新旧差异 → HA_ALTER_FLAGS | 算法判定的事实来源 |
| `dd_open_table` in `innobase dict0dd.cc:5412` | dd::Table → dict_table_t | 外键引用递归打开 |

</details>

## 核心实现

### 为什么用 DD 替换 .frm（代码可考的理由）

`sql/dd/impl/bootstrap/bootstrapper.h` 头注释列出设计原则，最核心的是**原子性**：升级时的原子切换通过 DML 直接改 DD 表中的 schema id 完成，"刻意不用 RENAME TABLE——它会自动提交从而破坏原子性"。加上：统一缓存 + MDL 让元数据并发成为一等公民；元数据变成 InnoDB 表后 I_S 才能视图化、ANALYZE 统计才能落到 `table_stats/index_stats`；引擎私有数据（`se_private_data` 键值 + `se_private_id`）与 server 元数据同事务提交——InnoDB 的表 id、instant 列元数据因此不再有"两张账"。

### 31 张 DD 系统表

`sql/dd/impl/tables/` 下每张表一个 `Object_table_impl` 子类：核心的 `tables/columns/indexes/index_column_usage/foreign_keys/check_constraints/table_partitions/table_stats/index_stats`（持久化统计）、`tablespaces/tablespace_files`、`routines/parameters/events/triggers`、`view_table_usage/view_routine_usage`（视图依赖跟踪）、`character_sets/collations/spatial_reference_systems/resource_groups`、以及特殊的 **`dd_properties`**——键值表存 `dd_version`/`I_S_version`/`P_S_version` 与每张 DD 表的注册信息，是唯一"永不允许改结构"的表（`dd_version.h:44` 注释）。

### SDI：可传输的元数据

`sdi::store`（`sql/dd/impl/sdi.cc:607`）按 handlerton 决定落点：InnoDB 注册了 `sdi_create/drop/get/set/delete` 回调（`ha_innodb.cc:5530-5535`），SDI 作为 **SDI B-tree 存在表空间内部**（自包含、可传输），写入走 `sdi_tablespace::store_tbl_sdi`；MyISAM 等无回调引擎写独立 `.sdi` 文件（`sdi_file::store_tbl_sdi`）。格式为 JSON（`SDI_VERSION=80019`，版本独立于 DD 表结构版本）。`FLUSH TABLES ... FOR EXPORT` 把 SDI 刷进 .ibd（`row0quiesce.cc`），`IMPORT TABLESPACE` 经 `row0import.cc` 读回——.ibd 在没有源实例 DD 的情况下也能重建元数据（配套 `ibd2sdi` 工具）。

### I_S 的视图化与 SHOW 的复用

`sql/dd/impl/system_views/` 下每个 I_S 表一个类：`Columns::Columns()`（`system_views/columns.cc:35`）构造的 `CREATE VIEW information_schema.columns AS SELECT ... FROM mysql.catalogs JOIN mysql.schemata ...`——**I_S 查询从此走普通优化器，谓词可下推**。SHOW 命令复用同一路径：`sql/dd/info_schema/show.cc`（54.7K）把 `SHOW COLUMNS/INDEX` 编译为对 I_S 视图的 SELECT——消灭"SHOW 与 I_S 不一致"这一历史 bug 类别。视图创建入口 `create_system_views()`（`info_schema/metadata.cc:430`）遍历 `dd::System_views` 注册表，对每个定义执行 `view_def->build_ddl_create_view()`（CREATE OR REPLACE VIEW），整个流程包在 `Disable_binlog_guard` 里抑制 binlog、强制 utf8mb3 字符集，完成后把 `I_S_version` 写入 dd_properties；`is_non_dd_based` 参数区分 INFORMATION_SCHEMA 与 NON_DD_BASED_INFORMATION_SCHEMA 两种视图集合。仍保留"真表"的只剩 9 个 `fill_schema_*`（`sql/sql_show.cc:3847` 起：PROCESSLIST、ENGINES、权限表族）。I_S 结构变更纳入版本化：变更史记录在 `info_schema/metadata.h:32` 起。

### ALTER TABLE：四算法与三步协议

算法枚举（`sql/sql_alter.h:366`）：`DEFAULT`（inplace 优先否则 copy）/`INPLACE`/`INSTANT`/`COPY`。`mysql_alter_table`（`sql_table.cc:17317`）的判定顺序：

1. 强制 COPY：`old_alter_table` 变量、换引擎（`is_inplace_alter_impossible`）、非原生分区变更；
2. 问引擎：`check_if_supported_inplace_alter`（`:18483`）返回 `HA_ALTER_ERROR/NOT_SUPPORTED/…_LOCK/INSTANT`；用户显式要 INSTANT 而引擎没给 → 直接报错；
3. 关键规则（`:18531` 注释）："任何 instant 操作事实上也是 in-place 操作"——INSTANT 无副作用时 INPLACE 请求也可走 INSTANT。

handler 三步在线 DDL 协议（`sql/handler.h:6503` 注释区）：Phase 1 编译新旧差异为 `HA_ALTER_FLAGS`（`mysql_compare_tables` in `sql_table.cc:13666`）；Phase 2 依次 `ha_prepare_inplace_alter_table` → 降锁 → `ha_inplace_alter_table`（主工作）→ 升 X 锁 → `ha_commit_inplace_alter_table`；Phase 3 原子 DDL 引擎把新 `dd::Table` 存进 DD 并整语句 `trans_commit_stmt` 提交。

### InnoDB instant DDL：零拷贝改表

白名单 `INNOBASE_INSTANT_ALLOWED`（`handler0alter.cc:158`）：列改名、加减虚列、加/删存储列、调整列序。分类由 `innobase_support_instant()`（`:830`）完成，结果类型 `Instant_Type`（`storage/innobase/include/dict0inst.h:40`）：`IMPOSSIBLE`（flag 超白名单，或升级线程上强制禁用）/ `NO_CHANGE`（无实质变更）/ `COLUMN_RENAME`（仅列改名）/ `VIRTUAL_ONLY`（仅虚列增删）/ `ADD_DROP_COLUMN`。instant 的全部代价是 **DD `se_private_data` 元数据 + rec 读取时按版本补默认值**（`rec_get_nth_field_instant`，`:2310`）——旧版本记录里没有新列，靠版本元数据（`n_instant_cols`、row version，上限 64 版）补默认值。每次 instant ADD/DROP bump row version，超限回落 INPLACE；空表默认走 INPLACE 以避免 bump row version（`:1067` 注释）。执行侧 `inplace_alter_table_impl()`（`:6135`）开头 `is_instant(...)` 直接返回 no-op，真正变更在 `commit_inplace_alter_table_impl()` 的 `executor.commit_instant_ddl()`（`:1628`）。

### 版本治理与 CalVer 升级

`DD_VERSION = 90200`（`sql/dd/dd_version.h:236`，26.7 的 DD 表结构与 9.2 以来无变化所以停在 90200——**DD 版本独立于 server 版本**，结构没变就不必升级 DD）。降级默认禁止 minor 降级（路径组合爆炸、QA 成本，注释原话）。表结构升级走 `dd::upgrade::upgrade_tables()`（`sql/dd/impl/upgrade/dd.cc:1102`）：建临时 schema → 建/删表集 → `update_meta_data()`+`migrate_meta_data()` → 单事务原子切换 schema id。**5.7 直升路径已移除**（8.0 的 `sql/dd/upgrade/57/` 在 26.7 树中不存在，仅剩 observer 钩子痕迹）。26.x 新增 CalVer 跨版本判定 `Server_version_transition::evaluate()`（`sql/dd/impl/bootstrap/server_version_transition.cc`）：9.7 是最后一条 legacy LTS 线，首个 calendar 版本 26.7.0 的兼容 lineage 由 `MYSQL_PREVIOUS_LTS_VERSION=9.7.0` 定义——同 lineage 前向升级接受；跨 lineage 仅"从 LTS 源进入以其为 base 的新 lineage"接受；跨多 lineage / 跳过 LTS 线（如 8.4→26.7 返回 `INVALID_SERVER_UPGRADE_SKIPS_LTS_LINEAGE`）/ Innovation 间 patch 降级（返回 `NO_PATCH_DOWNGRADE_FOR_INNOVATION_RELEASES`）一律拒绝；超出来源版本 upgrade_threshold 则返回 `BEYOND_SERVER_UPGRADE_THRESHOLD`。由 `bootstrapper.cc:1185` 在启动时调用并写错误日志。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两级缓存 + 作用域释放 | session registry + `Auto_releaser` 栈 / shared cache | "本语句还用着哪些对象"成为词法作用域问题；eviction 靠引用计数 |
| 三层分离 | types / impl / tables | 接口稳定、实现可换、表定义即代码 |
| 策略 | 四算法 × 引擎 `check_if_supported_inplace_alter` | DDL 并发代价由引擎按操作自报 |
| 模板 SQL | `Object_table_impl` 内嵌 DDL 片段 | bootstrap 不需要磁盘上的自举元数据 |

## 模块间交互

- **上游**：所有开表路径经 `Dictionary_client` 拿 `dd::Table`；`TABLE_SHARE`/表缓存以其为缓存前端；
- **与 InnoDB**：`dd_open_table` 翻译、`se_private_data` 双向同步、SDI 写表空间（见[InnoDB 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/06-innodb)）；
- **与统计**：`table_stats/index_stats/column_statistics`（直方图 JSON）是优化器基数估计的输入（见[优化器模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/03-optimizer)）；
- **与 I_S/P_S**：I_S 视图化；P_S 以 plugin native table 方式注册（`create_native_table` 只写 DD 元数据、跳过 `handler::create()`）。

## 扩展方式

- **给 mysql.tables 加一列**：`types/table.h` 虚接口 → `impl/types/table_impl.cc` 成员 + `store/restore` + SDI 字段 → `impl/tables/tables.cc` 的 `add_field` SQL 片段 → `dd_version.h` bump DD_VERSION 写变更说明 → 需要数据迁移则 `upgrade/dd.cc` 加版本分支 → 暴露给 I_S 则 `system_views/` 对应视图加字段；
- **新增一种 instant DDL 操作**：`sql/handler.h` 的 `HA_ALTER_FLAGS` 新 bit + `mysql_compare_tables` 设置 → InnoDB 白名单 `INNOBASE_INSTANT_ALLOWED` 加 flag → `innobase_support_instant()`（`:830`）加分支 → 提交路径把元数据写 `se_private_data`（`dd_commit_inplace_update_instant_meta`，`:4204`）；
- **回归注意**：row version 上限、`error_if_not_empty`、显式 `ALGORITHM=INPLACE` 时的回落语义（`handler0alter.cc:1035-1105` 的注释是判据清单）。
