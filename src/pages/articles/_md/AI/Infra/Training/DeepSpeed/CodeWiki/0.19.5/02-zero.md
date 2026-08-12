---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "ZeRO 优化器"
date: "2026-08-12T15:35:32+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "ZeRO", "参数分片", "ZeRO-Offload", "显存优化"]
description: "ZeRO 是 DeepSpeed 的旗舰创新，通过将优化器状态、梯度、参数逐级分片消除数据并行冗余。本文解读 Stage 1/2/3 的分片机制、参数协调器的预取与 trace、以及 Offload 到 CPU/NVMe 的设计。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

ZeRO（Zero Redundancy Optimizer）是 DeepSpeed 的旗舰创新——通过将数据并行中的优化器状态（Stage 1）、梯度（Stage 2）、参数（Stage 3）逐级分片到多个 rank，消除冗余显存占用，使 N 张卡的聚合显存接近单卡的 1/N。ZeRO-3 进一步支持将状态 offload 到 CPU/NVMe（ZeRO-Offload / ZeRO-Infinity），突破 GPU 显存墙。

ZeRO 模块位于 `runtime/zero/`（13,900 行），包含两个核心类：`DeepSpeedZeroOptimizer`（Stage 1/2，参数完整驻留 GPU）和 `DeepSpeedZeroOptimizer_Stage3`（Stage 3，参数本身分片，需要按需 allgather）。Stage 3 引入了完全不同的参数管理范式——`DeepSpeedZeRoOffload` + `PartitionedParameterCoordinator` + hook 机制——因此独立成类而非用条件分支。

## 模块架构

```
DeepSpeedOptimizer (base_optimizer.py)
└── ZeROOptimizer (base_optimizer.py L250)
    ├── DeepSpeedZeroOptimizer (stage_1_and_2.py L134)     — Stage 1/2
    │   partition_gradients=False → ZeRO-1
    │   partition_gradients=True  → ZeRO-2
    └── DeepSpeedZeroOptimizer_Stage3 (stage3.py L149)      — Stage 3
        ├── DeepSpeedZeRoOffload (parameter_offload.py L130)
        │   └── PartitionedParameterCoordinator (partitioned_param_coordinator.py L73)
        └── Init (partition_parameters.py L923)             — 参数初始化时分片的上下文管理器
```

Stage 1/2 与 Stage 3 的本质差异：Stage 1/2 参数完整驻留 GPU，backward 中梯度即时 reduce；Stage 3 参数分片，forward/backward 需按需 allgather，引入 hook 机制和参数协调器。

## 调用链路

### ZeRO-3 训练迭代

```
FORWARD (per sub_module):
  _pre_forward_module_hook
    └── coordinator.fetch_sub_module(module, forward=True)
          ├── allgather 本 sub_module 参数 (NOT_AVAILABLE → AVAILABLE)
          ├── 预取后续 sub_module 参数（基于 trace）
          └── 等待本 sub_module 参数就绪
  >>> 执行 forward 计算 <<<
  _post_forward_module_hook
    └── coordinator.release_sub_module(module)  ← partition 释放

BACKWARD (per sub_module, 逆序):
  pre_bwd_fn → coordinator.fetch_sub_module(module, forward=False)
  >>> 执行 backward 计算 <<<
    └── gradient hook 触发:
        __reduce_and_partition_ipg_grads()       stage3.py L1539
          ├── __avg_scatter_grads() → reduce_scatter_coalesced()  ← 跨 DP rank 分片梯度
          └── partition_grads()                                     ← 写入本 rank 分区
  post_bwd_fn → coordinator.release_sub_module()

STEP (stage3.py L2574):
  _pre_step() → _partition_all_parameters()
  → _overflow_check_and_loss_scale_update()
  → for sub_group: _prepare_fp32_grad → unscale+clip → optimizer.step() → fp32→fp16 copy
  → _post_step() → allgather persistent params
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `step` in `stage3.py` L2574 | ZeRO-3 参数更新主流程 | 先 partition 所有参数再逐子组更新 |
| `__reduce_and_partition_ipg_grads` in `stage3.py` L1539 | 梯度 reduce-scatter + 分区 | 在独立 stream 上 overlap 通信 |
| `partition_grads` in `stage3.py` L1855 | 将梯度分片写入本 rank buffer | CPU offload 时 non_blocking copy |
| `_partition_all_parameters` in `stage3.py` L3026 | 确保所有参数分片 | step 前置条件 |
| `fetch_sub_module` in `partitioned_param_coordinator.py` L310 | allgather + 预取 + 等待 | 基于 trace 重放预取队列 |
| `release_sub_module` in `partitioned_param_coordinator.py` | partition 释放参数 | 控制峰值显存 |
| `reset_step` in `partitioned_param_coordinator.py` L251 | 重置 trace/预取队列 | RECORD→COMPLETE→INVALID 状态机 |
| `offload_states` in `stage3.py` L3553 | 优化器状态 GPU↔CPU 迁移 | checkpoint 时用 |

</details>

## 核心实现

### 参数分片与状态机

`Init` 上下文管理器（`partition_parameters.py` L923）在 `Parameter.__init__` 后立即分片，避免分配完整参数。每个参数被注入 `all_gather`、`partition`、`reduce_gradients_at_owner` 等方法，并通过 `ZeroParamStatus` 枚举跟踪状态：

```python title="runtime/zero/partition_parameters.py L230"
class ZeroParamStatus(Enum):
    NOT_AVAILABLE = 0   # 参数已分片，本 rank 无完整数据
    INFLIGHT = 1        # 正在 allgather 中
    AVAILABLE = 2       # 本 rank 有完整参数
```

**为什么用状态机**：ZeRO-3 的参数在 forward/backward 中频繁切换分片/完整状态，状态机让 hook 逻辑能判断当前状态决定是否需要 allgather，避免重复通信。

### PartitionedParameterCoordinator 的 trace 预取

协调器的核心创新是 **trace 记录与重放**——第一次 forward+backward 记录模块执行顺序，后续迭代按记录预取后续模块的参数，实现通信/计算 overlap：

```python title="runtime/zero/partitioned_param_coordinator.py L53-59"
class ZeRoTraceMode(Enum):
    RECORD = 0     # 第一次：记录模块顺序
    COMPLETE = 1   # 后续：按记录预取
    INVALID = 2    # trace 不匹配：重新记录
```

`fetch_sub_module` 的流程：allgather 当前模块参数 → 从 `__param_queue` 预取后续模块参数（最多 `__max_ongoing_fetch_events = 2` 并发）→ 等待当前模块参数就绪。`reset_step` 在每次 fwd+bwd 开始时调用，第一次 RECORD，后续 COMPLETE，trace 不匹配则 INVALID 重记录。

**为什么有并发 fetch 限制**：防止预取过多参数导致 OOM。2 是经验值——足够 overlap 通信延迟，又不过度占用显存。

### ZeRO-1/2 的梯度处理

Stage 1/2 参数完整驻留 GPU，backward 中梯度即时 reduce，不需要 per-module allgather：

```python title="runtime/zero/stage_1_and_2.py L222-223"
self.partition_gradients = partition_grads  # True=ZeRO-2, False=ZeRO-1
self.zero_stage_string = "ZeRO-2" if partition_grads else "ZeRO-1"
```

- **ZeRO-1**：`average_tensor()` → `all_reduce`（不分片梯度）
- **ZeRO-2**：`average_tensor()` → `reduce_scatter` + `copy_grads_in_partition()`（只保留本 rank 分片）

Stage 1/2 的 step 末尾调 `all_gather_dp_groups()` 同步所有更新后的 fp16 权重；Stage 3 不需要（参数始终分片，下次 forward 时按需 allgather）。

### Offload 到 CPU/NVMe

```python title="runtime/zero/offload_config.py L14-18"
class OffloadDeviceEnum(str, Enum):
    none = "none"
    cpu = "cpu"
    nvme = "nvme"
```

`_configure_offloading`（`stage3.py` L741-757）根据 config 设置 offload 设备。CPU offload 时 `self.device` 切到 CPU，梯度在 `partition_grads` 中通过 `non_blocking=True` 从 GPU 拷贝到 CPU。NVMe offload 通过 `OptimizerSwapper` / `PipelinedOptimizerSwapper`（`runtime/swap_tensor/`）做异步 swap。

**关键约束**（`stage3.py` L294-297）：fp16/bf16 master weights 必须搭配 CPU offload + `DeepSpeedCPUAdam`——因为需要 fused CPU 精度的 optimizer。

### Contiguous Memory Allocator

碎片化显存会导致 allgather/reduce_scatter 时分配大 buffer 失败。`contiguous_gradients=True`（`config.py` L102）将梯度复制到连续 buffer：

```python title="runtime/zero/stage3.py L125-137"
@dataclass
class IPGBucketZ3:
    buffer: Tensor  # 可复用的连续 buffer
    # ... 梯度在 buffer 上 narrow 出区域，避免反复分配
```

Stage3 还将所有 fp16 分片参数存于一个连续 `lp_param_buffer`（`stage3.py` L1217），避免碎片化。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略模式 | `engine.py` L2338 按 `ZeroStageEnum` 选 Stage1/2/3 | 三级分片策略互斥，按 stage 值分发 |
| 状态机 | `ZeroParamStatus` in `partition_parameters.py` L230 | 参数在分片/完整/传输中三态切换 |
| 协调器 | `PartitionedParameterCoordinator` | 封装 fetch/release/预取的全部复杂逻辑 |
| 上下文管理器 | `Init` in `partition_parameters.py` L923 | 在参数初始化时自动分片 |
| 上下文管理器 | `GatheredParameters` in `partition_parameters.py` L2288 | 临时 allgather 参数供外部访问 |

## 模块间交互

- **→ Comm**：`dist.all_gather`（参数聚合）、`reduce_scatter_coalesced`（梯度分片）、`dist.all_reduce`（溢出检测）
- **→ Accelerator**：`get_accelerator().Stream()` 创建 `reduce_and_partition_stream` 和 `allgather_stream`；`is_synchronized_device()` 判断设备行为
- **→ Ops**：`DeepSpeedCPUAdam`（`ops/adam/cpu_adam.py`）用于 CPU offload 时的 fused 优化器
- **→ Checkpoint**：`offload_states()` / `reload_states()` 在 checkpoint 时迁移优化器状态
- **→ Swap**：`OptimizerSwapper`（`runtime/swap_tensor/`）用于 NVMe offload 的异步 swap
- **被 Engine 调用**：`engine._configure_zero_optimizer` L2315 创建；`engine.backward` 调 `optimizer.backward_prologue/epilogue`

## 扩展方式

新增 offload 设备：`offload_config.py` `OffloadDeviceEnum` 加值 → `stage3.py` `_configure_offloading` 加处理逻辑 → `partition_parameters.py` `_partition_param` 加存储分配 → 可能需要新的 `Swapper` 类。

修改参数分片粒度：`partition_parameters.py` L1645 `_aligned_size`/`_partition_numel` 改分片大小计算；`parameter_offload.py` L196 `_set_z3_leaf_modules_by_threshold` 改 leaf module 粒度（影响 fetch/release 粒度）。`zero_hpz_partition_size`（`stage3.py` L200）已支持 HPZ（Hierarchical Partition ZeRO）多级分片。
