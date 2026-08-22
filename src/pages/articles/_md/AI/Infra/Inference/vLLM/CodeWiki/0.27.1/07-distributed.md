---
source:
  type: "源码解读"
  project: "vLLM"
  url: "https://github.com/vllm-project/vllm"
title: "分布式推理与平台"
date: "2026-08-22T18:02:27+08:00"
category: [AI, Infra, Inference, vLLM, CodeWiki, "0.27.1"]
tags: ["vLLM", "分布式", "Tensor Parallel", "NCCL", "Custom AllReduce", "Platform 抽象"]
description: "解读 vLLM 分布式与平台抽象模块：GroupCoordinator 管并行组、DeviceCommunicator 多 backend 级联 dispatch、Platform 屏蔽 N 种硬件、shm 广播与 EP all-to-all。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview)

---

## 模块定位

分布式与平台模块（`vllm/distributed/` + `vllm/platforms/`）屏蔽底层硬件与通信差异，让上层模型代码只写 `tensor_model_parallel_all_reduce(x)` 而不关心是 NCCL、自定义 P2P 还是共享内存。它管理五种并行维度（TP/PP/EP/CP/DP）的进程组，提供 7 种 all-reduce backend 的级联 dispatch，并用 `Platform` 抽象声明 40+ 项硬件能力——从 dtype 支持到 attention backend 选择，是 vLLM "一套代码跑 N 种硬件"的基石。

## 模块架构

![分布式与平台抽象](/vibe-reading/images/articles/vllm/07-distributed.svg)

模块三层：`Platform`（abstract，`platforms/interface.py:134`）声明硬件能力，`__init__.py` 用 lazy 检测 + OOT 插件选一个激活（CUDA/ROCm/CPU/XPU/TPU）；`GroupCoordinator`（`parallel_state.py:380`）封装 PyTorch ProcessGroup，同时持 `cpu_group`（gloo，元数据通信）与 `device_group`（NCCL，GPU tensor），通过 `platform.get_device_communicator_cls()` 实例化 `DeviceCommunicator`；`CudaCommunicator`（`cuda_communicator.py:29`）的 `all_reduce` 按 7 种 backend 优先级级联 dispatch，每个 backend 有 `should_*` 门控，不适用则 fall through。

## 调用链路

进程启动时初始化并行状态：

```
Worker.init_device()                              # gpu_worker.py
└─ init_distributed_environment(world_size, rank, ...)  # parallel_state.py:1588
   └─ torch.distributed.init_process_group(backend=platform.dist_backend)
└─ ensure_model_parallel_initialized(tp_size, pp_size, ...)  # parallel_state.py:1992
   └─ initialize_model_parallel()
      ├─ all_ranks = arange(world_size).reshape(DP, PP, PCP, TP)  # layout: ExternalDP×DP×PP×PCP×TP
      ├─ _TP = init_model_parallel_group(tp_ranks, ...)
      ├─ _PP = init_model_parallel_group(pp_ranks, ...)
      ├─ _EP = init_model_parallel_group(ep_ranks, ..., use_all2all=...)
      └─ _DP/_DCP/_PCP/_EPLB = ...
```

模型 forward 时一次 all-reduce：

```
RowParallelLinear.forward()
└─ tensor_model_parallel_all_reduce(output_parallel)   # parallel_state.py
   └─ _TP.all_reduce(input_)
      └─ device_communicator.all_reduce(input_)         # parallel_state.py:662
         └─ CudaCommunicator.all_reduce(input_)          # cuda_communicator.py:275
            ├─ try NCCL symm_mem all-reduce
            ├─ try QuickAllReduce (ROCm MI300)
            ├─ try FlashInferAllReduce
            ├─ try CustomAllreduce (vLLM 自研 NVLink P2P)
            ├─ try SymmMemCommunicator
            └─ fallback: PyNcclCommunicator.all_reduce / dist.all_reduce
```

数据流：分片 tensor → 各 rank `device_communicator.all_reduce` → 聚合 tensor。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `init_distributed_environment` | 初始化 torch.distributed | 考虑 DP 偏移 |
| `initialize_model_parallel` | 创建各并行组 | layout reshape |
| `GroupCoordinator.all_reduce` | TP all-reduce | custom op 注册 |
| `CudaCommunicator.all_reduce` | 7-backend 级联 dispatch | 每个 backend 有门控 |
| `Platform.get_device_communicator_cls` | 返回通信器类路径 | 基类返 DeviceCommunicatorBase |
| `Platform.get_attn_backend_cls` | 返回 attention backend | 按硬件+模型选 |

</details>

## 核心实现

### GroupCoordinator 与并行组布局

`GroupCoordinator`（`parallel_state.py:380`）同时持 `cpu_group`（gloo，对象级通信）与 `device_group`（NCCL，GPU tensor），外加 `device_communicator`（平台特定）与 `mq_broadcaster`（TP 组内共享内存广播）。全局单例 `_TP`/`_PP`/`_EP`/`_DP`/`_DCP`/`_PCP`/`_EPLB`，layout 顺序 `ExternalDP × DP × PP × PCP × TP`（`initialize_model_parallel` L1812 的 rank reshape），每种并行维度经转置+reshape 提取对应 rank 子集；EP 组由 `DP × PCP × TP` 组合而成。

### 自定义 all-reduce 与 shm 广播

为什么自定义 all-reduce：NCCL 在小 tensor + 少 GPU 场景非最优。`CustomAllreduce`（`custom_all_reduce.py:56`）用 NVLink P2P 直连 + 共享内存 + 自旋等待绕过 NCCL 软件栈开销。约束：`_SUPPORTED_WORLD_SIZES = [2,4,6,8,16]`、同节点、P2P 可达（`can_device_access_peer`）、NVLink 全互联，超限 fall back NCCL。`shm_broadcast` 的 `MessageQueue`（`shm_broadcast.py:465`）解决 TP 组内 rank 0 向其他 rank 广播小对象（KV cache metadata、采样参数）——用 POSIX 共享内存 ring buffer（`ShmRingBuffer` 无锁）+ ZMQ PUB/SUB 通知，reader 自旋或休眠等待，避免 `dist.broadcast_object_list` 的 gloo 序列化阻塞。

### Platform 抽象与 lazy 检测

`Platform`（`interface.py:134`）有 40+ 个 `@classmethod` 覆盖 device 识别、dtype 支持、attention backend 选择、quantization 支持、`get_device_communicator_cls` 等，子类只覆写需特化的方法。`platforms/__init__.py` 的 `builtin_platform_plugins`（`tpu`/`cuda`/`rocm`/`xpu`/`cpu`）各自有检测函数，`current_platform` 在首次访问时经 `__getattr__` 触发检测、遍历 plugin、**只允许一个激活**，支持 OOT 插件经 `PLATFORM_PLUGINS_GROUP` entry point 注册。`CudaPlatformBase.get_device_communicator_cls` 返回 `CudaCommunicator`，`GroupCoordinator.__init__` 经 `resolve_obj_by_qualname` 动态加载。

### EP all-to-all 与多进程 executor 配合

EP 组的 `use_all2all=True` 时，`CudaCommunicator.__init__` 创建 `All2AllManager`，支持 8 种后端：`naive`（all-gather+reduce-scatter 模拟）、`deepep_high_throughput`/`deepep_low_latency`/`deepep_v2`、`mori`、`nixl_ep`、`flashinfer_nvlink` 等。分布式与 v1/engine executor 配合：多进程 executor fork/spawn Worker 进程并设环境变量，`parallel_state` 在每进程内独立初始化，`Platform.set_assigned_physical_gpu_ids` 让 executor 精确控制每 worker 看到的物理 GPU。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 抽象基类 + 多实现 | `Platform`/`DeviceCommunicatorBase`/`All2AllManagerBase` | 屏蔽 N 种硬件/通信 |
| 工厂 + 注册 | `builtin_platform_plugins` + OOT entry point | lazy 检测选平台 |
| 单例 | `_TP`/`_PP`/`_EP` 全局变量 in `parallel_state.py` | 进程级并行状态 |
| 责任链 | `CudaCommunicator.all_reduce` 7-backend dispatch | 按 tensor 特性选最优 backend |

## 模块间交互

被 `model_executor/layers` 调用（TP linear 层 `get_tp_group().all_reduce`）、被 `v1/worker` 调用（`init_distributed_environment` + `ensure_model_parallel_initialized`）、被 `config` 初始化调用（`Platform.check_and_update_config`/`apply_config_platform_defaults`）。`GroupCoordinator.get_device_communicator_cls` 被 `GroupCoordinator.__init__` 调用实例化通信器（L504），`_groups` dict + weakref 注册所有活跃组供 `all_reduce` custom op 查找。`v1/attention` 也依赖 distributed 的通信（EP all-to-all）。

## 扩展方式

新增硬件平台：实现 `Platform` 子类（`platforms/<new>.py`，覆写 `device_name`/`dist_backend`/`get_device_communicator_cls`/`get_attn_backend_cls` 等能力声明）；若通信需自定义后端，继承 `DeviceCommunicatorBase` 覆写 `all_reduce` 等；在 `platforms/__init__.py` 的 `builtin_platform_plugins` 加检测函数或用 OOT entry point。新增通信原语（如 all-reduce backend）：建 `device_communicators/<new>_all_reduce.py`（含 `should_<new>` 门控 + `<new>_all_reduce` 方法），在 `CudaCommunicator.__init__` 加初始化与 `self.<new>_comm`，在 `all_reduce` dispatch 链插 try-fallback 分支，在 `_log_all_reduce_backend_selection` 的 `all_potential_ar_backends` 加名。
