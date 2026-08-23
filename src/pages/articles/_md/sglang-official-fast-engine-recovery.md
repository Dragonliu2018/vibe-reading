---
title: "Fast Engine Recovery: Sub-Second Engine Restart for SGLang via Weight Cache Daemon"
source:
  type: "article"
  project: "SGLang"
  url: "https://www.lmsys.org/blog/2026-08-21-sglang-fast-recovery"
  author: "Ant Ling Infra Team (Ant Group), Alibaba, SGLang Team"
  site: "LMSYS Org Blog"
date: "2026-08-23T19:52:07+08:00"
category: [AI, Infra, Inference, SGLang, Official]
tags: ["SGLang", "LLM Serving", "Fast Recovery", "Weight Cache", "CUDA IPC", "Zero-Copy", "Failover", "FP8", "Megatron"]
description: "SGLang 引入 Weight Cache Daemon：常驻 GPU 进程持有量化后权重，引擎重启时经 CUDA IPC 零拷贝映射，将权重加载从分钟级降至秒级（Ling-2.6-1T FP8：~495s → ~0.63s，~785× 提速），是面向 <10s 冷重启、<1s 热备切换的 Fast Engine Recovery 框架第一阶段。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Fast Engine Recovery: Sub-Second Engine Restart for SGLang via Weight Cache Daemon](https://www.lmsys.org/blog/2026-08-21-sglang-fast-recovery) · **作者** Ant Ling Infra Team (Ant Group), Alibaba, SGLang Team · **来源** LMSYS Org Blog · **原文发布** 2026-08-21 · **中英对照·AI 译** 2026-08-23
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

## TL;DR

As SOTA models grow larger, reloading model services after crashes becomes prohibitively expensive. This post introduces the **Weight Cache Daemon** — a persistent GPU process that holds post-quantized model weights in GPU memory and serves them to new SGLang engine instances via CUDA IPC zero-copy mapping. This reduces weight loading from minutes to seconds.

> **译：** 随着 SOTA 模型规模不断增长，崩溃后重新加载模型服务的代价已变得极其高昂。本文介绍 **Weight Cache Daemon**——一个常驻 GPU 进程，将量化后的模型权重保存在 GPU 显存中，并通过 CUDA IPC 零拷贝映射提供给新的 SGLang 引擎实例。它将权重加载时间从分钟级降至秒级。

The Weight Cache Daemon is the first phase of a **Fast Engine Recovery Framework** targeting **< 10 second cold restarts** and **< 1 second warm standby switches** for production LLM serving.

> **译：** Weight Cache Daemon 是 **Fast Engine Recovery Framework** 的第一阶段，目标是面向生产级 LLM 服务实现 **< 10 秒冷重启** 和 **< 1 秒热备切换**。

Key results:

> **译：** 关键结果：

1. **Weight loading: ~495s → ~0.63s** — a **~785× speedup**, based on the Ling-2.6-1T FP8 model.
2. **Total startup: 8.8min → 0.528min** — a **93.9% reduction** in end-to-end engine boot time.
3. **Multi-instance weight sharing** — multiple engine instances on the same GPU map to the same IPC handles, eliminating redundant disk I/O and post-quantization transforms.
4. **Active-standby failover in < 1 second** — standby engines share weights via zero-copy, enabling near-zero-downtime failover without dedicating full GPUs to idle replicas.
5. **Multi-node-instance weight sharing** — support for multi-node mode with large models.

> **译：**
> 1. **权重加载：~495s → ~0.63s**——基于 Ling-2.6-1T FP8 模型，提速约 **785×**。
> 2. **启动总耗时：8.8min → 0.528min**——端到端引擎启动时间减少 **93.9%**。
> 3. **多实例权重共享**——同一 GPU 上的多个引擎实例映射到相同的 IPC 句柄，消除冗余的磁盘 I/O 与量化后变换。
> 4. **主备故障切换 < 1 秒**——备用引擎通过零拷贝共享权重，实现近零停机切换，无需为空闲副本独占整套 GPU。
> 5. **多节点实例权重共享**——支持大模型的多节点模式。

---

## Background

As LLM models grow larger — Qwen3-235B, Ling-2.6-1T, and the newly released 2.8T Kimi K3 — cold-start time of serving engines has become a critical bottleneck for production efficiency. A Ling-2.6-1T FP8 instance on 8×H20-3e GPUs takes approximately **8.52 minutes** just to become ready to serve, with weights stored on 3.5T NVME SSD. In production, this means:

> **译：** 随着 LLM 模型规模不断变大——Qwen3-235B、Ling-2.6-1T 以及新发布的 2.8T Kimi K3——服务引擎的冷启动时间已成为生产效率的关键瓶颈。一个部署在 8×H20-3e GPU 上的 Ling-2.6-1T FP8 实例，即便权重存放在 3.5T NVME SSD 上，也大约需要 **8.52 分钟** 才能开始提供服务。在生产环境中，这意味着：

- **P99 tail latency spikes** during restarts — all in-flight requests fail or queue indefinitely.
- **Reduced availability** — multi-minute recovery windows violate SLA targets.
- **Operational friction** — rolling updates, config changes, and failure recovery are all bottlenecked by the restart cycle.
- **GPU resource waste** — traditional active-standby deployments dedicate a full set of GPUs to idle replicas, doubling hardware cost for failover.

> **译：**
> - **重启期间 P99 尾延迟突增**——所有在途请求失败或无限排队。
> - **可用性下降**——数分钟的恢复窗口违反 SLA 目标。
> - **运维摩擦**——滚动更新、配置变更与故障恢复都受限于重启周期。
> - **GPU 资源浪费**——传统主备部署为空闲副本独占一整套 GPU，故障切换的硬件成本翻倍。

The team profiled a complete SGLang engine startup for Ling-2.6-1T FP8:

> **译：** 团队对 Ling-2.6-1T FP8 的一次完整 SGLang 引擎启动做了剖析：

### Startup Profiling Table

| Phase | Time (s) | Percentage | Notes |
|---|---|---|---|
| Pre-init & ServerArgs | ~1 | 0.2% | Pre-init and ServerArgs parsing |
| Tokenizer init | ~13 | 2.4% | load and init tokenizer |
| Init torch distributed | ~5 | 0.9% | NCCL 2.28.9, 8-card H20, NVLink mesh 370.8 GB/s, P2P/IPC; slowest rank TP1=5.19s |
| Load weight (disk) | ~495 | 93.9% | 161 shard, W8A8 FP8 (CompressedTensorsW8A8Fp8MoE), slowest rank=495.3s, 120GB per card; Disk I/O bound |
| Cache allocation (KV+Mamba) | ~1 | 0.2% | KV:553,599 tokens/5.94GB bf16; Mamba SSM state:5.33GB, max_mamba_cache_size=155 |
| Capture CUDA graph | ~7.7 | 1.5% | only 3 decode BS [1,2,4] |
| Server ready | ~4 | 0.8% | Unified RadixTree init, HTTP/uvicorn startup, warmup requests |
| **Total** | **~527** | **~8.8 minutes** | |

The bottleneck is clear: weight loading from disk accounts for **93.2% of startup time**. For the Ling-2.6-1T FP8 model, each TP rank reads ~120GB of safetensors from disk, deserializes, applies TP sharding, and runs post-quantization transforms (FP8 quantization, weight repacking). This work is **repeated identically on every restart**, even though the resulting GPU tensors are deterministic and often already present in GPU memory.

> **译：** 瓶颈很清晰：从磁盘加载权重占了 **93.2% 的启动时间**。对 Ling-2.6-1T FP8 模型，每个 TP rank 要从磁盘读取约 120GB 的 safetensors，反序列化，做 TP 分片，并执行量化后变换（FP8 量化、权重重排）。这些工作 **每次重启都完全相同地重复一遍**，哪怕最终得到的 GPU 张量是确定性的，并且常常已经存在于 GPU 显存中。

The solution: keep weights in GPU memory across engine restarts.

> **译：** 解决办法：让权重在引擎重启之间留在 GPU 显存里。

---

## Design

### Core Idea: Persistent Weight Cache via CUDA IPC

The Weight Cache Daemon is a persistent GPU process that holds post-quantized, TP-sharded weights in GPU memory. On engine restart, the new engine process maps weights from the daemon via **CUDA IPC zero-copy** — no disk I/O, no deserialization, no quantization.

> **译：** Weight Cache Daemon 是一个常驻 GPU 进程，在 GPU 显存中持有量化后、TP 分片后的权重。引擎重启时，新的引擎进程通过 **CUDA IPC 零拷贝** 从 daemon 映射权重——无磁盘 I/O、无反序列化、无量化。

![Architecture diagram: each GPU runs one Weight Cache Daemon that holds post-quantized weights and serves them to engine processes via CUDA IPC zero-copy.](/vibe-reading/images/articles/sglang-official-fast-engine-recovery/architecture.svg)

Each GPU runs **one daemon process** for its TP rank. The daemon:

> **译：** 每个 GPU 为其 TP rank 运行 **一个 daemon 进程**。daemon 负责：

1. Loads model weights from disk (full pipeline: disk → TP shard → quantize → repack).
2. Exports every parameter and buffer in `model.state_dict()` as CUDA IPC handles.
3. Records a `CacheConfig` fingerprint (model path, TP/DP size, quant config hash, dtype).
4. Serves IPC handles over a Unix socket to requesting engine processes.

> **译：**
> 1. 从磁盘加载模型权重（完整流水线：磁盘 → TP 分片 → 量化 → 重排）。
> 2. 将 `model.state_dict()` 中的每个参数和缓冲区导出为 CUDA IPC 句柄。
> 3. 记录一份 `CacheConfig` 指纹（模型路径、TP/DP 大小、量化配置哈希、dtype）。
> 4. 通过 Unix socket 向发起请求的引擎进程提供 IPC 句柄。

The engine connects to the daemon, validates config compatibility, and maps weights directly into its address space — the engine and daemon **share the same physical GPU memory** via CUDA IPC.

> **译：** 引擎连接到 daemon，校验配置兼容性，然后把权重直接映射进自己的地址空间——引擎与 daemon 通过 CUDA IPC **共享同一份物理 GPU 显存**。

### Zero-Copy Loading via Meta Device

The key to sub-second loading is **zero-copy**: the engine's `param.data` pointer is set directly to the IPC-mapped GPU tensor. No data is copied.

> **译：** 亚秒级加载的关键在于 **零拷贝**：引擎的 `param.data` 指针直接指向 IPC 映射的 GPU 张量。没有任何数据拷贝。

To achieve this, the engine initializes the model on the **meta device** (no GPU/CPU memory allocation), then replaces each parameter's data pointer with the IPC-mapped tensor.

> **译：** 为实现这一点，引擎在 **meta device** 上初始化模型（不分配 GPU/CPU 内存），随后用 IPC 映射的张量替换每个参数的数据指针。

Post-quantization parameters (e.g., `weight_scale` from FP8 quantization) that were created by `process_weights_after_loading()` are also cached by the daemon and mapped directly — no re-quantization needed.

> **译：** 由 `process_weights_after_loading()` 创建的量化后参数（如 FP8 量化产生的 `weight_scale`）也会被 daemon 缓存并直接映射——无需重新量化。

### Config Validation: Safety First

Any mismatch between the engine's config and the daemon's cached config triggers a **full disk reload**, ensuring correctness:

> **译：** 引擎配置与 daemon 缓存配置之间的任何不匹配都会触发一次 **完整的磁盘重载**，以确保正确性：

| Field | Mismatch Example | Consequence |
|---|---|---|
| `model_path` + `model_arch` + `revision` | Different model or revision | Wrong weights entirely |
| `tp_size` + `tp_rank` | Different TP sharding | Wrong shard for this rank |
| `pp_size` + `pp_rank` | Different PP partitioning | Wrong layers for this pipeline stage |
| `dp_size` + `ep_size` | Different DP/EP strategy | Incorrect weight distribution |
| `quant_method` + `quant_config_hash` | Different quantization | Unquantized vs FP8 mismatch |
| `dtype` | float16 vs bfloat16 | Type mismatch |
| `device_capability` + `torch_version` | Different GPU arch or torch version | Weights map cleanly but serve wrong numerics |

The last two fields form an **environment stamp**: a daemon and a client that ran different post-processing branches (different compute capability or torch/kernel version) can produce weights that map cleanly over IPC yet serve garbage — stamping the environment into `CacheConfig` turns that into a clean mismatch.

> **译：** 最后两个字段构成一个 **环境印记**：一个 daemon 和一个客户端若运行了不同的后处理分支（不同的算力或 torch/kernel 版本），可能产生能通过 IPC 干净映射却给出垃圾数值的权重——把环境盖戳到 `CacheConfig` 里，就把这种情况变成了一个可被检测到的干净不匹配。

This is critical for production safety: if an operator changes the model or quantization config, the engine will detect the mismatch and fall back to disk loading rather than mapping incompatible weights.

> **译：** 这对生产安全至关重要：如果运维人员更改了模型或量化配置，引擎会检测到不匹配并回退到磁盘加载，而不是去映射不兼容的权重。

On top of config validation, quantization methods are gated by an **IPC allowlist**. CUDA IPC zero-copy exports only raw tensor data, so it is correct only when the entire effect of `process_weights_after_loading()` is captured by that data. Methods that stamp Python-side metadata or repack/transpose weights (per-tensor FP8, Marlin, AWQ/GPTQ) would silently serve wrong numerics — they raise a hard error instead. Currently verified: **unquantized** and **block-wise FP8** (`weight_block_size` set); more methods will be added after end-to-end verification.

> **译：** 在配置校验之上，量化方法还由一份 **IPC 允许列表** 把关。CUDA IPC 零拷贝只导出原始张量数据，因此只有在 `process_weights_after_loading()` 的全部效果都被这些数据涵盖时才正确。那些会在 Python 侧写入元数据、或对权重做重排/转置的方法（per-tensor FP8、Marlin、AWQ/GPTQ）会静默地给出错误数值——因此它们会直接抛出硬错误。目前已验证：**未量化** 与 **block-wise FP8**（设置了 `weight_block_size`）；更多方法将在端到端验证后加入。

### Three Modes: daemon, client, and off

| Mode | Flow | Weight Load Time | GPU Memory | Use Case |
|---|---|---|---|---|
| **daemon** | Engine launches daemon → daemon loads from disk → engine maps IPC | < 1s (after daemon ready) | 1× (shared) | First start; engine manages daemon lifecycle |
| **client** | Connect to pre-running daemon → map IPC | < 1s | 1× (shared) | Engine restart; daemon pre-running |
| **off** | Normal disk loading | 405–411s (Ling-2.6-1T FP8) | 1× | Default; no cache |

In **daemon** mode, the engine spawns daemon processes during startup and waits for them to load weights from disk. The first start is still slow (daemons must load from disk), but subsequent restarts are instant.

> **译：** 在 **daemon** 模式下，引擎在启动期间派生 daemon 进程，并等待它们从磁盘加载权重。首次启动仍然较慢（daemon 必须从磁盘加载），但后续重启是瞬时的。

In **client** mode, the engine connects to already-running daemons. This is the fast-restart path — the daemon was started earlier and already holds weights in GPU memory.

> **译：** 在 **client** 模式下，引擎连接到已经在运行的 daemon。这是快速重启路径——daemon 此前已启动并在 GPU 显存中持有权重。

### Safety and Robustness

The Weight Cache Daemon is designed to be **non-intrusive and safe**:

> **译：** Weight Cache Daemon 在设计上 **非侵入且安全**：

- **Minimal invasiveness**: The feature is self-contained in `python/sglang/srt/weight_cache/` with minimal changes to the core engine (only `load_model()` dispatch and a CLI flag).
- **Crash-safe**: If the daemon crashes, existing engine instances continue running — they already hold references to the IPC-mapped tensors via CUDA reference counting. GPU memory is only freed when **both** the daemon and the engine exit.
- **Daemon recovery**: If the daemon is restarted, it reloads weights from disk and re-exports IPC handles. New engine instances can then connect to the restarted daemon.
- **Fallback on mismatch**: Config mismatches automatically fall back to disk loading (in client mode) or raise an error (in daemon mode, where fallback would cause OOM since both processes share the same GPU).

> **译：**
> - **极低侵入性**：该特性自包含在 `python/sglang/srt/weight_cache/`，对核心引擎的改动极小（仅 `load_model()` 派发与一个 CLI 参数）。
> - **崩溃安全**：若 daemon 崩溃，已有的引擎实例继续运行——它们已通过 CUDA 引用计数持有 IPC 映射张量的引用。只有当 daemon 与引擎 **两者都** 退出时，GPU 显存才会被释放。
> - **daemon 恢复**：若 daemon 被重启，它会从磁盘重新加载权重并重新导出 IPC 句柄。新的引擎实例随后可连接到重启后的 daemon。
> - **不匹配回退**：配置不匹配时自动回退到磁盘加载（client 模式），或抛出错误（daemon 模式——因为两进程共享同一 GPU，回退会导致 OOM）。

---

## Beyond Restart: Production Scenarios

The Weight Cache Daemon unlocks production patterns that are impractical with traditional disk-based loading:

> **译：** Weight Cache Daemon 解锁了在传统磁盘加载下难以实现的生产模式：

### Multi-Instance Weight Sharing

A single daemon per GPU holds weights in memory; multiple engine instances (e.g., independent services) map to the same IPC handles via zero-copy. Weights are loaded from disk and quantized **exactly once per GPU**, regardless of how many instances consume them.

> **译：** 每个 GPU 只需一个 daemon 在显存中持有权重；多个引擎实例（如相互独立的服务）通过零拷贝映射到相同的 IPC 句柄。无论有多少实例消费，权重在 **每个 GPU 上只从磁盘加载并量化一次**。

![Multi-instance weight sharing: multiple engine instances on the same GPU map to the same IPC handles held by one Weight Cache Daemon.](/vibe-reading/images/articles/sglang-official-fast-engine-recovery/multi-instance.svg)

### Priority Co-Serving

Run a high-priority online service and a low-priority batch job on the same GPU, backed by the same weight cache daemon. The low-priority instance can be **evicted and re-spawned in sub-second time** without reloading weights from disk — enabling flexible GPU time-sharing without the usual startup penalty.

> **译：** 在同一 GPU 上运行一个高优先级在线服务和一个低优先级批处理任务，背后是同一个 weight cache daemon。低优先级实例可以在 **亚秒级时间内被驱逐并重新拉起**，无需从磁盘重新加载权重——实现灵活的 GPU 时分复用，且没有通常的启动代价。

### Active-Standby Failover

Deploy a standby engine alongside the primary, both backed by the same weight cache daemon. The standby maps weights via zero-copy and stays warm. When the primary fails, the standby takes over in **< 1 second** — no weight loading, no disk I/O.

> **译：** 在主引擎旁部署一个备用引擎，两者背后是同一个 weight cache daemon。备用引擎通过零拷贝映射权重并保持热状态。当主引擎故障时，备用引擎在 **< 1 秒** 内接管——无权重加载、无磁盘 I/O。

This achieves near-zero-downtime failover **without dedicating a full set of GPUs to an idle replica**, avoiding the expensive GPU resource waste of traditional hot-standby deployments.

> **译：** 这实现了近零停机故障切换，**且无需为空闲副本独占一整套 GPU**，避免了传统热备部署昂贵的 GPU 资源浪费。

![Active-standby failover: primary and standby engines share weights via the same Weight Cache Daemon; on primary failure the standby takes over in under one second.](/vibe-reading/images/articles/sglang-official-fast-engine-recovery/active-standby.svg)

---

## Performance

### Weight Loading: Disk vs IPC Zero-Copy

#### Single Node

| Model | Weight Size | Disk Load (s) | IPC Zero-copy (s) | Speedup |
|---|---|---|---|---|
| **Qwen3-235B FP8** | ~235 GB | ~306–327 | <1 | ~500× |
| **Ling-2.6-1T** | ~1 TB | ~405–411 | <1 | ~780× |

#### Performance Chart

![Performance results: disk load vs IPC zero-copy weight loading for Qwen3-235B FP8 and Ling-2.6-1T.](/vibe-reading/images/articles/sglang-official-fast-engine-recovery/results.svg)

---

## How to Use

### Launch Weight Cache Daemons — single-node

One command launches all TP rank daemons:

> **译：** 一条命令启动所有 TP rank 的 daemon：

```bash
# Standalone daemon launch (one command for all TP ranks):
python -m sglang.srt.weight_cache.daemon \
    --model-path /path/to/model --tp-size 4 \
    --load-format auto --dtype auto --quantization fp8
```

Wait for daemons to become ready (they write a `.ready` file per rank):

> **译：** 等待 daemon 就绪（每个 rank 会写一个 `.ready` 文件）：

```bash
# Check readiness:
ls /tmp/sglang_weight_cache_rank*.ready
```

### Start Engine with Weight Cache

> **译：** 用 weight cache 启动引擎：

```bash
# Engine Client — connect to pre-running daemons (restart)
python -m sglang.launch_server \
    --model-path /path/to/model --tp-size 4 \
    --weight-cache-mode client
```

### Launch Weight Cache Daemons — multi-node

In a multi-node deployment, each node runs its own daemon for its local TP ranks. All daemons join the same distributed group, so `--nnodes`, `--node-rank`, and `--dist-init-method` must be consistent across nodes, with `$MASTER_ADDR` pointing at node 0:

> **译：** 在多节点部署中，每个节点为它本地的 TP rank 运行自己的 daemon。所有 daemon 加入同一个分布式组，因此 `--nnodes`、`--node-rank` 与 `--dist-init-method` 必须在各节点间保持一致，且 `$MASTER_ADDR` 指向 node 0：

```bash
# Daemon on node 0:
python -m sglang.srt.weight_cache.daemon \
    --model-path /path/to/model --tp-size 2 \
    --load-format auto --dtype auto --quantization fp8 \
    --nnodes 2 --node-rank 0 \
    --dist-init-method tcp://$MASTER_ADDR:29500
```

```bash
# Daemon on node 1:
python -m sglang.srt.weight_cache.daemon \
    --model-path /path/to/model --tp-size 2 \
    --load-format auto --dtype auto --quantization fp8 \
    --nnodes 2 --node-rank 1 \
    --dist-init-method tcp://$MASTER_ADDR:29500
```

Once every node reports its daemons ready, start the engine clients. They use a separate rendezvous port (`29600`) from the daemons (`29500`):

> **译：** 每个节点都报告其 daemon 就绪后，启动引擎 client。它们使用的会合端口（`29600`）与 daemon（`29500`）不同：

```bash
# Engine client on node 0:
python -m sglang.launch_server \
    --model-path /path/to/model --tp-size 2 \
    --weight-cache-mode client \
    --nnodes 2 --node-rank 0 \
    --dist-init-addr $MASTER_ADDR:29600 --port 34000
```

```bash
# Engine client on node 1:
python -m sglang.launch_server \
    --model-path /path/to/model --tp-size 2 \
    --weight-cache-mode client \
    --nnodes 2 --node-rank 1 \
    --dist-init-addr $MASTER_ADDR:29600
```

---

## Fast Engine Recovery Framework: Roadmap

The Weight Cache Daemon is Phase 1 of a broader **Fast Recovery Framework** targeting **< 10s cold restarts** and **< 1s warm standby switches**:

> **译：** Weight Cache Daemon 是更宏大的 **Fast Recovery Framework** 的第一阶段，目标是 **< 10s 冷重启** 与 **< 1s 热备切换**：

| Phase | Current (s) | Target (s) | Approach | Status |
|---|---|---|---|---|
| **Load weight** | ~306–327 | < 1 | Weight Cache Daemon (CUDA IPC) | **Done (this PR)** |
| Capture CUDA graph | ~34.9 | < 3 | CUDA graph serialization + replay | Planned |
| DeepGEMM JIT warmup | ~23.1 | < 2 | Kernel cache persistence, parallel warmup | Planned |
| Server init & Tokenizer | ~17.3 | < 3 | Lazy tokenizer init, config caching | Planned |
| Init torch distributed | ~4.7 | < 2 | NCCL session reuse, persistent process groups | Planned |
| KV Cache allocation | ~0.5 | < 0.5 | kvcache reuse | Planned |
| Server ready | ~3.4 | < 1 | Skip warmup requests on restart | Planned |
| **Total (single-node)** | **~390** | **< 10** | | |

Support for more models is also on the way.

> **译：** 对更多模型的支持也在推进中。

---

## Public Roadmap

The Weight Cache Daemon is just the **first step** — there is still much to build. Phase 1 today covers TP + PP, single- and multi-node launch, per-GPU zero-copy CUDA IPC, and unquantized plus block-wise FP8. Beyond that, many high-impact directions remain open:

> **译：** Weight Cache Daemon 只是 **第一步**——还有很多要建。目前 Phase 1 覆盖 TP + PP、单节点与多节点启动、每 GPU 零拷贝 CUDA IPC，以及未量化加 block-wise FP8。除此之外，仍有许多高影响力方向是开放的：

- **More models & quantization**: extend the IPC allowlist beyond block-wise FP8 (per-tensor FP8, INT8, MXFP8, NVFP4, AWQ/GPTQ, ...) and cover more architectures, including multimodal and LoRA base weights.
- **DP/EP & multi-node**: DP/EP shard keying and cross-node daemon coordination, lifecycle management, and failover.
- **Weight update without reload**: in-place weight refresh for RL / online updates, with the daemon as the delivery agent.
- **Cross-GPU & fleet sharing**: peer-copy and fleet-fill so a cluster cold start pays roughly one disk read per shard group.
- **KV cache restore**: preserve and remap KV cache across restarts / failover (KV reuse, handoff to standby) so in-flight context survives recovery instead of being recomputed from scratch.
- **Rest of the startup path**: CUDA graph serialization, kernel-warmup persistence, and faster server / distributed init to reach the **< 10s** cold-restart goal.
- **Other hardware backends**: extend this feature to other accelerators that expose similar functionality (AMD and Intel both have comparable IPC mechanisms).
- **Ops & reliability**: metrics, status tooling, security hardening, and CI coverage.

> **译：**
> - **更多模型与量化**：把 IPC 允许列表扩展到 block-wise FP8 之外（per-tensor FP8、INT8、MXFP8、NVFP4、AWQ/GPTQ……），并覆盖更多架构，含多模态与 LoRA 基座权重。
> - **DP/EP 与多节点**：DP/EP 分片键控与跨节点 daemon 协调、生命周期管理与故障切换。
> - **免重载权重更新**：为 RL / 在线更新做就地权重刷新，以 daemon 作为投递代理。
> - **跨 GPU 与集群共享**：peer-copy 与 fleet-fill，使一次集群冷启大约每个分片组只付一次磁盘读取。
> - **KV cache 恢复**：在重启/故障切换间保留并重映射 KV cache（KV 复用、向备用移交），让在途上下文在恢复中存活，而非从零重算。
> - **启动路径的其余部分**：CUDA graph 序列化、kernel 预热持久化，以及更快的 server/分布式初始化，以达成 **< 10s** 冷重启目标。
> - **其他硬件后端**：将该特性扩展到暴露类似功能的其它加速器（AMD 与 Intel 都有可比的 IPC 机制）。
> - **运维与可靠性**：指标、状态工具、安全加固与 CI 覆盖。

This is very much a community effort. The full plan is tracked publicly at [sgl-project/sglang#33522](https://github.com/sgl-project/sglang/issues/33522) — contributions and feedback are welcome, and there is plenty of impactful work to pick up.

> **译：** 这是一项需要社区共建的工作。完整计划在 [sgl-project/sglang#33522](https://github.com/sgl-project/sglang/issues/33522) 公开追踪——欢迎贡献与反馈，有大量有影响力的工作可认领。

---

## Acknowledgements

**Ant Ling Infra Team, Ant Group:** [Michael Qiu](https://github.com/QiuMike) — qiudayu.qdy@antgroup.com

**Alibaba:** [Siyu Liu](https://github.com/liusy58) — liusy58@smail.nju.edu.cn

**SGLang Team:** [Alex Nails](https://github.com/alexnails)

> **译：** **蚂蚁 Ling Infra 团队 / 蚂蚁集团：** [Michael Qiu](https://github.com/QiuMike) — qiudayu.qdy@antgroup.com
> **阿里巴巴：** [Siyu Liu](https://github.com/liusy58) — liusy58@smail.nju.edu.cn
> **SGLang 团队：** [Alex Nails](https://github.com/alexnails)

---

## 相关阅读

> 相关阅读：本文属 Vibe Reading 博客 LLM 推理服务系列。SGLang 的 Weight Cache Daemon 通过 CUDA IPC 零拷贝把权重常驻 GPU 显存，与 [[sglang-pr-26220-cola-dlm-text-diffusion]]（SGLang 接入 Cola-DLM 文本扩散）、[[sglang-efficient-structured-lm-programs]]（SGLang 结构化生成）同属 SGLang 生态；推理引擎与加速方向可对照 [[flashinfer-attention-engine-llm-serving]]（FlashInfer 统一 attention 引擎，KV cache 格式与 CUDAGraph 兼容）、[[kuaishou-blogs-wanqing-llm-inference-optimization]]（快手万擎推理成本与性能优化，PD 分离 + 分级 KV Cache + 10 秒级实例启动）、[[pipo-pair-in-pair-out-latent-multi-token-prediction]]（latent 压缩 + 多 token 预测加速推理）——后者从模型结构侧降本，本文从引擎冷启动侧降本，互补。
