---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "oblib 基础库"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "内存管理", "自旋锁", "RPC", "网络库"]
description: "oblib 基础库：协程已移除的线程模型、租户内存三层隔离、ObLatch 排队自旋锁、宏生成 RPC 框架与 easy 魔改点。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`deps/oblib/`（~114 万行）是全项目的地基：Worker 线程模型、三层内存体系、锁、RPC 框架，加上魔改的 easy 网络库。它对业务**零依赖**（实测 `#include "lib/..."` 在全仓库出现 9807 次），是唯一可独立单测的层。反向依赖通过**弱符号注入**实现——oblib 定义协议（`alloc_worker/common_yield`），observer/share 层覆写行为，这是教科书式的依赖倒置。

**先纠正一个流传甚广的旧认知：此 develop 快照中用户态协程已整体移除**。`lib/coro/` 只剩一个 `co_var.h`（1.4K），内容是把协程局部变量宏降级为 `thread_local`：`#define RLOCAL(TYPE, VAR) thread_local TYPE VAR`（`co_var.h:32`）。全 oblib grep 不到 `Coroutine/swapcontext`（唯一残留是 easy 自带的 `easy_uthread.c`，主链路不用）；`Worker::sched_wait()/sched_run()` 退化为空实现直接 return（`worker.cpp:126-136`）。调度单元就是真线程（`ObThWorker : lib::Worker + lib::Threads`）。协程的继任者 `lib/rc/`（RunContext）只保留了"线程内内存上下文切换栈"的纯内存价值（`Flow::current_flow()`，`context.h:743-773`）。为什么移除：4.x 早期"每请求一协程"模型在多租户资源隔离重写（resource group + CPU 时间片 + cgroup）时被整体推翻——RLOCAL 语义复杂、协程栈上内存/锁诊断困难、与 cgroup 配合差。

## 模块架构

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `Worker` 体系 | `lib/worker.h:35`、`lib/thread/thread.h:55` | 每线程一个 Worker（`__thread Worker *self_`），请求处理线程的"人格" |
| `lib/rc` Context | `lib/rc/context.h:296` | `__MemoryContext__` 树（arena + malloc 双分配器） |
| `ObMallocAllocator` | `lib/alloc/ob_malloc_allocator.h:96` | 全局内存入口，tenant × ctx 二维路由 |
| `ObLatch` 族 | `lib/lock/ob_latch.h:209` | 排队自旋锁 + 全局 3079 桶等待队列 |
| `ObRpcPacket/Proxy/Processor` | `rpc/obrpc/` | 136 字节定头 RPC 包、客户端 proxy、服务端模板 processor |
| easy | `deps/easy/src/` | Reactor 网络库（libev 裁剪版 + 系统调用全量挂钩） |

## 调用链路

一次内部 RPC 的完整生命周期（无协程、真线程阻塞）：

```
[客户端线程]
ObRpcProxy::rpc_call<Input,Out>()          deps/oblib/src/rpc/obrpc/ob_rpc_proxy.ipp:460
└─ create_request → init_pkt（填 pcode/tenant/timeout）
   └─ ObReqTransport::send                 deps/oblib/src/rpc/frame/ob_req_transport.cpp:478
      └─ send_session                      同文件 :414
         └─ balance_assign 选 IO 线程 → easy_client_send   deps/easy/src/io/easy_client.c:76
            └─ 调用线程阻塞在 ob_pthread_cond_wait（pthread cond）  easy_client.c:138
               ← IO 线程收响应后 pthread_cond_signal 唤醒

[服务端 easy IO 线程]
ev loop → ObReqHandler::decode（校验 MAGIC_HEADER_FLAG）  rpc/frame/ob_req_handler.cpp
└─ process → ObSrvDeliver::deliver → ObTenant::recv_request 入队
   [租户 worker 线程]
   ObRpcProcessorBase::run                rpc/obrpc/ob_rpc_processor_base.cpp:69
   └─ check_timeout → check_cluster_id → deserialize → process() → response
```

"协程挂起/唤醒"在现版本的对应物就是 **pthread 条件变量 + IO 线程 reactor**。

## 核心实现

### 三层内存体系（租户隔离 + 500 债务审计）

物理布局（`lib/alloc/alloc_struct.h`）：`AChunk`（2MB）→ `ABlock`（≤256 块/chunk）→ `AObject`（最小 16B，magic code + tail magic 防越界）。

- **全局层** `ObMallocAllocator`：单例，内部 `ObTenantCtxAllocatorV2 *allocators_[10000]` + 32 桶分段锁（`ob_malloc_allocator.h:171-200`）。
- **租户-ctx 层** `ObTenantCtxAllocatorV2`：tenant_id × ctx_id 二维，NUMA 感知，chunk 归属 `ObTenantMemoryMgr`——可精确 `get_tenant_hold/limit/sync_wash`（内存洗白回收）。
- **Context 层** `__MemoryContext__`（`lib/rc/context.h:296`）：内嵌 `TreeNode` 父子链（`destory_context` 递归销毁），arena（免 free）+ malloc 双分配器。SQL 执行树天然有生命周期嵌套，arena 按 context 整体释放消灭海量 free；超过 100 个 context 报警 + dump（:595-628）。

最有趣的是 **500 租户哨兵机制**：500 = `OB_SERVER_TENANT_ID`（系统）。`SET_USE_500` 显式声明"我知道这块内存不该算在 500 上"（`alloc_struct.h:195-205`）；线程当前租户 ≠ 500 却用默认 attr 分配时，会被改记到真实租户的 `DO_NOT_USE_ME` ctx（`ob_malloc_allocator.cpp:131-138`）——把"代码里没写清租户"的内存债务显式化成可审计的桶。

### ObLatch 排队自旋锁

`low_lock()`（`ob_latch.cpp:752`）三段式：自旋 `max_spin_cnt_` 次 → `sched_yield` → 入**全局 3079 桶等待队列**（锁对象本体只 4 字节，`WAIT_MASK|WRITE_MASK|24bit 读计数`）+ `ObFutex::wait`。为什么不用 `std::mutex`：①等待者外置到全局桶，热路径零额外内存；②每把锁有 latch_id 可独立调自旋次数、接入 wait event 诊断与死锁诊断（`ObLDLatch` 的 `lbt()`）；③`wr2rdlock` 写降读等定制语义。配套 `ObQSyncLock`（seqlock，读端无原子写）用于读多写少场景。

### RPC：宏驱动的三层 code generation

不是脚本而是编译期宏：①PCODE 注册表——X-macro `ob_rpc_packet_list.h` 被 `#define PCODE_DEF(name, id)` 重复包含生成枚举与名称表；②proxy 方法——`OB_DEFINE_RPC_SYNC/S2/S1_INPUT` 宏族 + `.ipp` 双重包含生成声明/实现两份；③处理器绑定——`Processor<OB_XXX>` 模板别名经 `DEFINE_TO` 注入链式 builder（`proxy.timeout(x).by(tenant).to(addr)`，`ob_rpc_proxy.h:349`）。服务端 `ObRpcProcessor<T>` 的 `arg_/result_` 自动反序列化，`run()` 固定 check_timeout → deserialize → process → response 流程。

### easy 魔改点清单（可考证）

- **线程创建被劫持**：`ob_pthread_create/ob_pthread_join` 把 easy 的线程包成 `ObPThread`——内存记 500 租户、可被 OB 线程管理器统一 stop/统计（`easy_io.c:262`）。
- **系统调用全量挂钩**：`SYS_HOOK` 宏（`lib/thread/ob_tenant_hook.cpp:29-39`）进程内覆写 `pthread_mutex_lock/ob_epoll_wait/ob_pthread_cond_wait/usleep/futex` 等——每次可能阻塞的调用都进 `Thread::WaitGuard` 更新 `loop_ts_/blocking_ts_`，这是"线程 hang 检测 + ASH 等待事件"的地基。
- **IO 线程 hang 监控**：`easy_baseth_pool_monitor`（`easy_baseth_pool.c:297-320`）周期检查每条 IO 线程 `lastrun`，超时 `pthread_kill` 触发 `ob_backtrace_c` 打印用户态回溯。
- **请求粘连守卫**：`easy_request_wakeup` 校验提交线程归属（`easy_request.c:25-31`），防止响应包跨 IO 线程提交破坏 reactor 单线程假设。
- **batch RPC 独立 IO 线程池 + 限流专线**（`ob_req_transport.cpp:390-410`）。

### Worker 与弱符号

`Worker::self()` 惰性调弱函数 `alloc_worker()` 补一个裸 Worker（`worker.cpp:49-53`）；`common_yield` 由 `src/share/scheduler/ob_tenant_dag_scheduler.cpp:37` 覆写为 `dag_yield()`——oblib 定义协议、上层注入行为。Guard 全家桶（`THIS_WORKER`、`ConsumerGroupIdGuard`、`WorkerTimeoutGuard` 等，`worker.h:216-359`）RAII 切换 thread_local 状态。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 弱符号注入 | `alloc_worker/common_yield`（`worker.cpp:49-81`） | 库定义协议、上层注入行为，无编译依赖 |
| 宏 code generation | `ob_rpc_packet_list.h` X-macro、`OB_DEFINE_RPC_*` 宏族 | 编译期生成协议三层样板，零运行时开销 |
| Core-local 无锁 | `ObCoreLocalStorage<T>`（`lib/core_local/ob_core_local_storage.h:27`） | 按核分槽，读自己的槽不跨核共享 |
| LDS linker-script 收集 | `lib/lds/ob_lds_assist.h:23-50` | MTL 模块表零运行时注册 |
| 兼容层（协程化石） | `co_var.h` 的 RLOCAL→thread_local | 协程移除后老代码零改动 |

## 模块间交互

被全项目 include（9807 次）；observer 通过 `IRunWrapper`（线程进出租户上下文的 pre_run/end_run 回调）与弱符号向上注入。`CURRENT_CONTEXT` 是全工程 SQL 执行期分配器的默认来源（`Worker::get_sql_arena_allocator()` 直接返回 `CURRENT_CONTEXT->get_arena_allocator()`，`worker.h:78`）。

## 扩展方式

- **新增一个 RPC 接口**：`ob_rpc_packet_list.h` 加 `PCODE_DEF(OB_MY_RPC, 编号)` → 业务侧 `ObMyRpcProxy : ObRpcProxy` + `RPC_S(@PR5 my_func, OB_MY_RPC, (args), result)`（`ob_rpc_proxy.h:197-214` 有注释示例）→ 服务端 `ObMyP : ObMyRpcProxy::Processor<OB_MY_RPC>` 重写 `process()` → observer 的 `ob_srv_xlator_*.cpp` 注册
- **新增租户内存 context**：`lib/allocator/ob_ctx_define.h` 的 `ObCtxIds` 加 ctx_id → `CREATE_CONTEXT(context, param.set_mem_attr(...))` 宏即入口
- **新增租户后台线程**：`lib::Threads` + `set_run_wrapper(tenant)`，线程自动进出租户上下文
