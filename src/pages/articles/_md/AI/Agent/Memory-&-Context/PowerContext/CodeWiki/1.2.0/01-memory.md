---
source:
  type: "源码解读"
  project: "powercontext"
  url: "https://github.com/oceanbase/powercontext"
title: "Memory 家族"
date: "2026-09-30T17:51:04+08:00"
category: [AI, Agent, "Memory & Context", PowerContext, CodeWiki, "1.2.0"]
contentType: "CodeWiki"
tags: ["PowerContext", "Agent Memory", "Python"]
description: "Memory Artifact Family：一 Scope 一份记忆制品，Entry 版本链与三元组 citation、四模式检索与 RRF 融合、写入门控 HOLD 语义、plan/apply 事务分离。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Memory-&-Context/PowerContext/CodeWiki/1.2.0/00-overview)

---

## 模块定位

Memory 是 PowerContext 最核心的 Artifact 家族：**一个 Scope 恰好一份 Memory Artifact**（`memory_artifact_id` 固定绑定），保存"后续任务需要复用的事实、偏好、决定、约束和进度"。它解决的问题在 RFC 0014 里说得很直白——目标不是让 agent 记住更多，而是让共同推进的工作更容易被接手。

模块边界：`builtin/artifacts/memory/`（模型 + 编排 + 纯函数支撑，`service.py` 1945 行是核心）负责领域规则；`builtin/persistence/memory.py` + `memory_index.py` 是它的存储端口实现；runtime 侧的 `ScopedMemoryApplication`（`runtime/application.py:2379`）是 scope 门面。本文三者都覆盖。

## 模块架构

内部是一个教科书式的 Ports & Adapters 结构——`MemoryService` 是纯编排核心，五个 Protocol 端口全部可注入替换：

```
ScopedMemoryApplication（runtime 门面）
        │ remember / search / expand / flush / capacity
        ▼
MemoryService（service.py，编排 + 校验）
        │ 五个端口（protocols.py）
        ├─ MemoryBackend        → RelationalMemoryBackend（persistence/memory.py）
        │                          └─ MemoryIndex（FTS+Vector 投影）
        ├─ CandidatePipeline    → LLMMemoryCandidatePipeline（extract 模式抽取）
        ├─ MemoryWriteGate      → DecisionMemoryWriteGate（证据充分性门控）
        ├─ MemoryReranker       → LLMMemoryReranker（listwise 重排）
        └─ MemoryUnitOfWork     → 一次原子提交的边界
```

这样划分的原因：领域编排**零 import SQLAlchemy**——换后端、换 LLM、换门控策略都不碰 `service.py`；而"校验全部集中在服务层"意味着 LLM 产出（Candidate）永远过不了未经校验的路径。

## 调用链路

```
remember（显式写入，application.py:2386）
  → _context(scope_id, embedding_purpose=MEMORY_INDEXING) + _locked(scope_id)
  → _head_or_none → _validate_expected_revision（乐观并发第一道）
  → MemoryService.plan_remember（service.py:495）
       1. _select_remember_mode（:1786）auto→append/extract/no-work
       2. _canonical_base（:1285）base==存储版本==head，否则 RevisionConflictError
       3. _candidates（:1344）extract 走 CandidatePipeline.extract
       4. _assess_write（:1366）write_gate.assess（异常→ACCEPT+used_fallback）
       5. verdict 分流：HOLD→plan(result=base,commit=None)
                        FLAG→提交但 reason 填充
                        ACCEPT→_prepare_commit（:1482）→ MemoryCommit
  → _raise_if_write_held（:1818）HOLD 转 MemoryWriteRejectedError(code, reason)
  → MemoryService.apply（:560）backend.begin() → uow.commit(plan.commit)
```

方法速查（`<details>` 折叠）：

<details>
<summary>MemoryService 方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `plan_remember` in `service.py:495` | 产出无副作用的写计划 | plan/apply 分离，昂贵工作事务外做完 |
| `apply` in `service.py:560` | 经 UnitOfWork 原子提交 | 计划可并入外层大事务（flush 就这么用） |
| `search` in `service.py:671` | 四模式检索 + 融合 + 重排 | 显式 head 前后双校验，检索投影可丢弃但锚必须准 |
| `expand` in `service.py:874` | 按三元组精确取正文 | `_validate_anchor` 双向 hash 校验拒跨 Revision 顶替 |
| `flush`（runtime 层 `application.py:2585`） | Source 窗口批量 extract 写入 | 游标 CAS + 事务二段式，`held_count` 上报 |
| `compact` in `service.py:410` | 清理老化 tombstone 指针 | 只删指针保留全部历史 Revision 和正文 |
| `capacity` in `service.py:334` | 读三维容量 | 只罚增长：已超限仍可 revise/deactivate |

</details>

## 核心实现

### 不可变三件套：Artifact / Manifest / EntryVersion

```python title="builtin/artifacts/memory/models.py"
class MemoryManifestEntry(BaseModel):        # Revision 目录中的逻辑指针
    entry_id: str
    entry_version_id: str
    entry_content_hash: str
    state: MemoryEntryState                 # Literal["active", "inactive"]

class MemoryContent(BaseModel):              # Revision 完整内容 = 目录 + 变更记录
    manifest: MemoryManifest
    changes: tuple[MemoryChange, ...] = ()   # op: add/revise/deactivate/reactivate/compact
    schema_version: Literal["powercontext.memory.v1"]

class MemoryEntryVersion(BaseModel):         # 逻辑 entry 的一个不可变正文版本
    memory_artifact_id: str
    entry_id: str
    entry_version_id: str
    version: int
    previous_version_id: str | None          # 单链表式版本历史
    kind: str
    text: str
    entry_content_hash: str
    created_in_revision: int
```

**为什么 Memory 是 Artifact 而不是表**（`Memory(Artifact[MemoryContent])` in `models.py:110`）：Revision 是不可变整快照，正文永不删除、永不原地更新——deactivate 只改 manifest 指针的 `state`，compact 只删老化指针。红利：(a) 任何 `ArtifactRef` 永久可解析；(b) citation 无需 TTL 即可审计（`expand` 重验 hash）；(c) 复用共享 Artifact CAS/lineage/tags 基建。

**entry identity / version / state 三分**的动机：`entry_id`（逻辑主题，跨 Revision 稳定）→ `entry_version_id`（一次不可变正文，`previous_version_id` 链）→ `state`（属于 Revision 目录而非正文）。revise 换指针不换历史（`_claim_revision_target` in `service.py:1607` 强制精确命中当前版本，否则 `entry-mismatch`），所以"删除"可逆、版本链完整可审计。

### 三元组 citation 与检索的诚实性

```python title="artifacts/models.py:58"
class MemoryCitation(BaseModel):
    """An exact entry version anchored in its owning Memory Revision."""
    memory_ref: ArtifactRef      # 哪个 Revision 的 manifest
    entry_id: str                # 目录与正文的交叉验证键
    entry_version_id: str        # 哪个正文行
```

三元缺一不可的原因（`_validate_anchor` in `service.py:1136`）：`memory_ref` 给目录、`entry_version_id` 给正文，`entry_id` 则是"目录与正文必须互相归属"的交叉验证键——同时校验 manifest 指针、`version.memory_artifact_id`、`version.entry_id`、双向 `content_hash`。两元组发现不了"正文行被搬到另一个 entry 名下"的错位。

检索链路（`search` in `service.py:671`）四模式（`MemorySearchMode = Literal["fts","vector","hybrid","auto"]`）：

- **auto 的诚实降级**（`_select_search_mode` in `service.py:936`）：hybrid 可用→hybrid，否则 fts；embedding 失败时仅 auto 降级 fts 且如实计 `embedding_calls=1`（"the cost is real even though it produced nothing"）
- **融合**（`fuse_rankings` in `fusion.py:57`）：RRF（k=60），通道身份是 `(artifact_id, revision, entry_id, entry_version_id)` 四元组——含 revision 天然防跨 Revision 合并
- **query 向量复用**（`_resolve_query_vector` in `service.py:782`）：传入的 `MemoryQueryEmbedding` 与当前索引 profile 相等即复用（`embedding_calls=0`），否则新算（=1）；`MemoryQueryEmbedding` 携带 profile 就是为了防跨 profile 复用向量
- **head 前后双校验**（`_validate_search_heads` in `service.py:929` + `persistence/memory.py:331`）：索引行按 artifact_id 组织、不随每次 Revision 重刷版本戳，head 前后不变才保证返回行属于请求的 ref
- **计账不泄漏**：`MemorySearchResult` 的 admission/embedding_calls/generation_calls 字段全部 `exclude=True`，防 gate 工件泄漏进 HTTP 响应

### 写入门控：HOLD 语义与 fail-open

门控是 1.2.0 的新特性（`feat(memory): gate writes on decision-model evidence sufficiency`），设计在 `memory_write_gate.py`：

```python title="builtin/runtime/memory_write_gate.py"
class MemoryWriteVerdict(StrEnum):
    ACCEPT / FLAG / HOLD

class MemoryWriteAssessment(BaseModel):
    """docstring: a refused write is visible to its caller, never silently dropped."""
    verdict: MemoryWriteVerdict
    policy_id: str
    code: MemoryWriteRejectionCode | None   # NEEDS_EVIDENCE / EVIDENCE_LIMIT_EXCEEDED / INSUFFICIENT_COVERAGE
    reason: str | None
    used_fallback: bool
```

三个关键语义：

1. **fail-open 三层防线**：`_fail_open_decision_model` 把 DecisionModel 包成超时/异常降级为中性裁决；gate 配置了但 backend 缺失只 log warning 返回 None 写穿透（与 decision role 相反——后者 enabled 无 backend 直接 `BuiltinConfigurationError`，`composition.py:317`）；`used_fallback` 或 ABSTAIN 映射为 ACCEPT。设计理由写在 docstring："a misconfigured gate can never block Memory writes"。
2. **HOLD 是可见拒绝**：plan 层 HOLD = 无 commit 但带 decision；`remember` 直调转 `MemoryWriteRejectedError`（结构化 code），flush 路径转 `held_count/hold_codes` 计入 `MemoryFlushResult`——两条路径都绝不静默丢弃。
3. **阈值校准与证据预算**：`hold_on` 方向由配置指定但置信阈值默认 None（"a hold never depends on a made-up number"，需校准探针确立）；评估证据超限（>32 项 / >4000 字符）反而 HOLD（`memory_write_gate.py:106`）——防超宽 citation set 被静默放行。低于阈值的 hold 降级 FLAG（写入但标注不确定）。

### plan/apply 与三层 CAS

```python title="builtin/artifacts/memory/protocols.py"
class MemoryWritePlan(BaseModel):
    """无副作用结果，可在外层事务提交"""
    result: Memory | None
    commit: MemoryCommit | None      # 一个完整 Revision + 全部行
    decision: MemoryWriteAssessment | None
```

plan/apply 分离让 flush 场景把"记忆提交 + 游标前移 + processing 状态"放进**同一个事务**。乐观并发三层：服务层计划期（`_canonical_base`，base ≠ head 即 `RevisionConflictError`）、提交期（`_validate_commit` in `persistence/memory.py:600`，revision 连续性 + content_hash + **projection 覆盖 active entry 集合的全等校验**——投影行与权威目录不一致直接拒绝提交；底层共享 Artifact 仓储的 revision CAS 与 tag 替换同锁；含 compact 操作时额外 `for_update` 重读 tagged entry，冲突则整个事务回滚避免悬挂 tag）、读期（search 前后双校验）。

配套的容量契约：`MemoryCapacityBudget` 三维默认 `max_active_entries=5_000 / max_manifest_entries=10_000 / max_manifest_bytes=4 MiB`（validator 强制 active ≤ manifest 的层级顺序）。compact 的老化判定按 `MemoryCompactionPolicy.min_tombstone_revisions` 窗口排除仍被引用的 entry；策略未启用时 `dry_run=True` 只返回 `MemoryCompactionResult`（含 `reclaimed_bytes` 估计），`dry_run=False` 直接抛 `CapabilityNotSupportedError`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Null Object | `NoMemoryIndex` in `persistence/memory_index.py:121` | 诚实暴露"无检索能力"，search 抛异常而非假空结果 |
| Composite | `CompositeMemoryIndex` in `memory_index.py:189` | hybrid = fts ∧ vector，vector_complete 需全部向量索引完备 |
| Write-through 投影缓存 | `_previous_projection_cache` in `service.py:1191` | Revision 不可变 ⇒ hit 永远对该 ref 有效，缓存一致性可自检 |
| Strategy | `MemoryExtractionProfile` in `prompts.py:20` | coding/conversation 两套版本化抽取指令，指令本身是 Artifact |

## 模块间交互

**上游**：`ScopedContextApplication._recall_round` 调 `MemoryService.search`（limit=16）做 prepare_context 召回；`flush` 挂接 source journal 游标触发器。**下游**：`RelationalMemoryBackend` 复用共享 `ArtifactRepository` 存 Revision 本体 + 两张自有表（`MEMORY_ENTRY_VERSIONS_TABLE` 不可变正文、`MEMORY_ENTRY_HEADS_TABLE` active-head 检索投影）；索引经 `MemoryIndex` 协议的 `tables` 属性参与 DDL、upsert/delete 与写同事务（投影一致性见 [06-persistence](06-persistence)）。**横向**：`MemoryCitation` 定义在顶层 `artifacts/models.py` 供 Experience/Handoff 跨家族引用；embedding 经 `inference` 端口（写时失败静默降级为无向量投影）；`EmbeddingProfile`（`memory_index` 强制 unit-L2）跨部署不可混用——`MemoryQueryEmbedding` 携带 profile 就是为了防跨 profile 复用向量。

## 扩展方式

**新增搜索模式**（如 bm25→graph）：`MemorySearchMode`/`MemoryUsedSearchMode` 加字面量 → `MemoryCapabilities` 加能力位 → `_select_search_mode` 加分支 → 实现 `MemoryIndex` 返回该通道 hits。fusion/rerank 层零改动——`fuse_rankings` 对通道数无假设。

**新增 capacity dimension**：`MemoryCapacityDimension` 加字面量 → `MemoryCapacityBudget` 加字段与 validator → `_capacity_values/_capacity_limits`（`service.py:361`）各加一行；`_require_capacity` 的 growth 集合自动覆盖。注意"只罚增长"（`_require_capacity` in `service.py:371` 只在超上次且超限时抛错）避免把已超限 Memory 锁死。

**新增 extraction profile**（如 meeting-notes）：`MemoryExtractionProfile` 加枚举值 + 带版本号的 INSTRUCTIONS（`powercontext.memory.extract.meeting.v1`）注册进 `_INSTRUCTIONS_BY_PROFILE`；版本字符串随 lineage 进入每个 Revision，可审计"当年用哪版指令抽取"。
