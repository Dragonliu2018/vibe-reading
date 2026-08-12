---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "PD 分离"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "PD 分离", "disaggregation", "NIXL", "RDMA", "KV Cache 传输"]
description: "PD 分离模块——KvCacheTransceiverV2 通过 NIXL RDMA 跨节点传输 KV cache，prefill/decode 分离部署，consensus 机制保证 TP/PP 一致。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/TensorRT-LLM/CodeWiki/1.3.0/00-overview)

---

## 模块定位

PD 分离（disaggregated serving）是一个**横切特性**模块——把 prefill worker 与 decode worker 分离部署，通过 NIXL RDMA 跨节点传输 KV cache。模块独立存在是因为它有完整的传输抽象体系：per-request 的 TxSession/RxSession 会话、C++/Python 可切换的传输后端、TP/PP rank 间的 consensus 共识机制。它 hook 进 `PyExecutor` 的调度循环，而非垂直分层。

## 模块架构

```
disaggregation/
├── transceiver.py        ← KvCacheTransceiverV2（传输核心）
├── base/agent.py         ← BaseTransferAgent 抽象（C++/Python 切换）
├── base/transfer.py      ← KVSlice / TxSessionBase / RxSessionBase
├── native/transfer.py    ← TransferWorker + NixlTransferAgent
├── native/bounce/        ← Bounce Buffer（小 payload CPU 中转）
└── native/messenger.py   ← ZMQ 控制面消息
```

## 调用链路

prefill → 传输 KV cache → decode 的完整流程：

```
[Context Worker (Prefill)]
1. prefill 完成 → kv_cache_transceiver.respond_and_send_async(req)  [transceiver.py:633]
   → _get_or_create_send_session(req) → TxSession
   → _create_kv_slice(req)  ← block_ids + token_range + mamba_state_index
   → session.send(kv_slice)  ← NIXL RDMA 异步
2. 轮询 check_context_transfer_status()                              [transceiver.py:695]
   → _poll_sessions_for_interval() → _collect_done()
   → _ctx_consensus()  ← TP/PP allgather 共识
   → 完成 → DISAGG_CONTEXT_COMPLETE

[Generation Worker (Decode)]
3. gen request 到达 → kv_cache_transceiver.request_and_receive_async(req)  [transceiver.py:678]
   → _transfer_worker.create_rx_session(req) → RxSession
   → session.receive(kv_slice)  ← 异步接收
4. 轮询 check_gen_transfer_status()                                  [transceiver.py:768]
   → _gen_consensus()  ← TP/PP 共识
   → 完成 → DISAGG_GENERATION_TRANS_COMPLETE
   → _apply_aux()  ← 解包 first_gen_tokens、draft_tokens
5. KV cache 就位 → 正常 decode
```

| 组件 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `KvCacheTransceiverV2` | KV cache 传输核心 | per-request TxSession/RxSession |
| `BaseTransferAgent` | 传输后端抽象 | C++/Python 实现可切换 |
| `TransferWorker` | 底层传输引擎 | 封装 NixlTransferAgent |

## 核心实现

### NIXL RDMA 传输

PD 分离选择 NIXL（NVIDIA Inference Transfer Library）而非 NCCL。`native/transfer.py:68` 的 `NixlTransferAgent` 基于 UCX 协议，支持 GPU-to-GPU 直接传输（VRAM → VRAM，无需 CPU 中转）。传输流程：`register_memory()` 注册 GPU KV cache 内存 → `get_local_agent_desc()` / `load_remote_agent()` 交换 agent 描述符 → `submit_transfer_requests()` 提交 RDMA → `TransferStatus.wait()` 等待。

`_create_nixl_agent()` in `native/transfer.py:2283` 创建 NIXL agent，线程数由 `TRTLLM_NIXL_NUM_THREADS` 环境变量控制（默认 8）。`get_status_dump()` 明确输出 `backend=NIXL`。**Why**：NCCL 是 collective 通信库，不适合 point-to-point KV 传输；NIXL 专为推理场景优化，支持 RDMA、异步、多 session 并发。

### Bounce Buffer 与控制面

**Bounce Buffer**（`native/bounce/`）通过中间 CPU buffer 中转小 payload，避免 RDMA 注册开销超过传输收益，由 `TRTLLM_KV_CACHE_BOUNCE_MIN_BLOCKS`/`TRTLLM_KV_CACHE_BOUNCE_MIN_BYTES` 调优。ZMQ Messenger（`native/messenger.py`）用于控制面消息（session 建立、cancel 等），与数据面 NIXL 分离。

### Consensus 机制

TP/PP rank 间必须对每个 request 的传输状态达成共识——`_ctx_consensus()` / `_gen_consensus()` allgather，确保所有 rank 对 per-request 状态变更一致。**Why**：防止 state divergence 导致 hang——某个 rank 认为传输完成而另一个未完成，会让集合通信阻塞。

### Session 抽象与 aux channel

per-request 的 `TxSession`/`RxSession`（`base/transfer.py:155`）解耦了传输生命周期和 request 生命周期，支持多 request 并发传输。`pack_aux()` / `send_aux()` 在 KV cache 之外传输 `first_gen_tokens`、`draft_tokens` 等元数据，支持 generation-first 调度。

`_create_kv_slice()` in `transceiver.py:253` 从 request 构建 `KVSlice`（含 `block_ids`、`token_range`、`mamba_state_index`），`cancel_request()` in `transceiver.py:918` 取消传输。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 生产者-消费者 | `respond_and_send_async` / `request_and_receive_async` in `transceiver.py` | PD 分离 KV 传输解耦 |
| 抽象工厂 | `BaseTransferAgent` + C++/Python 切换 in `base/agent.py:93` | 传输后端可切换 |

## 模块间交互

PD 分离与 `pyexecutor` 集成：`PyExecutor.__init__()` in `py_executor.py:986` 接收 `kv_cache_transceiver` 参数。prefill 完成后调 `respond_and_send_async()`；gen request 到达时调 `request_and_receive_async()`；每 iteration 调 `check_context_transfer_status()` / `check_gen_transfer_status()` 推进进度。`check_gen_transfer_complete()` 返回 `len(self._recv_sessions) == 0`。`_send_sessions` / `_recv_sessions` 字典维护 per-request 会话状态，`_reuse_adapter: CacheReuseAdapter` 处理 KV cache 复用。

## 扩展方式

**新增 KV cache 传输后端**：

1. 继承 `BaseTransferAgent`（`base/agent.py:93`）实现 `register_memory`/`submit_transfer_requests`/`get_local_agent_desc`
2. 继承 `TxSessionBase`/`RxSessionBase`（`base/transfer.py:155`）实现 session 生命周期
3. `TransferWorker`（`native/transfer.py:2318`）添加后端选择逻辑
4. 在 `_create_nixl_agent()`（`native/transfer.py:2283`）旁添加新后端工厂函数
5. `KvCacheTransceiverV2` 无需修改——通过 `TransferWorker` 间接使用
