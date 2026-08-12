---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Tools, Extensions & MCP"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "MCP", "Extensions", "Tools"]
description: "DeerFlow 工具聚合/扩展注入/MCP 集成三模块解析：get_available_tools 四源聚合、PlacementAnchor 语义注入、MCPSessionPool 持久会话。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 能力扩展与沙箱](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox)

---

## 模块定位

本模块属于 **能力扩展与沙箱** 子系统，三个正交子系统构成 DeerFlow 工具生态：**tools** 是聚合框架——把内置工具、skill 工具、MCP 工具、ACP 工具统一装配为 `list[BaseTool]` 并做 async→sync 适配；**extensions** 是扩展系统——第三方插件通过 `install()` 注册 middleware，按语义 `PlacementAnchor` 注入 middleware stack；**mcp** 是 MCP（Model Context Protocol）集成——连外部 MCP server、管理持久 session pool、把外部工具暴露为 LangChain BaseTool。三者职责边界清晰：tools=聚合、extensions=注入、mcp=外部协议。

## 核心实现

### get_available_tools — 四源聚合工厂

```python title=backend/packages/harness/deerflow/tools/tools.py
def get_available_tools(groups, include_mcp, model_name, subagent_enabled, ...) -> list[BaseTool]:
    # 1. 从 AppConfig 读 tool_configs 按 groups 过滤
    #    LocalSandboxProvider 激活时剔除 host bash 工具 (_is_host_bash_tool)
    # 2. resolve_variable(cfg.use, BaseTool) 动态加载每个配置工具
    # 3. BUILTIN_TOOLS = [present_file, ask_clarification, review_skill_package]
    #    + list_uploaded_files + skill_manage_tool (if skill_evolution) + task_tool (if subagent)
    # 4. view_image_tool (if model supports vision)
    # 5. MCP 工具 (if include_mcp): get_cached_mcp_tools → tag_mcp_tool
    # 6. ACP 工具 (if acp_agents)
    # 7. 合并去重: config-loaded > builtin > MCP > ACP (按 tool.name)
```

### _ensure_sync_invocable_tool — async→sync 适配

```python title=backend/packages/harness/deerflow/tools/sync.py
def _ensure_sync_invocable_tool(tool: BaseTool) -> BaseTool:
    if getattr(tool, "func", None) is None and getattr(tool, "coroutine", None) is not None:
        tool.func = make_sync_tool_wrapper(tool.coroutine, tool.name)  # 异步工具打 sync func
    return tool

def make_sync_tool_wrapper(coro, tool_name):
    # 返回 sync callable: _SYNC_TOOL_EXECUTOR (10 线程) 跑 asyncio.run(coro)
    # contextvars.copy_context() 传播上下文; 检测 RunnableConfig 参数注入 config
```

### ExtensionRegistry — 可变注册阶段

```python title=backend/packages/harness/deerflow/extensions/registry.py
@dataclass(frozen=True)
class LoadedExtensions:  # 不可变运行时视图
    app_store: ExtensionData
    middleware_contributors: tuple[...] = ()
    has_middleware_contributors: bool = False  # 预计算, 零扩展短路
    # + task_lifecycle / system_model_observers
class ExtensionRegistry(ExtensionRegistryContract):  # 可变注册阶段, host-only 机制不暴露给扩展
    # attributed_to(spec.use) context manager 标记 source; mark/rollback_to 位置回滚; build() → LoadedExtensions
```

### PlacementAnchor — 语义注入位置

```python title=backend/packages/harness/deerflow/extensions/anchors.py
@dataclass(frozen=True)
class AnchorRule:
    side: _Side  # outer/inner/outer_last/inner_last/inner_last_after/start/end
    types: tuple[type, ...] = ()
    after_types: tuple[type, ...] = ()
@dataclass(frozen=True)
class PlacementAnchor:    # 有序 fallback chain
    chain: tuple[AnchorRule, ...]
# Placement.MODEL_LOGICAL = outer_of(LLMErrorHandling)  — "一次逻辑决策=一次事件, 即使 retry"
# Placement.MODEL_PHYSICAL = inner_of_last_after(SafetyFinishReason, after=TerminalResponse)  — "观察真正发给 LLM 的"
# Placement.TOOL_VISIBLE = outermost()  — "工具调用入口"
# Placement.TOOL_RAW = inner_of_last(Clarification)  — "工具真实返回"
```

### MCPSessionPool — 持久会话

```python title=backend/packages/harness/deerflow/mcp/session_pool.py
class MCPSessionPool:  # MAX_SESSIONS=256, SESSION_CLOSE_TIMEOUT=5.0
    # LRU 淘汰, 按 (server_name, scope_key) 隔离
```

## 调用链路

### Extensions 加载/注入/排序

```
config.yaml plugins: list[ExtensionSpec]
  ▼ load_extensions(specs) [loader.py]
  ├─ ExtensionRegistry (可变)
  └─ for spec: resolve_variable(spec.use) → install 函数
       ├─ __deerflow_api__ 版本标记 semver 检查
       ├─ registry.mark() 快照 bucket 长度
       ├─ with registry.attributed_to(spec.use): install(registry, _frozen_config(config))
       └─ 失败 → rollback_to(mark); required=True → raise ExtensionLoadError
  ▼ registry.build() → LoadedExtensions (不可变)

compose_with_extensions(middlewares, scope, ctx, extensions) [stack.py]
  ├─ _placement_anchors_for_scope(scope) → PlacementAnchor 表
  ├─ inject_middlewares: 遍历 middleware_contributors → 收集 → 按 (placement.order, 注册顺序) 排序
  │    每个 contribution: anchor.resolve(result) → (index, used_primary_rule)
  │    从后往前插入 (避免索引偏移): IsolatedMiddleware(middleware, source, ...) 包装
  └─ assert_ordering(result, provenance)  # core_ordering_constraints 校验
```

### MCP client 连外部 server

```
initialize_mcp_tools() [cache.py]
  ├─ ExtensionsConfig.from_file() → get_enabled_mcp_servers()
  ├─ get_mcp_tools() [client.py + tools.py]:
  │    build_servers_config (stdio/sse/http) + OAuth headers + 拦截器
  │    MultiServerMCPClient(servers_config) → asyncio.gather(load_server_tools)  # 独立加载, 一个坏不影响其他
  │    for tool: 校验 name ^[A-Za-z0-9_-]+$ → tag_mcp_tool → tag_mcp_routing
  │      if stdio: _make_session_pool_tool (StructuredTool, coroutine=call_with_persistent_session)
  │      else: 保留原 tool
  ├─ make_sync_tool_wrapper → async MCP 工具打 sync func
  └─ 缓存 _mcp_tools_cache + config signature (mtime+size+sha256)
运行时: get_cached_mcp_tools() → _is_cache_stale()? → reset + 重初始化 : 返回缓存
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 工厂 | `get_available_tools` | 按参数动态装配四源，屏蔽内部差异 |
| 适配器 | `make_sync_tool_wrapper` | async-only 工具适配为 sync callable（线程池+新 loop+contextvars） |
| 注册表 | `ExtensionRegistry` / `McpTaskDriverRegistry` | 可变注册阶段 + 位置回滚 + 不可变视图 |
| 装饰器 | `IsolatedMiddleware`（via injection） | 扩展 middleware 隔离包装，故障降级为 diagnostic |
| 策略 | `AnchorRule.resolve` 7 种 `_Side` | `PlacementAnchor.chain` 有序 fallback |
| 单例 | `get_session_pool` 双检锁 | 全局唯一 MCPSessionPool |
| 对象池 | `MCPSessionPool` LRU | 按 (server, scope_key) 隔离，256 上限 |
| 标记 | `tag_mcp_tool` | `tool.metadata["deerflow_mcp"]=True`，多模块区分来源 |

## 模块间交互

- **依赖**：`config`（ExtensionsConfig/McpServerConfig）、`extensions`（IsolatedMiddleware）、`mcp`（get_cached_mcp_tools/tag_mcp_tool/make_sync_tool_wrapper）。
- **被调用**：`get_available_tools` 被 `agents/lead_agent/agent.py` 调用装配 lead 和子 agent 工具；`compose_with_extensions` 被 lead_agent（LEAD scope）和 `tool_error_handling_middleware.py`（SUBAGENT scope）调用；`initialize_mcp_tools` 启动时调用一次；`McpRoutingMiddleware` 读 `get_mcp_routing(tool)` 路由 metadata 自动提升 deferred MCP 工具。
- **三者职责边界**：tools=聚合（不发现，MCP 发现在 mcp/；不注入，注入在 extensions/）；extensions=注入（不定义工具，不连外部）；mcp=外部协议（不参与 middleware stack，不负责 skill 工具）。

## 核心实现（续）

### 为什么 _ensure_sync_invocable_tool 把 async 包成 sync

DeerFlow client 流式路径是同步的。`BaseTool` 有 `func`（sync）和 `coroutine`（async）两入口，只有 `coroutine` 时同步调用者无法调。`make_sync_tool_wrapper` 在独立线程跑 `asyncio.run(coro)`，处理两种情况（无 running loop 直接 run / 有 loop 则线程池+新 loop+contextvars 传播）。覆盖所有 MCP 工具（`_make_session_pool_tool` 产出只有 coroutine）和 ACP 工具。

### 为什么 PlacementAnchor 控制注入位置

Middleware stack 位置敏感——同一 middleware 不同位置行为完全不同。直接用 list index 会让扩展绑定具体布局，stack 重构就崩。PlacementAnchor 提供语义抽象（MODEL_LOGICAL=retry 外层=一次逻辑决策一次事件；MODEL_PHYSICAL=真正发给 LLM 的内容；TOOL_VISIBLE=工具入口；TOOL_RAW=工具真实返回）。每个 Placement 是 fallback chain，主规则不匹配时退化到次规则（warning）。

### 为什么 MCP 用 session_pool

三重问题：(1) 有状态服务器（Playwright 打开页面填表单后，新 session 丢状态）；(2) anyio 同 task 限制（`ClientSession` 的 cancel scope 必须从同一 task 退出，但 `make_sync_tool_wrapper` 每次新 `asyncio.run` 是不同 task，直接复用会 crash #3379）；(3) 解决方案——每个 pooled session 由专属 `_run_session` task 拥有，enter context manager + initialize + `await close_evt.wait()` 阻塞，所有关闭路径只 signal close event 由 owner task 执行 `__aexit__`，保证 enter/exit 同 task。

### 为什么 mcp_metadata 是叶子模块

需要在多模块区分"MCP 来源工具"，但不引入跨模块私有 helper。`mcp_metadata.py` 只依赖 `BaseTool`（无 import cycle 风险），把 metadata key + tagger + predicate 集中一处。`MCP_TOOL_ROUTING_METADATA_KEY` 存序列化路由信息，`McpRoutingMiddleware` 据此自动提升 deferred MCP 工具。

### 为什么 config 变更检测用 sha256 而不只 mtime

严格 mtime `>` 漏掉同秒编辑、mtime 不变/倒退（对象存储/网络挂载、`git checkout`/`cp -p`/`tar`/`rsync` 保时间戳）。`(mtime, size, sha256)` 内容签名覆盖所有场景，`!=` 比 `>` 更安全，且始终计算 sha256（同秒同大小内容替换只有 sha256 能检测）。

## 扩展方式

### 新增内置工具

`tools/builtins/my_tool.py` 实现 `BaseTool`；`__init__.py` 导出；`tools/tools.py` 的 `BUILTIN_TOOLS` 加一项（无条件）或在 `get_available_tools` 加条件判断（参考 view_image_tool）。async 工具无需手动处理——`_ensure_sync_invocable_tool` 自动包装。

### 接入 MCP server

`extensions_config.json` 的 `mcpServers` 加条目（enabled/type/command/args/env/oauth/tool_name_prefix/session_init_timeout）。无需改代码——`get_cached_mcp_tools` 自动发现加载。需 OAuth 加 `oauth` 字段；需拦截器加 `mcpInterceptors`。

### 加扩展注入点（新 Placement）

`deerflow_extension_api` 的 `Placement` enum 加值；`extensions/stack.py` 的 `_anchors()` 加 anchor 规则 `PlacementAnchor.of(...)`；扩展侧 `contribute_middlewares` 返回 `MiddlewarePlacement(placement=...)`；有排序约束则 `ordering.py` 加 `OrderingConstraint`。

对应测试：`backend/tests/tools/` + `extensions/` + `mcp/`。
