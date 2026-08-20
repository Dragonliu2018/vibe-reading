---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "容错与审计"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "Fault Tolerance", "IndepDP", "Audit", "Event Sourcing", "Witness"]
description: "原地容错恢复（no restart no pause）、控制平面/数据平面分离、IndepDP 弹性数据并行、事件溯源审计。"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

这一层是 Miles 的旗舰容错特性——SGLang engine 或训练 GPU 挂掉时，原地恢复不重启 job、不暂停训练。它通过控制平面/数据平面分离（K8s 风格 control server + mini controller）、IndepDP 弹性数据并行、事件溯源审计日志三个机制实现。审计日志的 3 条验证规则专门检测 RL 训练中最危险的 silent data corruption。

## 调用链路

容错恢复全链路：

```
SimpleHealthChecker._loop()                    # 周期 RPC check_fn (get_heartbeat_status)
  → 连续失败 failure_threshold 次 → status=FALSE
    → RayTrainCell.cell_status()                # cell_monitor.compute_cell_status
      → Control Server GET /api/v1/cells        # 暴露 K8s 风格状态
        → _MiniFTController._poll_and_heal()    # mini_ft_controller.py:127
          → PATCH suspend=True → group.stop_cell(i) → cell.stop() → ray.kill(actors)
          → sleep(resume_delay)
          → PATCH suspend=False → group.start_cell(i) → cell.mark_as_pending()
            → 下一个 train() 调用 → _refresh_cells()
              → allocate_for_pending() → 新 actor
              → alive cell: send_ckpt (NCCL in-memory checkpoint)
              → healing cell: init() → recv_ckpt → reconfigure_indep_dp (重建 PG, quorum_id++)
              → health_checker.resume()
              → log CellReconfigureEvent
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `SimpleHealthChecker._loop()` in `health_checker.py` | 周期 probe + 去抖 | first_wait 300s grace period + failure_threshold=3 |
| `compute_cell_status()` in `cell_monitor.py:40` | cell + health → CellStatus | K8s 风格 phase + conditions |
| `start_control_server()` in `server.py:30` | FastAPI 控制平面（daemon thread） | K8s 风格 REST API |
| `_MiniFTController._poll_and_heal()` in `mini_ft_controller.py` | 发现 UNHEALTHY cell → heal | 带指数退避（min 5×2^n, 300s） |
| `_refresh_cells()` in `group.py:332` | 恢复 dead cell | alive→healing in-memory checkpoint 传输 |
| `reconfigure_indep_dp_group()` in `indep_dp.py:74` | 重建 NCCL PG | shutdown 旧 PG + 新 quorum_id |
| `EventLogger.log()` in `logger.py:23` | 事件追加写入 JSONL | contextvars 线程/async 安全 |

</details>

## 核心实现

### 原地恢复（no restart, no pause）

三层机制：

1. **Cell 级别 stop/start**：`RayTrainCell.stop()`（`cell.py:108`）只 `ray.kill` 当前 actor 转 `StateStopped`，整个 Ray job 和其他 cell 持续运行。
2. **`_refresh_cells()` 原地恢复**（`group.py:332`）：每次 `train()` 开头检测 pending cell，从 alive cell 经 NCCL `send_ckpt`/`recv_ckpt`（torchft `PGTransport`，`checkpoint_transfer.py:24`）传 in-memory checkpoint，重建 NCCL process group。
3. **retry 包裹 train attempt**（`group.py:164`）：`_RETRY_MAX_ATTEMPTS=30`，恢复期间 alive cells 不暂停——`_execute_all_alive_and_catch` 用 `return_exceptions=True` 收集结果，失败的 cell 标记 errored，成功的照常使用。`group.py:347` 断言至少一个 alive cell——只要不是全挂就能恢复。

### 控制平面/数据平面分离

控制平面：`control_server/server.py` FastAPI HTTP server（独立 daemon thread），暴露 K8s 风格 REST API（`apiVersion="miles.io/v1"`, `kind="Cell"`）——`GET /api/v1/cells`、`PATCH /api/v1/cells/{name}`（suspend/resume）、`POST /inject-fault`。

数据平面：`RayTrainGroup`/`RayTrainCell` 执行训练。`_ActorCellHandle`（`handles.py:37`）将 HTTP 操作翻译为 group 方法调用。

外部控制器：`_MiniFTController`（`mini_ft_controller.py:127`）纯 async 逻辑，通过 HTTP 与控制平面交互，不直接耦合训练代码。模拟 K8s controller 的 reconcile loop——未来可直接接入 K8s 而非 mini controller。

### IndepDP 弹性数据并行

传统 PyTorch DP 的 process group 是静态的——一个 rank 挂掉整个 group 不可用。IndepDP 用 torchft `ProcessGroupNCCL` 支持动态成员变更：`reconfigure_indep_dp_group()`（`indep_dp.py:74`）先 `shutdown()` 旧 PG，再用新 `quorum_id` 和 `alive_cell_indices` 创建新 PG。`allreduce_grads_and_losses_across_replicas()`（`indep_dp.py:107`）用 `GeneralPGUtil` 统一处理 native PG 和 torchft PG 的 all_reduce，`collective_bool_and`（`process_group_utils.py:339`）做 cell 内共识——任何 rank 的 allreduce 失败，所有 rank 一起 discard。

`IndepDPInfo`（frozen dataclass）携带 `cell_index`/`alive_rank`/`alive_size`/`quorum_id`/`alive_cell_indices`，是 cell 在 DP 组中的位置信息。

### 事件溯源审计日志

`EventLogger`（`logger.py:23`）把所有关键状态变更为不可变事件，JSONL 追加写入。8 种事件类型覆盖权重校验和、witness 快照、ID 分配、步结束、cell 重配置、推理引擎校验和、优势计算、指标。`checkpoint.py` 在 model checkpoint 时同步 snapshot event 目录，使 event history 与 model 版本对齐。

3 条离线分析规则（`analyzer.py:33` `run_analysis()`）检测 silent bug：

```python title="miles/utils/audit_utils/event_analyzer/analyzer.py (3 条验证规则)"
def run_analysis(events):
    issues = []
    issues += cross_replica_weight_checksum.check(events)          # 跨 cell 权重一致性（allreduce 是否真工作）
    issues += inference_engine_weight_checksum_consistency.check(events)  # 推理引擎权重一致（weight update 是否成功）
    issues += witness.check(events)                                 # 每样本梯度是否真流过模型（数据是否丢/重复）
    return issues  # 发现问题 → raise ValueError (fail-fast)
```

### Witness 数据血缘追踪

`_DataWitness`（`witness/module.py`）在 model 的 head/tail 插入 `nn.Embedding(buffer_size, 1)`，forward 时 bitwise 0（`w - w.detach()`），backward 时梯度非零则标记该样本被训练。验证每个样本的梯度是否真的流过了模型，检测数据丢失/重复训练。`WitnessIdAllocator`（`allocator.py`）环形分配 ID + 计算 stale_ids，`read_persisted_witness_counter` 从 event 目录恢复计数器确保 ring buffer ID 不冲突。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 健康检查（Liveness Probe + 去抖） | `SimpleHealthChecker._loop` | 类 K8s liveness probe，连续失败阈值去抖避免误杀 |
| 控制平面/数据平面分离 | `control_server/` + `_MiniFTController` | 恢复决策独立于训练进程，未来可接入 K8s |
| 事件溯源 | `EventLogger.log()` | 不可变事件流，离线分析检测 silent corruption |
| 状态机 | `cell_state.py` + `_change_state` | 5 状态强约束，frozen 保证一致性 |
| 策略（PG 抽象） | `GeneralPGUtil.create(group)` in `process_group_utils.py` | native PG / torchft PG 统一接口 |
| Witness 模式 | `_DataWitness` in `witness/module.py` | bitwise 0 forward + 非零梯度 backward 检测数据血缘 |

### 为什么原地恢复而非重启 Job

RL job 运行数小时到数天，重启整个 Ray job 丢失所有 GPU 分配、placement group、rollout manager 状态、SGLang engine 状态；重启需重新加载 model checkpoint（大模型数十分钟），而 in-memory checkpoint transfer 经 NCCL 直接 cell 间传输无需落盘；原地恢复只影响故障 cell，其他 cell 继续训练。

### 为什么 control server 独立

解耦（训练专注训练，恢复决策独立运行不阻塞）；可替换性（control server 模拟 K8s API server，mini controller 模拟 K8s controller reconcile loop，未来直接接入 K8s）；可观测性（外部可随时 `GET /api/v1/cells` 查看 cell 健康）；容错隔离（mini_ft_controller 挂了不影响训练，只是不自动恢复）。

## 模块间交互

`ft_utils` 被 `miles/ray/train/cell.py`（health_checker + IndepDPInfo + CellStatus）和 `group.py`（_refresh_cells + checkpoint transfer + retry）使用。`audit_utils` 被 `megatron_utils/actor.py`（weight checksum + witness）、`loss.py`（advantage event）、`group.py`（step end + reconfigure event）喂数据。`tracking_utils` 的 `TrackingManager` fan-out 到 wandb/tensorboard/mlflow/prometheus/dashboard 各 backend，`MilesDashboardBackend`（`base.py:142`）经 `miles/dashboard/backend.py` 与 dashboard 交互。

## 扩展方式

#### 新增一种故障检测（如 GPU OOM）

`health_checker.py` 新增 `OOMHealthChecker` 或在 `SimpleHealthCheckerConfig` 加 `check_oom` 选项；`cell_monitor.py:create_trainer_cell_health_checker()` 的 `_check()` 加 OOM 检测（如 `torch.cuda.memory_allocated()` 与阈值比较）；如需新 `CellCondition.type`，`models.py` 的 `Literal` 加新类型，`compute_cell_status()` 加 match 分支。

#### 新增一条 audit 分析规则（如检测梯度异常）

`models.py` 新增 `GradientNormEvent(EventBase)` 事件类型加入 discriminated union；训练代码中调 `get_event_logger().log(GradientNormEvent, {...})`；`event_analyzer/rules/` 新增 `gradient_anomaly.py` 实现 `check(events) -> list[Issue]`；`analyzer.py:run_analysis()` 注册新规则。
