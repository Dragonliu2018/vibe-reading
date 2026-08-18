---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Memory 记忆系统"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Memory", "Embedding", "Rerank", "被动记忆"]
description: "jcode Memory 记忆系统——passive 自动召回、hybrid 检索（dense+BM25+RRF）、consensus LLM judge 重排、semantic drift 提取、向量空间隔离"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

Memory 模块是 jcode 智能化的核心差异化——一套"像人一样自动回忆"的 passive 记忆系统。它不作为 tool 暴露给 agent 主动调用，而是每轮自动检索相关记忆并注入对话。模块位于 `crates/jcode-base/src/memory*.rs`（7 个文件）+ `crates/jcode-embedding/`（本地 ONNX 推理）+ `crates/jcode-memory-types/`（数据契约）。

---

## 模块架构

- **memory.rs** — `MemoryManager`，检索主逻辑（hybrid 检索 + synthetic entry provider）
- **memory_agent.rs** — `MemoryAgent` sidecar，独立 tokio task 运行召回/提取流程
- **memory_graph.rs** — 记忆图操作
- **memory_rerank.rs** — consensus LLM judge 重排
- **memory_types.rs / jcode-memory-types** — `MemoryEntry`/`MemoryGraph`/`Edge` 数据契约
- **embedding.rs / embedding_backend.rs** — embedding facade + `EmbeddingBackend` trait
- **jcode-embedding** — 本地 ONNX 推理（all-MiniLM-L6-v2 + tract）

`MemoryEntry`（`jcode-memory-types/src/lib.rs:232`）含 `category`（Fact/Preference/Entity/Correction/Custom）、`embedding: Option<Vec<f32>>`（384 维）、`embedding_model`（向量空间标记）、`confidence`（时间衰减+访问增益）、`strength`（reinforcement 计数）、`trust`（High/Medium/Low）、`active`/`superseded_by`（生命周期）。

`MemoryGraph`（`graph.rs:231`）含 `memories` HashMap + `tags`/`clusters` 节点 + `edges`（前向）+ `reverse_edges`（反向，用于 BFS）。

---

## 调用链路

### 记忆召回（每 turn 触发）

```
主 Agent turn 结束 → memory_agent::update_context_sync_with_dir()
  └─ MemoryAgent::process_context()              memory_agent.rs:477
       ├─ embed_query_active(context)            embedding_backend.rs:324
       │    → LocalOnnxBackend / OpenAI 后端生成 query 向量
       ├─ cosine_similarity(ctx_emb, last_emb)   memory_agent.rs:581
       │    → 若 < 0.3: topic_changed=true → extract_from_context(previous_topic)
       ├─ MemoryManager::find_similar_hybrid()   memory.rs:642
       │    → hybrid_fuse(): dense(cosine) + sparse(BM25) → RRF 融合
       │    → 向量空间门控: 仅相同 model_id 的 embedding 参与 dense 比较
       ├─ rerank_candidates_consensus_attributed()  memory_rerank.rs:249
       │    → N 个独立 LLM judge 投票, min_agree 票数通过才保留
       ├─ set_pending_memory(prompt)             memory/pending.rs
       │    → 写入 PENDING_MEMORY, 主 agent 下次读取注入 system prompt
       └─ post_retrieval_maintenance()           memory_agent.rs:1200
            → discover_links / confidence 更新 / cluster 精化
```

### 记忆提取

```
触发: topic_changed(cosine<0.3) + turns_since>=4 | periodic(每12轮) | session end
  └─ MemoryAgent::extract_from_context()        memory_agent.rs:931
       ├─ sidecar.extract_memories_with_existing()  Haiku LLM 提取候选
       │    (传入 existing memories 避免重复)
       ├─ 对每条: find_similar(content, threshold=0.90) 去重检测
       │    ├─ 已存在 → reinforce() (strength++), 可选 supersede
       │    └─ 新记忆 → MemoryEntry::new() → ensure_embedding() → 写入 graph
       └─ 保存到 ~/.jcode/memory/<project_hash>/
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `process_context()` | 召回主流程 | sidecar task 内完成，不阻塞主对话 |
| `find_similar_hybrid()` | hybrid 检索 | dense+BM25 RRF 融合 |
| `rerank_candidates_consensus_attributed()` | LLM judge 重排 | N judge 投票，min_agree 通过 |
| `extract_from_context()` | 记忆提取 | 传 existing 避免重复 |
| `effective_confidence()` | 置信度计算 | category 半衰期不同 |

---

## 核心实现

### Passive 记忆（不主动调 tool）

memory 不作为 tool 暴露给主 agent，而是被动地每 turn 自动检索 + 注入 pending memory。主 agent 无需感知记忆系统存在——整个 `process_context` 流程在 sideagent task 内完成，结果写入 `PENDING_MEMORY`，主 agent 下次构建 system prompt 时读取注入。

### Hybrid 检索 + RRF 融合

`find_similar_hybrid`（`memory.rs:642`）走两路：dense（cosine 相似度）和 sparse（BM25 词频），各取 top `pool=limit*5`，用 Reciprocal Rank Fusion（`RRF_K=60`）合并——`score = Σ 1/(RRF_K+rank+1)`。这比纯 dense 更鲁棒（BM25 捕获精确关键词匹配，dense 捕获语义相似）。

### Consensus Rerank（多 LLM judge 投票）

`rerank_candidates_consensus_attributed`（`memory_rerank.rs:249`）并发 N 个独立 LLM judge，`min_agree` 票一致才保留。将单 judge precision ~0.77 提升到 ~1.0。**Cadence 门控**：昂贵的 LLM rerank 每 N 轮才跑一次（`memory_rerank_cadence`），中间轮次复用上次 judge-verified set。Circuit Breaker：rerank 失败时 30s backoff，永久错误只报告一次。

**LLM judge 是唯一精度保证**：`memory_runtime_active()` 在 sidecar 模式下若无 LLM backend（未登录），记忆系统直接 dormant 而非降级到低精度 no-LLM 路径——no-LLM hybrid 路径 precision@5 仅 0.23，注入大量无关记忆反而有害。

### Semantic Drift 触发提取

用 context embedding cosine < 0.3（`TOPIC_CHANGE_THRESHOLD`）检测 topic change，在切话题前对旧话题 context 做增量提取（`memory_agent.rs:582`）。同时有 periodic extraction（每 12 轮，`turns_since_extraction >= 12`）兜底长单话题 session。session end 时 `trigger_final_extraction()`。

### Local ONNX Embedding

默认用 all-MiniLM-L6-v2（384 dim，ONNX，tract 推理），不依赖网络/API key。模型按需 lazy load + idle unload（`maybe_unload_if_idle`），避免 87MB 常驻 RAM——这是 jcode "local embedding off" 模式下 27.8 MB RSS 的关键（开启 embedding 后 167 MB）。

### 向量空间隔离

切换 embedding backend 时，旧向量不与新向量比较（不同 `model_id`）。旧记忆仍可通过 BM25 lexical 检索触达，避免静默损坏。`dense_eligible` 过滤（`memory.rs:691`）确保仅相同 model_id 的 embedding 参与 dense 比较。

### Memory Consolidation

`effective_confidence`（`lib.rs:352`）按类别设不同半衰期：Correction 365 天 / Preference 90 天 / Fact 30 天。verified 记忆 `boost_confidence`，rejected 记忆 `decay_confidence`。supersede 机制标记过时记忆 `active=false`。ambient mode 定期做 gardening（duplicates > contradictions > prune > verify stale facts）。

### Synthetic Entry Provider（依赖反转）

`register_synthetic_entry_provider`（`memory.rs:80`）让上层 skill 模块注册回调，将 skill registry 转为 synthetic `MemoryEntry` 参与检索——skill 也像记忆一样被 embedding 检索自动注入。这避免了 memory → skill 的向上依赖。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Sideagent | `MemoryAgent` mpsc channel(16) | 独立 tokio task，不阻塞主对话 |
| Hybrid 检索 + RRF | `hybrid_fuse()` RRF_K=60 | dense+BM25 互补 |
| Consensus Rerank | `memory_rerank.rs:235` N judge | 单 judge 0.77→~1.0 |
| Cadence 门控 | `memory_agent.rs:719` | 昂贵 rerank 每 N 轮一次 |
| Synthetic Entry Provider | `register_synthetic_entry_provider` | 依赖反转，skill 注入检索 |
| 向量空间隔离 | `dense_eligible` model_id 门控 | 切 backend 不静默损坏 |
| Circuit Breaker | `memory_rerank.rs:32` 30s backoff | 失败不淹没 |

---

## 模块间交互

- **memory ↔ skill**：skill 通过 `register_synthetic_entry_provider` 注册为 synthetic memory entry，参与 `collect_retrieval_candidates_scoped()` 的全局范围检索。
- **memory ↔ ambient**：ambient system prompt 通过 `gather_memory_graph_health()` 收集 graph 统计（contradictions/low_confidence/missing_embeddings），供 ambient agent 做 consolidation 决策。post-cycle 异步 `backfill_embeddings()`。
- **memory ↔ embedding**：`embedding_backend.rs` 的 `active_backend()` 选择本地 ONNX 或远程 OpenAI；`embedding.rs` 管理进程级 EmbedderCache + LRU(128) + idle unload。
- **memory ↔ sidecar**：`Sidecar` 是 Haiku LLM 封装，用于提取（`extract_memories_with_existing`）和重排判官（`rerank_candidates_consensus`）。

---

## 扩展方式

**新增记忆来源**（如从 git log 提取）：在 `collect_retrieval_candidates_scoped()` 追加来源，或新注册 `register_synthetic_entry_provider(|| { git_entries })`。若需 LLM 提取，扩展 `Sidecar::extract_memories_with_existing` 的 prompt。

**修改召回策略**（如调整 hybrid 权重）：修改 `memory.rs:668 hybrid_fuse()` 的 RRF 融合逻辑，或调整 `EMBEDDING_MAX_HITS`/`MEMORY_RELEVANCE_MAX_CANDIDATES`。调整精度阈值改 `memory_rerank.rs` 的 `RerankMode` 和 consensus `min_agree`。

**更换 embedding 模型**（如换 bge-large）：实现 `EmbeddingBackend` trait（注意 `format_query`/`format_passage` 的 instruction prefix），在 `active_backend()` 添加选择逻辑。新记忆自动标记新 model_id；旧记忆通过 BM25 仍可检索，dense 比较自动隔离。
