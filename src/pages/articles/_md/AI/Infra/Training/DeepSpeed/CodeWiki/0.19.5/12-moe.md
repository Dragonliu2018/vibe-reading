---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "MoE 专家混合"
date: "2026-08-12T15:35:32+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "MoE", "Expert Parallel", "Grouped GEMM", "Top-K Gate"]
description: "DeepSpeed v0.19.5 的 MoE 模块包含三套技术栈：原始训练栈(TopKGate+Experts for-loop+AllToAll)、AutoEP 栈(TokenChoiceTopKRouter+GroupedExperts grouped GEMM+AllToAllV)、推理栈(RaggedTopKGating kernel+CUTLASS MoEGEMM)，覆盖训练、替换注入、推理三个场景。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

DeepSpeed 的 MoE（Mixture of Experts）子系统并非单一实现，而是**三套独立技术栈**的集合，分别面向三个场景：

| 技术栈 | 入口模块 | 路由器 | 专家计算 | 通信原语 | 场景 |
|--------|---------|--------|---------|---------|------|
| **原始训练栈** | `MOELayer` (`sharded_moe.py`) | `TopKGate` (k=1/2/K) | `Experts` for-loop | `_AllToAll` (等长) | 从零训练 MoE 模型 |
| **AutoEP 栈** | `AutoEPMoELayer` (`auto_ep_layer.py`) | `TokenChoiceTopKRouter` | `GroupedExperts` grouped GEMM | `_AllToAllV` (变长) | 替换 HuggingFace MoE 模型为 EP 版本 |
| **推理栈** | `DSMultiGemmMoE` (`cutlass_multi_gemm.py`) | `RaggedTopKGating` kernel | `MoEGEMM` (CUTLASS) | 无（单卡 ragged） | 高吞吐推理 |

三套栈的关键差异在于**数据搬移方式**：原始栈用 dense capacity buffer `[E, C, M]` 定长分发，AutoEP 用 permutation（expert-contiguous + alignment pad）变长分发，推理栈用 ragged batch（按 expert 偏移量组织）。从原始栈到 AutoEP 栈的演进核心是：放弃定长 capacity buffer，改为按实际路由结果排序 token，配合 grouped GEMM 避免空转——内存效率更高，也更适配 `torch._grouped_mm` 的接口。

MoE 模块目录 `deepspeed/moe/` 包含 8 个核心文件约 3500 行代码，另有 `module_inject/auto_ep_layer.py`（AutoEP 注入层）和 `inference/v2/modules/implementations/moe/cutlass_multi_gemm.py`（推理实现）分属不同子包。

## 调用链路

### 原始训练栈：MOELayer.forward

```
MOELayer.forward(input)                           sharded_moe.py L668
├── reshaped_input = input.reshape(-1, d_model)   ← 拍平为 [S, M]
├── gate_output = TopKGate(reshaped_input)        L528 → top1gating/top2gating/topkgating
│   └── returns: l_aux, C(capacity), E(experts), indices, locations, gates, exp_counts
├── _route_slots(indices, locations, E, C)        L196 ← 计算 [E*C] 中的扁平槽位
├── _sparse_encode(reshaped_input, slots, E, C)   L207 ← scatter 到 [E, C, M] dense buffer
├── drop_tokens(dispatched_input, dim=1)          mappings.py ← TP 去重（如有 TP）
├── _AllToAll.apply(ep_group, dispatched_input)   L97 ← EP dispatch（等长）
├── reshape → [ep_size, local_experts, C, M]
├── experts(dispatched_input)                     experts.py ← for-loop 逐专家计算
├── reshape → [ep_size * local_experts, C, M]
├── _AllToAll.apply(ep_group, expert_output)      ← EP gather（反向 all-to-all）
├── gather_tokens(expert_output, dim=1)           ← TP 恢复（如有 TP）
├── _sparse_decode(expert_output, slots, gates, S) L223 ← 加权求和回到 [S, M]
└── return combined_output.reshape(input.shape)
```

### AutoEP 栈：AutoEPMoELayer.forward

```
AutoEPMoELayer.forward(hidden_states)             auto_ep_layer.py L575
├── x = hidden_states.reshape(-1, hdim)           ← [B,S,H] → [T,H]
├── RouterOutput = TokenChoiceTopKRouter(x)       ep_router.py L27
│   └── returns: top_scores[T,K], selected_experts[T,K], num_tokens_per_expert[E]
├── argsort(selected_experts.view(-1), stable)    ← 按 expert 排序
├── [TP Folding] partition_assignments(payload)   ep_tp_dispatch.py L230
│   └── assignment_index % tp_size == tp_rank     ← 分片到 TP peer
├── routed_input = x[token_indices // top_k]      ← 按排序顺序取 token
├── _AllToAllV.apply(ep_group, routed_input, splits)  L184 ← 变长 dispatch
├── permute_by_local_expert(routed_input, counts) auto_ep_layer.py L230
│   └── generate_permute_indices (Triton kernel)  ep_kernels.py L190
│   └── alignment pad to TOKEN_GROUP_ALIGN_SIZE_M(8)
├── GroupedExperts(permuted_input, aligned_counts) ep_experts.py L177
│   └── triton_grouped_mm / grouped_mm / for_loop  ← 三路径选择
├── unpermute_by_local_expert(expert_output)      auto_ep_layer.py L290
├── _AllToAllV.apply(ep_group, expert_output, reverse_splits)  ← 反向 gather
├── [TP Folding] restore_combined(expert_output)  ep_tp_dispatch.py L397
│   └── _AllGatherVariableRows (TP all-gather)     L283
└── combine_from_routed(...) / restore_combined   ← 加权合并回 [B,S,H]
```

<details>
<summary>方法速查表</summary>

| 方法 | 文件 / 行号 | 一行职责 | 关键设计 |
|------|------------|---------|---------|
| `TopKGate.forward` | `sharded_moe.py` L578 | 路由决策 + 辅助损失 | k=1/2/K 分发到三个 gating 函数 |
| `top1gating` | `sharded_moe.py` L235 | Top-1 路由 (Switch Transformer) | RTS 随机选择 + capacity 限制 |
| `top2gating` | `sharded_moe.py` L341 | Top-2 路由 (GShard) | Gumbel-max trick 选第二专家 |
| `topkgating` | `sharded_moe.py` L434 | 通用 Top-K 路由 | drop_policy: probs/position |
| `_sparse_encode` | `sharded_moe.py` L207 | token → [E,C,M] dense buffer | 反转路由表变 scatter 为 gather |
| `_sparse_decode` | `sharded_moe.py` L223 | [E,C,M] → [S,M] 加权求和 | fp32 累加避免精度损失 |
| `MOELayer.forward` | `sharded_moe.py` L668 | 原始 MoE 完整前向 | gate→encode→A2A→experts→A2A→decode |
| `TokenChoiceTopKRouter.forward` | `ep_router.py` L136 | AutoEP 路由 | node-limited + e_score_correction_bias |
| `AutoEPMoELayer.forward` | `auto_ep_layer.py` L575 | AutoEP 完整前向 | router→argsort→A2AV→permute→experts |
| `GroupedExperts.forward` | `ep_experts.py` L242 | 分发到三路径 | triton_grouped_mm / grouped_mm / for_loop |
| `_run_experts_triton_grouped_mm` | `ep_experts.py` L140 | Triton grouped GEMM | trans_b=True 避免转置 copy |
| `_run_experts_grouped_mm` | `ep_experts.py` L92 | torch._grouped_mm 路径 | sm90+ 原生支持 |
| `group_gemm_triton` | `group_gemm_triton.py` L448 | Triton grouped GEMM 入口 | drop-in 替代 torch._grouped_mm |
| `_GroupGemmFn` | `group_gemm_triton.py` L392 | autograd Function | trans_b 在 forward 内部处理 |
| `partition_assignments` | `ep_tp_dispatch.py` L230 | TP 分片 | assignment_index % tp_size |
| `restore_combined` | `ep_tp_dispatch.py` L397 | TP 恢复 + 加权合并 | _AllGatherVariableRows 可微 |
| `generate_permute_indices` | `ep_kernels.py` L190 | 生成 permutation 索引 | Triton kernel + alignment pad |
| `_AllToAll` | `sharded_moe.py` L97 | 等长 all-to-all (autograd) | backward = 反向 all-to-all |
| `_AllToAllV` | `auto_ep_layer.py` L184 | 变长 all-to-all (autograd) | backward 交换 input/output splits |
| `_AllGatherVariableRows` | `ep_tp_dispatch.py` L283 | 变长 all-gather (autograd) | backward = reduce-scatter |
| `MoE.__init__` | `layer.py` L38 | 原始栈用户入口 | 组装 TopKGate + Experts → MOELayer |
| `DSMultiGemmMoE.forward` | `cutlass_multi_gemm.py` L195 | 推理 MoE 前向 | ragged batch + CUTLASS MoEGEMM |

</details>

## 核心实现

### TopKGate 路由策略

`TopKGate`（`sharded_moe.py` L528）是原始训练栈的路由器，按 `k` 值分发到三个独立函数：

**k=1 — top1gating (Switch Transformer)**

```python title="sharded_moe.py L235 — top1gating 核心逻辑"
gates = F.softmax(logits, dim=1)
indices1_s = torch.argmax(logits_w_noise if noisy_gate_policy == 'RSample' else gates, dim=1)
mask1 = F.one_hot(indices1_s, num_classes=num_experts)

# Random Token Selection: 对 mask 乘随机数后 topk 选 capacity 个
if use_rts:
    mask1_rand = mask1 * uniform(mask1.shape)
top_idx = _top_idx(mask1_rand, selection_capacity)  # dim=0 topk
new_mask1 = mask1 * torch.zeros_like(mask1).scatter_(0, top_idx, 1)

# 辅助损失: l_aux = sum(me * ce) * E
me = torch.mean(gates, dim=0)       # 每个专家的平均 gate 概率
ce = torch.mean(mask1.float(), dim=0)  # 每个专家被选中的比例
l_aux = torch.sum(me * ce) * num_experts
```

`noisy_gate_policy='RSample'` 使用 Gumbel 噪声注入（L246），`'Jitter'` 使用乘性抖动（L56），两者目的相同：防止路由坍缩到少数专家。RTS（Random Token Selection）在超容量时随机丢弃 token 而非确定性丢弃，避免同一 token 总被丢弃。

**k=2 — top2gating (GShard)**

```python title="sharded_moe.py L341 — top2gating Gumbel-max 选第二专家"
# 第一专家：直接 argmax
indices1_s = torch.argmax(gates, dim=1)
mask1 = F.one_hot(indices1_s, num_classes=num_experts)

# 第二专家：Gumbel-max trick
# 加 Gumbel 噪声后屏蔽第一专家，再 argmax
logits += gumbel_rsample(logits.shape, device=logits.device)
logits_except1 = logits.masked_fill(mask1.bool(), float("-inf"))
indices2_s = torch.argmax(logits_except1, dim=1)

# 辅助损失: l_aux = mean(me * ce) * E^2
l_aux = torch.mean(me * ce) * num_experts * num_experts

# 归一化：gates / (g1 + g2)
denom_s = gates1_s + gates2_s
gates1_s /= denom_s
gates2_s /= denom_s
```

Gumbel-max trick 是一种无需替换的采样方法：对 logits 加 Gumbel 噪声后 argmax 等价于按 softmax 概率采样。这里用它选第二专家，保证第二专家不是第一专家的简单 runner-up，而是真正的概率采样。辅助损失乘 `E^2` 而非 `E`，因为 top-2 场景下负载均衡的惩罚需要更强。

**通用 K — topkgating**

```python title="sharded_moe.py L434 — topkgating 两种 drop_policy"
top_gate, top_idx = torch.topk(gates, k=k, dim=1)
mask = torch.zeros_like(gates, dtype=torch.bool).scatter_(1, top_idx, 1)

if drop_policy == 'probs':
    # 按概率选 capacity 个：对每个专家列，取 gate 值最大的 capacity 个
    topk_masked_gates = torch.zeros_like(gates).scatter(1, top_idx, top_gate)
    _, capacity_indices = torch.topk(topk_masked_gates, k=selection_capacity, dim=0, sorted=False)
    capacity_mask = torch.zeros_like(gates, dtype=torch.bool).scatter_(0, capacity_indices, True)
    mask &= capacity_mask
elif drop_policy == "position":
    # 按位置截断：cumsum 后保留前 capacity 个
    locations = torch.cumsum(mask, dim=0) - 1
    mask *= torch.lt(locations, capacity)

# 辅助损失: l_aux = mean(me * ce) * E^2 / K
l_aux = torch.mean(me * ce) * num_experts * num_experts / k
```

`drop_policy='probs'` 按概率大小丢弃（低概率 token 先丢），`'position'` 按到达顺序丢弃（先到先得）。probs 策略在 token 重要性差异大时更合理，position 策略在序列顺序有意义时更安全。辅助损失除以 `k` 是因为 top-K 的负载分散到 K 个选择上，惩罚力度应相应降低。

**辅助损失统一公式**：`l_aux = mean(me * ce) * E^2`（top1 为 `sum * E`，等价变形）。`me` 是每个专家收到的平均 gate 概率，`ce` 是每个专家实际被选中的比例。当所有专家均匀分布时 `me = ce = 1/E`，乘积为 `1/E^2`，`l_aux` 最小；路由坍缩时乘积增大，梯度推动 gate 权重远离坍缩专家。

**TokenChoiceTopKRouter（AutoEP 栈）**（`ep_router.py` L27）是更现代的路由器，支持两个原始栈不具备的能力：

```python title="ep_router.py L82 — node-limited routing (DeepSeek-V3)"
# 专家按 node 分组，先选 top-N 个 group，再在组内选 top-K
scores_grouped = scores_for_choice.view(-1, num_expert_groups, experts_per_group)
# group score = top-2 专家分数之和（DeepSeek-V3 策略）
top2_scores_in_group, _ = scores_grouped.topk(2, dim=-1)
group_scores = top2_scores_in_group.sum(dim=-1)
_, group_idx = torch.topk(group_scores, k=num_limited_groups, dim=-1, sorted=False)
# 屏蔽非选中组的专家
group_mask = torch.ones_like(group_scores, dtype=torch.bool)
group_mask.scatter_(1, group_idx, False)
scores_for_choice = scores_grouped.masked_fill(group_mask.unsqueeze(-1), float("-inf"))
```

Node-limited routing 将专家按物理节点分组，先选 `num_limited_groups` 个组再在组内选 top-K，减少跨节点 AllToAll 通信量。`e_score_correction_bias`（L76）是 DeepSeek-V3 noaux_tc 路由的可训练偏置——它影响 top-K 选择但不影响 gate 分数本身（L178: `top_scores = scores.gather(...)` 用的是原始 scores），从而解耦了"选谁"和"权重多大"。

### GroupedExperts 与 Triton GroupGEMM

`GroupedExperts`（`ep_experts.py` L177）是 AutoEP 栈的专家计算模块，支持三条执行路径：

```python title="ep_experts.py L202 — GroupedExperts 路径选择"
if use_grouped_mm and not disable_triton_grouped_mm:
    # 探测：委托给 accelerator backend
    self.use_triton_grouped_mm = get_accelerator().prefer_triton_grouped_mm()

if use_grouped_mm and not hasattr(torch, "_grouped_mm") and not self.use_triton_grouped_mm:
    raise RuntimeError(...)  # 两条快速路径都不可用则报错

def forward(self, x, num_tokens_per_expert):
    if self.use_triton_grouped_mm:
        return _run_experts_triton_grouped_mm(...)   # sm80/sm86
    elif self.use_grouped_mm:
        return _run_experts_grouped_mm(...)           # sm90+
    else:
        return _run_experts_for_loop(...)             # reference
```

三路径的 SwiGLU MLP 计算语义相同（w1 gate-up × w3 up → SiLU → w2 down），区别在 GEMM 实现方式：

| 路径 | GEMM 实现 | 适用场景 | 性能特征 |
|------|----------|---------|---------|
| `for_loop` | 逐专家 `torch.matmul` | 所有平台 | per-group launch 开销，`.tolist()` D2H sync |
| `grouped_mm` | `torch._grouped_mm` | sm90+ (H100) | 原生 fused grouped GEMM |
| `triton_grouped_mm` | 自研 Triton kernel | sm80/sm86 (A100) | 单 kernel 处理所有 group，无 D2H sync |

**为什么需要 Triton 路径**：在 sm80/sm86 上，`torch._grouped_mm` 没有 fused CUTLASS/cuBLASLt kernel，会静默回退到 Python for 循环（每个 group 发一个 `at::mm` 加一次 D2H sync）。MoE 每层调用 grouped GEMM 3 次（w1, w3, w2），for 循环的 launch 开销和 sync 开销会严重拖慢训练。`group_gemm_triton.py` 的 Triton kernel 用单个融合 kernel 处理所有 group，消除 per-group launch 和 D2H sync。

**Triton grouped GEMM 核心设计**（`group_gemm_triton.py`）：

```python title="group_gemm_triton.py L86 — _group_gemm_kernel 融合所有 group"
@triton.autotune(configs=_gmm_configs(), key=["KC", "NO", "NUM_GROUPS"])
@triton.jit
def _group_gemm_kernel(a_ptr, b_ptr, out_ptr, group_m_start_ptr, group_m_size_ptr, ...):
    pid_m = tl.program_id(0)
    # 每个 program tile 在运行时自行定位所属 group
    selected = -1
    for g in range(NUM_GROUPS):  # constexpr → 展开
        size_g = tl.load(group_m_size_ptr + g)
        tiles_g = tl.cdiv(size_g, BLOCK_M)
        is_here = (selected < 0) & (pid_m < prefix_g)
        selected = tl.where(is_here, g, selected)
    # ... 在 selected group 的 M 范围内做 tiled GEMM
```

三个关键优化：

1. **单 kernel 全 group**：`NUM_GROUPS` 作为 `tl.constexpr` 传入，编译器展开循环。所有 group 的 tile 由同一个 kernel 的不同 program 处理，无 per-group launch。

2. **设备端元数据计算**：`_group_meta_kernel`（L254）在 GPU 上从 `offs` 计算 `m_start` 和 `m_size`，避免 `offs.tolist()` 的 D2H 同步。这是原始 for-loop 路径的主要性能瓶颈。

3. **trans_b=True 避免转置 copy**：

```python title="group_gemm_triton.py L395 — trans_b 在 Function 内部处理"
class _GroupGemmFn(torch.autograd.Function):
    @staticmethod
    def forward(ctx, mat_a, mat_b, offs, trans_b):
        # trans_b=True: mat_b 是 [E, N, K]（权重原生布局）
        # 在此做 strided VIEW（非 copy），transpose 不上 autograd tape
        b_kernel = mat_b.transpose(-2, -1) if trans_b else mat_b
        out = _group_gemm(mat_a.contiguous(), b_kernel, offs)
        ctx.save_for_backward(mat_a, mat_b, offs)
        ctx.trans_b = trans_b  # backward 用原始 mat_b 布局
        return out

    @staticmethod
    def backward(ctx, grad_out):
        # grad_b 直接在 mat_b 的 [E, N, K] 布局上写出
        # 避免了外部 .transpose() 触发的 contiguous copy
        if trans_b:
            grad_b = _grouped_dw(grad_out, mat_a.contiguous(), offs, E)
```

专家权重天然以 `[E, hidden, dim]` 存储（PyTorch `nn.Linear` 的 weight 布局）。计算 `x @ W^T` 时如果外部调用 `.transpose(-2, -1)` 会生成非连续 view，autograd 会在 backward 时触发 contiguous copy。`trans_b=True` 将转置移到 `forward` 内部作为 strided view（不上 tape），backward 直接在原生布局上计算梯度，省去 copy。

**`@triton.autotune` 6 种 tile 配置**（L69）：`(BLOCK_M, BLOCK_N, BLOCK_K)` 组合覆盖 32-128 的 M tile、128-256 的 N tile、32-64 的 K tile，按 `(KC, NO, NUM_GROUPS)` 自动选择最优配置。权重梯度 kernel `_group_gemm_dw_kernel` 有独立的 6 种配置（L166），因为 weight grad 的输出维度是 `[E, K, N]` 而非 `[M, N]`，tile 维度角色互换。

### EP+TP Folding

EP+TP Folding 是 AutoEP 栈的核心通信优化，实现在 `ep_tp_dispatch.py`。问题背景：当 Expert Parallel 和 Tensor Parallel 同时启用时，每个 TP rank 独立运行 router 得到相同的路由结果，然后每个 TP rank 都通过 AllToAll 发送全量 token——这造成 `tp_size` 倍冗余传输。

**partition_assignments**（`ep_tp_dispatch.py` L230）在 EP dispatch 前按 `assignment_index % tp_size` 分片：

```python title="ep_tp_dispatch.py L230 — partition_assignments TP 分片"
def partition_assignments(payload, *, tp_group, tp_rank, tp_size):
    active = ~payload.drop_mask & ~payload.pad_mask
    if tp_size <= 1:
        keep = active
    else:
        # 每个 TP peer 只保留 ordinal % tp_size == tp_rank 的 assignment
        keep = (payload.assignment_indices.remainder(tp_size) == tp_rank) & active
    local_indices = torch.nonzero(keep, as_tuple=False).flatten()
    local = _take(payload, local_indices)
    # 重新计算 input_splits（按实际保留的 token 数）
    local.input_splits = _recompute_input_splits(local)
    local.output_splits = list(local.input_splits)
    return local, ctx
```

`assignment_ordinals_by_expert`（L43）为每个 (token, expert) assignment 生成在专家段内的稳定序号。TP rank 0 处理偶数序号、rank 1 处理奇数序号，保证每个 TP rank 处理约 1/tp_size 的 assignment，AllToAll 传输量减少 tp_size 倍。

**restore_combined**（L397）在 EP gather 后用 all-gather 恢复完整结果：

```python title="ep_tp_dispatch.py L397 — restore_combined TP 恢复"
def restore_combined(local_combined, ctx, *, tp_group, validate_coverage=False):
    # 可微 all-gather：拼接所有 TP peer 的局部结果
    all_outputs = _all_gather_variable_rows(local_combined, tp_group, ctx.tp_size,
                                             preserve_grad=local_combined.requires_grad)
    # 按 token 索引加权求和
    output = local_combined.new_zeros((ctx.num_tokens, local_combined.shape[-1]))
    for slot in torch.unique(all_capacity_slots, sorted=True).tolist():
        rows = all_capacity_slots == int(slot)
        output.index_add_(0, all_token_indices[rows], weighted_outputs[rows])
    return output
```

**梯度归约策略**：`_AllGatherVariableRows`（L283）是可微的 all-gather。其 backward 是 reduce-scatter：因为 forward 输出在每个 peer 上相同（replicated），所以每个 peer 的 `grad_output` 也相同，`all_reduce` 会将梯度乘以 `tp_size`。这意味着 router/gate 参数的梯度流经 restore all-gather 后会携带 `tp_size` 因子。TP 梯度 reducer 用 **AVERAGE** 策略除以 `tp_size` 恢复正确梯度；如果用 **SUM** 则会多出 `tp_size` 倍——这正是 CPU/Gloo parity test 防护的 2.0x 梯度回归 bug。

`AutoEPMoELayer.__init__` 中（`auto_ep_layer.py` L491）对 router 参数调用 `mark_autoep_folding_router_parameter` 标记为 `replicated` family，确保 optimizer 使用 AVERAGE 而非 SUM：

```python title="auto_ep_layer.py L491 — router 参数标记为 AVERAGE 归约"
for param in self.router.parameters():
    param.allreduce = True
    mark_autoep_folding_router_parameter(param)
    param.ds_zero_placement_family = "replicated"
```

而专家参数标记为 `autoep_expert` family（L483），走 EP 分片归约路径——因为每个 EP rank 只持有部分专家，梯度是真正的 partial sum。

### 原始栈的 sparse encode/decode

原始训练栈用 dense capacity buffer `[E, C, M]` 组织 token，`_sparse_encode`（L207）和 `_sparse_decode`（L223）是核心：

```python title="sharded_moe.py L207 — _sparse_encode 反转路由变 scatter 为 gather"
def _sparse_encode(reshaped_input, slots, num_experts, capacity):
    # slots: 每个 (token, route) 对在 [E*C] 中的扁平位置
    # 反转：对每个 slot，找到它的 source token
    source = torch.full((num_experts * capacity + 1,), num_tokens, dtype=torch.long, device=slots.device)
    tokens = torch.arange(num_tokens, device=slots.device).expand_as(slots)
    source.scatter_(0, slots.reshape(-1), tokens.reshape(-1))
    # index_select 一次性 gather 所有 slot 的 source token
    padded_input = torch.cat([reshaped_input, reshaped_input.new_zeros(1, d_model)])
    return padded_input.index_select(0, source[:-1]).view(num_experts, capacity, d_model)
```

反转路由表的设计原因：直接 scatter 需要为每条路由执行一次 copy（E×C 次），而反转后变成单次 `index_select` gather。被替换的 dense einsum `"sec,sm->ecm"` 代价是 `O(S*E*C*M)`，但实际只需移动 `S*K*M` 个元素——sparse 路径的复杂度与 K 而非 E*C 成正比。

```python title="sharded_moe.py L223 — _sparse_decode fp32 加权求和"
def _sparse_decode(expert_output, slots, gates, num_tokens):
    # gather 每个 token 的专家输出
    routed = padded_output.index_select(0, slots.reshape(-1)).view(slots.size(0), num_tokens, d_model)
    # gates 是 fp32，乘法和求和都在 fp32 中进行
    combined = (routed * gates.unsqueeze(-1)).sum(0)
    return combined.to(expert_output.dtype)
```

显式 fp32 累加的原因：bf16/fp16 下多专家加权求和会有累积精度损失。gates 张量在 `top2gating` 中以 fp32 计算（L350: `gates = F.softmax(logits, dim=1)` 在 fp32 函数中），decode 时保持 fp32 乘加，最后才 `.to(expert_output.dtype)` 转回。

## 设计模式

| 模式 | 实例 | 设计意图 |
|------|------|---------|
| **策略模式** | `TopKGate` 按 k=1/2/K 分发到三个 gating 函数 | 路由策略可插拔，共享 gate 权重和辅助损失框架 |
| **策略模式** | `GroupedExperts` 三路径(triton/grouped/for-loop) | 硬件适配：探测委托 `get_accelerator().prefer_triton_grouped_mm()` |
| **autograd Function** | `_AllToAll` / `_AllToAllV` / `_AllGatherVariableRows` / `_GroupGemmFn` / `_DropTokens` / `_GatherTokens` | 通信和 GEMM 操作嵌入 autograd 图，backward 自动反向 |
| **Kernel 抽象层** | `_group_gemm_kernel` + `_group_gemm_dw_kernel` + `_group_meta_kernel` | 前向/权重梯度/元数据计算三个 Triton kernel 分离，各自 autotune |
| **注册表模式** | `DSMoERegistry.register_module` (推理栈) | `DSMultiGemmMoE` 通过 `@register_module` 注册，`supports_config` 按配置选择 |
| **Payload 数据类** | `RoutedAssignmentPayload` / `RestoreContext` | EP+TP Folding 的路由信息封装为不可变 dataclass，在 partition/restore 间传递 |
| **Drop-in 替代** | `group_gemm_triton` 替代 `torch._grouped_mm` | 相同 API 语义(`mat_a, mat_b, offs`)，autograd 兼容，透明切换 |
| **装饰器模式** | `indices_padding_wrapper` (`ep_kernels.py` L303) | 包装专家计算函数，自动添加 alignment padding 和 permutation |

## 模块间交互

**与 `deepspeed.comm`**：三套 AllToAll 通信原语都基于 `deepspeed.comm` 的 `all_to_all_single` / `all_gather` / `all_reduce`。`_AllToAll`（等长）用于原始栈 EP dispatch，`_AllToAllV`（变长）用于 AutoEP 栈，`_AllGatherVariableRows`（变长 all-gather）用于 TP Folding 恢复。`TopKGate` 在 `drop_tokens=False` 时调用 `dist.all_reduce(MAX)` 跨 EP rank 同步最大 capacity（L271）。

**与 `deepspeed.ops`**：原始栈可选集成 Tutel（L48: `from tutel import moe as tutel_moe`），使用 Tutel 的 `fast_dispatcher` 替代 `_sparse_encode/_sparse_decode`。推理栈使用 `deepspeed.inference.v2.kernels` 的 `RaggedTopKGating`、`MoEScatter`、`MoEGather`、`MoEGEMM` 等 CUDA kernel。

**与 `module_inject`**：`AutoEPMoELayer` 是 `module_inject` 子系统的组件，用于将 HuggingFace MoE 模型（如 DeepSeek-V3、Mixtral）的 MoE 层替换为 EP 版本。`repack_expert_weights`（`auto_ep_layer.py` L448）从源模型的 expert 权重中按 `ep_rank` 切片并重新打包为 `GroupedExperts` 所需的 `[E_local, hidden, dim]` 布局。`AutoEPConfig` 和 `MoELayerSpec` 定义模型预设（router 名称、expert 布局、score function 等），`mark_autoep_folding_router_parameter` 标记 router 参数的梯度归约策略。

**与 `engine`**：`MoE`（`layer.py` L17）是用户可见的 MoE 层入口，在 `MoE.__init__` 中组装 `TopKGate` + `Experts` → `MOELayer`。`set_deepspeed_parallelism` 创建 EP/DP/TP 进程组并注入 `MOELayer`。引擎通过 `param.allreduce = False` 和 `param.group_name` 识别专家参数，在梯度归约时跳过 DP all-reduce，改为 EP 组内归约。AutoEP 栈通过 `param.ds_zero_placement_family` 标记（`autoep_expert` / `replicated`）让 ZeRO optimizer 选择正确的分片和归约策略。

**与 `accelerator`**：`get_accelerator().prefer_triton_grouped_mm()` 是硬件探测接口，CUDA backend 在 sm < 9.0（A100/A6000 等 Ampere）时返回 `True`（因为 `torch._grouped_mm` 在这些设备上回退到慢速 for 循环），sm90+（H100）返回 `False`（原生 `torch._grouped_mm` 有 CUTLASS kernel）。

**推理栈的独立性**：`DSMultiGemmMoE`（`cutlass_multi_gemm.py`）完全独立于训练栈，不共享 `moe/` 目录的任何代码。它使用 ragged batch（`RaggedBatchWrapper`）组织变长输入，`MoEGEMM` 是 CUTLASS multi-GEMM kernel 的封装，按 `expert_cumsum` 偏移量在单个 kernel 内处理所有专家。`MoEScatter`/`MoEGather` 完成 token 的分发和回收，无需 AllToAll（推理时专家通常在同一 GPU）。`_create_buffers`（L77）预分配所有中间 buffer，避免推理时的动态分配。
