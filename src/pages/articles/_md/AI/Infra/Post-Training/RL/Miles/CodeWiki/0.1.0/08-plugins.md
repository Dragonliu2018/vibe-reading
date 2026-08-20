---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "插件系统"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "Plugins", "mbridge", "Megatron", "Model Spec", "Optimizer"]
description: "mbridge 声明式权重转换、model spec 注入自定义 attention、megatron_bridge 在线桥接、NVMe 流式 optimizer。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

插件系统是 Miles 的扩展层——模型架构差异极大（DeepSeek V4 sparse attention + indexer、GLM-5 DSA Multi-Latent Attention、Inkling 多模态 MoE 混合 GatedDeltaNet、Nemotron-H Mamba+Attention 混合），如果硬编码到核心会导致核心耦合数十个模型专用实现且 kernel 依赖互相冲突。插件经 CLI 参数注入，核心框架不 import 具体插件（依赖反转）。

## 模块架构

```
miles_plugins/                     ~11,200 行
├── mbridge/                       # HF↔Megatron 权重转换 bridge（1,632 行）
│   ├── qwen3_5.py                 #   Qwen3.5/3.6 MoE + MTP（含 fused/unfused expert）
│   ├── deepseek_v32.py            #   DeepSeek V3.2 DSA indexer
│   ├── deepseekv4.py              #   DeepSeek V4
│   ├── inkling.py                 #   Inkling（4 路 QKVR + expert 提取）
│   ├── glm4.py / glm4moe.py       #   GLM4 dense / MoE
│   └── ...                        #   10 个 bridge 类
├── megatron_bridge/               # megatron.bridge 集成（297 行）
│   └── nemotron_h.py              #   Nemotron-H MoE bridge（覆盖上游 dense 变体）
├── optimizers/                    # optimizer 插件（522 行）
│   └── nvme_stream.py             #   NVMe 流式 optimizer state（744B 模型）
└── models/                        # model-specific 实现（8,720 行）
    ├── deepseek_v4/               #   DeepSeekV4Attention
    ├── glm5/                      #   DSAMLASelfAttention（DSA MLA）
    ├── inkling/                   #   InklingGPTModel + provider + LoRA
    └── qwen3_5.py / qwen3_next.py / glm4.py / ...
```

## 核心实现

### mbridge 声明式权重转换

mbridge 是外部库，提供 `LLMBridge`/`Qwen2Bridge`/`Qwen2MoEBridge`/`DeepseekV3Bridge` 基类和 `@register_model` 装饰器。`miles_plugins/mbridge/` 的每个文件继承基类注册 bridge，用**声明式映射表** + **Template Method** 避免 per-model 写完整转换器：

```python title="miles_plugins/mbridge/qwen3_5.py (声明式映射表)"
@register_model(["qwen3_5", "qwen3_5_moe", "qwen3_6", "qwen3_6_moe"])
class Qwen3_5Bridge(Qwen2MoEBridge):
    _DIRECT_MAPPING = { ... }        # embedding/norm/output 直接映射
    _ATTENTION_MAPPING = { ... }     # attention 权重名映射 (MCore → HF)
    _MLP_MAPPING = { ... }           # MLP/MoE expert 权重名映射
    _CONFIG_MAPPING = { ... }        # HF config → Megatron TransformerConfig

    def _build_config(self) -> TransformerConfig: ...
    def _weight_to_mcore_format(self, name, hf_weights): ...  # HF tensor reshape/merge
    def _weight_split_across_tp(self, name, weights, param, tp_split_size): ...
```

基类算法骨架遍历 MCore 参数，按映射表加载/转换/切分，子类只 override 有特殊 reshape 需求的方法（如 `InklingBridge._weight_to_mcore_format` 处理 4 路 QKVR 合并 + 3D expert tensor 提取）。新增模型只需填三张表 + 几个 override。

### model spec 注入自定义 attention

model 插件不共享统一基类，而是直接继承 Megatron Core 的类，通过 `ModuleSpec` 注入：

```python title="miles_plugins/models/glm5/glm5.py (DSA MLA attention)"
class DSAMLASelfAttention(DSAMultiLatentAttention):
    def get_absorb_query_key_value_tensors(self, ...):  # QKV 投影 + indexer
    def forward(self, hidden_states, ...):

def get_glm5_spec(args, config, vp_stage):   # --spec 入口函数
    self_attn_module_spec = ModuleSpec(
        module=DSAMLASelfAttention,            # 替换默认 SelfAttention
        submodules=DSASelfAttentionSubmodules(...),
    )
```

经 `--spec "miles_plugins.models.glm5.glm5 get_glm5_spec"` 加载（`model_provider.py:224` `import_module(args.spec)`）。或经 `--custom-model-provider-path` 加载完整 model provider（如 Inkling 的 `inkling_model_provider` 返回 `InklingGPTModel`）。

### megatron_bridge 在线桥接

与 mbridge（离线 checkpoint 转换）不同，`megatron.bridge` 是 Megatron 自带的**在线模型定义桥接**（model provider 级别）。`miles_plugins/megatron_bridge/nemotron_h.py` 解决的问题是：Megatron 自带的 `NemotronHBridge` 只支持 dense 变体，不支持 MoE 变体。`MilesNemotronHBridge` 经 `@MegatronModelBridge.register_bridge` **覆盖**上游 bridge，追加 MoE 权重映射和 provider 字段：

```python title="miles_plugins/megatron_bridge/nemotron_h.py"
@MegatronModelBridge.register_bridge(source="NemotronHForCausalLM", target=MambaModel)
class MilesNemotronHBridge(NemotronHBridge):
    def provider_bridge(self, hf_pretrained):   # 注入 MoE 字段
    def mapping_registry(self):                  # 追加 MoE 权重映射
```

### NVMe 流式 optimizer

744B 参数的 Adam optimizer state（fp32 main + exp_avg + exp_avg_sq）可能超 GPU 显存。`NVMeOptimizerStateStore`（`nvme_stream.py:208`）把 state 存 NVMe 文件，`step()` 逐 bucket 读入 GPU → Adam step → 写回 NVMe → 释放。`setup_optimizer_state_streaming()`（`nvme_stream.py:445`）给每个 `DistributedOptimizer` 绑定 store，monkey-patch 5 个方法（`step_with_ready_grads`→`store.step()` 等）。GPU 显存占用从全量 state 降为单个 bucket。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Registry | `@register_model` in `mbridge/` / `@MegatronModelBridge.register_bridge` | 插件注册，新增模型不改核心代码 |
| Template Method | mbridge 基类 `load_weights()` 算法骨架 | 子类只 override 特殊步骤，避免 per-model 完整转换器 |
| Bridge | mbridge 三张映射表 | HF safetensors ↔ MCore checkpoint 双向桥接 |
| Strategy | `ModuleSpec` 注入不同 attention/MLP | Megatron 默认 SelfAttention → DSAMLASelfAttention/DeepSeekV4Attention |
| Monkey-Patch | NVMe optimizer `_bind()` / Nemotron-H shim | 运行时方法替换，幂等保护 + try/except |

### 为什么模型适配逻辑用插件而非硬编码

不同模型架构差异极大，硬编码会导致核心 `miles/` 包耦合数十个模型专用 attention/MLP 实现，新增模型需改核心代码，不同模型间 kernel 依赖（tilelang/flashinfer/deep_ep）互相冲突。插件经 `ModuleSpec` 替换 Megatron 默认模块，核心只依赖 `GPTModel` 接口。核心框架通过延迟 import + try/except 保证插件不可用时仍能运行（`megatron_utils/__init__.py:23-26`）。

### 插件契约如何定义

miles 的插件没有正式 ABC/Protocol，而是通过**约定**：

| 契约 | 签名 | 加载方式 |
|------|------|---------|
| mbridge bridge | 类属性映射表 + 可选 override + `@register_model` | import 时自动注册 |
| model spec | `def get_xxx_spec(args, config, vp_stage) -> ModuleSpec` | `--spec` |
| model provider | `def xxx_model_provider(pre_process, post_process, vp_stage) -> GPTModel` | `--custom-model-provider-path` |
| megatron bridge | `@MegatronModelBridge.register_bridge(source, target)` + 继承上游基类 | import 时自动注册 |

## 模块间交互

插件被 `miles/` 加载的入口：`miles/backends/megatron_utils/__init__.py:24`（import `miles_plugins.megatron_bridge`，try/except）；`tools/convert_hf_to_torch_dist.py:12`（import `miles_plugins.mbridge`）；`model_provider.py:146`（`--custom-model-provider-path`）/ `:224`（`--spec`）；`model.py:205`（`--stream-optimizer-state-to-disk`）。megatron_utils 不直接依赖任何具体插件，而是经 CLI 参数间接引用——**依赖反转**：核心定义扩展点，插件实现扩展点，框架参数注入。

## 扩展方式

#### 新增一个模型插件（mbridge bridge）

1. 新建 `miles_plugins/mbridge/foo.py`：`@register_model("foo_model")` 继承 `Qwen2MoEBridge`/`LLMBridge`/`DeepseekV3Bridge`，填三张映射表 + override `_build_config`/`_weight_to_mcore_format`
2. 编辑 `miles_plugins/mbridge/__init__.py` 加 import + `__all__`
3. （可选）新建 `miles_plugins/models/foo/foo.py`：定义自定义 `FooAttention(MegatronModule)` + `def get_foo_spec(...)` + `--spec` 指定

#### 新增一个优化器插件

新建 `miles_plugins/optimizers/cpu_offload_v2.py`：实现 `Store` 类（`step`/`save_to`/`load_from`）+ `setup_xxx(args, optimizer)` 入口（复用 `_bind` monkey-patch 模式）；`miles/backends/megatron_utils/model.py:setup_model_and_optimizer` 加加载入口（约 3 行）。

#### 为现有模型添加 MTP 支持

以 Qwen3.5 为参考模板（`miles_plugins/mbridge/qwen3_5.py:98-331`）：bridge 加 `_MTP_MLP_MAPPING_FUSED`/`_UNFUSED` 类属性；override `_weight_name_mapping_mcore_to_hf()` 调 `_convert_mtp_param()`；override `_get_gptmodel_args()` 加 `mtp_block_spec`；`_build_config` 从 HF config 读 `mtp_num_hidden_layers` 传 `mtp_num_layers`。
