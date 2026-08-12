---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Memory"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "Agent Memory", "FTS5"]
description: "DeerFlow 长期记忆模块解析：MemoryManager 三层契约、DeerMem 默认后端、MemoryUpdateQueue 防抖队列、FTS5 检索与多后端可插拔架构。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 记忆与持久化](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/02-memory-persistence)

---

## 模块定位

本模块属于 **记忆与持久化** 子系统。DeerFlow 的 agent 有长期记忆——从对话中提取 facts、按用户隔离存储、检索后注入回 system prompt。做成可插拔多后端：自研 **DeerMem**（文件 + SQLite FTS5，零外部依赖）、**Honcho**/**OpenViking**（远程用户建模服务）、**mem0**（第三方记忆平台）、**noop**（模板/禁用）。整个后端文件夹可 vendor 到其他 agent 项目——唯一允许的 `from deerflow` import 是 contract line `from deerflow.agents.memory.manager import MemoryManager`。切换后端 = 改 `config.yaml` 一行 + 重启。

## 核心实现

### MemoryManager — 三层契约（pydantic BaseModel）

```python title=backend/packages/harness/deerflow/agents/memory/manager.py
class MemoryManager(BaseModel):
    backend_config: dict[str, Any] = Field(default_factory=dict)
    mode: Literal["middleware", "tool"] = "middleware"
    callbacks: MemoryCallbacks | None = None
    supports_search: ClassVar[bool] = False
    requires_passive_writes_in_tool_mode: ClassVar[bool] = False

    # Tier 1 (abstract, 必须实现)
    @abstractmethod
    def add(self, thread_id, messages, *, agent_name, user_id, trace_id) -> None: ...
    @abstractmethod
    def get_context(self, user_id, *, agent_name, thread_id) -> str: ...
    @classmethod
    @abstractmethod
    def from_config(cls, backend_config, *, mode, **host_hooks) -> MemoryManager: ...
    # Tier 2 (management, 带默认): add_nowait/search/get_memory/clear_memory/shutdown_flush
    # Tier 3 (optional hooks): warm/on_pre_compress/on_turn_start/create_fact/update_fact
```

用 pydantic BaseModel 而非裸 ABC——获得字段校验 + 序列化，且 `ModelMetaclass` 继承 `ABCMeta`，缺 `add`/`get_context` 会在实例时报 `TypeError`（记忆是持久状态，缺契约是严重 bug）。

### DeerMem — 默认后端

```python title=backend/packages/harness/deerflow/agents/memory/backends/deermem/deer_mem.py
class DeerMem(MemoryManager):
    supports_search: ClassVar[bool] = True
    def model_post_init(self, __context):
        self._config = DeerMemConfig.from_backend_config(self.backend_config)
        self._storage = create_storage(self._config)      # FileMemoryStorage
        self._llm = self._config.host_llm or build_llm(self._config.model)
        self._updater = MemoryUpdater(self._config, self._storage, self._llm, ...)
        self._queue = MemoryUpdateQueue(self._config, self._updater)
    def add(self, thread_id, messages, *, agent_name, user_id, trace_id):
        # 过滤→检测信号→入队
    def get_context(self, user_id, *, agent_name, thread_id):
        # 加载 + 格式化注入
    def search(self, query, top_k=5, *, user_id, agent_name, category):
        # FTS5 + 子串回退
```

### FileMemoryStorage — 文件仓库（god 45）

```python title=backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/storage.py
class FileMemoryStorage(MemoryStorage):
    def __init__(self, config: DeerMemConfig, retrieval: RetrievalPort | None = None): ...
    def load(self, agent_name=None, *, user_id=None) -> dict: ...      # 读+迁移+缓存
    def save(self, memory_data, *, expected_revision=None) -> bool: ...  # 乐观并发
    def apply_changes(self, change_set, **scope) -> dict: ...         # 仓库级 upsert/delete
    # 内部: _commit_changes_locked (事务日志 .memory.journal.json + 原子写 Markdown + fsync)
    #        _recover_if_needed (崩溃恢复), _migrate_locked (v1→v2)
```

### MemoryUpdateQueue — 防抖队列

```python title=backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/queue.py
class MemoryUpdateQueue:
    def add(self, thread_id, messages, *, signals) -> None: ...   # 同 key 合并 + 背压
    def add_nowait(self, ...) -> None: ...   # delay=0 立即处理（紧急路径）
    def flush_sync(self, timeout: float) -> bool: ...  # 有界关闭排空
```

### FTS5Retrieval — 全文检索

```python title=backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/retrieval.py
class FTS5Retrieval:
    # 排序: BM25 score × time_decay + confidence × 0.2
    # 中文: jieba 分词 + OR join
    def search(self, query, *, scope_user, scope_agent, top_k, category, mode, filters) -> list[dict]: ...
```

## 调用链路

### 记忆写入（middleware 模式）

```
Agent 产出对话
  ▼
MemoryMiddleware.after_agent()
  ▼
DeerMem.add(thread_id, messages)
  ├─ _prepare_update: filter_messages_for_memory + filter_trivial + detect_signals
  └─ MemoryUpdateQueue.add(...)
       ├─ _enqueue_locked: 同 key 合并(signal union) + 背压(queue_max_depth，非信号项被拒)
       └─ _reset_timer (debounce_seconds 后触发)
            ▼ Timer 线程
       _process_queue → MemoryUpdater.update_memory:
            ├─ storage.load (当前 memory)
            ├─ LLM 调用提取 facts (staleness review + consolidation prompt)
            └─ storage.apply_changes → FileMemoryStorage._commit_changes_locked:
                 ├─ 乐观并发检查 (expected_revision)
                 ├─ 事务日志 (.memory.journal.json, prepared→committed)
                 ├─ 逐 fact 原子写 Markdown (_atomic_write + fsync)
                 ├─ 更新 user-level memory.json (revision+1)
                 └─ 通知 RetrievalPort (FTS5 index upsert)
```

### 记忆检索 + 注入

```
lead_agent 构造 system prompt
  ▼
_get_memory_context()  (lead_agent/prompt.py)
  ▼
DeerMem.get_context(user_id, agent_name, thread_id)
  ├─ [middleware 模式] 加载 agent facts + user 全局 summaries
  ├─ [tool 模式] 仅加载全局 summaries（facts 留给 memory_search 工具）
  └─ FileMemoryStorage.load (跨进程文件锁 + scope RLock + 缓存)
       └─ format_memory_for_injection → 注入 <memory>…</memory>
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 策略 | `manager.py` `_scan_backends` + `get_memory_manager` | 多后端可插拔，扫描 `backends/<name>/__init__.py` 的 `MANAGER_CLASS` |
| 队列 | `MemoryUpdateQueue` | 防抖（debounce 合并）+ 背压（满时拒非信号项，信号项始终准入） |
| 仓库 | `FileMemoryStorage` | fact 级 CRUD + 事务日志 + 原子写；Markdown 为 canonical 存储 |
| 门面 | `get_memory_manager` | 进程级单例工厂，双检锁，注入 host_hooks |
| 协议 | `RetrievalPort` | 检索适配器协议，`FTS5RetrievalAdapter` 实现 |
| 模板方法 | `MemoryManager` 三层契约 | tier-1 骨架 + tier-2/3 默认实现 |

## 模块间交互

- **依赖**：`config`（MemoryConfig 4 字段 + runtime_paths）、`runtime.user_context`、`extensions`（LangfuseMemoryCallbacks）、`models`（create_chat_model host LLM）、`tracing`。
- **被调用**：`middlewares/memory_middleware.py`（after_agent 调 add）、`summarization_hook.py`（压缩前 add_nowait 抢救）、`lead_agent/prompt.py`（get_context 注入）、`memory/tools.py`（memory_search 工具）、`gateway/routers/memory.py`（HTTP 端点）、Gateway lifespan（warm + shutdown_flush）。
- **多后端切换**：改 `config.yaml` 的 `memory.manager_class: deermem|honcho|openviking|mem0|noop` + `backend_config`，`get_memory_manager` 扫描后端文件夹 + `from_config` 构建实例，缓存为进程单例。

## 核心实现（续）

### 为什么可插拔多后端

不同部署需不同记忆方案（本地文件/远程用户建模/企业内部/第三方平台）；后端文件夹可整体 vendor——唯一 `from deerflow` import 是 contract line，改一行即可移植；切换 = 改 config 一行 + 重启，不改核心。noop 既是模板又是显式禁用方式。

### 为什么异步队列写

LLM 提取 facts 昂贵，同步会阻塞 agent；防抖合并同 thread 多轮为一次 LLM 调用；背压降级——队列满时拒非信号更新（`QueueFull`）但信号更新（correction/reinforcement）始终准入，重要记忆不丢；紧急路径 `add_nowait`（delay=0）用于 summarization 前抢救即将被移除的消息；`shutdown_flush(timeout)` 进程退出时有界排空防丢。

### 为什么自研 DeerMem + FTS5

零外部依赖（SQLite FTS5 是 stdlib）；结构化 facts 每个存独立 Markdown（人类可读、可手编、可版本控制）；多级检索（FTS5 BM25×time_decay 为主，子串匹配回退，中文 jieba 分词）；事务安全（两阶段事务日志 + 原子写 fsync + 跨进程文件锁 + revision 乐观锁）。检索是派生数据，通过 `RetrievalPort` 解耦，失败不影响 canonical 记忆。

## 扩展方式

### 新增记忆后端

复制 `backends/noop/` → `backends/postgres/`；编辑 `config.py`（声明字段 + `from_backend_config`）+ `postgres_manager.py`（实现 `from_config` + tier-1 `add`/`get_context`）+ `__init__.py`（`MANAGER_CLASS = PostgresMemoryManager`）；`config.yaml` 设 `memory.manager_class: postgres`。约束：后端唯一 `from deerflow` import 是 contract line；`storage_path` 从 `backend_config` 读。

### 改 FTS5 检索策略

改 `retrieval.py` 的 `FTS5Retrieval._compute_final_score`（BM25×time_decay + confidence×0.2 公式）或 `_preprocess_content`（中文分词）。不影响存储/updater/queue——检索通过 `RetrievalPort` 解耦。

### 调整更新队列

改 `config.py` 的 `DeerMemConfig`（`debounce_seconds`/`queue_max_depth`）或 `queue.py` 的 `_enqueue_locked`（背压策略）。仅 DeerMem 内部。

对应测试：`backend/tests/` 下 `memory/` 各后端单测 + `test_memory_queue.py` + `test_deermem_storage.py`。
