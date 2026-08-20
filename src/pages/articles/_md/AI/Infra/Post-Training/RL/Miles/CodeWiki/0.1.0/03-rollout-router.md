---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "Rollout 与 Router"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "RL", "Rollout", "TITO", "R3", "SGLang", "Router"]
description: "Rollout 生成管线 + MilesRouter 请求分发 + TITO 增量分词 + R3 MoE 路由回放 + Session 多轮状态管理。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

这一层负责 RL 循环的"生成"半边：把 prompt 喂给 SGLang engine 生成 response、过滤、打分，并保证生成数据在数值上与训练对齐。它的两个旗舰正确性机制——TITO（token-in-token-out）和 R3（路由回放）——解决了多轮 agentic 场景下 detokenize/retokenize 往返和 MoE routing 不匹配两大偏差源。MilesRouter 独立成层做请求分发与健康检查。

## 模块架构

```
miles/rollout/
├── generate_hub/          # 三种 generate 函数（统一 GenerateFnInput→Output 接口）
│   ├── single_turn.py     #   单轮：POST /generate → update_sample
│   ├── multi_turn.py      #   多轮 tool-call 循环
│   └── agentic_tool_call.py  # 通用 agentic（OpenAIEndpointTracer + session）
├── filter_hub/            # dynamic filter（组级别过滤）
├── rm_hub/                # reward model 分发（async_rm / batched_async_rm）
├── session/               # TITO + R3 核心引擎
│   ├── core.py            #   SessionCore（三阶段锁：prepare→proxy→update）
│   ├── linear_trajectory.py  # v1 线性轨迹（单步回滚）
│   ├── v2/                #   v2 树状轨迹（自由 retry 分支）
│   └── samples/codec.py   #   safetensors wire codec
├── inference_rollout/     # 类式 rollout 入口（InferenceRolloutFn，v2）
├── base_types.py          # RolloutFnInput/Output（被 import 12 次）
└── fully_async_rollout.py # fully-async worker loop + DataBuffer
miles/router/router.py     # MilesRouter（FastAPI HTTP reverse proxy）
miles/utils/chat_template_utils/tito_tokenizer.py  # TITO 增量分词器
```

## 调用链路

一次 rollout 的完整流程：

```
RolloutManager.generate(rollout_id)
  └── call_rollout_function(InferenceRolloutFn, RolloutFnTrainInput)
      └── InferenceRolloutFn._call_train()
          └── generate_rollout_async(state, rollout_id, data_source.get_samples)
              ├── data_source.get_samples(N) → list[list[Sample]]  (prompt 分组)
              ├── while len(data) < target:
              │     state.submit_generate_tasks(samples)
              │       └── asyncio.create_task(generate_and_rm_group)
              │             └── per sample: generate_and_rm(state, sample)
              │                   ├── generate(GenerateFnInput)
              │                   │   └── POST http://{router}/generate → MilesRouter
              │                   │       ._use_url() → SGLang Engine
              │                   │       ← text + meta_info (output_token_logprobs)
              │                   └── async_rm(args, sample) → reward
              ├── call_dynamic_filter(group) → keep/drop (MetricGatherer 记录)
              └── asyncio.wait(FIRST_COMPLETED) → 重复直到满
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `generate()` in `generate_hub/single_turn.py` | 单轮生成 | POST /generate + update_sample_from_response |
| `MilesRouter._use_url()` in `router.py` | 选活跃请求最少的 worker | least-active-requests 负载均衡 |
| `MilesRouter._health_check_loop()` | 后台健康检查，连续失败隔离 | dead_workers 集合 |
| `SessionCore.chat_completions()` in `session/core.py` | 多轮会话代理 | 三阶段锁（prepare→proxy→update） |
| `LinearTrajectory.prepare_pretokenized()` | TITO 增量分词 | 复用 token_ids 前缀 + tokenize_additional_messages |
| `TITOTokenizer.merge_tokens()` | 合并 pretokenized + 增量 | 模型子类覆写处理边界 token |
| `SessionCore._maybe_request_addition_r3()` | 增量 R3 请求 | 设 routed_experts_start_len 只返回未保留行 |
| `async_rm()` in `rm_hub/__init__.py` | 单 sample reward | 按 rm_type 分发 |

</details>

## 核心实现

### MilesRouter 请求分发

`MilesRouter` 是 FastAPI HTTP reverse proxy，在多个 SGLang engine 间分发请求。两种机制保留 per-request metadata：

```python title="miles/router/router.py (least-active-requests 负载均衡)"
def _use_url(self):
    if not self.dead_workers:
        url = min(self.worker_request_counts, key=self.worker_request_counts.get)
    else:
        valid = (w for w in self.worker_request_counts if w not in self.dead_workers)
        url = min(valid, key=self.worker_request_counts.get)
    self.worker_request_counts[url] += 1
    return url
```

`worker_request_counts` 是 per-URL 活跃请求计数器（请求开始 `_use_url` 递增，结束 `_finish_url` 递减），选最小计数器实现动态负载均衡。`X-SMG-Routing-Key` header（consistent_hashing/manual 策略）把同一 session 的请求路由到同一 worker 复用 KV cache——session 模式下 `session_id` 本身就是 routing_key（`session/core.py` Phase 2 设 header）。MilesRouter 与 SGLang 内置 Rust Router 互斥选择（`args.use_miles_router`），额外提供 health-check 自动隔离和动态 `add_worker` 注册。

### TITO 如何避免 detokenize/retokenize 往返

TITO 的核心思想是**全链路使用 token IDs 而非文本**。传统路径每轮都要 messages→text→tokenize→input_ids，生成后 text→tokenize→response_ids。TITO 路径：

第一轮：`tito_tokenizer.apply_chat_template(messages, tokenize=True)` → 完整 input_ids → 发 engine → 从 `meta_info.output_token_logprobs` 直接取 `[logprob, token_id]` 对得 completion token IDs → 存为 checkpoint。

后续轮次（增量）：

```python title="miles/rollout/session/linear_trajectory.py (prepare_pretokenized)"
if not self.token_ids:
    return tito_tokenizer.apply_chat_template(request_messages, tools=tools, ...)
# 复用存储的 token_ids 作为前缀，仅 tokenize 新增消息的增量
return tito_tokenizer.merge_tokens(
    old_messages=self.messages, new_messages=effective_messages,
    pretokenized_token_ids=self.token_ids, tools=tools,
)
```

```python title="miles/utils/chat_template_utils/tito_tokenizer.py (merge_tokens)"
def merge_tokens(self, old_messages, new_messages, pretokenized_token_ids, tools):
    incremental = self.tokenize_additional_messages(old_messages, new_messages, tools)
    return list(pretokenized_token_ids) + incremental  # 不重新 tokenize 整个对话
```

不同模型 chat template 在 message 边界有不同的 token（如 Qwen3 的 `<|im_end|>\n`），各 `TITOTokenizer` 子类（`Qwen3TITOTokenizer`/`GLM47TITOTokenizer`/`DeepSeekV4TITOTokenizer` 等）覆写 `merge_tokens` 处理边界 token。session server 强制 `logprobs=True` + `return_meta_info=True`（`core.py:prepare_chat_request`）获取 output token logprobs。

### R3 如何记录并回放 MoE expert routing

R3 记录 MoE 模型在 rollout 时的 expert 路由决策，训练时回放，消除 MoE routing mismatch 导致的训练不稳定。

**记录阶段**：`sglang_rollout.py` 设 `payload["return_routed_experts"]=True`，SGLang 返回 `meta_info.routed_experts`（base64 int32 buffer），解码为 `(num_tokens, num_layers, topk_experts)` numpy 数组存入 `sample.rollout_routed_experts`。

**增量 R3**：`in_place` 权重更新模式下 session 保留 KV cache 和 token 前缀，`_maybe_request_addition_r3()` 设 `routed_experts_start_len`，SGLang 只返回 session 未保留的 R3 行（`session/core.py`）。

**回放阶段**：`BaseReplayManager`（`miles/utils/replay_base.py:53`）通过 monkey-patch `get_topk_fn` 替换 MoE router 的 top-k 选择——record 阶段记录 routing 结果，`replay_forward`/`replay_backward` 阶段直接回放，避免训练时重新计算 routing。`RoutingReplayManager` 和 `IndexerReplayManager` 分别处理 MoE routing 和 indexer。

### Session 两代设计

**v1（LinearTrajectory）**：线性轨迹，单条路径，支持单步回滚（agent retry 时 `_try_detect_and_rollback_to_assistant_checkpoint` 回退到上一个 assistant checkpoint，最多 1 步）。

**v2（SessionStateV2 + SessionTree）**：树状轨迹森林，`find_attach_point` 深度优先搜索最匹配节点后创建新分支，永不拒绝请求。`sample_picker` 在 `collect_samples` 时决定选取哪些 leaf 样本。解决 v1 单步回滚限制——agent 可自由 retry 任意次数。

并发模型：三阶段锁（prepare 持锁→proxy 不持锁→update 持锁），长推理期间不持锁，避免阻塞并发 chat 和 DELETE。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Hub 管线 | `generate_hub/` 三函数统一接口 | `--custom-generate-function-path` 插件式选择，兼容类式/新式/旧式 |
| 负载均衡策略 | `MilesRouter._use_url` + `X-SMG-Routing-Key` | least-active / consistent_hashing / manual 三策略 |
| 鸭子类型注入 | `TrajectoryLifecycle().sink` in `lifecycle.py:13` | 核心代码不 import dashboard，sink 为 None 时 no-op |
| Safetensors wire codec | `session/samples/codec.py` `SAMPLES_VALUE_SPEC` | R3 tensor 以 int32 strict 传输，不允许类型转换 |

### 为什么 Router 独立成层

四原因：多后端兼容（MilesRouter Python / SGLang Rust Router 切换不改 rollout 代码）；进程隔离（`multiprocessing.spawn` 独立进程，不继承 Ray actor 的 finalizer）；Session Server 解耦（需代理到 router，`backend_url=router_url`）；Health check 隔离（独立 event loop 不受 rollout async task 饥饿影响）。

## 模块间交互

`rollout/` 依赖 `miles/utils/http_utils`（post/get/router_worker_base_urls）、`miles/utils/types`（Sample）、`miles/utils/misc`（load_function/SingletonMeta）、`miles/utils/chat_template_utils`（TITOTokenizer/message_matcher）、`miles/utils/replay_base`（R3）。被 `miles/ray/rollout/rollout_manager.py` 调用——`load_rollout_function()` 加载 `InferenceRolloutFn`，`call_rollout_function()` 驱动。

Router 与 Session Server 关系：`RolloutManager` 经 `router_manager.py:start_router()` 启动 MilesRouter（或 SGLang Router），经 `start_session_server()` 为每个 port 启动独立 SessionServer 进程。SessionServer 的 `backend_url` 指向 router，router 再负载均衡到各 SGLang engine。

## 扩展方式

#### 新增一个 dynamic filter

在 `miles/rollout/filter_hub/dynamic_sampling_filters.py` 新增 `def my_filter(args, samples, **kwargs) -> DynamicFilterOutput`，通过 `--dynamic-sampling-filter-path` 指定。函数须返回 `DynamicFilterOutput(keep=bool, reason=str|None)`，旧版直接返回 bool 也兼容。内置 `check_reward_nonzero_std`（拒绝零方差组）和 `check_no_aborted`（拒绝含 ABORTED 的组）。

#### 接入新的 agentic environment

实现 `async def my_agent(base_url, prompt, request_kwargs, metadata, **kwargs) -> dict`，经 `--custom-generate-function-path miles.rollout.generate_hub.agentic_tool_call.generate` + `--custom-agent-function-path` + `--use-session-server` 指定。Agent 函数调 `POST /sessions/{id}/v1/chat/completions`，Session server 自动处理 TITO 和 R3。
