---
source:
  type: "源码解读"
  project: "powercontext"
  url: "https://github.com/oceanbase/powercontext"
title: "Topic Memory"
date: "2026-09-30T17:51:04+08:00"
category: [AI, Agent, "Memory & Context", PowerContext, CodeWiki, "1.2.0"]
contentType: "CodeWiki"
tags: ["PowerContext", "Agent Memory", "Python"]
description: "Topic Memory 家族：长期主题的渐进式披露、Probe→三路径生成→原子发布的后台流水线、opaque id 防幻觉与服务端操作控制。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Memory-&-Context/PowerContext/CodeWiki/1.2.0/00-overview)

---

## 模块定位

Topic Memory 解决 Memory 家族覆盖不了的内容形态：**长期主题**。RFC 1417 的例子很典型——"PowerContext 后台制品处理架构"这样一个主题需要把跨会话、跨任务的多条证据整理成持续演进的整体（标题/概要/详细正文）。拆成 Memory Entry 会丢失主题结构；每次加载完整正文又浪费 agent 上下文。Topic Memory 给出独立主题 identity，并把发现、判断与完整读取分开——**渐进式披露**。

它与 Memory 的第二重分野：Memory 的写入要么显式（`remember`）要么人工触发（`flush`），Topic Memory 是**唯一由服务端流水线自动发布的家族**（不经 Review Inbox），因此它的生成契约把"模型能决定什么"压缩到了最小。

## 模块架构

```
Source Journal ──cursor──> TopicMemoryWindowSelector（最大连续前缀 + token 估计）
                                │ 窗口 Source → 匿名 evidence（evidence_id）
                                ▼
                    _probe()（≤20 个检索探针，超限字符级二分切片）
                                │ probe → 检索现役 Topic Heads（hybrid）
                                ▼
                    三路径生成（_generate，topic_memory_processing.py:602）
                    ├─ 全局路径：窗口整体演进（≤20 topics）
                    ├─ 按 Work Item：探针恰好划分一次 → 逐 item 演进
                    └─ 临时降级：分批 temporary → 逐层归并 → 最终演进
                                │ proposal（content + evidence_ids + candidate_id）
                                ▼
                    _coordinate()（相关组协调，禁止合并历史身份）
                                │
                                ▼
                    _prepare_operations()（candidate_id → 精确 head，服务端决定 CREATE/UPDATE）
                                │
                                ▼
                    TopicMemoryAtomicPublisher.publish()（单事务原子发布）
```

编排器 `TopicMemoryProcessor.process()`（`runtime/topic_memory_processing.py:492`）是流水线骨架；生成器六阶段（probe/global/planner/evolve/temporary/reconciler）全部经 `StructuredGenerator` 端口注入（`:192-201`）——领域代码不知道 pydantic-ai 存在。

## 调用链路

```
process(assignment)（后台 worker 进程内）
  ├─ WindowSelector.select()（:268）  cursor 后最大连续前缀，真实 probe prompt 做 token 估计
  ├─ _probe()（:625）                 探针必须引用 evidence_ids（防编造）
  ├─ _history()（:775）               每个 probe hybrid 检索现役 heads → candidate-0001… 匿名映射
  ├─ _generate()（:602）              _global_targets_bind（成功 + candidate_id 绑定合法）
  │                                   判定通过走全局，否则回退 planner 三路径
  ├─ _coordinate()（:967）            词法签名 + 向量质心分组 → reconciler 协调
  ├─ _prepare_operations()（:1066）   candidate_id → PublishedTopicMemory 精确 head
  └─ publish()（:318-427）            单事务：fence 校验 → journal head 写锁 → cursor CAS
                                      → 逐字节重验窗口证据 → sources ⊆ 窗口校验
                                      → publish_create/publish_revision → cursor 前移
```

方法速查：

<details>
<summary>TopicMemoryProcessor 关键步骤速查</summary>

| 步骤 | 位置 | 关键设计决策 |
| --- | --- | --- |
| `select` | `topic_memory_processing.py:268` | 最小输入真实 prompt 估 token，而非假长度公式 |
| `_probe` | `:625` | 探针必须引用 evidence_ids；超限字符级二分切片保证据身份不丢字符 |
| `_history` | `:775` | 历史 Topic 只以 candidate_id 暴露给模型 |
| `_plan` | `:864` | 探针恰好划分一次（非法划分抛 `invalid_plan`） |
| `_compact_intermediates` | 归并中间产物 | temporary 逐层归并到 evolve 输入可容纳 |
| `publish` | `:318` | 冲突映射为 LEADERSHIP_LOST / CURSOR_CONFLICT / HEAD_CONFLICT 三种可重试结局 |

</details>

## 核心实现

### 渐进式披露与无身份 chunk

```python title="builtin/artifacts/topic_memory/models.py"
class TopicMemoryContent(BaseModel):
    """Progressively disclosed content for one durable topic."""
    title: TopicMemoryTitle          # ≤512
    summary: TopicMemorySummary      # ≤8_000
    detail: TopicMemoryDetail        # ≤125_000

class TopicMemoryChunk(BaseModel):
    """One rebuildable Markdown-aware search chunk without public identity."""
    ordinal: StrictInt
    start_offset: StrictInt
    end_offset: StrictInt
    policy_version: Literal["markdown-v1"] = "markdown-v1"
```

检索命中 `TopicMemorySearchHit` 只带 title+summary+480 字符 snippet（`fusion.py` 的 `_SNIPPET_MAX_CHARACTERS`）；agent 判断有必要再 `get_exact` 读完整 detail。chunk 是 detail 的**确定性可重建投影**而非独立制品——docstring 的 "without public identity" 是关键：换分块策略时按 `policy_version` 整体重建即可，不需要为每块维护不可变 Revision/lineage/审批身份。这与 Memory 家族每条 Entry 有身份形成有意的对照。

四检索通道（`topic_fts/topic_vector/detail_fts/detail_vector`）+ RRF 融合；chunk 数 ≤200 是为 sqlite-vec 的 KNN 邻居上限（k≤4096）设计（`chunking.py` 注释），超过上限时 `_bounded_window_spans` 退化为有界窗口切分兜底；尾块小于 `TOPIC_MEMORY_CHUNK_MIN_TAIL_CHARACTERS` 且合并后不超 `TOPIC_MEMORY_CHUNK_MAX_CHARACTERS` 时并入前一块。`TopicMemoryProjection.validate_projection`（`models.py`）强制投影不变量：chunk ordinal 连续、chunk 文本与 detail 的 offset 关系一致、`chunk_embeddings` 与 `embedding_profile` 配套。

### Opaque id 契约：模型只能建议内容

生成阶段的核心防幻觉机制（`topic_memory/generation.py:145-231`）——模型输入输出全部是 run-local 匿名 id：

```python title="builtin/artifacts/topic_memory/generation.py"
class TopicMemoryEvidence(...):       # 窗口 Source 的匿名投影
    evidence_id: str
    source_type: str
    content: str

class TopicMemoryHistoricalSlot(...): # 历史内容只以 candidate_id 暴露
    candidate_id: str
    title: str
    summary: str
    detail: str

class TopicMemoryProposal(...):       # 生成产物
    proposal_id: str | None
    candidate_id: str | None           # 绑定历史 topic 才非空
    content: TopicMemoryContent
    evidence_ids: tuple[str, ...]
```

**模型只提供 title/summary/detail/evidence_ids；操作类型与目标 Revision 全部由服务端控制**（`_prepare_operations` in `topic_memory_processing.py:1066`）：candidate_id 映射回 `PublishedTopicMemory` 精确 head——current 非空 ⇒ UPDATE 沿用 artifact_id（lineage 挂 current ref），为空 ⇒ 服务端 `id_factory()` 分配新 ID 即 CREATE。`TopicMemoryProposal.reject_content_identity_fields`（`generation.py:211-218`）直接拒绝 content 里混入身份字段，`_TopicMemoryStageModel` `extra="forbid"`。全局指令同时只允许模型用 opaque ids，reconciler 被禁止 "merging two historical identities"。

为什么这么紧：模型无法伪造 Artifact 身份、无法指定任意修订目标、无法声明"删除/合并"这类危险操作——发布事务用 cursor CAS + revision CAS 双保险，误操作在事务层就死掉。

### 原子发布与预算前置失败

`TopicMemoryAtomicPublisher.publish()`（`:318-427`）在单个事务内完成：lease fence 校验 → Source journal head 写锁冻结 → cursor CAS（generation 比对，不符抛 `GenerationConflictError` ⇒ CURSOR_CONFLICT）→ 逐字节重验窗口证据 → 每个 draft 引用的 sources ⊆ 窗口 → `publish_create`/`publish_revision` → cursor 前移。**NOOP 是合法结果**：evolver 输出 proposal=None 时该 work item 零操作，整个窗口 proposals 为空则零操作、cursor 照常前移——"没有值得保存的变化"不是错误。

预算设计（`BudgetedTopicMemoryGenerator`）：80/20 输入/输出预算，**在 provider I/O 之前抛错**；`validate_topic_memory_stage_capacity` 用真实固定 prompt + 最小合法输入验证部署可行——宁可启动期失败，不在处理中途烧钱烧到一半。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 渐进式披露 | `TopicMemoryContent` 三层 + snippet 检索 | 检索单元与读取单元分离，节省 agent 上下文 |
| 能力最小化 | opaque id 契约（`generation.py`） | 模型权限压到"建议内容"，身份/操作服务端独占 |
| 期望态 + CAS | publish 的 cursor/revision 双 CAS | 多副本并发下旧世界观写入被事务拒绝 |
| 预算前置失败 | `BudgetedTopicMemoryGenerator` | 贵重 I/O 前验证部署可行 |

## 模块间交互

**Source Journal**：以 `TOPIC_MEMORY_SOURCE_WINDOW_BINDING` cursor 消费连续前缀，发布事务内锁 `SOURCE_JOURNAL_HEADS_TABLE` 冻结捕获并逐字节重验（`:354-391`）——窗口证据在处理期间被新增 Source 推移也不会产生错误引用。**Supervisor**：worker 契约把冲突翻译成 `ArtifactProcessingWorkerOutcome`（CURSOR_CONFLICT/HEAD_CONFLICT/LEADERSHIP_LOST）供 supervisor 安全重试（lease/fence 契约见 [05-runtime](05-runtime)）。**Inference**：六阶段生成器全走 `StructuredGenerator` 端口；embedding 复用 memory 家族的 `EmbeddingProfile`。**prepare_context**：`ScopedContextApplication` 召回时 topic 候选上限 8、entry 上限 8。

## 扩展方式

**换分块策略**（如 `markdown-v2`）：改 `chunking.py` 新增 policy_version + `TopicMemoryChunk.policy_version` Literal + 存储层按 policy_version 重建投影。搜索侧零改动——chunk 无公开身份、投影可重建，这正是该设计直接受益的场景。

**新增生成路径**（如按文件分组）：在 `_generate` 的路径选择处加分支，复用 `ScopeInvocation` 的 guard/complete 契约；三路径的选择逻辑集中在 `:602-623`，注意全局路径成功且 candidate_id 绑定合法即采纳的短路语义。

**提升披露层数**（如加 outline 层）：`TopicMemoryContent` 加字段 + 检索投影 `TopicMemoryProjection` 加对应可搜索文本 + `fusion.py` 通道扩展——四通道结构是开放的，RRF 融合对通道数无假设。
