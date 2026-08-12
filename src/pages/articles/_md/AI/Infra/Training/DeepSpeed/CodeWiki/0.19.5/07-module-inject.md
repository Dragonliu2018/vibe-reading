---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "模型注入"
date: "2026-08-12T15:52:44+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "AutoTP", "AutoEP", "模型替换", "张量并行"]
description: "模型注入模块负责将 HuggingFace 模型的 nn.Linear 层替换为 DeepSpeed 优化的 Tensor Parallel / Expert Parallel 层。本文解读 AutoTP 自动张量并行、Policy+Container 模型适配、AutoEP 专家并行三条核心路径。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

模型注入（module_inject）是 DeepSpeed 推理引擎的"手术刀"——它负责将用户从 HuggingFace 加载的 `nn.Module` 中的原始层（`nn.Linear`、`nn.Embedding`、`nn.LayerNorm` 等）替换为 DeepSpeed 优化的 **Tensor Parallel（TP）层** 或 **Expert Parallel（EP）层**，使模型在多 GPU 推理时自动实现张量并行分片和专家并行。

这个模块解决的核心问题是：**如何在不修改用户模型代码的前提下，将任意 HF 模型的权重自动分片到多个 GPU 上？** 模型注入通过两种路径回答这个问题：

- **AutoTP 路径**：递归遍历模型的 `nn.Linear` 层，按层名自动推断是 column-parallel（如 `q_proj`）还是 row-parallel（如 `o_proj`），替换为 `LinearLayer` 或 `LinearAllreduce`。无需手写 Policy，零配置。
- **Kernel Injection 路径（v1）**：通过 `TransformerPolicy` + `BaseTransformerContainer` 精确提取特定模型（BERT、GPT2、LLaMA 等）的 QKV/MLP/LayerNorm 权重，创建 DS 优化内核模块，实现深度融合优化。

模块边界：模型注入只负责"层替换"——它不执行推理（那是 `inference/engine.py` 的事）、不管理 checkpoint 加载细节（由 `load_checkpoint.py` 协作）、不实现集合通信原语（由 `deepspeed.comm` 提供）。它产出的是一个**结构已替换、权重已分片**的 `nn.Module`，交给推理引擎执行。

---

## 调用链路

模型注入的入口是 `replace_transformer_layer()`（`replace_module.py` L189），它根据配置分流到两条路径：

```
replace_transformer_layer()  (replace_module.py L189)
    │
    ├── config.replace_with_kernel_inject == True
    │   └── Kernel Injection 路径 (v1)
    │       replace_with_policy()  → policy_to_ds_container() → Container 10 步装配
    │       适用于: BERT/GPT2/LLaMA 等有 Policy 的模型，用 DS 推理内核
    │
    └── config.replace_with_kernel_inject == False
        └── AutoTP 路径
            replace_wo_policy()  → AutoTP._replace_module() 递归遍历
            适用于: 任意 HF 模型，通用 nn.Linear → TP 层替换
                │
                ├── partition_config == None (传统模式)
                │   └── tp_parser() 按层名推断 row/column → _replace() 路由
                │
                └── partition_config != None (新式 TPLayerSpec 配置)
                    └── _replace_with_config() → find_matching_spec() → 按预设分片
```

<details>
<summary>路径速查表</summary>

| 维度 | AutoTP 路径 | Kernel Injection 路径 |
| --- | --- | --- |
| 触发条件 | `replace_with_kernel_inject=False` | `replace_with_kernel_inject=True` |
| 入口函数 | `replace_wo_policy()` (L273) | `replace_with_policy()` (L216) |
| 模型适配 | 通用，按 `nn.Linear` 层名路由 | 需模型特定 Policy（如 `HFBertLayerPolicy`） |
| 替换产物 | `LinearLayer` / `LinearAllreduce` | DS 推理内核模块（`DeepSpeedTransformerInference`） |
| TP 分片 | 在 `LinearLayer.__init__` 中 `_tp_partition` | Container `apply_tensor_parallelism` + `mp_replace` |
| 配置方式 | 传统模式自动推断 / 新式 `TPLayerSpec` 预设 | `injection_policy` 指定模型层类 |
| 适用场景 | 快速部署、新模型零配置 | 追求极致推理性能、有 DS 内核优化 |

</details>

### AutoTP 递归遍历

AutoTP 路径的核心是 `AutoTP._replace_module()`（`auto_tp.py` L653），它递归遍历模型的 `named_children()`，对每个子模块按类型路由：

```python title="auto_tp.py _replace_module (L653)"
def _replace_module(self, r_module, prev_name='', prev_class_name=''):
    for name, child in r_module.named_children():
        # AutoEP 层跳过 TP，仅对 shared_experts 做 TP
        if getattr(child, "_is_autoep_layer", False):
            full_name = prev_name + '.' + name if prev_name else name
            self._replace_autoep_shared_experts(child, full_name)
            continue

        if self.partition_config is not None:
            # 新式配置：用 TPLayerSpec pattern 匹配
            full_name = class_name + '.' + name if class_name else name
            if hasattr(child, "weight") and child.weight.dim() == 2:
                new_child = self._replace_with_config(child, full_name)
                if new_child is not None:
                    setattr(r_module, name, new_child)
            else:
                self.update_mp_params(child)
                self._replace_module(child, name, class_name)
        elif child.__class__ in self.linear_policies:
            # 传统模式：按层名路由到 _replace()
            setattr(r_module, name, self.linear_policies[child.__class__](child, ...))
        else:
            self.update_mp_params(child)
            self._replace_module(child, name, class_name)
    return r_module
```

> **why 递归而非顶层替换**：HF 模型的层次结构因模型而异（有的 `model.layers.0.self_attn`，有的 `transformer.h.0.attn`），递归遍历不依赖固定路径，能适配任意嵌套深度。`_is_autoep_layer` 标记让 AutoTP 跳过 MoE 专家层，仅对 shared_experts 做 TP 分片——这是 AutoEP 与 AutoTP 协同的关键设计。

### Kernel Injection 的 Container 装配

Kernel Injection 路径通过 `replace_with_policy()`（`replace_module.py` L216）执行 10 步 Container 装配流水线：

```python title="replace_module.py replace_with_policy (L216)"
_container = policy_to_ds_container(policy=policy, config=config, ...)
_container.set_moe(moe)
_container.set_tensor_parallel_config(tp_size, tp_group)
_container.initialize_tensors()       # 从 Policy 提取 QKV/MLP/LayerNorm 权重
_container.convert_to_required_dtype() # fp16/bf16/int8 转换
_container.set_quantization_config(quantizer)
_container.create_ds_model_config()    # 构建 DeepSpeedInferenceConfig
_container.create_module()             # 创建 DS 内核模块
_container.transpose()                 # 权重转置（如需要）
_container.apply_tensor_parallelism(mp_replace)  # TP 分片
_container.copy_data_to_new_module()   # 将分片后权重复制到新模块
```

> **why Container 持有权重**：权重需要经历 提取 → dtype 转换 → 转置 → TP 分片 → 复制 多步变换。如果直接在原模块上操作，中间状态的内存峰值会导致 OOM。`BaseTransformerContainer` 作为中间持有者，在 `initialize_tensors()` 中从 Policy 提取权重引用，在 `apply_tensor_parallelism()` 中分片，最后在 `copy_data_to_new_module()` 中复制到新模块——每一步都可以释放前一步的中间张量，控制内存峰值。

---

## 核心实现

### AutoTP 自动张量并行

#### 层名路由：_replace()

传统模式下，`AutoTP._replace()`（`auto_tp.py` L354）是层替换的核心路由器，按层名决定 column-parallel 还是 row-parallel：

```python title="auto_tp.py _replace (L354)"
def _replace(self, child, name, conv_linear_layer):
    if getattr(child, "replaced", False) == True:
        return
    # AutoEP 管理的层跳过
    if getattr(child, "_is_autoep_layer", False):
        return child

    # 跳过 MoE gate / 低秩投影层
    if "mlp.gate" == name or "q_a_proj" in name or "kv_a_proj_with_mqa" in name:
        return child

    # row-parallel 层：o_proj, down_proj, dense_4h_to_h 等
    if name in self.all_reduce_linears or 'down_proj' in name:
        setattr(child, "replaced", True)
        return LinearAllreduce(child, self.mp_group, name=name)

    # column-parallel 层：q_proj, k_proj, v_proj, gate_proj, up_proj 等
    setattr(child, "replaced", True)
    return LinearLayer(child, self.mp_group, name=name)
```

`all_reduce_linears` 列表由 `tp_parser()` 自动推断——它扫描模型的所有 `nn.Linear` 层，根据层名模式（`o_proj`、`out_proj`、`down_proj`、`dense_4h_to_h` 等）识别 row-parallel 层：

```python title="auto_tp.py tp_parser (L291)"
def tp_parser(model):
    # ...
    for i, layer in enumerate(layer_list):
        if 'out_proj' in layer:
            gem_list = gem_list + [layer]
        elif 'o_proj' in layer:
            gem_list = gem_list + [layer]
        elif 'down_proj' in layer:
            gem_list = gem_list + [layer]
        elif 'dense_4h_to_h' in layer and 'ChatGLM' in str(model):
            gem_list = gem_list + [layer]
    # ...
    return policy_list  # [(module_type, gem_list), ...]
```

> **why 按层名而非结构推断**：TP 的 column/row 划分取决于权重在 Transformer 中的语义角色——`q_proj` 是 column-parallel（输出维度可切分），`o_proj` 是 row-parallel（输入维度可切分，输出需 all-reduce）。这种语义信息编码在 HF 模型的命名约定中（`_proj` 后缀），比解析模型结构更可靠且通用。

#### 新式配置：TPLayerSpec + AutoTPPresets

`autotp_config.py` 引入了声明式的 TP 配置方式，用正则 pattern 匹配层名，显式声明 partition type：

```python title="autotp_config.py TPLayerSpec (L28)"
@dataclass
class TPLayerSpec:
    patterns: List[str]                           # 正则匹配参数名
    partition_type: PartitionType = PartitionType.COLUMN
    shape: Optional[Tuple[...]] = None            # 子参数形状（如 fused QKV）
    partition_dim: Optional[int] = None           # 分片维度
    model_types: Optional[List[str]] = None       # 限定模型类型
    gather_output: bool = False                   # column-parallel 是否 gather 输出

    def matches(self, param_name, model_type=None) -> bool:
        if self.model_types:                      # 检查模型类型约束
            if model_type not in [mt.lower() for mt in self.model_types]:
                return False
        return any(re.match(pattern, param_name) for pattern in self.patterns)
```

`AutoTPPresets` 内置了 7 种主流模型的预设配置：

| 预设 | 模型 | 特殊处理 |
| --- | --- | --- |
| `llama()` | LLaMA | 分离 Q/K/V 投影，标准 column/row |
| `llama_gqa()` | LLaMA GQA | fused QKV，**不均等子参数** `((q_size, kv_size, kv_size), -1)` |
| `bloom()` | BLOOM | fused QKV 交错排列 `[q1,k1,v1,q2,...]`，无需 reshape |
| `chatglm()` | ChatGLM | fused QKV `(3, -1)` + chunked MLP `(2, -1)` |
| `mixtral()` | Mixtral MoE | 专家 w1/w3 column + w2 row，gate SKIP |
| `deepseek_v2()` | DeepSeek-V2 MLA | 低秩投影 `q_a_proj`/`kv_a_proj` SKIP，shared_experts TP |
| `phi3()` | Phi3 | fused `qkv_proj` `(3, -1)` + `gate_up_proj` `(2, -1)` |

```python title="autotp_config.py AutoTPPresets.deepseek_v2 (L454)"
@staticmethod
def deepseek_v2() -> AutoTPConfig:
    return AutoTPConfig(layer_specs=[
        TPLayerSpec(patterns=[r".*\.self_attn\.o_proj\.weight$"],
                    partition_type=PartitionType.ROW),
        # MLA 低秩投影跳过 TP（不做分片）
        TPLayerSpec(patterns=[r".*\.self_attn\.(q_a_proj|kv_a_proj_with_mqa)\.weight$"],
                    partition_type=PartitionType.SKIP),
        # Q/K/V 从 latent 投影，column-parallel
        TPLayerSpec(patterns=[r".*\.self_attn\.(q_b_proj|kv_b_proj)\.weight$"],
                    partition_type=PartitionType.COLUMN),
        # MoE 专家：w2 row, w1/w3 column
        TPLayerSpec(patterns=[r".*\.mlp\.experts\.\d+\.down_proj\.weight$"],
                    partition_type=PartitionType.ROW),
        TPLayerSpec(patterns=[r".*\.mlp\.experts\.\d+\.(up|gate)_proj\.weight$"],
                    partition_type=PartitionType.COLUMN),
        # MoE gate 跳过
        TPLayerSpec(patterns=[r".*\.mlp\.gate\.weight$"],
                    partition_type=PartitionType.SKIP),
        # Shared experts 做 TP
        TPLayerSpec(patterns=[r".*\.mlp\.shared_experts\.down_proj\.weight$"],
                    partition_type=PartitionType.ROW),
        TPLayerSpec(patterns=[r".*\.mlp\.shared_experts\.(up|gate)_proj\.weight$"],
                    partition_type=PartitionType.COLUMN),
    ])
```

> **why SKIP 类型**：MoE 的 gate 层（router）和 DeepSeek MLA 的低秩投影层（`q_a_proj`）不应该被 TP 分片——gate 需要看到完整的专家维度来做路由决策，低秩投影的中间维度太小切分后无法恢复。`PartitionType.SKIP` 让配置显式表达"不分片"，而非隐式跳过。

#### TP 层实现：LinearLayer / LinearAllreduce

`layers.py` 中的 `LinearLayer`（L724）和 `LinearAllreduce`（L628）是 AutoTP 的两个基本替换层，分别对应 column-parallel 和 row-parallel：

```python title="layers.py LinearLayer forward (L739)"
class LinearLayer(TensorParallel_Layer):
    """Column-parallel: 权重按 dim 0 分片，forward identity, backward all_reduce"""
    def forward(self, input):
        if not self.__class__.tp_overlap_comm:
            input = ColumnParallel.apply(self.mp_group, input)  # forward identity
            output = torch.matmul(input, self.weight.transpose(-1, -2))
            if self.bias is not None:
                output = add_bias(output, self.bias)
        else:
            output = AsyncColumnParallel.apply(self.mp_group, input, self.weight, self.bias)
        if self.gather_output:
            output = GatherFromTensorParallelRegion.apply(self.mp_group, output)
        return output
```

```python title="layers.py LinearAllreduce forward (L644)"
class LinearAllreduce(TensorParallel_Layer):
    """Row-parallel: 权重按 dim 1 分片，forward all_reduce, backward identity"""
    def forward(self, input):
        output = torch.matmul(input, self.weight.transpose(-1, -2))
        output = RowParallel.apply(self.mp_group, output, not self.is_training_mode())
        if self.bias is not None:
            output = add_bias(output, self.bias)
        return output
```

TP 通信模式通过 `torch.autograd.Function` 实现，正反向传播的通信互补：

| 通信类 | forward | backward | 适用层 |
| --- | --- | --- | --- |
| `ColumnParallel` (L201) | identity（直接返回 input） | `all_reduce` 梯度 | `LinearLayer` (column-parallel) |
| `RowParallel` (L140) | `all_reduce` 输出 | identity（直接返回梯度） | `LinearAllreduce` (row-parallel) |
| `GatherFromTensorParallelRegion` (L231) | `all_gather` 最后一维 | `narrow` 取本 rank 分片 | `LinearLayer` with `gather_output` |

> **why forward/backward 通信互补**：column-parallel 的 forward 不需通信（每个 rank 独立计算自己负责的输出列），但 backward 需 all-reduce 梯度（因为输入是完整的，梯度来自所有输出列）。row-parallel 正相反——forward 需 all-reduce 输出（每个 rank 只计算部分输入的乘积），backward 不需通信。这种互补关系确保了 TP 的数学正确性。

#### GQA 不均等分片

当 KV heads 数量不能被 TP world size 整除时（如 8 KV heads / 6 TP ranks），`get_shard_size()`（`tp_shard.py` L47）实现不均等分片：

```python title="tp_shard.py get_shard_size (L47)"
def get_shard_size(total_size, mp_size, name=None, rank=None):
    global num_kv_heads
    if num_kv_heads != None and total_size % num_kv_heads == 0 \
       and "mlp" not in str(name) and str(name) not in last_linear:
        # 按 KV heads 粒度分片：rank < 余数的多分一个 head
        my_slices = (num_kv_heads // mp_size) + (1 if rank < (num_kv_heads % mp_size) else 0)
        return total_size * my_slices // num_kv_heads
    else:
        # 近均等分片：grain_size 粒度
        grain_size = total_size // tp_grain_size
        return (grain_size // mp_size + (1 if rank < (grain_size % mp_size) else 0)) * tp_grain_size
```

> **why 按 KV heads 粒度**：GQA 中 KV heads 是最小不可分割单元——一个 KV head 的权重不能拆到两个 rank 上（否则 attention 计算错误）。当 8 KV heads / 6 ranks 时，rank 0-1 各分 2 个 heads（`8//6=1`，余数 2），rank 2-5 各分 1 个 head。`tp_grain_size` 控制 MLP 层的分片粒度，避免极小分片影响效率。

#### SubParamLinearLayer：子参数分片

`SubParamLinearLayer`（L1265）处理 fused QKV / chunked MLP 等权重内含多个逻辑子参数的情况，支持不均等子参数（GQA 的 Q/K/V 大小不同）：

```python title="layers.py SubParamLinearLayer (L1265)"
class SubParamLinearLayer(TensorParallel_Layer):
    """Column-parallel with sub-parameter support (fused QKV, GQA, chunked MLP)"""
    def __init__(self, module, mp_group, shape, partition_dim=0, **kwargs):
        # shape 可以是 (3, -1) 表示 3 个等长子参数
        # 或 ((q_size, k_size, v_size), -1) 表示不均等子参数
        (self._logical_shape, self._output_shape, self._subparam_sizes,
         self._bias_partition_dim) = _infer_subparam_logical_shapes(
            self._orig_weight_shape, self.shape, self.partition_dim, self.name)
        if self._should_materialize_tp_partition():
            self._tp_partition([self.weight, self.bias])
```

`_partition_logical_tensor()`（L1203）对子参数逐一分片后重新拼接，确保每个子参数（如 Q、K、V）各自被均匀切分：

```python title="layers.py _partition_logical_tensor (L1203)"
def _partition_logical_tensor(tensor, partition_dim, tp_world_size, tp_index, subparam_sizes=None):
    if subparam_sizes:
        # 先按 subparam_sizes 拆分，每个子参数独立 chunk，再拼回
        sub_params = torch.split(tensor, subparam_sizes, dim=partition_dim)
        partitioned_sub_params = [torch.chunk(sp, tp_world_size, dim=partition_dim)[tp_index]
                                  for sp in sub_params]
        return torch.cat(partitioned_sub_params, dim=partition_dim)
    return torch.chunk(tensor, tp_world_size, dim=partition_dim)[tp_index]
```

> **why 先拆后切再拼**：fused QKV 权重 `[3*hidden, hidden]` 如果直接 `chunk(6)` 会把 Q 和 K 的边界切断。正确做法是先拆成 Q `[hidden, hidden]`、K `[hidden, hidden]`、V `[hidden, hidden]`，各自独立 chunk，再拼回 `[3 * hidden/6, hidden]`。这样每个 rank 拿到的是完整的 Q/K/V 子集，attention 计算正确。

### Policy+Container 模型适配

#### TransformerPolicy：四个抽象方法

`TransformerPolicy`（`policy.py` L43）定义了从 HF 模型提取权重的契约——它用四个抽象方法解耦"从哪种 HF 模型提取"和"如何创建 DS 内核"：

```python title="policy.py TransformerPolicy (L43)"
class TransformerPolicy(DSPolicy):
    @abstractmethod
    def attention(self):
        """Returns attention qkv and dense parameters
        weight: (3*hidden, hidden) and (hidden, hidden)
        bias: (3*hidden) and (hidden)"""
        raise NotImplementedError

    @abstractmethod
    def get_hidden_heads(self):
        """return hidden_size and number of heads"""
        raise NotImplementedError

    @abstractmethod
    def mlp(self):
        """Returns mlp intermediate and output
        weight: (intermediate, hidden) and (hidden, intermediate)
        bias: (intermediate) and (hidden)"""
        raise NotImplementedError

    @abstractmethod
    def layernorm(self):
        """Returns LayerNorms used in transformer layer
        Post-Attention and pre/post layer norm
        gamma and beta with shape: (hidden)"""
        raise NotImplementedError
```

> **why 四个抽象方法而非一个**：不同 HF 模型的权重命名和结构差异巨大（BERT 的 `self.query` vs LLaMA 的 `q_proj` vs BLOOM 的 `query_key_value`），但它们都需要提取相同语义的四类权重：attention QKV、attention output、MLP intermediate/output、LayerNorm。四个方法将"提取什么"固定，将"从哪里提取"留给子类，实现了关注点分离。

#### BaseTransformerContainer：10 步装配

`BaseTransformerContainer`（`containers/base.py` L26）是 Container 的基类，持有从 Policy 提取的权重引用，执行 10 步装配流水线（见调用链路章节）。Container 持有 `qkvw`、`dense_w`、`_h4h_w`、`_4hh_w` 等权重引用：

```python title="containers/base.py initialize_tensors (L140)"
def initialize_tensors(self, enable_training=False):
    # 从 Policy 提取权重到 Container
    self.set_attention(*self.policy.attention(enable_training=enable_training))
    self.set_mlp(*self.policy.mlp(enable_training=enable_training))
    self.set_layernorm(*self.policy.layernorm())
```

Container 的 `apply_tensor_parallelism()`（L226）使用 `ReplaceWithTensorSlicing` 对 QKV 权重做 strided copy（按 head 分片），对 MLP 权重做普通 copy：

```python title="containers/base.py apply_tensor_parallelism (L226)"
def apply_tensor_parallelism(self, mp_replace):
    self.attention_qkv_mp(mp_replace)   # strided_copy num_splits=3
    self.attention_o_mp(mp_replace)     # copy
    self.mlp_inter_mp(mp_replace)       # copy
    self.mlp_output_mp(mp_replace)      # copy
```

> **why QKV 用 strided_copy**：fused QKV 权重按 head 交错排列 `[q_h1, k_h1, v_h1, q_h2, k_h2, v_h2, ...]`，简单 chunk 会打乱 head 结构。`strided_copy` 先按 3 split（Q/K/V 段），每个段内再按 `mp_size` split，最后按 head 交错重组，确保每个 rank 拿到完整的 head 子集。

#### Policy 注册：replace_policies

Policy 通过 `replace_policy.py` 注册到全局列表，`replace_module()` 在遍历时自动匹配：

```python title="replace_policy.py (L23)"
replace_policies = [
    HFBertLayerPolicy, HFGPTNEOLayerPolicy, GPTNEOXLayerPolicy,
    HFGPTJLayerPolicy, MegatronLayerPolicy, HFGPT2LayerPolicy,
    BLOOMLayerPolicy, HFOPTLayerPolicy, HFCLIPLayerPolicy,
    HFDistilBertLayerPolicy, LLAMALayerPolicy, LLAMA2LayerPolicy,
    InternLMLayerPolicy
]
```

`policy_to_ds_container()`（`utils.py` L14）维护 Policy → Container 的映射表，在运行时查找对应的 Container 类。

### AutoEP 专家并行

#### AutoEP 独立于 AutoTP

MoE 模型的专家权重需要 **Expert Parallelism（EP）** 而非 TP——EP 将不同专家分配到不同 rank，每个 rank 只持有部分专家。AutoEP（`auto_ep.py` L273）独立于 AutoTP 运行，通过 `_is_autoep_layer` 标记与 AutoTP 协同：

```python title="auto_tp.py _replace_module 中的 AutoEP 协同 (L657)"
for name, child in r_module.named_children():
    if getattr(child, "_is_autoep_layer", False):
        # MoE 专家层由 AutoEP 管理，AutoTP 跳过
        # 但 shared_experts 仍需 TP 分片
        full_name = prev_name + '.' + name if prev_name else name
        self._replace_autoep_shared_experts(child, full_name)
        continue
```

`_replace_autoep_shared_experts()`（`auto_tp.py` L632）对 MoE 层内的 shared_experts 子模块做 TP 分片，而专家权重留给 AutoEP 的 EP 分片：

```python title="auto_tp.py _replace_autoep_shared_experts (L632)"
def _replace_autoep_shared_experts(self, autoep_layer, autoep_name):
    for child_name in ("shared_experts", "shared_experts_gate"):
        child = getattr(autoep_layer, child_name, None)
        if child is None:
            continue
        full_name = f"{autoep_name}.{child_name}" if autoep_name else child_name
        # 对 shared_experts 做正常的 TP 替换
        if self.partition_config is not None:
            new_child = self._replace_with_config(child, full_name)
            if new_child is not None:
                setattr(autoep_layer, child_name, new_child)
```

> **why AutoEP 独立于 AutoTP**：TP 将同一层权重切分到所有 rank（每 rank 持有 1/N 权重），EP 将不同专家分配到不同 rank（每 rank 持有完整专家但数量减少）。两种并行策略的切分逻辑、通信模式完全不同——TP 需 all-reduce，EP 需 all-to-all。混在一起会增加复杂度且无法独立调优。`_is_autoep_layer` 标记实现了清晰的职责边界。

#### AutoEP 检测：ep_parser()

`AutoEP.ep_parser()`（`auto_ep.py` L283）遍历模型，用 `MoEModelPreset` 的 pattern 匹配 MoE 层，执行结构验证和参数推断：

```python title="auto_ep.py ep_parser (L283)"
def ep_parser(self) -> list[MoELayerSpec]:
    specs = []
    presets_to_try = self._resolve_presets()  # 按模型类型选择预设

    for preset_name, preset in presets_to_try:
        adapter = get_preset_adapter(preset.preset_adapter)
        pattern = re.compile(preset.moe_layer_pattern)

        for module_name, module in self.model.named_modules():
            if not pattern.fullmatch(module_name):
                continue
            # 结构验证：检查 experts 和 router 子模块
            experts_child = getattr(module, preset.experts_pattern, None)
            router_child = getattr(module, preset.router_pattern, None)
            # ...
            # 推断 hidden_size / ffn_hidden_size / num_experts / top_k
            spec = MoELayerSpec(moe_module_name=module_name, ...)
            specs.append(spec)
    return specs
```

#### MoEModelPreset：模型预设

`MoEModelPreset`（`auto_ep_presets/base.py` L27）定义了 MoE 模型族的预设结构，包含专家权重命名、router 位置、评分函数等：

```python title="auto_ep_presets/base.py MoEModelPreset (L27)"
@dataclass
class MoEModelPreset:
    moe_layer_pattern: str          # MoE 层的正则匹配
    router_pattern: str             # router 子模块名
    experts_pattern: str            # experts 子模块名
    expert_storage: Literal["fused_3d", "module_list"]  # 存储格式
    expert_w1: str                  # gate/up 投影权重名
    expert_w2: str                  # down 投影权重名
    expert_w3: str | None           # 独立 up 投影（None=fused gate+up）
    num_experts_attr: str           # config 中专家数量属性名
    top_k_attr: str                 # config 中 top_k 属性名
    score_func: Literal["softmax", "sigmoid"]
    has_shared_experts: bool = False
    shared_experts_pattern: str = ""
```

预设通过 `registry.py` 注册，内置支持 mixtral、qwen3_moe、qwen3_5_moe、deepseek_v2、deepseek_v3 五种 MoE 模型族。`AutoEPPresetAdapter` 提供了可扩展的适配器接口，模型特定的解析逻辑（如 expert layout 推断、forward contract 检测）可在 adapter 中覆盖。

#### Universal Checkpoint 元数据

AutoTP 替换层时会在参数上标记 Universal Checkpoint（UC）元数据，用于跨 TP 配置的 checkpoint 转换：

```python title="layers.py LinearAllreduce._mark_uc_metadata (L704)"
def _mark_uc_metadata(self):
    original_weight_shape = (self.weight.shape[0], self.weight.shape[1] * self.tp_world_size)
    self._set_param_uc_meta(self.weight,
                            partition_type='row',
                            partition_dim=1,
                            logical_shape=original_weight_shape,
                            original_shape=original_weight_shape)
```

`collect_autotp_universal_checkpoint_info()`（`layers.py` L496）遍历模型所有参数，收集 UC 元数据到模型级的 `UNIVERSAL_CHECKPOINT_INFO` 字典，供 `ds_to_universal.py` 做 checkpoint 格式转换：

```python title="layers.py collect_autotp_universal_checkpoint_info (L496)"
def collect_autotp_universal_checkpoint_info(model):
    row_parallel_patterns = []
    replicated_patterns = []
    parameter_with_sub_params = []
    # ...
    for module_name, module in model.named_modules():
        marker = getattr(module, "_mark_uc_metadata", None)
        if marker is not None:
            marker()
        for param_name, param in module.named_parameters(recurse=False):
            conversion_meta = _get_param_uc_conversion_meta(param)
            if not conversion_meta:
                # AutoTP 未触碰的参数 → TP-replicated
                replicated_patterns.append(pattern)
                continue
            if conversion_meta.get('partition_type') == 'row':
                row_parallel_patterns.append(pattern)
            # ...
```

> **why UC 元数据分两层**：参数级的 `_set_param_uc_meta` 保存 restore 时的完整细节（`sub_param_sizes`、`target_partition_shape`），模型级的 `collect_autotp_universal_checkpoint_info` 只收集 conversion 时需要的精简 schema。这样 restore 和 conversion 各取所需，避免元数据冗余传递。replicated_patterns 确保 LayerNorm/RMSNorm 等 AutoTP 未分片的参数在 UC 转换时不会被错误地按 dim 0 拼接扩展。

---

## 设计模式

| 模式 | 实现位置 | 作用 |
| --- | --- | --- |
| **Policy（策略模式）** | `TransformerPolicy` (policy.py L43) | 四个抽象方法定义提取契约，子类（`HFBertLayerPolicy` 等）实现具体提取逻辑，解耦模型适配与内核创建 |
| **Container（中间持有者）** | `BaseTransformerContainer` (containers/base.py L26) | 持有从 Policy 提取的权重引用，执行 10 步变换流水线，控制内存峰值 |
| **Template Method** | `BaseTransformerContainer.initialize_tensors()` (L140) | 模板方法调用 `self.policy.attention()` 等抽象方法，子类只覆写 Policy 不需改 Container |
| **Registry（注册表）** | `replace_policies` (replace_policy.py L23) + `policy_to_container` (utils.py L28) | Policy → Container 映射表，`replace_module()` 按模型层类查找匹配的 Policy |
| **Strategy（路由策略）** | `AutoTP._replace()` (auto_tp.py L354) | 按层名路由到 column/row/skip 分片策略，`_replace_with_config()` 用 TPLayerSpec pattern 匹配 |
| **Preset（预设）** | `AutoTPPresets` (autotp_config.py L321) + `PRESET_MODELS` (registry.py) | 内置模型族配置，用户选择模型名即获得正确的 TP/EP 分片方案 |
| **Adapter（适配器）** | `AutoEPPresetAdapter` (auto_ep_presets/base.py L154) | MoE 预设的适配器接口，模型特定的解析逻辑可在 adapter 中覆盖 |
| **Autograd Function** | `ColumnParallel` / `RowParallel` / `GatherFromTensorParallelRegion` (layers.py) | 自定义 forward/backward 通信模式，实现 TP 的数学正确通信 |

---

## 模块间交互

| 交互对象 | 交互方式 | 关键接口 |
| --- | --- | --- |
| **inference/engine.py** | engine 调用 `replace_transformer_layer()` 触发注入 | `replace_transformer_layer(orig_layer_impl, model, checkpoint_dict, config, model_config)` |
| **ops/transformer** | Kernel Injection 路径创建 DS 推理内核模块 | `DeepSpeedInferenceConfig`、`DeepSpeedTransformerInference` |
| **comm（deepspeed.comm）** | TP 层的集合通信原语 | `dist.all_reduce`、`dist.all_gather`、`dist.inference_all_reduce` |
| **checkpoint** | UC 元数据标记 + checkpoint 加载协作 | `_set_param_uc_meta`、`collect_autotp_universal_checkpoint_info`、`load_model_with_checkpoint` |
| **runtime/tensor_parallel** | TP 模式和进程组管理 | `AUTOTP_MODE.INFERENCE` / `TRAINING`、`groups.get_tensor_model_parallel_group()` |
| **moe/fused_expert** | AutoEP 替换后的 MoE 层使用 fused expert kernel | `AutoEPMoELayer`（`auto_ep_layer.py`）、`classify_fused_gate_up_layout` |
| **replace_policy.py** | Policy 注册表，`replace_module()` 遍历匹配 | `replace_policies` 列表、`generic_policies` 列表 |

AutoTP 与 AutoEP 的协同流程：AutoEP 先运行 `ep_parser()` 检测 MoE 层并标记 `_is_autoep_layer`，然后 `replace_moe_layers()` 替换为 `AutoEPMoELayer`。之后 AutoTP 的 `_replace_module()` 遍历时跳过已标记的 MoE 层，仅对 shared_experts 和非 MoE 层做 TP 分片。这种"先 EP 后 TP"的顺序确保专家权重走 EP 路径，共享权重走 TP 路径。

---

## 扩展方式

### 新增模型支持（Kernel Injection 路径）

1. 在 `containers/` 下创建 `HF{Model}LayerPolicy`（继承 `TransformerPolicy`），实现四个抽象方法：`attention()`、`mlp()`、`layernorm()`、`get_hidden_heads()`
2. 在 `containers/` 下创建 `DS_{Model}Container`（继承 `BaseTransformerContainer`），如需特殊权重处理可覆写 `apply_tensor_parallelism()` 等方法
3. 在 `utils.py` 的 `policy_to_container` 字典中注册映射
4. 在 `replace_policy.py` 的 `replace_policies` 列表中添加 Policy 类

### 新增 AutoTP preset

1. 在 `AutoTPPresets`（`autotp_config.py` L321）中添加 `@staticmethod` 方法，返回 `AutoTPConfig(layer_specs=[...])`
2. 在 `get_preset()` 的 `presets` 字典中注册模型类型到预设方法的映射
3. 用 `merge_autotp_configs()` 合并用户自定义 spec 与内置 preset

### 新增 AutoEP preset

1. 在 `auto_ep_presets/` 下创建新模块（如 `my_model.py`），定义 `PRESET_NAME` 和 `PRESET: MoEModelPreset`
2. 在 `registry.py` 的 `_PRESET_MODULES` 元组中添加模块
3. 如需模型特定的解析逻辑，创建 `AutoEPPresetAdapter` 子类并注册到 `_PRESET_ADAPTERS`
4. 在 `MoEModelPreset.hf_model_types` 中声明支持的 HF model_type

> **AutoTP vs AutoEP preset 的关系**：AutoTP preset 定义非专家层的 TP 分片方式，AutoEP preset 定义 MoE 层的 EP 检测和替换方式。对于 MoE 模型（如 Mixtral、DeepSeek-V2），两者都需要——AutoTP preset 处理 attention 和 shared_experts，AutoEP preset 处理专家层。`deepseek_v2()` AutoTP preset 中专家层的 `column`/`row` spec 在 AutoEP 路径中被跳过（因为 `_is_autoep_layer` 标记让 AutoTP 跳过整个 MoE 模块），但 shared_experts 的 spec 仍然生效。
