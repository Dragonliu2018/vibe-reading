---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "扩展加载与双许可桥"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "双许可", "ABI 桥"]
description: "TimescaleDB 三层 .so 接力加载、_PG_init 钩子注册与 CrossModuleFunctions 函数指针表双许可桥机制解读"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

这个模块解决一个看似矛盾的需求：**Apache 2.0 开源代码要调用 Timescale License 企业代码，却不能在编译/链接期依赖它**。TimescaleDB 的解法是三层 `.so` 接力加载 + 一张运行时函数指针表（`CrossModuleFunctions`）。它处在整个扩展的最底层——loader 引导加载、Apache 主体注册钩子、TSL 在运行时"合闸"把指针表切到真实实现。没有这一层，上面的压缩、连续聚合、向量化等企业功能都无法被开源核心调用。

## 模块架构

模块内核心组件按加载时序分为三组：

- **loader（`src/loader/loader.c`）**：唯一在 `shared_preload_libraries` 阶段加载的 `.so`。注册 `post_parse_analyze_hook` 作为延迟触发点，注册 shmem/license GUC，拉起集群级 BGW launcher。
- **Apache 主体（`src/init.c` + `src/cross_module_fn.c`）**：`_PG_init` 注册所有 PG 钩子（process_utility/planner/executor）；`cross_module_fn.c` 定义 `CrossModuleFunctions` 结构体、`CROSSMODULE_WRAPPER` 宏、`ts_cm_functions_default` 默认桩表。
- **TSL 主体（`tsl/src/init.c`）**：`ts_module_init` 把全局指针 `ts_cm_functions` 切到 `&tsl_cm_functions`，并初始化 TSL 专有节点（columnar_scan/vector_agg/skip_scan）。

三组之间的关键纽带是全局指针 `ts_cm_functions`（`src/cross_module_fn.c`）：初始指向 `ts_cm_functions_default`（约 80 个字段全是 `error_no_default_fn_*` 报错桩），TSL 加载后一行赋值 `ts_cm_functions = &tsl_cm_functions` 切换到真实实现。这就是双许可桥的"合闸"。

## 调用链路

加载与委托的调用链：

```
shared_preload_libraries → loader _PG_init (loader.c:674)
  └─ 注册 post_parse_analyze_hook / shmem_hook / GUC
首条 SQL → post_parse_analyze_hook (loader.c:492)
  └─ extension_check → do_load (loader.c:736)
       └─ load_external_function("timescaledb-2.29.2.so", "ts_post_load_init")
            └─ ts_post_load_init (src/init.c:132)
                 └─ ts_license_enable_module_loading()
                      └─ license GUC assign_hook → tsl_module_init (tsl/src/init.c:213)
                           ├─ ts_cm_functions = &tsl_cm_functions  ← 合闸
                           └─ _columnar_scan_init / _vector_agg_init / ...

SQL 调用 compress_chunk → ts_compress_chunk (CROSSMODULE_WRAPPER 生成)
  └─ ts_cm_functions->compress_chunk(fcinfo)
       ├─ TSL 未加载 → ts_cm_functions_default.compress_chunk → error_no_default_fn_pg_community
       └─ TSL 已加载 → tsl_cm_functions.compress_chunk → 真实压缩
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `_PG_init` (loader.c:674) | loader 引导入口 | 不在此加载主体（preload 阶段无 DB 连接） |
| `post_analyze_hook` (loader.c:492) | 首条 SQL 后触发加载 | 延迟到有 DB 连接时才查 pg_extension |
| `ts_post_load_init` (src/init.c:132) | 解锁 TSL 加载 | 延迟到主体之后，避开并行 worker 链接顺序问题 |
| `ts_module_init` (tsl/src/init.c:213) | 切换 `ts_cm_functions` 指针 | 一行赋值实现双许可桥合闸 |
| `CROSSMODULE_WRAPPER` (cross_module_fn.c:18) | 生成 SQL 可调用包装 | 自动生成 80+ 委托函数，避免手写 |

## 核心实现

### CrossModuleFunctions 函数指针表

`CrossModuleFunctions`（`src/cross_module_fn.h:41`）是一个约 80 字段的 C 结构体，按功能域分两类字段：

- `PGFunction` 类型字段（约 70 个）：SQL 可调用函数，经 `CROSSMODULE_WRAPPER` 包装后注册为 PG C 函数，接受 `PG_FUNCTION_ARGS` 返回 `Datum`。如 `compress_chunk`、`merge_chunks`、`continuous_agg_refresh`。
- 非 PGFunction 的函数指针字段（约 20 个）：C 内部接口，仅供 Apache 代码内部调用，不暴露 SQL。如 `create_upper_paths_hook`（planner 钩子）、`job_execute`（后台任务执行器，`bool (*)(BgwJob *)`）、`compressor_init`（返回 `RowCompressor *`）。

```c title="src/cross_module_fn.h:41（节选）"
typedef struct CrossModuleFunctions
{
    PGFunction policy_compression_add;        /* SQL 可调用 */
    bool (*job_execute)(BgwJob *job);          /* C 内部接口 */
    void (*create_upper_paths_hook)(...);      /* planner 钩子 */
    PGFunction compress_chunk;                 /* SQL 可调用 */
    DDLResult (*process_cagg_viewstmt)(...);   /* C 内部接口 */
    /* ...约 80 个字段... */
} CrossModuleFunctions;
extern TSDLLEXPORT CrossModuleFunctions *ts_cm_functions;
extern TSDLLEXPORT CrossModuleFunctions ts_cm_functions_default;
```

### CROSSMODULE_WRAPPER 宏与默认桩

`CROSSMODULE_WRAPPER` 宏（`src/cross_module_fn.c:18`）自动生成符合 PG `PGFunction` 签名的包装函数：生成 `ts_##func` 作为 SQL 注册入口，函数体仅 `PG_RETURN_DATUM(ts_cm_functions->func(fcinfo))`。这让 70+ 个 SQL 可调用函数无需手写重复委托代码。

默认桩 `ts_cm_functions_default`（`cross_module_fn.c:301`）的每个字段都是 `error_no_default_fn_pg_community`，调用时报 `"function \"X\" is not supported under the current \"Y\" license"`，hint 提示升级。少数桩是 no-op：`tsl_postprocess_plan_stub`（社区版无需向量化后处理）、`preprocess_query_tsl_default_fn_community`。特殊桩 `process_compressed_data_in/out` 会先尝试 `ts_license_enable_module_loading()` 再检查指针——为 replication worker 中 TSL 未正常加载的场景兜底。

### 三层延迟加载的 why

加载顺序的设计是规避 PG 生命周期约束的精心安排：

- **loader 不在 `_PG_init` 加载主体**：`shared_preload_libraries` 在 `InitPostgres` 之前执行，此时没有数据库连接，无法查 `pg_extension` 判断扩展是否安装。改用 `post_parse_analyze_hook` 在首条 SQL 解析后触发。
- **Apache `_PG_init` 不加载 TSL**：`src/init.c:134` 注释明确——"if we load the tsl during _PG_init parallel workers try to load the tsl before timescale itself, causing link-time errors"。并行 worker 的库恢复机制独立加载 `.so`，若在 `_PG_init` 加载 TSL，worker 可能先于 Apache 主体加载 TSL，导致 TSL 符号找不到。延迟到 `ts_post_load_init` 确保主体先初始化。
- **license GUC 的 check/assign 两阶段**：`src/license_guc.c:26` 注释——check 阶段只 dlopen 不链接（check_hook 不允许抛异常），assign 阶段才 `ts_module_init` 切指针（assign_hook 必须不失败）。dlopen 与指针切换分离，避免事务提交路径上崩溃。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 函数指针表（vtable） | `CrossModuleFunctions` in `cross_module_fn.h:41` | 同一接口运行时切换实现，许可证隔离 |
| 抽象桥接 | Apache 经 `ts_cm_functions->func` 调 TSL | 编译期不链接 TSL，运行时 dlopen |
| 延迟加载 | `post_parse_analyze_hook` + `ts_post_load_init` | 规避 preload 阶段无连接、并行 worker 链接序问题 |
| 钩子链 | `prev_ProcessUtility_hook` 等 | 保存前 hook 再叠加，与其他扩展共存 |

## 扩展方式

新增一个跨模块（TSL）功能的完整步骤，注释写在 `src/cross_module_fn.h:24`：

1. `src/cross_module_fn.h`：`CrossModuleFunctions` 加字段 `PGFunction my_feature;`
2. `src/cross_module_fn.c`：加 `CROSSMODULE_WRAPPER(my_feature);`，`ts_cm_functions_default` 赋 `.my_feature = error_no_default_fn_pg_community`
3. `tsl/src/init.c`：`tsl_cm_functions` 赋 `.my_feature = my_feature`
4. `.sql`：`CREATE FUNCTION my_feature(...) AS 'timescaledb', 'ts_my_feature' LANGUAGE C`

社区版调用命中桩报错，企业版经桥走实现。`ts_tsl_loaded()`（`cross_module_fn.c:278`）提供 SQL 层检测：返回 `ts_cm_functions != &ts_cm_functions_default`。
