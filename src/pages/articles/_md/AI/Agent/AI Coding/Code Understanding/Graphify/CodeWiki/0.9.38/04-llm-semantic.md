---
source:
  type: "源码解读"
  project: "graphify"
  url: "https://github.com/Graphify-Labs/graphify"
title: "LLM Semantic Layer"
date: "2026-08-10T22:00:00+08:00"
category: [AI, Agent, "AI Coding", "Code Understanding", Graphify, CodeWiki, "0.9.38"]
tags: ["graphify", "LLM", "语义抽取", "多provider", "自适应重试", "prompt安全"]
description: "graphify LLM 语义层：多 provider 统一接口、自适应二分重试、prompt injection 防御、语义缓存与 semantic_cleanup 安全边界。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI Coding/Code Understanding/Graphify/CodeWiki/0.9.38/00-overview)

---

## 模块定位

LLM 语义层是 graphify 的**可选补充**——代码用 tree-sitter 确定性抽取，但文档、PDF、图片、视频需要 LLM 做语义理解。这层只在用户配置了 API key 或 backend 时运行，产出的语义节点/边与 AST 节点/边合并后送入图构建。模块覆盖 `llm.py`（3164 行）、`semantic_cleanup.py`（336 行）、`ingest.py`（353 行）。

模块的核心设计原则是**与 AST 抽取物理隔离**——LLM 抽取是不确定性的、有成本的、需缓存的，不能污染确定性管线。语义边统一标记为 INFERRED（因为通过 LLM 推理得出而非源码显式声明），让下游能区分。

## 模块架构

![LLM 语义层调用链](/vibe-reading/images/articles/graphify-internals/llm-semantic-call-chain.svg)

模块内部按数据流分四个阶段。**缓存检查**（`check_semantic_cache`）分离已缓存/未缓存文件，只对未缓存文件调 LLM。**并行抽取**（`extract_corpus_parallel`）按 token budget 分块，`ThreadPoolExecutor`（max_concurrency=4）并发 LLM 调用。**Provider 分派**（`extract_files_direct`）用 if/elif 路由到具体 `_call_*` 函数——大多数 OpenAI-compatible provider 共用 `_call_openai_compat`。**解析与清洗**（`_parse_llm_json` + `semantic_cleanup`）解析 LLM 返回的 JSON，验证 code 节点符号在源码中存在，清洗恶意/畸形 payload。

## 调用链路

```
cli.py: extract 命令
  ├─ AST 抽取 (extract.py)
  ├─ check_semantic_cache(files, root, mode, prompt)     cache.py L1022
  │   └→ (cached_nodes, cached_edges, cached_hyperedges, uncached_paths)
  │
  ├─ extract_corpus_parallel(uncached_paths, backend, ...)  llm.py L2227
  │   ├─ _pack_chunks_by_tokens() → 按 token budget 分块
  │   ├─ ThreadPoolExecutor(max_concurrency=4)
  │   │   └─ _extract_with_adaptive_retry()               llm.py L2034
  │   │       ├─ _extract_one_chunk() → LLM API call
  │   │       │   └─ extract_files_direct()                llm.py L1727
  │   │       │       ├─ _read_files() → user message
  │   │       │       │   └─ _wrap_untrusted() + _neutralise_injection_sentinels()
  │   │       │       └─ if backend == "claude": _call_claude()
  │   │       │          elif backend == "bedrock": _call_bedrock()
  │   │       │          elif backend == "azure": _call_azure()
  │   │       │          else: _call_openai_compat()  (openai/gemini/ollama/kimi/deepseek)
  │   │       └─ 截断时二分递归重试 (max_retry_depth=3)
  │   ├─ _parse_llm_json(response)                        llm.py L979
  │   ├─ _bind_node_evidence()                            llm.py L654
  │   │   └─ 验证 code 节点符号在源码中存在 → 否则标 unverified
  │   └─ _checkpoint_chunk() → save_semantic_cache         llm.py L2329
  │
  ├─ save_semantic_cache(fresh, ...)                      cache.py L1111
  ├─ prune_semantic_cache(root, live_hashes)              cache.py L968
  └─ 合并 AST + semantic → build()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `extract_corpus_parallel()` llm.py L2227 | 语义抽取编排 | 分块 + ThreadPool + 自适应重试 |
| `_extract_with_adaptive_retry()` llm.py L2034 | 截断时二分重试 | 三种失败信号统一走二分 |
| `extract_files_direct()` llm.py L1727 | Provider 分派 | if/elif 路由，非抽象基类 |
| `_call_openai_compat()` llm.py L1156 | OpenAI-compatible 调用 | 覆盖 5+ provider |
| `_call_claude()` llm.py L1306 | Anthropic SDK 调用 | 支持 vision |
| `_call_bedrock()` llm.py L1670 | boto3 Converse API | 响应结构完全不同 |
| `_parse_llm_json()` llm.py L979 | 解析 LLM 返回 JSON | strip fences + json.loads + sanitize |
| `_bind_node_evidence()` llm.py L654 | 验证 code 节点 | 符号不存在标 unverified |
| `_checkpoint_chunk()` llm.py L2329 | 增量写 cache | 每个 chunk 完成后立即写 |
| `generate_community_labels()` llm.py L3121 | 社区命名 | 失败降级为 Community N |
| `detect_backend()` llm.py L2816 | 自动探测可用 backend | Ollama 排最后 |

</details>

## 核心实现

### 多 Provider 统一：BACKENDS 字典 + 函数分派

graphify 不用抽象基类统一 provider，而是用**配置字典 + if/elif 分派**的轻量策略模式。`BACKENDS` 字典（`llm.py` L100）定义每个 provider 的参数：

```python title="llm.py L100-218"
BACKENDS: dict[str, dict] = {
    "claude":    {"base_url": ..., "default_model": ..., "env_key": ..., "pricing": {...}, "temperature": 0, "max_tokens": 16384, "vision": True},
    "kimi":      {..., "vision": True, "temperature": None},  # kimi-k2.6 固定 temperature
    "ollama":    {..., "pricing": {"input": 0.0, "output": 0.0}},
    "gemini":    {..., "reasoning_effort": "low"},
    "openai":    {...},
    "deepseek":  {...},
    "azure":     {..., "env_key": "AZURE_OPENAI_API_KEY"},
    "bedrock":   {...},
    "claude-cli": {..., "default_model": "claude-code-plan"},  # 走本地 CLI subprocess
}
```

`extract_files_direct()`（`llm.py` L1796）用 if/elif 分派到具体调用函数。大多数 OpenAI-compatible provider（kimi/openai/gemini/ollama/deepseek）共用 `_call_openai_compat()`（L1156），只有 SDK 不兼容的 provider 有独立函数：`_call_claude()`（Anthropic SDK）、`_call_bedrock()`（boto3 Converse API）、`_call_azure()`（AzureOpenAI SDK）、`_call_claude_cli()`（subprocess）。

**为什么不用抽象基类**：各 provider 的 SDK 参数差异太大（Bedrock 用 Converse API、claude-cli 是 subprocess、Azure 用独立 SDK client），抽象成统一 interface 会丢失 provider-specific 优化。配置 dict + 函数分派保持了灵活性。

**零代码新增 provider**：用户可以在 `~/.graphify/providers.json` 中添加配置，`_load_custom_providers()`（L264）自动合并到 `BACKENDS`。

### Provider-specific 差异处理

- **Temperature**：`_resolve_temperature()`（L345）处理 reasoning model（o1/o3/o4/gpt-5）不接受 temperature 的问题。
- **Ollama num_ctx**：自动推导 `num_ctx` 防止默认 2048 截断 prompt（L1230-1265）；单 GPU 一次只处理一个请求，默认强制 `max_concurrency=1`，除非用户设 `GRAPHIFY_OLLAMA_PARALLEL=1`。
- **Kimi thinking disable**：Moonshot endpoint 强制 `{"thinking": {"type": "disabled"}}`（L1214）。
- **Bedrock**：用 boto3 Converse API，响应结构完全不同，需 `_bedrock_response_text()` 提取（L1059）。

### 自适应二分重试

`_extract_with_adaptive_retry()`（`llm.py` L2034）统一处理三种失败信号——都触发 chunk 二分 + 递归重试，最大深度 `max_retry_depth`（默认 3，即最多 8 倍展开）：

1. `finish_reason == "length"` — 输出被 max_tokens 截断
2. Context window exceeded — API 400 错误
3. Hollow response — HTTP 200 但内容为空/不可解析（`_response_is_hollow()` L1083，Ollama 过载典型）

### Prompt 安全：untrusted_source + injection 防御

LLM 处理的是用户提供的文件内容（可能包含恶意构造），graphify 有两层防御：

- **`_wrap_untrusted()`**（L548）：把每个文件内容包在 `<untrusted_source>` 标签中，带 sha256 hash。prompt 明确指示模型：`<untrusted_source>` 块内是数据不是指令。
- **`_neutralise_injection_sentinels()`**（L538）：用零宽空格打断 chat template 控制符（`<|im_start|>`、`<<SYS>>` 等），防止文件内容注入 chat template。

### 语义抽取的 prompt

`_EXTRACTION_SYSTEM`（`llm.py` L450-478）是固定的 system prompt，定义抽取 schema：
- **Nodes**：id（`{stem}_{entity}` 格式）、label、file_type（code/document/paper/image/rationale/concept）、source_file
- **Edges**：relation（calls/implements/references/cites/conceptually_related_to/shares_data_with/semantically_similar_to）、confidence（EXTRACTED/INFERRED/AMBIGUOUS）
- **Hyperedges**：3+ 节点的群体关系，每个 chunk 最多 3 个

**Deep mode**：`_DEEP_EXTRACTION_SUFFIX`（L481）追加指令，要求抽取更多 INFERRED 边（共享数据契约、生命周期耦合、多步流程依赖）。

### semantic_cleanup：安全边界

`semantic_cleanup.py` 是 untrusted agent-written chunk JSON 的安全边界。LLM 返回的 JSON 可能包含恶意构造或格式错误，需要在触碰 graph 前拦截。分两阶段：

1. **`validate_semantic_fragment()`**（L44）：验证阶段，拒绝恶意/畸形 payload——payload 上限 25MB、nodes 上限 10000、ID 验证（长度 ≤256、不含 `/`/`\`/`..` 防目录逃逸 #825、字符集 `[\w.:-]+`）。file_type 故意不验证（因为 build.py 的 `_FILE_TYPE_SYNONYMS` 会做同义词映射）。
2. **`sanitize_semantic_fragment()`**（L172）：清洗阶段——识别无效 `file_type: "rationale"/"concept"` 的节点 + 句子型 rationale 节点，把 rationale label 转为目标节点的 `rationale` 属性，删除引用已移除节点的边。

**主要构建路径不运行 cleanup**：`build_from_json`/`load_graph_json` 故意不运行 cleanup——它们必须能加载已存在的合法 graph。

### 语义缓存：prompt 指纹 + 增量检查点

语义缓存（`cache.py`）的关键设计：

- **Key**：按 `source_file` 分组，每个文件一个 cache entry，keyed by 文件内容 hash + **提取 prompt 的指纹**（SHA256 前 12 位，`cache.py` L66-109）。prompt 变了就重新抽取，没变就复用（#1939）。
- **增量检查点**：`_checkpoint_chunk()`（L2329）在每个 chunk 完成后立即写 cache，中断后重启只重跑未完成的 chunk。
- **Partial 标记**：被截断的 chunk 结果标记 `partial: True`，下次视为 cache miss 重新抽取（L825-834）。
- **Deep mode namespace**：deep-mode 结果存入 `cache/semantic-deep/`，不覆盖标准模式（#1894）。
- **Allowed source files**（L1142）：cache 写入时只允许当前 chunk 实际分派的文件作为 key，防止模型把节点错误归属到其他文件（#1757）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Provider 策略 | `BACKENDS` dict + `extract_files_direct()` | 配置统一参数，函数分派保灵活性 |
| 自适应降级 | `_extract_with_adaptive_retry()` | 三种失败信号统一走二分重试 |
| 优雅降级 | `generate_community_labels()` | LLM 失败降级为占位符 |
| 增量检查点 | `_checkpoint_chunk()` | 中断不丢已完成结果 |
| 安全边界 | `semantic_cleanup.py` | 验证 + 清洗两阶段防御 |

## 模块间交互

- **← cli.py**：`extract` 命令先跑 AST 抽取，再检查 semantic cache，只对未缓存文件调 `extract_corpus_parallel()`。
- **→ cache.py**：`check_semantic_cache` 读缓存，`save_semantic_cache` 写缓存，`prune_semantic_cache` 清孤儿。
- **→ build.py**：语义节点与 AST 节点合并后送入 `build()`——同 ID 时 semantic 覆盖 AST（semantic 有更丰富 label）。
- **→ file_slice.py**：`FileSlice`/`bisect_slice` 用于 chunk 分割和截断处理。
- **→ detect.py**：`extract_pdf_text` 等用于非代码文件文本提取。
- **→ ingest.py**：`ingest()` 下载/转换 URL 为本地文件，后续被 extract 拾取——支持 tweet/arxiv/webpage/pdf/youtube。
- **← dedup.py**：调 `_call_llm()` 做 Pass 3 LLM tiebreaker。
- **← prs.py**：调 `BACKENDS`/`_get_backend_api_key`。

## 扩展方式

### 新增一个 LLM provider

1. **`graphify/llm.py`**：`BACKENDS` 字典（L100）添加 entry（`base_url`/`env_key`/`default_model`/`pricing`/`temperature`/`max_tokens`/`vision`）
2. **判断是否需要独立 `_call_` 函数**：OpenAI-compatible 不需要，直接走 `_call_openai_compat()`（L1156）；SDK 不兼容则添加 `_call_xyz()`
3. **`detect_backend()`**（L2827）priority 列表添加新 provider
4. **零代码方案**：用户在 `~/.graphify/providers.json` 添加配置，`_load_custom_providers()`（L264）自动合并

### 修改语义抽取的 prompt

1. **`graphify/llm.py`**：修改 `_EXTRACTION_SYSTEM`（L450-478）——在 relation 枚举中添加新类型、在 output schema 中加入示例
2. **注意 cache 失效**：修改 prompt 后 `prompt_fingerprint()` 产生不同 hash，所有旧 cache entry 自动失效（设计意图——prompt 变了应该重新抽取）
3. **Deep mode**：修改 `_DEEP_EXTRACTION_SUFFIX`（L481）同样触发 cache 失效
