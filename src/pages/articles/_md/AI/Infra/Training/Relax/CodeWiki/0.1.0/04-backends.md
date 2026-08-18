---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "后端层"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "Megatron-LM", "SGLang", "权重同步", "TP/PP/CP/EP", "权重转换"]
description: "解读 Relax 后端层：MegatronTrainRayActor 训练 Actor 的前向/反向/权重广播、SGLangEngine 推理生命周期、HF↔Megatron 权重转换与三条权重同步路径（IPC/NCCL/DCS）。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/backends/`（17,660 行）是六层架构的后端层，管理 Megatron-LM 训练后端与 SGLang 推理后端的进程生命周期、权重转换与权重同步。它承载两个 god node 级核心抽象：`MegatronTrainRayActor`（44 边，训练 Ray Actor）与 `SGLangEngine`（54 边，推理引擎）。后端层不复用 Relax 的引擎层抽象——`SGLangEngine` 直接继承 `RayActor` 而非 engine 层基类，因为推理引擎是持久化 HTTP server 进程，生命周期/管理接口/容错语义与训练 engine 根本不同。后端层是 Relax 与底层框架（Megatron-LM / SGLang）的适配边界。

## 模块架构

后端层分两个子目录：`megatron/`（训练后端，含 actor/model/loss/data/cp_utils/weight_update/weight_conversion/megatron_patch/kernels）与 `sglang/`（推理后端，`sglang_engine.py`）。`MegatronTrainRayActor` 持有 model/optimizer/`TensorBackuper`/`weight_updater`/`checkpoint_engine_client`/`MegatronTrainStateOffloader`，承担前向/反向/更新/权重广播全部职责；`SGLangEngine` 持有 SGLang server 进程，管理 router 注册/KV cache/权重加载/扩缩容。两者通过三条权重同步路径耦合：colocate 走 CUDA IPC、disaggregated 走 NCCL broadcast、fully_async 走 DCS。

```
backends/
├── megatron/                          训练后端
│   ├── actor.py (2269)   MegatronTrainRayActor：train_actor/train_critic/train_hybrid/update_weights
│   ├── model.py (1777)   forward_only/train_one_step/initialize_model_and_optimizer/save_hf_model
│   ├── loss.py (1466)    compute_advantages_and_returns/get_log_probs_and_entropy/policy_loss_function
│   ├── data.py (1222)    DataIterator/数据预处理/get_batch
│   ├── cp_utils.py (714) Context Parallel 工具
│   ├── weight_update/
│   │   ├── hf_weight_iterator_bridge.py (704)  HfWeightIteratorBridge（AutoBridge 转换）
│   │   ├── update_weight_from_tensor.py        colocate: CUDA IPC 路径
│   │   └── update_weight_from_distributed.py   disaggregated: NCCL broadcast 路径
│   ├── weight_conversion/             手写 per-model 转换（raw 模式）
│   ├── megatron_patch/ mbridge/       Megatron Bridge 集成
│   └── kernels/                       自定义算子
└── sglang/
    └── sglang_engine.py (1515)  SGLangEngine + GenRMEngine（推理生命周期）
```

## 调用链路

一次训练 step 在 `MegatronTrainRayActor` 内的调用链（`train_actor`）：

```
train(rollout_id)                                       # actor.py:612
  → wake_up() (if offload_train)                        # 重载权重 + reload_process_groups
  → _get_data_from_transfer_queue()                     # TQ GET 训练数据
  → train_actor(rollout_id, rollout_data)               # actor.py:785
      → get_data_iterator(args, model, rollout_data)    # 分 micro-batch
      → [Phase 1 前向] _switch_model("ref") → compute_log_prob("ref_")
                       _switch_model("teacher") → compute_log_prob("teacher_")
                       _switch_model("actor") → compute_log_prob("")  # old log_probs
      → [Phase 2 优势] compute_advantages_and_returns(args, rollout_data)  # loss.py
      → [Phase 3 训练] train(rollout_id, model, optimizer, ...)         # model.py
          → for step_id: train_one_step(...)                            # model.py:946
              → forward_step → Megatron forward_backward_func (1F1B + CP)
              → finalize_model_grads → optimizer.step()
      → [Phase 4 备份] weights_backuper.backup("actor")
      → [Phase 5 权重同步] update_weights()                             # actor.py:1611
  → sleep() (if offload_train)                          # 让出 GPU
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MegatronTrainRayActor.init` | 初始化 Megatron 分布式/模型/优化器/权重通道 | 支持 sleep/wake（offload 状态到 CPU + 销毁/重建 NCCL 组） |
| `train_actor` | RL 训练全流程 | `_switch_model` 在 actor/ref/teacher 间切换（TensorBackuper） |
| `train_one_step` | 单步 1F1B pipeline 训练 | 含 CP all-gather、`forward_backward_func` |
| `update_weights` | 权重同步到 SGLang | colocate 走 IPC，disaggregated 走 NCCL，fully_async 走 DCS |
| `update_weights_fully_async` | DCS 权重同步 | `checkpoint_engine_client.update_weights_for_rollout` |
| `SGLangEngine.init` | 启动 SGLang HTTP server | `launch_server_process` + 注册 router/DCS |
| `SGLangEngine.update_weights_from_tensor` | IPC 接收权重 | colocate 模式 CUDA IPC |
| `SGLangEngine.update_weights_from_distributed` | NCCL 接收权重 | disaggregated 模式 broadcast |
| `SGLangEngine.release/resume_memory_occupation` | KV cache offload/onload | 配合 Megatron sleep/wake 时分共享 GPU |

</details>

## 核心实现

### MegatronTrainRayActor：训练与 sleep/wake

`MegatronTrainRayActor`（`actor.py:147`）继承 `TrainRayActor`，是 Megatron-LM 训练的 Ray Actor 封装。关键属性：`self.model`/`self.optimizer`/`self.opt_param_scheduler`（Megatron 三件套）、`self.weights_backuper`（`TensorBackuper`，多模型权重备份用于 colocate `_switch_model` 角色切换）、`self.weight_updater`（`UpdateWeightFromTensor` 或 `UpdateWeightFromDistributed`，取决于 colocate）、`self._train_state_offloader`（`MegatronTrainStateOffloader`，sleep/wake 时 offload/reload）、`self.checkpoint_engine_client`（DCS 客户端，fully_async）。

colocate 模式的 sleep/wake 是核心机制：`sleep()` 把训练状态 offload 到 CPU 并 `destroy_process_groups` 销毁 NCCL 组（释放 GPU 显存引用，否则 SGLang 无法分配 KV cache，cuMemCreate OOM）；`wake_up()` 重载状态并 `reload_process_groups` 重建 NCCL 组。`ReloadableProcessGroup`（`utils/reloadable_process_group.py:133`）通过 `monkey_patch_torch_dist` 拦截 `dist.new_group()` 包装为可重载 group，记录 ranks 以便重建，带 3 次重试应对 NCCL socket TIME_WAIT。

`_switch_model`（`actor.py`）用 `TensorBackuper` 在 actor/ref/teacher/old_actor 间切换权重——colocate 模式下这些角色共享同一物理模型，通过备份/恢复权重实现"角色切换"而非部署独立服务。hybrid 模式的 `train_hybrid`（`actor.py:1227`）分三阶段：收 sub-batch 做 ref/actor forward → 合并算 advantages → 全量训练。

### SGLangEngine：推理生命周期

`SGLangEngine`（`sglang_engine.py:325`）继承 `RayActor`，封装 SGLang 推理引擎生命周期。`init`（`:325`）启动 SGLang HTTP server 进程（`launch_server_process`），注册到 router 与 DCS。权重管理：`init_weights_update_group`（建 NCCL 通信组）、`update_weights_from_distributed`（NCCL broadcast 接收）、`update_weights_from_tensor`（CUDA IPC 接收）。内存管理：`release_memory_occupation`/`resume_memory_occupation`（KV cache offload/onload）、`flush_cache`、`abort_requests`。生成控制：`pause_generation`/`continue_generation`（暂停/恢复请求准入，权重同步时用）。扩缩容：`is_evicted`（SIGTERM 驱逐标记）、`shutdown`、`simulate_crash`、`init_weights_send_group_for_remote_instance`/`send_weights_to_remote_instance`（跨实例权重发送，用于弹性扩容的新引擎）。`GenRMEngine`（`:1134`）继承 `SGLangEngine`，重写 `init` 与 `release_memory_occupation`（带更严格 drain 超时），作为 GenRM judge LLM 专用引擎。

### 权重转换：HF ↔ Megatron

`weight_conversion/__init__.py:43` `convert_to_hf` 与 `weight_update/hf_weight_iterator_bridge.py` 提供两种适配器：**直接适配器** `HfWeightIteratorDirect`（手写 per-model 转换，按 `model_name` 分派，支持 llama/qwen2/qwen3/qwen3moe/qwen3vl/qwen3omni/glm4/glm4moe/deepseekv3 等十余种）与 **Bridge 适配器** `HfWeightIteratorBridge`（用 `megatron.bridge.AutoBridge` 自动发现转换映射）。`HfWeightIteratorBase.create(args, model)` 工厂按 `args.megatron_to_hf_mode`（`"raw"`/`"bridge"`）选择。`BridgeConverter`（`bridge_converter.py:27`）调 `AutoBridge.from_hf_pretrained` + `get_conversion_tasks` 拿转换任务，`task.convert(param)` 做megatron-sharded→HF-format。

`HfWeightIteratorBridge._iter_hf_params`（`:64`）两条路径：Expert 权重走 `load→TP gather+convert(src_rank only)→PP+EP broadcast`（quantize-before-broadcast 减少传输量）；Non-expert 走 `PP/EP broadcast(BF16)→TP all-gather→bridge convert`。`_chunk_with_mla_pairing` 确保 MLA 的 `q_a_proj`/`kv_a_proj_with_mqa` 在同一 chunk（SGLang 的 `do_load_weights` 会 fuse 这两个权重）。

### 三条权重同步路径

`update_weights`（`actor.py:1611`）按模式选三条路径之一：

| 模式 | 传输方式 | 通信组 | 代码位置 |
| --- | --- | --- | --- |
| colocate | CUDA IPC + Ray ObjectRef | Gloo（CPU gather） | `UpdateWeightFromTensor._send_hf_params` |
| disaggregated | NCCL broadcast | `slime-pp_{pp_rank}` | `UpdateWeightFromDistributed._update_bucket_weights_from_distributed` |
| fully_async | DCS coordinator + NCCL | DCS-managed | `checkpoint_engine_client.update_weights_for_rollout` → `DeviceDirectBackend` |

colocate 路径：`FlattenedTensorBucket.flatten` → `MultiprocessingSerializer.serialize` → `dist.gather_object(gloo)` 汇聚到 gather src rank → `engine.update_weights_from_tensor.remote(serialized)`（Ray IPC 传 GPU tensor）。同步协议统一为 `pause_generation → flush_cache → update → continue_generation`，`weight_version` 原子递增。选 NCCL/IPC 而非文件 checkpoint 是因为 RL 每 step 都需同步权重（`_per_step_rollout=True` when RL mode，`actor.py:149`），文件 checkpoint 秒级延迟不可接受，NCCL/IPC 毫秒级 GPU→GPU 直传。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 适配器（HF↔Megatron） | `BridgeConverter` + `convert_to_hf` in `weight_conversion/`、`weight_update/` | 参数命名/布局/分片互转，同 checkpoint 跨框架 |
| Ray Actor | `MegatronTrainRayActor`/`SGLangEngine` 继承 `TrainRayActor`/`RayActor` | 跨 actor `ray.get(method.remote())`，训练/推理节点独立 |
| 策略（权重加载器） | `UpdateWeightFromTensor`/`UpdateWeightFromDistributed` in `actor.py:278` | colocate 选 IPC、disaggregated 选 NCCL |
| 工厂 | `HfWeightIteratorBase.create` in `hf_weight_iterator_base.py:6` | 按 `megatron_to_hf_mode` 选 raw/bridge |
| 策略（offload） | `_TmsOffloadStrategy`/`_SelectiveOffloadStrategy` in `train_offload.py` | 按 torch_memory_saver 是否 LD_PRELOAD 选 VMM pause 或应用级 offload |

## 模块间交互

backends 依赖 `distributed.checkpoint_service.client`（DCS 客户端）、`distributed.ray`（`TrainRayActor`/`RayActor` 基类）、`utils`（`ReloadableProcessGroup`/device/Sample/`TensorBackuper`/stream_dataloader/s3_model_loader/opd/`RoutingReplay`）、`engine.sft`（SFT 评估）、`models`（模型定义）。被 `components` 调用（`allocate_train_group` 创建 `MegatronTrainRayActor`，`RolloutManager` 管理 `SGLangEngine`）。Megatron↔SGLang 权重同步通过 `distributed` 层的 DCS/NCCL 间接完成，是 backends 与 distributed 双向依赖的根源。详见概览「模块地图」。

## 扩展方式

- **支持新并行策略**：`initialize.py` `init`/`_initialize_distributed` 加 parallel size 参数；`actor.py` `_init` 的 `train_parallel_config` 加维度；`cp_utils.py` 加 CP 辅助；`hf_weight_iterator_bridge.py` `_build_param_info_buckets` 加参数元数据交换
- **接入新推理后端**：新建 `backends/vllm/vllm_engine.py` 参照 `SGLangEngine` 实现 `init`/`update_weights_from_tensor`/`update_weights_from_distributed`/`release_memory_occupation`/`pause_generation`/`register_to_router`；适配 `update_weight_from_tensor.py`/`update_weight_from_distributed.py` 的传输格式
- **支持新模型权重转换**：`weight_conversion/` 新建 `{model}.py` 实现 `convert_{model}_to_hf` + `__init__.py:43` `_convert_to_hf_core` 加分支；新量化在 `weight_conversion/processors/` 加 `quantizer_{method}.py`
