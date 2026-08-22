---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "推测解码"
date: "2026-08-22T22:29:54+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.18"]
tags: ["SGLang", "speculative", "EAGLE", "DFlash", "推测解码", "tree attention"]
description: "SGLang 推测解码：BaseSpecWorker 统一抽象、EAGLE tree attention、spec_registry 注册表、DFlash block draft 与 CUDA Graph 加速。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.18/00-overview)

---

## 模块定位

speculative 是 SGLang 的旗舰优化之一。推测解码的核心思想：主模型解码时，先用轻量 draft 模型（或 n-gram）猜一批候选 token，主模型一次 forward 验证全部候选，按树形接受/拒绝——接受的多个 token 一次性产出，从而把多次 decode 压缩成一次 verify forward。本模块统一了 EAGLE、DFlash、DSpark、n-gram、FrozenKVMTP 等多种算法，靠 `BaseSpecWorker` 抽象 + `spec_registry` 注册表让 scheduler 只需调一个 `forward_batch_generation`。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-v0518/speculative-architecture.svg)

入口是 `SpeculativeAlgorithm`（`spec_info.py:31`）枚举 + 注册表：`DFLASH/DSPARK/EAGLE/EAGLE3/FROZEN_KV_MTP/STANDALONE/NGRAM/NONE`，`from_string`（`:48`）先查枚举成员再 fallback 到 `_get_registered_spec`，`create_worker(server_args)`（`:254`）工厂返回对应 Worker。外部插件用 `@SpeculativeAlgorithm.register("MY_SPEC")`（`:64`）注册，`_assert_custom_spec_algo_conforms`（`spec_registry.py:187`）注册时校验 duck-type 契约——刻意用 `vars(SpeculativeAlgorithm)` 而非 `dir()`（因为 `EnumMeta.__dir__` 会隐藏实例方法，导致漏检），要求所有 `is_*()`/`supports_*()` 必须存在，`_RESERVED_ALIASES = {'NEXTN'}` 保护内置名不被覆盖。注意 `is_eagle()`（`:98`）把 `FROZEN_KV_MTP` 也算作 eagle（源码含 FIXME 注释），以复用 EAGLE 的 verify 路径。

两个 ABC。`BaseSpecWorker`（`base_spec_worker.py:147`）是 spec worker 基类，无严格 abstract 方法但子类必须覆盖 `forward_batch_generation`（scheduler 调的入口），还提供 `alloc_memory_pool`/`init_attention_backends`/`init_cuda_graphs` 生命周期与 `on_verify_complete_cpu`/`note_request_finished`/`activate_step_by_batch` 默认 no-op 的观察者 hook（供 `AdaptiveController` 自适应）。`EagleDraftWorkerBase`（`:57`）是 draft 执行器基类，声明 `draft()`/`draft_extend()` 为 `@abstractmethod`——前者多步 draft forward 生成候选 token 树，后者用 target hidden states 填充 draft KV 保持同步。

7 种 Worker：`EAGLEWorkerV2`（独立 draft model + tree attention）、`DFlashWorkerV2`（block draft + 从 hidden 物化 KV）、`NGRAMWorker`（无 draft model，CPU corpus 查找）、`FrozenKVMTPWorkerV2`（继承 EAGLE 只读 target KV）、`MultiLayerEagleWorkerV2`（EAGLE3 multi-layer）、`StandaloneWorkerV2`（vanilla LLM draft）、`DSparkWorkerV2`（block-based + ragged verify）。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-v0518/speculative-call-chain.svg)

以 EAGLE decode 路径为例。`EAGLEWorkerV2.forward_batch_generation`（`eagle_worker_v2.py:1108`）→ `activate_step_by_batch`（`:1148`，Adaptive 切换 step）→ `draft_worker.draft`（`:1180`，`EagleDraftWorker.draft` `:497`：`prepare_for_draft` 分配 draft cache locs → 多步循环 `for i in range(speculative_num_steps)`：`select_top_k_tokens` + `draft_runner.forward` → `organize_draft_results`）→ `build_tree_kernel_efficient`（`eagle_utils.py:147`，构造 tree attention mask + `retrieve_index` 索引）→ `verify`（`:1183`，`run_eagle_verify` `eagle_worker_common.py:461`：`eagle_prepare_for_verify` 分配 verify cache locs → `target_worker.forward_batch_generation(is_verify=True)`（`:562`）TARGET_VERIFY forward → `eagle_sample`（`eagle_utils.py:649`，`verify_tree_greedy_func` 或 `tree_speculative_sampling_target_only` → accept_lens）→ `move_accept_tokens_to_target_kvcache`（`eagle_worker_common.py:422`，draft 临时区→target 连续区））→ `on_publish(new_seq_lens)`（`:1186`，`FutureMap.publish`）→ `draft_extend_for_decode`（`:859`，用 verify hidden 填充 draft KV）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `forward_batch_generation` (`eagle_worker_v2.py:1108`) | spec worker 入口 | decode: draft→verify→on_publish→extend; prefill: target prefill→extend |
| `draft` (EagleDraftWorker) (`:497`) | 多步生成候选树 | speculative_num_steps 循环 + select_top_k |
| `build_tree_kernel_efficient` (`eagle_utils.py:147`) | 构造 tree attention | tree_mask + retrieve_index |
| `verify` (`eagle_worker_v2.py:1183`) | target verify forward | `run_eagle_verify` → target_worker.forward(is_verify=True) |
| `eagle_sample` (`eagle_utils.py:649`) | 树形接受/拒绝 | greedy 或 sampling → accept_lens |
| `move_accept_tokens_to_target_kvcache` (`eagle_worker_common.py:422`) | 同步 draft→target KV | _finalize_accept_tree_path 内 |
| `on_publish` (`:1186`) | 发布 new_seq_lens | FutureMap.publish + WAR barrier |
| `_draft_extend_for_decode` (`:859`) | 用 verify hidden 填 draft KV | 保持 draft/target 同步 |
| `create_worker` (`spec_info.py:254`) | 工厂选 Worker | 按算法类型延迟导入 |
| `register` (`spec_info.py:64`) | 注册插件算法 | 委托 spec_registry._register_algorithm |
| `_assert_custom_spec_algo_conforms` (`spec_registry.py:187`) | 契约校验 | vars() 非 dir()，校验所有 is_*/supports_* |

</details>

## 核心实现

### EAGLE verify 骨架

`EAGLEWorkerV2.forward_batch_generation`（`eagle_worker_v2.py:1108`）是模板方法的实例。decode 路径：`activate_step_by_batch`（Adaptive 自适应 step 切换）→ `draft_worker.draft`（`:1180`）→ `verify`（`:1183`）→ `on_publish`（`:1186`）→ `draft_worker._draft_extend_for_decode`（`:1201`）。prefill 路径：target prefill → `on_publish` → `draft_extend_for_prefill`。子类（`FrozenKVMTPWorkerV2`）覆写 `forward_batch_generation` 但复用 `verify` 方法。

`draft` 多步循环（`EagleDraftWorker.draft` `:497`）：`prepare_for_draft` 分配 draft cache locs → `for i in range(speculative_num_steps)`：`select_top_k_tokens(i, ...)` 选 top-k → `draft_runner.forward(forward_batch)` 单步 draft forward → `organize_draft_results` 汇总。CUDA graph 模式下用 `EAGLEDraftCudaGraphRunner` 重放加速，仅 `speculative_num_steps > 1` 时捕获。

### 注册表与契约校验

`@SpeculativeAlgorithm.register`（`spec_info.py:64`）委托 `spec_registry.register_algorithm`（`:222`）：`upper = name.upper()` → 检查 `_reserved_names()`（枚举成员名 + `_RESERVED_ALIASES = {'NEXTN'}`）防覆盖 → 检查 `_REGISTRY` 防重复 → `_assert_custom_spec_algo_conforms`（`:187`）校验 → 返回 decorator 存入 `_REGISTRY[upper]`。

`_assert_custom_spec_algo_conforms`（`:187`）用 `vars(SpeculativeAlgorithm)`（非 `dir()`）提取所有 `is_*`/`supports_*` 方法名，检查 `spec_class` 是否实现了全部——有缺失则 `TypeError`。新 predicate 自动被覆盖，无需维护第二份列表（`:197`）。

### spec_v2 overlap 与 FutureMap

overlap 模式下 `on_publish`（`eagle_worker_v2.py:1184-1186`）在 verify 完成后、draft_extend 前调用。`on_publish` = `partial(self.future_map.publish, future_indices)`（`scheduler.py:3681`）。`FutureMap.publish`（`overlap_utils.py:511`）将 `new_seq_lens` 写入 `new_seq_lens_buf[indices]` 并 record `publish_ready` event。下一轮的 plan_stream 可在 draft_extend 还在 GPU 执行时就开始 prepare_for_draft——这就是 WAR barrier 的作用。`last_shared_read_runner`（`base_spec_worker.py:215`）决定 WAR barrier 等待的 event 来源：EAGLE 的 draft_extend 是最后一个读 shared buffer 的阶段，所以 EAGLEWorkerV2 覆写它返回 `draft_runner`（`:1060`）。

### FrozenKVMTP 与 DFlash 差异

`FrozenKVMTPWorkerV2`（`frozen_kv_mtp_worker_v2.py:676`）继承 `EAGLEWorkerV2` 但**不调 `EAGLEWorkerV2.__init__`**（`:692` 注释明确说明），因为 EAGLE 的 `__init__` 会构建 `EagleDraftWorker`（有独立 draft KV pool），而 frozen draft 只读 target KV。它只复用 `EAGLEWorkerV2.verify()` 方法，draft worker 和 draft_extend 逻辑是 frozen 专有。

`DFlashWorkerV2`（`dflash_worker_v2.py`）的 draft 模型没有自己的 lm_head（借用 target 的），通过 `__getattr__`（`:551`）委托 `target_worker` 的方法（如 `update_weights_from_tensor`、tokenizer），避免重复代码。`DSparkWorkerV2` 用 ragged verify（per-request 变长验证，`ragged_verify_layout`）。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
|------|----------------------|----------|
| 模板方法 | `BaseSpecWorker` `base_spec_worker.py:147` 生命周期骨架；`EAGLEWorkerV2.forward_batch_generation` `eagle_worker_v2.py:1108` | 统一 verify 骨架，子类只填 draft 差异 |
| 注册表/插件 | `@SpeculativeAlgorithm.register` `spec_info.py:64`；`_REGISTRY` `spec_registry.py:166` | 算法可不改源码扩展，注册时校验契约 |
| 策略模式 | `SpeculativeAlgorithm.create_worker` `spec_info.py:254` 按类型选 Worker | 7 种算法统一 `forward_batch_generation` 接口 |
| 观察者 | `on_verify_complete_cpu`/`note_request_finished`/`activate_step_by_batch` `base_spec_worker.py:314-338` | 默认 no-op，`AdaptiveController` 覆写做自适应 |
| 委托 | `DFlashWorkerV2.__getattr__` `dflash_worker_v2.py:551` | 自动委托 target_worker 方法 |

## 模块间交互

spec worker↔Scheduler：`maybe_init_draft_worker`（`scheduler.py` 初始化段）调 `create_worker` 构建；`run_batch`（`:3694`）调 `model_worker.forward_batch_generation(batch, on_publish=..., grammar_barrier=...)`；overlap 模式 `on_publish` = `partial(future_map.publish, future_indices)`（`:3681`）。spec worker↔mem_cache：`alloc_memory_pool` 创建独立 draft KV pool；`_build_hicache_draft_plan`（`base_spec_worker.py:234`）决定 draft KV 是 packed（共享 target pool）还是 sidecar（独立）；`move_accept_tokens_to_target_kvcache` 同步 KV。spec worker↔model_executor：`target_worker.forward_batch_generation(is_verify=True)` 复用 target `ModelRunner` 和 `decode_cuda_graph_runner`。

## 扩展方式

#### 新增推测算法

1. 实现 Worker 类继承 `BaseSpecWorker`（或 `EAGLEWorkerV2` 复用 verify 骨架），实现 `forward_batch_generation(batch, on_publish, grammar_barrier)`
2. 用 `@SpeculativeAlgorithm.register("MY_SPEC", supports_overlap=True)` 注册 factory
3. 如需覆写 `is_*()` 方法，传入 `spec_class`（继承 `CustomSpecAlgo`）
4. 实现 `SpecInput` 子类（如算法有独特的 draft/verify 输入结构），在 `SpecInputType` 中新增类型
5. `_assert_custom_spec_algo_conforms` 会校验 `MySpecAlgo` 实现了所有 `is_*()`/`supports_*()`——有新 predicate 漏实现注册时就 `TypeError`

参考 `frozen_kv_mtp_worker_v2.py`（继承 EAGLEWorkerV2 只换 draft worker，最简扩展路径）。
