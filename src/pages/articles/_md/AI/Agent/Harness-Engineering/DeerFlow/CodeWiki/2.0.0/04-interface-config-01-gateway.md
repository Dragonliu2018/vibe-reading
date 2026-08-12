---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Gateway"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "FastAPI", "SSE", "Auth"]
description: "DeerFlow HTTP 网关解析：FastAPI lifespan、Auth/CSRF/Trace 三层中间件、langgraph_runtime DI、24 router 与 LangGraph Platform API 兼容。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 接口与配置](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/04-interface-config)

---

## 模块定位

本模块属于 **接口与配置** 子系统。`backend/app/gateway/`（19k 行）是 FastAPI HTTP API 层——LangGraph Platform API 兼容的 HTTP 接口（threads/runs/agents）+ 自有 API（skills/mcp/channels/memory/models）。前端 Next.js 和 IM channels 都通过它调用 harness。核心职责：lifespan 装配所有运行时单例、三层 ASGI middleware（Trace→Auth→CSRF）、DI 工厂注入 `DeerFlowClient`/`RunManager`/`StreamBridge`、24 router 分组、SSE 流式响应。

## 核心实现

### AuthMiddleware — fail-closed 四路认证

```python title=backend/app/gateway/auth_middleware.py
class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if _is_public(request.url.path): return await call_next(request)  # /health /docs /api/webhooks/
        # 路径1: 内部 token (IM channel worker, X-DeerFlow-Internal-Auth)
        # 路径2: session cookie + JWT 严格校验 (get_current_user_from_request)
        # 路径3: auth_disabled 模式 (开发)
        # 路径4: 无凭证 → 401
        request.state.user = user
        request.state.auth = AuthContext(user, permissions)
        token = set_current_user(user)  # contextvar, persistence 层自动 owner 过滤
        try: return await call_next(request)
        finally: reset_current_user(token)
```

### langgraph_runtime — 运行时 facade + 生命周期

```python title=backend/app/gateway/deps.py
@asynccontextmanager
async def langgraph_runtime(app, startup_config):
    _enforce_postgres_for_multi_worker(startup_config)  # 多 worker 安全门
    async with AsyncExitStack() as stack:
        set_extension_notify_loop(asyncio.get_running_loop())
        app.state.stream_bridge = await stack.enter_async_context(make_stream_bridge(config))
        await init_engine_from_config(config.database)
        app.state.checkpointer = await stack.enter_async_context(make_checkpointer(config))
        app.state.store = await stack.enter_async_context(make_store(config))
        app.state.run_store = RunRepository(sf); app.state.thread_store = make_thread_store(sf, store)
        app.state.run_event_store = make_run_event_store(run_events_config)
        app.state.run_manager = RunManager(store=..., event_store=..., on_orphans_recovered=...)
        await app.state.run_manager.reconcile_orphaned_inflight_runs(...)
        await app.state.run_manager.start_heartbeat()
        yield
        await _drain_inflight_runs(run_manager); await close_engine()
```

### DI 工厂 — `_require` 模式

```python title=backend/app/gateway/deps.py
def _require(attr, label):
    def dep(request): 
        val = getattr(request.app.state, attr, None)
        if val is None: raise HTTPException(503, f"{label} not available")
        return val
    return dep
get_stream_bridge = _require("stream_bridge", "Stream bridge")  # 等
```

### thread_runs router

```python title=backend/app/gateway/routers/thread_runs.py
@router.post("/{thread_id}/runs/stream")
@require_permission("runs", "create", owner_check=True, require_existing=True)
async def stream_run(thread_id, body, request):
    bridge = get_stream_bridge(request); run_mgr = get_run_manager(request)
    record = await start_run(body, thread_id, request)
    return StreamingResponse(sse_consumer(bridge, record, request, run_mgr),
        media_type="text/event-stream",
        headers={"Content-Location": f"/api/threads/{thread_id}/runs/{record.run_id}"})
```

## 调用链路

### POST /api/threads/{id}/runs/stream 全链路

```
Client POST (Cookie + X-CSRF-Token + Body: RunCreateRequest)
  ▼ ASGI Middleware Chain (外→内, 注册逆序):
  TraceMiddleware (生成/继承 trace_id → contextvar + X-Trace-Id header)
  → CORSMiddleware (allow_origins + expose run_id header)
  → CSRFMiddleware (POST → Double Submit Cookie: csrf_token cookie == X-CSRF-Token)
  → AuthMiddleware (_is_public? → access_token cookie → JWT decode → DB 查 User → request.state.user)
  ▼ thread_runs.router @require_permission (runs/create + owner_check thread_store.check_access)
  ▼ services.start_run():
       validate_thread_id → normalize_stream_modes → get_run_context (RunContext)
       → resolve_agent_factory(body.assistant_id) → make_lead_agent
       → build_run_config (configurable: thread_id + recursion_limit clamp)
       → inject_authenticated_user_context → normalize_input (dict→messages)
       → run_mgr.create_or_reject → RunRecord(pending) → asyncio.create_task(run_agent(...))
       → return record (立即返回)
  ▼ StreamingResponse(sse_consumer):
       bridge.subscribe(run_id, last_event_id)
       for entry: HEARTBEAT → ": heartbeat"; END → "end"; StreamEvent → format_sse(event, data, id)
       finally: on_disconnect==cancel → run_mgr.cancel
  ▼ 后台 run_agent worker (见 Runtime 模块): make_lead_agent → agent.astream → bridge.publish → SSE
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 依赖注入 | `deps.py` `_require` + `Depends` | 从 `app.state` 取单例，缺失 503 而非崩溃 |
| Facade | `langgraph_runtime` | StreamBridge+checkpointer+store+RunManager+5 repo 打包成 `async with` |
| 中间件链 | `app.py` add_middleware | 注册顺序 Auth→CSRF→CORS→Trace，ASGI 执行逆序 |
| 路由分组 | 24 router | 按 prefix 挂载，独立文件 |
| 装饰器鉴权 | `authz.py` `@require_permission` | AuthMiddleware 认证（你是谁），decorator 授权（能干什么）+ owner_check |
| Contextvar | `set_current_user` | 认证后写 contextvar，persistence 自动按 user 过滤 |
| Service Layer | `services.py` | `start_run`/`sse_consumer` 集中业务，router 薄 |
| AsyncExitStack | `langgraph_runtime` | 单例按逆序释放 |

## 模块间交互

- **依赖**：`deerflow.config`（get_config mtime 热加载）、`deerflow.runtime`（StreamBridge/RunManager/run_agent）、`deerflow.tracing`（Monocle）、`deerflow.uploads`、`deerflow.agents`（make_lead_agent）、`deerflow.persistence`（init_engine + repos）、`app.channels`（start_channel_service）、`app.scheduler`/`app.mcp_tasks`。
- **被调用**：Frontend Next.js（对话/thread CRUD/models/skills/mcp/memory/auth）；IM Channels（内部 token 认证 HTTP 回环）；GitHub Webhooks（HMAC 验签）；Scheduler（内部 launch_scheduled_thread_run）。
- **LangGraph Platform API 兼容**：SSE 格式（event/data/id 字段顺序 + Content-Location header）严格匹配，使 `@langchain/langgraph-sdk` 的 `useStream` React hook 无修改可用；`assistants_compat` router 提供 stub。

## 核心实现（续）

### 为什么用 DI 而非直接 import

`get_config()` 注释：`AppConfig` 不缓存 `app.state`，router 通过 `get_app_config()` mtime 热加载，config.yaml 改动下次请求生效。`_require` 让 router 只依赖 `app.state` 接口，单例缺失返回 503 而非 500，可测试（替换 `app.state`），避免 `app.gateway → deerflow.runtime → app.gateway` 循环。

### 为什么 CSRF + Auth + Trace 三层

三层职责正交：Trace（最外层，trace_id，认证失败的 401 也有 trace）；Auth（fail-closed 身份验证，在 CSRF 前因 CSRF 需 auth state）；CSRF（Double Submit Cookie 防 CSRF，POST/PUT/DELETE/PATCH）。webhook 路径三层全免（`_PUBLIC_PATH_PREFIXES` + `should_check_csrf` 豁免 + HMAC 签名替代，因 webhook 无法携带 cookie）。

### 为什么 24 router 细分

关注点分离（每文件独立修改/测试/review）；prefix 独立不冲突；鉴权差异（github_webhooks 条件挂载）；SSE vs JSON 分开避免 StreamingResponse generator 语义污染 JSON handler。

### 为什么兼容 LangGraph Platform API

生态复用：前端直接用 LangChain 官方 SDK（`@langchain/langgraph-sdk`），`useStream` React hook 提供自动重连/Last-Event-ID 恢复/interrupt 处理，DeerFlow 白拿；第三方集成（LangSmith 调试）可直连 runs API。

### 为什么 github_webhooks 单独 router

(1) 认证方式不同（`X-Hub-Signature-256` HMAC 非 session cookie，Auth/CSRF 豁免）；(2) 条件挂载（仅配 `GITHUB_WEBHOOK_SECRET` 才挂，fail-closed）；(3) import side-effect（import `app.gateway.github` 注册 GitHub channel 的 `ChannelRunPolicy`）。

## 扩展方式

### 新增 API 端点（如 /api/threads/{id}/labels）

`routers/threads.py` 加 `@router.post("/{thread_id}/labels")` handler，用 `Depends(get_thread_store)` + `@require_permission("threads","update",owner_check=True)`。不需改 `app.py`（router 已挂载）/middleware。需新 persistence 层则 `deps.py` 加 `get_label_store` + `langgraph_runtime` 初始化 `app.state.label_store`。

### 加一层 middleware（如限流）

新建 `rate_limit_middleware.py` 继承 `BaseHTTPMiddleware`；`app.py` 的 `create_app` 加 `app.add_middleware(RateLimitMiddleware)`——位置决定执行顺序（Auth 前=对未认证也限流，Auth 后=只对已认证）。按 user 限流从 `request.state.user` 读。

### 接新 IM channel webhook（如企业微信）

新建 `routers/wecom_webhooks.py`（prefix `/api/webhooks/wecom`）；webhook 路径三层 middleware 已豁免（`/api/webhooks/` 前缀通配），认证由 handler 内部签名验证负责；`app.py` 条件挂载；`app/channels/` 实现 `Channel` 子类 + `ChannelRunPolicy`；lifespan 的 `start_channel_service` 注册。

对应测试：`backend/tests/gateway/` 下各 router + `test_auth_middleware.py` + `test_csrf.py`。
