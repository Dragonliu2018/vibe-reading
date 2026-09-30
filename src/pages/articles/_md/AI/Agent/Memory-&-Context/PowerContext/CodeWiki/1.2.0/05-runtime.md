---
source:
  type: "源码解读"
  project: "powercontext"
  url: "https://github.com/oceanbase/powercontext"
title: "Runtime 与后台调度"
date: "2026-09-30T17:51:04+08:00"
category: [AI, Agent, "Memory & Context", PowerContext, CodeWiki, "1.2.0"]
contentType: "CodeWiki"
tags: ["PowerContext", "Python", "AsyncIO"]
description: "BuiltinRuntime 组合根：open_builtin_runtime 装配链、18 个 Application 门面、prepare_context 召回充分性闸门、ArtifactProcessingSupervisor 的 lease/fence 调度与 code 索引。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Memory-&-Context/PowerContext/CodeWiki/1.2.0/00-overview)

---

## 模块定位

`builtin/runtime/`（30 文件 ~17.5k 行）是全系统的**装配与编排中枢**：`composition.py` 的 `open_builtin_runtime` 是唯一组合根（数据库、推理适配器、七家族 service、后台 supervisor 全在这一个 asynccontextmanager 里装配）；`application.py`（3603 行）定义 `BuiltinRuntime` 和 18 个 `*Application` 门面；`prepared_context.py` + `recall_sufficiency.py` 实现 prepare_context 的召回闸门；`scheduler.py` + `artifact_processing.py` 承担后台调度。

本模块还覆盖两块支撑件：`builtin/code/`（tree-sitter 代码证据索引）与 `ArtifactProcessingSupervisor` 的完整契约——它们没有独立成文是因为其设计动机全部锚定在 runtime 的装配与调度语境里。

## 模块架构

```
open_builtin_runtime（composition.py:357，@asynccontextmanager）
  │ AsyncExitStack 按序装配，异常时 LIFO 回收
  ├─ 1. _generation_pipelines → 7 条 pydantic-ai 管线（显式注入优先）
  ├─ 2. decision model 恒 fail-open 包装（FailOpenDecisionModel + Tracing）
  ├─ 3. open_builtin_contexts → SQLite/OceanBase/SeekDB 三分支
  │      └─ RelationalContexts（PowerContextProvider 实现）
  ├─ 4. readiness probes（database.ping + 4 个非阻塞 inference probe）
  ├─ 5. _artifact_processing_bindings → 5 family 后台绑定
  │      └─ _open_artifact_processing_supervisor（global/dedicated 两模式）
  └─ 6. BuiltinRuntime(...) → 挂载 18 个 Application 门面
         │ 生命周期原语
         ├─ _operation()：全局操作计数 + close() 排空
         ├─ _scope_operation(id)：+ scope 注册校验 + ScopeCache 租约
         ├─ _context(id)：+ generation 信号量 + usage 绑定 → PowerContext
         └─ _locked(id)：写路径串行化（ScopeCache 每 scope 一把锁）
```

`BuiltinRuntime.__init__` 接收 70+ 关键字参数（`application.py:2975-3124`），但构造体几乎全是赋值——**根只做三件事**：持有依赖、提供生命周期原语、挂载门面。18 个门面（`sources/ingestion/code/context/experience/dream/external_skills/handoff/work/memory/topic_memory/records/prompts/review/skill/remote_skills/statistics` + 后挂的 `handoff_report/artifact_processing_supervisor/processor`）每个遵循统一模式：非 scoped 根类 + `for_scope(scope_id)` 视图。

## 调用链路

### prepare_context：召回充分性闸门 + 有界扩展

```
ScopedContextApplication.prepare（application.py:831）
  → 校验 assembly 总 limit ≤ context_assembly_max_entries(8)
  → assembly.sections 为空且不 include_code → 直接返回空 PreparedContext（快速路径）
  → _scope_operation + authorize_scopes（当前 scope + context_references）
  → _prepare_build（:887）：
      1. families = assembly 指定 或 默认 {memory, experience, topic-memory}
      2. scope_ids = [当前 scope, *scope.context_references]
      3. round_zero = _recall_round（admission=None = 历史默认阈值，
         与未开 gate 逐字节相同——recall_sufficiency.py:165 的回归保证）
      4. gate.assess（纯函数："No I/O, no clock, no model"）
         信号：candidate_count / family_count / top_score / top_gap / lexical_overlap
         短路顺序：无内容→sufficient；budget_bounded→sufficient（Builder 自己跑一遍
         纯 fitting 的 probe_budget，区分"预算受限的薄"与"召回受限的薄"）；
         rerank 开启且不允许扩展→sufficient
      5. while 不充分 and families_recoverable>0 and len(expansions)<policy.max_rounds(2)：
         RecallExpander.plan：round 1 = ("admission", 0.15)，round 2 = ("policy-floor", 0.10)
         候选只增不减（seen-identity 去重）；embedding reuse cache（round 0 已付费的
         query 向量按 scope 缓存，扩展轮不再 re-embed）
      6. 任何异常降级回 round_zero 候选集，trace 记 expansion-failed
         ——"the gate can never turn a successful prepare into a failure"
      7. include_code → _code_candidates（CodeError 吞掉返回空）
      8. builder.build_scopes_result 一次性应用 family ceilings
  → RecallEffort trace 不是 build 的字段——_prepare 只返回 build.context，字段无处
    可观测，故经 _recall_effort_sink 旁路投递（失败仅 log）；RecallEffort.rounds
    = 已执行的搜索轮数（round 0 + 提交的扩展轮）
```

RFC 1560 的三条安全性质在代码里都有锚点：**扩展不可能破坏 Builder 不变量**（跨轮并集沿既有分配器重选，`prepared_context.py:164-169` 的上限不变）；**不扩展的运行与今天逐字节相同**（`admission=None` 路径）；**交付体积永不越过 max_bytes**（扩展只能用 round 0 未用满的预算）。

方法速查：

<details>
<summary>Runtime 关键方法速查表</summary>

| 方法 | 位置 | 一行职责 |
| --- | --- | --- |
| `open_builtin_runtime` | `composition.py:357` | 组合根：全资源 AsyncExitStack 装配 |
| `open_builtin_contexts` | `composition.py:857` | 三后端分派 + schema bootstrap |
| `prepare` | `application.py:831` | 召回入口（校验 + 鉴权 + 委托） |
| `_prepare_build` | `:887` | 闸门 + 扩展轮 + build |
| `_gated_recall_effort` | `:1049` | 有界扩展循环（候选只增不减） |
| `start_scheduler` | `:3166` | APScheduler 侧车绑定（见下文注意项） |
| `close` | `:3261` | 排空在飞操作，不关 provider |
| `_run` | `artifact_processing.py:530` | supervisor 主循环 |

</details>

### Supervisor 主循环：lease → 发现 → 派发 → fence

```
_run()（artifact_processing.py:530-562）
  while not stop:
    if lease_lost: _lose_leadership()
    if fence is None: _acquire()        # SQLite: start_single_process_term
    if fence is not None: _cycle()      #        OceanBase: try_acquire 持久租约
                                         #        + _renew 每 lease_seconds/3 续约
    等待 _wake 或 _next_wake_seconds 超时

_cycle()（:605）按 rotation 轮转 family（"Reserve fresh admission before retries"）
  ├─ 发现：SourceProcessingPendingProvider.reconcile（processing_discovery.py:63）
  │        分页扫 SOURCE_JOURNAL_HEADS，journal head > cursor ⇒ intents.mark_dirty
  ├─ 派发（:843-868）：事务内 require_fence + intents.load(for_update=True)，
  │        requested_generation > handled_generation 才构造 assignment（带冻结的 fence）
  │        → asyncio.create_task(_execute(...))，受 binding.max_workers 并发预算
  ├─ 完成（:946）：_verify_acknowledgement 事务内 require_fence + durable ack 检查
  │        ——"A successful process exit is not a successful invocation"
  └─ 失败重试：指数退避 min(cap, base·2^failures) × uniform(0.8,1.2) 抖动
```

worker 侧契约（`ScopeInvocation` in `processing_execution.py:39`）：构造即校验 fence 归属（只接受 `global` 或 `artifact:{自家family}`——**fence 永不跨 family 借用**）；`guard()`（fence + intent FOR UPDATE + 幂等检查）、`start()`（记录 dirty_generation）、`complete(remaining_work=...)`（`intents.acknowledge`，`clean_generation` 不超过 `dirty_generation`——"cannot acknowledge unseen domain work"）。

## 核心实现

### 为什么 18 个门面而不是 god class

`application.py` 3603 行按 family 线性分节（Source 464-670、Context 824-1660、Memory 2379+、BuiltinRuntime 2972+…）。每个门面独立演进（skill 有 8 个依赖注入点），改 Memory 不碰 Skill 区；根上的方法（`capabilities/readiness/close/_operation`）全是横切生命周期，与业务门面正交。**文件长但耦合面窄**——这与 god class 的区别不在行数在耦合。

### composition 为什么用 asynccontextmanager

装配要打开的外部资源横跨多层（HTTP client、数据库连接、子进程 supervisor、FTS schema 事务），`AsyncExitStack` 保证异常时已开资源按 LIFO 回收；`yield runtime` 让调用方（factory lifespan / CLI）把 runtime 的存活期绑定到自己的栈——**所有权随控制流走**而不是藏在对象里。构造函数做不到"半装配失败自动回滚"。`PowerContextProvider` 的 docstring（`protocols.py:69` "without transferring lifecycle ownership"）是契约的另一半：`BuiltinRuntime.close` 只 drain 操作（`application.py:3261` 注释 "await in-flight operations without closing the provider"），数据库由 contexts 的栈所有。

### ScopeCache：租约 + LRU + 在飞不驱逐

`_operation()` 按 `asyncio.current_task()` 维护 `_operation_depths`——**同任务嵌套只计一次**（depth==0 时检查 `_closing/_closed` 拒绝新操作）；`close()` 在 `_lifecycle` Condition 上 `wait_for(active_operations == 0)`，排空后新操作一律拒绝。`_scope_cache.py:45-140`：有界 LRU，条目为 `_ScopeEntry(lock, leases)`——每个 scope 一把串行锁 + 租约计数。`lease()` 租约 +1 并 touch；`lock()` 只在当前任务持有租约时可取（供 `_locked()` 写串行化）；驱逐只挑 `leases == 0` 的最旧条目，**在飞操作永不驱逐**（全员活跃时缓存临时超容，租约退出后收缩）；evictor 回调同步清理 `RelationalContexts` 侧缓存。`counts` 只暴露低基数聚合（cached/active）——观测面按 RFC 0028 收敛到不泄露证据的粒度。

### 调度器：APScheduler 侧车与 supervisor 的关系

`scheduler.py` 用独立 SQLite job store（`powercontext_scheduler_jobs` 表）+ 模块级 `_processors` 注册表：持久化 job 只存函数引用 + `runtime_key`（scheduler db 绝对路径，同一文件同一进程只允许一个 scheduled runtime，防双写），触发时经注册表路由回当前进程。**注意**：`BuiltinRuntime.start_scheduler` 在 `src/` 内无生产调用方（仅测试）——生产路径的周期处理走 `ArtifactProcessingSupervisor`：不用 APScheduler 执行，而是自己从 checkpoint 计算 deadline（interval 直加、cron 二分搜索补齐错过的触发），spawn 子进程 worker。APScheduler 侧车是单进程/独立模式的备用路径（代码事实，未见文档佐证——待核实）。

### 为什么迟到 worker 的提交要被 fence 拒绝

场景：OceanBase 租约到期（时钟漂移/网络分区/GC 停顿），旧 leader 及其 in-flight worker 未死，新 leader 已当选并可能已对同一 scope 派发新 worker。若旧 worker 的 `intents.acknowledge` 仍被接受，就产生**双重处理 + lost-update**。机制：assignment 派发时冻结当时的 fence（`artifact_processing.py:857`）；worker 的每个 DB 事务和 supervisor 侧的 durable ack 校验都执行 `require_fence(connection, fence)`；而 `_lose_leadership()`（`:1020-1038`）在丢领导权时撤销租约并显式 `supervisor_generation + 1`，使旧代 worker 的提交在校验层直接失败——经典 fencing token（单调代数）模式。补充防线：worker 正常退出也不算数，必须 DB 中 `handled_generation >= claimed_request_generation`。

global vs dedicated 两模式（构造器强制合法拓扑，`artifact_processing.py:440-443`）：global 一次选主管全部 family（family 间共享一个 lease 但保留各自独立的 max_workers/retry/ready），适合单进程部署省掉 N 次租约竞争；dedicated 每 family 独立 lease（组名必须 `artifact:{family}`），实现故障与运维隔离。**选 dedicated 无需改任何 worker 代码**——`ScopeInvocation` 两种组名都接受。

### code 索引：本地可重建缓存

`CodeService`（`builtin/code/service.py:56`）docstring 定调："Own a local rebuildable index"。索引是 `(仓库内容, 抽取策略, 工具版本)` 的纯函数——`_fingerprint`（`:199-209`）把 `parser_builds()/RESOLVER_BUILDS/SCHEMA_VERSION` 全部纳入指纹，升级 tree-sitter 自动作废旧代无需迁移。权威真源始终是 git 工作区（manifest 记录 commit/dirty）；缓存默认 `~/.cache/powercontext/code` 且禁止落在仓库内部。安全侧：`PythonExtractor` docstring "Extract syntax without importing or evaluating repository modules"、`parser_for` "never download or execute repository code"——**绝不执行被索引仓库的代码**。查询前 `_verify()` 重新 capture 比对，宁可 409 `code_changed` 也不静默供陈旧证据；`expected_fingerprint` 供调用方 CAS。`_fit_source` 对行数二分以塞进 max_bytes。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| asynccontextmanager 资源栈 | composition 全部 open* 函数 | 所有权随控制流，半装配失败自动回滚 |
| 三层 scoped operation | `application.py:3289-3399` | 操作计数 → scope 租约 → generation 信号量渐进叠加 |
| 租约 + fencing token | `supervision.py:122-183` | 多副本安全，迟到提交事务层被拒 |
| dirty set + cursor | `processing_discovery.py` + `processing_intents.py` 四代数 | 恢复不需要 Job 历史，DB 状态是唯一真源 |
| 可重建缓存 + 指纹 | `code/service.py` | 工具版本变更自动失效，零迁移 |
| 原子发布 + 指针 | `code/cache.py:201`（staging → 原子换 current.json） | 读侧 pin 共享锁，永不半开 |

## 模块间交互

**Server factory**（`server/factory.py:205-258`）：lifespan 内 `enter_async_context(open_builtin_runtime(...))` 后 `app.state.application = runtime`；`_scheduled_access_runners` 让后台调度也以 system principal 过 `access.require`——**后台路径不绕过鉴权**。**CLI**（`server/cli.py:312`）：无 server 直接驻留（纯后台角色）。**Supervisor 双向**：factory 从 `runtime.artifact_processing_supervisor` 读 family status 喂 metrics 与 readiness（supervisor degraded 直接 NOT_READY）。

## 扩展方式

**新增一个 Artifact Family**（以 topic-memory 为参照，九处改动）：

1. `processing_registry.py:41` `processing_capabilities` families 追加
2. `processing_registry.py:95` `canonical_processing_manifest` 的 bindings map；`composition.py:710` `canonical = {**FAMILY_BINDINGS, "新family": BINDING}`
3. `composition.py:715-791` automatic dict + binding 构造（`config.py` 加 `{prefix}_max_workers` 等字段）
4. **`composition.py:899-914`（SQLite）与 `:980-991`（OceanBase）两处 schema bootstrap 都要加**——两分支是复制粘贴的，改一处漏一处会静默漏建表
5. `relational.py` 检索/写入方法 + `_services_for`
6. `application.py` 新 `Scoped*Application` + `BuiltinRuntime.__init__` 注入 + `self.xxx = XxxApplication(self)`（`:3102-3118` 处）
7. （可选）`_prepare_build` 默认 family 集合与 `_recall_round` 分支
8. `config.py` 调度字段；`processing_registry.py:32` 推荐调度
9. HTTP 能力面（factory 的 `_server_capabilities`）

另注意 `_validate_processing_source_registry`（`composition.py:671`）在非 api role 下会拒绝未注册 family 的 child Source definition——新 family 若有专属 Source 类型必须同步 `SourceDefinitionRegistry`。

**新增一种语言 collector**（code 索引）：`languages.py` 的 `LANGUAGES` 加 `LanguageSpec`（`spec.build` 入指纹——改这里自动作废旧代）；写 collector 注册进 `polyglot.py` 的 `_COLLECTORS`；`LANGUAGE_LIMITATIONS` 加已知限制（出现在查询结果的 limitations 字段）。
