---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Lead Agent & Client"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "LangGraph", "Agent", "ByteDance"]
description: "DeerFlow 的 Lead Agent 图装配入口、DeerFlowClient 嵌入式 facade、SubagentExecutor 子代理执行器与多 provider LLM 工厂的实现解析。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← Agent 编排与运行时](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration)

---

## 模块定位

本模块属于 **Agent 编排与运行时** 子系统，是整个 harness 的"装配车间"：把 LLM model、tools、middlewares、system prompt、state schema 组装成一个可运行的 LangGraph agent 图，并提供两种驱动入口——Gateway/Channels 用的异步 `run_agent` worker，以及 TUI/嵌入式用的同步 `DeerFlowClient` facade。`make_lead_agent` 是 LangGraph Server 注册的 graph factory，`build_middlewares` 是中间件栈的唯一装配点（中间件实现见「Middlewares」模块），`SubagentExecutor` 让 lead agent 能 spawn 隔离的子代理，`create_chat_model` 用配置字符串动态解析 provider 类、适配多家非标准 LLM API。

## 核心实现

### make_lead_agent — graph 装配入口

DeerFlow 2.0 用 LangGraph 的 `create_agent` 生成**有状态的 agent 图**而非线性 chain。`make_lead_agent` 是 LangGraph Server 通过 `langgraph.json` 注册的 factory，签名保持兼容 `RunnableConfig`：

```python title=backend/packages/harness/deerflow/agents/lead_agent/agent.py
def make_lead_agent(config: RunnableConfig):
    """LangGraph graph factory; 保持签名兼容 LangGraph Server。"""
    # 冻结进程级 checkpoint mode → 调用 _make_lead_agent

def _make_lead_agent(config: RunnableConfig, *, app_config: AppConfig):
    # 解析 user_id / model_name / thinking / subagent_enabled / agent_name
    # 加载 skills + tools → apply_tool_authorization → assemble_deferred_tools
    # build_mcp_routing_middleware → create_chat_model(attach_tracing=False)
    # build_middlewares(...) → normalize_middleware_state_schemas
    # apply_prompt_template(...) → create_agent(model, tools, middleware, system_prompt, state_schema)
```

装配链路清晰：

```
make_lead_agent(config)
  └─ _make_lead_agent(config, app_config)
       ├─ resolve_config_user_id(config)        # 用户身份
       ├─ _resolve_model_name(...)              # model: request → agent config → default
       ├─ _authorize_model_name(...)             # model:use 授权
       ├─ _load_enabled_available_skills(...)   # skill 元数据
       ├─ get_available_tools(...)              # 工具集（内置+MCP+skill+ACP）
       ├─ apply_tool_authorization(...)          # Layer 1 工具授权过滤
       ├─ assemble_deferred_tools(...)          # 延迟工具装配
       ├─ create_chat_model(name, attach_tracing=False)
       ├─ build_middlewares(config, ...)         # ~15+ 中间件链
       ├─ normalize_middleware_state_schemas()
       ├─ apply_prompt_template(...)
       └─ create_agent(model, tools, middleware, system_prompt, state_schema)
```

**为什么用图而非链**：agent 图通过 `state_schema=get_thread_state_schema(mode)` 支持 checkpoint 持久化、多轮恢复、时间旅行；`AgentMiddleware` 协议（before_model/after_model/wrap hooks）是图遍历的原生能力；`agent.stream(state, config, stream_mode=["values","messages","custom"])` 支持三模式同时消费；`recursion_limit=100` 控制最大 super-step 防止无限循环。

### DeerFlowClient — 嵌入式同步 facade

`DeerFlowClient`（`client.py`，~1660 行）是与 Gateway 异步路径**并行**而非包装的同步入口：

```python title=backend/packages/harness/deerflow/client.py
class DeerFlowClient:
    def __init__(self, config_path=None, checkpointer=None, *,
        model_name=None, thinking_enabled=True, subagent_enabled=False,
        plan_mode=False, agent_name=None, available_skills=None,
        middlewares=None, environment=None): ...

    def _ensure_agent(self, config: RunnableConfig, *, context=None):
        """懒创建 agent，config key 变化时重建。"""
        # 计算 _agent_config_key (model + thinking + skills + authz)
        # 未变 → 复用缓存；变了 → 重建

    def stream(self, message, *, thread_id=None, **kwargs) -> Generator[StreamEvent]:
        """同步 generator 流式驱动一次 agent 运行。"""

    def chat(self, message, *, thread_id=None, **kwargs) -> str:
        """stream 的便捷封装，累积 delta 返回最终文本。"""
```

**为什么大 facade**：Gateway 的 `run_agent` 是 `async def` + `agent.astream()`，需要完整 asyncio 运行时 + StreamBridge + SSE 序列化；`DeerFlowClient.stream()` 是**同步 generator**，调用方写 `for event in client.stream(...)` 即可，无需碰 asyncio。两者走**相同的装配路径**（`_ensure_agent` 调 `build_middlewares` + `create_chat_model` + `create_agent`），保证嵌入式和 Gateway 行为一致。`_agent_config_key` 元组缓存避免每次调用重建 agent。

### SubagentExecutor — 子代理隔离执行

lead agent 通过 `task` 工具把子任务委派给 `SubagentExecutor`，子代理有独立的 state schema、不持久化 checkpoint、独立 recursion_limit，结果通过 `SubagentResult` 结构化返回：

```python title=backend/packages/harness/deerflow/subagents/executor.py
class SubagentExecutor:
    def __init__(self, config: SubagentConfig, tools, app_config=None,
        parent_model=None, sandbox_state=None, thread_data=None, thread_id=None,
        trace_id=None, user_id=None, user_role=None, ..., extensions=None): ...

    async def _aexecute(self, task: str, result_holder=None) -> SubagentResult:
        # build_initial_state → _create_agent → agent.astream → 收集结果

    def execute(self, task: str, result_holder=None) -> SubagentResult:
        # 检测 event loop：有 → _execute_in_isolated_loop；无 → asyncio.run
```

**为什么独立执行器**：(1) **上下文隔离**——子代理 `checkpointer=False`、`state_schema=ThreadState`（非 lead 的 thread state），中间结果不污染 lead 的 context window；(2) **异步隔离**——`_execute_in_isolated_loop` 用持久化的 isolated event loop，避免与父 loop 冲突（共享 httpx 客户端绑定特定 loop，临时 loop 关闭会泄漏连接）；(3) **协作式取消**——`result.cancel_event` (threading.Event) 在 `astream` 迭代边界检查；(4) **guard cap 透传**——子代理被 `TokenBudgetMiddleware`/`LoopDetectionMiddleware` cap 时 `stop_reason` 传回 lead，区分"完成"和"被截断"；并发由 lead 侧 `SubagentLimitMiddleware` 统一限流。内置子代理在 `subagents/builtins/`（`bash_agent.py`、`general_purpose.py`）注册到 `BUILTIN_SUBAGENTS`。

### create_chat_model — 多 provider 工厂

```python title=backend/packages/harness/deerflow/models/factory.py
def create_chat_model(name=None, thinking_enabled=False, *, app_config=None,
    attach_tracing=True, model_overrides=None, **kwargs) -> BaseChatModel:
    # 1. config.get_model_config(name) 取 ModelConfig
    # 2. resolve_class(model_config.use, BaseChatModel) 动态导入 provider class
    # 3. model_dump 排除元数据 + thinking 开关叠加
    # 4. _normalize_openai_base_url + _apply_stream_chunk_timeout_default
    # 5. model_class(**settings) + attach_tracing → build_tracing_callbacks()
```

**为什么 patched_* 系列**：上游 LangChain 的 provider 适配器对非标准字段处理不完整，DeerFlow 不 fork 上游而是子类化 + 重写 `_get_request_payload`：

| Provider | 解决的问题 | 位置 |
| --- | --- | --- |
| `ClaudeChatModel` | OAuth token (sk-ant-oat) 自动检测 + prompt caching/thinking budget 注入 | `models/claude_provider.py` |
| `PatchedChatOpenAI` | Gemini thinking 模式 `thought_signature` 丢失导致 400 | `models/patched_openai.py` |
| `PatchedChatDeepSeek` | `reasoning_content` 多轮对话不回传 | `models/patched_deepseek.py` |
| `VllmChatModel` | vLLM 0.19 `reasoning` 字段被丢弃 + `thinking→enable_thinking` 映射 | `models/vllm_provider.py` |
| `MindIEChatModel` | chat template 不兼容原生 tool_calls，转 XML | `models/mindie_provider.py` |
| `CodexChatModel` | 用 Responses API（非 Chat Completions），直接继承 BaseChatModel | `models/openai_codex_provider.py` |

**为什么 tracing 在 graph root 而非 model 级**：`make_lead_agent` 和 `DeerFlowClient.stream` 都在 `config["callbacks"]` 注入 tracing（graph root），同时 `create_chat_model(attach_tracing=False)` 关闭 model 级回调——单次运行产生一个 trace，所有 node/LLM/tool 是 child span；model 级注入会重复 span 且破坏 Langfuse `propagate_attributes` 路径。独立调用者（MemoryUpdater、TitleMiddleware）不在 graph 内，保留 `attach_tracing=True`。

## 调用链路

DeerFlowClient 驱动一次 agent 运行的流式路径：

```
DeerFlowClient.stream(message, thread_id)
  ├─ get_current_trace_id() or generate_trace_id()
  └─ _stream_without_trace_context(message, ...)
       ├─ resolve_thread_id(thread_id)
       ├─ _get_runnable_config(thread_id, **kwargs)
       ├─ inject_checkpoint_mode(config, ...)
       ├─ get_checkpointer() + build_tracing_callbacks() → config["callbacks"]
       ├─ inject_langfuse_metadata(config, ...)
       ├─ _ensure_agent(config, context)          # 懒创建/复用 agent
       │    ├─ _authorize_model_name(...)
       │    ├─ _get_tools(model_name, subagent_enabled)
       │    ├─ get_enabled_skills_for_config(...)
       │    ├─ apply_tool_authorization → assemble_deferred_tools
       │    ├─ create_chat_model(attach_tracing=False)
       │    ├─ build_middlewares(config, ...)
       │    └─ create_agent(**kwargs)             # LangGraph 图装配
       └─ self._agent.stream(state, config,
            stream_mode=["values","messages","custom"])
            ├─ messages → 逐 token delta + tool_calls + tool results
            ├─ values  → 完整 state 快照
            └─ custom → 自定义事件
            → yield StreamEvent(type, data)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `make_lead_agent` | LangGraph Server graph factory | 签名兼容 `RunnableConfig`，冻结 checkpoint mode |
| `_make_lead_agent` | 装配 agent 图 | model→tools→middlewares→prompt→create_agent |
| `build_middlewares` | 组装中间件链 | 顺序敏感，跨模块被 client.py 复用 |
| `DeerFlowClient._ensure_agent` | 懒创建/复用 agent | config key 缓存避免重建 |
| `DeerFlowClient.stream` | 同步流式驱动 | 同步 generator，无需 asyncio |
| `SubagentExecutor._aexecute` | 异步执行子代理 | isolated loop + 协作式取消 |
| `SubagentExecutor.execute` | 同步封装 | 检测 event loop 选路径 |
| `create_chat_model` | LLM 工厂 | `resolve_class` 动态导入，patched_* 适配 |

</details>

## 模块间交互

本模块是装配中枢，向上承接三种入口、向下汇聚所有能力子系统：

- **被谁调用**：`langgraph.json` 注册 `make_lead_agent` 给 LangGraph Server；`backend/app/gateway/services.py` 取 factory 驱动 HTTP run；`tui/session.py` 用 `DeerFlowClient` 驱动终端会话；`subagents/executor.py` 用 `create_chat_model` 建子代理 LLM。
- **import 的下游**：`agents/middlewares/*`（~15 中间件）、`runtime/*`（checkpoint mode、user_context、goal）、`tools`（get_available_tools）、`skills`（build_skill_search_setup）、`models`（create_chat_model）、`extensions`（compose_with_extensions）、`tracing`（build_tracing_callbacks）、`authz`（apply_tool_authorization）、`sandbox.security`（is_host_bash_allowed）、`agents/memory`（get_memory_tools/manager）。

模块间的动态交互顺序见概览「核心运行流程」的 HTTP API 链路。

## 扩展方式

### 新增一家 LLM Provider

1. 新建 `models/xxx_provider.py`，定义 `XxxChatModel(BaseChatModel)` 或子类化已有 provider；若 provider 有非标准字段需多轮回传，重写 `_get_request_payload`（参照 `PatchedChatOpenAI`）。
2. 在 `config.yaml` 添加 model 条目，`use: deerflow.models.xxx_provider:XxxChatModel`。
3. `create_chat_model` 本身**不需改**——`resolve_class(model_config.use)` 动态解析。OpenAI-compatible provider 自动享受 `_normalize_openai_base_url` 等处理。

### 新增一个内置子代理

1. 新建 `subagents/builtins/xxx_agent.py`，定义 `XXX_AGENT_CONFIG = SubagentConfig(name="xxx", description=..., system_prompt=..., tools=[...], max_turns=N)`。
2. 在 `subagents/builtins/__init__.py` 的 `BUILTIN_SUBAGENTS` 字典注册。
3. 约束：`SubagentConfig.disallowed_tools` 默认含 `"task"`（子代理不可再 spawn 子代理）；`model="inherit"` 继承 lead 模型。

### 修改 lead_agent 的中间件链

改 `agents/lead_agent/agent.py` 的 `build_middlewares`（`agent.py:382`）。顺序严格敏感：`DynamicContextMiddleware` 必须在 `SummarizationMiddleware` 前；`ClarificationMiddleware` 必须最后。`build_middlewares` 被 `client.py` 跨模块调用，签名变更会 ripple 到 `DeerFlowClient`。扩展中间件通过 `compose_with_extensions` 最后合并，不能进 `build_lead_runtime_middlewares` 内部。

对应测试：`backend/tests/` 下 `test_lead_agent.py`、`subagents/test_executor.py`、`models/test_factory.py`。
