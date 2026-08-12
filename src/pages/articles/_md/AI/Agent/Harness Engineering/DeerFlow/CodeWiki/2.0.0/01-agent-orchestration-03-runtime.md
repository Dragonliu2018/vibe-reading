---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Runtime"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "LangGraph", "Runtime", "Asyncio"]
description: "DeerFlow Runtime 模块解析：RunManager 的 run 生命周期管理、run_agent worker 的流式执行、RunJournal 事件溯源、lease/heartbeat 多 worker 协调与 checkpoint 缓存。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← Agent 编排与运行时](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration)

---

## 模块定位

本模块属于 **Agent 编排与运行时** 子系统，负责一次 agent run 的完整生命周期——从 `RunManager` 创建/准入/取消 `RunRecord`，到 `run_agent` worker 用 `agent.astream()` 流式执行并经 `StreamBridge` 推 SSE，到 `RunJournal` 作为 LangChain callback 做事件溯源 + token 统计。它还解决多 worker 部署的故障恢复（lease/heartbeat/orphan recovery）和 delta checkpoint 的性能问题（read-through 缓存）。`DeerFlowClient`（TUI 路径）不复用 `run_agent`，而是自己跑同步 stream 管道——两条路径共享 `make_lead_agent` 装配但不共享 worker。

## 核心实现

### RunRecord — 一次 run 的可变状态

```python title=backend/packages/harness/deerflow/runtime/runs/manager.py
@dataclass
class RunRecord:
    run_id: str
    thread_id: str
    status: RunStatus              # pending/running/success/error/timeout/interrupted
    on_disconnect: DisconnectMode  # cancel/continue
    operation_kind: ThreadOperationKind
    multitask_strategy: str        # reject/interrupt/rollback
    task: asyncio.Task | None      # 后台 worker task 引用
    start_lock: asyncio.Lock       # 启动屏障锁
    abort_event: asyncio.Event     # 取消信号
    abort_action: str              # "interrupt" | "rollback"
    error: str | None
    model_name: str | None
    # 多 worker ownership
    owner_worker_id: str | None
    lease_expires_at: str | None
    ownership_lost: bool           # fence 标记：此 worker 已丧失 lease
    stop_reason: str | None        # "loop_capped"/"token_capped"/"safety_capped"
    # token 统计
    total_input_tokens / total_output_tokens / total_tokens
    lead_agent_tokens / subagent_tokens / middleware_tokens
    token_usage_by_model: dict
```

### RunManager — 运行时注册表 + 生命周期管理器

```python title=backend/packages/harness/deerflow/runtime/runs/manager.py
class RunManager:
    def __init__(self, store, *, persistence_retry_policy, worker_id,
                 run_ownership_config, event_store, on_orphans_recovered): ...
    async def create_or_reject(self, thread_id, *, on_disconnect, metadata, kwargs,
                               multitask_strategy, model_name, user_id) -> RunRecord
    async def try_start(self, run_id: str) -> RunStartOutcome      # pending→running 屏障
    async def cancel(self, run_id, *, action="interrupt") -> CancelOutcome
    async def set_status_if_not_cancelled(self, run_id, status, ...) -> str | None
    async def reconcile_orphaned_inflight_runs(self, *, error, before, stop_reason) -> list[RunRecord]
    async def reserve_thread_operation(self, thread_id, *, kind, user_id)  # 非 run 独占准入
```

`RunManager` 持有 `_runs: dict` 内存索引 + `_runs_by_thread` 二级索引，所有变更用 `asyncio.Lock` 保护。`try_start` 用 `start_lock` 串行化 + `store.start_run()` CAS——如果 CAS 失败（已被其他 worker 取消）返回 `RunStartOutcome.cancelled`。

### run_agent — worker 执行函数

```python title=backend/packages/harness/deerflow/runtime/runs/worker.py
@dataclass(frozen=True)
class RunContext:
    checkpointer: Any
    store: Any | None
    event_store: Any | None
    thread_store: Any | None
    app_config: AppConfig | None
    extensions: Any | None
    checkpoint_channel_mode: CheckpointChannelMode  # "full" | "delta"
    on_run_completed: Any | None

async def run_agent(bridge: StreamBridge, run_manager: RunManager, record: RunRecord,
                    *, ctx: RunContext, agent_factory, graph_input, config,
                    stream_modes, stream_subgraphs, interrupt_before, interrupt_after) -> None
```

### RunJournal — 事件溯源

```python title=backend/packages/harness/deerflow/runtime/journal.py
class RunJournal(BaseCallbackHandler):
    deerflow_loop_bound = True    # 不传递给子 agent 的独立事件循环
    run_inline = True             # 在 run 的事件循环线程上执行
    def __init__(self, run_id, thread_id, event_store, *,
                 track_token_usage=True, flush_threshold=20, ...): ...
    # LangChain callback: on_chain_start/end, on_chat_model_start, on_llm_end, on_tool_end...
    # 缓冲写入: _buffer 批量 flush(threshold=20) 到 event_store
```

### _AutoSentinel — 用户上下文哨兵

```python title=backend/packages/harness/deerflow/runtime/user_context.py
class _AutoSentinel:           # 单例，含义"从 contextvar 解析 user_id"
AUTO: Final[_AutoSentinel] = _AutoSentinel()
def resolve_user_id(value, *, method_name) -> str | None:
    # AUTO → contextvar 读取，无则 raise
    # str → 直接用；None → 跳 WHERE（migration/CLI）
```

三态语义让 repository 方法零 boilerplate——调用者无需每层传 `user_id`，auth middleware 在请求入口设 `ContextVar`，repository 自动读取。`asyncio.create_task`/`asyncio.to_thread` 继承父 task context，天然隔离。

## 调用链路

一次 run 的完整生命周期：

```
Gateway services.start_run()
  └─ run_mgr.create_or_reject(...) → RunRecord(pending) + store.put()
  └─ asyncio.create_task(run_agent(bridge, run_manager, record, ctx=RunContext(...)))
       │
       ├─ wait_for_prior_finalizing(thread_id, run_id)   # 等前序 run 收尾
       ├─ try_start(run_id)  ── store.start_run() CAS ── pending→running
       ├─ agent = agent_factory(config)   # make_lead_agent
       ├─ _capture_rollback_point(...)     # 预存 pre-run checkpoint
       ├─ bridge.publish(run_id, "metadata", {...})
       ├─ _stream_once(graph_input, config):
       │    └─ agent.astream(input, config, stream_mode=lg_modes)
       │         ├─ values → 完整 state 快照
       │         ├─ messages-tuple → AI delta + tool results
       │         └─ custom → subagent step events
       │         每 chunk → serialize() → bridge.publish() → SSE
       │    RunJournal 并行记录: on_llm_end 累积 token, 批量 flush 到 event_store
       ├─ _prepare_goal_continuation_input(...)  # 可选 goal 续轮
       └─ finally:
            ├─ _persist_delivery_receipt(event_store, ...)
            ├─ journal.flush()
            ├─ run_mgr.set_status(run_id, success/error/interrupted)
            ├─ record_workspace_changes(event_store, ...)
            ├─ thread_store.update_status(thread_id, "idle")
            └─ bridge.publish_end(run_id)
```

Run 状态机：`pending`→`try_start`→`running`→`success`/`error`/`interrupted`（见概览状态流 SVG）。`cancel(action=rollback)` 回滚到 pre-run checkpoint。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `create_or_reject` | 创建 RunRecord + 多 task 策略校验 | `multitask_strategy` reject/interrupt/rollback |
| `try_start` | pending→running CAS | `start_lock` + `store.start_run()` |
| `cancel` | 取消 run | `abort_event` + `task.cancel()`，action=interrupt/rollback |
| `reconcile_orphaned_inflight_runs` | 接管 lease 过期的 run | 多 worker 故障恢复 |
| `run_agent` | worker 主函数 | stream 循环 + goal 续轮 + delivery 验证 |
| `RunJournal._put/_flush` | 事件缓冲写入 | threshold=20 批量 flush |
| `resolve_user_id` | 用户上下文解析 | AUTO 哨兵 + contextvar |

</details>

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 管理器 | `RunManager` | 集中管理 run 创建/状态转换/取消/查询，内存索引 + store 协调 |
| 工作器 | `run_agent` | agent 执行解耦为独立 async task，stream 循环 + goal 续轮 + rollback |
| 事件溯源 | `RunJournal` + `RunEventStore` | LangChain callback → 标准 `RunEvent` → 持久化（memory/jsonl/db） |
| 桥接/发布订阅 | `StreamBridge` ABC | 解耦 producer/consumer，`MemoryStreamBridge`（单进程）/`RedisStreamBridge`（跨进程） |
| 装饰器 | `CachedHistorySaver` | 包装 `BaseCheckpointSaver`，read-through delta-history 缓存 |
| 哨兵 | `_AutoSentinel` | user_id 三态语义 |
| 租约/心跳 | `manager.py` lease + `reconcile_orphaned_inflight_runs` | 多 worker 故障恢复 + fence |
| 重试策略 | `PersistenceRetryPolicy` + `_call_store_with_retry` | SQLite lock contention 指数退避 |

## 模块间交互

- **依赖**：`agents/lead_agent`（agent_factory + GoalState）、`config`（AppConfig via RunContext）、`persistence/run`（RunStore protocol + RunRepository）、`checkpointer/` + `checkpoint_cache/`、`stream_bridge/`、`store/`、`tracing`、`workspace_changes`、`extensions`。
- **被调用**：`app/gateway/services.py`（HTTP 路径，`create_or_reject` + `asyncio.create_task(run_agent)`）；`DeerFlowClient`（TUI 路径，不复用 `run_agent`，自跑同步 stream）。
- **StreamBridge 跨进程**：`MemoryStreamBridge`（`asyncio.Condition` + event list，支持 `Last-Event-ID` 重连）；`RedisStreamBridge`（Redis Streams `XADD`/`XREAD`，**故意不**在 `__init__` 导入避免每进程加载 `redis.asyncio`）。

## 核心实现（续）

### 为什么 run 拆成 manager + worker

(1) **关注点分离**：Manager 管状态（同步、可并发的状态机），Worker 管执行（长时 async task）；(2) **生命周期解耦**：worker 崩溃时 Manager + store 仍能检测孤儿 run 并 `reconcile_orphaned_inflight_runs` 恢复；(3) **多 worker 部署**：不同进程的 Manager 通过共享 store（Postgres）协调，Worker 只执行本地持有的 run。

### 为什么有 RunJournal 事件溯源

(1) **可重放**：LangChain 细粒度 callback 标准化为 `RunEvent` 持久化，进程重启后可重放 run 历史；(2) **Token 统计**：`on_llm_end` 按 caller（`lead_agent`/`subagent:{name}`/`middleware:{name}`）和 model 分桶，避免在 worker 主循环穿插；(3) **Delivery 验证**：跟踪 `present_file` 工具的 artifacts，run 结束验证交付完整性；(4) **缓冲写入**：`_buffer` 批量 flush（threshold=20）避免高频 callback 逐条写库。

### 为什么 checkpoint_cache

delta checkpoint 模式下，恢复状态需递归遍历 checkpoint 祖先链 compose 所有 delta——O(depth) 每次重复。`CachedHistorySaver` 包装 saver 做 read-through 缓存，键 `(thread_id, checkpoint_ns, checkpoint_id, channel)` 不可变（append-only lineage），**写入后永不需失效**。后端可插拔（memory LRU / redis 跨进程共享）。

### 为什么 lease/heartbeat

多 worker 中 Worker A 崩溃后它持有的 run 在 store 仍 `running`。lease 让 Worker B 检测过期后安全接管（`claim_for_takeover`）。`ownership_lost` fence 让丧失 lease 的 worker 停止所有持久化写——防 zombie worker 覆盖接管者终态。`heartbeat_enabled=False` 时降级为直接 reclaim（向后兼容）。

## 扩展方式

### 改 run 状态机（如加 "paused" 状态）

`runs/schemas.py` 的 `RunStatus` 加 `paused`；`manager.py` 的 `try_start`/`set_status`/`_persist_status` 的 CAS guard 扩展 `status IN (...)`；`store/base.py` 的 `RunStore` protocol 的 guard 更新；`worker.py` finally 块处理 `paused`。风险：`RunStatus` 渗透整个 manager + store，改动面广。

### 新增 stream 模式

`stream_modes.py` 的 `RunStreamMode` Literal + `SUPPORTED_RUN_STREAM_MODES` 加新模式；`worker.py` 的 `_stream_once` 加到 `lg_modes` 或在 `to_langgraph_stream_modes` 加映射；`serialization.py` 加对应序列化。风险低——设计为可扩展 Literal + frozenset。

### 换 checkpointer 后端（sqlite→postgres）

`checkpointer/provider.py` + `store/provider.py` 改后端选择；`persistence/run/sql.py` 的 SQL DDL 适配 Postgres（partial unique index 等）。Manager 的重试逻辑已同时处理 SQLite/Postgres 错误码。风险中。

对应测试：`backend/tests/` 下 `runtime/test_manager.py`、`test_worker.py`、`test_journal.py`、`test_stream_bridge.py`。
