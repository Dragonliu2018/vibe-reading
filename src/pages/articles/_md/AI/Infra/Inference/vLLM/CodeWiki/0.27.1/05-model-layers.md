---
source:
  type: "源码解读"
  project: "vLLM"
  url: "https://github.com/vllm-project/vllm"
title: "模型执行层"
date: "2026-08-22T18:02:27+08:00"
category: [AI, Infra, Inference, vLLM, CodeWiki, "0.27.1"]
tags: ["vLLM", "并行层", "QKVParallelLinear", "FusedMoE", "量化", "权重加载"]
description: "解读 vLLM 模型执行层框架：把 PyTorch 标准层替换为 TP 并行版本，权重加载时拆分 fused 权重，量化作为可插拔算子覆盖 apply。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview)

---

## 模块定位

模型执行层模块（`vllm/model_executor/layers/`）是 vLLM 让"任意 HF 模型"在 TP/EP 下跑起来的框架层。它把 PyTorch 的标准 `nn.Module` 层替换为 vLLM 的并行/量化版本——`ColumnParallelLinear`、`QKVParallelLinear`、`VocabParallelEmbedding`、`FusedMoE`、`RMSNorm`、`RotaryEmbedding` 等。模型定义（`model_executor/models/` 下的 200+ 个模型）只实例化这些层，不用关心 TP 切分、量化 kernel 或权重融合的细节——那些都在层框架与权重加载器里处理。

## 模块架构

![模型执行层框架](/vibe-reading/images/articles/vllm/05-model-layers.svg)

模块核心是 `LinearBase`（`linear.py:233`）及其并行子类：`ColumnParallelLinear`（output 维切分，forward 后 all-gather）、`MergedColumnParallelLinear`（gate/up 融合）、`QKVParallelLinear`（QKV 融合 + KV head 复制）、`RowParallelLinear`（input 维切分，forward 后 all-reduce）、`ReplicatedLinear`（复制）。每个 `LinearBase` 持有一个 `quant_method` 对象（`LinearMethodBase`），forward 时调 `quant_method.apply(layer, x, bias)` 而非直接 GEMM——量化作为可插拔算子覆盖 `apply`，模型代码完全不感知量化方式。

## 调用链路

一次 `ColumnParallelLinear.forward`（`linear.py:591`）：

```
ColumnParallelLinear.forward(input_)
├─ output_parallel = quant_method.apply(self, input_, bias)
│  ├─ Unquantized → dispatch_unquantized_gemm(layer, x, weight, bias)
│  └─ Fp8 → self.fp8_linear.apply_weights(layer, x, bias)  # torch._scaled_mm / CUTLASS
├─ if gather_output and tp_size > 1:
│    output = tensor_model_parallel_all_gather(output_parallel)
└─ return output
```

`RowParallelLinear.forward`（`linear.py:1748`）：输入已是分片（来自 ColumnParallel）→ `quant_method.apply` → `tensor_model_parallel_all_reduce`。关键细节：**RowParallel 只在 rank 0 加 bias**（`bias_ = None if tp_rank > 0 else bias`），否则 all-reduce 后 bias 会被加 tp_size 次。

权重加载链（HF fused QKV → `QKVParallelLinear`）：

```
DefaultModelLoader.load_weights → model.load_weights
└─ AutoWeightsLoader + WeightsMapper.orig_to_new_stacked
   ├─ ".q_proj"/".k_proj"/".v_proj" → ".qkv_proj" (shard_id="q"/"k"/"v")
   └─ QKVParallelLinear.weight_loader(param, loaded_weight, loaded_shard_id="q")
      ├─ 计算 shard_offset / shard_size
      ├─ shard_rank = self.tp_rank  # q 按 TP 切
      │             或 self.tp_rank // num_kv_head_replicas  # k/v 复制
      └─ loaded_weight.narrow(output_dim, shard_rank*size, size).copy_(...)
```

数据流：HF checkpoint 的分开 q/k/v 权重 → 经 `WeightsMapper` 拼成 fused tensor 并附 `shard_id` → `weight_loader` 按 TP rank narrow 到正确分片。fused-on-disk（如 Phi-3 单一 `qkv_proj`）走 `_load_fused_module_from_checkpoint` 逐个拆分。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `ColumnParallelLinear.forward` | output 维切分的 forward | `gather_output` 控制 all-gather |
| `RowParallelLinear.forward` | input 维切分的 forward | rank 0 加 bias，all-reduce |
| `QKVParallelLinear.weight_loader` | 加载 fused QKV | KV head 复制 vs 切分 |
| `VocabParallelEmbedding.forward` | 词表并行 embedding | mask 非 rank token + all-reduce |
| `LogitsProcessor._get_logits` | hidden → logits | top-tokens gather 降通信量 |
| `QuantizationConfig.get_quant_method` | 按 layer 类型返回 Method | 策略分派 |
| `RoutedExperts.apply` | MoE 前向 | grouped GEMM + router top-k |

</details>

## 核心实现

### TP 切分维度与 weight_loader

`ColumnParallelLinear`（`linear.py:418`）沿 output 维切分（weight 的 dim=0），每 rank 持 `output_size/tp_size` 列，`weight_loader` 按 `output_dim` 属性 `narrow` loaded_weight 到 `start_idx = tp_rank * shard_size`。`RowParallelLinear`（`linear.py:1612`）沿 input 维切分，输出不切分、forward 后 all-reduce。`VocabParallelEmbedding`（`vocab_parallel_embedding.py:198`）沿词表维切分，forward 时把不属于本 rank 的 token id 置 0、mask 无效位置、再 all-reduce 汇总。

### Fused 权重加载时拆分

模型定义时把 gate/up 融合为一个 `MergedColumnParallelLinear`、q/k/v 融合为一个 `QKVParallelLinear`，减少 forward 中的 kernel launch。weight loading 时通过 `WeightsMapper.orig_to_new_stacked`（如 `llama.py` L346）把 HF checkpoint 中分开的 `gate_proj`/`up_proj`、`q_proj`/`k_proj`/`v_proj` 映射到融合参数的正确位置，附 `shard_id`。这样模型定义只需一个层、统一接口，运行时不需拆分/组装——权重在加载时已就位。

### 量化作为可插拔算子

`LinearBase.__init__`（`linear.py:276`）通过 `quant_config.get_quant_method(self, prefix)` 获取 `quant_method`，无 quant_config 时默认 `UnquantizedLinearMethod`。`QuantizationConfig.get_quant_method(layer)` 按 layer 类型返回不同 Method（`fp8.py:175`）：`LinearBase` → `Fp8LinearMethod`，`RoutedExperts` → `Fp8MoEMethod`，`Attention` → `Fp8KVCacheMethod`，可 `is_layer_skipped` 跳过特定层。这让同一个 `ColumnParallelLinear` 可跑 fp16/fp8/gptq/awq 任意量化，量化注册在 `quantization/__init__.py` 的 `method_to_config` 字典（27+ 种），支持 `@register_quantization_config` 装饰器自定义。

### FusedMoE 与 KV head 复制

MoE 单独一套（`fused_moe/`）：`RoutedExperts` 持 expert 权重（`w13_weight`=gate_up 融合、`w2_weight`=down_proj），`FusedMoEMethodBase` 定义 `apply(layer, x, topk_weights, topk_ids)`。单独成套因为：expert 分组要 grouped GEMM 而非单次 GEMM；MoE 支持 TP（每 expert 切分）与 EP（expert 分布到不同 rank）双模式，`FusedMoEParallelConfig` 有 `use_ep`/`ep_size` 等，`ExpertMapManager` 管 global→local expert 映射；forward 先 router 计算 top-k 再 grouped GEMM，逻辑与 Linear 完全不同。QKVParallelLinear 的 **KV head 复制**（`linear.py:1076`）：GQA/MQA 中 KV head 数 < TP size 时无法整除切分，改为复制——`num_kv_head_replicas = tp_size / total_num_kv_heads`，`weight_loader` 中 `shard_rank = tp_rank // num_kv_head_replicas` 使多 rank 加载同一份 KV 权重。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `QuantizeMethodBase` + 各 `LinearMethod` | 量化方式可替换 |
| 工厂 + 注册 | `get_quantization_config` in `quantization/__init__.py:109` | 字符串名延迟 import 避免循环 |
| PluggableLayer 注册 | `@PluggableLayer.register("column_parallel_linear")` | 运行时替换为优化实现 |
| Mixin | `QuantizationConfig.packed_modules_mapping` | 记录哪些算子要融合 |

## 模块间交互

被 `model_executor/models` 的所有模型直接实例化（如 `llama.py` 用 `VocabParallelEmbedding`/`QKVParallelLinear`/`RowParallelLinear`/`MergedColumnParallelLinear`/`RMSNorm`/`LogitsProcessor`/`ParallelLMHead`）。layers 调 `vllm/distributed` 的 `tensor_model_parallel_all_reduce`/`all_gather`/`gather` 与 `split_tensor_along_last_dim`，调 `vllm/v1/attention` 的 `Attention` 层，查 `current_platform`（`is_cuda_alike`/`use_all_gather`/`supported_quantization` 等）决定路径。权重加载经 `model_executor/model_loader/default_loader.py` 的 `DefaultModelLoader.load_weights`。

## 扩展方式

新增量化方法：在 `quantization/__init__.py` 的 `QuantizationMethods` 与 `method_to_config` 注册名；建 `quantization/my_quant/` 目录实现 `MyQuantConfig`（`get_quant_method` 按 layer 返 Method）与 `MyQuantLinearMethod`（`create_weights`/`apply`/`process_weights_after_loading`），或用 `@register_quantization_config` 装饰器。新增 weight loading 映射：在模型 `load_weights` 用 `WeightsMapper.orig_to_new_stacked` 定义映射。
