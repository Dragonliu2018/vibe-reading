---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "训练后端"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "Megatron", "FSDP", "SGLang", "Weight Sync", "P2P", "FP8"]
description: "Megatron/FSDP 双训练后端适配，4 种权重同步策略，7 维并行状态，FP8 低精度数值稳定。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

这一层承载训练的具体实现——模型构建、forward/backward、optimizer step、checkpoint，以及把训练好的权重同步回 SGLang engine。核心是 `TrainRayActor` 抽象基类定义的统一契约（`init`/`train`/`update_weights`/`save_model`/`sleep`/`wake_up`），Megatron 和 FSDP 两个后端实现它，权重同步有 4 种策略按部署拓扑选择。

## 模块架构

```
miles/backends/
├── training_utils/        # 跨后端共享（4,623 行）
│   ├── parallel.py        #   ParallelState — 7 维并行状态（被 import 24 次）
│   ├── cp_utils.py        #   Context Parallel（zigzag 布局 / a2a / allgather）
│   ├── data.py            #   get_rollout_data / DataIterator / get_batch
│   └── loss.py            #   compute_advantages_and_returns / loss_hub
├── megatron_utils/        # Megatron 后端（11,326 行）
│   ├── actor.py           #   MegatronTrainRayActor（872 行）
│   ├── model.py           #   train / forward_only / train_one_step（991 行）
│   ├── model_provider.py  #   Megatron model provider + FP8 配置
│   ├── rematerialize_utils.py  # FP32 master weight rematerialize
│   └── update_weight/     #   4 种权重同步策略
│       ├── update_weight_from_tensor.py    # colocate CUDA IPC
│       └── update_weight_from_distributed/
│           ├── mixin.py       #   DistBucketedWeightUpdateMixin（桶式）
│           ├── broadcast.py   #   NCCL broadcast
│           ├── p2p.py         #   RDMA P2P
│           └── delta.py       #   共享文件系统 delta
├── fsdp_utils/            # FSDP2 后端（4,741 行）
│   ├── actor.py           #   FSDPTrainRayActor（761 行）
│   └── parallel.py        #   create_fsdp_parallel_state（纯 DP）
└── sglang_utils/          # SGLang rollout 引擎管理（1,231 行）
    └── sglang_engine.py   #   SGLangEngine Ray Actor（832 行）
```

## 调用链路

### (a) 权重同步 P2P RDMA fast path

```
MegatronTrainRayActor.update_weights(info)        # actor.py:732
├── weight_updater.connect_rollout_engines()      # p2p.py:174
│   ├── RemoteTransferPlan.plan_p2p()             # round-robin 分配 source→target
│   ├── query_remote_weight_infos()               # engine.get_remote_instance_transfer_engine_info
│   ├── create_transfer_engine()                  # Mooncake TransferEngine, RDMA
│   └── _create_cpu_replica() + register_cpu_memory()  # CPU pinned buffer
└── weight_updater.update_weights()               # mixin.py:340
    ├── _pause_and_prepare_engines()              # pause_generation / flush_cache / begin_weight_update
    ├── _gather_and_update_non_expert_weights()   # TP all-gather → convert_to_hf → P2P write
    ├── _gather_and_update_expert_weights()       # TP+EP all-gather → convert_to_hf → P2P write
    ├── transfer_manager.wait_transfers()
    └── _finalize_and_resume_engines()            # update_weight_version / end_weight_update / continue_generation
```

### (b) 一次训练 step（含 CP）

```
MegatronTrainRayActor.train_actor(rollout_id, rollout_data)   # actor.py:464
├── _switch_model("ref") → compute_log_prob() → ref_log_probs  # forward_only pipeline pass
│   └── cp_utils.slice_with_cp()  # zigzag 切分：rank r 持有 chunk r 和 chunk 2*cp-1-r
├── _switch_model("actor") → compute_log_prob() → log_probs
│   └── cp_utils.all_gather_with_cp()  # dist.nn.all_reduce 聚合完整序列
├── compute_advantages_and_returns()  # KL + GRPO advantage
└── train() → for step: train_one_step()   # model.py:405
    ├── forward_step() → get_batch → model(tokens)  # CP zigzag slice / Ulysses a2a
    ├── forward_backward_func(forward_only=False)   # Megatron 1F1B pipeline schedule
    ├── allreduce_grads_and_losses_across_replicas()  # indep_dp 跨 cell all-reduce
    └── optimizer.step()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `MegatronTrainRayActor.train()` in `actor.py:386` | 一次 rollout 训练 | 含 wake_up/get_rollout_data/train_actor |
| `train_one_step()` in `model.py:405` | 单步 forward+backward+step | CP zigzag + 1F1B pipeline |
| `update_weights()` in `actor.py:732` | 权重同步入口 | 按 weight_updater 策略分发 |
| `DistBucketedWeightUpdateMixin.update_weights()` in `mixin.py:340` | 桶式编排 | pause→non-expert(TP)→expert(EP)→resume |
| `UpdateWeightP2P._update_weight_implementation()` in `p2p.py:122` | RDMA 直写 | 最后 rank 异步 fire-and-forget |
| `SGLangEngine.update_weights_from_tensor()` | colocate IPC 路径 | POST /update_weights_from_tensor |
| `compute_advantages_and_returns()` in `loss.py` | KL + GRPO advantage | 在 CP 聚合后的完整序列上操作 |

</details>

## 核心实现

### ParallelState — 7 维并行状态

```python title="miles/backends/training_utils/parallel.py"
@dataclass
class ParallelState:
    intra_dp: GroupInfo       # 不含 CP 的 data parallel 组
    intra_dp_cp: GroupInfo    # 含 CP 的 data parallel 组
    cp: GroupInfo             # context parallel 组
    tp: GroupInfo             # tensor parallel 组
    pp: GroupInfo             # pipeline parallel 组
    ep: GroupInfo             # expert model parallel 组
    etp: GroupInfo            # expert tensor parallel 组
    indep_dp: GroupInfo       # 独立 data parallel（容错用）
    cp_comm_type: str | ...   # "a2a" = Ulysses CP

    @property
    def effective_dp(self) -> GroupInfo: ...   # 按 _dp_mode 返回 intra_dp 或 indep_dp
    @property
    def is_ulysses_cp(self) -> bool: ...        # cp_size>1 且 cp_comm_type=="a2a"
```

通过模块级单例 `_parallel_state` 全局访问。Megatron 从 `mpu` 读取各组（`create_megatron_parallel_state`），FSDP 纯 DP 所有非 DP 轴设为 size=1。

### 4 种权重同步策略

`MegatronTrainRayActor.init()` 中按部署拓扑选择（`actor.py:253-264`）：

| 策略 | 类 | 选择条件 | 传输方式 |
|------|-----|---------|---------|
| Tensor IPC | `UpdateWeightFromTensor` | `--colocate` | CUDA IPC（Gloo gather + Ray object store） |
| NCCL Broadcast | `UpdateWeightFromDistributed` | `--update-weight-transfer-mode broadcast` | NCCL `dist.broadcast` |
| Disk Delta | `UpdateWeightFromDiskDelta` | `--update-weight-transfer-mode disk-delta` | 共享文件系统 delta |
| P2P RDMA | `UpdateWeightP2P` | `--update-weight-transfer-mode p2p`（非 colocate 默认） | Mooncake TransferEngine RDMA 直写 |

所有策略继承 `DistBucketedWeightUpdateMixin`，共享 `update_weights()` 编排（pause→non-expert→expert→resume）。桶式处理按 `update_weight_buffer_size` 分桶流式传输——TP all-gather → rm pad → HF 转换 → 桶满触发传输。

### CP zigzag 布局与 Ulysses a2a

`cp_utils.py` 实现 zigzag 布局：序列分成 `2*cp_size` 个 chunk，rank `r` 持有 chunk `r` 和 chunk `2*cp_size-1-r`（首尾对称），保证 attention KV 在相邻 rank 间有重叠。两种 CP 通信模式：ring-attention（KV 环形传递，延迟随 cp_size 线性增长）和 Ulysses a2a（attention head 维度 all-to-all，单次 a2a 对数级延迟，适合大 cp_size）。`--allgather-cp` 让 log_prob 阶段用 `dist.nn.all_reduce` 聚合完整序列简化 advantage 计算。

### FP8 低精度数值稳定

低精度训练通过保持 FP32 master weight 保证数值稳定：`rematerialize_utils.py` 的 `MainCastContext` 在每次 train step 前从 FP32 master weight 重新 cast 为低精度参数；`--use-precision-optimizer` 在 CPU offload 模式下从 CPU master 恢复 GPU shard。权重同步时 `convert_to_hf()` + quantizer processor（`quantizer_fp8.py`/`quantizer_mxfp8.py`/`quantizer_nvfp4.py`）统一处理精度转换。FSDP2 用 `MixedPrecisionPolicy(param_dtype=bf16, reduce_dtype=fp32)`，梯度 all-reduce 在 FP32 进行。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 适配器 | `TrainRayActor` in `train_actor.py` | Megatron/FSDP 统一接口，切换后端不改 launch script |
| 策略 | 权重同步策略类 in `update_weight/` | 4 种传输路径按部署拓扑选择 |
| 桶式更新 | `DistBucketedWeightUpdateMixin` in `mixin.py` | 流式处理大模型权重，控制显存峰值 |
| 多模型权重切换 | `TensorBackuper` in `actor.py:348` | actor/ref/teacher/old_actor 快照切换 |

### 为什么 P2P RDMA 是 fast path 而非默认

默认是 broadcast（NCCL），P2P 需显式设置。原因：P2P 依赖 Mooncake TransferEngine + RDMA 网卡（非所有集群可用）；不支持 LoRA/colocate/PD disaggregation；需在 CPU 上构建 SGLang 模型副本注册 pinned memory，初始化开销高。但一旦建立，P2P 绕过 NCCL collective 直接 RDMA 写入远端 GPU，且最后 engine rank 的写入可异步化（fire-and-forget 到后台线程池），实现传输与下一 bucket 转换的 overlap。

### FSDP2 vs Megatron 选择权衡

| 维度 | Megatron | FSDP2 |
|------|----------|-------|
| 模型来源 | Megatron GPTModel（需 bridge 转换） | HF 原生模型 |
| 并行策略 | TP/PP/CP/EP/ETP 全支持 | 纯 DP（FSDP2 shard） |
| 权重同步 | 4 种策略 | 2 种（Tensor IPC / NCCL） |
| 内存管理 | `torch_memory_saver` pause/resume | `model.cpu()`/`model.cuda()` |
| 容错 | indep_dp + checkpoint transfer | 不支持 `recv_ckpt_src_rank` |
| 适用场景 | 大规模训练（PP/EP/TP） | 中小规模、快速迭代、HF 直接训练 |

FSDP2 降低使用门槛——不需 Megatron bridge 转换、不需理解 TP/PP/EP，直接用 HF checkpoint 启动。代价是不支持大规模并行。

## 模块间交互

`ray/` 层经 `actor_factory.py` 选择后端 actor；`rollout/server_group.py` import `SGLangEngine`。Megatron actor 持有 `weight_updater` 对象，通过 Ray RPC 调 SGLang engine 方法：P2P 路径 `engine.get_remote_instance_transfer_engine_info.remote(rank)` 取 RDMA 地址后 `TransferEngine.batch_transfer_sync_write()` 直写；Broadcast 路径 `engine.init_weights_update_group.remote()` 建 NCCL 组后 `engine.update_weights_from_distributed.remote()`。`backends/` 依赖 `miles/utils/` 的 `distributed_utils`/`memory_utils`/`timer`/`tensor_backper`/`ft_utils.indep_dp`/`replay_base`（R3）/`audit_utils`（witness）。

## 扩展方式

#### 新增一种并行策略（如 Expert DP）

`parallel.py` 的 `ParallelState` 加 `edp: GroupInfo` 字段；`megatron_utils/parallel.py` 的 `create_megatron_parallel_state()` 从 `mpu` 读取；`mixin.py` 的 `_gather_and_update_expert_weights()` 加 EDP 维度 all-gather；`arguments.py` 加 `--expert-dp-size`。

#### 换权重传输路径（如 GPU-direct P2P）

`actor.py:253-264` 的策略选择加分支；新建策略类继承 `DistBucketedWeightUpdateMixin` 实现 `_update_weight_implementation()`（直接 GPU→GPU RDMA 跳过 CPU pinned buffer）；`arguments.py` 的 `--update-weight-transfer-mode` choices 加新值；`sglang_engine.py` 加 `get_gpu_direct_transfer_engine_info()` RPC。

#### 新增模型架构的 Megatron→HF 转换

新建 `megatron_utils/megatron_to_hf/<arch>.py` 实现 `convert_to_hf()`；`megatron_to_hf/__init__.py:115` 注册表加映射；如有量化需求新建 `processors/quantizer_<arch>.py`；`update_weight/common.py:get_atomic_update_groups()` 为新架构注册原子更新组（如 fused QKV 需一起传输）。
