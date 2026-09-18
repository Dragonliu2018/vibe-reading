---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "MCP 生态"
date: "2026-09-18T17:29:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "MCP", "stdio", "OAuth"]
description: "Odysseus MCP 生态：McpManager 单例托管 stdio/SSE/HTTP 三种 transport、AsyncExitStack 集中管理子进程生命周期、内置五 server（email/memory/rag/image_gen/browser）、RFC 9728 OAuth + PKCE 与 prompt 注入限流。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

MCP（Model Context Protocol）是 Odysseus 的扩展协议域：用户可以注册任意外部 MCP server（等于给 agent 开新工具），Odysseus 自己也以 MCP server 形态内置了 email / memory / rag / image_gen / browser 五个能力。它解决的问题：**工具生态的开放性**——不进核心代码库的能力（Playwright 浏览器、第三方服务）经标准协议接入。requirements.txt 明确 pin `mcp<2`（注释说明 v2 是 breaking rewrite）。

代码分布：`src/mcp_manager.py`（709 行，`McpManager` god node 22 edges）、`src/builtin_mcp.py`（386 行，内置注册）、`src/mcp_oauth.py`（211 行）、`routes/mcp/`（715 行）、`mcp_servers/`（3541 行：`email_server.py` 2912 行、`image_gen_server.py` 184 行、`memory_server.py` 285 行、`rag_server.py` 160 行）。

## 模块架构

`McpManager`（`src/mcp_manager.py:135`）是全局单例客户端管理器，四张核心 dict 按 server_id 索引：`_connections`（连接状态）、`_tools`（工具 schema 列表）、`_sessions`（mcp SDK `ClientSession`）、`_stacks`（`AsyncExitStack`——集中管理子进程/连接生命周期）。另有 `_connect_tasks`（HTTP/OAuth 后台连接任务）与 `_generation`（工具变更代数，用于 prompt cache 失效）。

内置 server 是**独立 Python 脚本**，全部用 MCP SDK v1 低层 `Server` 装饰器 API：`server = Server("memory")` + `@server.list_tools()` + `@server.call_tool()` + `stdio_server()` 的 `run()` 入口，通过 `sys.path.insert` 反向导入主项目模块（如 `memory_server.py` 导入 `src.memory.MemoryManager`）并用 `_ensure_init()` 懒初始化。**双工具格式**是重要设计：非 builtin server 走 OpenAI function-calling（`get_all_openai_schemas()`，`[MCP:{label}]` 描述前缀）；builtin Python server 走 code-block 工具格式（agent prompt 中硬编码），仅 `builtin_browser`（npx `@playwright/mcp`）例外需 function calling。

## 调用链路

**注册→连接→列举→调用**：启动时 `app.py:1071` 在 web server 就绪后异步调 `register_builtin_servers(mcp_manager)`（`src/builtin_mcp.py:163`）——遍历 `_BUILTIN_SERVERS`（四个 Python server 以 `sys.executable` + 脚本路径 stdio 启动）和 `_BUILTIN_NPX_SERVERS`（`builtin_browser` 经 `_find_npx()` 启动 `@playwright/mcp`）；随后 `connect_all_enabled()`（`src/mcp_manager.py:427`）从 DB 表 `McpServer` 读用户配置（每 server 20s 超时，`_connect_with_timeout()`）。连接：`connect_server()`（`:135` 签名）按 transport 分发到 `_connect_stdio()` / `_connect_sse()` / `_start_http_connect()`；stdio 用 `AsyncExitStack` 挂载 `stdio_client(StdioServerParameters)` + `ClientSession`，`session.initialize()` 后 `session.list_tools()` 把 schema 缓存进 `_tools`；从 env 变量名（含 email_address / account / user）提取 `identity`，用于在多实例同种 server（如两个邮箱账号）间区分。调用：agent 工具循环对 `mcp__` 前缀工具调 `mcp.call_tool(tool, args)`——`split("__", 2)` 解析 `mcp__{server_id}__{tool_name}` 命名空间，解析失败或服务器未连接时返回 `{"error": ..., "exit_code": 1}`（与本地工具的错误格式对齐）；`_do_call()`（`:509`）把 MCP content 转成 `{stdout, stderr, exit_code}` 兼容格式，image content（Playwright 截图）提升为 `images` 字段。`is_builtin()` 的判定：server_id 前缀 `builtin_` 或命中集合 `{image_gen, memory, rag, email}`——决定它走 code-block 格式（跳出 function-calling schema）还是反向。

**agent 侧注入**：`agent_loop.py:2286` 调 `get_all_openai_schemas()` 组装 function-calling schema；`:2747` 调 `get_tool_descriptions_for_prompt()` 并以 untrusted context message 插入对话（`:2749`）；plan mode 调 `plan_mode_blocked_mcp()`（`:3858`）双重拦截（schema 隐藏 + 运行时按 qualified name 拒绝），分类逻辑 `mcp_tool_is_readonly()`（annotations 优先，动词启发式 fail-closed）。工具系统侧：`tool_execution.py:1267` 把裸 email 工具名（fenced-block 模型用）别名到 `mcp__email__{tool}`；`:690` `_call_mcp_tool()` 为老式工具名提供 MCP 路由 + `_direct_fallback()` 兜底；MCP 工具也被 `ToolIndex.index_mcp_tools()`（`tool_index.py:224`）索引进 RAG 选择池。

## 核心实现

### OAuth 流（HTTP transport）

`src/mcp_oauth.py` 的 `build_provider()`（`:155`）构造 SDK 的 `OAuthClientProvider`，走 RFC 9728 discovery + DCR + PKCE。`redirect_handler` 注册 pending Future（state→Future 表 `_pending`），浏览器回调 `/api/mcp/oauth/callback`（`routes/mcp/mcp_routes.py:489`）中 `resolve_pending(state, code)` 唤醒后台连接任务——未命中的 state 再走 legacy Google 交换路径 `_exchange_and_connect()`（paste-back flow 应对远程/反代部署）；`DbTokenStorage`（`:97`）把 token/client_info 持久化到 `McpServer.oauth_tokens` 列。`_start_http_connect()` 有界等待 8s，未完成则发布 `needs_auth` 状态；`on_redirect` 回调保证 discovery/DCR 慢于等待窗口时也能及时暴露 auth_url（`AUTH_WAIT_SECONDS=300`）。后台连接最终完成后调 `clear_auth_url` 并把 `_generation` 自增——工具提示缓存按代数失效。重定向 base 依次取 `OAUTH_REDIRECT_BASE_URL` → `APP_PUBLIC_URL` → `http://localhost:{APP_PORT}`，**主机名刻意保持 localhost**——换成公网域名会使已注册的 DCR（动态客户端注册）失效。

### Prompt 注入限流

`_format_mcp_params()` / `_sanitize_schema_token()`（issue #2660）对不可信 schema 限流：`_MCP_PARAM_MAX = 12`（每工具最多渲染 12 个参数）、`_MCP_TOKEN_MAX = 40`（每个名称/类型 token 最多 40 字符）、`_MCP_HINT_MAX = 300`（整条 hint 总长）；`_sanitize_schema_token()` 用正则替换控制字符/换行为空格、折叠空白并截断加省略号——MCP server 的工具描述会进 agent prompt，恶意 server 可以借 schema 注入指令。MCP 工具结果在 isError 时标记 `untrusted_content=True`，进工具系统的不可信传播门。凭据与安全：所有管理路由 `require_admin`（注册 stdio server 等于宿主机执行任意二进制，必须是管理员；stdio 须提供 `command`、sse/http 须提供 `url`，否则 400）；OAuth 文件路径被 `_resolve_mcp_oauth_path()` 限制在 `MCP_OAUTH_DIR` 内防路径逃逸（越界抛 400）。

### 崩溃自动重连（仅 builtin）

`call_tool()` 对 builtin server 调用抛异常时自动 `_reconnect_builtin()` 重建（用 `sys.executable` 与 builtin_python_env 重连）并重试一次（用户注册的 server 不自动重连——尊重用户对自己的 server 的处置权）。`builtin_mcp.py` 的 `_BG_TASKS` 强引用集合防 GC 回收 fire-and-forget task。启动时序刻意放在 web server 接受流量之后（`app.py:1068` 注释）——MCP 启动可能慢或被本地工具阻塞，不能拖累整个 UI 首屏。plan mode 的 `plan_mode_blocked_mcp()` 返回 `(disabled_map: {server_id: set(tool_name)}, qualified_names: set)`——schema 隐藏与运行时拒绝共用同一判定结果；`mcp_tool_is_readonly()` 优先读 annotations 的 `readOnlyHint` / `destructiveHint`，无提示时按 `_MCP_READONLY_VERBS` 动词前缀启发式，**fail-closed**（不明确可读的一律视为写工具屏蔽）。

> ⚠️ 待核实：`_connect_stdio()` 的 `env={**os.environ, **env}` 合并是否构成环境凭据向子进程的意外暴露面（代码无注释说明意图）；`src/mcp_manager.py:14` 从 `src.database` 导入而 `src/mcp_oauth.py:103` 从 `core.database` 导入——双路径导入是否为重构遗留。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 进程托管 + AsyncExitStack | `_connect_stdio()` in `src/mcp_manager.py` | 子进程/连接生命周期集中清理 |
| Transport 抽象（if/else 分发） | `connect_server()` | stdio/SSE/HTTP 共享同一注册逻辑 |
| 双工具格式 | `get_all_openai_schemas()` vs code-block | builtin 走文本协议，外部走 function calling |
| 全局访问器 | `set_mcp_manager()` / `get_mcp_manager()` in `src/tool_utils.py:18/23` | agent_loop 深处取单例 |

## 模块间交互

被工具系统（`_MCP_TOOL_MAP`）、agent_loop（schema 注入）、task_scheduler（`CHECKIN_MCP_PATTERNS` 快照）消费；`email_server.py` 直连 Dovecot IMAP/SMTP 并读写 `src.secret_storage` 加密凭据（多 owner 隔离 `_filter_accounts_for_owner()`）；`memory_server.py` 复用 `MemoryManager` + `MemoryVectorStore`（`_scope_entries()` owner 过滤与 store 不可读保护，issue #5673）；`rag_server.py` 复用 `get_rag_manager()` + `PersonalDocsManager`。

## 扩展方式

新增一个内置 MCP server：① `mcp_servers/` 新建脚本（参照 `rag_server.py`，160 行）；② `src/builtin_mcp.py` 的 `_BUILTIN_SERVERS` 注册 `(script_rel, name)`；③ code-block 格式需在 `agent_loop.py` 的 prompt 工具文档补条目（参照 `:696` manage_mcp 条目），function calling 则调整 `get_all_openai_schemas()` 的 `is_builtin()` 跳过逻辑；④ 需要直连兜底则在 `tool_execution.py` 补 `_MCP_TOOL_MAP` 与 `_direct_fallback()` 分支。对应测试：`tests/test_companion_readonly.py` 式 owner 隔离测试。
