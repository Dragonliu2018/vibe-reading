---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "speculative & disaggregation"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "投机解码", "PD 分离", "NIXL", "Eagle3", "disaggregation"]
description: "投机解码与 PD 分离是 hook 进执行引擎的横切特性——15+ 投机解码算法 + NIXL RDMA KV cache 跨节点传输。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/TensorRT-LLM/CodeWiki/1.3.0/00-overview)

---

## 模块定位

speculative（投机解码）和 disaggregation（PD 分离）是两个**横切特性**模块——它们不参与垂直分层，而是 hook 进 `PyExecutor` 的执行循环。投机解码通过 draft model 预测 + target model 验证提升推理吞吐；PD 分离把 prefill 和 decode 分离部署，通过 NIXL RDMA 传输 KV cache。两模块独立成文是因为它们各自有完整的抽象体系（策略模式的多算法 / 生产者-消费者的传输会话），且都是 v1.3.0 的重点特性。

## 模块架构

```
speculative/
├── interface.py          ← SpeculativeDecodingMode 枚举 + SpecMetadata + SpecWorkerBase
├── utils.py              ← get_spec_worker() / get_spec_metadata() 工厂
├── eagle3.py             ← Eagle3OneModelWorker（+ DynamicTree 变体）
├── draft_target.py       ← DraftTargetOneModelWorker
├── mtp.py / ngram.py     ← MTP / Ngram worker
└── pard.py / dflash.py   ← 并行 draft 变体

disaggregation/
├── transceiver.py        ← KvCacheTransceiverV2（传输核心）
├── base/agent.py         ← BaseTransferAgent 抽象
├── base/transfer.py      ← KVSlice / TxSession / RxSession 抽象
└── native/transfer.py    ← TransferWorker + NIXL agent
```

## 调用链路

### 投机解码：draft → verify → accept

以 `DraftTargetOneModelWorker._forward_impl()` in `draft_target.py:143` 为例：

```
1. [Target forward] model.forward() → target logits
2. [Sample & Accept] sample_and_accept_draft_tokens()      [interface.py:1631]
   → _accept_draft_tokens()                                [interface.py:1459]
   → strict: _sample_and_accept_draft_tokens_base()        [interface.py:1388]
       └─ torch.cumprod((draft==target).int(), dim=-1).sum(1)  ← 连续匹配数
   或 rejection: _sample_and_accept_draft_tokens_rejection()
       └─ flashinfer.sampling.chain_speculative_sampling
3. [Prepare draft] _prepare_attn_metadata_for_draft_target()
   → 保存 attn_metadata（prepare_for_spec_dec）
4. [Draft loop] for i in range(runtime_draft_len):
   a. draft_model.forward() → hidden_states → draft logits
   b. sample_draft_tokens() → advanced_sample_draft()
   c. 更新 attn_metadata（kv_lens, seq_lens）
5. [Restore] _restore_attn_metadata_from_spec_dec()
6. [Return] {logits, accepted_tokens, next_draft_tokens}
```

关键：`_update_kv_after_first_draft_step()` 回退 KV lens——draft 前向预填了全部 draft token 的 KV，但只有 accepted 的才保留：`kv_lens -= (runtime_draft_len - num_accepted_tokens)`。

### PD 分离：prefill → transfer KV → decode

```
[Context Worker (Prefill)]
1. prefill 完成 → kv_cache_transceiver.respond_and_send_async(req)  [transceiver.py:633]
   → _create_kv_slice(req) → TxSession.send(kv_slice)  ← NIXL RDMA 异步
2. 轮询 check_context_transfer_status() → _ctx_consensus()  ← TP/PP 共识
   → 完成 → DISAGG_CONTEXT_COMPLETE

[Generation Worker (Decode)]
3. gen request 到达 → kv_cache_transceiver.request_and_receive_async(req)  [transceiver.py:678]
   → RxSession.receive(kv_slice)  ← 异步接收
4. 轮询 check_gen_transfer_status() → _gen_consensus()
   → 完成 → DISAGG_GENERATION_TRANS_COMPLETE → 正常 decode
```

| 组件 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `SpeculativeDecodingMode` | 枚举所有算法 + 能力谓词 | `is_*()` 让下游无需 if-else |
| `SpecWorkerBase` | 投机解码 worker 抽象 | `forward()` @final 保证 cleanup |
| `KvCacheTransceiverV2` | KV cache 传输核心 | per-request TxSession/RxSession |
| `BaseTransferAgent` | 传输后端抽象 | C++/Python 实现可切换 |

## 核心实现

### 投机解码的策略模式

`SpeculativeDecodingMode` in `interface.py:326` 枚举 15+ 算法（`EAGLE3`/`MTP`/`NGRAM`/`PARD`/`DFLASH`/`DSPARK`/`SA`/`USER_PROVIDED`/`AUTO` 等），提供大量 `is_*()` 谓词（`use_one_engine()`、`needs_kv_cache_rewind()`、`has_spec_drafter()`、`support_dynamic_draft_len()`）。这些谓词控制调度器和注意力后端的行为分支。

`get_spec_worker()` in `utils.py:482` 是工厂，按 `spec_dec_mode` 创建对应 worker。`SpecWorkerBase` in `interface.py:1063` 是抽象基类，`forward()` 是 final 方法（`__init_subclass__` 强制，`interface.py:1106`），在 try/finally 中保证 spec-dec metadata 恢复，子类只实现 `_forward_impl()`。**Why**：不同场景最优算法不同（Eagle3 通用高接受率但需训练 draft；Ngram 无需训练适合 FAQ；MTP 轻量适合 DeepSeek），能力谓词让下游无需硬编码 if-else，这是支持 15+ 算法的关键。

### strict acceptance vs rejection sampling

`_accept_draft_tokens()` in `interface.py:1459` 路由到两条路径：strict acceptance（`_sample_and_accept_draft_tokens_base`，用 `torch.cumprod` 算连续匹配数）和 rejection sampling（`_sample_and_accept_draft_tokens_rejection`，用 `flashinfer.sampling.chain_speculative_sampling`）。`draft_probs` 是 slot-indexed 的概率缓冲区 `[num_seq_slots, max_draft_len, vocab_size]`，`batch_slot_ids` 是 per-request 的 stable slot id，用于跨迭代 scatter/gather。

### Dynamic Tree

Static tree 用固定 `eagle_choices` 拓扑展开 draft tokens，对不同 prompt 适应性差。Dynamic tree（`eagle3_dynamic_tree.py`、`spec_tree_manager.py`）在每步根据 draft model 置信度动态调整树结构——`SpecTreeManager` 管理 topology，`dynamic_tree_max_topK` 控制展开。**Why**：简单 prompt 浪费 draft slot，复杂 prompt 不够；动态裁剪/扩展提高有效 draft token 利用率。

### One-model 架构的 KV cache 隔离

one-model 模式下 draft 和 target 共享同一 engine，但需不同 KV cache 布局。`prepare_attn_metadata_for_draft_replay()` in `interface.py:127` 在 draft forward 前交换 KV cache manager 和 block offsets，draft 后 `restore_attn_metadata_after_draft_replay()` 恢复。**Why**：避免维护两套 attention metadata 的开销，同时保证 CUDA graph 兼容性。

### NIXL RDMA 传输

PD 分离选择 NIXL（NVIDIA Inference Transfer Library）而非 NCCL。`native/transfer.py:68` 的 `NixlTransferAgent` 基于 UCX 协议，支持 GPU-to-GPU 直接传输（VRAM → VRAM，无需 CPU 中转）。传输流程：`register_memory()` 注册 GPU KV cache 内存 → 交换 agent 描述符 → `submit_transfer_requests()` 提交 RDMA → `wait()` 等待。

**Bounce Buffer**（`native/bounce/`）通过中间 CPU buffer 中转小 payload，避免 RDMA 注册开销超过传输收益，由 `TRTLLM_KV_CACHE_BOUNCE_MIN_BLOCKS`/`TRTLLM_KV_CACHE_BOUNCE_MIN_BYTES` 调优。ZMQ Messenger（`native/messenger.py`）用于控制面消息（session 建立、cancel）。**Why**：NCCL 是 collective 通信库，不适合 point-to-point KV 传输；NIXL 专为推理场景优化，支持 RDMA、异步、多 session 并发。

### Consensus 机制

TP/PP rank 间必须对每个 request 的传输状态达成共识——`_ctx_consensus()` / `_gen_consensus()` allgather，确保所有 rank 对 per-request 状态变更一致。**Why**：防止 state divergence 导致 hang——某个 rank 认为传输完成而另一个未完成，会让集合通信阻塞。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略 | `SpeculativeDecodingMode` + `get_spec_worker()` in `utils.py:482` | 15+ 算法可切换 |
| 模板方法 | `SpecWorkerBase.forward` @final in `interface.py:1106` | 统一流程骨架，保证 cleanup |
| 生产者-消费者 | `respond_and_send_async` / `request_and_receive_async` in `transceiver.py` | PD 分离 KV 传输解耦 |
| 抽象工厂 | `BaseTransferAgent` + C++/Python 切换 in `base/agent.py:93` | 传输后端可切换 |

## 模块间交互

**speculative 与 pyexecutor 集成**：`model_engine._set_up_spec_metadata()` in `model_engine.py:3120` 调 `get_spec_metadata()` 创建 `SpecMetadata`；worker 通过 `get_spec_worker()` 工厂创建，挂载到 `self.model.spec_worker`。`spec_metadata.prepare()` 在 forward 前分配 rejection sampling 缓冲区；`model_forward()` 中 `spec_worker._forward_impl()` 执行 draft-verify 循环。`SpecMetadata` 是 CUDA graph key 的一部分（`is_all_greedy_sample` 决定 graph variant）；`_sync_group_all_greedy_sample()` 在 TP 组内 all-greedy 标志取 AND。

**disaggregation 与 pyexecutor 集成**：`PyExecutor.__init__()` in `py_executor.py:986` 接收 `kv_cache_transceiver` 参数。prefill 完成后调 `respond_and_send_async()`；gen request 到达时调 `request_and_receive_async()`；每 iteration 调 `check_context_transfer_status()` / `check_gen_transfer_status()` 推进进度。`check_gen_transfer_complete()` 返回 `len(self._recv_sessions) == 0`。

## 扩展方式

**新增投机解码算法**：

1. `SpeculativeDecodingMode`（`interface.py:326`）添加枚举值 + `is_*()` 谓词，更新 `use_one_engine()` 等聚合谓词
2. 新建 worker 类继承 `SpecWorkerBase`，实现 `_forward_impl()` 和 `max_draft_len`
3. `get_spec_worker()`（`utils.py:482`）添加分支
4. `get_spec_metadata()`（`utils.py:83`）添加 metadata 创建逻辑
5. 若需特殊 attention 行为，更新 `attention_need_spec_dec_mode()`（`interface.py:471`）

**新增 KV cache 传输后端**：

1. 继承 `BaseTransferAgent`（`base/agent.py:93`）实现 `register_memory`/`submit_transfer_requests`/`get_local_agent_desc`
2. 继承 `TxSessionBase`/`RxSessionBase`（`base/transfer.py:155`）实现 session 生命周期
3. `TransferWorker`（`native/transfer.py:2318`）添加后端选择逻辑
4. `KvCacheTransceiverV2` 无需修改——通过 `TransferWorker` 间接使用
