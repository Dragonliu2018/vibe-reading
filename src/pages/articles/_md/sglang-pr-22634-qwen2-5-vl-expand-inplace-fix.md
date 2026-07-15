---
title: "expand() 视图上的原地写为何会崩——Qwen2.5-VL 解码路径修复"
source:
  project: "SGLang"
  type: "PR"
  id: "22634"
  url: "https://github.com/sgl-project/sglang/pull/22634"
  prType: "fix"
date: "2026-07-14"
category: [AI, 推理, SGLang, Contributions]
tags: ["SGLang", "Qwen2.5-VL", "PyTorch", "RoPE", "Bug Fix"]
description: "Qwen2.5-VL 解码阶段对 .expand() 视图执行 += 触发 RuntimeError，改为先加法再 expand 的 out-of-place 写法修复。"
readingTime: "9 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#22634](https://github.com/sgl-project/sglang/pull/22634) · **Issue** `-` · **commit** `-` · **首发版本** `-` · **变更行数** +6 / -7 行 · **合并时间** -

---

## 背景

SGLang 的 `multimodal_gen` 子系统把 **Qwen2.5-VL** 作为多模态/文生图管线的文本编码器（也用于 prompt 改写）。在自回归解码（decode）阶段，模型会抛出一段看起来很"PyTorch"的运行时错误：

```text title="decode 阶段的崩溃栈（节选自 PR 描述）"
File ".../python/sglang/multimodal_gen/runtime/models/encoders/qwen2_5vl.py", line 991, in forward
    position_ids += delta.to(position_ids.device)
RuntimeError: unsupported operation: more than one element of the written-to tensor
refers to a single memory location. Please clone() the tensor before performing the operation.
```

错误信息把根因说得很直白：被写入的张量里，**多个逻辑元素指向同一块物理内存**。这正是 PyTorch 对 `expand()` 视图执行原地写时的标准拒绝姿势。

PR [#22634](https://github.com/sgl-project/sglang/pull/22634) 的修复只有 +6 / -7 行、单文件改动，思路是把"先 `expand` 再 `+=`"重排为"先 `+` 再 `expand`"——让 `expand()` 始终处于数据流末端、只读的位置。（该 PR 截至撰稿时仍处于 Open 状态，尚未合入主线。）

---

## 前置知识

### Qwen2.5-VL 的 3D-RoPE 与 mrope delta

Qwen2.5-VL 用 **3D 旋转位置编码（M-RoPE）** 让模型感知视觉 token 的时空位置：`position_ids` 的形状是 `[3, batch_size, seq_length]`，三个维度分别对应**时间、高度、宽度**方向的位置。纯文本 token 三轴位置相同；视觉 token 的三轴则按 patch 网格各自展开。

prefill 阶段，位置编码由 `get_rope_index` 一次性算出，它同时返回一个 `mrope_position_deltas`（形状 `[batch_size, 1]`），记录视觉位置相对文本长度的"溢出量"。这个 delta 被缓存在 `self.rope_deltas`，供后续 decode 复用——decode 不再重算整套 3D 位置，而是用一个基准 `arange` 加上 delta 平移。

### prefill 与 decode 的分支

`Qwen2_5_VLModel.forward` 在 `position_ids is None` 时分两路：

```python title="qwen2_5vl.py — prefill / decode 分支（修复前）"
if prefill_compiled_stage or prefill_noncompiled_stage or self.rope_deltas is None:
    # prefill：算一次完整 3D 位置
    position_ids, rope_deltas = self.get_rope_index(...)
    self.rope_deltas = rope_deltas
else:
    # decode：用 arange + 缓存的 delta 平移
    batch_size, seq_length, _ = inputs_embeds.shape
    position_ids = torch.arange(seq_length, device=inputs_embeds.device)
    position_ids = position_ids.view(1, 1, -1).expand(3, batch_size, -1)   # ← 零步长视图
    ...
    position_ids += delta.to(position_ids.device)                          # ← 对视图原地写 ❌
```

prefill 走 `get_rope_index`，安全；问题只出在 decode 的 `else` 分支。

### expand() 的零步长视图

`expand()` 不复制数据，而是把要"重复"的维度 **stride 置 0**，让多个逻辑下标映射到同一物理地址：

```python title="expand 的内存语义"
base = torch.arange(3)                    # [3]        stride=(1,)
v = base.view(1, 1, -1).expand(3, 2, -1)  # [3, 2, 3]  stride=(0, 0, 1)
# v[0,0,0] / v[1,0,0] / v[2,0,0] 三个逻辑位置 → 同一块物理内存
```

对这种视图做原地写 `+=`，PyTorch 无法定义"同一地址被写几次、以什么顺序写"，于是直接拒绝。这就是崩溃的根。

---

## 实现

### 问题代码

完整的 decode `else` 分支（修复前）：

```python title="qwen2_5vl.py — decode 分支（修复前）"
batch_size, seq_length, _ = inputs_embeds.shape
position_ids = torch.arange(seq_length, device=inputs_embeds.device)
position_ids = position_ids.view(1, 1, -1).expand(3, batch_size, -1)     # ① 零步长视图
if cache_position is not None:
    delta = (cache_position[0] + self.rope_deltas).to(inputs_embeds.device)
else:
    delta = torch.zeros((batch_size, seq_length), device=inputs_embeds.device)
delta = delta.repeat_interleave(batch_size // delta.shape[0], dim=1)      # ② 恒为 1 倍
position_ids += delta.to(position_ids.device)                              # ③ 原地写视图 ❌
```

### 为什么会崩

- ① `expand(3, batch_size, -1)` 把 dim0、dim1 的 stride 设为 0：`[0, b, :]`、`[1, b, :]`、`[2, b, :]` 三行共享同一块 `[0..seq_length-1]`。
- ③ `position_ids += delta` 等价于对底层共享存储反复写——`[0, b, :]` 刚写完，`[1, b, :]` 又写同一地址，结果未定义，PyTorch 干脆拒绝。

```
逻辑视图（expand 后）              物理内存
position_ids[0, b, :]  ──┐
position_ids[1, b, :]  ──┼──►  [ 0, 1, 2, ... seq_length-1 ]
position_ids[2, b, :]  ──┘
          ↑ 三行指向同一块内存，原地 += 会互相覆盖
```

顺带一提，② 这行 `repeat_interleave(batch_size // delta.shape[0], dim=1)` 实际上是个**恒等操作**：`delta` 的形状总是 `[batch_size, 1]`（`self.rope_deltas` 来自 `get_rope_index` 的 `mrope_position_deltas`，固定 `[B, 1]`），所以 `batch_size // delta.shape[0] == 1`，沿 dim1 重复 1 倍 = 不变。它对正确性毫无贡献，修复时一并移除。

### 修复

```python title="qwen2_5vl.py — decode 分支（修复后）"
batch_size, seq_length, _ = inputs_embeds.shape
if cache_position is not None:
    delta = (cache_position[0] + self.rope_deltas).to(inputs_embeds.device)
else:
    delta = torch.zeros(batch_size, 1, device=inputs_embeds.device)       # ① [B, 1]，靠广播
position_ids = (
    (torch.arange(seq_length, device=inputs_embeds.device) + delta)       # ② out-of-place，物化新张量
    .unsqueeze(0)
    .expand(3, -1, -1)                                                     # ③ 只读视图，数据流末端
)
```

三个要点：

- **① `delta` 由 `[B, S]` 缩为 `[B, 1]`**——`else` 分支不再显式分配整段零张量，靠加法时的广播沿 `seq_length` 维展开，内存更省、语义更直白。
- **② `+` 是非原地操作**，会分配一块全新的连续 `[B, S]` 存储装结果，不与任何视图共享内存，后续 `expand` 安全。
- **③ `expand(3, -1, -1)` 只作只读视图**，直接喂给下游 `language_model`（`Qwen2_5_VLTextModel.forward` → `self.rotary_emb(hidden_states, position_ids)`），全程无写操作。

### 值等价性：修复是"无损"的

修复不是"加个 `.clone()` 兜底"，而是等价重排。逐元素比对修复前后 `position_ids[t, b, s]` 的值：

| 修复前 | 修复后 |
| --- | --- |
| `s + delta[b]`（`delta` 经广播到 `[3, B, S]`） | `s + delta[b]`（`arange(S) + delta[B,1]` 广播到 `[B, S]`，再 `expand` 到 `[3, B, S]`） |

两者逐元素相等，三个轴（T/H/W）共享同一组位置值——这正是 decode 阶段纯文本 token 的预期位置编码。换言之，修复**只改写法、不改数值**：崩在视图语义上的代码被重排成数据流末端的只读视图，结果不变。

---

## 验证

PR 未新增单测（checklist 中测试项未勾选），这是合理的：修复是值等价重排，`position_ids` 的输出张量逐元素不变，已有的端到端精度测试足以覆盖。

下游消费方式也佐证了这一点：`Qwen2_5_VLTextModel.forward` 收到形状 `[3, B, S]`（`ndim == 3` 且 `shape[0] == 3`，非 4 轴打包情形）的 `position_ids` 后，走 `text_position_ids = position_ids[0]` 取首轴建 mask，再 `self.rotary_emb(hidden_states, position_ids)` 读三轴算 RoPE——**全程只读**，与修复后"expand 处于数据流末端"的约束完全契合。

---

## 意义与影响

| 方面 | 修复前 | 修复后 |
| --- | --- | --- |
| 操作顺序 | 先 `expand`，再 `+=` | 先 `+`，再 `expand` |
| 是否原地写 expand 视图 | ✅ 是（崩溃根源） | ❌ 否 |
| `delta` 形状（else 分支） | `[B, S]` 显式零张量 | `[B, 1]`（广播） |
| `repeat_interleave` | 保留（恒 1 倍，冗余） | 移除 |
| `position_ids` 输出值 | （崩溃，未产出） | 与修复前预期值逐元素相等 |
| 运行时行为 | 抛 `RuntimeError` | 正常计算 |

这个 +6 / -7 的修复把一个经典 PyTorch 陷阱收束成一条可推广的原则：

> **`expand()` 造的是零步长视图，不是数据副本——永远不要对它原地写。** 遇到此类报错，治本的不是就地 `.clone()`，而是重排计算顺序，让 `expand()` 停在数据流末端、只读的位置。

```python title="安全 vs. 不安全的 expand 写法"
# ❌ 对 expand 视图原地写
t = base.expand(3, -1)
t += delta                       # RuntimeError

# ✅ 先 clone 再原地写（治标）
t = base.expand(3, -1).clone()
t += delta

# ✅ 非原地，产生新张量
t = base.expand(3, -1) + delta

# ✅ 先运算再 expand，视图只读（本 PR 的方案）
t = (base + delta).expand(3, -1)
```

触发条件也值得记一笔：仅在 **Qwen2.5-VL + decode 阶段 + `rope_deltas` 已缓存**时命中——prefill 走 `get_rope_index`，无此问题。这类"只在解码路径才炸"的 bug，往往要等一次完整 prefill 之后的第一个生成步才暴露，排查时容易和 KV cache、采样逻辑混在一起，值得在 RoPE/位置编码相关的视图操作里预先规避。

---

## 参考

- PyTorch 文档：`Tensor.expand()` 的零步长视图语义，以及原地操作与 `RuntimeError` 的内存别名检查
- HuggingFace Transformers 中 `Qwen2_5_VLModel` 的 `get_rope_index` / `mrope_position_deltas` 设计（SGLang `multimodal_gen` 的该编码器即移植自此）
