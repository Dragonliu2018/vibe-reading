---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "启动与配置"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "RL", "Launch", "typer", "true_on_policy"]
description: "Miles launch script 如何把 recipe 编译为 Ray job，true_on_policy 契约如何保证推理与训练数值一致。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

这一层是用户与 Miles 训练内核之间的边界。它的职责是把一个 launch script（recipe）编译成一条 `ray job submit` 命令——包括拼装 8+ 组 argument groups、校验 four-knob invariant、构建 true-on-policy 契约保证数值一致性。它不参与训练循环本身，Ray job 提交后控制权即交给 `train.py`。

核心边界：launch script 只管"配置编译"，不展开内部调用链（那是运行时行为的事）。

## 调用链路

从 launch script 到 Ray job 提交的完整调用链：

```
scripts/run_qwen3_4b.py: main(args)
├── prepare(args)                                   # 下载模型/数据集/转换 checkpoint
│   ├── U.hf_download_dataset("zhuzilin/dapo-math-17k", ...)
│   └── U.convert_checkpoint(...)                   # HF→torch_dist（仅 megatron 后端）
│       └── exec_command_gpu("torchrun .../convert_hf_to_torch_dist.py")
└── execute(args)                                   # 拼装 argument groups + 提交
    ├── [1] 拼 8+ argument groups（f-string blocks）:
    │   ckpt_args / rollout_args / grpo_args / optimizer_args /
    │   sglang_args / train_backend_args / perf_args / misc_args /
    │   true_on_policy_args
    ├── [2] build_true_on_policy_launch_plan(args).train_args   # true_on_policy/config.py:264
    └── [3] U.execute_train(train_args, config, ...)            # command_utils.py:229
        ├── pkill 残留进程 / ray start --head
        ├── shell_safe_model_args(megatron_model_type)          # 从 scripts/models/*.py 加载架构常量
        └── ray job submit -- python3 train.py {model_args} {train_args}
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `execute()` in `scripts/run_qwen3_4b.py` | 拼装 argument groups 并调 execute_train | f-string block 拼装，recipe 即代码 |
| `execute_train()` in `command_utils.py:229` | 唯一提交 Ray job 的函数 | 进程清理 + runtime env 构建 + ray job submit |
| `build_true_on_policy_launch_plan()` in `config.py:264` | 构建 true-on-policy 启动契约 | Builder 模式，validate→kernel_policy→launch_plan |
| `apply_true_on_policy_script_defaults()` in `config.py:271` | 在 `__post_init__` 注入 true-on-policy 默认值 | recipe 推导阶段介入 |
| `parse_args()` in `arguments.py` | Ray job 内解析参数 | 此处校验 four-knob invariant |
| `shell_safe_model_args()` in `model_args_utils.py` | 从 scripts/models/ 加载 Megatron 架构常量 | 架构常量与 recipe 解耦 |

</details>

## 核心实现

### argument groups 拼装机制

在 `execute()` 中，每个 argument group 是一个 f-string 字符串变量，最终拼接为单一 `train_args` 字符串：

```python title="scripts/run_qwen3_4b.py (execute 拼装)"
train_args = (
    f"{ckpt_args} {rollout_args} {optimizer_args} {grpo_args} "
    f"{U.get_default_wandb_args(__file__, run_id=args.run_id)} "
    f"{perf_args} {eval_args} {ci_args} {sglang_args} "
    f"{train_backend_args} {misc_args} {true_on_policy_args} "
    f"{args.extra_args} "
)
```

Megatron 架构常量不在 `train_args` 中——它们在 `execute_train()` 内部通过 `shell_safe_model_args(megatron_model_type)` 从 `scripts/models/<type>.py` 动态加载，拼到 `train.py` 命令行前方。这样同一模型族的不同 recipe 共享架构常量文件，variant 模型可经 `load_sibling_model_args()` 继承。

### four-knob invariant 校验

four-knob invariant（`rollout_batch_size × n_samples_per_prompt = global_batch_size × num_steps_per_rollout`）在 `miles/utils/arguments.py:3431-3439` 校验——设三个推第四个，若用户显式设四个且不一致则 assert 失败：

```python title="miles/utils/arguments.py (4-knob 校验)"
if args.num_steps_per_rollout is not None:
    global_batch_size = args.rollout_batch_size * args.n_samples_per_prompt // args.num_steps_per_rollout
    if args.global_batch_size is not None:
        assert args.global_batch_size == global_batch_size, "..."
    args.global_batch_size = global_batch_size
```

这是 launch 层与 training 层的交接点：launch script 设四个 knob 中的三个，`arguments.py` 推第四个，`train.py` 在 Ray job 内接管。

### true_on_policy 契约机制

true-on-policy 解决的核心问题是：**rollout（SGLang 推理）和 training（Megatron/FSDP 训练）使用不同的 kernel 实现，若两者计算 logprob 的数值路径不一致，RL 的 advantage 估计就有偏差——模型学到的不是真正的 on-policy gradient。**

契约机制通过声明式契约 + 运行时 kernel policy 保证一致性：

```python title="miles/true_on_policy/schema.py (声明式契约)"
@dataclass(frozen=True)
class TrueOnPolicyContractSchema:
    name: TrueOnPolicyContractName               # "qwen3_dense_true_on_policy_v1"
    model_family: ModelFamily                     # "qwen3_dense" / "qwen3_moe" / ...
    required_kernel_contracts: tuple[KernelContract, ...]
    logprob_contract: LogprobContract             # "sglang_prefill"
    sglang_attention_backend: str                 # "fa3"
    fsdp_attention_implementation: str            # "flash_attention_3"
    disable_megatron_sequence_parallel: bool
```

`TrueOnPolicyConfig.build_launch_plan()`（`config.py:204`）用 Builder 模式分三步构建 `TrueOnPolicyLaunchPlan`：`validate()`（校验 model_profile × layout 兼容性）→ `build_kernel_policy()`（推导 `disable_rope_fusion`/`batch_invariant_mode`/`deterministic_tp_allreduce` 等开关）→ 组装 sglang_args/megatron_args/env_vars。`build_env_vars()` 设置 `NVTE_ALLOW_NONDETERMINISTIC_ALGO=0` 和 `CUBLAS_WORKSPACE_CONFIG=:4096:8`，从环境层面禁止非确定性算法。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Template Method | `prepare()`/`execute()` in `scripts/run_*.py` | launch script 固定两段式骨架，recipe 只填内容不改结构 |
| Builder | `TrueOnPolicyConfig.build_launch_plan()` in `config.py:204` | 分步构建跨仓库启动契约（sglang+megatron+fsdp+miles+env） |
| Registry | `_CONTRACT_BY_NAME` / `_PROFILE_BY_MODEL_NAME` in `contracts.py:75` | name→contract/profile 查找，新增模型族只加条目 |
| Config dataclass + CLI 桥接 | `@dataclass_cli` in `miles/utils/typer_utils.py:25` | dataclass 字段自动转 CLI flag + `MILES_SCRIPT_*` env var，三级覆盖优先级 |

### 为什么用 typer + dataclass 而非 yaml

三个原因：CLI/env var 三级覆盖优先级（集群工具链经 env var 注入机器特定值而无需改脚本）；类型安全（`Literal["fsdp","megatron"]` 静态检查）；recipe 即代码（派生逻辑如"Qwen3-0.6B 用 TP=1"直接写在 `__post_init__` 里，而非散落 yaml defaults 层级）。

## 扩展方式

#### 新增一个模型 recipe

1. `scripts/models/<type>.py`：定义 `def model_args(**kwargs) -> str`，返回 `--num-layers 36 --hidden-size 4096 ...`
2. `scripts/run_<model>.py`：`ScriptArgs` 设 `model_name` 默认值，`__post_init__` 加 TP/PP/CP 派生逻辑，`execute()` 调 `rollout_args`/`grpo_args`
3. `miles/true_on_policy/model_profiles.py`：在 `QWEN3_DENSE_PROFILE.model_names` 加 `"<Model>": "<type>"` 映射

#### 改 true_on_policy 契约（新增 MoE 支持）

1. `schema.py`：新增 `QWEN3_MOE_TRUE_ON_POLICY_V1_SCHEMA` 声明 kernel contracts
2. `contracts.py`：实例化并加入 `_CONTRACT_BY_NAME` registry
3. `model_profiles.py`：新建 `QWEN3_MOE_PROFILE`，设 `supported_train_layouts`
4. `config.py:validate()`：可能需加 MoE 特定校验（expert parallel 兼容性）
