---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "记忆与 RAG"
date: "2026-09-18T17:26:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "记忆系统", "RAG", "Embedding"]
description: "Odysseus 记忆与 RAG：JSON 为权威、向量为加速层的双层存储；BM25+向量混合检索；embedding 双 lane（HTTP API / fastembed ONNX）；每 4 轮对话后台提取记忆，三连去重。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

记忆与 RAG 让 agent "记得你"：跨会话的长期记忆（事实、偏好、身份）与个人文档检索（把你的目录索引进向量库供聊天引用）。核心设计判断是**双层存储**：`memory.json` 是权威（source of truth），向量索引是"可丢失的加速层"——向量库挂了处处 fall through 到关键词路径，功能不残废。这个模块解决的是自托管的现实：ChromaDB 容器没起、embedding 模型没下载，都不该让聊天挂掉。

代码分布：`src/memory.py`（457 行，`MemoryManager`）、`src/memory_provider.py`（327 行，provider 抽象）、`src/memory_vector.py`（251 行，记忆向量索引）、`services/memory/`（2835 行，提取与审计）、`src/rag_vector.py`（705 行，`VectorRAG`）、`src/embeddings.py`（281 行）、`src/embedding_lanes.py`（389 行）、`mcp_servers/memory_server.py` / `rag_server.py`、`routes/memory/`（573 行）、`src/personal_docs.py`（487 行）。

## 模块架构

三个存储引擎各司其职：**MemoryManager**（`src/memory.py:47`）——长期记忆 JSON 权威，无向量能力，`memory_file` 指向 `data_dir/memory.json`；**MemoryVectorStore**（`src/memory_vector.py:25`，collection `odysseus_memories`）——记忆的向量索引；**VectorRAG**（`src/rag_vector.py:75`）——文档级 RAG，持 `EmbeddingLane` 列表。上层的检索编排统一在 `ChatProcessor._hybrid_retrieve()`（`src/chat_processor.py:154`）：BM25 关键词（语料内建 IDF）+ 向量分，加权 `0.55×vector + 0.40×keyword + 0.05×recency`（recency 仅 tiebreaker）。横切抽象两块：`MemoryProvider` ABC（外部记忆系统可插入而不替换本地基线，`MemoryProviderRegistry` 做注册与工具名冲突检测）；`EmbeddingLane`（不同 embedding 模型各占一个 ChromaDB collection——ChromaDB 在首次 insert 时固定 collection 维度，不同模型不能共 collection，故 custom HTTP 与 fastembed 各占 `odysseus_rag_custom` / `odysseus_rag_fastembed`）。

## 调用链路

**记忆提取链**（每 4 轮对话）：`routes/chat_helpers.py:1201` 异步调 `extract_and_store()`（`services/memory/memory_extractor.py:278`）——把会话窗口压平为单条"分析此 transcript"的 user 消息（原文注释：原始交替角色会让模型续写而非提取，实测 0/6 vs 6/6）→ `llm_call_async()` 提取 JSON facts → `_parse_extraction_json()` 容错解析 → 三连去重：`memory_vector.find_similar(threshold=0.72)` 向量去重（含跨租户保护：`find_similar` 无 owner 元数据，须回查 `existing` 确认 owner 匹配）→ `memory_manager.find_duplicates()` 精确匹配 → `_is_text_duplicate()` 模糊匹配 → `memory_manager.add_entry()` + `memory_vector.add()`（identity 类自动 `pinned=True`）→ `save()` 原子写 + `fire_event("memory_added")`。累计到 `AUDIT_INTERVAL` 触发 `audit_memories()` 复审：先比 `_fingerprint_entries()`（记忆集内容指纹）——未变化直接跳过 LLM 调用（省 token）；审计结果有防过度删除安全网（删得太多会被拒绝保存，宁可保留冗余也不丢记忆）；通过的清理经 `_save_tidy_state()` / `_load_tidy_state()` 落盘，向量索引用**完整的 saved_entries 而非本 owner 切片**重建（`MemoryVectorStore.rebuild()`——向量库不区分 owner，切片重建会把别人的记忆挤出索引）。

**检索回注链**：`ChatProcessor.build_context_preface()` → pinned 与 extended 分流（pinned 侧经 `_select_pinned_memories()`：核心记忆始终保留、其余按查询相关性筛选，上限 `MEMORY_CONTEXT_LIMIT = 5`），extended 走 `_hybrid_retrieve()`（`src/chat_processor.py:154`）混合召回——BM25 分（`_bm25_score`，语料内建 IDF）+ `memory_vector.search()` 向量分，加权 `0.55×vector + 0.40×keyword + 0.05×recency`（recency 仅 tiebreaker），低于门槛剔除——注入用 `untrusted_context_message()`（记忆属不可信内容，防注入）包裹，注入后 `increment_uses()` 回写计数。无向量或查询无有效 token 时退化为 `MemoryManager.get_relevant_memories()`（Jaccard + 关键词类目加权）。

**RAG 索引链**：`get_rag_manager()`（`src/rag_singleton.py`，懒加载 + 30s 节流重试，失败返回 None → 路由 503 而非重试风暴）→ `VectorRAG._initialize_system()` → `build_embedding_lanes("odysseus_rag")`（`src/embedding_lanes.py:252`，顺序 custom→fastembed）→ `index_personal_documents()` 用共享 `prune_index_dirs` / `is_indexable_file`（`src/index_walk.py`，单一来源策略）遍历目录，PDF 走 `personal_docs.extract_pdf_text()`，`_split_into_chunks()`（chunk_size=1000、overlap=200，句子边界感知）分块，`_generate_doc_id()`（sha256(owner+text)——owner-scoped 防跨用户 id 冲突）幂等写入所有 lane。查询链：`VectorRAG.search()` 经 `query_lanes()`（per-lane 查询）取候选，混合分 `0.7×vector + 0.3×keyword`，`dedupe_results()` 按 id 去重，失败降级 `_keyword_search_fallback()`；`chat_processor.py:362` 在 `use_rag` 时过滤阈值 `RAG_SIMILARITY_THRESHOLD = 0.35` 后注入。

## 核心实现

### 向量栈选型

`requirements.txt` 用轻量 `chromadb-client`（HTTP 连独立 ChromaDB 容器，默认 `localhost:8100`，docker compose 起）+ `fastembed` 本地 ONNX embedding——**避免把重量级 chromadb server 端嵌进主进程**（`rag_singleton.py` 注释记载曾因 chromadb 1.4.1 / pydantic 2.12 不兼容被迫 `return None`，现已恢复）。未用 faiss / qdrant。

### Embedding 双 lane 与故障降级

`get_embedding_client()`（`src/embeddings.py:241`）优先 HTTP API（Ollama / vLLM / llama.cpp，`EMBEDDING_URL`，OpenAI 格式 `/v1/embeddings`），进程级 `_http_embed_down` latch 防反复探测死端点（connect 3s 快失败）；失败降级 `FastEmbedClient`（`all-MiniLM-L6-v2` ONNX，~50MB 零配置，含 Windows 符号链接自愈——`app.py` 顶部还设 `HF_HUB_DISABLE_SYMLINKS` 防网络盘 UNC 路径崩）。换 embedding 模型：`_fingerprint(lane, url, model, dim)` 检测变更后 `_get_or_reset_collection()` 自动保数据重嵌入，业务层无感。

### fail-closed 的记忆存储

`MemoryStoreUnreadable` + `load_all_for_update()`（严格读，读-改-写专用）fail-closed——issue #5673 的教训：把"读失败"当"空"处理，下一次 `save()` 的原子写会把整个记忆库覆盖成空。普通 `load_all()` 是 lenient 读（供展示/注入），两条读路径分开。写入 `.tmp` + `os.replace` 原子替换。

### KV-cache 纪律

`build_context_preface` 的 docstring 明确：检索内容不放 system 消息——pinned 记忆、RAG 片段逐轮变化，放 system 会击穿本地后端的 KV 前缀缓存。记忆/检索内容一律注入 user-role 的 preface。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Provider 抽象 | `MemoryProvider`(ABC) in `src/memory_provider.py` | 外部记忆系统插入，本地基线不替换 |
| Lane 分流 | `build_embedding_lanes()` in `src/embedding_lanes.py:252` | 多 embedding 模型维度互斥，各占 collection |
| 门面/单例 | `RAGManager`（`src/rag_manager.py`，纯委托 `VectorRAG`）；`get_rag_manager()` 懒加载 | 向后兼容 + 失败降级 |
| 分层降级 | 向量失败 → BM25/Jaccard 关键词 | 向量是加速层不是依赖 |

## 模块间交互

`ChatProcessor` 是消费入口（agent 模式与 chat 模式共用 `build_context_preface()`）；提取/审计用 `llm_call_async()` + `resolve_task_endpoint()` 走后台任务端点，且经 `_queue_background_extraction()` 串行排队——避免挤占本地后端并发槽（issue #2927）；`PersonalDocsManager`（`src/personal_docs.py`，构造注入 `rag_manager`）管理个人文档目录；MCP 暴露 `manage_memory`（owner-scoped `_scope_entries()`——`mcp_servers/memory_server.py`）与 `manage_rag` 工具；`rename_owner()` 配合 `upload_handler` 的改名路径重写 RAG 元数据。注意区分：agent_loop 里的 "[tool-rag]" 日志是**工具索引**检索（tool_index.py），不是文档 RAG。

## 扩展方式

- **新增记忆类目**：`memory_extractor.py` 的提取 prompt/类目枚举 + `_hybrid_retrieve` 的 `cat_boost` + MCP `manage_memory` schema 的 category enum + `NativeMemoryProvider._CORE_FIELDS`，新字段要同步 `_validate_entries()`/`save()` 的补默认逻辑。
- **换向量库**：替换点高度集中——`src/chroma_client.py`（连接层）、`EmbeddingLane.collection`（Duck-typing：只需 `get/add/query/count/delete` 接口）、`rag_vector.py` / `memory_vector.py` 的直调处。注意 `remove_directory()` 依赖 Python 侧路径匹配（Chroma 无路径前缀 where 操作符），换库可能反而简化。对应测试：`tests/` 下 memory/rag 相关（`tests/helpers/` 有工厂）。
