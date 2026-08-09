---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "Speculative Decoding"
date: "2026-08-09T23:30:00+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.17"]
tags: ["SGLang", "speculative", "EAGLE", "DFlash", "推测解码", "tree attention"]
description: "SGLang 推测解码：BaseSpecWorker 统一抽象、EAGLE tree attention、spec_registry 注册表、DFlash block draft 与 CUDA Graph 加速。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.17/00-overview)

---

## 模块定位

speculative 是 SGLang 的旗舰优化之一。推测解码的核心思想：主模型解码时，先用轻量 draft 模型（或 n-gram）猜一批候选 token，主模型一次 forward 验证全部候选，按树形接受/拒绝——接受的多个 token 一次性产出，从而把多次 decode 压缩成一次 verify forward。本模块统一了 EAGLE、DFlash、n-gram、FrozenKVMTP 等多种算法，靠 `BaseSpecWorker` 抽象 + `spec_registry` 注册表让 scheduler 只需调一个 `forward_batch_generation`。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-internals/speculative-architecture.svg)

入口是 `SpeculativeAlgorithm`（`spec_info.py`）枚举 + 注册表：`DFLASH/DSPARK/EAGLE/EAGLE3/FROZEN_KV_MTP/STANDALONE/NGRAM/NONE`，`from_string` 先查枚举成员再 fallback 到 `_get_registered_spec`，`create_worker(server_args)` 工厂返回对应 Worker。外部插件用 `@SpeculativeAlgorithm.register("MY_SPEC")`（委托 `spec_registry._register_algorithm`）注册，`_assert_custom_spec_algo_conforms` 在注册时校验 duck-type 契约——刻意用 `vars(SpeculativeAlgorithm)` 而非 `dir()`（因为 `EnumMeta.__dir__` 会隐藏实例方法，导致漏检），要求所有 `is_*()`/`supports_*()` 必须存在，`_RESERVED_ALIASES = {'NEXTN'}` 保护内置名不被覆盖。注意 `is_eagle()` 把 `FROZEN_KV_MTP` 也算作 eagle（源码含 FIXME 注释），以复用 EAGLE 的 verify 路径。

两个 ABC。`BaseSpecWorker`（`base_spec_worker.py`）是 spec worker 基类，无严格 abstract 方法但子类必须覆盖 `forward_batch_generation`（scheduler 调的入口），还提供 `alloc_memory_pool`/`init_attention_backends`/`init_cuda_graphs` 生命周期与 `on_verify_complete_cpu`/`note_request_finished`/`activate_step_by_batch` 默认 no-op 的观察者 hook（供 `AdaptiveController` 自适应）。`EagleDraftWorkerBase` 是 draft 执行器基类，声明 `draft()`/`draft_extend()` 为 `@abstractmethod`——前者多步 draft forward 生成候选 token 树，后者用 target hidden states 填充 draft KV 保持同步；`init_cuda_graphs` 先调 `draft_worker.init_cuda_graphs(capture_decode_cuda_graph=False)` 再 `_capture_cuda_graphs`，而 `EagleDraftWorker._capture_cuda_graphs`（`eagle_worker_v2.py`）仅在 `speculative_num_steps > 1` 时捕获 `EAGLEDraftCudaGraphRunner`(draft_decode) 与 `EAGLEDraftExtendCudaGraphRunner`(draft_extend)；`_rebuild_topk1_chain_buffers`（`base_spec_worker.py`）断言 `speculative_num_draft_tokens == speculative_num_steps + 1` 后为 topk=1 链式 spec 预分配 runtime-invariant 的 parent/score buffer。

四个 Worker：`EAGLEWorkerV2`（多步自回归 draft + tree attention verify）、`DFlashWorkerV2`（直接继承 `BaseSpecWorker`，不经 `EagleDraftWorkerBase` 的 draft/draft_extend 拆分，`draft_worker` property 返回普通 `TpModelWorker`）、`NGRAMWorker`（`draft_worker` 返回 None，CPU corpus 查 draft 无 KV，`has_draft_kv()` 对 ngram 返回 False）、`FrozenKVMTPWorkerV2`（继承 `EAGLEWorkerV2` 但**不调** `EAGLEWorkerV2.__init__`，自建 `FrozenKVMTPDraftWorker(EagleDraftWorkerBase, TpModelWorker)` 经 `_bind_kv_context` 绑定 target `token_to_kv_pool` 只读复用，其 `draft_extend` 是 pass、`_draft_extend_for_decode` 拉取 verify 输出最后接受 token 的 target hidden 作下一轮 seed）。`EagleDraftWorker.draft_extend` 本身也是 pass（真实实现是 `_draft_extend_for_prefill`/`_draft_extend_for_decode`）。`SpecInput`（ABC）+ 子类（EagleDraftInput/EagleVerifyInput/DFlashDraftInputV2/NgramVerifyInput…）用 `SpecInputType` 枚举区分 draft/verify 阶段。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-internals/speculative-call-chain.svg)

以 EAGLE decode 为例（`eagle_worker_v2.py`）。`Scheduler.run_batch`（`scheduler.py:3641`）调 `model_worker.forward_batch_generation`（即 spec worker 入口）。① `draft_worker.draft`（多步自回归）：`prepare_for_draft` 构造 ForwardBatch → `cuda_graph_runner.execute`（CUDA graph 重放加速）或 `draft_forward` eager，循环 `speculative_num_steps` 步每步 `select_top_k_tokens` 选候选 + `draft_runner.forward`，产出 `topk_p`/`topk_index`/`hidden_states`。② `build_eagle_verify_input` 调 `build_tree_kernel_efficient`（`eagle_utils.py:144`）构造 tree attention mask（每 draft token 只看祖先链+prefix）+ `retrieve_index`/`retrieve_next_token`/`retrieve_next_sibling` 三索引描述树遍历顺序，产出 `EagleVerifyInput`。

③ `verify`：`run_eagle_verify` → `target_worker.forward_batch_generation(forward_batch, is_verify=True)`（`tp_worker.py`，`is_verify=True` 让 TpWorker 跳过 sampling）一次 forward 验证所有 draft token（batch_size × num_draft_tokens，经 tree mask 实现因果注意力）。④ `eagle_sample`（`eagle_utils.py:646`）：greedy 路径（`is_all_greedy` 或 CPU/NPU/HIP/XPU）走 `verify_tree_greedy_func`，sampling 走 `tree_speculative_sampling_target_only`（或 topk==1 的 `chain_speculative_sampling_triton` rejection sampling），返回 `num_correct_drafts + 1`（+1 含 bonus token，函数内是 drafts-only 语义、返回时翻转），sampling 在 TP `world_size>1` 时 broadcast `predict`/`accept_index`/`num_correct_drafts` 保跨 rank 一致，`fill_bonus_tokens_func` 提取 bonus token。⑤ `move_accept_tokens_to_target_kvcache`（`spec_utils.py`）：用 `seq_lens + num_correct_drafts + 1` 作 end_offset 调 `assign_extend_cache_locs`，`fill_accept_out_cache_loc_func` 把 `accept_index` 对应 draft `out_cache_loc` 收集到 `accept_out_cache_loc`，最后 `token_to_kv_pool_allocator.get_kvcache().move_kv_cache(tgt, accept)` 完成搬运。⑥ `on_publish(new_seq_lens)`（`FutureMap.publish`）在 `draft_extend` **之前**发布（注释 "fence at verify-end/target-end"），让 scheduler 下一轮 prep 与 verify 重叠。⑦ `draft_extend_for_decode` 用 verify 的 hidden states 更新 draft KV，产出 `next_draft_input` 存入 `batch.spec_info`（`scheduler.py:3694`）跨迭代传递。NGRAM 跳过 ①② 直接 CPU corpus 查 draft 再 verify；DFlash 跳过多步，一次 forward 出 block_size 个 token。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|--------------|
| `forward_batch_generation` | spec 入口（子类覆盖） | scheduler 统一调用 |
| `EagleDraftWorker.draft` | 多步 draft forward | cuda graph 重放加速 |
| `EagleDraftWorker.draft_extend` | target hidden 填 draft KV | 保 draft 与 target 同步 |
| `build_tree_kernel_efficient` | 构 tree mask + 索引 | `eagle_utils.py:144`，自定义 kernel |
| `verify` | target 一次 forward 验证 | is_verify=True 跳采样 |
| `eagle_sample` | 树形接受/拒绝 | greedy / sampling 两路径 |
| `move_accept_tokens_to_target_kvcache` | KV 同步 | draft pool→target pool |
| `on_verify_complete_cpu` | 自适应 hook | AdaptiveController 覆盖 |
| `activate_step_by_batch` | 自适应步数 hook | 按接受率调 spec_steps |
| `_assert_custom_spec_algo_conforms` | 注册时校验契约 | 防 AttributeError |

</details>

## 核心实现

### EAGLE Tree Attention

draft 多步 forward 生成一棵候选 token 树（topk 分叉 × spec_steps 深度）。`build_tree_kernel_efficient`（`eagle_utils.py:144`）调自定义 CUDA/Triton kernel 建 tree attention mask（每 draft token 只能看祖先链+prefix）与三索引数组（`retrieve_index`/`retrieve_next_token`/`retrieve_next_sibling`）描述遍历顺序，返回 `(tree_mask, positions, retrieve_index, retrieve_next_token, retrieve_next_sibling, draft_tokens)`。verify 时 target 一次 forward 处理所有 draft token（batch_size × num_draft_tokens）经 tree mask 实现因果注意力，随后 `eagle_sample` 树形接受/拒绝。`TreeMaskMode`（IntEnum）支持 FULL_MASK/QLEN_ONLY（省内存）/QLEN_ONLY_BITPACKING（位压缩），`default_tree_mask_mode()` 在 CPU 返回 QLEN_ONLY、否则 FULL_MASK；kernel 按 npu/xpu/cpu/cuda 分派到 `sgl_build_tree_kernel_efficient`/`_triton`/`_cpu`。

### DFlash block-level draft + compact cache

DFlash 不做多步自回归，一次 forward 生成整个 block（block_size 个 token），首位放 bonus token（上轮 verify 产出），其余放 mask token（用 `mask_token_id` 填充并借 target `embed_module` 做噪声嵌入）。draft 输出 hidden 后 `_greedy_sample_from_vocab_parallel_head` 借 target 的 `lm_head` 做 argmax（DFlash draft 无自己的 lm_head）——`_maybe_build_draft_sampler` 读 `target_model.lm_head.weight` 并校验非量化，`_DflashDraftSampler` 持该 weight 经 `draft_model_runner.capture_tail_hooks` 折进 draft cuda graph。`compact_draft_cache`（`draft_window_size`）滑窗式管 KV，防 draft KV 随序列无限增长。`_DflashDraftSampler` 在 CUDA graph 内完成 TP-all-gather+全局 argmax，保证 TP>1 draft token 一致。

### CUDA Graph 加速 draft 循环

EAGLE draft 每轮需 `spec_steps` 次 draft forward（自回归），每次 input shape 固定。`EAGLEDraftCudaGraphRunner`（继承 `DecodeCudaGraphRunner`）捕获静态 graph，`capture_one_shape` 预分配所有 static buffer（input_ids/hidden_states/topk_p/topk_index…），replay 只更新 buffer 指针，省 kernel launch 开销。`_topk1_parents_prealloc` 是 topk=1 优化：树退化为链，parent_list 与 score_indices 是 runtime-invariant，预分配后所有 step 复用。`EAGLEDraftExtendCudaGraphRunner` 同理加速 draft_extend。

### spec_v2 overlap

`BaseSpecWorker` 的 `on_publish`（`FutureMap.publish`）让 verify 完成后、draft_extend 前发布 `new_seq_lens`，scheduler 下一轮 prep 可与当前 verify 重叠。所有算法都经这套 spec_v2 骨架受益，与 managers 的 overlap 调度呼应。

自适应步数靠观察者 hook：`BaseSpecWorker.on_verify_complete_cpu`/`activate_step_by_batch` 默认 no-op，`EAGLEWorkerV2` 重写以调 `self.adaptive_controller`；`AdaptiveController`（`adaptive_runtime_state.py`）的 `on_verify_complete` 调 `params.on_verify_complete`、`activate_step_by_batch` 调 `params.get_steps_for_batch`，之后 `_activate` 调 `worker.apply_runtime_state` 切换 `SpecRuntimeState` 中的 draft/target attn backend 与 cuda graph runner；`EAGLEWorkerV2` 的 `build_adaptive_runtime_state`/`apply_runtime_state`/`_override_worker_state` 实现状态构建与临时覆盖。这样自适应逻辑不侵入主流程。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 注册表/插件 | `spec_registry.py` + `@SpeculativeAlgorithm.register` | 外部算法不改源码扩展，注册时校验契约 |
| 模板方法 | `BaseSpecWorker` 骨架 + `EagleDraftWorkerBase` 抽象 draft/draft_extend | verify 骨架统一，子类填 draft 差异 |
| 策略 | `create_worker` 选 Worker；`eagle_sample` greedy/sampling 分发 | 算法与采样路径可切换 |
| CUDA Graph 捕获-重放 | `eagle_draft_cuda_graph_runner.py` | draft 多步循环 shape 固定，省 launch |
| 观察者/Hook | `on_verify_complete_cpu`/`activate_step_by_batch` | AdaptiveController 自适应不侵主流程 |

## 模块间交互

与 `managers.Scheduler`：`Scheduler.maybe_init_draft_worker`（`scheduler.py:904`）经 `create_worker` 创建 spec worker 传入 `target_worker`；`run_batch` 调 `model_worker.forward_batch_generation(batch, on_publish=...)`，`on_publish` 是 `FutureMap.publish` 回调；每轮把 `batch_result.next_draft_input` 赋给 `batch.spec_info`（`:3694`）跨迭代传 draft 状态。与 `model_executor`：spec worker 经 `self.target_worker.forward_batch_generation(batch, capture_hidden_mode=FULL/LAST)` 调主 forward（`capture_hidden_mode` 控 hidden 捕获范围）；`is_verify=True` 让 TpWorker 跳过 sampling（`tp_worker.py:609`），spec worker 自己 `eagle_sample`；draft 与 verify 都复用 `ModelRunner.forward` 基础设施。与 `mem_cache`：`EagleDraftWorker.alloc_memory_pool` 分配独立 draft KV pool，与 target 共享请求映射但独立 KV；NGRAM 无 draft KV（`has_draft_kv()` False）；FrozenKVMTP 复用 target KV；`BaseSpecWorker._build_hicache_draft_plan` 决定 draft KV 层级策略（PACKED/SIDECAR/NONE）；verify 后 `move_accept_tokens_to_target_kvcache` 同步。

## 扩展方式

新增 spec 算法：用 `@SpeculativeAlgorithm.register("MY_SPEC", supports_overlap=True)` 注册 factory；新建 `MySpecWorker(BaseSpecWorker)` 实现 `forward_batch_generation`，有 draft model 则建 `MyDraftWorker(EagleDraftWorkerBase)` 实现 `draft`/`draft_extend`；在 `spec_info.py` 的 `SpecInputType` 加类型 + 对应 `SpecInput` 子类；如需接入内置 dispatch 分支覆盖 `is_*()`；`arg_groups/speculative_hook.py` 加 `_handle_my_spec` 并在 `SpeculativeAlgorithm.handle_server_args` dispatch。调 verify 接受策略：改 `eagle_utils.py:646` 的 `eagle_sample`（greedy 改 `verify_tree_greedy_func` `:371`，sampling 改 `tree_speculative_sampling_target_only` 调用 `:806` 或 `_verify_coins` `:618`），`speculative_accept_threshold_single/acc`（`:819`）调接受宽松度。改 draft batch/步数：`speculative_num_steps`/`speculative_num_draft_tokens`（ServerArgs，`handle_server_args` 规范化），`AdaptiveController` 的 `activate_step_by_batch`/`build_adaptive_runtime_state` 改自适应；改步数后 `init_cuda_graphs` 重捕获，`_rebuild_topk1_chain_buffers` 处理 topk=1 重建。扩展点契约见概览「核心概念」。
