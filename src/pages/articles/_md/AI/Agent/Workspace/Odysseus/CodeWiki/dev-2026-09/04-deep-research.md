---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "深度研究"
date: "2026-09-18T17:24:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "Deep Research", "IterResearch", "SSRF 防护"]
description: "Odysseus 深度研究模块：DeepResearcher 以 LLM-in-the-loop 的计划-搜索-抓取-综合-判停迭代生成演化报告，配三层超时、完整降级链与把 TCP 连接钉死到已验证 IP 的 SSRF 防护。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

深度研究（Deep Research）解决的问题是：**一个问题需要的不是一次搜索，而是一轮接一轮的"搜→读→想→再搜"**。模块把这件事做成 LLM-in-the-loop 的迭代引擎：代码只负责夹紧资源上限（轮数、时间、并发、字节数），每一步的决策（研究计划、生成什么查询、何时停止）都交给模型。入口有两个：聊天流里的 research 开关分支（`routes/chat_routes.py:1676-1795`）和 research 面板的 `POST /api/research/start`（`research_start()` in `routes/research/research_routes.py:493`）。

代码分布：`src/deep_research.py`（929 行，引擎 `DeepResearcher`——IterResearch 风格，自述灵感来自 Alibaba Tongyi）、`src/research_handler.py`（991 行，任务管理 `ResearchHandler`）、`services/research/`（666 行，**精简旧版副本**——无 owner/hard-timeout/consumed 机制，canonical 在 `src/`）、`routes/research/`（788 行）、`src/visual_report.py`（1933 行，可视化报告生成）、`src/outbound_fetch.py`（354 行，防 SSRF 抓取）。

## 模块架构

三层分工：**ResearchHandler**（`src/research_handler.py:65`）管任务生命周期——`_active_tasks: Dict[str, dict]`（session_id → task registry，刷新页面可恢复）、结果持久化到 `DEEP_RESEARCH_DIR/{session_id}.json`、事件通知；**DeepResearcher**（`src/deep_research.py:184`）管单次研究的迭代——`queries_used`（去重查询集）、`urls_fetched`、`findings`、`evolving_report`、`providers_used`、`_cancelled`；**services/search**（`core.py` + `providers.py`）管搜索引擎提供链（searxng/brave/ddg/google_pse/tavily/serper + fallback chain）。`src/search/` 是 `sys.modules` 兼容垫片转发到 `services/search`——单一事实源在 services。

`DeepResearcher.__init__()` 的参数就是全部资源上限：`max_rounds=8`（handler 侧上限 20）、`min_rounds=2`、`max_time=300`、`max_urls_per_round=3`、`max_content_chars=15000`、`max_report_tokens=8192`、`extraction_concurrency=3`、`max_empty_rounds=2`、`synthesis_window=10`。

## 调用链路

![深度研究迭代循环](/vibe-reading/images/articles/odysseus-codewiki-dev-2026-09/research-loop.svg)

从用户提交到报告：`synthesize_query()` in `src/research_handler.py:92` 把对话压成单个研究问题——空确认词（"yes"/"ok"）回退最早的真实 user 消息，**刻意不用长度启发式**（"UK"、"Rust" 是合法短主题）；`_resolve_research_endpoint()`（`routes/research/research_routes.py:140`）走 research→utility→default→chat 级联；`_probe_endpoint()`（`src/research_handler.py:720`）先发 "hi" 验证模型可达，失败用 `_format_probe_failure()` 给可操作提示；`start_research()`（`:240`）建 entry 并包 `asyncio.wait_for(hard_timeout)`——`research_run_timeout_seconds=1800`（0 = 无上限，夹到 [60,86400]）；`call_research_service()`（`:740`）从 settings 读各超时项构造 `DeepResearcher`（`min_rounds=max(2, max_rounds-2)`）。每轮：`_create_plan()` + `_classify_category()`（product/comparison/howto/factcheck 四类）→ `_generate_queries()`（`src/deep_research.py:461`，第 1 轮 4 条宽查询、后续 3 条补漏，`current_date_context()` 防训练截止年份污染）→ `_search_and_extract()`（`:507`）→ `_synthesize()`（`:671`，滑动窗口 10）→ `_should_stop()`（`:705`，LLM 判 YES/NO，`strip_thinking()` 防思考块吞掉答案）。成稿 `_final_report()`（`:737`，<400 词触发一轮 expansion 追问）→ `_format_research_report()`（handler `:899`）→ `_save_result()` 落盘 + `fire_event("research_completed")` → `get_report_html()` 调 `generate_visual_report()`（`src/visual_report.py`）。

## 核心实现

### 抓取的 SSRF 双保险

`src/outbound_fetch.py` 是全库外呼的安全底座：`_resolve_public_ips()`（`:92`）预解析 DNS 并拒私网/环回/链路本地/元数据地址（`_is_private_address()` 含 IPv4-mapped 检查）；`_PinnedBackend`（`:119`，httpcore `NetworkBackend`）/ `_PinnedTransport`（`:163`，httpx `BaseTransport`，工厂在 `:283`）**把 TCP 连接钉到已验证 IP**——防 DNS rebinding（两次解析之间换址）；重定向**每跳重新校验**（`_get_public_url()` 循环内 resolve 301/302/303/307/308 逐跳手动处理）；`Accept-Encoding: identity` + 拒绝压缩体（防解压炸弹无法限界）；响应体大小两级控制——软预算 `WEB_FETCH_SOFT_MAX_BYTES = 2MB`（默认下载预算）、硬顶 `WEB_FETCH_HARD_MAX_BYTES = 20MB`（`src/constants.py:83`），实际 cap = `min(max_bytes or 软预算, 硬顶)`，`Content-Length` 超硬顶或读超 cap 时抛 `BodyTooLargeError`（`_CappedFetch` 流式截断）。同一套 pin 思路复用在 `src/webhook_manager.py`（`_PinnedAsyncBackend`）。

### 并发限流的取舍

`asyncio.Semaphore` 限制 `_fetch_and_extract()`（`src/deep_research.py:609`）并发——为什么不用更大的并发：**本地模型服务器单 GPU 串行处理**，洪泛请求会拖慢所有请求（聊天、任务共用同一台模型机）。这是 local-first 架构对抓取侧的直接约束。

### 停止语义与弱模型容错

`max_rounds=20` 是安全帽，正常由 `_should_stop` 提前终止；`max_empty_rounds=2` 连续空轮判定搜索引擎挂了（含 `_last_search_error`——SearXNG 可达但引擎全空也算，issue #344；若全程一条 finding 都没收集到，返回 `"Search unavailable"` 提示串）。`_parse_json_array()`（`:810`）做弱模型容错：修复截断数组、回声 example 数组、多数组取最后一个——针对本地小模型的 JSON 输出缺陷。超时/异常分支都尝试保留 `evolving_report` 作部分结果（issue #1551：不让已抓 findings 白费）。

### 多租户与降级

owner 隔离：`_research_json_path()` 路径校验（session_id 须过 `_RESEARCH_SESSION_ID_RE = ^[A-Za-z0-9-]{1,128}$`（`src/research_handler.py:24`）——防路径穿越）+ 结果 JSON 内 `owner` 字段；路由层统一 404-not-403（`_assert_owns_research()`）防探测存在性（403 会泄露"这个 session 的研究数据存在"）；research_library 列表对无 owner 字段的历史 JSON 过滤；`_owned_enabled_endpoint()` 防 research 权限用户花他人 API key。降级链：`_fallback_research()`（`src/research_handler.py:861`）→ legacy `ResearchOrchestrator`（`research_engine.py` 缺失则跳过）→ `comprehensive_web_search()`。报告复用：`research_spinoff()`（`routes/research/research_routes.py:636`）用报告预填新 chat session，**刻意不注入 sources**——省 token 且防伪造引用。

网页正文一律经 `untrusted_context_message()`（`src/prompt_security.py:64`）包裹进 guard 块——网页内容可能含提示注入，不能进 system role。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| LLM-in-the-loop 计划-执行循环 | `research()` 主循环 in `src/deep_research.py:291-350` | 决策交模型，代码只夹资源上限 |
| 协作式取消 + 三层超时 | `cancel()` 轮间检查 + `max_time` 软超时 + `asyncio.wait_for` 硬超时 | 长任务三层兜底 |
| Progress callback 事件流 | `_emit()` :788 → SSE `research_stream()`（routes/research/research_routes.py:580） | 面板进度实时可见 |
| Task registry + 磁盘持久化 | `_active_tasks` 与 JSON 双读（`consumed` 标记防重复渲染） | 刷新页面可恢复 |

## 模块间交互

所有 LLM 调用经 `_llm()`（`src/deep_research.py:381`）→ `llm_call_async()`（延迟 import 避免启动耦合）；搜索用 `research_search_provider` 设置（独立于普通聊天的 `search_provider`），`providers_used` 记录实际命中者；抓取 `fetch_webpage_content()` in `services/search/content.py`；task_scheduler 的 `_execute_research_task()` 跑同构引擎并落同构 JSON；事件 `research_completed` / `session_created` 走 `src/event_bus.py`。上传/文档系统与本模块基本无直接耦合（仅 visual report 的 og_image 复用）。

> ⚠️ 待核实：`services/research/research_handler.py` 旧副本与 `src/` canonical 版的装配归属——app 实际初始化哪个实例由 `src/app_initializer.py` 的 components 决定（`components["research_handler"]`），改研究逻辑时须先确认装配来源。

## 扩展方式

- **换搜索引擎后端**：新 provider 加进 `_call_provider()`（`services/search/core.py:96`）+ providers.py 实现，`src/search` 垫片无需改；research 侧经 `research_search_provider` 设置或 `start_research(search_provider=...)` 生效，fallback 顺序用 `search_fallback_chain` 设置。
- **调迭代策略**：`src/deep_research.py` 的 `QUERY_GEN_PROMPT` / `STOP_PROMPT`、`min_rounds` 公式（`call_research_service()`）或 settings 的 `research_*` 超时项；UI 侧 `ResearchStartRequest` 的 `max_rounds=0` 即 "Auto"。
