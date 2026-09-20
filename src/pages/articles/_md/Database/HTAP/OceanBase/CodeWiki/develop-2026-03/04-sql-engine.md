---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "SQL 执行引擎"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "Volcano", "向量化", "DAS", "PX 并行"]
description: "OceanBase SQL 执行引擎：Volcano 算子 + skip bitmap 表达式向量化 + DAS 本地/远程屏蔽 + QC/DFO/SQC 三级 PX 并行；LLVM JIT 已废弃。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/sql/engine/`（~67 万行）执行物理计划：Volcano 迭代器模型算子（basic/join/aggregate/window_function/cmd）+ 29 万行的向量化表达式求值（`expr/`）+ PX 并行执行框架（`px/`）；配套 `src/sql/das/`（数据访问服务）、`dtl/`（并行数据传输）、`monitor/`（计划监控）。核心设计命题：**执行期零 malloc、表达式按需求值、数据访问位置透明**。

**重要勘误**：`src/sql/code_generator/` **不是 LLVM JIT**。`grep -rn llvm` 零命中；`ob_sql.cpp:3667` 中 `bool use_jit = false;` 硬编码。现代 OceanBase 的 "code generator" 是**静态引擎计划生成器**——`ObStaticEngineCG` 把逻辑算子编译成 `ObOpSpec` 物理算子 + 绑定表达式求值函数指针。"code generation" 指编译期绑定函数指针和 frame 偏移。为什么废弃 JIT：静态引擎全部 POD 化/偏移布局 + 直连 C 函数指针后解释开销已极低，JIT 反而带来编译延迟与跨版本序列化困难（对照：PL 引擎保留了 LLVM JIT，见 [PL/SQL 引擎](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/10-pl)）。

## 模块架构

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `ObOpSpec` / `ObOperator` | `engine/ob_operator.h:229/449` | 算子规格（不可变可序列化）/ 执行期实例 |
| `ObExpr` / `ObEvalCtx` | `engine/expr/ob_expr.h:475/232` | 向量化表达式节点 / 求值上下文（frames） |
| `ObExecContext` | `engine/ob_exec_context.h:173` | 一次执行的全局上下文（`DAS_CTX(ctx)` 直达） |
| `ObDataAccessService` | `das/ob_data_access_service.h:28` | DAS 单例：本地直执 / 远程 RPC 分叉 |
| `ObDASRef` | `das/ob_das_ref.h:225` | 一个算子的 DAS 任务集合（按 server 聚合） |
| `ObPxCoordOp` | `engine/px/ob_px_coord_op.h:51` | QC 根算子 + DFO 树调度 |
| `ObStaticEngineCG` | `code_generator/ob_static_engine_cg.h:193` | 逻辑计划 → 物理算子 + 表达式 CG |

**Spec/Op 分离（Flyweight 变体）** 是整个引擎的骨架：不可变可序列化的 `ObOpSpec` 在 plan cache 中一份（PX/DAS 远程传输的就是它），每次执行新建 `ObOperator`。表达式同理：`ObExpr` 含 frame 布局随计划缓存，`ObEvalCtx.frames_` 每执行一份。

## 调用链路

物理计划执行 → 表扫描 → 存储层：

```
ObResultSet::open_plan                            sql/ob_result_set.cpp:105
└─ ObExecutor::execute_plan                        sql/executor/ob_executor.cpp:44
   ├─ LOCAL：root_op_spec->create_operator(ctx, op) 递归建算子树
   └─ 驱动循环：root->get_next_row()             Volcano 拉模型逐行/逐批
      └─ ObOperator::get_next_row                 engine/ob_operator.cpp:1293
         startup_filter → inner_get_next_row → filter_row
         → try_check_status（每 1024 次查超时/kill）→ 监控计数

[表扫描算子]
ObTableScanOp::inner_open                         engine/table/ob_table_scan_op.cpp:2073
└─ init_das_scan_rtdef → 构建 ObDASMergeIter 树
   └─ do_table_scan → ObDASRef::execute_all_task  das/ob_das_ref.cpp:314
      └─ ObDataAccessService::execute_das_task   das/ob_data_access_service.cpp:84
         └─ execute_dist_das_task                 同文件 :168
            ├─ is_local_task() → do_local_das_task :377  本地直函数调用 open_op()
            └─ 远程 → das_rpc_proxy_（异步/同步 RPC）→ 对端 ObDASTaskProcessor::process
                                                               ob_das_rpc_processor.cpp:110
               └─ 本地执行内部：ObDASScanOp::open_op      das/ob_das_scan_op.cpp:725
                  └─ ObDASScanIter::do_table_scan          das/iter/ob_das_scan_iter.cpp:72
                     └─ tsc_service_->table_scan(...)      ★ 直达 storage 的 ObITabletScan 接口
```

方法速查表：

<details>
<summary>方法速查（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ObOperator::open` in `ob_operator.cpp:833` | 算子打开骨架 | 7 种 `OperatorOpenOrder`——PX coord 先开自己（先调度 DFO），Material 先开孩子 |
| `ObOperator::get_next_batch` in `ob_operator.cpp:1460` | 批拉取骨架 | 超出 `max_row_cnt` 时 `push_stash_rows/pop_stash_rows` 暂存机制 |
| `ObOperator::drain_exch` in `ob_operator.cpp:1859` | 迭代提前结束排空 exchange | 防止 PX 生产者 DFO 永远阻塞在 channel send |
| `ObDASRef::prepare_das_task` in `ob_das_ref.h:354` | 模板化建 DAS 任务 | `ObDASOpTraits<DASOp>::type_` 特化反查类型 |
| `ObPxCoordOp::inner_open` in `ob_px_coord_op.cpp:286` | QC 初始化 DFO 树 | init_dfo_mgr 按 receive/transmit 边界切计划树 |
| `ObStaticEngineCG::generate` in `ob_static_engine_cg.cpp:168` | 计划生成 | 后序遍历三段式 generate_spec_basic/final |

</details>

## 核心实现

### 表达式向量化：skip bitmap + evaluated flags 分层缓存

`ObExpr` 同时挂三组**按值传递的 C 函数指针**（非虚函数）：`eval_func_`（单行）/ `eval_batch_func_`（批）/ `eval_vector_func_`（rich format 向量化 2.0）。结果通过 **frame 布局偏移**定位（`datum_off_/eval_flags_off_` 等），`locate_expr_datum(ctx)` 即一次加法，零指针解引用。

惰性求值的核心：`ObEvalInfo` 4 个 bit 位压缩成 uint16；单行 `eval()` 先查 `is_evaluated()`；批模式 `do_eval_batch()`（`ob_expr.cpp:936`）用**每行 evaluated 位图与 skip 位图做 64 位字并行位运算** `bit_op_zero(skip, evaluated_vec)`，只重算"未跳过且未求值"的行。`is_projected()` 表示子算子已产出该值（TSC 直接填列值），eval 变 no-op。未实现批版本的表达式 CG 自动补 `expr_default_eval_batch_func` 逐行循环兜底（`ob_static_engine_expr_cg.cpp:672-675`）——29 万行表达式渐进向量化而不必一次完成。

### DAS：对 SQL 层屏蔽本地/远程

上层只管 `ObDASRef::execute_all_task()`；`execute_dist_das_task()` 按 `task_arg.is_local_task()`（tablet 所在 LS leader 地址 vs 本机）静默分叉：本地直接函数调用，远程构造 `ObDASTaskArg`（含序列化 ctdef + `ObDASRemoteInfo` 重建 exec 环境与 expr frame）走 RPC。分区表/全局索引扫描时一个 TSC 算子的 tablet 可能散布多节点——**路由、聚合（`ObDasAggregatedTask` 按 server 聚合、本地任务排前 `move_local_tasks_to_last()`）、重试（`retry_all_fail_tasks` → 刷新 location 再重试）、并发限流（`DASRefCountContext`）全部封装在 DAS**，算子代码只面对迭代器接口。任务去重靠 `task_map_`（DasRefKey{tablet_loc, op_type} → task，任务数 >1000 才建）；`del_aggregated_tasks_` 独立列表保证 delete 任务最先执行（避免先插入又被同语句删除的行产生无效写）。`get_tsc_service()`（`ob_das_scan_op.cpp:432`）按表类型三选一：虚拟表 `GCTX.vt_par_ser_` / 外表 / 常规 `MTL(ObAccessService*)`。

### PX 并行：QC → DFO → SQC 三级

1. QC `ObPxCoordOp::inner_open` 把计划树按 exchange 边界切成 DFO 树；
2. `ObSerialDfoScheduler::dispatch_sqcs`（`px/ob_dfo_scheduler.cpp:403`）对每个 `ObPxSqcMeta` 发 `ObPxRpcInitSqcArgs`（携带序列化的 ObOpSpec 子树）到各目标机器；
3. SQC 端 `ObPxSubCoord::dispatch_task_to_thread_pool`（`ob_px_sub_coord.cpp:795`）启动 px worker（租户专用 `omt::ObPxPool`）执行 DFO 片段；
4. 数据面全走 DTL channel：同机 `ObDtlLocalChannel`（attach buffer 零拷贝）、跨机 `ObDtlRpcChannel`；DTL 自带租户内存配额与流控，防大查询 OOM；
5. 上层 limit 提前结束时 `drain_exch()` → `notify_peers_mock_eof()` 通知 SQC 注入 EOF——否则生产端 DFO 永远阻塞。

### 表达式函数必须可序列化

`cg_expr_by_operator()` 校验每个 `eval_func` 必须在 `ObFuncSerialization` 注册表中（`REG_SER_FUNC_ARRAY`，样例 `ob_expr_abs.cpp:964`），否则 CG 报 "evaluate function not serializable"——因为远程 DAS/PX 执行要在对端重建函数指针绑定。这是跨节点执行的表达式契约。

### destroy() 代替虚析构

`ob_operator.h:528` 纯虚 `destroy()` 要求子类显式链式调用，省执行热点路径的 vtable 析构开销。配套 `dummy_allocator_/dummy_ptr_`（:790）：open 时申请一小块内存，close 未调用时内存上下文报警——tracepoint 控制的算子关闭泄漏检测。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 编译期注册工厂 | `REGISTER_OPERATOR_FULL__`（`ob_operator_reg.h:81`）模板特化 + `G_ALL_ALLOC_FUNS_[type]` 全局函数表 | 无运行时 if-else 链；`G_OB_VERSION_ARRAY_` 处理滚动升级时低版本节点不支持新算子 |
| 模板方法 | `open/get_next_row/get_next_batch/close` 骨架 + `inner_*` 钩子 | 监控、filter、状态检查、批转行适配统一在骨架 |
| 迭代器 + 适配器 | `ObBatchRowIter`（`ob_operator.h:173`）批转行；`get_next_row_vectorizely` 行转批 | 行/批双模渐进迁移 |
| 访问者 | `ObOpSpecVisitor`（`ob_operator.h:356`）+ `accept()` | 计划树统一遍历 |
| 策略 | `ObSerialDfoScheduler/ObParallelDfoScheduler`；DAS 三种并行模式 | 串行/并行 DFO 调度切换 |

## 模块间交互

依赖 storage：`ObDASScanIter` 持 `storage::ObITabletScan` 接口；DML 并行提交深拷贝 tx desc（`DASParallelContext::deep_copy_tx_desc()`）。依赖 observer RPC：`ObDASRpcProxy` + `ObDASTaskProcessor`；DAS task id 经 `ObDASIDCache` 向 SSLog/事务服务申请。被 `ObSyncPlanDriver`/`ObAsyncPlanDriver`（observer/mysql）驱动；`sql/monitor/ob_sql_plan.cpp` 消费 `ObMonitorNode`（`output_row_count_/db_time_`）生成 `gv$sql_plan_monitor`。

## 扩展方式

- **新增一个物理算子**：见概览「典型修改场景 3」
- **新增一个表达式函数**：`engine/expr/ob_expr_foo.cpp` 实现 `calc_result_typeN()` + `cg_expr()`（绑 `rt_expr.eval_func_`，样例 `ObExprAbs::cg_expr`，`ob_expr_abs.cpp:1272`）→ **必须** `REG_SER_FUNC_ARRAY` 注册函数指针 → parser 函数表 + `ob_expr_operator_factory.cpp` 注册
- **新增算子监控指标**：`ObMonitorNode` 加字段 → 骨架自动累计 → `submit_op_monitor_node`（`ob_operator.cpp:1270`）上报；RT monitor 阈值常量在 `ob_operator.h:454-456`
