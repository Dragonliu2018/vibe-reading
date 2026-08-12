---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "检查点"
date: "2026-08-12T15:35:32+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "Checkpoint", "Universal Checkpoint", "3D 并行", "持久化"]
description: "DeepSpeed 检查点模块负责 ZeRO 分片持久化与 3D 并行协调，通过 Universal 格式解耦训练与加载拓扑，支持子进程异步保存、Megatron 格式 merge/split 及 AutoTP/AutoEP 元数据驱动的参数分片加载。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

检查点模块负责将训练状态持久化到存储并在恢复训练时正确加载——这在动辄千亿参数、数百卡并行的大模型训练中绝非"torch.save 换个路径"那么简单。核心挑战是：**ZeRO 分片后每个 rank 只持有优化器状态和参数的 1/N，而恢复训练时的并行拓扑可能与保存时不同**（TP 度变了、PP 度变了、DP 度变了），检查点必须在这种拓扑变化下正确重组分片数据。

模块分布在三个目录：`checkpoint/`（格式读取与转换）、`runtime/checkpoint_engine/`（I/O 策略）、`runtime/model_checkpointing/`（写入器配置）。引擎层的 `save_checkpoint`/`load_checkpoint`（`engine.py` L4692/L4214）是统一入口，委托给 `CheckpointEngine` 完成实际 I/O，委托给 `SDLoaderFactory`/`DeepSpeedCheckpoint` 完成格式转换。

检查点模块独立存在的根本原因：**持久化逻辑与训练循环解耦**。训练循环关心的是 forward/backward/step，而持久化关心的是文件命名、分片重组、拓扑映射、异步 I/O——这两者的复杂度各自独立，混在一起会让引擎变得不可维护。更重要的是，Universal 格式的引入使得"用 8 卡训练的检查点在 64 卡上恢复"成为可能，这需要一套完全独立的参数重组逻辑。

## 调用链路

### 保存流程

```
engine.save_checkpoint(save_dir, tag)                         engine.py L4692
├── optimizer.checkpoint_event_prologue()                      ← ZeRO-3 预分片
├── checkpoint_engine.create(CheckpointCommitInfo)             ← 通知引擎准备
├── _checkpoint_tag_validation(tag)                            ← 跨 rank 一致性检查
│
├── [非 MoE] _save_checkpoint(save_dir, tag)                   engine.py L5175
│   ├── self._curr_ckpt_path = save_dir/tag                   ← Pipeline hack
│   ├── module_state_dict()                                    ← Pipeline 覆写为 layer 级保存
│   ├── self._curr_ckpt_path = None
│   ├── state = _common_checkpoint_state(module, ...)
│   └── checkpoint_engine.save(state_dict=state, path=save_path)
│
├── [MoE] _save_moe_checkpoint(save_dir, tag)                  ← MoE 专用路径
│
├── [ZeRO] _save_zero_checkpoint(save_path, tag)               engine.py L5345
│   ├── zero_sd = {optimizer_state_dict, ds_config, ds_version}
│   └── checkpoint_engine.save(zero_sd, zero_checkpoint_name)
│
├── optimizer.checkpoint_event_epilogue()                      ← ZeRO-3 后处理
└── checkpoint_engine.commit(CheckpointCommitInfo)             ← 通知引擎完成
    └── [非 decoupled] write 'latest' file
```

### 加载流程

```
engine.load_checkpoint(load_dir, tag)                         engine.py L4214
├── tag is None? → read 'latest' or 'latest_universal' file
├── optimizer.checkpoint_event_prologue()                      ← 确保参数已分片
│
├── _load_checkpoint(load_dir, tag)                            ← 模型状态加载
│   ├── SDLoaderFactory.get_sd_loader(ckpt_list, ...)          state_dict_factory.py L41
│   │   └── MegatronSDLoader(ckpt_list, version, engine)
│   ├── loader.load(mp_world_size, mp_rank)                    ← merge/split 分发
│   │   ├── num_ckpt == mp_world_size → direct load
│   │   ├── num_ckpt >  mp_world_size → merge_state_dict()    ← 合并多余分片
│   │   └── num_ckpt <  mp_world_size → split_state_dict()    ← 拆分到更多 rank
│   └── module.load_state_dict(sd)
│
├── [ZeRO] _load_zero_checkpoint(load_dir, tag)                engine.py L4555
│   ├── [Universal] checkpoint_folder = join(load_dir, tag)
│   │   └── zero_sd_list = None                               ← 逐参数加载
│   ├── [非 Universal] zero_sd_list = _get_all_zero_checkpoints()
│   └── optimizer.load_state_dict(zero_sd_list, checkpoint_folder, ...)
│       └── [Universal] param.load_hp_checkpoint_state(folder, tp_rank, ...)
│
├── optimizer.checkpoint_event_epilogue()
└── return (load_path, client_states)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `save_checkpoint` in `engine.py` L4692 | 保存入口 | MoE/非 MoE 分流，ZeRO 独立保存 |
| `_save_checkpoint` in `engine.py` L5175 | 保存模型状态 | `_curr_ckpt_path` hack 供 Pipeline 接管 |
| `_save_zero_checkpoint` in `engine.py` L5345 | 保存 ZeRO 优化器状态 | 独立文件 `zero_pp_rank_*_optim_states.pt` |
| `load_checkpoint` in `engine.py` L4214 | 加载入口 | Universal 时读 `latest_universal` |
| `_load_zero_checkpoint` in `engine.py` L4555 | 加载 ZeRO 状态 | Universal 与原生格式分支 |
| `SDLoaderFactory.get_sd_loader` in `state_dict_factory.py` L41 | 创建 state dict 加载器 | 工厂方法，目前仅支持 Megatron 类型 |
| `MegatronSDLoader.load` in `state_dict_factory.py` L57 | merge/split 分发 | 按检查点数与当前并行度的比例自动判断 |
| `DeepSpeedCheckpoint.__init__` in `deepspeed_checkpoint.py` L45 | 3D reshape 管理 | old_2d_map → new_2d_map 拓扑映射 |
| `ZeROCheckpoint.get_state_for_rank` in `zero_checkpoint.py` L53 | 读取并合并 ZeRO 分片 | 多文件 merge_state |
| `enable_universal_checkpoint` in `universal_checkpoint.py` L238 | 启用 Universal 加载 | monkey-patch 绑定方法到 param |
| `load_hp_checkpoint_state` in `universal_checkpoint.py` L99 | 逐参数从 Universal 加载 | 处理 TP/EP 分片、vocab padding、AutoTP |
| `main` in `ds_to_universal.py` L893 | DS→Universal 转换器 | ZeRO-1/2 与 Stage 3 分支 |
| `create_checkpoint_engine` in `checkpoint_engine/utils.py` L15 | 引擎工厂 | 按 config 优先级选择 5 种引擎 |
| `DecoupledCheckpointEngine.save` in `decoupled_checkpoint_engine.py` L157 | 非阻塞保存 | 投递到 mp.SimpleQueue，子进程执行 |
| `DecoupledCheckpointEngine.commit` in `decoupled_checkpoint_engine.py` L168 | 等待子进程完成 | 带超时和健康检查 |

</details>

## 核心实现

### DeepSpeedCheckpoint 与 3D reshape

`DeepSpeedCheckpoint` 是 ZeRO 分片检查点的读取器 + 3D 并行 reshape 管理器。它扫描检查点目录，发现原始的 PP/TP/DP 拓扑，构建源映射和目标映射，在拓扑变化时重组分片文件归属。

#### 两类检查点文件

检查点目录下有两类文件，由 `constants.py` 中的前缀常量定义：

```python title="checkpoint/constants.py L39-43"
MODEL_FILE_PREFIX = 'mp_rank_'            # 模型状态文件
ZERO_FILE_PREFIX = 'zero_pp_rank_'        # ZeRO 优化器状态文件
OPTIM_FILE_SUFFIX = '_optim_states.pt'
MODEL_FILE_SUFFIX = '_model_states.pt'
LAYER_FILE_PREFIX = 'layer_'              # Pipeline 层级文件
```

非 ZeRO 模式下，每个 rank 的模型状态存储为 `mp_rank_{XX}_{YYY}/model_optim_rng.pt`（PP 度 > 1 时 YYY 为 PP 索引）。ZeRO 模式下，优化器状态独立存储为 `zero_pp_rank_{DP}_mp_rank_{TP:02d}_optim_states.pt`——文件名直接编码了 DP rank 和 TP rank，使得 `ZeROCheckpoint` 可以从文件名反推 3D 拓扑。

#### old_2d_map / new_2d_map 拓扑映射

`DeepSpeedCheckpoint.__init__` 的核心是构建两个 2D 映射——`old_2d_map` 表示检查点保存时的 PP×TP 布局，`new_2d_map` 表示目标（当前训练）的 PP×TP 布局：

```python title="checkpoint/deepspeed_checkpoint.py L77-86"
self.old_2d_map = meg_2d_parallel_map(self.zero_checkpoint.get_src_pp_degree(),
                                      self.zero_checkpoint.get_src_tp_degree())
self.old_2d_map.simple_init()
self.new_2d_map = reshape_meg_2d_parallel(old_pp_degree=self.zero_checkpoint.get_src_pp_degree(),
                                          old_tp_degree=self.zero_checkpoint.get_src_tp_degree(),
                                          new_pp_degree=self.pp_degree,
                                          new_tp_degree=self.tp_degree)

if self.is_change_pp_degree() or self.is_change_tp_degree() or self.is_change_dp_degree():
    self.zero_checkpoint.reshape(model_3d_desc(self.pp_degree, self.tp_degree, self.dp_degree))
```

`meg_2d_parallel_map.simple_init()`（`reshape_meg_2d.py` L16）按 pp-major 顺序初始化：rank `i` 映射到 `(pp=i // tp_degree, tp=i % tp_degree)`，即 pp0_tp0, pp0_tp1, ..., pp1_tp0, ...。`reshape_meg_2d_parallel`（L80）执行 TP 先缩、PP 后缩的收缩映射——**只支持收缩（new <= old），不支持扩展**，因为扩展需要拆分参数张量，而检查点读取阶段无法知道参数的合并语义。

**为什么用两个 map**：`old_2d_map` 是恒等映射（source 拓扑的 rank 到自身的映射），`new_2d_map` 是 reshape 后的目标映射。`get_2d_parallel_files(tp_index, pp_index)` 通过 `new_2d_map.get_data(pp_index, tp_index)` 获取目标 (pp, tp) 位置对应的源文件索引列表——一个目标位置可能对应多个源文件（合并），也可能对应源文件的一个分区（拆分）。

#### 3D reshape 的层次结构

3D reshape 在 `model_3d_desc.reshape()`（`reshape_3d_utils.py` L27）中分两层执行：先 reshape 2D（PP×TP），再处理 DP 维度：

```python title="checkpoint/reshape_3d_utils.py L27-40"
def reshape(self, target_3d_desc, verbose=False):
    valid_reshape, reshape_errors = self.can_reshape(target_3d_desc)
    assert valid_reshape, ','.join(reshape_errors)
    tgt_2d_map = reshape_meg_2d_parallel(old_pp_degree=self.pp_degree,
                                         old_tp_degree=self.tp_degree,
                                         new_pp_degree=target_3d_desc.pp_degree,
                                         new_tp_degree=target_3d_desc.tp_degree)
    flat_3d_map = flatten_dp_dimension(meg_2d_map=tgt_2d_map,
                                       src_2d_size=self.pp_degree * self.tp_degree,
                                       dp_degree=self.dp_degree)
    return unflatten_dp_dimension(meg_2d_map=flat_3d_map, dp_degree=target_3d_desc.dp_degree)
```

`flatten_dp_dimension`（L141）将每个 (pp,tp) 槽位下所有 DP rank 的文件索引收集成一个扁平列表；`unflatten_dp_dimension`（L152）再按目标 DP degree 将扁平列表切分回独立的 2D map。最终 `ZeROCheckpoint._3d_file_map` 是一个按 DP rank 索引的列表，每个元素是一个 `meg_2d_parallel_map`，可以通过 `get_data(pp_index, tp_index)` 获取该 (pp, tp, dp) 位置对应的源文件列表。

### Universal 格式与转换

#### Universal 格式的核心思想

Universal 格式将每个参数独立存储为 `zero/{param_name}/{state_key}.pt`，彻底解耦训练拓扑与加载拓扑。原生 DeepSpeed 格式中，优化器状态按 rank 打包为扁平化的张量（无参数名标识，必须按保存时的顺序重建）；Universal 格式则每个参数一个目录，目录名就是参数名，内部按状态键（`fp32.pt`、`exp_avg.pt`、`exp_avg_sq.pt`）存储完整未分片的参数。

**为什么需要 Universal 格式**：原生格式要求加载时的 DP world size 与保存时一致（`engine.py` L4570-4575 显式 assert），因为优化器状态的分片是按 DP rank 做的均匀切分，切分数变了就无法对应。Universal 格式存储的是完整的、未分片的参数，加载时再按当前拓扑做 TP/EP/DP 切分——这使得"8 卡训练、64 卡恢复"成为可能。代价是 Universal 格式的文件数量远多于原生格式（每个参数一组文件，而非每个 rank 一个文件）。

#### ds_to_universal.py 转换器

`main()` 函数（`ds_to_universal.py` L893）是 CLI 入口，按 ZeRO stage 分两条路径：

```python title="checkpoint/ds_to_universal.py L893-960（节选）"
def main(args):
    optim_files = _get_optim_files(args.input_folder)
    zero3_optim_files = _filter_zero3_optim_files(optim_files)
    zero_stage = _get_zero_stage(zero3_optim_files or optim_files)

    if zero_stage <= 2:
        ds_checkpoint = DeepSpeedCheckpoint(args.input_folder)
        # 1. 提取 ZeRO 分片到临时目录
        _extract_zero_shard_files(args, ds_checkpoint, temp_dir)
        # 2. 合并 TP 切片为完整参数
        _merge_tp_slice_files(args, ..., temp_dir, ...)
        # 2.5. 合并 AutoEP 专家状态（如有）
        consolidate_autoep_zero12_expert_states(...)
        # 3. 保存公共优化器状态
        _save_optimizer_state(args, ds_checkpoint)
    else:
        # Stage 3 路径：从 zero_pp_rank_{dp}_mp_rank_{tp} 文件提取
        model_files = _get_zero3_model_state_files(args.input_folder)
        param_shapes = _parse_model_states_stage3(model_files)
        model_files_grid, tp_degree, dp_degree = _build_zero3_rank_grid(model_files)
        _extract_zero_shard_files_stage3(...)
        _merge_tp_slice_files_stage3(...)
```

转换器的核心步骤是"提取 → 合并"：先用 `DeepSpeedCheckpoint` 读取原生分片，提取每个参数的 `fp32`/`exp_avg`/`exp_avg_sq` 碎片到临时目录，然后按 TP 维度合并为完整参数。合并策略由 `UNIVERSAL_CHECKPOINT_INFO` 中的模式列表决定——`PARAMETER_TO_AVERAGE_PATTERNS` 做平均（如 layernorm），`PARAMETER_WITH_ROW_PARALLELISM_PATTERNS` 在 dim=1 拼接（如 attention.dense.weight），其余在 dim=0 拼接。合并后的参数保存为 `zero/{param_name}/{state_key}.pt`。

#### enable_universal_checkpoint 与 monkey-patching

Universal 格式的加载不是通过传统的 `state_dict` 批量加载，而是通过 **monkey-patching** 给每个参数绑定 `load_hp_checkpoint_state` 方法：

```python title="checkpoint/universal_checkpoint.py L238-240"
def enable_universal_checkpoint(param_list):
    for param in param_list:
        param.load_hp_checkpoint_state = types.MethodType(load_hp_checkpoint_state, param)
```

`types.MethodType` 将函数绑定为参数对象的实例方法——之后调用 `param.load_hp_checkpoint_state(folder, tp_rank, tp_world_size)` 时，`self` 就是该参数对象，可以通过 `self._hp_mapping` 获取该参数在 ZeRO 分片中的位置信息。

**为什么用 monkey-patching 而非传参**：每个参数的加载需要知道它自身的分片信息（`hp_mapping.lp_fragment_address` 标记了该参数在扁平化 LP buffer 中的位置），这些信息已经在 ZeRO 初始化时绑定到参数对象上。monkey-patching 让加载逻辑直接访问这些信息，无需额外的参数传递机制——这是 DeepSpeed 一贯的"参数对象即容器"设计哲学。

#### load_hp_checkpoint_state 的分片逻辑

`load_hp_checkpoint_state`（`universal_checkpoint.py` L99）逐参数从 Universal 格式加载，处理多种分片场景：

```python title="checkpoint/universal_checkpoint.py L99-118（节选）"
def load_hp_checkpoint_state(self, folder, tp_rank, tp_world_size, ep_rank=0, ep_size=1):
    hp_mapping = self._hp_mapping
    hp_mapping.optim_fragment = {}

    hp_keys = []
    for file in os.listdir(folder):
        match = re.search(r'(.+).pt', file)
        if match:
            hp_keys.append(match.group(1))

    for key in hp_keys:
        ckpt_dict = torch.load(os.path.join(folder, f"{key}.pt"), weights_only=False)
        full_hp_param = ckpt_dict[PARAM]
        # ... EP 切片、vocab padding、AutoTP 分片、标准 TP 切片 ...
```

加载逻辑按优先级处理：(1) EP 切片——如果是专家参数且 `ep_size > 1`，按 EP rank 切取本地专家；(2) shape 匹配检查——如果 `full_hp_param.shape == self.shape`，说明参数是复制的（如 layernorm），直接用 `tp_rank=0, tp_world_size=1` 跳过 TP 切分；(3) vocab padding——词表张量按目标 TP 度重新填充；(4) AutoTP 分片——通过 `DS_AUTOTP_UC_META` 元数据解析逻辑形状和分片维度；(5) 标准 TP 切分——按 `tp_world_size` 在 `CAT_DIM` 上 chunk。

### SDLoaderFactory 与 MegatronSDLoader

`SDLoaderFactory`（`state_dict_factory.py` L21）是模型状态加载的工厂入口，`MegatronSDLoader` 是目前唯一的加载器实现。其核心是 `load()` 方法（L57）的三路分发：

```python title="runtime/state_dict_factory.py L93-112"
if num_ckpt == mp_world_size:
    # 检查点数 == 当前并行度：直接加载
    sd = self.checkpoint_engine.load(load_path, ...)
elif num_ckpt > mp_world_size:
    # 检查点数 > 当前并行度：合并多余分片
    sd, all_scales, merge_count = self.merge_state_dict(...)
else:
    # 检查点数 < 当前并行度：拆分到更多 rank
    sd, all_scales = self.split_state_dict(...)
```

**为什么自动 merge/split**：大模型训练中常见"先用小 TP 度调试，再切换到大 TP 度正式训练"的场景。merge 将多个 TP 分片的参数按维度拼接还原为完整参数；split 将完整参数按维度切分到更多 rank。Megatron 格式的参数有三种拼接维度——axis=0（`word_embeddings`、`mlp.dense_h_to_4h`）、axis=1（`attention.dense.weight`、`mlp.dense_4h_to_h.weight`）、以及不切分（layernorm）。

#### QKV 三版本格式

`merge_query_key_value` / `split_query_key_value`（L220/L258）处理 Megatron 历史上的三种 QKV 参数排列格式：

```python title="runtime/state_dict_factory.py L225-256"
# version 0: [(3 * np * hn), h] — Q,K,V 交织，需三段拆分再拼接
# version 1.0: [(np * hn * 3), h] — 简单拼接
# version 2.0: [(np * 3 * hn), h] — 简单拼接
```

version 0 的 QKV 交织排列意味着不能简单 `torch.cat`——必须先把每个分片的 Q、K、V 三段拆开，分别跨分片拼接，再合并三段。version 1.0 和 2.0 的排列方式允许直接 `torch.cat(param_list, axis=0)`。版本号通过 `get_checkpoint_version`（L425）从 state_dict 的 `checkpoint_version` 字段读取，缺省为 0。

### CheckpointEngine 策略体系

`CheckpointEngine`（`checkpoint_engine.py` L21）是 I/O 策略的抽象基类，定义 `create → save → commit` 和 `load` 四个抽象方法。五种实现通过 `create_checkpoint_engine()`（`checkpoint_engine/utils.py` L15）按优先级选择：

```python title="runtime/checkpoint_engine/utils.py L15-48"
def create_checkpoint_engine(config_params, groups, zero_stage, has_moe_layers, optimize_dp_state):
    if config_params is not None:
        if config_params.checkpoint_config[CHECKPOINT_WRITER] is not None:
            writer_config = config_params.checkpoint_config[CHECKPOINT_WRITER]
            if writer_config[CHECKPOINT_WRITER_DECOUPLED]:
                return DecoupledCheckpointEngine(...)
            else:
                return FastCheckpointEngine(...)
        if config_params.nebula_config.enabled:
            return NebulaCheckpointEngine(...)
        if config_params.datastates_config.enabled:
            return DataStatesCheckpointEngine(...)
    return TorchCheckpointEngine(config_params)
```

| 引擎 | 文件 | save 实现 | 适用场景 |
|------|------|----------|---------|
| `TorchCheckpointEngine` | `torch_checkpoint_engine.py` L15 | `torch.save` | 默认，无特殊配置 |
| `FastCheckpointEngine` | `fast_checkpoint_engine.py` L16 | `torch.save` + AIO writer | 高性能 I/O（AIO/GDS） |
| `DecoupledCheckpointEngine` | `decoupled_checkpoint_engine.py` L78 | 子进程 `torch.save` | 训练-保存 overlap |
| `NebulaCheckpointEngine` | `nebula_checkpoint_engine.py` L20 | `torch_nebula` 分层存储 | 分布式持久化 |
| `DataStatesCheckpointEngine` | `datastates_checkpoint_engine.py` L14 | 外部 datastates 库 | 异步检查点 |

#### DecoupledCheckpointEngine：子进程异步保存

`DecoupledCheckpointEngine` 通过子进程执行 `torch.save`，主训练进程通过 `mp.SimpleQueue` 投递保存请求后立即返回，不阻塞训练——实现训练与保存的 overlap：

```python title="runtime/checkpoint_engine/decoupled_checkpoint_engine.py L42-67"
def init_decoupled_checkpoint(config_params, dp_writer_config, save_event, save_queue, optimize_dp_state):
    checkpoint_engine = FastCheckpointEngine(config_params, dp_writer_config, optimize_dp_state)
    save_path_list = []
    while True:
        (save_info, event_type) = save_queue.get()
        if event_type == DecoupledEvent.SAVE_EVENT and save_info is not None:
            state_dict, save_path = save_info
            save_path_list.append(save_path)
            checkpoint_engine.save(state_dict, save_path)
            del state_dict                                          ← 立即释放显存

        if event_type == DecoupledEvent.COMMIT_EVENT:
            save_path_list = []
            save_event.set()                                        ← 通知主进程完成

        if event_type == DecoupledEvent.EXIT_EVENT:
            break
```

主进程的 `save()` 方法（L157）只是将 `(state_dict, path)` 放入队列：

```python title="runtime/checkpoint_engine/decoupled_checkpoint_engine.py L157-166"
def save(self, state_dict, path: str):
    if self.ckpt_process is None:
        return
    if not self._check_process_alive():
        return
    save_info = (state_dict, path)
    self.save_queue.put((save_info, DecoupledEvent.SAVE_EVENT))
```

`commit()` 方法（L168）发送 `COMMIT_EVENT` 后通过 `_wait_for_event_with_timeout()`（L128）等待子进程完成——每 10 秒检查一次子进程是否存活，超时 300 秒后报错。这种设计确保：(1) 训练循环在 `save()` 时几乎无开销（仅队列投递）；(2) `commit()` 时同步等待，保证检查点完整性；(3) 子进程崩溃时主进程不会无限挂起。

**为什么用 `mp.SimpleQueue` 而非 `mp.Queue`**：`SimpleQueue` 是无界队列，不会因为子进程处理慢而阻塞主进程的 `save()` 调用。`mp.Event` 用于 commit 同步——主进程在 `commit()` 中 `wait()`，子进程在处理完所有 SAVE_EVENT 后 `set()`。子进程内部使用 `FastCheckpointEngine`（而非 `TorchCheckpointEngine`），以利用 AIO 异步写入进一步加速。

**为什么用 `spawn` 启动方法**：`mp.set_start_method('spawn')`（L83）是 CUDA tensor 共享的要求——`fork` 方式下子进程继承父进程的 CUDA context 会导致竞争条件，`spawn` 创建全新进程并通过 IPC 传递 tensor 句柄。

### AutoTP/AutoEP 元数据

AutoTP 和 AutoEP 在参数对象上注入元数据，指导 Universal 格式加载时的分片行为：

```python title="checkpoint/constants.py L63 + L97-98"
DS_AUTOTP_UC_META = "ds_autotp_universal_checkpoint_meta"   # AutoTP 元数据属性名
AUTOEP_LAYERS_KEY = 'ds_autoep_layers'                       # AutoEP 层信息键
AUTOEP_LAYERS_KEY_LEGACY = 'autoep_layers'                   # 旧版兼容
```

`DS_AUTOTP_UC_META` 是一个字符串常量，作为 `torch.nn.Parameter` 对象的动态属性名。AutoTP 在模型注入时（`module_inject/layers.py` L399）将元数据 setattr 到参数上，Universal 加载时 `_get_param_uc_restore_meta(param)`（`universal_checkpoint.py` L23）通过 `getattr(param, DS_AUTOTP_UC_META, None)` 读取。

元数据内容包含 `partition_dim`（分片维度）、`logical_shape`（逻辑形状）、`sub_param_shape`（子参数形状，用于 QKV 等复合参数）、`replicated`（是否复制不分片）。`_resolve_autotp_partition()`（L34）根据这些元数据将完整的 Universal 参数正确切分到当前 TP rank。

`AUTOEP_LAYERS_KEY` 存储在检查点的 model state dict 中，记录哪些层是 MoE 层及其专家配置（`moe_layer_id`、`module_path`、`num_experts`、`num_local_experts`、`ep_size`）。`DeepSpeedCheckpoint._lightweight_autoep_metadata()`（L95）在加载时只提取这些必要字段，避免将完整 model state 保留在内存中。`ds_to_universal.py` 在转换时将这些元数据注入到 `UNIVERSAL_CHECKPOINT_INFO` 中，使 Universal 格式加载器能正确处理专家参数的 EP 切片。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 工厂模式 | `SDLoaderFactory` in `state_dict_factory.py` L21 | 按 sd_type 创建加载器，目前仅 Megatron 但预留扩展 |
| 工厂模式 | `create_checkpoint_engine` in `utils.py` L15 | 按 config 优先级选择 5 种 I/O 引擎 |
| 策略模式 | `CheckpointEngine` ABC in `checkpoint_engine.py` L21 | I/O 策略可插拔：同步/异步/分布式存储 |
| 适配器模式 | `MegatronSDLoader` in `state_dict_factory.py` L190 | 适配 Megatron 三版本 QKV 格式 + merge/split |
| Monkey-Patching | `enable_universal_checkpoint` in `universal_checkpoint.py` L238 | 动态给 param 绑定加载方法，访问 ZeRO 分片元数据 |
| 模板方法 | `SDLoaderBase.load` in `state_dict_factory.py` L57 | load 定义 merge/split 分发骨架，子类实现具体合并逻辑 |
| 子进程隔离 | `DecoupledCheckpointEngine` in `decoupled_checkpoint_engine.py` L78 | 隔离 I/O 延迟，训练-保存 overlap |

## 模块间交互

- **→ Engine**：`save_checkpoint`/`load_checkpoint` in `engine.py` L4692/L4214 是统一入口，编排模型状态保存、ZeRO 状态保存、引擎 commit 三步
- **→ ZeRO**：`_save_zero_checkpoint` 调 `optimizer.state_dict()` 获取 ZeRO 分片状态；`_load_zero_checkpoint` 调 `optimizer.load_state_dict()` 恢复。Universal 加载时逐参数调 `param.load_hp_checkpoint_state()`
- **→ Pipeline**：`_save_checkpoint` 通过 `_curr_ckpt_path` 实例变量（`engine.py` L5187）将保存路径传递给 `PipelineEngine.module_state_dict()`（`pipe/engine.py` L1331），后者覆写为按层保存——`module.save_state_dict(self._curr_ckpt_path, ...)` 生成 `layer_{N}-model_{TP:02d}_model_states.pt` 文件
- **→ AutoTP**：AutoTP 在模型注入时将 `DS_AUTOTP_UC_META` 元数据绑定到参数上；Universal 加载时 `_resolve_autotp_partition()` 读取元数据做正确的 TP 切分
- **→ AutoEP**：`AUTOEP_LAYERS_KEY` 存储在 model state 中；`ds_to_universal.py` 转换时合并专家状态；`load_hp_checkpoint_state` 按 `ep_rank`/`ep_size` 切取本地专家参数
- **→ Comm**：`dist.barrier()` 在 `save_checkpoint` 末尾确保所有 rank 完成保存；Pipeline 加载时用 `dist.recv` 做串行加载链（`engine.py` L4564）
- **→ Config**：`get_checkpoint_config()` in `config.py` L61 解析 `checkpoint` 配置段，控制 serialization、writer 类型、data parallel 模式
- **→ Megatron**：`MegatronSDLoader` 硬编码了 Megatron GPT 的参数命名约定（`attention.query_key_value`、`mlp.dense_h_to_4h` 等），是非通用格式——Universal 格式才是面向未来的拓扑无关方案
