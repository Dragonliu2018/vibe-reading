---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "分布式层"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "DCS", "RolloutManager", "NCCL", "权重同步", "弹性扩缩容", "barrier"]
description: "解读 Relax 分布式层：DCS 分布式 checkpoint 服务控制面、RolloutManager 多引擎管理与弹性扩缩容、DeviceDirectBackend NCCL 权重广播、barrier 协调与 TransferQueue 数据传输。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/distributed/`（9,196 行）是六层架构的分布式层，承载三个横切职责：**DCS 权重同步控制面**（coordinator 管元数据 + DeviceDirectBackend 管数据面 NCCL broadcast）、**Ray Actor 组管理**（`RolloutManager` 管多 SGLang 引擎集群、`GenRMManager` 管 GenRM 引擎）、**跨角色协调**（`PeerStepBarrier`/`RolloutOffloadBarrier`）。它解决的核心问题是：RL 每 step 都要把训练后的权重从 Megatron actor 同步到推理引擎，而数十 GB 权重不能用 Ray object store（CPU 序列化不可接受）——DCS 作为控制面只传轻量元数据，实际 tensor 走 NCCL 点对点直传。

## 模块架构

分布式层分两块：`checkpoint_service/`（DCS）与 `ray/`（Actor 组 + coordination）。DCS 内部 coordinator/backends/client 三层分离——`DCSCoordinator` 是 Ray Serve 部署的控制面（注册/拓扑/心跳/权重元数据 long-poll），`DeviceDirectBackend` 是数据面（NCCL broadcast），`CheckpointEngineClient` 是 actor 侧客户端。`ray/rollout.py` 的 `RolloutManager` 是 god node（88 边），管理 `RolloutServer`→`EngineGroup`→`SGLangEngine` 三级引擎集群，含弹性扩缩容双模式。`coordination.py` 的两个 barrier 是无状态轮询包装器。

```
distributed/
├── checkpoint_service/                DCS（Distributed Checkpoint Service）
│   ├── coordinator/
│   │   ├── service.py (484)  DCSCoordinator（@serve.deployment，FastAPI 控制面）
│   │   └── topology.py       TopologyManager（角色注册/rank 分配/拓扑发现）
│   ├── backends/
│   │   ├── base.py (396)     CommBackend 抽象 + TensorFusion
│   │   └── device_direct.py (1117)  DeviceDirectBackend（NCCL/GLOO broadcast）
│   ├── client/engine.py (376)  CheckpointEngineClient（actor 侧数据面客户端）
│   └── metrics.py (556)
├── ray/
│   ├── rollout.py (4090)     RolloutManager（god node 88 边）+ RolloutServer + EngineGroup
│   ├── genrm.py (442)        GenRMManager
│   ├── train_actor.py        TrainRayActor 基类
│   ├── ray_actor.py          RayActor 基类
│   └── placement_group.py    InfoActor + GPU 排序
└── coordination.py           RolloutOffloadBarrier + PeerStepBarrier
```

## 调用链路

DCS 权重同步流程（actor 训练完成 → DCS coordinator → NCCL broadcast → rollout engine load）：

```
MegatronTrainRayActor.update_weights_fully_async(rollout_id)      # backends/megatron/actor.py:1814
  → checkpoint_engine_client.update_weights_for_rollout()          # client/engine.py:282
      → HTTP GET /topology（拉所有 rollout 节点 IP/rank）           # coordinator/service.py
      → DeviceDirectBackend.init_process_group_for_rollout(top)    # device_direct.py:354
          → 创建 RolloutEngine proxy actors + 健康检查
          → POST /init_weights_update_group（master_addr/port/rank_offset/world_size）
          → dist.init_process_group（建 NCCL 组）
      → DeviceDirectBackend.update_weights_for_rollout()           # device_direct.py:562
          → rank 0: POST /pause_generation + /flush_cache（所有引擎）
          → 逐参数: all_gather_param（跨 TP）→ convert_to_hf（Megatron→HF）→ buffer
          → bucket 满: 获取远程 lock → send_weight_meta → dist.broadcast（NCCL）
          → ray.get(futures)（确保 rollout 端 load 完成）
          → rank 0: POST /continue_generation
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `RolloutManager.generate` | 驱动 rollout 生成 | 转发 `generate_rollout`，传 data_system_client |
| `RolloutManager.offload/onload` | SGLang 显存释放/恢复 | 配合 Megatron sleep/wake |
| `RolloutManager.dispose` | 关闭所有引擎 | `engine.shutdown.remote()` + 超时 `ray.kill` 兜底 |
| `_scale_out_ray_native` | 同集群弹性扩容 | 独立 PG + 增量等 ready + partial success |
| `_scale_out_external` | 跨集群联邦 | RPC proxy actor（0.2 CPU 不占 GPU） |
| `DCSCoordinator.register_node` | 节点注册分 rank | TopologyManager 管理 |
| `DCSCoordinator.recv_weight_meta` | long-poll 收权重元数据 | 控制面只传元数据，tensor 走 NCCL |
| `DeviceDirectBackend.update_weights_for_rollout` | NCCL broadcast 权重 | topology reuse 快路径跳过重建组 |
| `RolloutOffloadBarrier.wait_offloaded` | 等 SGLang offload | 轮询 get_status，无状态 |
| `PeerStepBarrier.wait_completed_round` | 等 peer 完成轮次 | 轮询 get_step > round_id |

</details>

## 核心实现

### DCS：控制面与数据面分离

`DCSCoordinator`（`coordinator/service.py:126`，`@serve.deployment(num_replicas=1)` + `@serve.inggress(app)`）是控制面 Ray Serve 服务，暴露 FastAPI 端点：`/register`（节点注册分 rank）、`/topology`（拓扑发现）、`/heartbeat`（心跳）、`/recv_weight_meta`（long-poll 收权重元数据）、`/send_weight_meta`（发元数据）。它不传 tensor，只传 names/dtypes/shapes 元数据——实际 tensor 由 `DeviceDirectBackend` 直接 `dist.broadcast` 绕过 Ray object store。

`DeviceDirectBackend`（`backends/device_direct.py:60`，继承 `CommBackend`）是数据面，`update_weights_for_rollout`（`:562`）执行 NCCL broadcast：rank 0 发 `/pause_generation`+`/flush_cache`，逐参数 `all_gather_param`（跨 TP 合并分片）→ `convert_to_hf`（Megatron→HF）→ buffer，bucket 满时 `_update_bucket_weights_from_distributed`（`:823`）获取远程 lock → 发 weight metadata → `dist.broadcast`（NCCL）→ `ray.get(futures)` 确保 rollout 端 load。`topology reuse 快路径`（`:354` `_rollout_topology_signature`）：拓扑不变且引擎健康时跳过 destroy/create process group，复用 NCCL group 避免每步重建开销。`RolloutEngine`（`:1054`，`@ray.remote` HTTP proxy actor）封装与 SGLang 的 HTTP 通信，解决 NCCL broadcast 需协调 SGLang 端 init/destroy process group 的问题。

### RolloutManager：多引擎管理与弹性扩缩容

`RolloutManager`（`ray/rollout.py:799`，`@ray.remote` with `concurrency_groups`：health_monitoring/scale_out/scale_in/scale_coordination/recover_rollout_engines）是 god node（88 边），管理 `RolloutServer`（多 `EngineGroup` + router）→ `EngineGroup`（同构引擎组）→ `SGLangEngine` 三级集群。长耗时操作（scale-out 含 PG 等待+引擎 init+权重同步）用独立并发组不阻塞 generate/eval。

弹性扩缩容双模式（`_actor_rollout_pg_roles`）：
- **ray_native**（`_scale_out_ray_native`，`:1576`）：每 replica 独立 PG → 增量等 ready（不阻塞最慢）→ `_bring_up_single_replica`（probe GPU topology → 创建 EngineGroup → start engines → health check → weight sync → register router）。Partial success：超时保留已成功 replica，未完成标记 failed。
- **external federation**（`_scale_out_external`，`:1918`）：解析外部 engine URLs → 创建轻量 RPC proxy actor（0.2 CPU 不占 GPU）→ `init(skip_dcs_registration=True, skip_router_registration=True)` → health check → DCS 注册 → weight sync → router 注册。

幂等保证（`create_scale_out_request`，`:1398`）：ray_native 的 `num_replicas` 是绝对目标值，`effective_current >= target_total` 返回 NOOP；external URL 去重。`_find_active_scale_request`（`:1382`）确保同时只有一个 scale 操作。新引擎权重同步走 seed engine 路径（`_sync_weights_from_seed_engine`，`:2357`），用 `_weight_sync_lock` 防止与 DCS 路径并发。

故障容忍降级：`_update_rollout_engines`（`:276`）重试耗尽后不无条件 raise，而是 prune 不健康引擎后继续——注释（`:316`）说明此前即使有健康引擎也 raise 导致 actor 权重同步失败→全局重启→丢训练进度。`GenRMManager.recover`（`genrm.py:209`）同理，部分引擎无法恢复时降级 N-1 运行，仅全死才 raise。

### Barrier 协调

`RolloutOffloadBarrier`（`coordination.py:28`）：轮询 `rollout_manager.get_status.remote()` 直到非 "onload"，确保 SGLang 释放 GPU 后 Megatron 才 wake_up。`PeerStepBarrier`（`:50`）：轮询所有 peer `handle.get_step.remote()`，`step > round_id` 表示该 peer 完成该轮（含 backward+optimizer+sleep，GPU 已释放），全部完成才进下一轮。两者都是无状态轮询包装器，未使用时零开销，支持 sync/async 双接口。colocate 模式接线（见 [01-orchestration](01-orchestration)），fully_async/hybrid 短路。用轮询而非条件变量因 peer 是远程 Ray Serve deployment，`get_step.remote()` 是唯一可靠跨进程状态查询；轮询间隔 1 秒对训练步（数十秒到数分钟）开销可忽略。

### TransferQueue 跨角色数据传输

`RolloutManager.__init__` 中 `tq.init(args.tq_config)` + `tq.get_client()` 获取 `data_system_client`，`generate()` 通过 `call_rollout_fn` 传入 rollout function，rollout function 用它把生成样本 `async_put` 进 `train_{rollout_id}` 分区。训练侧 Actor 通过 TQ client 拉取。TransferQueue 是独立数据面传输系统，不经 Ray object store，适用于大规模 rollout 数据跨角色传输（避免序列化开销与内存压力），支持流式与 `max_staleness`。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 后端策略 | `CommBackend` ABC + `DeviceDirectBackend` in `backends/base.py:113`、`device_direct.py:60` | `BackendType`（NCCL/GLOO/TCP/HCCL）选后端，TCP 预留扩展点 |
| 协调器（控制面/数据面分离） | `DCSCoordinator` vs `DeviceDirectBackend` | 控制面只传元数据，tensor 走 NCCL 绕过 Ray object store |
| 屏障 | `RolloutOffloadBarrier`/`PeerStepBarrier` in `coordination.py:28,50` | 无状态轮询，colocate 协调 GPU 时序 |
| 代理 Actor | `RolloutEngine` in `device_direct.py:1054` | `@ray.remote` HTTP proxy，封装 SGLang HTTP 通信 |
| 幂等扩缩容 | `create_scale_out_request` in `rollout.py:1398` | 绝对目标值 + URL 去重，防重复扩容 |
| 降级容错 | `_update_rollout_engines` in `device_direct.py:276` | prune 死引擎继续而非全局重启 |

## 模块间交互

distributed 依赖 `backends.megatron.weight_conversion`（`convert_to_hf`）、`backends.megatron.weight_update`（`all_gather_param`/`BridgeConverter`/`LoraAdapterSync`）、`backends.sglang`（`SGLangEngine`/`GenRMEngine`）、`utils`（`ReloadableProcessGroup`/device/env/http_utils）、`transfer_queue`。被 `core/controller`（`create_dcs_deployment`/barrier/`stop_launched_routers`）、`components/rollout`（`create_rollout_manager`）、`components/actor`（barrier 注入）、`backends/megatron/actor`（`CheckpointEngineClient`）调用。backends↔distributed 双向依赖是权重同步链路自然双向（actor 发起→DCS 协调→NCCL broadcast→engine 接收→转换回传）。详见概览「模块地图」。

## 扩展方式

- **新增 checkpoint backend**：`backends/` 新建 `tcp_backend.py` 实现 `CommBackend`（send/recv/broadcast/init_process_group/close）；`client/engine.py:239` `_init_backend` 加 `elif BackendType.TCP` 分支
- **新增 barrier 协调**：`coordination.py` 参照 `PeerStepBarrier` 新增轮询 class；`controller.py:686-705` 接线；`components/actor.py:104` 加 barrier 字段
- **新增 NCCL 通信拓扑**：`device_direct.py` 加 `init_process_groups_for_X`（参照 `init_process_groups_for_actor_fwd_ref`）+ `_update_bucket_weights_for_X`；`coordinator/service.py` 加 `/get_X_update_group_ranks` endpoint；`client/engine.py` 加 client 方法
