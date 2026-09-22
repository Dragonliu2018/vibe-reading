---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "插件框架与安全"
date: "2026-09-22T22:50:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C", "插件框架", "ACL", "角色", "audit", "services", "数据类型插件"]
description: "MariaDB 插件框架与安全体系解读——st_maria_plugin ABI 三重门禁、services 手工动态链接器、角色=无 host 的用户（两遍 DFS 传播）、数据类型插件化（MySQL 无此机制）、audit 三段式零开销分发全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

插件框架（`sql/sql_plugin.cc` 4.6k 行 + `include/mysql/plugin.h`）是 MariaDB 一切可扩展性的地基——22 个存储引擎、50 个 plugin/ 目录、数据类型、认证、审计、加密全部经它装载。安全体系（`sql/sql_acl.cc` 17.4k 行 + `sql/sql_audit.cc`）叠加其上：ACL/角色 + audit API。这层最重要的架构事实有两个：**services 是"手工动态链接器"**（插件不能直接引用 server 符号）；**数据类型插件化是 MariaDB 独有机制**（MySQL 没有）。

## 模块架构

插件的双层描述符是理解入口：**`st_maria_plugin`**（`include/mysql/plugin.h`）是插件作者填充的扁平 C 结构——`type`（12 种插件类型之一）+ `info`（类型专属描述符，其第一字段必须是 `interface_version`）+ init/deinit 回调 + sysvar 数组。MariaDB 版比 MySQL 兼容版多 `version_info`/`maturity` 两字段。**`st_plugin_int`**（`sql/sql_plugin.h:109`）是 server 侧记账句柄：`state` 五选一单值态（FREED/DELETED/UNINITIALIZED/READY/DYING/DISABLED）、`ref_count`、`data`（类型专属数据如 handlerton）、`mem_root`。

12 种插件类型（`plugin.h:92-110`）：STORAGE_ENGINE、FTPARSER、DAEMON、INFORMATION_SCHEMA、AUDIT、REPLICATION、AUTHENTICATION、PASSWORD_VALIDATION、ENCRYPTION、**DATA_TYPE**、FUNCTION、UDF（未实现）。`plugin_type_initialization_order[]`（sql_plugin.cc:142）声明依赖顺序——**encryption 与 data_type 先于 storage engine**（引擎加密和行格式里的类型都依赖它们）。

## 调用链路

**启动加载**（`plugin_init()`，sql/sql_plugin.cc:1591）：

```
1. 初始化 plugin_hash[MYSQL_MAX_PLUGIN_TYPE_NUM]  ★每类型一个名字哈希表
2. 注册静态插件: mysql_mandatory_plugins[] → mysql_optional_plugins[]（只登记不初始化）
3. 先单独初始化 MyISAM (:1700-1716)   ← 后续初始化都要能打开/写表，需先有默认表引擎
4. 解析 --plugin-load 命令行
5. 按类型顺序批量初始化（重试循环，SPIDER 这类有依赖的引擎走 HA_ERR_RETRY_INIT）
   分发表 plugin_type_initialize[] (:123): { 0, ha_initialize_handlerton, 0, 0,
                                              initialize_schema_table, initialize_audit_plugin, ... }
6. plugin_load() (:1905) 读 mysql.plugin 表恢复动态插件
```

**动态 .so 加载**：`plugin_dl_add()` 用 dlsym 找 `_maria_plugin_interface_version_`/`_maria_plugin_declarations_`（sql_plugin.cc:165-170 的符号名锚点），**找不到 MariaDB 符号再回退 MySQL 兼容符号**——兼容历史 .so 的同时允许 MariaDB 结构演进。

<details>
<summary>plugin/ 50 目录的类型全景</summary>

| 类别 | 目录 | 代表 |
|---|---|---|
| 认证（10） | auth_socket/auth_ed25519/auth_pam/auth_gssapi/auth_parsec/auth_mysql_sha2 等 | ed25519：不依赖密码哈希的椭圆曲线认证 |
| 审计（2） | server_audit / audit_null（空模板） | 见下文 |
| 密钥管理（5） | file/aws/hashicorp/debug/example_key_management | file：keyfile + AES 加密密钥文件本身 |
| 压缩 provider（5） | provider_bzip2/lz4/lzma/lzo/snappy | 供 InnoDB/引擎页压缩调用 |
| **数据类型（8）** | type_inet/type_uuid/type_mysql_json/type_cursor/type_xmltype/type_assoc_array/type_mysql_timestamp/type_test | inet4/inet6 两个类型插件 + 一串函数插件同 .so 声明 |
| 全文（1） | fulltext/plugin_example.c | 最小可运行示范 |
| I_S 表插件（~8） | disks/metadata_lock_info/query_response_time/userstat 等 | userstat 扩展 USER_STATISTICS 等 4 张表 |
| 其他 | handler_socket（绕过 SQL 层的 NoSQL 通道）、versioning（REPLICATION 钩子实现 AS OF 查询） | |

**澄清**：`type_geom` 不是 DATA_TYPE 插件（plugin.cc:212 声明的是两个 I_S 表）；geometry 的 `Type_handler_geometry` 本体内置在 `sql/sql_type_geom.cc`。

</details>

## 核心实现

### ABI 三重门禁

`st_maria_plugin` 的加载校验有三道，任何一道失败都拒绝装载：

1. 框架级 `_maria_plugin_interface_version_`（0x0110）dlsym 校验
2. **`sizeof(struct st_maria_plugin)` 字节级比对**——结构大小即 ABI 门禁，防字段布局漂移
3. 每类型 `interface_version`（如 `MYSQL_AUDIT_INTERFACE_VERSION 0x0303`）

### services：手工动态链接器

动态插件 .so **不能直接引用 server 符号**（mariadbd 不导出内部 C++ 符号）。解法是**结构体函数表 + 加载期指针改写**（`sql_plugin.cc:816-851`）：

```c
// include/mysql/service_thd.h
extern struct thd_service_st {
  MYSQL_THD (*get_current_thd)(void);
} *thd_service;
#ifdef MYSQL_DYNAMIC_PLUGIN
# define get_current_thd() thd_service->get_current_thd()   // 间接调用
#else
  MYSQL_THD get_current_thd();                               // 静态插件直接调用
#endif
```

server 在 `plugin_dl_add()` 里 dlsym 找到 .so 数据段的 `thd_service` 指针（当前存的是版本号占位），校验版本后**直接把 server 侧函数表地址写进插件的全局变量**，原值存 `st_ptr_backup` 供 dlclose 还原。`list_of_services[]` 共 31 项（`sql/sql_plugin_services.inl:351`）：thd_service、thd_alloc（插件必须用 THD mem_root）、thd_specifics（per-THD 槽位）、sql_service（让 handler_socket 这类插件本地执行 SQL）、encryption、5 个压缩 provider 等。**Why**：插件 ABI 的完全受控——server 任何重构都不破坏插件，代价是新增 service 要走 7 步模板（`libservices/HOWTO`）。

### ACL 与角色：内存 DAG + 两遍 DFS

类层次（`sql/sql_acl.cc:143-331`）：`ACL_USER_BASE`（公共基类）→ `ACL_USER`（认证参数 `AUTH *auth` **是数组**——一个账号可对不同 client 插件挂不同认证条目）与 **`ACL_ROLE`（角色与用户同基类）**——"角色 = 无 host 的用户"是 MariaDB 角色模型的实现起点（`mysql.user` 表里角色就是 host 为空的行）。

授权关系是内存 DAG：`ACL_USER_BASE::role_grants`（正向边）+ `ACL_ROLE::parent_grantee`（反向边）。权限**沿图向上合并**用两遍 DFS（`propagate_role_grants()`，sql_acl.cc:7827-7878）：

```cpp
// sql/sql_acl.cc:7876
traverse_role_graph_up(role, &data, init_role_for_merging, count_subgraph_nodes);
traverse_role_graph_up(role, &data, NULL, merge_role_privileges);
```

**Why 两遍**：若 role1→role2、role1→role3、role3→role2，必须先合并完 role3 才能合并 role2——`ACL_ROLE::counter` 记录"本子图内待处理的父节点数"，第二遍归零才执行合并。`traverse_role_graph_impl`（:7917）返回 `ROLE_CYCLE_FOUND` **在授予时即检测环**。历史注：MariaDB 角色于 10.0（2013）落地，早 MySQL 8.0 约 5 年。

### audit：三段式零开销分发

事件模型精简为 3 类（`include/mysql/plugin_audit.h`）：GENERAL（0）/ CONNECTION（1）/ **TABLE（15——2-14 被 MySQL 历史占用，新类跳号）**。插件端描述符极小：`event_notify` 统一入口 + `class_mask[]` 订阅位图。分发核心 `mysql_audit_notify()`（sql_audit.cc:412-439）的三段优化，全部围绕"不让每条 SQL 都锁全局插件表"：

1. **全局掩码短路**：`mysql_global_audit_mask` 与事件类位与——无插件订阅时事件构造都被跳过
2. **线程级缓存**：THD 首次遇到某事件类时 `mysql_audit_acquire_plugins()`（:112）锁定感兴趣的插件进 `thd->audit_class_plugins`，后续直接遍历缓存
3. **版本失效**：`thd->audit_plugin_version` 对比 `global_plugin_version`（INSTALL/UNINSTALL 递增），不一致清缓存重取

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 函数表注入 | services 指针覆写（sql_plugin.cc:817-837） | .so 与 server 解耦，版本协商在数据段完成 |
| 分发表 | `plugin_type_initialize[]`（sql_plugin.cc:123） | 12 种类型各自初始化路径，加类型不动 plugin_init |
| DAG + 拓扑序 | 角色授权图两遍 DFS（sql_acl.cc:7876） | 依赖合并的正确性，环检测免费 |
| 观察者 | audit class_mask + `mysql_audit_*` 内联分发（sql/sql_audit.h） | 插件按需订阅，无订阅零成本 |

## 模块间交互

- **与存储引擎**：`ha_initialize_handlerton` 由类型分发表接管（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）；Aria 是 MANDATORY、MyISAM 必须最先初始化（临时表依赖链）
- **与类型系统**：`initialize_data_type_plugin()`（sql/sql_type.cc:9903）把插件名反向注入 `Type_handler`（`set_name`）——**类型 ABI = `MYSQL_VERSION_ID << 8`，与 server 版本严格绑定，不做跨版本兼容**（类型语义太深做不到）
- **与 SQL 层**：`sql_builtin.cc.in` 模板把 binlog、mysql_password、mhnsw 三个插件**无条件硬编码**进 mandatory 数组
- **debug 技巧**：`plugin_ref` 在 debug build 是双重指针——`intern_plugin_lock()` 把 `st_plugin_int` 第一个成员地址写入自身，悬垂引用在锁检测中立即暴露（sql_plugin.h:132-154）

## 扩展方式

**新增一个 audit 插件**：① 建 `plugin/my_audit/`，实现 `auditing(MYSQL_THD, event_class, event)` 按 class downcast；② 静态 `st_mysql_audit descriptor = { MYSQL_AUDIT_INTERFACE_VERSION, NULL, auditing, {MYSQL_AUDIT_CONNECTION_CLASSMASK} }` + `maria_declare_plugin`（照抄 `server_audit.cc:2221-2261`）；③ `MYSQL_SYSVAR_*` 宏声明 sysvar；④ CMakeLists 一行 `MYSQL_ADD_PLUGIN(my_audit my_audit.cc MODULE)`。server 侧零改动——事件点已埋在 `sql/sql_audit.h` 的内联函数。**注意**：需要新的 event class 才动 `plugin_audit.h`（类号跳号，2-14 已被历史占用）。

**新增一个数据类型插件**：① `class Type_handler_mytype : public Type_handler`（参考 `plugin/type_inet/plugin.cc:178-195` 完整模板，含同 .so 捆绑 FUNCTION 插件的写法）；② `st_mariadb_data_type descriptor = { MariaDB_DATA_TYPE_INTERFACE_VERSION, &type_handler }`；③ 需要函数就并列声明 `MariaDB_FUNCTION_PLUGIN` 条目。解析器无需改动（类型名经 `plugin_hash[DATA_TYPE]` 解析）。**实际约束**：DATA_TYPE 插件基本只能静态编译（列格式/frm 是 server 级约定，动态加载的类型插件建的表在插件禁用后不可读）。
