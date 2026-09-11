---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Memory 记忆系统"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "Memory", "Embedding", "Rerank", "被动记忆", "Hybrid Retrieval"]
description: "jcode Memory 记忆系统——passive 自动召回 pipeline、hybrid 检索（dense+BM25+RRF 融合）、consensus listwise LLM rerank（recall@5 0.53→0.75）、carry verified 降级保护、语义漂移提取、记忆图"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

Memory 是 jcode 智能化的核心差异化：**passive 记忆**——每轮对话自动检索相关记忆注入上下文，模型无需主动调用记忆工具。核心不变量（`memory_rerank.rs:203`）："the judge is the ONLY thing allowed to surface memory"——hybrid 检索只负责 recall，consensus LLM rerank 负责 precision，judge 不可用时宁可沉默也不注入噪声。模块跨 `jcode-base`（`memory.rs` 2065 行、`memory_agent.rs` 1949 行、`memory_rerank.rs`、`memory/` 子目录）与 `jcode-memory-types`（契约）、`jcode-embedding`（本地 ONNX 推理）。

---

## 模块架构

三层结构：

- **入口层**（TUI 侧 `app/turn_memory.rs:102` 的 `build_memory_prompt_nonblocking`）：只在 fresh user turn 触发——`take_pending_memory` 取上轮结果 + `try_send` 投递新检查任务给常驻 actor。发送即返回，不 await
- **MemoryAgent**（`memory_agent.rs`）：常驻 tokio actor（`CONTEXT_CHANNEL_CAPACITY = 16` 的 mpsc），`process_context` 是单条 pipeline：embed → topic change 检测 → periodic extraction（后台 spawn）→ hybrid retrieval → cadence-gated rerank → 写入 `PENDING_MEMORY`
- **PENDING_MEMORY**（`memory/pending.rs`）：进程级 `static Mutex<Option<HashMap<session_id, PendingMemory>>>`，turn N 写 turn N+1 取。四重去重闸门：超 120s 视为 stale 丢弃；全部 id 已在 `INJECTED_MEMORY_IDS`（TTL 45 分钟）丢弃；prompt 签名 90s 内重复丢弃；与上次注入集合 overlap ≥ 0.8 且 180s 内丢弃

存储是 **JSON graph 而非向量库**：project（`~/.jcode/memory/projects/{hash}.json`）+ global（`global.json`）双 scope，全量内存计算——规模上限受多 MB JSON 与 O(n) cosine 扫描约束（这是刻意的取舍，个人编码 agent 的记忆量级下够用）。

---

## 调用链路

```
turn N 结束: App → update_context_sync (try_send, 非阻塞)
  → MemoryAgent::process_context() [memory_agent.rs:488]
       1. memory_runtime_active() 检查        LLM 不可达 → dormant 早退（不降级）
       2. embed context（spawn_blocking）
       3. topic change 检测（cosine < 0.3 → 提取上一段记忆）
       4. periodic extraction（每 12 turn 强制一次）
       5. find_similar_hybrid()               dense + BM25 + RRF 融合
       6. 过滤已 surface / 已注入
       7. cadence gate → rerank_candidates_consensus_attributed()
            sidecar 并发 votes 个独立 listwise rerank
            只保留票数 ≥ min_agree 的候选
       8. set_pending_memory(session_id, ...)
turn N+1: build_memory_prompt_nonblocking → take_pending_memory
  → 注入为尾部 user 消息（保 cache prefix）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `process_context()` in `memory_agent.rs:488` | 召回 pipeline 主体 | LLM 不可达早退 dormant，重新登录自动恢复 |
| `hybrid_fuse()` in `memory.rs:668` | dense+BM25+RRF 融合 | 无硬阈值——过滤交给 rerank |
| `bm25_rank()` in `memory.rs:1991` | Okapi BM25 稀疏半边 | K1=1.2, B=0.75 |
| `rerank_candidates_consensus_attributed()` in `memory_rerank.rs:249` | consensus rerank | 失败 judge 不投票 |
| `carry_verified()` in `memory_agent.rs:957` | 降级时保持 precision | `last_verified_ids` 交集，不降级到 hybrid 序 |
| `extract_from_context()` in `memory_agent.rs` | 记忆提取 | DUPLICATE_THRESHOLD=0.90 命中 reinforce 而非新建 |
| `cascade_retrieve()` in `jcode-memory-types/src/graph.rs:546` | 图 BFS 扩展 | 边衰减 `score * weight * 0.7^(depth+1)` |
| `effective_confidence()` in `jcode-memory-types/src/lib.rs:352` | 置信度衰减 | 按类别半衰期（Correction 365d … Fact 30d） |

</details>

---

## 核心实现

### Hybrid 检索：dense + BM25 + RRF

`find_similar_hybrid`（`memory.rs:642`）→ `hybrid_fuse`（`memory.rs:668`）：

- **Dense 半边**：`batch_cosine_similarity`（向量已 L2 归一直接点积）。**无硬阈值**——`memory.rs:641` 注释明说旧 dense-only 路径的 0.5 cosine floor 在真实 session 窗口上"基本什么都召不回"，hybrid 负责找回 recall，过滤交给 sidecar/rerank。**向量空间隔离**：`dense_eligible` 只含 `effective_embedding_model() == active_model` 的条目——换 embedding 模型后未重嵌的旧条目仍可经 BM25 + RRF 触达，不会消失
- **Sparse 半边**：`bm25_rank` 标准 Okapi BM25，doc 为 `entry.searchable_text()`（content+tags 小写规范化拼接）
- **RRF 融合**：`RRF_K = 60.0`，两份 ranked list 各按 `1/(60+rank+1)` 加权求和；pool = `(limit*5).max(50)`，即 dense/BM25 各取 top-50 进融合（live 路径 `EMBEDDING_MAX_HITS = 10`）

检索 query 用 **focused query**（最新用户意图，system-reminder/tool 噪声剥离），与 broad context 分开单独 embed——`memory_agent.rs:648` 注释：fusion 两半必须同一表示；topic-change 检测继续用 broad embedding。

### Consensus listwise rerank：为什么不用 cross-encoder

`memory_rerank.rs` 头注释给出了完整实验记录：本地 MS-MARCO cross-encoder 对"memory 语句"是 out-of-domain，在 noisy 多消息 context 上失效，**反而降低 recall**；listwise LLM rerank 喂 focused query + 全部候选一次调用，benchmark **recall@5 0.53 → 0.75，precision@5 0.23 → 0.35**。`build_rerank_prompt` 1-based 编号候选列表（query 截尾 4000 chars、单候选截头 600 chars），system prompt 要求"只回 JSON 数组，best-first，只含真正有用的"。

解析语义的关键区分：`extract_ranking` 返回 `None`（找不到 JSON array = 垃圾响应，**是失败**）vs `Some(vec![])`（真返回 `[]` = judge 裁定无关，**是真裁决**）——两者后续行为相反。**Consensus**：`rerank_candidates_consensus_attributed` 并发跑 `votes` 个独立 rerank（默认 2），`tally_consensus` 只保留票数 ≥ `min_agree`（默认 2）的候选——依据是离线 adjudication 显示单 judge precision ~0.77，2-of-2 一致时 ~1.0。失败 judge 不投票（"a blip cannot force-inject"）；transient 失败武装 30s 进程级 circuit breaker。

**Cadence gate**：`should_run_rerank`（`memory_agent.rs:317`）——session 首次 rerank 必触发、topic change 必触发、否则距上次 ≥ `memory_rerank_cadence`（默认 3）才触发。被 gate 的 turn 只重 surface 上次 consensus 验证过的记忆（`carry_verified` 取 `last_verified_ids` 与当前候选集的**交集**）——绝不降级到未审的 hybrid 序（那会注入低相似度 bloat）。

### 提取与记忆生命周期

**topic change**（`TOPIC_CHANGE_THRESHOLD = 0.3`，`memory_agent.rs:42`）：当前 broad embedding 与 session 内上一个的 cosine < 0.3 判定换题，触发对**上一段** context 的提取（若 `turns_since_extraction >= 4`）。注意 injected-memory 追踪刻意不清——真实 session 里连续 coding turn 常跌破阈值，旧注入仍在 transcript 里模型已知，靠 TTL 45 分钟自然过期。另有 `PERIODIC_EXTRACTION_INTERVAL = 12` 兜底（长单题 session）。

**MemoryEntry**（`jcode-memory-types/src/lib.rs:232`）：`category`（Fact/Preference/Entity/Correction/Custom）、`trust`、`strength`（reinforce 次数）、`superseded_by`、`reinforcements: Vec<Reinforcement>`（session_id+message_index+timestamp 溯源面包屑）。**confidence 衰减**按类别半衰期指数衰减：Correction 365d、Preference 90d、Entity 60d、Fact 30d；公式 `confidence * e^(-age/half_life*ln2) * (1+0.1*ln(access_count+1))`。**提取去重**：cosine ≥ 0.90 命中已有条目 → `entry.reinforce()`（strength+1 + breadcrumb），不新建。**矛盾消解**：`check_contradiction` LLM 判定 → 旧条目 `supersede(new_id)`（active=false + Contradicts 双向边）。**反馈回路**：verified +0.05 / rejected -0.02；每 250 次 maintenance `prune_low_confidence` 清 confidence < 0.15 且 age ≥ 24h。

**MemoryGraph**（`graph.rs:231`）：节点三类（memory/tag/cluster）+ 六种 `EdgeKind`（HasTag 0.8 / InCluster 0.6 / RelatesTo 自定义权重 / Supersedes 0.9 / Contradicts 0.3 / DerivedFrom 0.7）。`cascade_retrieve` 从 embedding 命中做 BFS，边衰减 `score * weight * 0.7^(depth+1)`，visited 防环。边来源：提取期共现记忆互连 `DerivedFrom`；post-retrieval co-relevant 建 `RelatesTo`（默认 0.6）；每 50 次 maintenance 把 co-relevant 集合归入 auto cluster（FNV-1a hash 保证 cluster id 跨运行稳定）。注入数量上限 `MAX_MEMORIES_PER_TURN = 5`（`memory_agent.rs:45`）——Mode-1 无 judge 时 `dynamic_gate_select` 输出 1..=5 条可变数量而非固定 5。

### 本地 embedding：纯 Rust 推理栈

`jcode-embedding/src/lib.rs`：all-MiniLM-L6-v2 ONNX（HF 自动下载到 `~/.jcode/models/`）+ **tract 0.23**（`tract-onnx`）+ HF `tokenizers`，384 维、MAX_SEQ_LENGTH 256、mean-pooling 后 L2 归一。**按需加载 + 空闲卸载**：`maybe_unload_if_idle()`（`embedding.rs:228`）在模型闲置一段时间后卸载并 `release_retained_heap("embedding_model_idle_unload")` 归还内存——87MB 模型不常驻，这是 "local embedding off" 模式 27.8 MB RSS（开启后 ~167 MB）的关键。工程亮点：`input_plan` 按**名字**绑定输入角色（input_ids/attention_mask/token_type_ids）和声明 dtype——不同 exporter 输入顺序不同（MiniLM input_ids 在前，e5/bge attention_mask 在前），为换模型通用化。选 tract 而非 ONNX Runtime 的可核实依据是依赖树纯 Rust（reqwest 用 rustls、tokenizers 只开 onig），无 C/C++ 原生动态库，静态打进 TUI 二进制跨平台分发无 linker 痛点；根 Cargo.toml 对 tract 在 dev profile 强制 opt-level 3（未优化时单次 embed ~666ms 会占住模型让 idle unloader 烧 CPU）。换 embedding 模型无需迁移：`MemoryEntry.embedding_model` 向量空间门控，旧条目走 BM25 路径。

### Synthetic Entry Provider：skill 也是记忆

`register_synthetic_entry_provider`（`memory.rs:80`）让上层 skill 模块注册回调，把 `SkillRegistry` 转为 synthetic `MemoryEntry` 参与检索——技能也像记忆一样被 embedding 检索自动注入对话。这反转了 `memory → skill` 的向上依赖（skill 层注册适配器，memory 层只认 `SyntheticEntryProvider` 函数指针），组合根在 `src/cli/startup.rs` 完成接线。

### 提取触发与收尾

三种提取触发：topic change（cosine < 0.3 且 ≥4 turn）、periodic（每 12 turn）、**session end**——`trigger_final_extraction()`（`memory_agent.rs:1897`）在会话结束时 fire-and-forget 全量 transcript 提取，已提取的内容不会因会话关闭而丢失。

### Sidecar

轻量 LLM 客户端（`sidecar.rs`）：优先级 Codex 凭据 → `gpt-5.6-luna`（reasoning=none）、Claude 凭据 → `claude-haiku-4-5-20251001`、任何 live provider fork、无凭据回落 Claude 报可操作错误。`memory_runtime_active()` = sidecar 模式开启 && `memory_llm_judge_available()`（`llm_backend_available()` 每次 live 重读凭据，登录状态变化免重启生效）——sidecar 开着但 LLM 不可达时 `process_context` 早退 dormant 而非降级到无 LLM 路径，重新登录自动恢复。

---

## 模块间交互

向上被 agent 的 `build_memory_prompt_nonblocking_shared` 消费（PENDING_MEMORY 全局交接）；工具层暴露 `memory` 工具（remember/recall/search/list/forget/tag/link/related）供主动操作；ambient 模式做 memory gardening（consolidate/去重/冲突消解——用 bash/read 验证后 forget 或 remember 修正）；`set_active_provider` 注册的 live provider 供 sidecar 复用（否则 Copilot/Gemini 等会静默降级）。offline benchmark（`memory_recall_bench` 二进制）与 live agent 共享 `memory_rerank` 模块——"single source of truth"，测量与线上行为一致。

---

## 扩展方式

**换 embedding 模型**（远程）：config `agents.memory_embedding_backend = "openai"` + `memory_embedding_model` / `base_url` / `dim`，无 key 静默回落本地。**调 rerank 策略**：`memory_rerank_cadence`（0/1 = 每 turn）、`memory_rerank_votes`/`min_agree`（双 judge 一致 vs 单 judge 快）、`RerankMode` Precision/Recall 切换在 `rerank_candidates_with_mode`。**关 sidecar**：`memory_sidecar_enabled = false` 走 Mode-1 `dynamic_gate_select`（GATE_REL_FLOOR=0.90/GATE_DROP_RATIO=0.95 的 score-relative 可变 k 门控）。
