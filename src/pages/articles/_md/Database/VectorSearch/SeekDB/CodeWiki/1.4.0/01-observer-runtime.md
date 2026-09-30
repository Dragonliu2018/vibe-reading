---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "进程底座与单 Runtime"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "OceanBase", "C++", "进程架构", "服务定位器"]
description: "单 binary 三段式启动、60 个 mods_* 模块的唯一所有权装配、ObMultiTenant 消亡后的单 ObServerRuntime、embedded 嵌入式生命周期与三条 header-only API 窄缝"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

一个 `seekdb` 单 binary 里装下了 SQL 引擎、存储、palf 日志、rootserver 管理面、standby 备库协议、AI 服务——本模块回答「这些组件如何被装配、以什么顺序启动、资源如何分配」。seekdb v1.4.0 的底座是一次**外科手术式单体瘦身**：保留 OceanBase 单进程 observer 的启动骨架，但把多租户机器掏空成单 runtime、把 sql↔storage 的依赖环切成两条 API 窄缝、把集群级服务（rootserver/CDC）裁掉或进程内化。理解这一层的意义在于：v1.4.0 大量「删掉的东西」决定了剩余代码的形状——读者若拿上游 OceanBase 的心智模型来读 seekdb，会在 `omt/` 目录里找不到 `ObMultiTenant`，在 `rootserver/` 里找不到 `ObRootService`。

## 模块架构

```shell
src/observer/
├── main.cpp                  # 进程入口：mmap 栈 + daemon 化 + systemd 上报
├── ob_server.{h,cpp}         # ObServer：装配复合根（"structure aggregated but not logical processing"）
├── omt/                      # 原 ObMultiTenant 目录，现仅 10 文件
│   ├── ob_server_runtime_controller.{h,cpp}   # 单 runtime 控制器（OMT 模块入口）
│   ├── ob_server_runtime.{h,cpp}              # runtime 本体（无 tenant_id 字段）
│   ├── ob_ai_service.{h,cpp}                  # AI 服务模块 + Guard（权限与端点缓存）
│   └── ob_th_worker / ob_worker_processor     # 线程执行（瘦身保留）
├── mysql/                    # MySQL 协议（obmp_query 等命令处理器 + packet sender）
├── ob_srv_network_frame.cpp  # 网络框架（embedded 模式关闭 TCP）
└── composition/              # v1.4.0 新增：装配层（如 composition/retrieval/ 的 DAS 迭代器装配）
```

三个关键事实划出本模块的骨架：**ObServer 是模块唯一所有者**——约 60 个 `mods_*` 指针（`mods_trans_service_`、`mods_ai_service_`、`mods_px_pools_`…）由 `obs_construct_modules()` 在 boot 期创建（`ob_server.h:684-690` 注释 "ObServer is the sole owner; created by obs_construct_modules() at boot and bound into runtime service slots"），并以 `obs_init/start/stop/wait/destroy_modules()` 六段式显式管理生命周期；**ObServer 本体同时实现 11 个跨模块接口**（`memory_pressure_service() { return this; }`、`ai_endpoint_resolver() { return this; }` 等，`ob_server.h:235-246`）——简单能力不再包一层模块，复合根兼默认实现；**消费方只见接口**——SQL 层经 `gctx_` 或 OBSERVER 访问器拿到的全部是 `data_plane::`/`query::` 接口指针，例如 `optimizer_storage_service()` 声明返回 `data_plane::ObIOptimizerStorageService*`、实际返回的是 `storage::ObAccessService*`——这正是 api 化的运行时体现。

## 调用链路

启动三段式（构造一切 → 先就绪后监听 → 阻塞等待）：

```
main() (main.cpp:858)
└─ disable_hugepage_for_self_text()            # Linux: THP 不碰代码页，防启动变慢
└─ CALL_WITH_NEW_STACK(inner_main(), 1MB mmap 栈)  # 主线程长期当管理线程，栈尺寸受控
   ├─ change_signal_mask / parse_args          # --embedded / --role PRIMARY|STANDBY
   ├─ check_uid_before_start(CONF_DIR)         # 启动用户 ≠ etc/ 属主即拒绝，防误启破坏数据
   ├─ create_observer_softlink("run/seekdb")   # run/ 下建指向自身可执行文件的软链
   ├─ start_daemon("run/seekdb.pid") → 日志打开 log/seekdb.log（daemon 化之后，子进程持锁）
   ├─ mallopt(M_ARENA_MAX, 1)                  # glibc 单 arena，防多 arena 内存碎片
   ├─ lib::Worker worker + set_worker_to_thread_local  # 租户体系存在前先有内存归属上下文
   ├─ observer.init(opts, log_cfg)             # ↓ 见下
   ├─ observer.start()                          # ↓ 见下
   ├─ safe_sd_notify(0, "READY=1")              # dlopen libsystemd 动态上报就绪
   └─ observer.wait()                          # embedded: 起线程等最后一个客户端断开 → _Exit(0)
```

`ObServer::init()`（`ob_server.cpp:644`，构造一切、不启动服务）的主干顺序：`init_config` → SQL 静态工厂（`sql::init_sql_factories()` / `ObPreProcessSysVars::init_sys_var()`）→ `init_pre_setting()`（内存预算发布点：`set_memory_budget(GMEMCONF.get_server_memory_budget())`）→ `init_io()`（`ObIOManager` + IO 校准）→ `init_global_kvcache()` → `init_schema()`（**schema/配置元数据落进程内 SQLite**：`share::ObSQLiteConnectionPool meta_db_pool_`，`ob_server.h:450-451` 注明存 config 与 tablet_meta 表）→ `init_network()`（只构造不监听）→ `init_fts()` → `init_ob_service()` → `init_local_management_service()`（进程内 rootserver）→ `init_sql()/init_pl()/init_storage()` → `init_server_runtime()`（构造唯一 runtime）→ 尾部的定时任务族（`init_px_target_mgr()`、`ObDictCache::init()` 等）。

`ObServer::start()`（`ob_server.cpp:1116`）的顺序本身就是设计宣言：

```
signal_handle_.start() → startup_accel_handler_.start()   # 启动期并行任务池（启动完成后 destroy）
→ OB_STORAGE_OBJECT_MGR.start() → standby_module_->prepare_storage_replay()
→ server_runtime_controller_.start() → initialize_server_runtime()
    （create_bootstrap_runtime() 从 slog/super block 引导 → refresh_runtime_resources() → bring_up_runtime()）
→ local_management_service_.start_service() → ob_service_.start() → standby_module_->start()
→ config_mgr_.reload_config()        # 全部模块构造绑定后才允许组件配置生效
→ wait_for_server_runtime()          # 等 OB_TS_MGR.get_gts() 可用 + 备库 wait_replay_ready()
→ net_frame_.start()                 # ★ 网络监听最后打开——客户端进来时 runtime/schema/GTS 全部就绪
→ standby_module_->start_listener()  # gRPC
```

启动失败时错误码必须传回 `inner_main()`——`wait()` 内部会 `_Exit(0)`，不回传就把失败的 bootstrap 伪装成成功（`main.cpp` 注释明说）。全程埋 `DBA_STEP_INC_INFO(server_start, ...)` 阶段点供外部观测启动进度。

## 核心实现

### 单 Runtime：多租户的语义坍缩

上游 OceanBase 的 `ObMultiTenant` 持有 `tenant_id → ObTenant` 映射、unit 配额、租户级线程组/队列/内存隔离。v1.4.0 中 **`class ObMultiTenant` 全库零匹配**（`*multi_tenant*` 文件不存在），接替者自述正统（`omt/ob_server_runtime_controller.h:45`，"This is the entry class of OMT module"）：

```cpp title="src/observer/omt/ob_server_runtime_controller.h"
class ObServerRuntimeController : public common::ObTimerTask,
                                  public storage::ObIServerRuntime {
  const static int64_t TIME_SLICE_PERIOD = 100000;   // 100ms 定时器
  int create_bootstrap_runtime();
  int refresh_runtime_resources();
  int bring_up_runtime();
  struct ServerResource {                             // 注释：Aggregated resources assigned
    double max_cpu_;  double min_cpu_;                //        to the *single* runtime
    int64_t memory_size_;  int64_t log_disk_size_;
  };
protected:
  ObServerRuntime *runtime_;  // Built once during startup, freed only during shutdown.
};                          // 早期读者见 null → OB_SERVER_RUNTIME_NOT_READY
```

简化的手法是**语义坍缩**而非接口重命名：`omt/ob_server_runtime.h` 中 `tenant_id` 零出现（runtime 对象不再携带租户标号），但兼容层接口保留旧词汇——`ObServer::server_has_tenant()` 实现为 `{ return server_runtime_controller_.has_runtime(); }`（`ob_server.h:614-617`），`get_current_tenant_cpu()` 等接口语义全部坍缩为「那一个 runtime」。资源不再有 unit/资源池/负载均衡层，`build_server_resource_config_()` 直接从 `GCONF` 读服务器聚合量（"Single server-runtime resource configuration sourced from GCONF"）。请求路径从每租户队列变成 `recv_request()` + `omt::ObRetryQueue`（100ms 定时排空）。这套保留形状、掏空内部的路线，让上游十年积累的「以当前租户为语境」的接口签名零改动。

### embedded 嵌入式模式

`ObServerOptions::embedded_`（`ob_server_options.h:45`，CLI `--embedded`，help 文本 "run seekdb in embedded mode"）是 seekdb 区别于上游的部署形态，行为差异（`gctx_.is_embedded_mode()` 的消费点）：

1. **关闭 TCP**：`ob_srv_network_frame.cpp:83` `const bool disable_tcp = gctx_.is_embedded_mode();`——MySQL 端口不启，走本地通道（pyseekdb 的进程内库形态）；
2. **库式生命周期**：打开 `./run/seekdb.clients` 锁文件（`ob_server.cpp:659-680`，Windows 用 `CreateFileA("run\\seekdb.clients")`），`ObServer::wait()` 起 `std::thread(wait_no_client())`——最后一个客户端断开（flock 成功）后 `_Exit(0)` 自动退出，行为像 SQLite 那样的嵌入式库；
3. **standby RPC 关闭**：`standby_module.cpp:509` `if (config_.embedded_mode_ || !config_.rpc_service_enabled_)` 不启 gRPC 监听。

注意命名撞车：`observer/vector_index/ob_plugin_vector_index_service.h` 的 `embedded_adatper_guard_`、hybrid refresh task 的 `delete_embedded_table` 是**向量索引的附属表（embedded table）概念，与 embedded 运行模式无关**。

### 三条 header-only API 窄缝

```shell
src/data_plane/api/data_plane/    # 存储侧：access/ blocksstable/ compaction/ ddl/ encoding/
                                  #   fts/ lob/ memtable/ meta/ retrieval/ scheduler/ transaction/
                                  #   vector/ ... 共 17 子系统 + 10 个顶层接口头
src/query/api/query/              # SQL 侧：ai/ change_stream/ command/ das/ ddl/ engine/ monitor/
                                  #   optimizer/ parser/ plan_cache/ protocol/ resolver/ runtime/
                                  #   scheduler/ session/ vector/ virtual_table/ ... 共 19 子系统
src/storage/api/storage/          # 存储自留缝：runtime/ob_i_server_runtime.h、vector/...
```

组织方式是「物理三级嵌套映射成逻辑一级 include」：`src/data_plane/api/data_plane/fts/ob_fts_parser.h` 的引用写法是 `#include "data_plane/fts/ob_fts_parser.h"`——api 层不引入新命名空间（接口仍住在 `storage`/`query` 命名空间），是纯物理分层。`src/data_plane/CMakeLists.txt` 注释自白动机："Data Plane was extracted from SQL and Storage during the **Bazel modularization**... implementation is intentionally small"；`src/query/CMakeLists.txt`："Query owns the **narrow runtime seams** extracted from SQL and Observer"。data_plane 模块本体只有两个实现文件（`ob_tablet_scan.cpp`、`ob_parallel_range_task_planner.cpp`），真正的实现全在 `src/sql/` 与 `src/storage/`——api 层的职责是把两者之间的依赖收敛成单向窄接口 `sql → data_plane(头) ← storage`，斩断上游的头文件环。运行时取用走 `src/share/rc/ob_server_runtime.h` 的服务定位器：

```cpp title="src/share/rc/ob_server_runtime.h"
inline void bind_server_service(Service *service);   // 装配期绑定实现
inline Service *server_service();                    // 消费方按接口类型取（如 ObIVectorIndexRuntime）
```

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 复合根 + 单一所有权 | `ob_server.h:684-763` `mods_*` + `obs_*_modules()` 六段式 | 消灭初始化顺序的隐式全局依赖；模块创建/销毁顺序显式可读 |
| 服务定位器 | `share/rc/ob_server_runtime.h` 的 `server_service<T>()` | SQL/存储层不 include 实现头也能拿到服务；接口与实现类型解耦（声明返回接口、实际返回实现类指针） |
| 三段式生命周期 | `init()`（构造）/ `start()`（就绪后监听）/ `wait()`（守护） | 「客户端进来时一切已就绪」由 start 的排序硬保证 |
| 语义坍缩兼容层 | `server_has_tenant() = has_runtime()` | 上游接口签名零改动地适配单租户现实 |
| 可裁剪 stub | `standby_module_disabled.cpp` | 编译期整体裁剪备库模块的空实现 |

## 模块间交互

ObServer 装配并暴露的能力被四类消费方引用：**SQL 引擎**经 `gctx_` 取 `vector_index_service()/tablet_scan_service()/dml_service()` 等（全部接口指针）；**存储层**反向取 `ObIVectorIndexRuntime`（DML 写入钩子 `insert_vector_index_rows` 用 `server_service<storage::ObIVectorIndexRuntime>()` 拿到向量索引服务——storage→observer 的反向依赖靠这条接口缝合法化）；**rootserver**（进程内管理服务）持 `ObIRootserverLocalRuntime` 接口由 observer 在装配期注入实现（接口反转：rootserver 只声明"我需要什么"，observer 决定"给谁"）；**standby** 模块由 `ObServer::init_ob_service()` 构造并填 `StandbyConfig`。外部依赖是 systemd（`safe_sd_notify` 动态加载）与 SQLite（元数据库），二者都是进程内资源，无外部集群依赖——这正是单机化后底座的形态。

## 扩展方式

新增一个 server 级服务（模板：`omt::ObAiService`）：
1. 新建服务类，按 `ObSharedTimer` 的 `server_module_init/start/stop/wait` 四段式组织；
2. `ob_server.h` 加 `XxxService *mods_xxx_service_ = nullptr;` 成员（挂进 692-763 行那组）+ 接口类型访问器；
3. 在 `obs_construct/init/start/stop/wait/destroy_modules()` 六段中各加一步（定义在 `omt/ob_server_runtime_controller.cpp`）；
4. 若 SQL/存储层要调用：接口头放 `query/api/query/<子系统>/` 或 `data_plane/api/data_plane/`，消费方 include 接口头取用——不许直接 include 实现头；
5. 构建清单登记 `observer_module_sources.bzl` / `observer_source_inventory.bzl`。

新增 MySQL 协议命令：协议解码在 `src/query/protocol/`，命令分发在 `src/observer/ob_srv_xlator.cpp`（`QIT_*` → 处理器映射），SQL 语义走 `src/sql/parser → resolver → engine`；涉及系统表输出则加 `query/api/query/virtual_table/` 接口 + `src/observer/virtual_table/` 实现。
