---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "框架核心"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "Batch", "KVCache", "Block", "Sequence", "Sampler"]
description: "xLLM 框架核心解读：Batch/Sequence/Request 批处理模型、KVCache/BlockManager 显存管理、Sampler 采样与 PrefixCache。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

框架核心（`core/framework/`）是贯穿全栈的共享数据结构层。`Batch`/`Sequence`/`Request` 是请求与批处理模型，`KVCache`/`Block`/`BlockManager` 是显存管理，`Sampler`/`PrefixCache`/`Tokenizer` 是推理辅助。这层独立是因为这些数据结构被 scheduler/runtime/layers 共同依赖——若分散在各模块会导致循环依赖与重复定义。把它抽到底层后，上层只引用而不定义。`~59.2k` 行 C++，是代码量最大的模块。

## 模块架构

```
framework/
├── batch/            # Batch 批处理单元 + 输入构建 + beam search
├── request/          # Request/Sequence/StoppingChecker/IncrementalDecoder/SequenceState
├── block/            # Block 物理块 + BlockManager(Pool) + 引用计数
├── kv_cache/         # KVCache + 多种实现(quantized/linear/deepseek_v4) + 容量估算
├── kv_cache_transfer/  # Mooncake KV 存储传输 + 层级缓存
├── prefix_cache/     # 前缀缓存（块哈希去重）
├── sampling/         # Sampler/BeamSearcher/RejectionSampler/ConstrainedDecoding
├── tokenizer/        # Tokenizer 封装（sentencepiece/tokenizers）
├── model/            # CausalLM/CausalVLM/DiTModel 抽象 + ModelArgs/Traits
├── model_loader/     # HF/DiT 权重加载器 + quant_args + state_dict
├── config/           # 17 个 Config 单例（ModelConfig/KVCacheConfig/SchedulerConfig...）
├── parallel_state/  # TP/DP/EP/CP/SP 并行状态
├── chat_template/    # 对话模板组装（Jinja-like）
├── multimodal/      # MMData 多模态数据结构
├── xtensor/          # xTensor 物理页池 + 全局分配器
├── eplb/             # MoE 专家负载均衡管理器
├── state_dict/       # 权重 state_dict 抽象
└── encoder_cache/    # 编码器缓存（VLM/DiT）
```

## 调用链路

框架核心被各层调用，本身不主动驱动。以 `Batch` 在一步内的生命周期为例：

```text
scheduler->schedule_request()
  ├─ RequestPriorityQueue 取请求 → 取出 Sequence*
  ├─ new Batch(sequences)                    in framework/batch/batch.h
  ├─ block_manager_pool->allocate(seqs)      # 为 Sequence 分配 Block
  └─ batch.prepare_forward_input(...)         # → ForwardInput

engine->step(batch)
  └─ batch→worker→executor→model.forward
       └─ KVCache[i] 逐层读写               in framework/kv_cache/kv_cache.h

batch.process_sample_output(SampleOutput)     # 输出写回 Sequence
  └─ Sequence::append_token(token)            in framework/request/sequence.h
```

<details>
<summary>核心对象速查表</summary>

| 对象 | 定义位置 | 职责 |
| --- | --- | --- |
| `Batch` | `framework/batch/batch.h` | 一批 Sequence 的执行单元，含 process_sample_output |
| `Sequence` | `framework/request/sequence.h` | 单请求生成状态机（tokens/kv_state/stage） |
| `Request` | `framework/request/request.h` | 用户请求，含多条 Sequence + callback |
| `Block` | `framework/block/block.h` | KV Cache 物理块句柄（引用计数 + 哈希） |
| `BlockManager` / `BlockManagerPool` | `framework/block/block_manager_pool.h` | 块分配/释放池 |
| `KVCache` | `framework/kv_cache/kv_cache.h` | 每层 K/V 张量抽象 |
| `KVCacheManager` | `framework/block/kv_cache_manager.h` | KV Cache 管理接口 |
| `Sampler` | `framework/sampling/sampler.h` | logits→token 采样 |
| `PrefixCache` | `framework/prefix_cache/prefix_cache.h` | 前缀块哈希去重 |

</details>

## 核心实现

### Sequence 阶段状态机

`Sequence`（`sequence.h`）是单条请求的生成状态载体。其核心是 `stage()` 方法依据 KV cache 已缓存 token 数与 prompt 长度判定阶段：

```cpp title="framework/request/sequence.h"
enum class SequenceStage : int8_t { PREFILL = 0, CHUNKED_PREFILL = 1, DECODE = 2 };

SequenceStage stage() const {
  if (kv_state_.kv_cache_tokens_num() <
      std::max(volatile_num_prompt_tokens_, num_prompt_tokens())) {
    if (kv_state_.kv_cache_tokens_num() > 0) return CHUNKED_PREFILL;
    return PREFILL;
  }
  return DECODE;
}
```

设计决策：`volatile_num_prompt_tokens_` 记录中断时的 token 数。序列被中断（显存不足释放全部 Block）时，已生成 token 保留，重排后视为 prompt 重新预填——这样不丢失已生成内容。`KVCacheState` 跟踪设备 KV 与 host KV（`host_kv_state_`，用于 PD 分离时的跨实例缓存）。

### Block 引用计数与哈希

`Block`（`block.h`）是 KV Cache 物理块句柄，用**原子引用计数**实现共享（多条 Sequence 共享同一 prefix 块）：

```cpp title="framework/block/block.h"
class Block final {
  int32_t id_ = -1;              # 块 ID
  uint32_t size_ = 0;            # 块大小
  std::atomic<uint32_t>* ref_count_;  # 引用计数（跨线程原子）
  BlockManager* manager_;        # 拥有者
  uint8_t hash_value_[XXH3_128BITS_HASH_VALUE_LEN];  # 前缀哈希
};
```

`ref_count_` 用原子变量是因为 disagg-PD 场景下调度线程 match 前缀块与 prefill threadpool 销毁序列在不同线程，inc/dec 不能竞争。`hash_value_` 是级联哈希（当前块 + 前序块哈希），用于 `PrefixCache` 精确匹配前缀。

### KVCache 多态实现

`KVCache`（`kv_cache.h`）是 pimpl 封装，内部 `KVCacheImpl` 有多种实现，按模型类型选择：
- `kv_cache_impl` — 标准密集 K/V
- `quantized_kv_cache_impl` — KV 量化（`kv_cache_dtype` 控制）
- `linear_attention_kv_cache_impl` — 线性注意力（DeepSeek MLA 等无显式 KV）
- `deepseek_v4_kv_cache_impl` — DeepSeek-V4 特殊缓存策略
- `indexed_kv_cache_impl` — 索引式 KV

`KVCacheManager`（`block/kv_cache_manager.h`）是管理接口，`BlockManagerPool` 是默认实现（每 DP rank 一个 `BlockManager`）。xTensor 模式下替换为 `XTensorAllocator` 管理的物理页池。

### BlockManager 与 PrefixCache

`BlockManagerPool`（`block_manager_pool.h`）管理多 DP rank 的块池。`PrefixCache`（`prefix_cache/prefix_cache.h`）在分配块前查询已有前缀：用 Block 的级联哈希匹配，命中则共享块（ref_count++），未命中则分配新块并计算哈希。`prefix_cache_with_upload` 支持把命中块上传到全局存储（Mooncake）供跨实例复用。

### Sampler 采样

`Sampler`（`sampling/sampler.h`）执行 logits→token：支持 temperature/top_k/top_p/frequency_penalty/presence_penalty/repetition_penalty。`BeamSearcher` 实现 beam search（多候选 + 打分）。`RejectionSampler` 支撑推测解码的拒绝采样。`ConstrainedDecoding` 支持结构化输出（JSON/grammar 约束）。

### Config 单例体系

`framework/config/` 有 17 个 Config 单例（`ModelConfig`/`KVCacheConfig`/`SchedulerConfig`/`ParallelConfig`/`DisaggPDConfig`/`ExecutionConfig`/`SpeculativeConfig`/`EPLBConfig`/...），每个用 `PROPERTY` 宏生成 getter/setter。`initialize_configs()` 在 `xllm.cpp` 启动时统一注册，gflags 解析后写入，`create_options()` 汇总。这套设计让配置项分散在各模块但统一管理。

## 模块间交互

- **被 Scheduler 依赖**：构建 `Batch`、管理 `Sequence` 生命周期、分配 `Block`。
- **被 Runtime 依赖**：`Executor::forward` 使用 `KVCache`、`ModelInputParams`；`Worker` 分配 `KVCache`。
- **被 Layers 依赖**：`CausalLM::forward` 接收 `KVCache` 引用，逐层传入。
- **被 distributed_runtime 依赖**：`Engine` 持有 `KVCacheManager`、`ModelArgs`、`Tokenizer`。

## 扩展方式

- 新增 KV Cache 实现：继承 `KVCacheImpl`，在 `KVCache` 构造函数增加分支。
- 新增 Config 项：在对应 `XxxConfig` 类用 `PROPERTY` 宏添加字段，在 `xllm.cpp` 的 `initialize_configs` 已自动覆盖。
- 新增采样策略：在 `sampling/` 增加实现，`Sampler` 内增加分支。
