---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "引擎层"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "SGLang", "rollout", "reward", "SlimeRouter", "radix tree", "GenRM"]
description: "解读 Relax 引擎层：rollout 编排与 SGLang HTTP 通信、可插拔奖励 RewardExecutor 与 GenRM LLM-as-judge、SlimeRouter 路由与 radix tree 前缀缓存、数据过滤与 OPD 蒸馏。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/engine/`（8,255 行）是六层架构的引擎层，封装 RL rollout 的编排逻辑——prompt 采样、并发生成、奖励计算、请求路由、数据过滤、on-policy 蒸馏。它的核心架构分界是**与推理后端解耦**：引擎层不直接调用 `SGLangEngine` 的方法，而是通过 HTTP POST `/generate` 与 SGLang 服务器通信，RL 逻辑与推理引擎生命周期正交，换一个推理后端（vLLM/TensorRT-LLM）只需适配 HTTP 协议。`RolloutManager`（distributed 层）同时持有 `SGLangEngine`（管生命周期）和 `generate_rollout`（执行推理），两者通过 router 间接耦合。

## 模块架构

引擎层内部按职责分五个子目录：`rollout/`（生成编排核心）、`rewards/`（可插拔奖励）、`router/`（请求路由 + radix tree 中间件）、`filters/`（数据过滤）、`sft/`（SFT 引擎）。`sglang_rollout.py` 是生成编排中枢，含 `GenerateState` 单例（持 tokenizer/processor/并发控制/OPD manager）与 `generate_rollout` 函数族；`rewards/` 以 `RewardExecutor` 单例 + `RewardWorker` Ray Actor 池执行奖励，`registry.py` 提供策略注册；`router/` 的 `SlimeRouter` 是自定义 FastAPI 代理，`radix_tree.py` 的 `StringRadixTrie` 提供前缀缓存。

```
engine/
├── rollout/
│   ├── sglang_rollout.py (1338)  GenerateState 单例 + generate_rollout 函数族（HTTP POST 到 SGLang）
│   ├── data_source.py (359)      RolloutDataSource / WithBuffer（prompt 采样 + buffer）
│   ├── on_policy_distillation.py (383)  OpdManager（师生 logprob prefill）
│   ├── request_permit.py (66)    InferencePermitManager（并发控制 semaphore）
│   └── base_types.py (39)        RolloutFnTrainOutput/EvalOutput + call_rollout_fn
├── rewards/
│   ├── __init__.py (469)         RewardExecutor 单例 + RewardWorker Ray Actor + async_rm
│   ├── registry.py (299)         RewardSpec + register_reward + resolve_rm_type
│   ├── dapo_genrm.py (179)        GenRM LLM-as-judge
│   └── math_utils.py / deepscaler.py / f1.py  具体奖励函数
├── router/
│   ├── router.py (336)           SlimeRouter（FastAPI 代理 + sticky session + 负载均衡）
│   └── middleware/
│       ├── radix_tree.py (623)   StringRadixTrie（前缀缓存树 + 权重版本 GC）
│       └── radix_tree_middleware.py (173)  RadixTreeMiddleware（HTTP 拦截器）
├── filters/                      DynamicFilterOutput + check_reward_nonzero_std 等
└── sft/                          SFT runtime / bootstrap / dataset / eval / predict
```

## 调用链路

一次 rollout generate 的调用链（从 RolloutManager 到 SGLang 返回）：

```
RolloutManager.generate(rollout_id)                         # distributed/ray/rollout.py:1020
  → call_rollout_fn(generate_rollout, ...)                  # base_types.py:20
    → generate_rollout(args, rollout_id, data_source, dsc)  # sglang_rollout.py:1306
      → run(generate_rollout_async(...))                    # sglang_rollout.py:1327
        → state.submit_generate_tasks(samples)              # sglang_rollout.py:189
          → asyncio.create_task(generate_and_rm_group(...)) # sglang_rollout.py:637
              → asyncio.gather(generate_and_rm(...))        # sglang_rollout.py:550
                  ├─ _dispatch_generate → generate(args, sample, sampling_params)
                  │    → POST http://{router_ip}:{router_port}/generate   # sglang_rollout.py:396
                  │       → SlimeRouter.proxy() 或 SGLang 原生 router
                  │           → 转发到 SGLangEngine 启动的 HTTP server
                  │    → sample.tokens += new_response_tokens
                  │    → sample.rollout_log_probs = output.logprobs
                  │    → sample.update_from_meta_info(meta_info)          # types.py:177
                  └─ async_rm(args, sample) → sample.reward               # rewards/__init__.py:448
                      → RewardExecutor.execute(args, sample)              # rewards/__init__.py:339
        → collect → convert_samples_to_train_data → transfer_batch_to_data_system
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `generate_rollout` | rollout 入口函数 | 通过 `load_function(args.rollout_function_path)` 动态加载，可替换 |
| `GenerateState` | rollout 全局状态单例 | 持 tokenizer/processor/OPD/并发 semaphore，metaclass Singleton |
| `generate` | 单 sample 生成 | HTTP POST，不 import SGLangEngine——与后端解耦 |
| `async_rm` | 奖励计算入口 | 分 custom 路径与内置 rm_type 路径 |
| `RewardExecutor.execute` | 分派奖励策略 | async mode 走 event loop，sync mode 走 Ray worker 池 |
| `SlimeRouter.proxy` | 请求代理 | sticky session 路由 + 最少负载选择 |
| `StringRadixTrie.find_longest_prefix` | 前缀缓存命中 | 权重版本感知 GC，权重更新后清旧 logprob |
| `OpdManager.before/after_rollout` | OPD 蒸馏介入 | 向 payload 注 student top-k 请求，post-fill teacher logprob |

</details>

## 核心实现

### generate_rollout：HTTP 通信与 Sample 填充

`engine/rollout/sglang_rollout.py` 是生成编排核心，但**没有 `SGLangRolloutEngine` class**——它是模块级函数集合 + `GenerateState` 单例。`generate()`（`sglang_rollout.py:299`）构建 HTTP payload（含 input_ids、sampling_params、multimodal data），`POST http://{router_ip}:{router_port}/generate`（`:396`），解析返回的 `output["text"]`/`output["meta_info"]["output_token_logprobs"]`，增量更新 `sample.tokens`（`sample.tokens = sample.tokens + new_response_tokens`，支持 partial rollout）、`sample.rollout_log_probs`，调 `sample.update_from_meta_info(args, output["meta_info"])` 更新 status（COMPLETED/TRUNCATED/ABORTED）、spec_info、prefix_cache_info、weight_versions。

`GenerateState`（`sglang_rollout.py:75`，metaclass `SingletonMeta`）持 tokenizer、processor、OPD manager、`InferencePermitManager`（并发控制 semaphore）、sampling params。`inference_permit()` 是每请求许可上下文管理器，控制对 SGLang 的并发请求量。`dp_rank_context` 提供 DP rank 负载均衡。这个分界的意义：`SGLangEngine`（backend）管进程生命周期（启动/权重/内存/关闭），`sglang_rollout.py`（engine）管 RL 编排（采样/并发/奖励/多模态），两者通过 HTTP `/generate` 解耦——换后端只需适配协议。

### 可插拔奖励：RewardExecutor 与 GenRM

`rewards/__init__.py` 的 `RewardExecutor`（`:181`，单例 `_instance` + `get_or_create`）是奖励执行中枢。`execute(args, sample)`（`:339`）分两条路径：`args.custom_rm_path` 存在走 `_execute_custom_with_concurrency`（`:298`，async 函数直接在 event loop 执行，sync 函数走 `RewardWorker` Ray Actor 池）；否则 `resolve_rm_type()`（`registry.py:177`）按优先级选内置策略，sync mode 走 `worker.compute.remote(rm_type, response, label, metadata)`，async mode 走 `await spec.resolve()(args, sample)`。

`RewardWorker`（`rewards/__init__.py:113`，`@ray.remote(num_cpus=0.25)`）是进程隔离的奖励计算 worker，`compute`（内置同步奖励）与 `compute_custom`（自定义）方法，`reload_custom_reward` 支持热重载。`_next_worker` 轮询选择 worker，`max_concurrency=64`/`num_workers=16` 控制并发。

```python title="relax/engine/rewards/registry.py（策略注册）"
register_reward("deepscaler", "relax.engine.rewards.deepscaler:get_deepscaler_rule_based_reward")
register_reward("math", _math_reward, label_matcher=_looks_like_math_label)
register_reward("dapo", "relax.engine.rewards.math_dapo_utils:compute_score")
register_reward("remote_rm", remote_rm, mode="async")
register_reward("dapo-genrm", async_compute_score_genrm, mode="async")
register_reward("dummy", lambda args, sample: _dummy_reward(args), mode="async")
```

GenRM（`rewards/dapo_genrm.py:108` `async_compute_score_genrm`）是 LLM-as-judge 设计：构造 few-shot prompt 让 judge LLM 判断 model answer 与 ground truth 是否一致，输出 "1"/"0"。关键设计：格式检查短路（无 `\boxed{}`/`Answer:` 直接 score=0，不浪费 judge 调用）、答案长度上限 `MAX_ANSWER_LEN=500`（防 actor 填充超长答案 hack judge）、优雅降级（judge 调用失败降级 score=0 而非中断 rollout batch）、注册为 async mode（I/O 密集不走 worker 池）。`GenRMEngine`（`backends/sglang/sglang_engine.py:1134`）继承 `SGLangEngine` 作为独立推理引擎部署 judge LLM。

### SlimeRouter 与 radix tree 前缀缓存

`SlimeRouter`（`router/router.py:29`）是自定义 FastAPI 代理，核心 `proxy(request, path)` 转发 `/generate` 请求。`_use_url(routing_key)` 选 worker：支持 sticky session（`_pick_sticky_url`，按 routing_key 绑定固定 worker 复用 KV cache）与最少负载选择（`_select_least_loaded`）。中间件通过 `load_function` 动态加载（`router.py:75-79`），`args.slime_router_middleware_paths` 配置，`add_middleware` 注册——**无需改框架代码**即可加中间件。

`StringRadixTrie`（`router/middleware/radix_tree.py:100`）是前缀缓存树，`find_longest_prefix` 做最长前缀匹配，`insert` 插入完整 trajectory 的 token_ids/logprobs/loss_mask/weight_version。RL 训练中同一 prompt 生成多个 response 共享前缀，radix tree 缓存这些前缀使：(1) 前缀 KV cache 复用（sticky session 路由到同 worker）；(2) token/logprob 缓存避免重复 tokenize；(3) `gc_by_weight_version`（`:445`）按权重版本清过期缓存——权重更新后旧 logprob 失效。`RadixTreeMiddleware`（`radix_tree_middleware.py:62`，`BaseHTTPMiddleware`）拦截 `/generate`，请求前查前缀、响应后插 trajectory。

### On-Policy Distillation 与数据过滤

`OpdManager`（`rollout/on_policy_distillation.py`）在 rollout 三阶段介入：`before_rollout(payload)`（`:150`）注入 student top-k 请求参数让 SGLang 返回 student top-k logprobs；`after_rollout(sample, output)`（`:178`）解析存入 `sample.student_topk_*`；`prefill(samples, encode_mm_fn)`（`:192`）向 teacher 引擎 POST 取 teacher logprobs，组装 transfer channels。支持 `topk_worker`/`sampled_worker`/`opsd_worker` 三种模式，teacher URL 路由支持 MOPD（多教师，按 `sample.metadata.data_source` 路由）。`filters/dynamic_sampling_filters.py` 的过滤函数（如 `check_reward_nonzero_std`）通过 `call_dynamic_filter`（`base_types.py:11`）调用，`keep=False` 的组被丢弃并记 metric。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 策略（可插拔 reward） | `RewardSpec` + `register_reward` + `resolve_rm_type` in `rewards/registry.py` | 用户可 `--custom-rm-path` 完全绕过内置注册表 |
| 中间件 | `SlimeRouter` + `load_function` + `add_middleware` in `router/router.py:75` | 动态加载中间件，新增不改框架代码 |
| 工厂（load_function） | `utils/misc.py` 被 `registry.py:64`/`sglang_rollout.py:521`/`data_source.py:56` 调用 | dotted path 字符串→callable，统一懒加载入口 |
| 单例 | `GenerateState`/`RewardExecutor` metaclass Singleton | rollout/reward 全局状态唯一 |
| 适配器（HTTP 解耦） | `generate()` HTTP POST in `sglang_rollout.py:299` | RL 逻辑与推理后端正交，可换后端 |

## 模块间交互

engine 依赖 `backends/sglang`（SGLangEngine，但**仅通过 HTTP 间接调用**，不直接 import 其方法）、`distributed/ray`（`_log_rollout_data`、RolloutManager 持有 generate_rollout）、`utils`（Sample/load_function/http_utils/multimodal/metrics）、`transfer_queue`（data_system_client）。被 `components/rollout`（间接，RolloutManager 调 generate_rollout）与 `agentic`（`SGLangBackendAdapter` 复用 HTTP 通信）调用。关键：engine 与 backends 的依赖是**单向 HTTP**而非 import——这是引擎层独立成层的根基。详见概览「模块地图」。

## 扩展方式

- **新增奖励函数**：方式 A 在 `engine/rewards/` 新建文件 + `registry.py` `register_reward("my_type", "relax.engine.rewards.my:get_fn", mode=..., label_matcher=...)`；方式 B 不改框架，`--custom-rm-path pkg.module:func`，`RewardExecutor._execute_custom` 自动加载
- **新增路由中间件**：`engine/router/middleware/` 新建 `class XMiddleware(BaseHTTPMiddleware)` 接受 `router=self`，`--slime-router-middleware-paths relax.engine.router.middleware.x:XMiddleware` 配置即加载
- **新增数据过滤**：`engine/filters/dynamic_sampling_filters.py` 加 `fn(args, samples, **kwargs) → DynamicFilterOutput`，或 `--dynamic-sampling-filter-path` 指定独立函数
