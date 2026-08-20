---
source:
  type: "源码解读"
  project: "miles"
  url: "https://github.com/radixark/miles"
title: "共享基础"
date: "2026-08-20T00:17:42+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "Miles", "CodeWiki", "0.1.0"]
tags: ["Miles", "Data Contract", "Sample", "TITO", "R3", "Utils"]
description: "Sample 数据契约约束 rollout↔train 边界，load_function 插件加载，HTTP 分布式 POST，TITO/R3 数据结构。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/Miles/CodeWiki/0.1.0/00-overview)

---

## 模块定位

这是被全仓库复用的基础层。核心是 `miles/utils/types.py` 的 `Sample`——全链路唯一数据契约，约束 rollout 产出与 train 消费的边界。`misc.py` 的 `load_function` 是框架可扩展性的基石（reward/rollout/agent 函数都经 dotted path 加载）。`http_utils` 的分布式 POST 支持 fully-async 多 engine 并发。

## 核心实现

### Sample — 全链路数据契约

`Sample`（`types.py:25`）是贯穿 rollout 生成到 train 消费的核心数据类型，被全仓库 80+ 处直接 import：

```python title="miles/utils/types.py (Sample 核心字段)"
@dataclass
class Sample:
    group_index: int | None = None
    prompt: str | list[dict[str, str]] = ""
    tokens: list[int] = field(default_factory=list)          # TITO: 已生成 token 序列
    response: str = ""
    response_length: int = 0
    reward: float | dict[str, Any] | None = None
    loss_mask: list[int] | None = None
    rollout_log_probs: list[float] | None = None
    rollout_routed_experts: numpy.ndarray | None = None      # R3: MoE routing
    rollout_indexer_topk: numpy.ndarray | None = None        # indexer topk
    teacher_log_probs: list[float] | None = None             # OPD
    adapter: AdapterRef | None = None                        # Multi-LoRA 路由
    reward_spec: RewardSpec | None = None                    # per-sample reward 分派
    status: Status = Status.PENDING
    weight_versions: list[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
```

关键方法：`validate()`（校验 per-token 字段长度一致性，fail-fast）、`strip_last_output_tokens(n, tokenizer)`（多轮截断）、`reset_for_retry()`（重置输出保留 prompt/identity）、`to_dict()`/`from_dict()`（序列化支持未知字段透传）。内嵌 `Status` 枚举（PENDING/COMPLETED/TRUNCATED/ABORTED/FAILED）、`SpecInfo`（speculative decoding 统计）、`PrefixCacheInfo`。

### RolloutBatch 与数据转换边界

`RolloutBatch = dict[str, list[torch.Tensor] | list[int] | list[float] | list[str]]`（`types.py:313`）是 type alias 而非 class——train 侧需灵活按 key 读取可选字段，dict 形式让 rollout 按需添加字段、train 按需消费，向后兼容。`ROLLOUT_DATA_VALUE_SPEC`（`train_data_conversion.py:26`）为每个字段声明 codec（`typed_ragged`/`ndarray`/`msgpack_ragged`）和 dtype，作为文档化的字段 schema 弥补 type alias 的弱类型。

数据流转链路：

```
Sample(prompt, label) → generate → Sample(tokens, response, reward, rollout_log_probs, routed_experts)
  → convert_samples_to_train_data() → dict{tokens, rewards, loss_masks, ...}
    → split_train_data_by_dp() → list[ObjectRef] (per-DP shards)
      → get_rollout_data() → RolloutBatch (dict with GPU tensors)
```

### ParamInfo — 权重同步参数元数据

```python title="miles/utils/types.py (ParamInfo)"
@dataclass(frozen=True)
class ParamInfo:
    name: str
    dtype: torch.dtype
    shape: torch.Size
    attrs: dict
    size: int
    src_rank: int
```

`AdapterRef`（frozen，Multi-LoRA 样本到 adapter 绑定）和 `RewardSpec`（frozen，per-sample reward 分派规格）都是 frozen dataclass，作为样本的不可变路由/标识信息。

### load_function — 插件加载基石

```python title="miles/utils/misc.py (load_function)"
def load_function(path: str):
    fn = _registry.lookup(path)           # 先查 FunctionRegistry（测试用）
    if fn is not None:
        return fn
    module_path, func_name = path.rsplit(".", 1)
    module = importlib.import_module(module_path)  # fallback importlib
    return getattr(module, func_name)
```

这是全框架的插件机制——reward function（`--custom-rm-path`）、rollout function（`--rollout-function-path`）、agent function（`--custom-agent-function-path`）、generate function（`--custom-generate-function-path`）都经 dotted path 加载。`FunctionRegistry` 支持 `temporary()` context manager（测试场景注册临时函数）。

### http_utils 分布式 POST

当 rollout engine 数量多时，单进程 HTTP client 成瓶颈（GIL + 连接池）。`init_http_client`（`http_utils.py:274`）在 `use_distributed_post` 时创建 Ray actor `_HttpPosterActor`，用 `NodeAffinitySchedulingStrategy` 放到不同节点 round-robin 分派 POST 请求——对 fully-async 多 engine 并发生成尤为关键。

### TITO 与 R3 的数据结构支撑

TITO 不直接操作 `Sample`，而是由 session 层调用 `TITOTokenizer` 的增量 tokenize 逻辑，结果写入 `Sample.tokens`。TITO 依赖：`Sample.tokens`（pretokenized prefix）、`TITOTokenizer.merge_tokens()`（`tito_tokenizer.py:81`，合并 prefix + 增量）、`FixedTemplate` dataclass（定义模型族固定 chat template）、`TokenSeqComparator`（验证增量与全量 tokenize 一致性）。

R3 依赖 `Sample.rollout_routed_experts`（`(num_tokens, num_layers, topk)` numpy 数组）和 `BaseReplayManager`（`replay_base.py:53`，monkey-patch MoE router `get_topk_fn`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Dataclass + 手动 validate | `Sample.validate()` in `types.py:184` | Sample 频繁修改含 numpy/tensor，pydantic 验证开销大，dataclass 零开销 + 关键节点一次性校验 |
| Frozen dataclass | `AdapterRef`/`RewardSpec`/`ParamInfo` | 不可变标识，防流转中被意外修改 |
| Pydantic 严格模式 | `StrictBaseModel` in `pydantic_utils.py` | 仅控制平面（ft_utils/control_server API），数据平面不需要运行时验证开销 |
| Singleton | `SingletonMeta` in `misc.py:97` | Timer/SGLangRollout 复用，`clear_all_instances()` 测试隔离 |
| ValueSpec codec | `ROLLOUT_DATA_VALUE_SPEC` | 声明式序列化，object_store 按此高效编码 |

### 为什么用独立 types.py 而非各模块自定义

RL 的 rollout 和 train 是物理分离的进程（甚至不同节点），中间经 object store 传输。各模块自定义数据结构会导致 rollout 改字段 train 不知道、序列化不匹配。`types.py` 作为唯一数据契约使边界有编译时可见的 type definition，`Sample.validate()` 在数据离开 rollout 前就校验长度一致性，fail-fast。

### 为什么 Sample 用 dataclass 而非 pydantic

Sample 在 rollout 过程中被频繁修改（`update_from_meta_info`/`strip_last_output_tokens`/`reset_for_retry`），且含 `numpy.ndarray`/`torch.Tensor` 非 pydantic 原生类型。pydantic 每次字段修改触发验证，RL rollout 每步生成数十到数百个 Sample 性能敏感。dataclass + 手动 validate 允许关键节点一次性校验，平时零开销。对比 `StrictBaseModel` 仅用于控制平面（外部 HTTP 请求需严格校验防注入）。

## 模块间交互

`types.py` 的 `Sample` 被 `miles/rollout/`（所有 generate 函数产出）、`miles/ray/rollout/`（train_data_conversion/rollout_data_conversion）、`miles/backends/`（megatron_utils/actor、training_utils/data/loss）、`miles/dashboard/`（dump_reader）、30+ 测试文件 import。`misc.load_function` 被 `arguments.py`、`megatron_utils/actor.py`、`rollout/data_source.py` 等 20+ 处使用。`http_utils.post`/`get` 被 rollout engine HTTP 通信（single_turn/multi_turn/sglang_rollout）使用。
