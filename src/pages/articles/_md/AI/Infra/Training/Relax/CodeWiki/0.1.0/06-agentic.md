---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "Agentic RL"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "Agentic RL", "多轮交互", "SessionForest", "loss masking", "VLM", "pipeline"]
description: "解读 Relax Agentic RL 模块：AgenticResidentPipeline 常驻四域 dataflow、AgenticSessionShard 分片会话与 SessionForest 多轮状态树、FinalizedResultTransport 训练样本回传、loss masking 与 VLM 上下文承接。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/agentic/`（11,881 行）是横跨组件与引擎层的 agentic RL 模块，支持多轮"执行→观察→决策"闭环训练。它独立成层是因为 agentic RL 与普通 RL 根本不同：普通 RL 一次性生成（一次 forward→一个 response→一个 reward），agentic RL 由**外部 agent 进程驱动多轮交互**——每轮需承接上文（messages+tools+KV cache prefix）、tool call 后注入 observation、灵活终止、跨 step 的 partial rollout 恢复。这要求独立的 session 层（管多轮对话状态）与 pipeline 层（协调异步 dataflow），不能用同步 batch 的普通 rollout 模式。该模块承载四个 god node：`RuntimeDomain`（86 边）、`AgenticSessionShard`（80 边）、`FinalizedResultTransport`（46 边）、`AgenticResidentPipeline`（44 边）。

## 模块架构

agentic 分 pipeline/session/runner 三层。`AgenticResidentPipeline`（`rollout.py:200`）是常驻 pipeline，跨 step 复用，协调四个 Domain（Prepare/Runtime/Reward/Transfer）的异步 dataflow。`AgenticSessionShard`（`session/service.py:674`）是分片会话服务（默认 16 shard），每个 shard 管理多个 `SessionForest` 多轮状态树与 `InflightRequest` 队列。`AgenticChatAPIService`（`session/service.py:2523`）是 Ray Serve deployment，对外暴露 OpenAI 兼容 HTTP API，fan-out 到 16 shard。`FinalizedResultTransport`（`session/state.py:210`）是会话结束后的训练样本传输载体。

```
agentic/
├── rollout.py (1806)      AgenticResidentPipeline（常驻 pipeline + _resident_dataflow_loop）
├── pipeline/
│   ├── runtime.py (3932)  RuntimeDomain（managed session 生命周期 + 物化 + IR 门控）god node 86
│   ├── prepare.py (611)   PrepareDomain（数据预取 + group 创建 + session 启动）
│   ├── reward.py (525)    RewardDomain（per-sample async / per-group reward）god node 41
│   ├── transfer.py        TransferDomain（partition 配额 + batch 传输）
│   └── __init__.py        ExportMode / PendingExportUnit / GroupKey / SampleKey
├── session/
│   ├── service.py (2961)  AgenticSessionShard（god node 80）+ AgenticChatAPIService（HTTP API）
│   └── state.py (852)     FinalizedResultTransport（god node 46）+ SessionForest + MsgNode + InflightRequest
└── runner/
    └── ipc.py (667)       LauncherClient + ManagedSessionRunner（外部 agent 进程管理）
```

## 调用链路

一次多轮 agentic rollout 的执行链：

```
generate_rollout(args, rollout_id, data_source, dsc)       # rollout.py:1769
  → AgenticResidentPipeline.run_step(rollout_id)           # rollout.py
      → open_step()                                         # rebind 四域 + 释放 partial-resume gate + 启动 dataflow loop
      → close_step(step_handle)
          → _wait_step_target()                             # 等 TransferDomain 凑够 group 数
              → 后台 _resident_dataflow_loop 持续 _pump_once():
                  ├─ _pump_prepare_once()       PrepareDomain fetch/launch agent 进程
                  ├─ _pump_admission_once()     PrepareDomain → RuntimeDomain.start_batch
                  ├─ _pump_runtime_to_reward_once()  RuntimeDomain → RewardDomain
                  ├─ _pump_reward_to_transfer_once()  RewardDomain → TransferDomain
                  └─ _pump_transfer_once()      TransferDomain → data_system
          → TransferDomain.close_output_window() + build_output() → RolloutFnTrainOutput
          → _seal_step()（gate IR + abort SGLang + 等待 active request 归零）

=== agent 进程内部多轮交互（HTTP 回调到 shard）===
agent 进程 → POST /agentic_api/v1/chat/completions
  → AgenticChatAPIService → 路由到 AgenticSessionShard.chat(session_id, messages, ...)
      → _ensure_record() / _match_parent_state_hash()（SessionForest 找历史 state 承接上下文）
      → _append_observation_if_needed()（追加 observation delta）
      → _build_ir_locked()（创建 InflightRequest 入队）
      → _maybe_start_next_ir_locked() → _run_ir()（SGLangBackendAdapter.generate 向 SGLang 发请求）
      → forest.append_resp()（响应追加到 forest）→ 返回 agent
agent 退出 → ManagedSessionRunner 收集输出 → RuntimeDomain 物化
  → finalize_and_discard() → SessionForest.build_sample()（拼 loss_mask）→ ray.put(artifact)
  → FinalizedResultTransport（status + artifact_ref）→ RewardDomain → TransferDomain → TQ PUT
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `AgenticResidentPipeline.run_step` | 完整执行一步 agentic rollout | 常驻跨 step，后台 `_resident_dataflow_loop` 驱动 |
| `open_step` | rebind 四域 + 释放 gate | step 间复用 pipeline，只 rebind 参数 |
| `_pump_once` | 驱动一轮五阶段 dataflow | 任一阶段有进展就继续 |
| `RuntimeDomain.start_batch` | 接收 leased group 激活 session | 注册 runtime slot |
| `RuntimeDomain.wait_for_next_runtime_slot` | 等 managed session 完成→物化 | 转为 FinalizedResultTransport |
| `AgenticSessionShard.chat` | 处理 agent chat 请求 | SessionForest 承接多轮上下文 |
| `AgenticSessionShard.finalize_and_discard` | 会话结束构建训练样本 | `SessionForest.build_sample` 拼 loss_mask |
| `SessionForest.build_sample` | 拼完整 Sample | resp 节点 loss_mask=1，obs 节点=0 |
| `AgenticChatAPIService` | OpenAI 兼容 HTTP API | fan-out 到 16 shard |

</details>

## 核心实现

### AgenticResidentPipeline：常驻四域 dataflow

`AgenticResidentPipeline`（`rollout.py:200`）跨 step 复用，`init_pipeline` 初始化四个 Domain，`run_step` 调 `open_step`（rebind `RuntimeDomain`/`RewardDomain`/`TransferDomain` + `release_partial_resume_gate` 释放上轮被门控的 IR + `start_resident_dataflow` 启动后台 `_resident_dataflow_loop`）与 `close_step`（`_wait_step_target` 阻塞等 TransferDomain 凑够 group 数 → `close_output_window` → `build_output` → `_seal_step` gate IR + abort SGLang + 等待 active request 归零 → `_discard_resident_tail`）。`_resident_dataflow_loop`（`:476`）持续 `_pump_once` 驱动 prepare→admission→runtime→reward→transfer 五阶段，任一有进展就继续。

常驻而非每轮重建的原因：(1) Partial rollout 被 abort 的 session 需跨 step 保持 `SessionForest` 状态，下 step `release_partial_resume_gate` 恢复；(2) SGLang KV cache prefix 跨 step 复用（session 通过 `X-SMG-Routing-Key: session_id` header 绑定固定 engine）；(3) `PrepareDomain` 维护 warming/ready group 池跨 step 预取减少启动延迟；(4) Over-sampling 允许提前超额 prepare。代价是复杂的 `_resident_dataflow_loop` 异步协调与 `_close_status` 多重终止条件。

### AgenticSessionShard 与 SessionForest

`AgenticSessionShard`（`session/service.py:674`）是 Ray Actor，默认 16 分片（`_DEFAULT_SESSION_SHARD_COUNT = 16`），按 session_id 哈希到固定 shard。分片原因：锁竞争隔离（每 session 独立 `asyncio.Lock`，单 actor 上数千锁调度开销大）、内存分散（`SessionForest` 的 `nodes_by_hash` 与 IR token prefix 多轮增长）、并行 IR 执行（16 shard 并行处理 16 session generation）、SGLang 并发控制（第一个 shard 持 `_sglang_request_semaphore`，其他远程获取 permit）。

`SessionForest`（`state.py:431`）是会话多轮交互状态树，节点 `MsgNode`（`:359`）类型 `obs`/`resp`，`nodes_by_hash` + `children_by_hash`，state_hash 由 `messages+tools+chat_template_kwargs` 哈希决定。作用：多轮上下文承接（`lineage()` 拼完整 messages）、abort 重试（从 parent 重新生成）、partial rollout 跨 step 恢复、`build_sample(leaf_state_hash)` 遍历 lineage 拼 tokens/loss_mask/log_probs 生成完整 `Sample`。

### FinalizedResultTransport 与 loss masking

`FinalizedResultTransport`（`state.py:210`）是会话结束结果载体，`status`（completed/truncated/aborted/failed/discarded/non_finalizable）+ `metadata` + `artifact_ref`（Ray ObjectRef 指向 `{"units": [...]}`）。构建：`AgenticSessionShard._build_transport_from_unit_payloads`（`service.py:2129`）`ray.put(artifact)`。解析：`RuntimeDomain._export_units_from_transport`（`runtime.py:3098`）`_resolve_object_async(artifact_ref)`，每 unit 经 `TrainingFieldArtifact(sample_payload).to_sample()` 还原 `Sample`，进 `TransferDomain` → `data_system_client.async_put`。

**loss masking** 在 `SessionForest.build_sample`（`state.py:620`）实现：遍历 lineage，resp 节点 `loss_mask_delta` 默认 `[1]*len(train_token_delta)`（模型生成 token 参与训练），obs 节点默认空或 `[0]*len`（observation 不计 loss），prompt 部分不进 `continuation_train_tokens`。最终 `Sample.loss_mask` 长度等于 `tokens`，仅模型自生成 token 位为 1。`_assistant_token_spans`（`service.py:2131`）从 loss_mask 提取 `(start,end)` span 供 explicit export 模式。

### VLM 多模态上下文承接

三层多模态数据管理：(1) 消息层 `_multimodal_inputs_from_messages`（`state.py:340`）从 content parts 提取 image/audio/video；(2) Forest 节点层 `MsgNode` 存 `multimodal_train_inputs_delta`/`backend_image_data_delta` 等；(3) IR 层 `InflightRequest` 携 `history_backend_image_data` 等，`build_execution_prefix`（`state.py:516`）从 lineage 拼接。新一轮 chat 到达时 `_match_parent_state_hash` 找历史 state，`_append_observation_if_needed` 只编码新增 observation delta，历史多模态数据从 lineage 恢复不重传。`SessionForest.build_sample` 经 `_merge_multimodal_train_inputs`（`state.py:288`）合并所有节点 delta 生成最终 `Sample.multimodal_inputs`/`multimodal_train_inputs`。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 领域驱动 | `RuntimeDomain`/`PrepareDomain`/`RewardDomain`/`TransferDomain` in `pipeline/` | 各封装一阶段状态，`_pump_once` 协调，统一 `rebind_step`/`shutdown` |
| 分片 | `AgenticSessionShard` × 16 + `AgenticChatAPIService` fan-out in `session/service.py:2493` | 锁/内存/IR 并行分散，全局 SGLang 并发控制 |
| 常驻 Pipeline | `AgenticResidentPipeline` + `_resident_dataflow_loop` in `rollout.py:200,476` | 跨 step 保持 forest/KV cache/prepare pool |
| 状态机（会话生命周期） | `SessionGateReason` + `_SessionRecord` in `service.py:116,142` | prepare→active→partial_resume→finalize/discard |
| 状态树 | `SessionForest` + `MsgNode` in `state.py:431,359` | 多轮上下文承接 + abort 重试 + partial 恢复 |

## 模块间交互

agentic 依赖 `engine`（`on_policy_distillation`/`base_types`/`filters`）、`distributed`（`ray.rollout` 的 `_resolve_sglang_config`/`_start_router`、TransferQueue via data_system_client）、`utils`（Sample/http_utils/multimodal/metrics/s3_model_loader）、`backends`（SGLang via `SGLangBackendAdapter`→router→workers）。被 `core/controller` 调用（`deploy_agentic_chat_api_services`/`shutdown_agentic_chat_api_services`/`clear_agentic_runtime_caches`）、被 engine rollout driver 每轮调 `generate_rollout`。`AgenticChatAPIService` 对外暴露 `/agentic_api/v1/chat/completions`（OpenAI 兼容，agent 进程通过 `RELAX_BASE_URL` 调用）。详见概览「模块地图」。

## 扩展方式

- **新增终止条件**：`session/service.py` `AgenticSessionShard._terminal_response_locked` 检查 finish_reason/tool_calls 设新 `ir.pending_status`；`state.py` `SessionForest.append_resp` 记录 + `build_sample` status 映射 + `runtime.py` `_materialize_managed_result_record` 处理
- **新增多模态类型**：`state.py` `MsgNode` 加 `backend_X_data_delta` 字段 + `InflightRequest` 加 history/pending + `ExecutionPrefix`/`build_execution_prefix` 拼接 + `runtime.py` `SGLangBackendAdapter.generate` 传参 + `SGLangMessageCompiler` 编码
- **新增自定义 reward**：`pipeline/reward.py` `RewardDomain` 加路径（参照 `_async_rm`/`_batched_async_rm`）+ `step_once` 集成 + `rollout.py` `_pump_reward_to_transfer_once` 处理 prefill
