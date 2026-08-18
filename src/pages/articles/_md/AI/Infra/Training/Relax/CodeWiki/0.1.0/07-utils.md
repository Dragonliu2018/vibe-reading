---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "共享数据类型"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "Sample", "Envs", "metrics", "autoscaler", "health", "streaming"]
description: "解读 Relax 共享基础设施：Sample 核心数据结构（god node #1，177 边）、Envs 环境变量单例、MetricsService 多后端适配、HealthManager 自动恢复、AutoscalerService 弹性扩缩容决策引擎。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/utils/`（32,596 行，93 文件）是全框架的共享基石——被所有模块高频 import（`get_logger` 95 次、`Envs` 28 次、`Sample` 18 次，扇入最高）。它承载框架最核心的数据结构 `Sample`（god node #1，177 边）、配置系统 `Envs`、以及 metrics/autoscaler/health_system 三个生产运维子系统。虽然目录名是 "utils"，但它不只是工具函数集合——`Sample` 是贯穿 RL 全链路的数据契约，`HealthManager` 驱动全局重启，`AutoscalerService` 做弹性扩缩容决策，都是核心领域逻辑。本模块聚焦数据契约与运维子系统，纯工具函数（logging/http/device 等）不展开。

## 模块架构

utils 内部按职责分多个子目录：`types.py`（核心数据结构）、`env.py`/`arguments.py`（配置）、`metrics/`（MetricsService + adapters）、`autoscaler/`（AutoscalerService + ScalingDecisionEngine）、`health_system.py`（HealthManager + HealthChecker）、`data/`（StreamingDataLoader）、`multimodal/`（图/视频/音频）、`opd/`（蒸馏管理）、`training/ppo_utils.py`（loss 计算）。三个运维子系统（metrics/autoscaler/health）各自独立但逻辑互补：Autoscaler 从引擎拉指标做扩缩容决策，Metrics 收集训练 metric 分发后端，Health 监控心跳触发重启。

```
utils/
├── types.py                Sample（god #1, 177 边）+ RolloutBatch + SFTBatch
├── env.py (296)            Envs 单例 + EnvProperty 描述符（god 79 边）
├── arguments.py (3584)     parse_args 三阶段解析
├── health_system.py        HealthManager + HealthChecker + HealthStatus（god 16 边）
├── metrics/
│   ├── service.py          MetricsService（Ray Serve，多 adapter 分发）
│   └── adapters/           _TensorboardAdapter / _ClearMLAdapter / _AppriseAdapter
├── autoscaler/
│   ├── autoscaler_service.py   AutoscalerService（Ray Serve）
│   ├── scaling_decision.py     ScalingDecisionEngine（决策引擎）
│   ├── monitor.py (957)        MetricsCollector（引擎指标拉取）
│   └── config.py               AutoscalerConfig
├── data/
│   ├── stream_dataloader.py (1501)  get_data_from_transfer_queue
│   └── streaming_dataset.py (1087)  StreamingDataset + PrefetchBuffer
├── multimodal/             图/视频/音频处理
├── opd/opd_utils.py (1527) On-Policy Distillation 管理
├── training/ppo_utils.py (1248)  compute_ppo_loss / gspo / cispo
└── visualize/ templates.py (2573) 训练可视化模板
```

## 调用链路

Sample 在一次 RL step 中的生命周期（字段流转）：

```
[Phase 1 创建]  data_source.get_samples() / build_sample()           # data_utils.py:430
                  → Sample(prompt, multimodal_inputs, group_index, index)
[Phase 2 rollout 填充]  generate()                                    # sglang_rollout.py
                  → sample.tokens = prompt_ids + response_tokens
                  → sample.rollout_log_probs = output.logprobs
                  → sample.update_from_meta_info(meta_info)           # status/spec/prefix_cache/weight_version
                  → sample.reward = await async_rm(args, sample)
[Phase 3 转换]  convert_samples_to_train_data(args, samples)          # utils/utils.py:95
                  → post_process_rewards（group normalization）
                  → RolloutBatch dict {tokens, response_lengths, loss_masks, rewards,
                                        rollout_log_probs, ...} → TensorDict
                  → transfer_batch_to_data_system（TQ PUT）
[Phase 4 训练]  get_data_from_transfer_queue()                        # data/stream_dataloader.py:614
                  → build_data_fields(consumer="actor")               # training/data_fields.py:23
                  → tq_client.async_get_meta → async_get_data
                  → compute_ppo_loss（full_log_probs vs old_log_probs + advantages）  # ppo_utils.py:145
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Sample.update_from_meta_info` | 从 rollout meta_info 更新状态 | 填 status/spec_info/prefix_cache_info/weight_versions |
| `Sample.get_reward_value` | 多 reward key 选择 | `reward if not args.reward_key else reward[args.reward_key]` |
| `Sample.to_dict/from_dict` | 序列化跨进程传输 | `__dict__.copy()` + field_names 过滤，新字段自动支持 |
| `convert_samples_to_train_data` | Sample→RolloutBatch | post_process_rewards + 条件填充 OPD/MoE 字段 |
| `Envs.<X>` | 读环境变量 | EnvProperty 惰性实时读 os.environ，每次访问 resolve |
| `validate_env` | 启动校验环境变量 | 解析失败 raise，未注册 RELAX_* 变量 warning/error |
| `HealthChecker._check_loop` | 心跳监控 | 120s 超时触发 on_unhealthy，fatal 跳 restart 直接 exit |
| `ScalingDecisionEngine.evaluate` | 扩缩容决策 | scale-out ANY / scale-in ALL + debounce + cooldown |
| `MetricsService.report_step` | metric 分发 | 遍历 adapters 调 .log(data, step) |

</details>

## 核心实现

### Sample：胖数据类贯穿全链路

`Sample`（`types.py:9`，`@dataclass`，40+ 字段）是框架最核心数据结构，177 边来自被 rollout 引擎/数据转换/训练/OPD/metrics/agentic/data 全链路 import。字段按功能分组：标识（`group_index`/`index`）、Prompt 侧（`prompt`/`tokens`/`rollout_tokens`/`multimodal_inputs`/`multimodal_train_inputs`）、Response 侧（`response`/`response_length`/`reward`/`loss_mask`/`rollout_log_probs`/`rollout_routed_experts`/`weight_versions`）、OPD 蒸馏（`teacher_log_probs`/`student_topk_*`/`opd_topk_*` ~10 字段）、Teacher 模态、状态机（`Status` enum：PENDING/COMPLETED/TRUNCATED/ABORTED/FAILED）、元数据（`metadata`/`session_id`/`train_metadata`）、嵌套 dataclass（`SpecInfo`/`PrefixCacheInfo`）。

```python title="relax/utils/types.py:9（Sample 字段节选）"
@dataclass
class Sample:
    group_index: int | None = None       # 同 prompt 的 N response 共享
    index: int | None = None
    prompt: str | list[dict] = ""
    tokens: list[int] = field(default_factory=list)          # prompt + response 全量
    rollout_tokens: list[int] = field(default_factory=list)  # 仅 rollout 引擎所见
    multimodal_inputs: dict | None = None        # 原始多模态
    multimodal_train_inputs: dict | None = None  # 处理后张量
    response: str = ""
    reward: float | dict | None = None           # 标量或 dict（多 reward key）
    loss_mask: list[int] | None = None           # 1=参与 loss, 0=不参与
    rollout_log_probs: list[float] | None = None
    weight_versions: list[str] = field(default_factory=list)
    status: Status = Status.PENDING
    # ... OPD/Teacher/元数据字段
```

**为什么是 god node**：Sample 选择「胖数据类」而非「瘦接口+多子类」，因为 RL pipeline 是线性流水线，同一条样本需在不同阶段间传递且每阶段添加不同字段。拆成 `RolloutSample`/`TrainSample`/`RewardSample` 子类，转换开销与字段重复反而增加复杂度。代价是 40+ 字段，部分在非 OPD/非多模态场景始终为 None。`from_dict` 用 `field_names = set(Sample.__dataclass_fields__.keys())` 自动包含新字段，**新增字段通常无需改序列化逻辑**。

`CanonicalSample`（`engine/sft/dataset/sample.py:30`）是 SFT 专用规范化结构（非 Sample 子类），通过 `CanonicalMessage(role, content, learn, tool_calls)` 把不同数据源统一为标准对话格式，是反腐败层——让 `chat_template.py`/`multimodal.py` 只处理 `CanonicalSample` 不关心数据源格式。

### Envs：环境变量单例

`Envs`（`env.py:160`）是类级单例（非实例化），通过 `EnvProperty` 描述符（`:92`）实现惰性读取——`__get__` 每次访问都 `resolve()` → `parse(os.environ.get(env))`，因为某些变量运行时才设置（`LOCAL_RANK` 由 Ray 设，`RELAX_OPD_TOKEN_IDS_LOGPROB_K` 由 sglang_engine 设）。`_EnvsMeta` 元类（`:142`）`__setattr__` 禁止 `Envs.X = value` 防意外覆盖。`validate_env`（`:339`）启动时检查所有已声明变量可解析性 + 未注册 `RELAX_*` 变量，`_parse_bool` 拒绝模糊值（如 `ture`）。选环境变量而非 YAML：Relax 跑在 SLURM/Ray 分布式环境，env var 天然跨进程传播（Ray worker 继承 driver env），SLURM 脚本/Docker entrypoint 习惯用 env var，配置文件需额外分发。

### HealthManager：健康检查与自动恢复

`HealthManager`（`health_system.py:335`）三层组合：`HealthStatus`（Ray remote actor，`:37`，线程安全存储各角色 `ServiceHealthState`）、`HealthChecker`（daemon thread，`:209`，`_check_loop` 每秒检查 unhealthy 与 120s stale heartbeat）、`HealthManager`（`:335`，组合层为 Controller 提供单一接口）。`on_unhealthy` 回调触发 `Controller.restart_serve`，`on_fatal` 跳过 restart 阶梯直接 `os._exit(1)`——确定性错误（如 SFT 数据 schema 不匹配）不会因 restart 恢复，跳过 ~12 次 in-place + 4 次 global restart 阶梯直接退出。`restart_count`（`:194`）跟踪每角色 restart 次数供 Controller 判断上限。

### MetricsService 与 AutoscalerService

`MetricsService`（`metrics/service.py:100`，Ray Serve deployment @ `/metrics`）持 `self._adapters` dict，按 config 动态初始化 `_TensorboardAdapter`/`_ClearMLAdapter`/`_AppriseAdapter`，W&B 直接内联（`_init_wandb`）。`report_step`（`:252`）遍历 adapters 调 `.log(data, step)`，统一接口。adapter 用 `SingletonMeta` 确保多 rank 单实例。`/log_error` 端点供 Controller `_report_error_to_metrics_service` 推错误触发 Apprise 通知。

`AutoscalerService`（`autoscaler/autoscaler_service.py:178`，Ray Serve @ `/autoscaler`）组合 `MetricsCollector`（从 SGLang 引擎 HTTP 拉指标）+ `ScalingDecisionEngine`（`scaling_decision.py:94`）+ `AutoscalerState`。`ScalingDecisionEngine.evaluate`（`:148`）按 cooldown → pending → scale-out(ANY) → scale-in(ALL) 顺序评估，返回 `ScalingDecision`。**不对称策略**：扩容 ANY 条件触发（token_usage_high/queue_backlog/queue_latency_high/ttft_high，延迟紧急），缩容 ALL 满足（token_usage_low+no_queue+throughput_stable，OOM 灾难性）。Debounce（条件须持续 `condition_duration_secs`）、Cooldown（操作后等待）、Conservative scale-in（每次只缩 1 引擎 + projected usage 检查）、Coverage 检查（防部分引擎不可达误判）。决策后 HTTP POST 到 Rollout `/scale_out`/`/scale_in`。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 数据类（胖数据载体） | `Sample` in `types.py:9` | 线性 pipeline 同样本跨阶段传递+增量填充，避免多子类转换 |
| 描述符 + 元类单例 | `EnvProperty` + `_EnvsMeta` + `Envs` in `env.py:92,142,160` | 惰性实时读取 + 只读绑定 + 启动校验 |
| 适配器（metrics 多后端） | `MetricsService` + `_TensorboardAdapter`/`_ClearMLAdapter` in `metrics/service.py:100` | 统一 `log(data, step)` 接口适配异构后端 |
| 观察者（健康检查） | `HealthManager` + `HealthChecker` in `health_system.py:335,209` | 心跳超时回调 restart，fatal 直接 exit |
| 决策引擎（扩缩容） | `ScalingDecisionEngine.evaluate` in `autoscaler/scaling_decision.py:148` | 决策与执行解耦，不对称策略 + debounce + cooldown |
| 反腐败层 | `CanonicalSample` in `engine/sft/dataset/sample.py:30` | 统一 SFT 数据源格式，下游不关心数据源 |

## 模块间交互

utils 被几乎所有模块 import（最高扇入）。内部 metrics/autoscaler/health 三角协作：Autoscaler 从引擎拉指标做决策 → HTTP POST 到 Rollout 扩缩容；Metrics 收训练 metric 分发后端；Health 监控心跳触发重启。三者不直接互调但逻辑互补（Autoscaler 的引擎指标与 Metrics 的训练指标互补）。`StreamingDataLoader`（`data/stream_dataloader.py:614`）封装 TransferQueue GET + broadcast 到 TP/PP 各 rank，被 `MegatronTrainRayActor._get_data_from_transfer_queue` 调用。`ppo_utils`（`training/ppo_utils.py:145`）的 `compute_ppo_loss` 支持 PPO/GSPO（温度软门控）/CISPO（非对称 clipping）/OPSM（advantage<0 且 KL>delta 时 mask）。详见概览「模块地图」。

## 扩展方式

- **新增 Sample 字段**：`types.py` Sample dataclass 加字段（`from_dict` 的 `field_names` 自动包含，通常无需改序列化）；填充模块加赋值；消费模块加读取
- **新增 Metrics 后端**：`metrics/adapters/` 新建 adapter 类实现 `log(data, step)`（可继承 SingletonMeta）；`metrics/service.py:108-154` `__init__` 加 `if config.use_X: self._adapters["x"] = _XAdapter(config)`；`arguments.py` 加 `--use-X` 参数
- **新增环境变量**：`env.py` Envs 类加 `X = EnvProperty("X", type, default)`；`RELAX_` 前缀变量声明后 `validate_env` 自动合法化
