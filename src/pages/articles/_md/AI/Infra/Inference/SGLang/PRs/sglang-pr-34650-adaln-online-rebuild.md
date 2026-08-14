---
title: "按需重建 MiniMax-H3 AdaLN 输出，甩掉 24.2 GiB sidecar"
source:
  project: "SGLang"
  type: "PR"
  id: "34650"
  url: "https://github.com/sgl-project/sglang/pull/34650"
  prType: "feat"
date: "2026-08-14T16:27:27+08:00"
category: [AI, Infra, Inference, SGLang, PRs]
tags: ["SGLang", "MiniMax-H3", "Diffusion", "DiT", "AdaLN", "Tensor Parallelism"]
description: "解读 SGLang #34650：按需重建 MiniMax-H3 的 AdaLN 输出，甩掉 24.2 GiB sidecar，DiT 全驻留提速 6.4%，根因是 H2D 流与 Ulysses all2all 的带宽争用。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#34650](https://github.com/sgl-project/sglang/pull/34650) · **Issue** `-` · **commit** [a86edcd](https://github.com/sgl-project/sglang/commit/a86edcdc0a69679b4927b4dcefbc64dd682bf0dd) · **首发版本** `-`（截至写作时最新为 v0.5.17，2026-08-08，未含此合并） · **变更行数** +872 行 · **合并时间** 2026-08-14

---

## 背景

**MiniMax-H3** 是 SGLang `multimodal_gen` 框架服务的一个多模态扩散 Transformer（DiT），一次性生成视频与音频。它的去噪过程按"模式"组织 timestep：`t2va`（文生视频+音频，2 个 timestep）、`fl2va`（图+文，3 个）、`ref2va`（带视觉/音频参考，4 个，最宽），权重分区对应 `fl2va` / `ref2va` 两种 `model-variant`。

这个模型有一个"肥得流油"的部件：**AdaLN**（Adaptive Layer Normalization）。DiT 里每个 block 的 scale/shift/gate 调制参数，是把 timestep 嵌入经过一个线性层 `adaln_proj` 投影出来的。H3 一共有 **50 个 block `adaln_proj` + 1 个 final `adaln_proj`**，输入维度 `time_embed_dim=2688`，block 输出 `adaln_out_features = 6 × 3 × 5376 = 96768`（`expand_ratio=6`、`MINIMAX_H3_ADALN_MODALITY_NUM=3`）。单层 block 权重是 `[96768, 2688]` = 260M 参数，BF16 下恰好 **496 MiB**；50 层加起来 **13.0B 参数 / 24.2 GiB，占整个 DiT 的 39.3%**。

关键性质：**AdaLN 输出只依赖 timestep**（以及常量的 `time_embedder` 权重），与输入 latent、与请求里的画面/声音无关。这意味着 24.2 GiB 的权重完全可以**预算成一张表**，推理时查表而不是跑线性层——既省显存又省算力。

前序 PR [#33991](https://github.com/sgl-project/sglang/pull/33991)（**已关闭**）走的就是这条路：离线跑一个构建脚本，把每种采样计划的 AdaLN 输出预计算成一张 `sidecar .safetensors`，serve 时加载、去噪时按 timestep 计划查表。权重本身不加载到设备上，于是 DiT 能在 `tp_size=1` 全驻留，无需层间 offload。

问题出在 sidecar 的**身份（identity）**：一张 artifact 只覆盖一种 `(mode, steps, flow_shift, audio_flow_shift, imgvid_cond_noise_aug, audio_cond_noise_aug)` 组合；4 步 / 8 步蒸馏变体再把组合数翻倍。更糟的是 H3 的合成 warmup 在 `fl2va` 分区上跑 `t2va`，其 timestep 计划永远对不上 `fl2va` 的 sidecar——一旦某次请求的计划不在 artifact 里，sidecar 直接**判失败**，而不是降级。一个组合对不上，整条请求挂掉。

[#34650](https://github.com/sgl-project/sglang/pull/34650) 的洞察一句话讲完：**一条请求的全部 timestep 计划，在去噪循环开始前就已经在 `prepare_timestep_plan` 里定死了**。那么与其离线穷举所有组合存成 artifact，不如在请求时按需把要用的那几张计划重建出来，artifact 干脆不要了。本 PR 把 #33991 的 sidecar 实现（4 个 commit）一并收入、保留为 `--minimax-h3-adaln-cache-path`（固定计划部署仍可用），再加 3 个自己的 commit 落地 `--minimax-h3-adaln-online`——按需重建。两路对比下图：

![AdaLN 输出供给路径：sidecar 与按需重建](/vibe-reading/images/articles/sglang-pr-34650-adaln-online-rebuild/supply-path.svg)

左路（旧）需要一个离线构建的 24.2 GiB 产物，身份被采样参数锁死，计划对不上就整请求失败；右路（新）在每个请求去噪前用 `prepare_adaln_plans` 现场重建，从 checkpoint 流式读权重、瞬时峰值只有一层（496 MiB）而非 24.2 GiB，重建完写进固定宽度的 slab，之后查表逻辑与 sidecar 路完全一致。两路共用同一个 `MiniMaxH3AdalnCache` 类——只是构造参数从 `path=`（加载产物）换成 `weight_files=`（从 checkpoint 重建）。

## 前置知识

### AdaLN 在 H3 里的角色

DiT 的每个 block 是 `norm1 → scale/shift → attention → gated residual → norm2 → scale/shift → MLP → gated residual`。这里的 scale/shift/gate 共 6 个调制量（block 侧），由 `adaln_proj` 把 timestep 嵌入 `adaln_input` 一次投影成 6 份。final 层只有 shift/scale 2 个量，故 `final_adaln_out_features = 2 × 5376 = 10752`。

`adaln_input` 的来历：timestep `t` → 正弦嵌入（fp32）→ `time_embedder` 的 `proj_in`（`ColumnParallelLinear`，256→5376）→ SiLU → `proj_out`（`RowParallelLinear`，5376→2688）→ 再 SiLU → 转 BF16。重建路径必须把这套嵌入**原样复刻**到 offline builder 里（见 `build_minimax_h3_adaln_cache.py` 的 `_time_embed`），否则预算的输出和运行时对不上。

### timestep 计划与 GEMM 的 batch 维

一个去噪 step 里，视频、音频、图像条件、音频参考各有各的 timestep。本步去重后剩下的唯一 timestep 集合，就是 AdaLN 投影的 **GEMM batch 维 M**：`t2va`→M=2、`fl2va`→3、`ref2va`→4。这也是后面"必须按精确 M 重建"那个坑的由来——M 既是 timestep 数，也是矩阵乘的批维度。

## 实现

### 一个类，两副面孔

核心是 `MiniMaxH3AdalnCache`（`python/sglang/multimodal_gen/runtime/models/dits/minimax_h3.py`）。它没有为"在线重建"另起一个类，而是让同一个类按构造参数分流：

```python title="minimax_h3.py — 构造分流"
class MiniMaxH3AdalnCache(nn.Module):
    def __init__(self, arch, *, path=None, model_variant=None,
                 weight_files=None, max_plans=64,
                 max_plan_width=MINIMAX_H3_ADALN_MAX_PLAN_WIDTH):
        if (path is None) == (weight_files is None):
            raise ValueError(
                "MiniMax H3 AdaLN cache takes exactly one of path (prebuilt "
                "sidecar) or weight_files (rebuild from the checkpoint)"
            )
        ...
```

- `path=`（#33991 sidecar 路线）：`load()` 直接从 safetensors 把预算好的张量读进设备。
- `weight_files=`（#34650 在线路线）：`load()` 只调 `_allocate()` 开一块**空 slab**，真正的数据留到请求时由 `build()` 现填。

复用同一个类的关键技巧：**空 slab 对 `lookup()` 不可见**。slab 的 `plan_lengths` 初始全是 0，而任何真实计划至少有 1 个 timestep，所以"长度==0"永远不会匹配——`build()` 没填的槽位天然等于不存在。于是 storage、lookup、模型 forward 三条路径在线路和 sidecar 路之间**完全一致**，零分支。

### slab：固定宽度、指针永不动

`_allocate()` 一次性开好固定形状的 slab：

```python title="minimax_h3.py — _allocate()"
self.register_buffer("plan_timesteps",
    torch.zeros((self.max_plans, width), dtype=_FP32_DTYPE, device=device))
self.register_buffer("plan_lengths",
    torch.zeros((self.max_plans,), dtype=torch.int64, device=device))
self.register_buffer("block_params",
    torch.zeros((self.max_plans, width, self.num_layers, self.block_width),
                dtype=_BF16_DTYPE, device=device))
self.register_buffer("final_params",
    torch.zeros((self.max_plans, width, self.final_width),
                dtype=_BF16_DTYPE, device=device))
```

`block_width = 6 × 3 × 5376 = 96768`，`final_width = 2 × 5376 = 10752`。宽度 `width` 默认 4（`MINIMAX_H3_ADALN_MAX_PLAN_WIDTH`），盖住最宽的 `ref2va`。这块 slab **只分配一次、之后原地写**，张量指针永远不变——因为 **breakable CUDA graph** 会把张量指针当成 replay 签名的一部分，指针一挪就失效。这也是 `--minimax-h3-adaln-plan-width` 存在的理由：slab 必须一开始就按部署能见到的最宽计划开好，`t2va`（只需宽 2）用默认 4 会白白多占 1.16 GiB 它永远填不满的槽位，窄部署可以把它调到 2 或 3；超宽计划直接拒绝并提示正确宽度，而不是静默截断。

### build()：一次流式扫描填满全部计划

`denoise_loop` 在 `prepare_timestep_plan` 之后、去噪循环之前，调一句 `model.prepare_adaln_plans([entry[0] for entry in timestep_plan])`。`prepare_adaln_plans` 把模型自己的 `time_embedder` 包成 `embed` 闭包传给 `cache.build()`：

```python title="minimax_h3.py — prepare_adaln_plans()"
def prepare_adaln_plans(self, step_timesteps):
    if self.adaln_cache is None or self.adaln_cache.weight_files is None:
        return
    def embed(timesteps):
        return nn.functional.silu(self.time_embedder(timesteps)).to(_BF16_DTYPE)
    self.adaln_cache.build(step_timesteps, embed=embed)
```

`build()` 是整个 PR 的重头戏——一次流式扫描把本请求要查的所有计划全填上，而不是在循环里一步步现补：

![build() 流式重建：逐层读权重 → GEMM → all-gather → 写 slab](/vibe-reading/images/articles/sglang-pr-34650-adaln-online-rebuild/build-streaming.svg)

逐层读、逐层写的好处是**瞬时显存峰值只有一层权重（496 MiB）**，而不是把 24.2 GiB 的 `adaln_proj` 全铺开。`build()` 内部干了几件事：

1. **去重 + 记账**：用 `_plan_key()` 把每步的 timestep 集合压成"fp32 位模式"元组（`struct.pack("<f")` 取原始 4 字节），靠位精确匹配去重；`_slots` 字典跨请求 memoize——同样的计划重复出现就不再重建，重复调度"白嫖"。
2. **溢出策略**：所有计划必须在去噪循环全程常驻（查表要用），所以一旦超出 `max_plans`，不是淘汰一部分（那只会把失败挪进 `lookup()`），而是整块清空重来。
3. **逐层 GEMM**：`ExitStack` 一次性打开所有 safetensors 句柄；`for layer in range(50)` 外层循环里，每层读一次 `weight`/`bias`，对每个缺计划跑一次 `project()` 写进 `block_params[slot, :length, layer]`；final 层同理写 `final_params`。

```python title="minimax_h3.py — project() 的分片 + all-gather"
def read_shard(name, out_features):
    if tp_size == 1:
        return index[name].get_tensor(name)
    shard = out_features // tp_size
    start = tp_rank * shard
    return index[name].get_slice(name)[start : start + shard]

def project(adaln_input, weight, bias):
    out = nn.functional.linear(adaln_input, weight, bias)
    return tensor_model_parallel_all_gather(out) if tp_size > 1 else out
```

### 两个 correctness 陷阱：精确 M、镜像分片

`build()` 之所以"每个计划各按自己的 timestep 数当 batch 维重建"，而不是图省事拼成一个大 batch，是因为 **cuBLAS 按 GEMM 形状挑 kernel，而挑选不是随 M 单调的**。PR 作者实测：以运行时的 `M==2` 为基准，`M==4/8/16/64/96` 都 bit-identical，但 `M==32` 在 96768 个输出元素里有 11760 个不同，`M==1`（第一步走的 GEMV 路径）有 69 个不同。换任何别的 batch 重建，都会悄悄扰动输出、打破"与常驻权重 bit-identical"的承诺——这种坑既不报错也不崩，只在输出 md5 里偏移，是这类缓存优化最容易踩的暗礁。所以 `build()` 必须严格按每个计划消费时的 M 来算，`block()` / `final()` 也按 `:num_timesteps` 切片取用。

同理，`tp_size>1` 时**必须只读本 rank 的列分片再 all-gather**，镜像 `ColumnParallelLinear`。这不是单纯省读（把每 rank 的 checkpoint 读量降到 `1/tp`），更是 correctness：分片 GEMM 的 N 维不同，cuBLAS 又会选不同 kernel，输出就不再一致。这两条互为表里——同一个"cuBLAS 形状敏感"根因，在 batch 维和输出维各表现一次。

### forward：查表顶替 adaln_proj

`MiniMaxH3DiTModel.__init__` 在 `_adaln_precomputed` 为真时，把每个 block / final 的 `self.adaln_proj` 置为 `None`（`use_adaln_cache=True`），权重也不再加载（见下面 loader）。forward 里改成"先查计划、再从 slab 切片"：

```python title="minimax_h3.py — forward 里的查表"
adaln_cache_plan_index = self.adaln_cache.lookup(
    unique_timesteps.view(-1).to(device))
block_adaln_params = tuple(
    self.adaln_cache.block(index, adaln_cache_plan_index, adaln_input.shape[0])
    for index in range(len(self.blocks)))
...
# 传给 final_layer.forward 的 adaln_params：
adaln_params=None if adaln_cache_plan_index is None
    else self.adaln_cache.final(adaln_cache_plan_index, adaln_input.shape[0])
```

`lookup()` 用"长度相等 + 前缀 timestep 全等"定位计划槽位；`block()` 把切片 `[plan, :M, layer]` reshape 成 6 份、`final()` reshape 成 2 份返回。block / final 的 forward 拿到这组 `adaln_params` 就直接用，绕过已为 `None` 的 `adaln_proj`。一旦 `adaln_proj` 是 `None` 又没给参数，立即抛 `ValueError`——不静默兜底。

### loader：把 adaln_proj 权重挡在设备外

`transformer_loader.py` 给在线路和 sidecar 路都挂了一个 `checkpoint_key_filter`：

```python title="transformer_loader.py — _minimax_h3_adaln_cache_key_filter()"
def _minimax_h3_adaln_cache_key_filter(name: str) -> bool:
    return ".adaln_proj.linear." not in name
```

凡是名字含 `.adaln_proj.linear.` 的权重，一律不加载进设备——它们要么被 sidecar 预算值取代，要么由在线路现场重建。这个 filter 一路插到 `fsdp_load.maybe_load_fsdp_model` 的 `safetensors_weights_iterator(weight_dir_list, key_filter=...)`。`weight_utils.py` 里还有一处关键：**一旦带 `key_filter`，就强制关掉 runai streamer**——因为 streamer 是把所有张量物化后再过滤，没法在加载时跳过整个 checkpoint 分片，filter 形同虚设。三处还做了校验：在线路与 `--minimax-h3-adaln-cache-path` 互斥、两者都只接受未量化的 H3、cache-path 还要求 `model_variant` 是 `fl2va`/`ref2va`。

### decoding.py：顺手修的 in-place 陷阱

本 PR 还捎带一个独立 commit 修 `--vae-cpu-offload` 在 H3 上根本跑不起来的问题。`_reverse_normalize_latents_`（去掉末尾下划线成 `_reverse_normalize_latents`）原本是原地 `latents.mul_(std).add_(mean)`，但 `--vae-cpu-offload` 会把 decode 阶段放在 `torch.inference_mode(False)` 下跑，而 `batch.latents` 是去噪阶段在 `InferenceMode` 里分配的 inference 张量——往这种张量上原地写会直接报错。改成 out-of-place：

```python title="decoding.py — 改 out-of-place"
return latents * std.view(*view_shape) + mean.view(*view_shape)
```

作者特意保留 `mul`-then-`add` 的顺序、不用 `addcmul`，是为了**不让 FMA 收缩（fused multiply-add）改写数值**——顺序一变，结果会随编译器收缩策略漂移。

## 测试

### 单元测试

新增 `test/unit/test_minimax_h3_adaln_cache.py`（59 行）专测 cache 的张量布局正确性。用极小 arch（`num_layers=2, hidden_size=4`）手搓一张 cache（`plan_timesteps` / `plan_lengths` / `block_params` / `final_params`），落盘时带 `format_version=2` 与 `model_variant=fl2va` 元信息，再 `load()` 回来，断言 `block()` / `final()` 的 reshape 与原始存储一致。要点是 `block()` 把一份 `[num_timesteps, 6 * modality * hidden]` 的扁平行拆成 6 份 `[num_timesteps, modality, hidden]`——modality 轴折进 leading 维，元素不变。`test_fsdp_load.py` 也同步加了一行 `key_filter=None` 到对 `safetensors_weights_iterator` 调用参数的断言里。

### 回归测试（准确性）

作者在 PR body 里给出了一套严格的 bit-identical 验收：在 `t2va` / `fl2va` / `ref2va` 三种模式、`tp1/ul8` 与 `tp2/ul4` 两种并行、1344×768 / 124 帧 / 50 步下，输出 mp4 的 **md5 与常驻 `adaln_proj` 权重完全一致**。`tp2` 的对照组是全常驻权重（不是另一个 cache），slab 宽度 2 与 4 也产出一致输出——这正是 `--minimax-h3-adaln-plan-width` 的验收标准：宽度只塑形 slab、不进入计算。把分支 rebase 到当时 main 后，同一个 `t2va` 跑前后 md5 都是 `13805bb7`，整卡峰值精确到 0.01 GiB 一致。完整 `multimodal_gen` 单测套件 1521 passed / 5 failed，那 5 个在未改动的 `b784726` 上一样失败——与本次改动无关。

### 性能测试

8× RTX PRO 5000（sm_120），`t2va`，1344×768，124 帧，50 步，3 次重复，1.72% 噪声底：

| 配置 | e2e | 整卡峰值 | headroom |
|---|---|---|---|
| `tp1/ul8` layerwise offload r35 | 135.74 s | 70.34 GiB | 0.78 GiB |
| `tp1/ul8` DiT 全驻留 + slab 2 | **127.03 s** | 66.90 GiB | 4.22 GiB |

快 6.4%，headroom 大 5 倍。`tp2/ul4` 整卡峰值再从 59.43 → 49.56 GiB。一次重建 pass 花费 2.4 s（10.9 GiB/s），有了 memoization，重复调度零成本。

真正的惊喜在 Nsight profiling（50 步捕获、`cudaProfilerApi` 范围、8 rank 汇总）——**提速的来源不是"少拷字节"，而是带宽争用**：

![性能根因：H2D 流与 Ulysses all2all 的带宽争用](/vibe-reading/images/articles/sglang-pr-34650-adaln-online-rebuild/bandwidth-contention.svg)

DiT 全驻留后，每步那个 host-to-device 流基本消失（292,268 ms → 9.3 ms）；附带地，Ulysses all2all 的 `ncclDevKernel_SendRecv` 从 219,963 ms 掉到 150,634 ms（−31.5%）。计算量没变——`flash_fwd` + cutlass GEMM 反而 +1.3%，方向跟提速相反，说明是时钟抖动、不是工作量。两个数字对得上：all2all 节省 `(219,963 − 150,634) / 8 = 8.67 s/rank`，正好对应 e2e 的 `8.71 s` 差值。

机制是这样的：每步的 H2D 流本可以与计算重叠，但它与 Ulysses all2all **共享同一根互连**；把它撤掉，等于把每条链路同时松绑。一个对照实验佐证了"是争用、不是字节"：设 `NCCL_P2P_LEVEL=SYS`（把 112 条 SHM 链路改成直连 P2P，只改善链路子集）只让 nccl kernel 降 4.1%、去噪循环 0% 不动——**改善子集链路不动关键路径，消掉共享带宽争用才动**。

## 意义与影响

最直接的价值：H3 在 `tp1/ul8` 上 DiT 全驻留、不用层间 offload，端到端快 6.4%、headroom 大 5 倍；`tp2/ul4` 峰值再降 9.87 GiB。而这一切的前提——把 24.2 GiB 的 `adaln_proj` 权重踢出设备——正是由 #33991 开创、#34650 收口的"AdaLN 输出预算"思路提供的。

但本 PR 真正的亮点是把这套预算从"离线产物"泛化成"在线能力"：

- **消灭 sidecar 的组合爆炸**。不再需要为 `(mode, steps, flow_shift, audio_flow_shift, imgvid/audio_cond_noise_aug)` 笛卡尔积、再叠 4/8 步蒸馏变体逐一预算 artifact；任意采样计划、任意步数都能跑，且与常驻权重 bit-identical。
- **memoization 让重复调度免费**。一次重建 2.4 s，之后同计划零成本；固定采样的服务（绝大多数生产部署）实际只付一次。
- **根因是带宽争用，不是少拷字节**。这是最有迁移价值的洞察：层间 offload 的 H2D 流看似与计算重叠、是"免费的"，实则与 Ulysses all2all 抢同一根互连，拖累了所有链路。一旦 DiT 能全驻留（靠踢掉 24.2 GiB AdaLN 权重腾出空间），H2D 流消失，all2all 整体松绑——这重新定义了"什么时候该 offload"：offload 省下的显存若能让 DiT 全驻留、从而消掉 H2D 流，收益会超过 offload 本身的开销。

副作用是顺带把 `--vae-cpu-offload` 在 H3 上的 in-place 写陷阱也修了，让这条 offload 路真正可用。

## TODO

- [ ] `--minimax-h3-adaln-online` 默认关闭（experimental），生产前需端到端数值与峰值显存验证。
- [ ] 在线重建仅兼容未量化权重（`quant_config` 非空时直接 raise）。
- [ ] `--minimax-h3-adaln-plan-width` 需按部署最宽计划手填以省显存：`t2va` 可设 2、`fl2va` 3、`ref2va` 4。
- [ ] 量化权重支持 / 计划宽度自动推断，目前未做。

## 参考

- [MiniMax-H3 模型卡（HuggingFace）](https://huggingface.co/MiniMaxAI/MiniMax-H3) — 官方说明约 13B 参数的 AdaLN 分支可在推理时预算，本文 24.2 GiB / 13.0B 参数 / 39.3% 占比的依据来源。

## 相关阅读

- [在 SGLang 中接入 LongCat-Image：一个文生图 DiT 模型的全栈适配](/vibe-reading/articles/sglang-pr-23274-support-longcat-image) — **同框架**·同为 `multimodal_gen` 的 DiT 接入与 Tensor Parallelism 落地，对照本篇的 H3 DiT 并行（tp / Ulysses）取舍。
- [接入 Cola-DLM：在 multimodal_gen 框架里用扩散生成文本](/vibe-reading/articles/sglang-pr-26220-cola-dlm-text-diffusion) — **同框架**·`multimodal_gen` 接入扩散模型的另一条线，对照"同一框架如何承载不同扩散形态"。
- [SGLang Diffusion AR-DiT 优化](/vibe-reading/articles/AI/Infra/Inference/SGLang/Official/sglang-official-ar-dit-sgl-diffusion-optimization) — **同主题**·SGLang 扩散侧 DiT 并行执行（AR 用 TP、DiT 用 SP）与一卡一 DiT 的动态调度，与本篇 DiT 全驻留后的并行结构直接呼应。
- [让 SGLang Diffusion 中 Torch Compile 完全退役](/vibe-reading/articles/AI/Infra/Inference/SGLang/Informal/sglang-informal-diffusion-retire-torch-compile) — **同主题**·本篇 H3 文档里明确"`torch.compile` 改变数值输出、不能用于一致性 ground truth"，正呼应这条"退役 compile"脉络。
