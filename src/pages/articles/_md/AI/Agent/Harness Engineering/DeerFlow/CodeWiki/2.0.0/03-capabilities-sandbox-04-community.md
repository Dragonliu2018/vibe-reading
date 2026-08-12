---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Community"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "Search", "Browser", "Crawler"]
description: "DeerFlow 社区工具提供者目录解析：搜索/爬虫/浏览器/图片/天气 provider 的约定式接口、动态导入与 BrowserSession 生命周期。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 能力扩展与沙箱](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox)

---

## 模块定位

本模块属于 **能力扩展与沙箱** 子系统，是 DeerFlow 的外部能力 provider 目录——搜索引擎、网页爬虫、浏览器自动化、图片搜索、天气等外部服务的适配层。~19 个 provider 分两类：**无状态约定式**（搜索/爬虫，每个 `tools.py` 暴露 `web_search_tool`/`web_fetch_tool`，无共享基类）和**有状态重量级**（`browser_automation` 的 `BrowserSession`，需独立 event loop + session 池 + SSRF 防护）。沙箱类 provider（aio/e2b/boxlite/tenki）虽在此目录但归 Sandbox 模块。核心设计：**配置字符串动态导入、约定式接口统一 tool name、结果标准化**。

## 核心实现

### 约定式接口（无基类）

搜索/爬虫 provider 无共享 ABC/Protocol，统一遵循约定：每个包 `tools.py` 暴露 `web_search_tool(query) -> str` + `web_fetch_tool(url) -> str`，用 `@tool("web_search", parse_docstring=True)` 注册，tool name 统一 `"web_search"`/`"web_fetch"`，返回 `[{title,url,snippet}]` JSON。

```python title=backend/packages/harness/deerflow/community/tavily/tools.py
def _get_tavily_client() -> TavilyClient:
    config = get_app_config().get_tool_config("web_search")
    api_key = (config.model_extra or {}).get("api_key") if config else None
    return TavilyClient(api_key=api_key)

@tool("web_search", parse_docstring=True)
def web_search_tool(query: str) -> str:
    """Search the web."""
    config = get_app_config().get_tool_config("web_search")
    max_results = (config.model_extra or {}).get("max_results", 5) if config else 5
    res = _get_tavily_client().search(query, max_results=max_results)
    return json.dumps([{"title": r["title"], "url": r["url"], "snippet": r["content"]}
                       for r in res["results"]], indent=2, ensure_ascii=False)
```

### GroundRoute — 自包含 meta search（无 SDK 依赖）

```python title=backend/packages/harness/deerflow/community/groundroute/tools.py
_GROUNDROUTE_ENDPOINT = "https://api.groundroute.ai/v1/search"
@tool("web_search", parse_docstring=True)
def web_search_tool(query: str, max_results: int | None = None) -> str:
    # 纯 httpx, 不依赖任何搜索 SDK; 路由 6 引擎 (Serper/Brave/Exa/Tavily/Firecrawl/Perplexity)
    # 结果多 source_engine 字段标明实际命中引擎
```

### BrowserSession — 浏览器生命周期（god 50）

```python title=backend/packages/harness/deerflow/community/browser_automation/session.py
class _PlaywrightLoopThread:  # 私有 daemon 线程上的独立 event loop
    async def run(self, coro):  # run_coroutine_threadsafe + wrap_future 跨 loop

class BrowserSession:
    """A single Playwright browser+page bound to the private loop."""
    def __init__(self, loop, *, headless, timeout_ms, viewport, cdp_url=None,
                 url_guard=None, on_activity=None): ...
    async def navigate(self, url) -> PageSnapshot: ...
    async def snapshot(self) -> PageSnapshot: ...
    async def click(self, ref: int) -> PageSnapshot: ...
    async def type_text(self, ref, text, submit=False) -> PageSnapshot: ...
    async def screenshot_bytes(self, full_page=False) -> bytes: ...
    # _ensure_page 懒启动 Playwright/Browser/Context/Page + _install_request_guard (SSRF)

class BrowserSessionManager:  # 进程级 per-thread session 池
    # max_sessions=32, idle_timeout_s=1800, _pin/_unpin 引用计数 + LRU 驱逐
```

### WarmPoolLifecycleMixin — 沙箱 provider 共享基类

```python title=backend/packages/harness/deerflow/community/warm_pool_lifecycle.py
class WarmPoolLifecycleMixin:  # DEFAULT_IDLE_TIMEOUT=600, DEFAULT_REPLICAS=3
    # _evict_oldest_warm / _reap_expired_warm / _start_idle_checker / _idle_checker_loop
# AioSandboxProvider(WarmPoolLifecycleMixin[SandboxInfo], SandboxProvider)
# BoxliteProvider(WarmPoolLifecycleMixin[BoxliteBox], SandboxProvider)
# TenkiSandboxProvider(WarmPoolLifecycleMixin[TenkiSandbox], SandboxProvider)
```

## 调用链路

### provider 发现/调用

```
config.yaml: use: deerflow.community.tavily.tools:web_search_tool
  ▼ resolve_variable() (deerflow/reflection/resolvers.py)
  import_module(module_path) + getattr(module, var_name) → BaseTool
  ▼ get_available_tools() 遍历 config.tools, 对每个 resolve_variable
  ▼ 加入 agent tool 列表

agent 调 web_search:
  ▼ web_search_tool(query)
  ▼ get_app_config().get_tool_config("web_search") → config.model_extra (api_key/max_results)
  ▼ TavilyClient.search → 标准化 [{title,url,snippet}] → JSON → ToolMessage → LLM
```

### BrowserSession 生命周期

```
browser_navigate_tool(url)
  ▼ _resolve_session(runtime, "browser_navigate") → get_browser_session_manager().get_session(thread_id, pin=True)
     ├─ ensure_browser_worker_compatibility (GATEWAY_WORKERS<=1)
     ├─ 按 thread_id 查已有; 无则 清理 idle → 检查 max_sessions cap → LRU 驱逐 → 创建新 BrowserSession
     └─ pin=True 增引用计数
  ▼ BrowserSession.navigate(url) → self._loop.run(self._navigate(url))
     ▼ _ensure_page 懒启动 (async_playwright→chromium.launch→new_context→_install_request_guard→new_page)
     ▼ page.goto → _snapshot_impl (JS 遍历元素打 data-df-ref 编号) → PageSnapshot
  ▼ _SessionLease.__exit__ → _unpin; session idle 超 idle_timeout_s 异步关闭
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 策略 | config `use` + 各 provider `tools.py` | 可互换策略，切 provider 改一行 config，tool name 统一 agent 无感知 |
| 适配器 | 各 `_get_*_client` + 结果标准化 | 不同 SDK 返回适配为 `{title,url,snippet}` |
| 工厂 | `resolve_variable` + `get_browser_session_manager` | 字符串路径动态导入；双检锁单例 |
| 引用计数 + LRU | `BrowserSessionManager` | `_pin/_unpin` 确保使用中不被驱逐 + LRU 驱逐 + idle 清理 |
| Mixin | `WarmPoolLifecycleMixin` | 沙箱 provider 复用 warm pool 生命周期逻辑 |

## 模块间交互

- **依赖**：`config`（get_app_config/get_tool_config）、`reflection`（resolve_variable）、`langchain.tools`（@tool）、`community.url_safety`（SSRF 防护）、`community.warm_pool_lifecycle`（沙箱 provider）、`constants`/`config.paths`（虚拟路径前缀）、`tools.types`（Runtime）。
- **被调用**：`tools.tools.get_available_tools` 是唯一聚合入口——从 `config.tools` 读 ToolConfig，对每个 `cfg.use` 调 `resolve_variable`，与 builtin/MCP/ACP 合并去重。
- **共性**：SSRF 防护（`url_safety.validate_public_http_url`，browser 在 context 级拦截所有请求含 redirect/popup/iframe）；配置读取模式（`get_tool_config` → `model_extra.get("api_key"/"max_results")`）；结果标准化（`[{title,url,snippet}]`）；fetch 截断（`content[:4096]`）。

## 核心实现（续）

### 为什么外部能力做成 community provider 而非内置

(1) 可选依赖——不同 provider 需不同 SDK（tavily-py/firecrawl-py/exa-py），内置则 core 需装所有 SDK；`resolve_variable` 运行时 import，缺依赖报清晰错误（`_build_missing_dependency_hint` 提示 `uv add`）。(2) 用户按需选——不需 9 个搜索引擎，选一个即可。(3) 生态扩展——第三方按约定写 `tools.py`，config 指向它零侵入接入。

### 为什么 browser_automation 独立 BrowserSession（1020 行）

(1) **Loop affinity**——Playwright async 对象绑定创建它们的 event loop，但 tool 调用可能在 Gateway/TUI/test loop 上；`BrowserSession` 用独立 `_PlaywrightLoopThread` 解耦，跨 loop 调用。(2) **有状态生命周期**——搜索/爬虫是无状态单次 API，浏览器需跨多轮保持 session（navigate→click→type→screenshot），需 session 池/引用计数/LRU/idle 清理。(3) **深层 SSRF**——一次性 URL 检查只覆盖初始 URL，浏览器跟随 redirect/popup/iframe/subresource，需 context 级 `_install_request_guard` 拦截所有路径防公开 URL 30x 到 `169.254.169.254`。(4) **Live screencast**——支持实时画面推流（`_start_screencast`/`_dispatch_input`）。

### 为什么多家搜索 provider 并存

不同引擎覆盖/定价/额度不同（DuckDuckGo 免费但一般、Serper 是 Google 实时但收费、Brave 独立索引、Exa neural search）；GroundRoute 是 meta 层一个 API 路由 6 引擎按质量+成本选最优带 failover/缓存；GroundRoute 无 SDK 依赖降低接入门槛。

### 为什么 tool name 统一 "web_search" 而非 "tavily_search"

Agent tool schema 只有一个 `web_search`，LLM 无需感知后端。`get_available_tools` 按 name 去重，config-loaded 优先，保证不同时加载两个搜索 provider 导致 schema 冲突（#1803）。

## 扩展方式

### 新增搜索 provider（如 You.com）

新建 `community/youcom/tools.py`，实现 `_get_youcom_client` + `@tool("web_search") web_search_tool` + `@tool("web_fetch") web_fetch_tool`，输出 `{title,url,snippet}`；`config.example.yaml` 加注释示例。无需改 `tools/tools.py`/`resolve_variable`——动态导入自动发现。

### 改 BrowserSession 池策略

`community/browser_automation/session.py` 的 `_DEFAULT_MAX_SESSIONS`（32）/`_DEFAULT_IDLE_TIMEOUT_S`（1800），或 `BrowserSessionManager.__init__` 改从 config 读；换驱逐策略改 `_pop_lru_unpinned_locked`/`_collect_evictable_locked`。

### 给搜索 provider 加共享缓存

新建 `community/search_cache.py` 装饰器（按 query hash + TTL 缓存 JSON）；各 provider `tools.py` 给 `web_search_tool` 加装饰器，或 `tools/tools.py` 的 `get_available_tools` 统一包装（注意 name 去重逻辑）。

对应测试：`backend/tests/community/` 各 provider + `test_browser_session.py`。
