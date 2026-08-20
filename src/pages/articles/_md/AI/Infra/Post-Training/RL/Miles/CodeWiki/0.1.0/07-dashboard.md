---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "可观测性"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "Dashboard", "Observability", "FastAPI", "NVML", "Telemetry"]
description: "自托管 web UI，per-GPU-per-step 行为可视化，三层延迟管线，fire-and-forget 降级保证不阻塞训练。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

Miles Dashboard 是自托管 web UI，展示一次 RL run 的训练动态和计算效率——每块 GPU 在一个 step 里做了什么、每条 trajectory 的 token 级内容。它的核心价值在于 wandb/tensorboard 无法展示的维度：per-GPU-per-step 行为时间线、token 级 trajectory 内容、batch anatomy swimlanes、启发式告警。与 audit_utils/event_logger 完全独立——dashboard 面向训练动态和计算效率，audit 面向正确性审计。

## 模块架构

```
miles/dashboard/
├── store.py          # MetricStore — 文件存储引擎（读写双端，1517 行）
├── dump_reader.py    # .pt dump 惰性读取器（token 级内容，726 行）
├── advisory.py       # 启发式健康告警 + sglang 配置调优建议
├── hooks.py          # 进程侧 hooks（PhaseSink / TrajectorySink）
├── collector.py      # DashboardCollector — 数据采集中枢（Ray named actor）
├── server.py         # FastAPI REST API 路由
├── sglang_scraper.py # sglang engine 指标抓取器
├── gpu_sampler.py    # per-node NVML 采样器
├── backend.py        # Ray 生命周期胶水
├── args.py           # CLI 参数 + CollectorConfig
└── serve.py          # standalone 服务入口
```

## 调用链路

数据写入流（训练过程 → store）与读取渲染流（store → 前端）：

```
[写入] 三条数据通道汇聚到 DashboardCollector (Ray named actor):
  ① Phase 事件（每 GPU 做了什么）:
     Timer.__exit__ → PhaseSink.__call__(name,t0,t1) → push_phases.remote(batch)
  ② NVML 采样（GPU 利用率/显存/功耗）:
     GpuSampler.sample_once() 每 1s → flush 每 5s → push_gpu_samples.remote()
  ③ sglang engine 指标:
     SglangScraper.scrape_once() 每 2s → GET {router}/engine_metrics → push

  DashboardCollector._run_flush_loop() 每 5s:
    → _reconcile_samplers() (diff alive GPU nodes)
    → flush() → MetricStore.flush() → 分 stream 写 JSONL（高频按小时分区）

[读取] serve.py → MetricStore.load() + DumpReader → FastAPI:
  GET /api/timeline/phases → store.phases_by_lane() → phase 区间
  GET /api/timeline/gpu → store.gpu_series() → NVML 时间序列
  GET /api/timeline/heatmap → store.heatmap() → uint8 矩阵 binary
  GET /api/rollout/{id}/sample/{idx}/tokens → reader.tokens() → per-token metrics
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `MetricStore.append()` in `store.py:459` | 写入端追加记录 | append-only JSONL |
| `MetricStore.follow()` in `store.py:566` | 读端增量 tail | byte-offset 只消费完整行 |
| `DashboardCollector.push_*()` | 多源 fire-and-forget 推送 | MAX_BUFFERED=500K/stream + drop oldest |
| `GpuSampler.sample_once()` in `gpu_sampler.py:114` | NVML 采样 | 每 1s util/mem/power |
| `SglangScraper.scrape_once()` | sglang 指标抓取 | router 模式聚合 / direct 模式并发 |
| `DumpReader.tokens()` in `dump_reader.py:536` | token 级内容 | mmap .pt dump 惰性加载 |
| `compute_advisories()` in `advisory.py:59` | 启发式告警 | 跨域推理（telemetry + dump） |

</details>

## 核心实现

### 三条数据通道

1. **Phase 事件**：每个训练 rank 的 `Timer` 上下文管理器退出时调 `PhaseSink.__call__`（`hooks.py:104`），把 `(name, t0, t1, node, gpus, rank, role)` 打包成 `PhaseEvent` 批量推送。读端 `phases_by_lane`（`store.py:843`）将 rollout manager 的无 GPU 事件扩展到 topology window 下所有 rollout engine 的 GPU——每块 GPU 都能看到它处于哪个 phase。

2. **NVML 采样**：collector 在 flush loop 的 `_reconcile_samplers`（`collector.py:326`）中 diff `ray.nodes()` 与已有 sampler，为每个 GPU node spawn `GpuSampler` actor（`NodeAffinitySchedulingStrategy` 硬 pin）。daemon thread 每 1s 读 NVML `nvmlDeviceGetUtilizationRates`/`nvmlDeviceGetMemoryInfo`/`nvmlDeviceGetPowerUsage`。

3. **sglang engine 指标**：`SglangScraper` 每 2s 抓取，router 模式 `GET {router}/engine_metrics`（一次性所有 engine），direct 模式并发 `GET {addr}/metrics`（ThreadPoolExecutor max 8），解析 prometheus text format。

### token 级 trajectory 内容

不经过 telemetry 流，而是由训练的 `--dump-details` 直接写 `.pt` 文件。`DumpReader.tokens`（`dump_reader.py:536`）请求时惰性加载：rollout 侧 per-token 列从 `dashboard_columns/rollout_{rid}.parquet` 读；train 侧 per-token 列经 `torch.load(mmap=True)` 惰性 mmap train shard，只 fault in 请求行所需 KB 级数据。两源 join 返回 `token_ids`/`token_text`/`rollout_log_probs`/`train_log_probs`/`ref_log_probs`/`lp_diff`/`imp_ratio`/`entropy`/`advantages`/`returns` 等 per-token 数组。

### store 持久化与并发模型

**持久化**：`MetricStore` 以 append-only JSONL 写入 `{dump_details}/dashboard/`。高频 stream（gpu_util/engine_series/phases/trajectories/gpu_processes）按小时分区 `{stream}/{YYYYMMDD_HH}.jsonl`；低频 stream（metrics/topology/data_buffer）单文件。读端 `load()` 全量加载低频到内存，高频经 `_PartitionReader` 惰性解析 + LRU 块缓存（24 blocks）。

**多 writer 单 reader**：写端 collector（Ray actor）和读端 server（standalone 进程）是不同进程，共享介质是磁盘文件。append-only + 只消费完整行（`chunk.rfind(b"\n")`）保证 reader 不读半写行。`--follow` 模式 server 每 2s `store.follow()` tail 新数据。

### 三层延迟管线

| 层 | 间隔 | 代码位置 |
|----|------|---------|
| 采集 | NVML 1s / sglang 2s / Phase 即时 begin + 批量 close | `gpu_sampler.py:33` / `sglang_scraper.py:99` |
| 持久化 | flush 5s | `collector.py:131` |
| 读取 | follow 2s | `serve.py:27` |

端到端延迟 ~8s（1s 采样 + 5s flush + 2s follow）。Phase begin marker 即时（不计入批量），close 最多延迟 ~7s。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 生产者-消费者 | `DashboardCollector` + `PhaseSink`/`TrajectorySink`/`GpuSampler` | 多源 fire-and-forget 推送，生产者永远不等消费者 |
| Named Actor 单例 | `COLLECTOR_ACTOR_NAME="miles_dashboard_collector"` | 所有进程经 `ray.get_actor(name)` 解析同一 collector |
| Fire-and-forget + 降级 | `hooks.py:8` "Every entry point is a no-op when disabled" | 可观测性绝不 kill training step，异常 catch + 限频告警 |
| Append-only + byte-offset tail | `store.py:566` `follow()` | 文件只追加不修改，只消费完整行 |
| 鸭子类型注入 | `TrajectoryLifecycle().sink` | 核心代码不 import dashboard，sink=None 时 no-op |
| Bounded buffer + drop oldest | `MAX_BUFFERED_PER_STREAM=500_000` | 磁盘满时丢弃最旧并 LOUD 告警，防 OOM |

### 为什么自托管 web UI 而非 wandb

wandb 擅长 scalar 曲线，但 dashboard 核心价值在 wandb 无法展示的维度：per-GPU-per-step 行为的二维 carpet/heatmap（`store.py:1275` `heatmap` 返回 uint8 矩阵）；token 级 trajectory 内容（需读 .pt dump join rollout+train 两源）；batch anatomy swimlanes（trajectory 事件 + topology join）；advisory 告警（跨域推理需同时读 telemetry 和 dump）。dashboard 并不排斥 wandb——`server.py:66` 生成 wandb run 页直链，二者互补。

## 模块间交互

dashboard 被 `miles/ray/rollout/rollout_manager.py`（`dashboard_hooks.register_router` + `register_engines`）、`miles/backends/megatron_utils/actor.py`（`register_train_actor` 每 rank）、`miles/rollout/sglang_rollout.py`（`TrajectoryLifecycle().sink`）喂数据。`tracking_utils/base.py` 的 `MilesDashboardBackend` 经 `miles/dashboard/backend.py` 的 `init_dashboard`/`dashboard_log`/`finish_dashboard` 交互。与 `audit_utils/event_logger` 无直接关系（经 grep 确认无 import）——两者独立观测系统，dashboard 面向效率，audit 面向正确性。

## 扩展方式

#### 新增一个可视化面板（如 KV Cache Pressure）

`store.py` 新增查询方法（基于 `engine_series("sglang_token_usage")` 交叉计算）；`server.py:make_app` 加 `@app.get("/api/timeline/kv_pressure")` 路由；`static/` 新增前端组件 + `app.js` 注册 tab；`/api/meta` 的 `capabilities` 加 `has_kv_pressure` 标志。

#### 加一种 metric 采集（如 NCCL 通信延迟）

`store.py` 新增 `NcclSample(Record)` + `Stream.NCCL_STATS` 枚举 + `_RECORD_TYPE_OF_STREAM` 注册；`collector.py` 加 `push_nccl_samples()`；编写 NCCL 采样器（类似 `gpu_sampler.py`）在 `_reconcile_samplers` 中 spawn；`args.py` 加 `--dashboard-nccl-sample-interval`；训练代码中调 `handle.push_nccl_samples.remote(...)`。
