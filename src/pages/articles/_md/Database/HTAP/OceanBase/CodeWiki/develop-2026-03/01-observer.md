---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "Observer 进程与多租户"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "多租户", "MySQL 协议", "网络线程模型"]
description: "observer 进程入口、easy/SQL NIO 双轨网络、omt 多租户两级队列与 cgroup 隔离、虚拟表工厂。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/observer/` 是 OceanBase 的**进程入口和组装层**——全仓库只有 `main.cpp` 一个入口，其余所有子系统（SQL、存储、事务、日志、RS）都在这里被实例化、接线、启动。它的第二重身份是**多租户容器**：`omt/`（ObMultiTenant）让一个进程内运行多个租户，每个租户自带 worker 池、请求队列、内存上下文与 cgroup，实现"数据库即服务"的进程内高密度部署。边界：observer 不做 SQL 编译执行（转交 `sql_engine_`）、不做数据存储（`GCTX` 指向 MTL 服务），它只负责"把请求安全地送到正确的租户、正确的资源组里"。

## 模块架构

内部组件围绕"网络 → 分发 → 租户队列 → worker 线程"四级流水线组织：

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `ObSrvNetworkFrame` | `ob_srv_network_frame.h:38` | 网络门面：组装 4 条 RPC 传输 + MySQL 监听（easy 或 SQL NIO 双轨） |
| `ObSrvXlator` 族 | `ob_srv_xlator.h:108/144/166` | 请求翻译器：MySQL cmd → processor 工厂；RPC pcode → processor（14 个分文件注册） |
| `ObSrvDeliver` | `ob_srv_deliver.h:112` | 分发器：登录前请求进独立线程组，已认证请求按租户投递 |
| `ObMultiTenant` / `ObTenant` | `omt/ob_multi_tenant.h:78`、`omt/ob_tenant.h:373` | 租户容器与租户实例（队列 + worker + 内存配额） |
| `ObResourceGroup` | `omt/ob_tenant.h:270` | 资源组：双优先级队列 + cgroup 绑定 |
| `ObTenantNodeBalancer` | `omt/ob_tenant_node_balancer.h:34` | 周期轮询 RS，本地建/删租户（最终一致收敛） |
| `ObVirtualTableIteratorFactory` | `virtual_table/ob_virtual_table_iterator_factory.cpp` | 虚拟表迭代器工厂（3460 行 switch，140+ 虚拟表） |
| `ObInnerSQLConnection` | `ob_inner_sql_connection.h:96` | 内部 SQL 直驱（绕网络调 SQL 引擎） |

```cpp title="src/observer/ob_server.h（节选）"
class ObServer {
  // "structure aggregated but not logical processing" —— 注释原话
  int init(const ObServerOptions &opts, const ObPLogWriterCfg &log_cfg);
  int start();  int wait();  void destroy();
private:
  ObGlobalContext &gctx_;                 // 服务定位器，宏 GCTX 全局可用
  ObSrvNetworkFrame net_frame_;
  sql::ObSql sql_engine_;
  pl::ObPL pl_engine_;
  rootserver::ObRootService root_service_; // RS 逻辑内嵌于本进程
  ObService ob_service_;
  omt::ObMultiTenant multi_tenant_;        // 多租户容器
  sql::ObSQLSessionMgr session_mgr_;
  share::ObCgroupCtrl cgroup_ctrl_;        // 租户 CPU 隔离
};
#define OBSERVER (::oceanbase::observer::ObServer::get_instance())
```

## 调用链路

MySQL 请求接入链（easy 路径）：

```
[easy IO 线程]
ObMySQLHandler::decode(easy_message_t*)      deps/oblib/src/rpc/obmysql/ob_mysql_handler.cpp:43
└─ ObMySQLHandler::process                    同文件 :110
   ├─ ObSMHandler::on_connect                 src/observer/mysql/obsm_handler.cpp:69（握手包+scramble）
   └─ 组装 rpc::ObRequest → deliver_.deliver  ob_mysql_handler.cpp:179
      └─ ObSrvDeliver::deliver                src/observer/ob_srv_deliver.cpp:903
         └─ deliver_mysql_request             同文件 :708
            ├─ 登录前 → 解析用户/租户 → mysql_queue_ / diagnose_queue_（独立线程组）
            └─ 已认证 → tenant->recv_request   :878
               └─ ObTenant::recv_request      src/observer/omt/ob_tenant.cpp:1495
                  ├─ group_id ≠ 0 → recv_group_request :1435 → 组内 req_queue_ / multi_level_queue_
                  └─ 否则按 QQ_HIGH/QQ_NORMAL/QQ_LOW 优先级入队

[租户 worker 线程 ObThWorker]
ObThWorker::worker                           src/observer/omt/ob_th_worker.cpp:324
└─ tenant_->get_new_request(...) → process_request :238
   └─ ObWorkerProcessor::process             ob_worker_processor.cpp:94（trace_id/ASH 采样）
      └─ translator_.translate → ObSrvMySQLXlator::translate   ob_srv_xlator.cpp:169
         ├─ COM_QUERY → placement new ObMPQuery（线程局部缓冲）:185
         └─ processor->run → ObMPQuery::process    obmp_query.cpp:53
            ├─ get_session + 一串安全检查（zombie/kill/throttle/包长）:102-169
            └─ do_process_single_stmt → gctx_.sql_engine_（进入 SQL 引擎）
```

方法速查表：

<details>
<summary>方法速查（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ObServer::init` in `ob_server.cpp:237` | 40+ 步链式初始化 | else-if 链保证顺序可读，失败即终止 |
| `ObServer::start` in `ob_server.cpp:951` | 启动网络/多租户/服务 | `check_if_multi_tenant_synced`（:1229）等租户同步完才服务 |
| `ObSrvDeliver::deliver` in `ob_srv_deliver.cpp:903` | 请求总分发 | deliver 处刻意删掉二次租户存在性检查（:838 注释，性能） |
| `ObTenant::recv_request` in `ob_tenant.cpp:1495` | 按组入队 | 组内 0 worker 时 force acquire_more_worker(1)（:1483）弹性扩线程 |
| `ObThWorker::worker` in `ob_th_worker.cpp:324` | worker 主循环 | 每请求 `CREATE_WITH_TEMP_CONTEXT` 建请求级内存上下文 |
| `ObMPQuery::process` in `obmp_query.cpp:53` | COM_QUERY 处理 | `do{...}while(RETRY_TYPE_LOCAL)` 本地重试环 |

</details>

## 核心实现

### 单进程多租户（OMT）

`ObMultiTenant` 持 `TenantList`（`ObSortedVector<ObTenant*>`，SpinRWLock 保护），每个 `ObTenant` 是 MTL 基类 `share::ObTenantBase` 的实例——自带 worker 池、请求队列、内存上下文、cgroup。租户间隔离有三条线：CPU（min/max_cpu + cgroup `ObCgroupCtrl`）、内存（`ObCtxMemConfig` per ctx 配额）、线程（组队列 `ObResourceGroup::req_queue_`，高/普通双优先级 + 10 级嵌套队列 `ObMultiLevelQueue`）。请求进入时 `deliver_mysql_request` 把 `conn->group_id_` 写进请求（`ob_srv_deliver.cpp:717-736`），资源管理器的组间调度策略由此生效。为什么要单进程多租户而不是每租户一进程：数百租户共享一套二进制和机器时，进程级隔离的内存/调度开销不可接受，而代价是所有隔离必须在进程内自己实现。

**租户视图的最终一致收敛**：租户/unit 的真源在 RS，`ObTenantNodeBalancer::run1` 周期 `fetch_effective_tenants` 对比本地列表，差异驱动 `create_tenant/del_tenant`（`ob_tenant_node_balancer.h:84-93`）。RS 重启不丢事件；observer 重启后 `check_if_multi_tenant_synced` 阻塞等同步完成才对外服务。

**worker 弹性扩缩容**：`ObTenant::timeup` 周期执行 `check_worker_count`——扩容条件之一是 `ObMallocAllocator::get_tenant_remain > get_tenant_limit * 0.05`（内存余量 5%），且距上次 token 变更超过 `EXPAND_INTERVAL` 才 `acquire_more_worker(1)`；缩容在 token < worker 数且超过 `SHRINK_INTERVAL` 时置 `shrink_` 标志，worker 主循环中 ATOMIC_BCAS 命中后自行退出。大查询降级由 `ObTenant::switch_worker_to_large_query_group` 完成；`check_large_query_quota`（`ob_th_worker.cpp`）对系统保留租户和嵌套请求不做驱逐。组内 0 worker 时 `recv_request` force 扩一个（`ob_tenant.cpp:1483`）——空租户不常驻线程，按需拉起。

### easy 与 SQL NIO 双轨网络

`ObSrvNetworkFrame::init` 里若 `enable_new_sql_nio()` 则不为 MySQL 建 easy IO，改由 `obmysql::ObSqlNioServer` 承接（`ob_srv_network_frame.cpp:206-234`，支持 NUMA 亲和与 per-tenant 网络线程）。easy 是老一代 Reactor 框架，SQL NIO 是为高连接数演进的新路径，两轨并存降低迁移风险。内部 RPC 有 4 条独立传输（rpc / high-prio / batch / unix domain），高优先级 RPC（租户管理、心跳）不能被批量 RPC 洪峰阻塞（`NET_IO_HP_GID=64`，`ob_srv_network_frame.h:41`）。

### Processor 线程局部 placement new

`ObSrvMySQLXlator::translate` 把 `ObMPQuery` new 在线程局部 union buffer 上（`ob_srv_xlator.cpp:185`），COM_STMT_CLOSE 专门用独立栈缓冲防内存不足时无法回错误包（:255-259 注释），并有 `STATIC_ASSERT` 保证 OOM 时选举 RPC 仍可用（:156）。SQL 处理路径每秒数万次分配，热路径零 malloc。

### 虚拟表 = table_id switch 工厂

`__all_virtual_*` / `information_schema` / `mysql` 兼容表全部在 observer 层实现：SQL 引擎经 `ObIVirtualTableIteratorFactory` 接口（`ob_virtual_table_iterator_factory.cpp:343`）→ `ObVTIterCreator::create_vt_iter`（:432）以 table_id 走巨型 switch 生成迭代器。部分表转发 RS 聚合（`ObAgentVirtualTable` 远端代理）。价值：把进程内运行时状态（内存、线程、队列、锁等待）以 SQL 可查形式暴露，运维自举。

### 隐藏 sys 租户与虚拟租户

`create_hidden_sys_tenant` / `create_virtual_tenants`（`ob_multi_tenant.cpp:852/902`）：bootstrap 前先建 hidden sys tenant（磁盘上只有 slog 可回放），另建若干不占 unit 的 virtual tenant 承载系统后台流量——解决"先有租户还是先有系统表"的鸡蛋问题，并隔离系统内部流量与用户流量。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法 | `ObSqlProcessor::run`（`deps/oblib/src/rpc/frame/ob_sql_processor.cpp:20`）；`response/cleanup` 在 `ObMPBase` 中 `final`（`obmp_base.h:73/76`） | 骨架固定，30+ 命令包处理器只写 `process()` |
| 工厂 + 注册表 | `ObSrvMySQLXlator::translate` 的 cmd→processor switch（`ob_srv_xlator.cpp:236`）；`RPC_PROCESSOR` 宏注册 pcode（`ob_srv_xlator.h:27`） | 新增处理器零侵入 |
| 服务定位器 | `ObGlobalContext`（`ob_server_struct.h:221`，宏 `GCTX` :352） | 50+ 指针只读互访通道 |
| Reactor | easy 的 `ObReqHandler` 持 `easy_io_handler_pt` 回调（`ob_req_handler.h:51`） | IO 与业务解耦 |
| 策略（认证） | `ObMPBase::handle_caching_sha2_authentication_if_need` 等（`obmp_base.h:203-233`） | 按客户端 required_plugin 选择认证算法 |

## 模块间交互

向下依赖 oblib（rpc frame、easy 封装）、share（schema/location/cgroup）、sql 与 pl（`ob_server.h` 直接 include `sql/ob_sql.h`）、storage/logservice（`ObStorageEnv`、`ObServerLogBlockMgr`）、rootserver（内嵌 `ObRootService`）。observer 是组装层，不被别的模块作为库调用；但 `GCTX` 被 rootserver/storage/sql 反向引用（虚表创建、ob_service 等）。虚拟表入口 `ObVirtualDataAccessService` 实现 `common::ObITabletScan` 被 SQL 扫描算子消费。

## 扩展方式

- **新增一种 MySQL 命令包**：`obmp_xxx.h/.cpp` 继承 `ObMPBase` 实现 `deserialize()/process()` → `ObSrvMySQLXlator::translate` 的 switch 加一行 `MYSQL_PROCESSOR(ObMPXxx, gctx_)`（`ob_srv_xlator.cpp:236`）
- **新增虚拟表**：见概览「典型修改场景 1」
- **新增租户级后台服务（MTL 组件）**：写好 `mtl_init/mtl_start/mtl_stop/mtl_wait` 四个静态钩子（模板见 `omt/ob_tenant_mtl_helper.h`）加入租户 MTL 栈——服务生命周期与租户严格绑定，租户删除不泄漏线程/内存
