---
title: "接入 Cola-DLM：在 multimodal_gen 框架里用扩散生成文本"
source:
  project: "SGLang"
  type: "PR"
  id: "26220"
  url: "https://github.com/sgl-project/sglang/pull/26220"
  prType: "feat"
date: "2026-07-14"
category: [AI, 推理, SGLang, Contributions]
tags: ["SGLang", "Cola-DLM", "Diffusion Model", "Text Generation"]
description: "为 multimodal_gen 框架新增 Cola-DLM 文本扩散模型支持：自定义 DiT/VAE 适配器、三阶段块状去噪流水线、T2T 任务类型与文本生成端点。"
readingTime: "14 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#26220](https://github.com/sgl-project/sglang/pull/26220) · **Issue** `-` · **commit** `-` · **首发版本** `-` · **变更行数** +1175 / -7 行 · **合并时间** -

---

## 背景

SGLang 的 `multimodal_gen` 子系统原本服务于图像/视频/3D 网格等**视觉扩散**模型（Wan、FLUX、Hunyuan、Qwen-Image、Z-Image……）。这些模型的输出都是像素或网格，落盘成 `.png` / `.mp4` / `.glb`。但扩散的思想并不限于视觉——**文本也可以用扩散生成**。

PR [#26220](https://github.com/sgl-project/sglang/pull/26220) 接入的 **Cola-DLM**（Continuous Latent Diffusion Language Model，字节跳动 Seed 团队）正是这样一类模型：它在**连续潜在空间**里对文本做扩散，逐块（block）生成 token。这是 `multimodal_gen` 框架接入的**第一个文本到文本（Text-to-Text, T2T）模型**，因此改动不止是"多加一个模型"，而是让框架从"只产出视觉文件"长出"产出文本"的能力：

- 新增 `ModelTaskType.T2T` 与 `DataType.TEXT`，把"文本"作为一等输出类型贯通 CLI / Python API / HTTP Server；
- 新增文本生成 HTTP 端点 `POST /v1/text/generations`；
- 注册逻辑重构，支持**没有 `model_index.json` 的非 diffusers 模型**（Cola-DLM 的权重来自上游 `cola_dlm` 包，不是 diffusers checkpoint）；
- 三个完全自定义的流水线阶段，移植 Cola-DLM 上游的块状去噪推理算法。

PR 仍是 Draft、未合并，+1175 / -7 行、19 个文件（8 新增 + 11 修改）。本文聚焦这次接入的实现要点。

---

## 前置知识

### Cola-DLM：在连续潜在空间做文本扩散

普通自回归 LLM 逐 token 离散采样；Cola-DLM 的做法是：

1. **Text VAE**（`ColaTextVAEModel`）把 token ID 序列**编码为连续潜在向量**（每个 token 一个 `latent_dim=16` 维向量），也能把潜在向量**解码回词表 logits**。
2. **DiT 先验**（`ColaDiTModel`）在这些连续潜在上做扩散——预测从噪声到干净潜在的速度场（flow matching）。
3. 推理时**逐块生成**：每次扩散一个 `block_size=16` token 的潜在块，VAE 解码出 logits，采样得到这 16 个 token，再把这块写回 KV cache，继续下一块，直到 EOS 或达到 `max_new_tokens`。

关键参数（来自 `ColaDLMPipelineConfig` / `ColaDLMSamplingParams`）：

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `block_size` | 16 | 每个扩散块对应的 token 数 |
| `latent_dim` | 16 | 连续潜在向量维度 |
| `vocab_size` | 100278 | 词表大小 |
| `T` | 1000.0 | flow matching 端点 |
| `num_inference_steps` | 16 | 每块的 Euler ODE 步数 |
| `guidance_scale` | 7.0 | CFG 强度 |

两个让推理又快又对的技巧贯穿实现：**跨块 KV cache**（前缀与已生成块的 K/V 只算一次，后续块只对新增 Q 做注意力）和**首块 clean guidance**（把 prompt 对应的潜在位置在 t=0 钉死到干净值，保证 prompt 不被扩散破坏）。

### multimodal_gen 框架的"组装式"流水线

框架把一个模型的推理拆成若干 `PipelineStage`，由 `ComposedPipelineBase` 的子类装配：

- `_required_config_modules` 声明要从 `model_index.json` 加载哪些组件；
- `load_modules()` 默认读 `model_index.json`、按声明逐个加载；
- `create_pipeline_stages()` 用 `self.add_stage(...)` 把阶段串起来；
- `PipelineStage.forward(batch: Req, server_args)` 是每个阶段的契约——输入输出都是 `Req`（末阶段可输出 `OutputBatch`），中间状态挂在 `Req.extra: dict` 上跨阶段传递。

Cola-DLM 恰好在这三点上**全部不走默认路径**，这是后文实现部分的主线。

---

## 设计参考

移植的对象是 Cola-DLM 上游的 `cola_dlm/inference.py` 中的 `generate_task_repaint_inference`。PR 的 `ColaBlockDenoisingStage` 顶部注释直接标注了这一引用：

```python title="cola_dlm.py — stages 模块顶部"
# Reference: https://github.com/ByteDance-Seed/Cola-DLM/blob/main/cola_dlm/inference.py (generate_task_repaint_inference)
```

上游推理是单进程、单请求的脚本；PR 的工作是把它**重构成框架内的可组装阶段**：把"一次性算完"的循环拆成可被 `PipelineExecutor` 调度的 `forward`，把全局变量收敛进 `ColaRequestState`，并把 DiT/VAE 的调用包成符合框架 `BaseDiT` / VAE 约定的薄适配器。

---

## 实现

### 一、模型适配器：DiT 与 VAE 的薄包装

Cola-DLM 的 `ColaDiTModel` / `ColaTextVAEModel` 来自 `cola_dlm` 包，接口与框架的 `BaseDiT` / VAE 约定不同：它用 **NA（no-padding）形式**的 `txt` / `txt_shape` / `txt_q_shape` 张量，而不是图像 latent 的 `[B, C, H, W]`。PR 用两个薄 wrapper 做适配，把上游实例**注入**而不是重写：

```python title="runtime/models/dits/cola_dlm.py — ColaDiTWrapper.forward"
def forward(self, hidden_states=None, encoder_hidden_states=None,
            timestep=None, txt=None, **kwargs):
    # 框架标准参数 → Cola-DLM 接口
    txt = txt if txt is not None else hidden_states
    txt_shape = kwargs.get("txt_shape")
    txt_q_shape = kwargs.get("txt_q_shape")
    update_kv = kwargs.get("update_kv", False)
    use_kv_cache = kwargs.get("use_kv_cache", False)

    return self._model(
        txt=txt, txt_shape=txt_shape, txt_q_shape=txt_q_shape,
        timestep=timestep, update_kv=update_kv, use_kv_cache=use_kv_cache,
    )
```

要点：

- **注入而非继承**：`load_model(model)` 把已 `from_pretrained` 加载好的上游实例塞进 `self._model`，权重直通、不做任何重映射（`param_names_mapping = {r"^(.*)$": r"\1"}` 是恒等映射）。
- **KV cache 透传**：`set_kv_cache(flag)` 遍历 `self._model.blocks` 调上游方法；`forward` 把 `update_kv` / `use_kv_cache` 透传给上游——这是跨块缓存能工作的前提。
- VAE wrapper 同理：`encode([input_tensor])` 取 `enc.latents_list[0]`，`decode(z, txt_shape, txt_q_shape, update_kv)` 返回 logits。

### 二、三阶段流水线：块状去噪的核心

`ColaDLMPipeline` 用三个自定义阶段替代框架标准的 `DenoisingStage` + `DecodingStage`：

```
Req(prompt) ─► ColaTokenizationStage ─► ColaBlockDenoisingStage ─► ColaTextDecodingStage ─► OutputBatch(output=[text])
                 tokenize + VAE encode     块状 ODE + CFG + 采样      detokenize
                 切分 prefix + 首块          跨块 KV cache             返回文本
                 写入 batch.extra          读/写 batch.extra
```

**阶段 1 — `ColaTokenizationStage`**：tokenize prompt → 按 `patch_size * block_size` 对齐 padding → VAE encode 得连续潜在 → 按 token label（1=prompt、3=pad）折算潜在 label → 切出 **prefix** 与**首块**（`first_block_latents` / `first_block_labels`），连同首块 CFG 强度（prefix 非空才用 `guidance_scale`，否则 1.0）一起塞进 `batch.extra["cola_state"]`。

**阶段 2 — `ColaBlockDenoisingStage`**：核心循环。先做**前缀 KV 预取**——用 prefix 潜在跑一次 DiT 和 VAE.decode（`update_kv=True`）暖好缓存；随后进入 `while not state.finished` 的逐块循环：

```python title="cola_dlm.py — 块状去噪的单步（节选）"
for t_curr, t_next in zip(timesteps[:-1], timesteps[1:]):
    # 首块 clean guidance：把 prompt 位置在 t=0 钉到干净潜在
    if is_first_block and flat_mask is not None and flat_mask.any():
        ts_batch[flat_mask] = 0
        txt[flat_mask] = state.first_block_latents[flat_mask]

    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        # 条件分支：读 KV cache（prefix + 已生成块）
        drift_cond = self.dit(txt=txt_bf16, txt_shape=txt_shape_cum,
                             txt_q_shape=txt_q_shape, timestep=ts_bf16,
                             update_kv=False, use_kv_cache=True).txt_sample
        # 无条件分支：仅本块，不读 cache
        drift_uncond = self.dit(txt=txt_bf16, txt_shape=txt_q_shape,
                               txt_q_shape=txt_q_shape, timestep=ts_bf16,
                               update_kv=False, use_kv_cache=False).txt_sample

    # CFG 合成 + Euler 更新
    s = cfg_scale_first if is_first_block else guidance_scale
    drift = s * (drift_cond - drift_uncond) + drift_uncond
    txt_next = txt - drift * dt
    if is_first_block and flat_mask is not None and flat_mask.any():
        txt_next[flat_mask] = state.first_block_latents[flat_mask]   # 更新后再次钉住
    txt = txt_next
```

每个 ODE 块结束后：`vae.decode` 出 logits → 取末 `block_size * patch_size` 个位置的 logits → `_sample_with_strategies`（temperature / top-k / top-p / repetition penalty）采样 → 把刚去噪完的块**写回 DiT KV cache**（`update_kv=True`）→ 更新 `ColaRequestState`。终止条件是命中 `eos_token_id` 或达到 `max_new_tokens`。

**阶段 3 — `ColaTextDecodingStage`**：`tokenizer.decode(output_ids)` 得到文本字符串，返回 `OutputBatch(output=[text])`——文本走 `output` 字段，而不是视觉模型那套 `output_file_paths`。

### 三、流水线装配：三处覆盖默认行为

`ColaDLMPipeline` 在 `ComposedPipelineBase` 上覆盖了三处，全部是为了绕开"必须有 `model_index.json`"这一前提：

```python title="runtime/pipelines/cola_dlm.py — 三处覆盖"
_required_config_modules = []                       # 不声明任何 diffusers 组件

def _load_config(self) -> dict[str, Any]:
    return {"_class_name": self.pipeline_name,     # 合成配置，无需 model_index.json
            "_diffusers_version": "0.0.0"}

def load_modules(self, server_args, loaded_modules=None):
    config = server_args.pipeline_config
    dit_path = os.path.join(server_args.model_path, config.dit_path)   # cola_dlm/cola_dit
    vae_path = os.path.join(server_args.model_path, config.vae_path)   # cola_dlm/cola_vae
    # tokenizer 优先 tokenizer.json，否则 AutoTokenizer
    # DiT / VAE 用上游 cola_dlm 包的 from_pretrained 加载，再注入 wrapper
    ...
    return {"dit": dit, "vae": vae, "tokenizer": tokenizer}
```

- **`_required_config_modules = []`**：默认 `load_modules` 会 `assert len(model_index) > 1`，合成配置 pop 掉 meta 键后剩 0 个组件会断言失败——所以必须整体覆盖 `load_modules`，自己从嵌套目录 `cola_dlm/cola_dit`、`cola_dlm/cola_vae` 加载。
- **`load_modules`**：用 `ColaDiTModel.from_pretrained` / `ColaTextVAEModel.from_pretrained`（上游 `cola_dlm` 包）加载原始模型，再 `wrapper.load_model(raw)` 注入。
- **`create_pipeline_stages`**：`self.add_stage(...)` 依次挂三个阶段。

### 四、框架级改造：让"文本"贯通全栈

| 文件 | 改动 | 作用 |
| --- | --- | --- |
| `configs/pipeline_configs/base.py` | 新增 `ModelTaskType.T2T`；`data_type()` 把 `T2T` → `DataType.TEXT` | 框架首次有"文本"任务类型 |
| `configs/sample/sampling_params.py` | 新增 `DataType.TEXT`；`get_default_extension()` 返回 `"txt"`；CLI 加 `--max-new-tokens`/`--T`/`--temperature`/`--top-k`/`--top-p`/`--repetition-penalty` 等 | 文本采样参数 |
| `runtime/entrypoints/openai/protocol.py` | `TextGenerationsRequest` / `TextResponse` Pydantic 模型 | 文本请求/响应协议 |
| `runtime/entrypoints/openai/text_api.py` | `POST /v1/text/generations` 路由；校验 `task_type.data_type() == TEXT` | 文本生成 HTTP 端点 |
| `runtime/entrypoints/diffusion_generator.py` | `DataType.TEXT` 分支，构建 `GenerationResult(text=...)` | Python API 返回文本 |
| `runtime/entrypoints/cli/generate.py` | 打印 `result.text` | CLI 输出文本 |
| `runtime/entrypoints/utils.py` | `GenerationResult` 加 `text: str \| None` 字段 | 结果载体加文本槽 |
| `runtime/managers/gpu_worker.py` | `data_type == TEXT` 时跳过 `save_outputs` | 文本无文件可存 |
| `python/sglang/utils.py` | `KNOWN_NON_DIFFUSERS_DIFFUSION_MODEL_PATTERNS["cola-dlm"] = "ColaDLMPipeline"` | 标记 Cola-DLM 为非 diffusers 模型 |

文本端点的守卫值得一提——它用任务类型而非路径判断，避免视觉模型误触文本端点：

```python title="text_api.py — 任务类型守卫"
if task_type.data_type() != DataType.TEXT:
    raise HTTPException(status_code=400,
        detail=f"This endpoint is for text generation models. "
               f"Current model task type is {task_type.name}.")
```

---

## 问题

### 为什么顺手重构了 registry 的 detector 匹配？

`registry.py` 的 `_get_config_info` 原来第三步是**先**调 `maybe_download_model_index(model_path)` 拿到 `pipeline_name`，再用 detector 同时匹配 `model_path` 和 `pipeline_name`。问题在于：Cola-DLM 没有 `model_index.json`，这步下载会失败，导致**路径明明能匹配上、却因为先下载 model_index 而整体崩掉**。

重构后第三步拆成两段：先**只按路径**跑 detector（非 diffusers 模型在此命中），没匹配上才回退去下载 `model_index.json` 按类名匹配，并用 `try/except` 兜底非 diffusers 模型：

```python title="registry.py — _get_config_info 第 3 步（重构后）"
# 先按路径匹配（支持无 model_index.json 的非 diffusers 模型）
for model_id, detector in _MODEL_NAME_DETECTORS:
    if detector(model_path.lower()):
        matched_model_names += [model_id]

# 路径没中，再下载 model_index.json 按类名匹配
if not matched_model_names:
    try:
        config = maybe_download_model_index(model_path)
        pipeline_name = config.get("_class_name", "").lower()
        for model_id, detector in _MODEL_NAME_DETECTORS:
            if detector(pipeline_name):
                matched_model_names += [model_id]
    except Exception:
        pass  # 非 diffusers 模型没有 model_index.json
```

Cola-DLM 注册时只挂 detector（`"cola" in hf_id and "dlm" in hf_id`），不带 `hf_model_paths`，靠路径匹配即可命中。这个重构对所有"非 diffusers 但想接入框架"的模型都是净收益。

### 为什么用 `Req.extra` 跨阶段传状态？

Cola-DLM 的块状去噪是**有状态**的（已生成 token、累计 K 长度、首块干净潜在……），而框架的 `PipelineStage` 是无状态函数。PR 把全部状态收进 `ColaRequestState` dataclass，挂在 `batch.extra["cola_state"]` 上：阶段 1 填充、阶段 2 读写、阶段 3 读取最终 token 列表。这避免了在 stage 实例上存 per-request 状态（多请求并发会串），与框架"stage 无状态、状态随 batch 走"的约定一致。

---

## 意义与影响

| 维度 | PR 前 | PR 后 |
| --- | --- | --- |
| 输出类型 | 图像 / 视频 / 网格 | + **文本** |
| 任务类型 | T2I / T2V / I2V / I2I / TI2I / I2M / VLA | + **T2T** |
| 接入模型来源 | 需 diffusers checkpoint（有 `model_index.json`） | + 非 diffusers 模型（`cola_dlm` 包） |
| 调用方式 | CLI / Python API / HTTP（图像/视频） | + `POST /v1/text/generations` 文本端点 |

这次接入的价值不止"多一个模型"，而是把 `multimodal_gen` 从"视觉扩散 serving"扩展为"**扩散 serving**"——只要输出能落进 `DataType` 枚举、推理能拆成 stage，框架就能承载。文本扩散（Cola-DLM、潜在的 MDLM、SED 等）从此和图像/视频扩散共用同一套调度、KV cache、CFG、执行器基础设施。registry 的 detector 重构则顺手降低了一类模型的接入门槛：不再强制 `model_index.json`。

---

## TODO

PR 是 Draft，未合并，checklist 中测试与 benchmark 项均未勾选。可预见的后续工作：

- [ ] 补单元/回归测试：覆盖 tokenize 对齐、首块 clean guidance、EOS 终止、`max_new_tokens` 截断等分支。
- [ ] 精度 benchmark：与上游 `cola_dlm/inference.py` 的 `generate_task_repaint_inference` 对齐输出，验证移植无损。
- [ ] 性能 profiling：跨块 KV cache 的命中率、bf16 autocast 的数值稳定性。
- [ ] 多卡：当前 wrapper 的 `_fsdp_shard_conditions` / `_compile_conditions` 为空，尚未接 SP/TP。
- [ ] 把首块 CFG=1.0（prefix 为空时）等经验沉淀进 `ColaDLMSamplingParams` 文档。

---

## 参考

- Cola-DLM 模型主页：[HuggingFace ByteDance-Seed/Cola-DLM](https://huggingface.co/ByteDance-Seed/Cola-DLM) / [GitHub ByteDance-Seed/Cola-DLM](https://github.com/ByteDance-Seed/Cola-DLM)
- 上游推理参考：`cola_dlm/inference.py` 的 `generate_task_repaint_inference`
- 框架接入指南：`python/sglang/multimodal_gen/.claude/skills/sglang-diffusion-add-model/SKILL.md`
