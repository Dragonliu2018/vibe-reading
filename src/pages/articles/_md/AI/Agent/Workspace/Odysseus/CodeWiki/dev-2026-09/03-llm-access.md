---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "LLM 接入与模型能力"
date: "2026-09-18T17:23:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "LLM 接入", "模型发现", "能力探测"]
description: "llm_call_async 是 Odysseus 第二大 god node：host 扫描（含 Tailscale peer）、端口指纹识别、七 reader 能力归一化、OpenAI-compatible 兜底、流式 fallback 链与本地单 GPU 并发闸门——全部模型的单一咽喉。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

这个模块是 Odysseus "local-first" 理念的落点：**任何模型服务——本地 llama.cpp / Ollama / vLLM / LM Studio，还是 Anthropic / OpenAI / OpenRouter / ChatGPT 订阅——都从同一个函数进**。`llm_call_async()` in `src/llm_core.py:2262` 是全库连接数第二的 god node（56 edges）。它解决三个问题：端点从哪来（发现与解析）、请求怎么发（provider 方言与流式）、模型有什么能力（能力探测与协商）。上游消费者是 [Agent 执行引擎](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/01-agent-engine)与邮件/记忆/研究等全部 LLM 辅助调用；下游是网络（httpx）。

代码分布：`src/llm_core.py`（3730 行核心）、`src/endpoint_resolver.py`（672 行，被 import 18 次）、`src/model_capabilities.py`（934 行，能力载体）、`src/model_capability_readers/`（10 文件 1774 行，七个 provider reader）、`src/model_context.py`（520 行，上下文长度查询）、`src/model_discovery.py`（293 行）、`src/ai_interaction.py` 的 `_resolve_model()`（:78，运行时模型路由总入口）、`src/foreground_model_routing.py`、`src/chatgpt_subscription.py`（315 行）。

## 模块架构

模块分三个子域。**发现域**（`ModelDiscovery`）：host 列表从哪来 + 端口上跑的是什么；**解析域**（`endpoint_resolver` + `_resolve_model`）：DB 里的 `ModelEndpoint` 行怎么变成 `(base_url, api_key)`；**调用域**（`llm_core`）：payload 构建、流式解析、fallback、韧性。第四个横切域是**能力**（`model_capabilities` + readers）：payload 里的模型元数据怎么归一成 `ModelCapabilityRecord`。四个域之间靠 DB 表 `ModelEndpoint`（`core/database.py`）与 settings 键（`{prefix}_endpoint_id/_model`）衔接。

关键类型：`ModelCapabilityRecord` in `src/model_capability_readers/base.py:37`——冻结 dataclass（vendor / model_id / capability / display_name / stable_model_id / capability_assertions / deterministic_controls / raw），`__post_init__` 自动补全两件事：`stable_model_id` 为空时用 `stable_model_id_for(vendor, model_id)` 派生（`vendor|scope|model_part`，scope 为 `endpoint:...` 或 base_url 哈希或 global）；`capability_assertions` 为空但有 capabilities 时自动生成 `ASSERTION_CLAIMED` 断言。`ModelCapability` in `src/model_capabilities.py:476` 是规范化载体：`family`（9 类）、`modalities`、`capabilities`（19 个 `CAP_*` token）、`source`（9 级来源优先级：`admin_override > provider_reader > cookbook_hf > … > heuristic`）、`confidence`，配套 `CapabilityAssertion`（claimed/verified/unsupported）、`DeterministicControl`（temperature/seed/tool_choice 等 12 种控制）与 `CapabilityProbeResult`（含 request_hash/response_fingerprint 证据）——`to_assertion()` 把探测结果映射为断言：`PROBE_PASS → ASSERTION_VERIFIED`、`PROBE_FAIL → ASSERTION_UNSUPPORTED`、`PROBE_PARTIAL → ASSERTION_CLAIMED`，source 标 `SOURCE_CAPABILITY_PROBE`，confidence 在 PASS 时取显式级、否则启发式级。

## 调用链路

**发现链**：`ModelDiscovery._get_hosts()`（`src/model_discovery.py`）三级优先——env `LLM_HOSTS` 手动覆盖 → `discover_tailscale_hosts()` 解析 `tailscale status --json` 的 Peer → 默认 host + `host.docker.internal`；各路径都会追加 `OLLAMA_BASE_URL` / `LM_STUDIO_URL` 的主机与自定义端口。端口探测 `discover_models()` 对 hosts × 端口（8000–8020 vLLM/SGLang、8080 llama.cpp、1234 LM Studio、11434 Ollama、11435 APFEL + env 端口）用 `ThreadPoolExecutor(max_workers=50)` 并发 `_check_port()`——GET `/v1/models`，再 `_fingerprint_provider()` 经各家**原生** API（`/props` llama.cpp、`/api/v1/models` LM Studio）指纹识别服务软件，按 `(port, tuple(sorted(models)))` 去重——**为什么这样设计**：同一台机器会经不同 IP（Tailscale IP 与 localhost）被扫到两次，端口+模型集相同的探测结果是同一服务，按此键折叠。为什么用端口指纹而非路径猜测：同一端口可能跑不同服务，OpenAI 兼容层不足以区分软件种类。

**解析链**：`resolve_endpoint_runtime()` in `src/endpoint_resolver.py:146` 把 DB 的 `ModelEndpoint` 行解析为 `(base_url, api_key)`——带 `provider_auth_id` 的（ChatGPT 订阅）走 `chatgpt_subscription.resolve_runtime_credentials()` 取可刷新 token；DNS 失败时 `_resolve_tailscale_host()` 用 Tailscale peer 表把主机名换算成 IP（个人 tailnet 里 DNS 未必通）。

**选择链**：`_resolve_model()` in `src/ai_interaction.py:78` 是运行时模型名→路由的总入口，支持 `"model_name@endpoint_name"` 语法。策略：遍历所有 enabled 且过 `owner_filter` 的端点；Anthropic 走 `ANTHROPIC_MODELS` 硬编码表匹配；其余实时 GET `/models`（失败退回 `ep.cached_models`），**精确匹配优先于部分匹配**。配置侧等价物 `resolve_endpoint()`（`src/endpoint_resolver.py:343`）读 settings 键，完整回退链：`{prefix}_endpoint_id`/`{prefix}_model` → prefix 非 utility/default 时回退 `utility_endpoint_id`/`utility_model` → 调用方给的 `fallback_url`+`fallback_model` → `default_endpoint_id`/`default_model` → 最后用调用方 fallback。配置的 model 若在端点上被用户隐藏（`_endpoint_hidden_models`）则清空视为未设置，改由 `_first_chat_model()` 自动挑——`_endpoint_enabled_models()` 合并 `cached_models` 与 `pinned_models` 保序去重、剔除 hidden 后，跳过 `_NON_CHAT_MODEL` 子串（text-embedding / tts- / whisper / dall-e 等）选第一个聊天模型，全部非聊天时回退 `models[0]`。

**调用链**：`stream_llm()` in `src/llm_core.py:2559` 是薄包装——先过 `_local_model_slot()` 本地模型闸门，再进 `_stream_llm_inner()`（:2582，49-edge god node）。流式协议 SSE 四类：`{"delta": text}` 文本、`{"type": "tool_calls"}`（累积原生工具调用）、`event: error`、`[DONE]` 结束；`return_model_metadata=True` 时额外产出 `{"type": "model_actual"}`。payload 细节：`stream_options.include_usage` 对除 openrouter / groq 之外的所有 provider 注入；`_is_ollama_openai_compat_url(url)` 且 `_supports_thinking(model)` 时设 `payload["think"] = False`——防工具调用被吞进 `&lt;think&gt;` 块。**流式路径刻意不重试连接**（注释明示）：只把 connect 预算加宽到 `LLM_CONNECT_TIMEOUT`，真正不可达的上游交给 dead-host cooldown 处理——重试半开的连接只会让首字延迟更糟。`llm_call_async()` 的 chatgpt-subscription 分支甚至把流式聚合回纯字符串（Codex Responses API 只支持流式）；该分支只对 429/502/503/504 重试（sleep `LLMConfig.RETRY_DELAY` 后再试，达 `max_retries` 止），响应 JSON 结构异常时抛 `_FallbackIneligibleHTTPException(502)`——`fallback_eligible=False`，该失败绝不推进候选路由链。

## 核心实现

### Provider 适配：OpenAI-compatible 兜底 + 按 host 精确分派

`_detect_provider()` in `src/llm_core.py:966` 按 hostname **精确匹配**（防 `anthropic.com.example` 误判），未知 host **默认归入 openai 兼容**——绝大多数本地/云服务实现 `/v1/chat/completions`，这是"统一接入"的落点。已知 provider 再叠加各自 quirk：`_uses_max_completion_tokens()`、`_omit_temperature()`（Moonshot/Anthropic 拒绝自定义温度）、`_alias_harmony_tools()`、Mistral `reasoning_effort`、Ollama `/v1` 的 `think: false`。

`_is_self_hosted_openai_compatible()` 的双重门槛（provider=openai 且 `is_local_endpoint()`）决定 llama.cpp 的 `session_id/cache_prompt` KV-cache 亲和字段**只发给确认本地的端点**——严格云服务（api.openai.com 400、Mistral 422 extra_forbidden）会拒绝未知顶层字段，宁可丢性能提示也不要硬 4xx。

### Fallback 链：已吐 token 就不再切换

三层 fallback：`llm_call_async_with_route_fallback()`（`:2188`，非流式，只对显式 eligible status 前进，空响应视为不可用证据）；`stream_llm_with_fallback()`（`:3511`，流式）：**只在候选产出实质内容之前（pre-content）且错误 eligible 时切换；一旦已产出真实输出（emitted）绝不切换**，后续错误原样透传——否则会重复吐 token。非实质输出的 chunk 存入 `pending_metadata`，实质输出 commit 后、正文之前 flush；`i > 0` 的备选候选首次产出实质内容时 yield 一个 `type="fallback"` 事件（含 `selected_model` / `answered_by` / `failures` 字段，前端据此显示"已切换模型"）。候选无实质输出视为 502 "returned no substantive output" 错误；`fallback_on_empty=False` 可禁用空完成切换（最后一个候选的空输出以 "All model candidates returned no substantive output" 收尾）。`_FallbackIneligibleHTTPException` 允许错误携带 `fallback_eligible=False` 直接熔断链（4xx 配置错误换候选也没用）。运维韧性配套：**死主机冷却**——`_mark_host_dead()`（`src/llm_core.py:489`）连续 `_HOST_FAIL_THRESHOLD = 2` 次失败把 host 标 dead、冷却 `DEAD_HOST_COOLDOWN = 20.0` 秒（`:231-232`），期间请求直接 503 不再撞死端点；成功请求经 `_clear_host_dead()`（`:500`）同时清 dead 标记与失败计数；`_host_fails` 的读-改-写由 `_host_health_lock` 保护（`:238` 注释——多线程探测并发下不加锁会丢计数）。另有 `_DegenerateStreamGuard`（`src/llm_core.py:360`）检测本地模型的 token 崩塌（"Var Var Var..." 刷屏烧上下文）——三条保守规则：同一 token 连续 ≥28 次且总字符 ≥100；近期 96 个 token 窗口内某 token 计数 ≥60 且占比 ≥0.78；同一 4-gram 短语重复 ≥10 次（防量化 MLX/MoE 模型的短语死循环），命中即发 `event: error`、status 502、`fallback_eligible=False`（`:422`，熔断 fallback 链），以及 `_HarmonyStreamRouter` 处理 gpt-5.2 思考/正文路由。

### 本地单 GPU 闸门

`_local_model_slot()` 让 foreground 可 cancel 后台任务、background 需等 `has_foreground_activity()` 归零——本地服务器多为单生成管道，后台 email 摘要与前台聊天并发会造成"流串台"。前台抢占语义与 task_scheduler 的 `_cancel_if_foreground_active()` 一脉相承。

### 能力读取器：分层纪律

`model_capability_readers/` 是 Protocol 多态：`CapabilityReader` 协议（`records_from_payload()`）由 `generic_openai / openai / openrouter / google / llamacpp / lmstudio / ollama` 七个实现满足，`reader_for_vendor()`（`__init__.py:49`）按 vendor 查 `READER_MODULES` 注册表，缺省回落 `generic_openai`。分层纪律写在 docstring：**readers 零网络 IO、禁止从模型名推断能力**（名称推断会把 `*-vision` 之外的视觉模型漏掉）——llama.cpp 甚至从 `/props` 提取 `ASSERTION_UNSUPPORTED` 负向断言。上下文长度 `_query_context_length()`（`src/model_context.py`）分层查询：api/proxy 端点优先 `_proxy_catalog_context()`（OpenRouter issue #4886：未知模型不按默认截断）；本地端点先打 llama.cpp `/slots` 读真实 `n_ctx`；本地与已知表取较小值（尊重用户 `--max-model-len`），云端取较大值。

> ⚠️ 待核实：`model_capability_readers` 注册表在 `src/` 与 `routes/` 生产代码中未发现消费者（仅 `tests/test_model_capability_readers.py` 引用）——能力记录如何入库/进 API 响应的生产接线疑似尚未完成。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Provider 适配 + 兜底 | `_detect_provider()` in `src/llm_core.py:966` | 未知 host 归 OpenAI 兼容，长尾服务零改动接入 |
| 读取器多态（Protocol） | `reader_for_vendor()` in `src/model_capability_readers/__init__.py:49` | vendor → reader 注册表，缺省 generic |
| 三层 fallback | `stream_llm_with_fallback()` :3511 | 本地服务不稳是常态；已吐 token 不换 |
| 响应缓存 | `_set_cached_response()`（llm_call 后写入） | 幂等请求（探测类）省算力 |
| 死主机冷却 | `_mark_host_dead()` / `_dead_hosts` | 避免每请求重复撞已死端点 |

## 模块间交互

被 `src/agent_loop.py` 核心消费（`stream_llm_with_fallback` 多轮、`llm_call_async` 辅助）；`routes/chat_routes.py` 经 `resolve_foreground_model_policy()` + `build_chat_model_candidates()`（`src/foreground_model_routing.py`）组装"主模型 + 用户显式启用的 fallback 列表"（默认 fail-closed：`FOREGROUND_FALLBACK_ENABLED_KEY is not True` 即禁用）；task_scheduler / email / memory 走 `resolve_task_candidates()` 后台端点链（研究/任务用户可配独立模型）。配置分工：`.env` 管基础设施级开关（`LLM_HOSTS`、`LLM_CONNECT_TIMEOUT`——注释解释为何从 3s 放宽到 10s：公网冷连接抖动导致流式 503），DB settings 管端点/模型选择。

## 扩展方式

- **新增 provider**：`_detect_provider()` 加 `_host_match` 分支 → 需要特殊 payload/头就在 `llm_call_async()` / `_stream_llm_inner()` 构建段加 quirk → 有原生模型 API 则在 `model_capability_readers/` 新增 reader 模块并注册 `READER_MODULES`，否则零改动落回 `generic_openai`。
- **新增能力探测维度**：`model_capabilities.py` 加 `CAP_*` 常量进 `CAPABILITIES` frozenset → 相关 reader 的 `records_from_payload()` 从 payload 显式字段产出该 token → 需实测则扩展 `CapabilityProbeResult` 与 `routes/model_routes.py` 的 `_probe_single_model()`（`with_tools=...` 已有工具支持实测）。
