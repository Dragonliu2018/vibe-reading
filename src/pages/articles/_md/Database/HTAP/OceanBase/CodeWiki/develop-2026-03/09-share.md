---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "Schema 与共享服务"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "多版本 Schema", "location cache", "mClock", "生成代码"]
description: "OceanBase 共享服务：多版本 schema COW 快照与双 allocator 换页、双层 location 缓存、mClock IO 调度与消灭手写样板的生成代码体系。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/share/`（~192 万行，其中 80.9 万行是 `inner_table/` 生成代码）被几乎所有模块依赖——实测 `#include "share/schema/..."` 1409 处、866 个文件（sql 148 / rootserver 104 / storage 103 / observer 66 / logservice 21）。四块核心：**多版本 schema 服务**（一致性读的基石）、**location cache**（双层位置缓存）、**IO 框架**（mClock 多租户隔离）、**统计信息与系统变量**。`GSCHEMASERVICE` 单例宏是事实上全局服务定位器。

## 模块架构

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `ObMultiVersionSchemaService` | `schema/ob_multi_version_schema_service.h:158` | 顶层：多版本快照缓存管理（三层继承链的顶层） |
| `ObServerSchemaService` | `schema/ob_server_schema_service.h:488` | 单 observer 的刷新引擎（refresh full/increment） |
| `ObSchemaMgr` | `schema/ob_schema_mgr.h:484` | 某版本的全内存目录快照 |
| `ObSchemaMgrCache` | `schema/ob_schema_mgr_cache.h:116` | 定长 slot 数组 + 引用计数 |
| `ObSchemaGetterGuard` | `schema/ob_schema_getter_guard.h:126` | 读侧 RAII 引用（400+ get_xxx） |
| `ObLocationService` | `location_cache/ob_location_service.h:34` | 位置门面（组合三个子 service） |
| `ObIOManager` / `ObTenantIOManager` | `io/ob_io_manager.h:327/448` | 进程级 / 租户级 IO 调度 |
| `ObOptStatManager` | `stat/ob_opt_stat_manager.h:36` | 统计信息（挂 KVCache） |
| `ObSysVarFactory` | `system_variable/ob_system_variable_factory.h:6148` | 系统变量工厂（生成代码） |

## 调用链路

### schema 增量刷新（DDL 广播 → SQL 可见）

```
RS notify / 定时刷新
→ ObMultiVersionSchemaService::refresh_and_add_schema     ob_multi_version_schema_service.cpp:2687
  └─ refresh_tenant_schema :3017（比较 refreshed vs received 版本，相等即跳过）
     └─ ObServerSchemaService::refresh_schema             ob_server_schema_service.cpp:6507
        └─ refresh_increment_schema :6995
           ├─ get_increment_schema_operations             读 __all_ddl_operation 算 SchemaOperation
           ├─ replay_log(schema_mgr_for_cache, ops)       在"影子" mgr 上重放
           └─ update_schema_mgr → publish_schema
→ ObMultiVersionSchemaService::publish_schema → add_schema :2298
  └─ alloc_and_put_schema_mgr_ :2393
     new_mgr->assign(latest)（COW 拷贝）→ schema_mgr_cache.put（slot 原子替换）
     → 满足条件 switch_allocator_（双 allocator 换页）
     → schema_store->update_refreshed_version（原子推进水位）
```

增量三级次序刻意为之：先 core 表 → 再 sys 表（core 变了整体重试 `OB_EAGAIN`）→ 最后普通表。**失败时把 mgr 版本拨回 `local_schema_version`**（:7112 注释 "avoid missing increment ddl operations"）——否则下一轮以错误基线算增量会永久丢 DDL。

### IO 请求分发（group 隔离 + mClock）

```
调用方构造 ObIOInfo{tenant_id, fd, flag(含 group_id), callback}
→ ObIOManager::aio_read → ObTenantIOManager::inner_aio     ob_io_manager.cpp:2126
   └─ alloc_req_and_result → qsched_.schedule_request（V2 树形 WFQ）或 io_scheduler_
      └─ 按 group_id 找 ObPhyQueue（每组一个物理队列）
      └─ ObTenantIOClock::calc_phyqueue_clock               mClock 三时钟算 deadline
      └─ ObIOSender::run1 → pop_and_submit（最小 deadline 堆）
         → ObDeviceChannel → 完成 → ObIOCallbackManager 回调
```

## 核心实现

### 磁盘表 + 内存全量快照的 schema 模型

磁盘上 `__all_table`/`__all_*_history` 追加历史；内存 `ObSchemaMgr` 存每版本完整目录（tenant/database/table 索引 + ~25 个子 Mgr + 十余个 hash 索引）。为什么：SQL 每条语句都要按 table_id/name 高频查 schema 且需要版本一致性读——DB 磁盘查询不可接受；多版本（事务/合并/schema version 对齐）需要按任意 version 取快照。两级表结构：缓存里只存 `ObSimpleTableSchemaV2`（轻量），完整 `ObTableSchema`（列/约束/外键）按需从 KVCache 或磁盘物化——`ObSchemaGetterController` 用 `constructing_keys_` HashSet + 256 cond slot 做 single-flight 并发去重。

**引用归因缓存**：`ObSchemaMgrItem::mod_ref_cnt_[MOD_MAX]`（17 种来源）+ `ObSchemaGetterGuard::mod_`——slot 满淘汰时 dump 打印谁在长时间持引用，泄漏可归因（`ob_schema_mgr_cache.h:64-93`）。slot 数量上限分两套：常规 cache `MAX_VERSION_COUNT`、liboblog 回退 cache `MAX_VERSION_COUNT_FOR_LIBOBLOG`（`ob_multi_version_schema_service.h`，后者更大以支撑 CDC 回放旧日志）；`ObSchemaMgrCache::put` 满时经 `find_dst_item_for_put` 选 ref_cnt 为 0 且版本最旧的 slot 驱逐，找不到则返回 `OB_EAGAIN` 下轮重试。`max_cached_num_` 只增不减——租户调大 `_max_schema_slot_num` 立即生效、调小等旧 slot 自然淘汰。

### 双 allocator 换页

`ObSchemaMemMgr` 持 `union { ObArenaAllocator allocator_[2]; }`——`ObArenaAllocator` 只能整体 free，旧页 schema 只能等 slot 轮换满（`check_can_switch_allocator(switch_cnt)`）后换页回收。这是 schema 内存可控的核心。

### fallback / 受控回溯

常规 cache miss（slot 被淘汰）时按需从 history 表重放构造旧版本（事务持长 guard、liboblog 回放旧日志需要）；`FORCE_FALLBACK` 模式走独立 cache 防回溯流量占满常规 slot 引发 OOM（:1537-1538 注释）。

### location 双层缓存

`ObTabletLSMap`（tablet→LS，64K 桶）与 `ObLSLocationMap`（LS→replicas，256 桶）分层。为什么：tablet 数量比 LS 多三个量级，**leader 切换只需失效 LS 层，tablet 层不动**。失效是错误驱动的：SQL 执行遇 `OB_NOT_MASTER` → `batch_renew_tablet_locations`——当前 `gen_renew_type_` 恒返回 `RENEW_BOTH`（`ob_location_service.cpp:491`，历史 bug 教训后的保守化）。renew 风暴防护：sys/meta/user 三条独立任务队列（user 队列 10000 容量）。

### mClock IO 调度

三层时钟即 mClock 算法：reservation（min，保 SLA）/ limitation（max，防独占）/ proportion（weight，按付费比例）——`GroupConfig{min_percent_, max_percent_, weight_percent_}` 来自资源计划 directive。租户间公平由 `adjust_tenant_clock` 周期对齐。V1 调度器与 `_enable_tree_based_io_scheduler` 的 V2（支持共享存储七资源维度）并存。

### 生成代码消灭手写样板

- **系统变量**：`ob_system_variable_init.json`（394KB）→ `gen_ob_sys_variables.py` → 工厂 926KB。`OB_SYS_VARS_COUNT=749`，id 直接偏移寻址（`calc_sys_var_store_idx`），会话建连时全量物化指针数组；ID 只能追加不能复用（兼容升级序列化）。
- **内部表**：`ob_inner_table_schema_def.py`（2.8MB）→ `generate_inner_table_schema.py` → 111 个分片 cpp（80.9 万行）。表 ID 落在区间常量内（core<100、sys<10000、mysql 虚表<15000…）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Copy-on-write 快照发布 | `alloc_and_put_schema_mgr_` + `ObSchemaMgrHandle` 引用计数 | 读完全无锁，写只串行化在 slot 写锁内 |
| 双 buffer（allocator 换页） | `ObSchemaMemMgr::allocator_[2]` | arena 整体释放语义下的内存回收 |
| 错误驱动缓存失效 | `gen_renew_type_` + `expire_renew_time` 参数化 | 把同步/异步/容忍度折叠进一个 int64 |
| 门面 + 组合 | `ObLocationService` 组合三个子 service | tablet/LS/vtable 三种位置语义统一 |
| single-flight | `ObSchemaGetterController` | 并发物化同一 schema 去重 |

## 模块间交互

sql/resolver（guard 取 schema）、storage（SSTable/事务快照记 schema_version 定位）、rootserver（DDL 落盘+广播）、observer（DDL handler、虚拟表）、logservice（location adapter 反查 leader）全员依赖。location_cache 反向依赖 schema（renew 时判断死租户）。IO 被 logservice/storage/observer 依赖；sys IO（SLOG/CLOG）在 `inner_aio` 特判绕过数据盘致命错误检查。

## 扩展方式

- **新增一个系统变量**：`system_variable/ob_system_variable_init.json` 加条目 → 跑 `gen_ob_sys_variables.py` 重新生成三份文件 → 会话/更新链路零手写
- **新增一种 schema 对象类型**（ai_model、ccl_rule 等都是现成样板）：定义 Schema struct + Mgr（挂进 `ObSchemaMgr`）+ getter guard `.ipp` + DDL 落盘 service + `fetch_increment_schemas` 的宏列表追加一行 `GET_BATCH_SCHEMAS(...)`
- **新增一张内部表**：`ob_inner_table_schema_def.py` 加 schema 定义 → 重新生成分片 cpp
- **新增 IO group**：运行时路径 DBA `CREATE RESOURCE PLAN/DIRECTIVE` → `ObResourcePlanManager`（`resource_manager/ob_resource_plan_manager.cpp:418`）→ `init_group_index_map` → `ObPhyQueue` 建立，mclock 生效
