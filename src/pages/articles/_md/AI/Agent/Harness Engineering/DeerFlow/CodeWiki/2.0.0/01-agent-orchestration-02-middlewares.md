---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Middlewares"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "LangGraph", "Middleware", "Agent"]
description: "DeerFlow 中间件栈解析：基于 LangGraph AgentMiddleware 的洋葱模型，15+ 中间件按确定顺序组装，覆盖循环检测、上下文压缩、技能激活、错误重试、安全终止等横切关注点。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← Agent 编排与运行时](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration)

---

## 模块定位

本模块属于 **Agent 编排与运行时** 子系统。13,712 行、41 个文件组成的中间件栈是 DeerFlow 把横切关注点（cross-cutting concerns）从 agent 核心逻辑解耦的核心机制。每个中间件可在 LLM 调用前修改 `ModelRequest`、调用后修改 state、包裹整个 model/tool 调用。`build_middlewares`（在 `agents/lead_agent/agent.py`，装配点归入 Lead Agent 模块）按确定顺序组装 ~15+ 中间件；本模块负责各中间件的实现与执行语义。子代理复用 `build_subagent_runtime_middlewares`，与 lead 共享基础层但去掉 lead 专属中间件。

## 核心实现

### 中间件契约 — AgentMiddleware

所有中间件继承 `langchain.agents.middleware.AgentMiddleware`。两类 hook：

- **Lifecycle hooks**（返回 `dict | None` 作为 state update）：`before_agent`/`abefore_agent`、`before_model`/`abefore_model`、`after_model`/`aafter_model`、`after_agent`/`aafter_agent`
- **Wrap hooks**（接收 `request` + `handler`，可拦截/替换）：`wrap_model_call`/`awrap_model_call`、`wrap_tool_call`/`awrap_tool_call`

LangChain 通过**类级别身份检查**（`m.__class__.before_model is not AgentMiddleware.before_model`）判断中间件是否实现了某 hook，以此决定是否接入调用链。

### 关键中间件

```python title=backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py
class LoopDetectionMiddleware(AgentMiddleware[AgentState]):
    """Detects and breaks repetitive tool call loops."""
    def __init__(self, warn_threshold=3, hard_limit=5, window_size=20, ...):
    # hooks: before_agent, after_model, after_agent, wrap_model_call
    def after_model(self, state, runtime) -> dict | None:
        return self._apply(state, runtime)        # 哈希 tool_calls，检测循环，队列警告
    def wrap_model_call(self, request, handler) -> ModelCallResult:
        return handler(self._augment_request(request))  # 注入排队的警告
```

```python title=backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py
class DeerFlowSummarizationMiddleware(SummarizationMiddleware):
    """Summarization middleware with pre-compression hook dispatch."""
    # hooks: before_model / abefore_model — 检查 token 数，超阈值压缩历史
```

```python title=backend/packages/harness/deerflow/agents/middlewares/llm_error_handling_middleware.py
class LLMErrorHandlingMiddleware(AgentMiddleware[AgentState]):
    """Retry transient LLM errors and surface graceful assistant messages."""
    retry_max_attempts: int = 3
    def wrap_model_call(self, request, handler) -> ModelCallResult:
        if self._check_circuit():                 # 熔断器开启
            return self._build_error_fallback_message(...)
        while True:
            try:
                response = self._bounded_model_call_sync(request, handler)
                self._record_success()
                return response
            except Exception as exc:
                retriable, reason = self._classify_error(exc)  # 策略：不同错误不同退避
                if retriable and attempt < max_attempts:
                    time.sleep(wait_ms / 1000); attempt += 1; continue
                return self._build_user_fallback_message(exc, reason)
```

```python title=backend/packages/harness/deerflow/agents/middlewares/clarification_middleware.py
class ClarificationMiddleware(AgentMiddleware[ClarificationMiddlewareState]):
    # hooks: wrap_tool_call — 拦截 ask_clarification 工具调用
    def wrap_tool_call(self, request, handler) -> ToolMessage | Command:
        if request.tool_call.get("name") != "ask_clarification":
            return handler(request)
        return self._handle_clarification(request)  # 返回 Command(goto=END)
```

### IsolatedMiddleware — 扩展故障隔离包装

第三方扩展贡献的中间件用 `IsolatedMiddleware` 包装，确保扩展 bug 不中断用户运行：

```python title=backend/packages/harness/deerflow/extensions/isolation.py
class IsolatedMiddleware(AgentMiddleware):
    def __new__(cls, inner, source, on_error, *, name=None):
        if cls is IsolatedMiddleware:
            cls = _wrapper_subclass(_implemented_hooks(inner))  # 动态缓存子类
        return super().__new__(cls)
    def __init__(self, inner, source, on_error, *, name=None):
        self._inner = inner
        # 镜像 inner 的 tools/transformers/state_schema，让 LangChain 工厂看到相同接口
```

机制：`_wrapper_subclass(hooks)` 按 hook 集合**缓存子类**（`_subclass_cache`），相同 hook 组合共享一个子类；`_make_async_wrap_delegate`/`_make_sync_wrap_delegate` 为 wrap hook 生成委托函数调用 `_invoke_*`；wrap hook 失败时若 handler 已调用则返回已捕获结果，未调用则旁路调 `handler(request)`；lifecycle hook 失败返回 `None`。所有失败经 `_report()` 记为 `Diagnostic` 不抛异常。当前版本所有扩展贡献是**观测性**的（fail-open），拦截性贡献需 fail-closed 并显式退出此 wrapper。

## 调用链路

### 栈组装

`build_middlewares`（`agents/lead_agent/agent.py:382`）组装分三阶段：

```
build_middlewares(config, model_name, ...)
  ├─ 阶段1: build_lead_runtime_middlewares() → _build_runtime_middlewares()
  │   ├─ Layer 1 (outer wrappers): InputSanitization → ToolOutputBudget → ToolResultSanitization
  │   ├─ Layer 2 (thread hooks): ThreadData → Uploads → Sandbox
  │   └─ Layer 3 (tail): DanglingToolCall → LLMErrorHandling → [Authz/Guardrail]
  │                       → SandboxAudit → [ReadBeforeWrite] → ToolErrorHandling
  ├─ 阶段2: lead 专属（按序 append）
  │   DynamicContext → SkillActivation → SkillToolPolicy → DurableContext
  │   → [Summarization] → [Todo if plan_mode] → [TokenUsage] → Title
  │   → Memory → [ViewImage if vision] → [McpRouting] → [DeferredToolFilter]
  │   → SystemMessageCoalescing → [SubagentLimit] → [LoopDetection]
  │   → [TokenBudget] → [custom] → [extension] → TerminalResponse
  │   → ModelLengthFinishReason → [SafetyFinishReason] → Clarification (永远最后)
  └─ 阶段3: compose_with_extensions() — IsolatedMiddleware 包装每个扩展中间件
```

### 一次 LLM 调用穿过中间件栈

LangChain 规则：列表中 first = outermost。`wrap_model_call` 按 outer→inner 包裹；`before_model`/`after_model` 按 outer→inner 执行 before，inner→outer（反向）执行 after。

```
User Input
  ▼
before_agent (outer→inner): ThreadData 初始化 thread_id；LoopDetection 清理 pending
  ▼
before_model (outer→inner): Summarization 检查 token 压缩历史；ViewImage 注入图片
  ▼
wrap_model_call 嵌套 (outer→inner):
  InputSanitization → LoopDetection(注入警告) → SkillActivation(注入 SKILL.md)
    → LLMErrorHandling(重试/熔断) → SystemMessageCoalescing → handler → LLM
  ▼
after_model (inner→outer, 反向):
  SafetyFinishReason(剥离安全终止的 tool_calls) → LoopDetection(哈希检测)
  ▼
after_agent (outer→inner): LoopDetection 清理当前 run pending
```

**为什么 LoopDetection 的警告在 wrap_model_call 而非 after_model 注入**：`after_model` 发射时工具节点尚未运行，没有对应 `ToolMessage`，此时插入消息会落在 `AIMessage(tool_calls)` 和响应之间，导致 OpenAI/Moonshot 报 `tool_call_ids did not have response messages`。延后到 `wrap_model_call` 时所有 ToolMessage 已就位，警告追加末尾不影响 pairing。

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 责任链/洋葱模型 | 整个栈 | 所有中间件都有机会处理，形成 onion 包裹而非"一个处理就停" |
| 装饰器 | `wrap_model_call`/`wrap_tool_call` | `handler` 是被包裹的下一层，中间件在调用前后插入逻辑 |
| 策略 | `LLMErrorHandlingMiddleware._classify_error` | 不同错误（burst_rate/quota/auth/timeout）不同退避基准 |
| 装饰器+动态子类缓存 | `IsolatedMiddleware` | 扩展中间件隔离包装，`_subclass_cache` 按 hook 集合复用子类 |

## 核心实现（续）

### 为什么循环检测/压缩/技能激活做成中间件

- **循环检测**（`loop_detection_middleware.py`）：P0 安全需求——防止 agent 无限调用同一工具直到 recursion_limit 杀死 run。`after_model` 检测 + `wrap_model_call` 注入警告 + `after_agent` 清理，三个 hook 覆盖完整生命周期。
- **上下文压缩**（`summarization_middleware.py`）：`before_model` 在每次 LLM 调用前检查 token 数并压缩历史，支持 `BeforeSummarizationHook` 协议让 `DurableContextMiddleware` 在压缩前保存数据。
- **技能激活**（`skill_activation_middleware.py`）：`wrap_model_call` 在 LLM 调用前注入完整 SKILL.md，使 base system prompt 保持 metadata-only 利于 prefix-cache 复用；工具循环中的后续 model call 也保持激活态。

### 为什么有些中间件处理 finish_reason

Provider 可能因输出长度限制或安全策略提前终止，但 LangChain 默认不区分终止原因。`ModelLengthFinishReasonMiddleware` 标记长度截断的 run-level stop_reason；`SafetyFinishReasonMiddleware` 剥离安全终止的 tool_calls（防继续执行不安全工具），注册在 `TerminalResponseMiddleware` 之后是利用 LangChain 反向 after_model 分发——Safety 先执行剥离，LoopDetection 后执行时看到的是已清理消息。

## 模块间交互

| 中间件 | 依赖模块 | 交互 |
| --- | --- | --- |
| SkillActivation | `deerflow.skills`（storage/slash/types）、`runtime.secret_context` | 读 SKILL.md、解析 `/skill`、绑定 secret |
| Summarization | `deerflow.models`（create_chat_model）、`extensions` | 构建摘要模型，多模型回退 |
| LLMErrorHandling | `config.app_config` | 读 `llm_call` 配置（重试/退避/并发） |
| Clarification | `langgraph.types.Command`/`END` | `Command(goto=END)` 中断执行 |
| McpRouting | MCP catalog | 推迟式 MCP schema 提升 |
| `_build_runtime_middlewares` | `sandbox.middleware`、`authz.runtime`、`guardrails` | 沙箱/授权/护栏中间件 |

**被谁调用**：`build_middlewares` 被 `make_lead_agent` 和 `DeerFlowClient._ensure_agent` 调用；`build_subagent_runtime_middlewares` 被 `SubagentExecutor` 调用。

## 扩展方式

### 新增一个中间件（如 PII 脱敏）

1. 创建 `middlewares/pii_redaction_middleware.py`，继承 `AgentMiddleware[AgentState]`，实现 `before_model`/`abefore_model`。
2. 在 `build_middlewares()`（`agent.py:382`）添加 `middlewares.append(PIIRedactionMiddleware())`，**位置至关重要**——必须在 `InputSanitization` 之后、`Summarization` 之前。
3. 扩展贡献的中间件通过 `compose_with_extensions()` 注入，自动被 `IsolatedMiddleware` 包装。

### 调整栈顺序

改 `build_middlewares` 的 append 位置。注意 LangChain 反向 after_model 分发：若需 LoopDetection 在 SafetyFinishReason 之后执行（看已清理消息），LoopDetection 必须在列表中**更早**注册（Safety 之后 append 意味着 LoopDetection 的 after_model 先执行）。改后跑 `deerflow.extensions.ordering` 的 invariant 校验。

### 改某中间件阈值

循环检测 `hard_limit` 从 5 改 3：不改代码，改 `config.yaml` 的 `loop_detection.hard_limit: 3`（`LoopDetectionConfig` 是 Pydantic model）；改默认值则改 `loop_detection_middleware.py` 的 `_DEFAULT_HARD_LIMIT`。`LLMErrorHandlingMiddleware` 重试次数通过 `app_config.llm_call.retry_max_attempts` 配置。

对应测试：`backend/tests/` 下 `middlewares/` 各中间件单测 + `test_middleware_ordering.py`。
