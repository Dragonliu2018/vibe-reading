---
title: "Flink 并发读 tablet 互杀：一个被 query_id 复用掩盖的 pipelineX 取消 Bug"
source:
  project: "Doris"
  type: "PR"
  id: "42421"
  url: "https://github.com/apache/doris/pull/42421"
  prType: "fix"
date: "2026-07-27"
category: [Database, Apache Doris, PRs]
tags: ["Flink", "PipelineX", "External Scan", "Doris", "Bug Fix"]
description: "Doris 外部读取（Flink/Spark/starrocks）走 pipelineX 时，多个并发 scanner 共用同一个 query_id，一个 scanner 结束会通过 cancel(query_id) 把其余 scanner 一并取消。"
readingTime: "9 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#42421](https://github.com/apache/doris/pull/42421) · **Issue** - · **commit** [95a0a8f](https://github.com/apache/doris/commit/95a0a8fdc650446513e85c2a0e63f754037e1b19) · **首发版本** 3.0.3 · **变更行数** +39 行 · **合并时间** 2024-10-28

---

## 背景

Doris 除了给自家 FE 提交查询，还对外暴露了一个 thrift 接口让外部计算引擎直接读 tablet——Flink/Spark 的 Doris Connector 就走这条路。每次 `open_scanner` 调用，BE 会拉起一个独立的 scan fragment，把指定 tablet 的数据按列吐回给 connector；读完一个 tablet 后 connector 调 `closeScanner` 收尾清理。一个 Flink 任务并发开多个 scanner 是常态。

pipelineX 引擎下，每个 fragment 都挂在 `FragmentMgr` 的两张 map 上：

```cpp title="fragment_mgr.h"
// (QueryID, FragmentID) -> PipelineFragmentContext
std::unordered_map<std::pair<TUniqueId, int>,
                   std::shared_ptr<pipeline::PipelineFragmentContext>> _pipeline_map;

// query id -> QueryContext
std::unordered_map<TUniqueId, std::weak_ptr<QueryContext>> _query_ctx_map;
```

`_query_ctx_map` 按 `query_id` 索引 `QueryContext`，而 `QueryContext` 是一个查询的「总管」——持有该查询所有 fragment instance 的 id、内存 tracker、取消状态。`cancel_query(query_id)` 会找到对应的 `QueryContext`，cancel 掉它名下的所有 instance，并从 `_query_ctx_map` 里 erase 掉这个 `query_id`。

这套模型的前提是：**一个 `query_id` 对应一个逻辑查询、一个协调者**。FE 发起的查询天然满足——FE 给每个查询分配全局唯一的 `query_id`。问题出在外部读取：`open_scanner` 把 `query_id` 直接透传自 `t_query_plan_info.query_id`，而 Flink 同一个查询的多个并发 scanner 共用这同一个值。于是 BE 把 N 个本该独立的 scanner 误认成同一个查询的 N 个 fragment，埋下了「一个结束、全员陪葬」的隐患。

### cancel 是谁触发的：closeScanner

那么「一个 scanner 结束」具体是怎么触发 cancel 的？答案在 connector 读取完成后的清理路径上。Spark/Flink connector 读完一个 tablet 会调 `closeScanner`，BE 侧 `close_scanner` → `clear_scan_context(context_id)`，而 `clear_scan_context` 拿着 `context->query_id` 直接调 `cancel_query`：

```cpp title="external_scan_context_mgr.cpp（clear_scan_context）"
if (context != nullptr) {
    // first cancel the fragment instance, just ignore return status
    _exec_env->fragment_mgr()->cancel_query(context->query_id,
                                            Status::InternalError("cancelled by clear thread"));
    // clear the fragment instance's related result queue
    static_cast<void>(_exec_env->result_queue_mgr()->cancel(context->fragment_instance_id));
    LOG(INFO) << "close scan context: context id [ " << context_id << " ]";
}
```

`context->query_id` 在修复前就是所有并发 scanner 共享的那个值。所以一个 scanner 读完后调 `closeScanner`，`cancel_query(共享 query_id)` 会把整组 scanner 的 `QueryContext` 一并 cancel 并 erase——还在扫描的其余 scanner 瞬间被「连坐」取消。这条 close→cancel 清理链正是 bug 的实际引爆点，也是作者在 commit message 里点名的 `FragmentMgr.cancel(query_id)`。

PR #42421 修的就是这个。

---

## 前置知识

### 外部读取的入口

`BaseBackendService::open_scanner` 是 thrift `open_scanner` 的实现。修复前，它为每次调用生成一个唯一的 `fragment_instance_id`，但 `query_id` 直接取自 FE 下发的 `t_query_plan_info`：

```cpp title="backend_service.cpp（修复前）"
void BaseBackendService::open_scanner(TScanOpenResult& result_, const TScanOpenParams& params) {
    TUniqueId fragment_instance_id = generate_uuid();
    // ...
    p_context->query_id = t_query_plan_info.query_id;
    // ...
    exec_st = _exec_env->fragment_mgr()->exec_external_plan_fragment(
            params, t_query_plan_info, fragment_instance_id, &selected_columns);
}
```

注意 `fragment_instance_id` 每次都新生成（唯一），`query_id` 却复用 FE 的值。Flink 同一查询并行开多个 scanner 时，这些 scanner 的 `query_id` 相同、`fragment_instance_id` 各异。

### fragment_id 缺省为 0

`exec_external_plan_fragment` 构造 `TPipelineFragmentParams` 时，设置了 `query_id`、`fragment_instance_id`、`coord.hostname`，却**从没设置 `fragment_id`**：

```cpp title="fragment_mgr.cpp（exec_external_plan_fragment）"
TPipelineInstanceParams fragment_exec_params;
exec_fragment_params.query_id = query_id;
fragment_exec_params.fragment_instance_id = fragment_instance_id;
exec_fragment_params.coord.hostname = "external";
```

而 thrift 里 `fragment_id` 是 `optional i32`：

```thrift title="PaloInternalService.thrift"
struct TPipelineFragmentParams {
    3: optional i32 fragment_id
```

未 set 即缺省 `0`。所以**所有外部 scanner 的 `fragment_id` 都是 0**。

### 两张 map 的键撞车

把上面两点拼起来：N 个并发外部 scanner 的键分别是

- `_pipeline_map` 键 `{query_id, fragment_id}` = `{同一个 query_id, 0}` —— **完全相同**
- `_query_ctx_map` 键 `query_id` —— **完全相同**

也就是说，这 N 个独立 scanner 被塞进了同一个 `QueryContext`、同一个 `_pipeline_map` 槽位。

---

## 实现

PR 用三处改动联袂修复，对应 commit message 里的三条。

### 改动一：每个 scanner 生成独立的 query_id

这是治本的一刀。外部读取不需要向 FE 上报任何东西，`query_id` 对外没有语义，完全可以换掉：

```cpp title="backend_service.cpp（修复后）"
void BaseBackendService::open_scanner(TScanOpenResult& result_, const TScanOpenParams& params) {
    TStatus t_status;
    TUniqueId fragment_instance_id = generate_uuid();
    // A query_id is randomly generated to replace t_query_plan_info.query_id.
    // external query does not need to report anything to FE, so the query_id can be changed.
    // Otherwise, multiple independent concurrent open tablet scanners have the same query_id.
    // when one of the scanners ends, the other scanners will be canceled through
    // FragmentMgr.cancel(query_id).
    TUniqueId query_id = generate_uuid();
    // ...
    p_context->query_id = query_id;
    // ...
    LOG(INFO) << fmt::format(
            "exec external scanner, old_query_id = {}, new_query_id = {}, "
            "fragment_instance_id = {}",
            print_id(t_query_plan_info.query_id), print_id(query_id),
            print_id(fragment_instance_id));
    exec_st = _exec_env->fragment_mgr()->exec_external_plan_fragment(
            params, t_query_plan_info, query_id, fragment_instance_id, &selected_columns);
}
```

`query_id` 也改成 `generate_uuid()`，和 `fragment_instance_id` 一样每次新生成。`exec_external_plan_fragment` 多接一个 `query_id` 入参，用它覆盖 `t_query_plan_info.query_id`：

```cpp title="fragment_mgr.cpp（修复后）"
Status FragmentMgr::exec_external_plan_fragment(const TScanOpenParams& params,
                                                const TQueryPlanInfo& t_query_plan_info,
                                                const TUniqueId& query_id,
                                                const TUniqueId& fragment_instance_id,
                                                std::vector<TScanColumnDesc>* selected_columns) {
    // ...
    TPipelineInstanceParams fragment_exec_params;
    exec_fragment_params.query_id = query_id;          // 用新生成的，而非 t_query_plan_info.query_id
    fragment_exec_params.fragment_instance_id = fragment_instance_id;
    exec_fragment_params.coord.hostname = "external";  // 见改动三
```

现在每个 scanner 拥有独立的 `query_id` → 独立的 `QueryContext` → 独立的 `_pipeline_map` 键 `{random, 0}`。一个 scanner 结束或被 cancel，只会动到它自己的 `QueryContext`，其余 scanner 不受牵连。日志里同时打印 `old_query_id` 和 `new_query_id`，方便排查时把 BE 侧的 scanner 关联回 FE 下发的原始查询。

### 改动二：duplicate 检查与插入收进同一把锁

`exec_plan_fragment` 在登记 fragment 时，对 `_pipeline_map` 做了一次「查重 + 插入」。修复前，这两步被拆在**两段独立的临界区**里，中间还夹着 `set_ready_to_execute_only` 和时间戳计算：

```cpp title="fragment_mgr.cpp（修复前）"
for (const auto& local_param : params.local_params) {
    const TUniqueId& fragment_instance_id = local_param.fragment_instance_id;
    std::lock_guard<std::mutex> lock(_lock);                 // 锁①：查重
    auto iter = _pipeline_map.find({params.query_id, params.fragment_id});
    if (iter != _pipeline_map.end()) {
        return Status::InternalError("exec_plan_fragment input duplicated fragment_id({})",
                                     params.fragment_id);
    }
    query_ctx->fragment_instance_ids.push_back(fragment_instance_id);
}

if (!params.__isset.need_wait_execution_trigger || !params.need_wait_execution_trigger) {
    query_ctx->set_ready_to_execute_only();                  // 锁外
}
int64 now = /* ... */;
{
    g_fragment_executing_count << 1;
    g_fragment_last_active_time.set_value(now);
    std::lock_guard<std::mutex> lock(_lock);                 // 锁②：插入
    _pipeline_map.insert({{params.query_id, params.fragment_id}, context});
}
```

这是个经典的 check-then-act 竞态：两个并发的 `exec_plan_fragment` 用同一个 `{query_id, fragment_id}`，都能在锁①里 `find` 不到对方尚未插入的条目，双双通过查重，然后在锁②里各自 `insert`（`unordered_map::insert` 对已有键是 no-op，于是后到的 context 静默丢失，但它已经 `submit()` 跑了起来——map 里查不到，后续 cancel/cleanup 找不到它）。

修复把查重和插入合并到**同一把锁**内，把不持锁也能做的事（`set_ready_to_execute_only`、`set_pipeline_context`、`submit`）挪到锁外：

```cpp title="fragment_mgr.cpp（修复后）"
{
    // (query_id, fragment_id) is executed only on one BE, locks _pipeline_map.
    std::lock_guard<std::mutex> lock(_lock);
    for (const auto& local_param : params.local_params) {
        const TUniqueId& fragment_instance_id = local_param.fragment_instance_id;
        auto iter = _pipeline_map.find({params.query_id, params.fragment_id});
        if (iter != _pipeline_map.end()) {
            return Status::InternalError(
                    "exec_plan_fragment query_id({}) input duplicated fragment_id({})",
                    print_id(params.query_id), params.fragment_id);
        }
        query_ctx->fragment_instance_ids.push_back(fragment_instance_id);
    }

    int64 now = /* ... */;
    g_fragment_executing_count << 1;
    g_fragment_last_active_time.set_value(now);
    _pipeline_map.insert({{params.query_id, params.fragment_id}, context});
}

if (!params.__isset.need_wait_execution_trigger || !params.need_wait_execution_trigger) {
    query_ctx->set_ready_to_execute_only();
}
query_ctx->set_pipeline_context(params.fragment_id, context);
RETURN_IF_ERROR(context->submit());
```

注释点明了契约：**一个 `(query_id, fragment_id)` 在单个 BE 上只执行一次**。既然是唯一性约束，查和插就必须原子。报错信息也补上了 `query_id`，方便定位是哪个查询重复派发了 fragment。

这条改动对外部 scanner 尤其有意义：改动一之前，所有外部 scanner 共享 `{query_id, 0}`，正好是触发这个竞态（以及直接撞 duplicate 报错）的高发场景。改动一让 query_id 唯一后，外部 scanner 之间不再撞键；改动二则把「同键并发」这条更普遍的路径（如 FE 重试/重复派发）也一并堵死。

### 改动三：外部查询不上报 FE

pipeline fragment 执行过程中会通过 `coordinator_callback` 向协调者（FE）回报状态。修复前无差别执行，外部 scanner 也走这条回调，试图用 `FrontendServiceConnection` 连一个根本不存在的协调地址：

```cpp title="fragment_mgr.cpp（修复后）"
void FragmentMgr::coordinator_callback(const ReportStatusRequest& req) {
    DCHECK(req.status.ok() || req.done);
    if (req.coord_addr.hostname == "external") {
        // External query (flink/spark read tablets) not need to report to FE.
        return;
    }
    Status exec_status = req.status;
    // ... 向 FE 回报 ...
}
```

配合改动一里 `exec_fragment_params.coord.hostname = "external"` 这个标记，外部 scanner 的回调直接 `return`，不再发起无意义的 FE report RPC。这也呼应了 commit message 第三条："External query (flink/spark read tablets) not need to report to FE."

一个细节：`"external"` 这个 hostname 会不会被后台 `cancel_worker` 误判为「协调者已死」而把 scanner cancel 掉？不会。`cancel_worker` 对每个 `QueryContext` 先查 `fe_process_uuid`，外部读取的 `query_options` 不带该字段（为 0），命中 `if (fe_process_uuid == 0) continue;` 直接跳过，根本走不到协调者存活检查。所以外部 scanner 既不被上报拖累，也不被清理线程误杀。

---

## 问题

### 误取消如何变成可见报错

共享 `query_id` 的代价是共享整个 `QueryContext`，连带着共享其中的取消状态。`cancel_query(query_id)` 调到 `QueryContext::cancel` → `cancel_all_pipeline_context`，后者遍历该 `QueryContext` 名下**所有** fragment context 一并 cancel（`cancel_query` 不传 fragment_id，默认 -1，一个都不跳过）：

```cpp title="query_context.cpp"
void QueryContext::cancel(Status new_status, int fragment_id) {
    if (!_exec_status.update(new_status)) { return; }
    set_ready_to_execute(new_status);
    cancel_all_pipeline_context(new_status, fragment_id);  // 取消该 QueryContext 下所有 fragment
}
// is_cancelled() = !_exec_status.ok()  —— 读的是共享的 _exec_status
```

还在初始化的兄弟 scanner 走到 `NewOlapScanner::open` → reader init 路径上的取消检查点，读到 `query_ctx->is_cancelled()` 为真，返回 `Status::Cancelled`，最终对外报成：

```text title="BE 日志 / 客户端报错"
[INTERNAL_ERROR] failed to initialize storage reader. tablet=32843226, res=[CANCELLED], backend=...
```

报错出现在「初始化 storage reader」阶段，而非扫描中途——因为兄弟 scanner 往往还没真正读到数据，就被先完成的 scanner 的 close→cancel 提前打掉了。

### 为什么是偶发，而不是「并发就必现」？

这是 PR 下一个反复被问到的疑问：既然多个并发 scanner 共享 `query_id` 必然撞键，按理说每次并发都会错，为什么实际报错是随机出现的？

答案藏在 close→cancel 的**时序**里。同时启动的多个 scanner，扫描的数据量相近，结束时间也相近。第一个读完的 scanner 调 `closeScanner` → `cancel_query(共享 query_id)`，但这串调用有 RPC 和锁的开销，**不是瞬时完成的**。等它真正 fire 出去时，可能出现两种情况：

- **其他 scanner 还在扫描** → `cancel_query` 命中共享 `QueryContext`，把它们一并取消 → 报错。
- **其他 scanner 也已经读完、正要或已经 `closeScanner`** → 此时它们对结果已无依赖，`cancel_query` 即使命中也只是清理一个即将结束的状态 → 无害，不报错。

所以是否报错，取决于「先完成的 scanner 的 cancel 调用」与「其余 scanner 的扫描完成」谁先到达——这是一个竞态，于是表现为偶发。并发度越高、单 tablet 数据量越大、close 调用越慢（网络/锁竞争），撞上 cancel 仍在途的概率越大，越容易复现。这也解释了为什么这类 bug 极难稳定复现：它不取决于输入数据是否「正确」，而取决于一组并发操作的相对时序。

> 作者在 commit message 里把这条链路概括为："when one of the scanners ends, the other scanners will be canceled through `FragmentMgr.cancel(query_id)`"。结合 close→cancel 的清理路径和上面的时序分析，偶发性就有了完整的解释。

---

## 意义与影响

这个 bug 的危害集中在 Flink/Spark 高并发读 Doris 的场景：

- **现象极具迷惑性**。表现为 scanner 在正常扫描中途被取消（`CANCELLED`），日志里却看不到明确的取消发起者。根因在 BE 内部多个独立 scanner 因共享 `query_id` 被「连坐」，与 Flink 侧、网络、超时都无关——典型的「看起来像外部问题、实则是内部键设计问题」。
- **只在 pipelineX 下暴露**。PR 标题特意标了 `on pipelineX`。旧执行引擎的 map 键/查重路径不同，未必触发；切到 pipelineX 后 `_pipeline_map` 以 `{query_id, fragment_id}` 为键、且 `fragment_id` 对外部读取恒为 0，才把「共享 query_id」这个老问题放大成实际故障。
- **三处改动是配套的**。改动一（独立 query_id）治本，让每个 scanner 自成一体；改动二（原子查插）堵住同键并发的竞态，对 FE 正常查询路径也有增益；改动三（跳过上报）消掉外部读取的无效 RPC。单独应用任一条都不完整——比如只改一不改三，scanner 仍会尝试连不存在的协调者。
- **消极影响不止正确性，还有性能**。修复前这套「共享 query_id」在高并发压测下会形成正反馈恶化：被连坐的 scanner 不是「立刻失败」，而是先在有限的 scanner 线程池里排队、进入 `NewOlapScanner::open` 走到取消检查点才退出——这些「注定失败」的 scanner 在失败前已占用线程、持 header 锁、开 rowset 做无效 I/O，挤压正常 scanner 拿不到线程；资源越紧 → scanner init 越慢 → 「兄弟 close 早于 init 完成」的竞态命中率越高 → 失败越多 → 上游重跑叠加流量 → 资源更紧。于是看到的不只是「失败多了」，而是「整体也慢了」——失败率和耗时同向恶化。修复后每个 scanner 独立，不再有「注定失败却占资源」的 scanner，线程池和 IO 全部给到有效 scanner，正反馈消失，压测耗时也随之回落。

更一般地看，这是一个 **「复用上游标识当本地主键」** 的设计陷阱：`query_id` 在 FE 语义里是「一个查询」，但 `open_scanner` 把它直接拿来当 BE 侧 `QueryContext` 的唯一键，隐含假设「同一个 `query_id` 的多次 open_scanner 属于同一查询」。这个假设对外部读取不成立——N 个 scanner 是 N 个独立消费者。修复没有去改 FE 下发的 `query_id`（那会影响可观测性和排查链路），而是在 BE 入口为每个 scanner 重新生成一个本地 `query_id`，把「外部消费者的独立性」在 BE 侧补齐。

首发版本 3.0.3（labels 含 `dev/3.0.3-merged`），同时回填到 2.1.x 与 3.0.x 线。升级后，Flink/Spark 高并发读 tablet 的稳定性显著改善，scanner 之间不再互相连坐。

---

## 参考

- 外部读取入口与 query_id 生成：`be/src/service/backend_service.cpp`（`BaseBackendService::open_scanner`）
- fragment 登记与查重竞态：`be/src/runtime/fragment_mgr.cpp`（`FragmentMgr::exec_plan_fragment`、`exec_external_plan_fragment`、`coordinator_callback`、`cancel_query`、`cancel_worker`）
- 两张 map 的定义：`be/src/runtime/fragment_mgr.h`（`_pipeline_map`、`_query_ctx_map`）
- thrift 字段缺省：`gensrc/thrift/PaloInternalService.thrift`（`TPipelineFragmentParams.fragment_id`）
