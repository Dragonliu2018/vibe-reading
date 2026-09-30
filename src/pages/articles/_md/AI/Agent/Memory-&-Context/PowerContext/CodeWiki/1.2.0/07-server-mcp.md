---
source:
  type: "源码解读"
  project: "powercontext"
  url: "https://github.com/oceanbase/powercontext"
title: "Server 与 MCP"
date: "2026-09-30T17:51:04+08:00"
category: [AI, Agent, "Memory & Context", PowerContext, CodeWiki, "1.2.0"]
contentType: "CodeWiki"
tags: ["PowerContext", "FastAPI", "MCP", "OpenAPI"]
description: "接入层：OpenAPI 契约驱动的 107 条路由、FastMCP 把 OpenAPI 子集投影为 46 个工具、进程内 ASGI 桥、Protocol 解耦与 lifespan 依赖注入。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Memory-&-Context/PowerContext/CodeWiki/1.2.0/00-overview)

---

## 模块定位

`server/`（~16.9k 行）是运行时的接入壳：HTTP（107 条路由）、MCP（46 个工具）、Dashboard（Jinja2）三个面。它的核心设计是**契约优先**——`openapi/powercontext.yaml`（341KB）是唯一真源，`http/_generated/` 的 models/operations/schema 由 `scripts/generate_api.py` 生成，一条契约三个消费者（路由注册、客户端代码、MCP 投影）。`app.py` 5620 行却与 runtime 实现零耦合——全部经 Protocol 结构化类型交互。

## 模块架构

```
create_server_app（factory.py:121，组合根）
  ├─ create_app（app.py:1254）
  │    ├─ 107 × _add_route(app, OPERATION, handler)   ← 路由纯数据驱动
  │    ├─ 异常处理器矩阵（PowerContextError → 结构化 ErrorResponse）
  │    └─ app.state.{application, access_control, capabilities, ...}
  ├─ 中间件栈：Authentication → HttpMetrics → AccessLog → HttpTracing
  ├─ /metrics 端点（含 SERVER_OBSERVE access check）
  ├─ mount_mcp（mcp.py:409）
  │    └─ create_mcp_server（:363）
  │         FastMCP(OpenAPIProvider(server_app.openapi(), route_map_fn=白名单,
  │                     client=httpx.AsyncClient(transport=_InternalBridgeTransport)))
  ├─ mount_dashboard（Jinja2 templates + labels 双语）
  └─ lifespan：open_builtin_runtime → app.state.application（详见 [05-runtime](05-runtime)）
```

## 调用链路

### 启动与请求处理

启动链：`powercontext server serve`（`server/cli.py`）→ `create_server_app(settings)` → `uvicorn.run(...)`。`artifact_processing_role == "background"` 时走独立 runner，且 `create_server_app` 对 background role 直接抛 `BackgroundRoleRequiresBackgroundRunnerError`（`factory.py:88-92`）——**防止纯后台进程误暴露 HTTP/MCP 面**。

契约的一个细节：`/docs` 由 Scalar 渲染（`docs_url` 显式设 None、自挂路由），schema 来自 `canonical_openapi` 闭包（`app.py:1479`）——`handoff_report_enabled=False` 时从预生成 `OPENAPI_SCHEMA` 中**裁掉 `/v1/handoff-reports/` 路径**再缓存，让文档面与实际可用路由一致。认证中间件（`middleware.py:55`）对 internal bridge、`_PUBLIC_PATHS`（`/`、`/docs`、`/health/*` 与 4 个 skill 远程端点——enroll/reconcile/receipt 本来就凭 credential 自证）、`/dashboard/session` 与静态资源跳过认证；认证被拒返回 401 `unauthorized`（附 `WWW-Authenticate: Bearer`），认证服务异常返回 503 `authentication_unavailable`；dashboard 路径的错误响应走独立的登录页渲染分支（`login_response`）。

请求处理：handler 签名统一 `application: Annotated[ServerApplication, Depends(_require_application)]`（为 None 抛 `_RuntimeNotReadyError` → 503），调用 `application.<能力面>.for_scope(scope_id).<方法>`。lifespan 在 yield 前注入 runtime、yield 后清空——"运行时热绑定/优雅降级"：停机中的 Server 返回全空 capabilities 而不是半真数据。

### MCP 工具调用：进程内 ASGI 桥

```
agent → POST /mcp（FastMCP http_app mount，外层 AuthenticationMiddleware
        先认证并 bind_authentication(result) 绑 principal contextvar）
  → FastMCP 分发到 OpenAPIProvider 生成的 tool
  → tool 内 httpx.AsyncClient 发请求，transport = _InternalBridgeTransport
    （mcp.py:396，httpx.ASGITransport 子类——同进程直接 ASGI 调用，
      不经网络/socket、不占第二个端口，请求头带上当前 request_id）
  → bind_internal_bridge() 置 ContextVar：
      AuthenticationMiddleware 跳过重复认证（principal contextvar 仍在生效）
      HttpAccessLogMiddleware 跳过重复访问日志
      审计上下文据此把 transport 标为 "mcp" 而非 "http"
  → FastAPI 路由 → handler → access check 照常执行
```

`mount_mcp` 还用 `combine_lifespans` 合并 FastAPI 与 FastMCP 两个 lifespan 再 mount。

方法速查：

<details>
<summary>server 关键函数速查表</summary>

| 函数 | 位置 | 一行职责 |
| --- | --- | --- |
| `create_app` | `server/app.py:1254` | 纯 HTTP 适配器（107 路由 + 异常矩阵） |
| `create_server_app` | `factory.py:121` | 组合根（中间件 + MCP + Dashboard + lifespan） |
| `create_mcp_server` | `mcp.py:363` | OpenAPI → MCP 工具投影 |
| `mount_mcp` | `mcp.py:409` | 合并 lifespan + mount |
| `_select_mcp_type` | `mcp.py:218` | 白名单判定 TOOL/EXCLUDE |
| `_annotate_mcp_component` | `mcp.py:294` | 叠加 ToolAnnotations 语义 |
| `_add_route` | `app.py:4312` | 从 Operation 数据注册 FastAPI 路由 |

</details>

## 核心实现

### MCP 是 OpenAPI 投影而非手写工具

`create_mcp_server`（`mcp.py:363`）直接 `server_app.openapi()` + `OpenAPIProvider` + 白名单 `route_map_fn`：

```python title="server/mcp.py:218"
def _select_mcp_type(route: HTTPRoute, _: MCPType) -> MCPType:
    if route.operation_id in _MCP_OPERATION_IDS:    # 46 个白名单
        return MCPType.TOOL
    return MCPType.EXCLUDE
```

为什么：(a) 工具的参数/输出 schema 从同一契约生成，HTTP 与 MCP **永不失同步**；(b) 工具调用复用 `_InternalBridgeTransport` 走已注册路由，auth/access/metrics/tracing/request-id 中间件全部自动生效——**MCP 不需要为横切逻辑写第二遍实现**；(c) `_annotate_mcp_component` 在投影上叠加 MCP 特有语义（`readOnlyHint/destructiveHint/idempotentHint/openWorldHint`）。

白名单的三级副作用分组：`_MCP_READ_ONLY_OPERATION_IDS`（21 个，search_memory/get_skill 等，标 `readOnlyHint=True` 让 MCP host 自动免确认）、`_MCP_CANDIDATE_WRITE_OPERATION_IDS`（5 个，生成只产 pending candidate，非破坏）、`_MCP_REVIEW_WRITE_OPERATION_IDS`（3 个，approve/reject/revise 终态审批，标 `destructiveHint=True`）。这三级与系统"候选-审批"两阶段安全模型一一对应。**但 MCP visibility 明确不是授权边界**（RFC 0050）——hints 只是让 MCP host 应用自己的确认策略，enforced 模式下每个调用照走 access check，pending-head CAS 保证精确重放被拒。

### handler 只依赖 Protocol

`app.py:828-1253` 定义一族结构化 Protocol（`_ScopedSourceApplication`、`_ScopedMemoryApplication`、`_ScopedContextApplication` 等按 `for_scope(scope_id)` 两级组织），汇聚成 `ServerApplication` Protocol（`:1220`，聚合约 20 个能力面）。`BuiltinRuntime` 结构化满足它——无需继承、无需 import。**app.py 不 import BuiltinRuntime**：它确实 import 了各 family 的数据模型（做 HTTP ↔ runtime DTO 转换），但行为接口只依赖 Protocol；`factory.py` 是唯一知道具体 family 实现的 server 层文件。契约测试/替换运行时可以传任意 duck-typed `application` 给 `create_app`（application=None 也能建 app，只返回 503）。

### 契约的门禁与兼容性修补

`Makefile:133` 的 `api-generate-check`（CI）跑 `generate_api.py --check` 拦截过期生成物。`mcp.py` 里有一个值得注意的契约兼容性修补：`_preserve_nullable_input`（`:247-313`）——OpenAPI 3.0 的 `nullable` 在 FastMCP 把 request schema 摊平为 JSON Schema `$defs` 后会丢失合法性，手工把 null 分支补回投影 schema；同时 `validate_output=False`（FastAPI 已校验过响应模型，二次 JSON Schema 校验会误杀合法的 nullable ref）。

### 全端点无例外的 enforced 模式

`_MetricsEndpoint`（`factory.py:100-114`）连 `/metrics`（不在 OpenAPI 契约里，`include_in_schema=False`）都要过 `AccessAction.SERVER_OBSERVE`——enforced 模式没有"内部端点免检"的口子。访问控制细节（principal、审计链、receipt migration 的联动）在 `authz/` 与 `access.py`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| OpenAPI 契约驱动 | yaml → `_generated` → 路由/客户端/MCP 三消费者 | 一处变更三处同步，CI 门禁兜底 |
| lifespan 依赖注入 | `app.state.application` 注入/清空 | 运行时热绑定与优雅降级 |
| Protocol 解耦 | `app.py:828-1253` 的 `_Scoped*` 族 | HTTP 层与 runtime 实现零耦合 |
| 白名单投影 + 注解分级 | `mcp.py:127-180` 三个子集 | 副作用分级给 MCP host 确认策略 |
| 组合方向单向 | factory import runtime，runtime 不反向依赖 | 测试可注入任意实现 |

## 模块间交互

**Runtime**：lifespan 装配与消费见 [05-runtime](05-runtime)；`_scheduled_access_runners` 让后台调度也走鉴权。**Client**：`_generated` 的 `Operation` 常量被手写 SDK 复用（见 [08-client-cli-service](08-client-cli-service)）。**Dashboard**（`dashboard/routes.py`）：Jinja2 + 分页 + 双语 labels，`/handoff-download` 等导出路由走 `validate_download` 鉴权。**Integrations**：Claude Code/Codex 插件的 `.mcp.json` 指向 `{server_url}/mcp`（streamable-http），hook 走同一批 REST 路由。

## 扩展方式

**新增一个 HTTP operation**（含 MCP 工具）四步：

1. `openapi/powercontext.yaml` 加 path + operationId + schema → `uv run python scripts/generate_api.py`
2. `server/app.py` 写 handler（依赖注入 `ServerApplication` + `mapping.*` DTO 转换；`app.py:2869-2885` 的 `remember_memory` 是完整范例）+ `create_app` 加一行 `_add_route(app, FOO, foo)`
3. `server/mcp.py:127` `_MCP_OPERATION_IDS` 加 operation_id；按副作用加进 read-only/candidate-write/review-write 子集获得正确 ToolAnnotations
4. 需要新能力面时在 `app.py:828-1253` 补 `_ScopedXxxApplication` Protocol 并挂到 `ServerApplication`——`BuiltinRuntime` 侧结构化实现即可，无需改 import

对应测试：`tests/test_api_contract.py`（契约一致性）与 `tests/test_mcp.py`（投影行为）。
