---
source:
  type: "源码解读"
  project: "powercontext"
  url: "https://github.com/oceanbase/powercontext"
title: "Sources、Scope 与 Inference"
date: "2026-09-30T17:51:04+08:00"
category: [AI, Agent, "Memory & Context", PowerContext, CodeWiki, "1.2.0"]
contentType: "CodeWiki"
tags: ["PowerContext", "Python", "Protocol"]
description: "SDK 层三件套：Source 证据采集与版本化 Definition 注册表、Scope 工作域与三级 binding 解析、pydantic-ai 推理端口与 usage 归因。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Memory-&-Context/PowerContext/CodeWiki/1.2.0/00-overview)

---

## 模块定位

这三个模块是领域层的**输入面**：`sources/`（SDK 层，无存储）定义证据采集的契约——Source 值、adapter 协议、版本化 Definition 注册表、命名投影；`builtin/scope/` 定义工作域——`scope_id` 是全系统分区键（RFC 1345："The Scope-local Runtime continues to partition Sources, Artifacts in every family, and Statistics by scope_id"）；`builtin/inference/` 经 pydantic-ai 把 provider 细节压扁成两个可移植端口（`StructuredGenerator`/`EmbeddingModel`）。

三者共同体现 PowerContext 的一个核心立场：**证据与结论分离**（RFC 1400："an Artifact cites an exact SourceRef, never a moving SourceKey or latest observation"——Artifact 引用精确 SourceRef，永不引用会漂移的"最新"）。

## 模块架构

```
SourceAdapter Protocol（sources/adapters.py:26）
  input_class / name / source_class + resolve() / read()
        │ 实现
        ▼
SourceDefinition（= adapter 契约 + version + projections）
        │ 注册
        ▼
SourceDefinitionRegistry（definitions.py:95，不可变路由表）
  ├─ by_input / by_source / by_name 三索引 + 投影路由
  ├─ definition_for_source：版本闸门（source.definition_version != definition.version 即拒）
  └─ project(source, key)：TEXT_EVIDENCE_PROJECTION_KEY → TextEvidence
        │ 消费
        ▼
BUILTIN_SOURCE_REGISTRY（builtin/sources/__init__.py:64）
  = (CONTENT, EXTERNAL_SKILL_SNAPSHOT, SKILL_PACKAGE_UPLOAD, SKILL_USAGE)
        │
        ▼ journal 追加 + cursor 消费（memory/topic-memory/experience 后台处理器）

ScopeApplication（scope/application.py:56）
  ├─ create：idempotency_key + draft digest 幂等
  ├─ resolve_binding：explicit → binding keys → default 三级 fallback
  └─ discover：签名游标分页

PydanticAIStructuredGenerator（inference/pydantic_ai.py:126）
  └─ Agent(PromptedOutput(output_type)) + 双重限额 + 错误四分类
      包装 UsageReportingStructuredGenerator（usage 按 purpose 归因）
```

## 调用链路

### prompt capture → Source → journal → Memory flush

```
POST /v1/scopes/{scope_id}/sources/content（server/app.py:2783）
  → ScopedSourceApplication._capture（runtime/application.py:471-497）
     ├─ 有 record_service：records().capture_source(...) 直接写 journal
     │   → SourceReceipt(source_ref, sequence)
     └─ 兜底：ContentSourceAdapter.resolve（builtin/sources/content.py:89）
         → ContentSource(materialization=CAPTURED)
  幂等语义：同 (scope_id, source_type, source_id) 同 payload = 幂等返回；
  同 identity 不同 payload → SourceConflictError（RFC 1400：重放幂等、换内容冲突）

flush（消费侧）
  → SourceWindowTrigger.activate（triggers/source_window.py:47，纯策略无 IO）
     signal(SourceHighWatermark) + state(SourceCursor) → 新 state + ProcessSourceWindow{after, through}
     ——"窗口固定、有界、单调"
  → 窗口 entries 经 registry.project(source, TEXT_EVIDENCE_PROJECTION_KEY)
     投影为 TextEvidence → 喂 LLMMemoryCandidatePipeline / topic-memory / experience
  → 游标推进持久化（SourceCursorRepository）
```

**capture 不隐式生成 Memory**（RFC 0019："Source capture stores raw working material only"）：capture 是高频低成本的追加写（hook 每条事件都调），LLM 抽取是昂贵批处理——解耦让两者各自限流、窗口有界，且"没有新证据时不产生空结论"（flush 到 watermark 即返回 idle，不创建空 Memory）。

### scope binding 解析：host 侧组装，server 侧查表

服务端 `ScopeApplication.resolve_binding`（`scope/application.py:241`）三级 fallback：`explicit_scope_id` → 依序尝试每个 `ScopeBindingKey(integration, kind, external_id)` → `allow_default` 且有 `default_scope_id` → 否则 `ScopeBindingNotFoundError`。host 侧（以 claude-code 插件为例，`scripts/workspace_scope.py:195`）：`binding_keys = [session_binding_key(session_id), workspace_binding_key(cwd)]`——后者 `git rev-parse --show-toplevel` 取 repo 根、`external_id = sha256(repo_root)`。

**为什么 binding 由 host 解析而不是 server 推导**：工作域边界是 host（agent 会话）才知道的语义事实；server 从 cwd/Git remote 猜测会把"目录结构"错当成"工作边界"——RFC 1345 正是把早期自动推导废弃掉的修正案（"remove ID derivation from Git remotes and directories. A plugin first resolves an explicit or durable binding, then falls back to default_scope_id"）。

方法速查：

<details>
<summary>三模块关键方法速查表</summary>

| 方法 | 位置 | 一行职责 |
| --- | --- | --- |
| `resolve_binding` | `scope/application.py:241` | 三级 fallback 查表 |
| `_create` | `:95-117` | idempotency_key + digest 幂等创建 |
| `discover` | `:146-163` | 签名游标（rfc8785 + SHA-256）分页 |
| `activate` | `triggers/source_window.py:47` | 纯策略窗口转换 |
| `definition_for_source` | `sources/definitions.py:156` | 版本闸门 |
| `project` | `:180-203` | 命名投影（SourceObservation 短路） |
| `generate` | `inference/pydantic_ai.py:126-208` | 结构化生成 + 双重限额 |

</details>

## 核心实现

### Source 模型与 Definition 注册表

```python title="sources/models.py"
class SourceMaterialization(StrEnum):
    CAPTURED = "captured"      # 值已随 Source 物化存储
    REFERENCED = "referenced"  # 值留在原系统，Source 只存引用

class Source(BaseModel):
    name: str
    definition_version: str = "1"
    materialization: SourceMaterialization
```

`SourceDefinitionRegistry` 构造期用 `getattr` 逐项探测（Protocol structural typing + eager validation——`input_class` 是 type、`name` 是非空串、`resolve/read` callable），按 input_class/source_class/name/projection 四维查重冲突即抛。`definition_for_source` 是版本闸门：Source 跨版本持久化，路由"按稳定 definition name+version 而非具体 Python 类"——旧版本数据不被新代码静默误读。`resolve()` 在适配器返回后还做**精确类型校验**（`type(source) is not definition.source_class` 即抛 `InvalidSourceResultError`，`definitions.py:171`）——不接受子类替身，防止 duck typing 漏洞。字段校验统一 `_validate_reference_part`：拒绝首尾空白（不自动 strip），source_type 与 source_id 分别受 `MAX_SOURCE_TYPE_LENGTH`/`MAX_SOURCE_ID_LENGTH` 约束。

远程 worker 扩展：`sources/observations.py` 的 `SourceDefinitionManifest`（name/version/fingerprint + JSON schema + ≤16 个 projection manifest，拒绝 `$ref` 远程引用）允许外部 worker 声明式注册 Source 类型；`SourceObservation` 携带预计算 projections，`project` 对它直接短路。

### Scope：幂等是内容指纹而非覆盖

```python title="builtin/scope/application.py:317"
def _draft_digest(draft: ScopeDraft) -> str:
    return sha256(draft.model_dump_json(exclude={"idempotency_key"}).encode()).hexdigest()
```

`_create` 事务内先按 `idempotency_key` 查已有创建；命中则比对 digest——**不同即抛 `ScopeIdempotencyConflictError`**（同 key 携带不同内容是冲突而非覆盖）。为什么：客户端重试是常态，但"同 key 不同 payload"几乎必然是 bug 或攻击，宁可失败不可静默覆盖。`IntegrityError` 兜底分支处理并发唯一键竞态（回滚后读事务重查，"An unrelated integrity failure remains visible"——不吞无关错误）。`scope_id` 由 `generate_scope_id()`（`application.py:309`）生成：16 字节 `secrets.token_bytes` → Crockford base32（字母表 `"0123456789abcdefghjkmnpqrstvwxyz"`，刻意排除 i/l/o/u 易混淆字符）→ `scp_` 前缀的 128-bit 不透明 ID。

`SubjectSourceService`（`subject_sources.py:55-83`）是"首见 subject 自动建 Scope + 绑定"的原子路径（3 次重试 + IntegrityError 竞态兜底），支撑 RFC 1485 的画像场景：群聊 Scope 完整保留讨论，同时把单用户发言积累到独立 Scope——业务系统判断身份归属，PowerContext 只提供双写便利。

### Inference：可移植端口 + usage 归因

```python title="builtin/inference/protocols.py"
class StructuredGenerator(Protocol[InputT, OutputT]):
    async def generate(self, value: InputT, /) -> GenerationResult[OutputT]: ...

class EmbeddingModel(Protocol):
    profile: EmbeddingProfile
    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult: ...
```

`PydanticAIStructuredGenerator`（`pydantic_ai.py:126-208`）的四个关键行为：

1. **构造期校验**：model 必须是已构造的 `pydantic_ai.models.Model`（拒绝字符串）；`allow_continuations=False` 时用 `_CompleteResponseModel` 包装——拒绝 provider 的 separately-billed continuation（`response.state != "complete"` 即抛），防止多次计费请求被折叠。
2. **prompt 选择**：配了 `prompt_key` 时经 `current_prompt` 取 Scope 拥有的 prompt，用 `Agent.override(instructions=...)`（task-local——"concurrent Scopes never mutate a shared Agent"）；Agent 构造的 `retries` 取 `max_requests - 1`（重试预算与请求限额同源）。
3. **双重限额**：`UsageLimits(request_limit, output_tokens_limit)` + `asyncio.wait_for(timeout)`。
4. **错误四分类**（`_map_error`，`:371`）：timeout / unavailable（409/425/429/5xx，可重试类）/ configuration（其余 4xx，detail 只带 `HTTP {code}`——"never the raw provider response body"）/ invalid-output。**provider 响应体永不外泄**。

usage 归因（`inference/usage.py`）：`UsageReportingStructuredGenerator` 装饰器在成功后 `_report(GENERATION, usage)`；reporter 经 `bind_usage_reporter` 以 ContextVar 绑定当前 Scope 的 purpose（generation_purpose/embedding_purpose），嵌套调用自动归属。composition 为每个 family pipeline 包一层（memory 抽取/experience 孵化/skill 生成/handoff 生成/reranker）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Protocol + eager validation | `definitions.py:206-226` 的 getattr 探测 | 注册期即拒绝坏实现 |
| 不可变 Registry | `SourceDefinitionRegistry` 三索引 | 路由表构造后只读 |
| 纯策略 Trigger | `SourceWindowTrigger` 无 IO | 独立可测试 |
| 幂等指纹 | `_draft_digest` | 重试安全，冲突显式 |
| 原子 fallback 链 | `resolve_binding` 三级 | 顺序确定性 |
| 装饰器归因 | `UsageReporting*` | usage 计量不侵入业务 |
| WrapperModel | `_CompleteResponseModel` | 拒绝 continuation 计费折叠 |

## 模块间交互

**→ 各 family 处理器**：窗口 Source 经 `TEXT_EVIDENCE_PROJECTION_KEY` 统一投影为 `TextEvidence`（`content.py:108` docstring："Expose captured text without coupling consumers to ContentSource"——消费方不耦合具体 Source 类）。**→ inference**：composition 为七条 pipeline 分别构造 generator 并包 usage 层（见 [05-runtime](05-runtime)）；family 代码只看 Protocol，换 OpenAI/Anthropic/MiniMax 不动上层。**→ scope**：`scope_id` 分区一切；`ScopeDescriptor.context_references` 让 prepare_context 召回跨 scope 聚合。**→ HTTP**：`/v1/scope-bindings/resolve` 是 hook 链路的第一跳（见概览「核心运行流程」）。

## 扩展方式

**新增一种 Source 类型（外部系统事件 webhook）**：新建 `builtin/sources/external_event.py` 四件套（Capture input 含 source_id/payload/metadata、`ExternalEventSource(Source)` 按"值已抓取 or 仅引用"选 CAPTURED/REFERENCED、adapter、可选投影）→ `BUILTIN_SOURCE_REGISTRY` 元组追加（构造期自动查重）→ 需 REST 端点走 RFC 1437 流程 → 要被记忆抽取消费则定义投影到 `TEXT_EVIDENCE_PROJECTION_KEY`，memory 代码零改动 → 远程 worker 走 `SourceDefinitionManifest` 声明式注册。

**新增 scope 发现方式（IDE workspace 绑定）**：host 插件侧组装新 `ScopeBindingKey(integration="ide", kind="workspace", external_id=...)` 调 resolve 端点；首次失败后 create_scope（带 idempotency_key）再 PUT binding。**server 侧通常零改动**——fallback 链天然支持任意多 binding keys。只有需要服务端自动发现（如 SubjectSourceService 模式）才扩展 application 层。

**新增推理 provider**：实现两个 Protocol（参照 `inference/minimax.py` 的 MiniMax 适配）；`cli/config.py` 的 `generation_adapter/embedding_adapter` 选择表加一行。
