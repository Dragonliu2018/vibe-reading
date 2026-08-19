---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "Rollout 数据生成"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "SGLang", "rollout", "PD 分离", "GRPO"]
description: "slime 的 rollout 层：可插拽数据生成契约、SGLang 引擎拓扑、Sample 到训练数据的转换与 DP 切分。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

rollout 层是 slime 的"灵活数据生成"支柱，由 `slime/rollout/`（生成与转换逻辑）+ `slime/backends/sglang_utils/`（SGLang 引擎生命周期）+ `slime/ray/rollout.py`（`RolloutManager` 编排者）共同构成。它解决三个问题：**如何让任意 workflow 接入数据生成**（可插拔契约）、**如何把 SGLang 引擎组织成可服务、可分离、可恢复的拓扑**、**如何把生成出的 `Sample` 转成训练侧能直接消费的 `RolloutBatch` 并按 DP 切分**。math、code、search、tool、sandbox、verifier、多 agent、长程 agentic 工作流都作为"返回 `Sample` 列表的函数"接入这里，不分叉训练内核。

## 模块架构

![Rollout 层组件](/vibe-reading/images/articles/slime-internals/rollout-flow.svg)

文字上，`RolloutManager`（`slime/ray/rollout.py`）是中心编排者，它是 1 CPU 0 GPU 的 Ray actor，持有四类对象：`servers`（`dict[str, RolloutServer]`，每个是一台 router 后的模型）、`data_source`（`DataSource` 实例，管理 prompt 与可选回放 buffer）、`generate_rollout` / `eval_generate_rollout`（`load_function` 动态加载的生成函数）、以及可选的 `custom_reward_post_process_func` / `custom_convert_samples_to_train_data_func`。`RolloutServer` 之下是 `ServerGroup`（同构引擎组，区分 regular/prefill/decode/placeholder），再下是 `SGLangEngine`（`slime/backends/sglang_utils/sglang_engine.py`，每个引擎一个 Ray actor）。这套三层结构（Server→Group→Engine）是 PD 分离与多模型服务的基础——一个 `RolloutServer` 可含多个不同 TP 配置的 `ServerGroup`。

## 调用链路

`RolloutManager.generate(rollout_id)` 是一条"取数 → 生成 → 转换 → 切分"的链路，每一步都把数据结构往前推一格：

```text
generate(rollout_id)                                      # ray/rollout.py
  └─ _get_rollout_data(rollout_id)                        # 调可插拔 generate_rollout 或加载 debug 数据
      └─ call_rollout_fn(self.generate_rollout, ...)      # base_types.py 契约包装
          └─ generate_and_rm / generate (sglang_rollout.py)  # SGLang /generate + reward
              └─ Sample.append_response_tokens           # 增量回填 tokens/log_probs/routed_experts
      └─ _validate_rollout_id_annotated(data)            # 校验 rollout_id 契约
  └─ _convert_samples_to_train_data(samples)              # Sample[] → RolloutBatch dict
      └─ _post_process_rewards(samples)                   # GRPO/GSPO/CISPO 组归一化
      └─ 补 rollout_mask_sums / rollout_log_probs / routed_experts / teacher_log_probs
  └─ _split_train_data_by_dp(data)                        # build_dp_schedule → per-rank Box
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `RolloutManager.generate` in `ray/rollout.py` | rollout 入口：取数→转换→切分 | `debug_rollout_only` 跳过转换直接返回 |
| `_get_rollout_data` in `ray/rollout.py` | 调生成函数或加载 debug 数据 | `_validate_rollout_id_annotated` 强制 rollout_id 契约 |
| `_post_process_rewards` in `ray/rollout.py` | 奖励组归一化 | GRPO/GSPO/CISPO 按 prompt 组 mean/std 归一 |
| `_convert_samples_to_train_data` in `ray/rollout.py` | `Sample[]` → `RolloutBatch` dict | 预算 `rollout_mask_sums` 作损失归约分母 |
| `_split_train_data_by_dp` in `ray/rollout.py` | DP 切分打包 per-rank Box | `build_dp_schedule` 纯 Python 可单测；NIXL 或 object-store 传输 |
| `ServerGroup.start_engines` in `ray/rollout.py` | 创建引擎 Ray actor + 端口分配 | 返回 init handle 让调用方 `ray.get` 阻塞，端口游标跨 group 防冲突 |
| `RolloutServer.recover` in `ray/rollout.py` | 死引擎恢复 + 权重重载 | 重叠 init，offload 后 resume weights |
| `SGLangEngine.update_weights_from_*` in `sglang_engine.py` | 四种权重更新入口 | 与 `update_weight/` 四路径一一对应 |

</details>

## 核心实现

### 可插拽数据生成契约

slime 的"最大数据生成自由度"由几个点式路径字符串契约支撑，全部经 `slime/utils/misc.py` 的 `load_function` 动态加载。`RolloutManager.__init__` 加载 `rollout_function_path` / `eval_function_path` / `data_source_path` / `custom_reward_post_process_path` / `custom_convert_samples_to_train_data_path`。生成函数的契约定义在 `slime/rollout/base_types.py`：

```python title="rollout/base_types.py"
@dataclass
class RolloutFnTrainOutput:
    samples: list[list[Sample]]      # 外层=步内多个 rollout，内层=一个 rollout 的多个 sample
    metrics: dict[str, Any] = None

@dataclass
class RolloutFnEvalOutput:
    data: dict[str, dict[str, Any]]
    metrics: dict[str, Any] = None
```

`call_rollout_fn` 做向后兼容包装：老式直接返回 `list[list[Sample]]` 的函数会被包成 `RolloutFnTrainOutput`。`list[list[Sample]]` 的双层结构支持"一个 rollout 产出多个训练样本"（compact / subagent 场景），`_get_rollout_data` 最后会把嵌套 list flatten。`DataSource` ABC（`slime/rollout/data_source.py`）定义 `get_samples` / `add_samples` / `save` / `load` / `__len__` 五个方法，`RolloutDataSource` 是只读 prompt 源（管理 epoch / shuffle / offset，把每个 prompt 扩展成 `n_samples_per_prompt` 个 sample 组），`RolloutDataSourceWithBuffer` 在其上叠加回放 buffer——`get_samples` 先从 buffer 取（用可插拔 `buffer_filter`，默认 `pop_first`），不够再从 prompt 源取。这就是 README 所说的 Data Buffer，桥接离线与 on-policy 数据。

### SGLang 生成：token 级增量回填

`slime/rollout/sglang_rollout.py` 是默认的生成实现。`GenerateState` 是个单例（`SingletonMeta`），持有 tokenizer / processor、`asyncio.Semaphore`（并发 = `sglang_server_concurrency × num_engines`）、sampling_params、以及 DP rank 负载均衡计数器。`generate` 函数向 SGLang router 的 `/generate` 发 POST，payload 里 `return_logprob=True`（拿回 log_probs 作 off-policy 修正）、`use_rollout_routing_replay` 时 `return_routed_experts=True`（拿回 MoE expert 路由作训练侧重放）。多模态样本走 `image_data`，单轮多模态发 text 让 SGLang 自己展开 image placeholder。

关键在 `Sample.append_response_tokens`（`slime/utils/types.py`）——这是多轮/增量生成的契约入口：模型生成 token 传 `trainable=True` + log_probs（自动补 loss_mask 1），工具/环境 token 传 `trainable=False`（自动补 loss_mask 0 与空 top-p span）。`_apply_meta_info` 处理 top-p 路由 token 的 ragged offsets 合并、routed_experts 的 reshape（按 `num_layers × moe_router_topk`）与部分追加、finish_reason 到 `Sample.Status`（TRUNCATED/ABORTED/COMPLETED）的映射、speculative 与 prefix cache 统计。`generate_and_rm` 在 generate 前对 `partial_rollout` 场景把已有 response 的 loss_mask 清零（掩掉上一轮 off-policy 生成），并支持 per-sample `generate_function_path`（来自 eval dataset config）与 `custom_generate_function_path`。`session_id` 在 `router_policy=="consistent_hashing"` 时通过 `X-SMG-Routing-Key` header 实现多轮 agent 的会话亲和路由。

### 引擎拓扑与 PD 分离

`ServerGroup`（`ray/rollout.py`）是同构引擎组：所有引擎共享 `num_gpus_per_engine` / `worker_type`（regular/prefill/decode/placeholder）/ `sglang_overrides`。`needs_offload` 标记这组的 GPU 是否与 Megatron 重叠（colocate 时 True，需 offload/onload 显存）。`start_engines` 创建 `ray.remote(SGLangEngine)` actor（`num_gpus=0.2`），逐引擎按 `gpu_offset` 从 placement group 取物理 GPU，注入一批 SGLang env 默认值（如 `SGLANG_MEMORY_SAVER_CUDA_GRAPH`），返回 init handle 让调用方阻塞等待健康——端口分配用 `_allocate_rollout_engine_addr_and_ports_normal`，`port_cursors` 跨 group 传递防同节点端口冲突。

`RolloutServer` 是"一个 router 后的一个模型"，可含多个 `ServerGroup`（如 prefill TP=2 + decode TP=4）。这正是 PD 分离：`slime/backends/sglang_utils/sglang_config.py` 的 `SglangConfig` / `ModelConfig` / `ServerGroupConfig` 支持从 YAML 加载拓扑专属配置（`has_pd_disaggregation` / `has_encoder_disaggregation`），也可由 `from_prefill_num_servers` 推导。`SGLangEngine`（`sglang_engine.py`）是引擎的 Ray actor 包装，`init` 分 normal 与 external 两条路（external 引擎由训练作业外部托管，`_init_external` 只校验字段不真正起进程），`_register_to_router` 把自己注册到 router。它暴露权重同步四入口（`update_weights_from_tensor` / `update_weights_from_distributed` / `update_weights_from_disk` / `pull_weights`）、显存生命周期（`release_memory_occupation` / `resume_memory_occupation` 带 tags 区分 WEIGHTS/KV_CACHE/CUDA_GRAPH）、生成控制（`pause_generation` / `continue_generation` / `flush_cache`）。

### Sample → RolloutBatch 转换：rollout_mask_sums 的正确性防护

`_convert_samples_to_train_data` 把 `Sample` 列表转成 `RolloutBatch` dict。基础字段直接取（`tokens` / `response_lengths` / `rewards` / `raw_reward` / `truncated` / `sample_indices` / `rollout_ids` / `loss_masks`）。`_post_process_rewards` 在 GRPO/GSPO/CISPO/REINFORCE++_baseline 且 `rewards_normalization` 开启时做组归一化：把 reward 按 `n_samples_per_prompt × rollout_batch_size` reshape 成 prompt 组，减 mean（GSPO/CISPO/GRPO 可选再除 std）。奖励的归一化在 rollout 侧做一次，训练侧不再重算。

最值得讲的设计是 `rollout_mask_sums`。训练侧的损失归约是"每个 rollout 取 token 加权平均"，分母是该 rollout 所有 sample 的 loss_mask 之和。但 `_split_train_data_by_dp` 用 first-fit 打包，可能把一个 rollout 的多个 sample 拆到不同微批。如果分母在微批内局部计算，被拆开的 rollout 的损失就会被错算。所以 `_convert_samples_to_train_data` 在**步骤级**（能看到该步全部 sample 时）预先预算每个 rollout 的 `rollout_mask_sums`，广播到每个 sample，训练侧的 loss reducer 直接拿它当分母——跨微批求和后仍得到正确的整 rollout token 加权均值。这是典型的"RL 静默 bug"防护点：算错不报错，只让曲线变差。按需附加的字段：`rollout_log_probs`（off-policy 修正）、`rollout_top_p_token_ids/offsets`（top-p 路由重放）、`rollout_routed_experts`（MoE 路由重放，配合 `use_routing_replay`）、`teacher_log_probs`（OPD）、`multimodal_train_inputs`、`source_names`。

### DP 切分：纯 Python 可单测的调度

`_split_train_data_by_dp` 把 `RolloutBatch` 按 DP rank 切分打包成 `Box`。调度核心 `build_dp_schedule` in `slime/utils/dp_schedule.py` 刻意写成**纯 Python、不 import ray/sglang**，这样能在 CPU-only CI 单测。它的"pack first, distribute second"策略（模块 docstring 列了 4 条不变量并由测试断言）：

1. 按 `rollout_id` 分组（一个 rollout 的所有 sample 留在同一 step，保证 per-rollout loss reducer 良定义），按 `global_batch_size` rollout/step 切 step；
2. 每个 step 内 first-fit 动态打包（或定长静态）成 K 个微批；
3. 把 K 对齐到 `dp_size × mb_group`（VPP>1 时）的倍数，保证每个 rank 微批数相同（PP 同步要求）；
4. 跨 rank 分发：`balance_data` 开启时用 Karmarkar-Karp 按 FLOPs 均衡，否则 strided round-robin。

打包后 `Box(ray.put(rollout_data))` 或 NIXL（`rollout_data_transport=="nixl"` 时 `_tensor_transport="nixl"`，GPU 间张量直传绕过 object store）。

### 故障容错与引擎恢复

`RolloutHealthMonitor`（`slime/utils/health_monitor.py`）每个 `ServerGroup` 一个，后台线程周期性 `_run_health_checks` → `_check_engine_health`（调 `engine.health_generate` 探活），失活则 `_kill_engine`（置 None 标记死）。`generate` 前 `health_monitoring_resume`，`update_weights` 前 `recover_updatable_engines` 调 `RolloutServer.recover`：对死引擎跨 group 并发 `start_engines` 重叠 init，恢复后 offload 再 resume weights，新引擎会被纳入下次 weight update 的 `num_new_engines`。`_try_ci_fault_injection` 在 CI 下注入 `simulate_crash` 验证这套恢复路径。这套机制让长程训练在单引擎崩溃时自愈，不中断循环。

## 扩展方式

接入新 workflow：实现一个返回 `RolloutFnTrainOutput`（`samples: list[list[Sample]]`）的函数，用 `--rollout-function-path` 传入。多轮场景用 `Sample.append_response_tokens(trainable=...)` 增量追加，并在拆分出的 sibling sample 上设同一个 `rollout_id`（否则损失归约会多算 N 倍）。`examples/` 下的 coding_agent_rl / search-r1 / tau-bench / multi_agent / retool 是现成模板。替换数据源：继承 `DataSource`，用 `--data-source-path` 传入。配置 PD 分离：写 `sglang-config` YAML，用 `--sglang-config` 传入（见 `docs/en/advanced/sglang-config.md`）。
