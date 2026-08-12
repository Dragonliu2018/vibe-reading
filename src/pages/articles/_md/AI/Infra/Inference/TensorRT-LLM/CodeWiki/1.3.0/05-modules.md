---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "modules"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "modules", "Attention", "MoE", "融合算子", "torch.compile"]
description: "modules 是可组合的神经网络算子层——Attention/MLP/MoE/RMSNorm，分离计算逻辑与 kernel 实现，支持 torch.compile 与融合路径。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/TensorRT-LLM/CodeWiki/1.3.0/00-overview)

---

## 模块定位

modules 是模型层与 kernel 层之间的算子组件层——`Attention`、`MLP`、`MoE`、`RMSNorm` 等可组合的 `nn.Module`。它封装了 QKV 投影、RoPE、TP/CP 切分、量化、LoRA 等**与 kernel 无关的逻辑**，把核心 attention 计算委托给 `attention_backend/`，把 GEMM/激活委托给 `custom_ops`。模块独立存在是为了**分离计算逻辑与 kernel 实现**：切换 backend 只需改配置，无需改算子代码。

## 模块架构

```
Attention (attention.py:384)       ← QKV/O 投影 + RoPE + TP/CP + 后端委托
  └── self.attn: AttentionBackend  ← 核心 attention 计算（策略可切换）
MLP (mlp.py:17)                    ← up_proj + activation + down_proj
GatedMLP (gated_mlp.py:20)         ← gate_up_proj + SwiGLU + down_proj
MoE (fused_moe/interface.py:224)   ← 接口 + 工厂 + 委托（@final forward）
  └── ConfigurableMoE              ← 包装 backend，添加调度/通信
RMSNorm (rms_norm.py:40)           ← 归一化 + NVFP4 融合量化
```

## 调用链路

### Attention.forward 流程

```
Attention.forward(position_ids, hidden_states, attn_metadata)  [attention.py:1016]
  ├─ qkv_proj(hidden_states)              → fused QKV
  ├─ preprocess_qkv(qkv, position_ids)    → split + RoPE（若 rope_fusion=False）
  ├─ convert_qkv(q, k, v)                 → fused/unfused 按 backend 要求
  ├─ forward_impl(q, k, v, ...)           [attention.py:922]
  │   ├─ [torch.compile] attn_custom_op_inplace()
  │   └─ [否则] self.attn.forward(q,k,v,metadata)  → attention_backend
  └─ o_proj(attn_output)                  → output（含 CP reduce-scatter）
```

### MoE.forward 流程

```
MoE.forward(x, router_logits)           [interface.py:1031]  ← @final
  ├─ [torch.compile] moe_custom_op()    → forward_impl
  └─ [否则] forward_impl(x, router_logits)
      → ConfigurableMoE: routing → dispatch → backend.run_moe(ctx) → combine → reduce
```

| 组件 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `Attention` | QKV 投影 + RoPE + 后端委托 | 能力协商（support_fused_rope 等） |
| `MoE` | 接口 + @final forward | 统一所有 backend 调用契约 |
| `ConfigurableMoE` | 调度/通信包装 | 委托 backend，添加横切逻辑 |
| `GatedMLP` | gate_up + SwiGLU + down | NVFP4 融合 GEMM+激活+量化 |

## 核心实现

### Attention 与 backend 的能力协商

`Attention.__init__` in `attention.py:610` 通过 `get_attention_backend()` 获取后端类，`create_attention()` 实例化为 `self.attn`。关键是不硬编码 if-else，而是**能力查询**：`attn_cls.support_fused_rope()` / `support_fused_qkv()` / `support_mla()` 等类方法声明 backend 能力，`Attention.__init__` 据此协商配置（`attention.py:649-656` 的 rope_fusion 协商）。新增 backend 只需声明能力。**Why**：不同硬件/场景最优 kernel 不同，能力协商让算子适配多 backend 而不修改自身。

### MoE 的接口-工厂-委托三层设计

- **接口层** `MoE` 基类（`interface.py:224`）：`forward()` 标记 `@final`，定义统一骨架（perfect router → torch.compile 分支 → `forward_impl`），子类只实现 `forward_impl` / `run_moe`。`capabilities` / `input_requirement` 类属性让调度器查询能力。
- **工厂层** `create_moe.py:get_moe_cls()`（`create_moe.py:60`）：按 `moe_backend` + `quant_config` + SM 版本选具体类，含 fallback（Marlin 不支持非 NVFP4 → CutlassFusedMoE）。
- **委托层** `ConfigurableMoE`（`configurable_moe.py:72`）：包装具体 backend，把 `create_weights`/`load_weights`/`run_moe` 全部委托，同时添加 scheduler（`EXTERNAL_COMM`/`FUSED_COMM`）、通信策略、EPLB/DWDP 集成。backend 只需实现 `run_moe(ctx)`，不用关心跨 rank 通信。

routing 同样可插拔：`BaseMoeRoutingMethod` 有十余种实现（Default/DeepSeekV3/LoadBalanced/SparseMixer 等），通过 `routing_method` 参数注入。

### 融合算子模式

MLP / GatedMLP / MoE / RMSNorm 都有 fused 路径，将 GEMM + activation + quantization 融合进单个 CUDA kernel：

- `MLP._fused_gelu()` → `torch.ops.trtllm.cute_dsl_nvfp4_dense_gemm_gelu_blackwell`（`mlp.py:236`）
- `GatedMLP._fused_gate_up_swiglu()` → `cute_dsl_nvfp4_dense_gemm_swiglu_*_blackwell`（`gated_mlp.py:277`）
- `RMSNorm.forward()` → fused add + RMSNorm + NVFP4 quantize（`rms_norm.py:126`）

每个融合路径有静态资格检查（`_can_fuse_*`）和运行时降级。**Why**：融合避免中间 BF16 物化，减少显存带宽压力。NVFP4 融合路径仅在 SM 100-119（Blackwell）生效。

### torch.compile 集成

所有模块通过 `torch.library.custom_op` 支持 torch.compile 图捕获：`trtllm::create_attn_outputs` + `trtllm::attn_custom_op_inplace`（`attention.py:64,75`）、`trtllm::moe_custom_op`（`interface.py:162`）。custom op 通过 `weakref` + `model_config.extra_attrs` 引用 layer 实例，使图能捕获动态行为同时保持可序列化。`is_torch_compiling()` 时 Attention/MoE 切换到 custom op 路径。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略 | `get_attention_backend()` in `attention_backend/utils.py:18` | 多 attention backend 可切换 |
| 工厂 | `get_moe_cls()` in `create_moe.py:60` | MoE backend 按配置 + 量化选 |
| 委托 | `ConfigurableMoE` 包装 backend in `configurable_moe.py:72` | 横切逻辑与 kernel 分离 |
| 模板方法 | `MoE.forward` @final in `interface.py:1031` | 统一 forward 骨架 |
| 融合算子 | `_fused_*` 路径 in mlp/gated_mlp/rms_norm | 减少 intermediate 物化 |

## 模块间交互

modules 向下调用 `attention_backend/`（`Attention` 通过 `self.attn.forward()`，`AttentionForwardArgs` 封装参数）和 `custom_ops`（`torch.ops.trtllm.*`，如 `helix_post_process`、`fused_relu2_quantize`、`cute_dsl_nvfp4_*`）。向上被 `models/` 继承——模型类继承 modules 基类（`DeepseekV3Attention(MLA)`、`Llama4Attention(Attention)`），添加模型特定初始化和 forward 路由。

## 扩展方式

**新增 Attention 变体（如 QK Norm）**：参照 `qk_norm_attention.py`——创建 `QKNormAttention(Attention)` override `apply_rope()` 在 RoPE 前插入 Q/K 的 RMSNorm。不需改 backend——QK Norm 在 `preprocess_qkv` 阶段完成，传给 backend 的 q/k 已 norm。

**新增 MoE 路由策略**：在 `fused_moe/routing.py` 新增 `XxxMoeRoutingMethod(BaseMoeRoutingMethod)` → `RoutingMethodType` enum 添加类型 → `__all__` 导出。不需改 MoE 基类或 backend。

**新增 MoE backend**：创建 `fused_moe_xxx.py` 定义 `XxxFusedMoE(MoE)` 实现 `create_weights`/`load_weights`/`run_moe`/`can_implement` → `get_moe_cls()` 添加分支 → 设置 `scheduler_kind`/`capabilities` 类属性。
