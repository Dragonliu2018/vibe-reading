---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "权重同步"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "权重同步", "NCCL", "CUDA IPC", "delta"]
description: "slime 的训练↔推理权重同步桥梁：tensor/nccl/disk/disk-delta 四路径与全局命名原语。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

`slime/backends/megatron_utils/update_weight/` 是训练与推理之间的权重同步桥梁，也是 slime 部署灵活性的核心。RL 循环每步结尾，训练侧产出的新 Megatron 权重必须同步到 SGLang rollout 引擎才能让下一轮生成 on-policy。这一步的代价在大模型上极其可观，所以 slime 提供了**四条不同语义与代价的路径**，按 `update_weight_mode`（delta/full）× `update_weight_transport`（disk/nccl/tensor）选择：从最快的 colocate 内存直传，到跨机型的全量落盘，到大模型增量 delta。它们共享一套 TP all-gather + 全局命名的原语（`common.py`），把 Megatron 的 TP/PP/EP 分片权重拼回 HF 全量名字空间再传给 SGLang。

## 模块架构

![权重同步四路径](/vibe-reading/images/articles/slime-internals/weight-sync-matrix.svg)

文字上，`common.py` 是四路径共享的基础设施：`named_params_and_buffers` 产出跨 PP/EP/VP 一致的全局名（处理 decoder.layers / mtp.layers / expert_bias 的偏移），`all_gather_param` / `all_gather_params_async` 把 TP 分片参数拼成全量张量（区分 expert-TP 与 regular-TP，处理 GLU 的 `linear_fc1` 重切块与 `linear_fc2` 维度修正）。四个 `UpdateWeight*` 类都实现 `connect_rollout_engines` / `update_weights` / `pop_metrics` 三个方法，差异只在"拼好的 HF 张量怎么送到引擎"。`DiskDelta` 继承 `Distributed`，复用其 TP all-gather + HF 转换的分桶逻辑，只在 `_on_chunk` 注入 delta 计算行为——这是模板方法模式。

## 调用链路

`MegatronTrainRayActor.update_weights` 是同步触发入口，每步循环结尾被 `train.py` 调用：

```text
update_weights()                                       # actor.py
  └─ recover_updatable_engines (rank0, 故障容错)       # 死引擎恢复
  └─ get_updatable_engines_and_lock                    # 从 RolloutManager 取可更新引擎 + 锁
  └─ connect_rollout_engines (新引擎/重连时)          # 建立 NCCL group / IPC 通道
  └─ weight_updater.update_weights()                  # 落到四路径之一
      ├─ pause_generation + flush_cache (rank0)       # 引擎先暂停
      ├─ 权重传输（tensor IPC / NCCL 广播 / 落盘 / delta）
      └─ continue_generation (rank0)
  └─ keep_old_actor 队列更新（可选）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MegatronTrainRayActor.update_weights` in `actor.py` | 同步触发：恢复→取引擎→connect→update | `reconnect_rollout_engines`（offload+critic+非colocate）需 wake |
| `all_gather_param` in `common.py` | TP 分片拼全量 | expert-TP vs regular-TP；GLU rechunk；fc2 维度修正 |
| `all_gather_params_async` in `common.py` | 多参数并行 all-gather | 三阶段：发起→统一 wait→concat，最大化 NCCL 重叠 |
| `named_params_and_buffers` in `common.py` | 跨 PP/EP/VP 全局命名 | 处理 layer_offset、expert_offset、mtp.layers |
| `UpdateWeightFromTensor.update_weights` | colocate CUDA IPC 直传 | 分块传输 + 每 chunk `ipc_collect` 释放 |
| `UpdateWeightFromDistributed._send_weights` | NCCL 分桶广播 | 非 expert(TP) pass → barrier → expert(EP) pass |
| `UpdateWeightFromDiskDelta.update_weights` | delta 落盘 | 首帧 `_capture_baseline`，之后 `_encode_delta` zstd 压缩 |

</details>

## 核心实现

### 全局命名与 TP all-gather 原语

权重同步的第一道关是命名对齐：Megatron 的参数名是 PP/EP/VP 分片后的局部名，而 SGLang 引擎消费的是 HF 全量命名。`_named_params_and_buffers_global` in `common.py` 用正则把 `decoder.layers.{local_idx}` 映射到全局 `layer_idx + layer_offset`（PP/VP 偏移），把 `mlp.experts.{rest}.{weight|bias}{expert_idx}` 的 expert_idx 加上 `ep_rank × num_experts // ep_size` 的 EP 偏移，还处理 `mtp.layers`（Multi-Token Prediction，speculative decoding 用）。这样同一逻辑参数在所有 rank 上产出一致的全局名，是后续 all-gather 与 HF 转换的基础。

`all_gather_params_async` 用三阶段最大化 NCCL 重叠：Phase1 对每个 TP 参数发起 `dist.all_gather(async_op=True)` 收集句柄、Phase2 统一 `handle.wait()`（让通信真正并行）、Phase3 才 concat 分区。它还特判了几个 Megatron grouped MoE 的已知坑：`linear_fc1` 的 GLU 重切（先 chunk(2) 再交错重组）、`linear_fc2` 的 `partition_dim` 0→1 修正。`expert_bias` 不参与 TP 分片直接返回，duplicated/non-TP/TP-size-1 参数也跳过通信。

### 路径 1：UpdateWeightFromTensor（colocate 内存直传）

colocate 场景下训练与 rollout 共享 GPU，走 CUDA IPC 内存直传最快。`update_weights` 先 rank0 `pause_generation` + `flush_cache`，然后按 HF 权重 chunk 迭代，`_send_hf_params` 把每个 chunk 通过 `_send_to_colocated_engine` 以 CUDA IPC 句柄传给同 GPU 的引擎。每 chunk 传完立即 `del` 释放 GPU 张量并 `torch.cuda.ipc_collect()` + `empty_cache()`，让 caching allocator 复用块、清理已关闭的 IPC 缓存。expert 权重有独立的 `_expert_transfer_plan`（`_update_expert_weights`，按 expert 分批）。结尾 rank0 `continue_generation`。压缩量化（`compressed-tensors`）有 `post_process_weights` 的 restore/quant 两阶段处理（int4/fp4 需要先 restore 原权重再量化）。

### 路径 2：UpdateWeightFromDistributed（NCCL 分桶广播）

分离部署用 NCCL。`_send_weights` 分两 pass：非 expert（TP all-gather）→ gloo barrier → expert（EP）→ barrier。`_iter_non_expert_chunks` 逐参数 `all_gather_param` 拼 TP、`convert_to_hf` 转 HF 命名、按 `--update-weight-buffer-size` 分桶，仅在 PP 源 rank 产出 chunk（其他 rank 仍参与 all_gather）。`_update_bucket_weights_from_distributed` 把分桶广播到 SGLang 引擎（`engine.update_weights_from_distributed`，引擎侧需先 `init_weights_update_group` 建 NCCL group）。`_on_chunk` 是模板方法钩子，`DiskDelta` 重写它。

### 路径 3 & 4：磁盘全量与 delta

`UpdateWeightFromDisk` 把全量 Megatron→HF 检查点落盘，引擎 `update_weights_from_disk` 重载——用于外部 rollout引擎、跨 GPU 厂商、独立 serving 环境（可经共享文件系统或本地 NVMe 拉取）。

`UpdateWeightFromDiskDelta` 继承 `Distributed`，是**大模型增量更新效率**的关键。首次调用不传输，只 `_capture_baseline`：从 `hf_checkpoint` 读基线快照（保证 `snapshot == engine base`，即使 Megatron→HF 往返会裁掉 vocab-padding 行），引擎 `pull_weights(0)` 各自物化本地基线。之后每次：`_encode_delta` 用 `diff_and_compress` 算当前与基线差异、zstd 压缩；`_write_delta_files` 写成 canonical safetensors（文件序号与 index.json 用 gloo 协调——因为非 POSIX 共享文件系统可能不即时可见）；`_reload_engines` 让引擎 `pull_weights(version)`（校验 checksum）后重载。这样大模型每步只传变化的少量参数，而非全量。

### 量化权重的后处理

`UpdateWeightFromTensor` 与 `Distributed` 都在 `pause` 后 / `continue` 前调 `post_process_weights`（`slime/backends/megatron_utils/megatron_to_hf/processors/quantizer_compressed_tensors.py`）：`restore_weights_before_load=True` 先从引擎恢复原权重（int4/fp4 解压回 fp16/fp32），传输新权重，再 `post_process_quantization=True` 重新量化压缩。这保证压缩格式权重在网络传输时是解压态、落地后重新量化，避免量化态直接传输的数值问题。

## 扩展方式

新增传输路径：在 `update_weight/` 新增类，实现 `connect_rollout_engines` / `update_weights` / `pop_metrics`（可继承 `UpdateWeightFromDistributed` 复用 `_send_weights` 的两 pass 分桶逻辑，只重写 `_on_chunk`），在 `actor.py:154` 的选型矩阵注册新的 `mode × transport` 组合。配置路径由 `--update-weight-mode` / `--update-weight-transport` / `--update-weight-buffer-size` 控制。External rollout 引擎（serving 独立于训练作业）见 `docs/en/advanced/external-rollout-engines.md`。
