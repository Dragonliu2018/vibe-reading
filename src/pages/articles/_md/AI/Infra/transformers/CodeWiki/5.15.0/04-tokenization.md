---
source:
  type: "源码解读"
  project: "transformers"
  url: "https://github.com/huggingface/transformers"
title: "分词框架"
date: "2026-08-18T16:40:20+08:00"
category: [AI, Infra, transformers, CodeWiki, "5.15.0"]
tags: ["transformers", "Tokenizer", "Jinja", "chat template", "Rust backend"]
description: "分词框架 v5 重构为三后端一基类架构，fast（Rust tokenizers）为唯一公共路径。PreTrainedTokenizerBase 定义流程骨架，chat template 用 Jinja2 沙箱解耦对话格式，special_tokens_map 统一抽象特殊 token。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/transformers/CodeWiki/5.15.0/00-overview)

---

## 模块定位

分词框架把文本转成模型可吃的 `input_ids`（含 special token 插入、padding、truncation、chat template 渲染）。v5 做了大幅重构——旧的 `tokenization_utils.py`/`tokenization_utils_fast.py` 被重定向，逻辑拆到 base + 三后端，`use_fast` 参数废弃（fast 成为唯一公共路径，slow 仅作内部转换来源）。它独立成模块，是因为分词是与模型前向分离的数据预处理，有自己的后端依赖、序列化格式与对话格式生态。

边界：分词只管"文本↔token id"，不管模型怎么用这些 id（建模核心），也不管图像/音频模态（多模态处理）。

## 模块架构

v5 的三后端一基类架构：

```
PreTrainedTokenizerBase              tokenization_utils_base.py:962（抽象基类，流程骨架）
├── PythonBackend                    tokenization_python.py:400  ← slow，纯 Python + Trie
│   （alias: PreTrainedTokenizer）
│   └── SentencePieceBackend         tokenization_utils_sentencepiece.py:45  ← 用 sentencepiece 库
└── TokenizersBackend                tokenization_utils_tokenizers.py:85  ← fast，包装 Rust tokenizers
    （alias: PreTrainedTokenizerFast）
```

关键点：`PythonBackend` 与 `TokenizersBackend` 是**平级兄弟**（都直接继承 base），不是 slow→fast 父子——这正是"fast 是唯一公共路径"的体现。`is_fast` 分别在 `tokenization_python.py:454`（False）与 `tokenization_utils_tokenizers.py:492`（True）。

- **base**：`tokenization_utils_base.py` 定义 `__call__`/`encode`/`decode`/`from_pretrained`/`save_pretrained`/`apply_chat_template`/`pad` 等具体流程，把 `_tokenize`/`_convert_token_to_id`/`_encode_plus`/`_decode` 留作抽象钩子。
- **辅助**：`utils/chat_template_utils.py`（Jinja2 沙箱 `ImmutableSandboxedEnvironment` + `AssistantTracker` 扩展）、`convert_slow_tokenizer.py`（`SLOW_TO_FAST_CONVERTERS`，把 slow 状态转 Rust Tokenizer）、`models/auto/tokenization_auto.py`（`AutoTokenizer` + `TOKENIZER_MAPPING` 懒加载）。

## 调用链路

`__call__` 统一入口，slow/fast 在 `_encode_plus` 分叉：

```
__call__(text, add_special_tokens=True, padding=True, return_tensors="pt")  base:2418
├── 合并参数 → _get_padding_truncation_strategies (PaddingStrategy/TruncationStrategy 枚举)
└── self._encode_plus(...)  ← 抽象，子类实现
    │
    [slow] PythonBackend._encode_plus  python:702
    ├── get_input_ids(text) → tokenize → convert_tokens_to_ids
    ├── prepare_for_model: truncate_sequences + build_inputs_with_special_tokens  # ids 层拼 [CLS]/[SEP]
    └── pad → BatchEncoding
    │
    [fast] TokenizersBackend._encode_plus  tokenizers:925
    ├── set_truncation_and_padding → 策略下沉到 Rust 侧
    └── self._tokenizer.encode_batch(...)  # Rust 一次完成 tokenize+special+truncate+pad+offsets
        └── _convert_encoding → 抽取 input_ids/attention_mask/offsets → BatchEncoding
```

`BatchEncoding`（base:195，继承 `UserDict`）持有 `input_ids`/`attention_mask`/`token_type_ids` + `.encodings`（原始 Rust `Encoding`，提供 `char_to_token`/`offsets`，仅 fast 有）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `__call__` in `tokenization_utils_base.py:2418` | 统一入口 | 模板方法，slow/fast 共用，仅 _encode_plus 分叉 |
| `_encode_plus`（slow） in `tokenization_python.py:702` | Python 分词+拼装 | Trie 切 added tokens，ids 层拼 special |
| `_encode_plus`（fast） in `tokenization_utils_tokenizers.py:925` | Rust 批量编码 | 策略下沉 Rust，一次完成 |
| `apply_chat_template` in `tokenization_utils_base.py:2989` | 对话→prompt | Jinja 渲染，special_tokens_map 注入上下文 |
| `from_pretrained` in `tokenization_utils_base.py:1489` | 加载分词器 | v5 废 use_fast，fast 为默认 |
| `__getattr__`/`__setattr__` in `tokenization_utils_base.py:1281/1257` | token↔id 自动映射 | special_tokens_map 统一抽象机制 |

</details>

## 核心实现

### slow vs fast 双实现与 v5 决断

`TokenizersBackend._encode_plus`（`tokenization_utils_tokenizers.py:925`）一次 `self._tokenizer.encode_batch`（L1027）在 Rust 侧完成 tokenize+截断+padding+offsets，比 `PythonBackend` 的 Trie 切分+Python 循环快 10-100× 且支持 batch 并行。但保留 slow 因：① 某些 checkpoint 只带 `vocab.txt`/`.model` 无 `tokenizer.json`，需 slow 来源重建 fast（`convert_to_native_format` 调 `SLOW_TO_FAST_CONVERTERS`）；② 调试可读性；③ legacy 兼容。v5 决断（`tokenization_auto.py:733`）：`use_fast` 显式 `_ = kwargs.pop("use_fast", None)` 丢弃，`TOKENIZER_MAPPING_NAMES` 从 v4 的 `(slow, fast)` 元组简化为单字符串，`AutoTokenizer.register` 的 slow/fast 参数标注 deprecated。这大幅简化公共 API——用户不再选 slow/fast。

### chat template 的 Jinja2 沙箱

不同模型（LLaMA-3、ChatML、Mistral、Qwen）对话格式差异极大，把格式写成 Jinja 字符串，模型作者可在 `tokenizer_config.json` 或 `chat_template.jinja` 携带，无需改 transformers 代码。`apply_chat_template`（base:2989）流程：`get_chat_template` 选模板 → `template_kwargs = {**self.special_tokens_map, **kwargs}`（special_tokens_map 注入上下文，bos/eos 改文本时模板自动跟随）→ `render_jinja_template`（`chat_template_utils.py:498`）用 `ImmutableSandboxedEnvironment`（防访问任意 Python 对象）渲染。`{% generation %}...{% endgeneration %}` 块经 `AssistantTracker`（chat_template_utils.py:431）记录 assistant char 区间，配合 `return_assistant_tokens_mask` 经 `out.char_to_token` 映射到 token 级 mask，支持训练时区分 assistant token。自定义 `tojson`/`raise_exception`/`strftime_now` 全局，要求 jinja2 ≥ 3.1.0。

### special_tokens_map 统一抽象

7 个标准 special token（`bos_token`/`eos_token`/`unk_token`/`sep_token`/`pad_token`/`cls_token`/`mask_token`）存于 `_special_tokens_map`，模型自定义 token 存 `_extra_special_tokens`（v5 拆分命名 vs extra，解决 v4 `additional_special_tokens` 一锅炖）。`__getattr__`（base:1281）把 `bos_token_id` 自动转成 `convert_tokens_to_ids(str(self._special_tokens_map["bos_token"]))`，`__setattr__` 反向——用户写 `tokenizer.bos_token_id` 即可，内部自动查表。序列化统一：`save_pretrained` 直接 `tokenizer_config.update(self.special_tokens_map)`（base:2053）写 7 个命名 token，`from_pretrained` 反向 merge。decode 时 `skip_special_tokens` 一次过滤命名+extra+added(special=True)。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `__call__`/`encode`/`apply_chat_template` in base | 基类固定流程，子类填 `_tokenize`/`_encode_plus` 钩子 |
| 策略 | `PythonBackend`/`TokenizersBackend` 平级实现 | 同一接口两后端，v5 固化 fast 默认 |
| 注册表 + 懒加载 | `TOKENIZER_MAPPING = _LazyAutoMapping` in `tokenization_auto.py:418` | 数百 tokenizer 按需 import |
| 属性描述符 | `__getattr__`/`__setattr__` + `attribute_map` | token↔id 自动双向映射 |
| 组合 | `ProcessorMixin` 持有 tokenizer（非继承） | 多模态统一前端，见多模态处理 |

## 模块间交互

分词器被 `processing_utils.ProcessorMixin`（组合为 `tokenizer` 属性）、`pipelines/base.py`（接收并 `from_pretrained`）、`generation/utils.py`（constrained decoding 调 `tokenizer.get_vocab()`）消费。**不进入 modeling 层**——model 只接收已 token 化的 `input_ids` tensor，与 tokenizer 的耦合是接口契约：`tokenizer.model_input_names`（决定 forward 输入键名）与 `model.resize_token_embeddings(len(tokenizer))`。`ProcessorMixin` 把 tokenizer 当文本模态属性，`__call__` 时委托，`batch_decode`/`decode` 转发，special_tokens_map 注入 template。这体现分层：数据预处理（tokenization）与模型前向分开。

## 扩展方式

为新模型注册 tokenizer（v5 fast-only）：在 `models/<model>/tokenization_<model>.py` 定义 `<Model>Tokenizer(TokenizersBackend)` 设 `model = BPE`/`Unigram`/`WordPiece`、`vocab_files_names`；若需从 `.model`/`vocab.txt` 重建加 `<Model>Converter(SpmConverter)` 注册到 `SLOW_TO_FAST_CONVERTERS`；在 `tokenization_auto.py:65` 的 `TOKENIZER_MAPPING_NAMES` 加 `"model_type": "<Model>Tokenizer"`。新增/改 chat template：`tokenizer.chat_template = "{%...%}"`（多模板用 dict），`save_pretrained` 写 `tokenizer_config.json` 或 `chat_template.jinja` 文件（`save_jinja_files=True` 默认开）；用 `{% generation %}` 块支持 `return_assistant_tokens_mask`。扩 vocab：`tokenizer.add_special_tokens({"extra_special_tokens": ["[MASK2]"]})` 后 `model.resize_token_embeddings(len(tokenizer))`（slow 写 `_added_tokens_encoder`+`_update_trie`，fast 走 Rust `_tokenizer.add_tokens`）。
