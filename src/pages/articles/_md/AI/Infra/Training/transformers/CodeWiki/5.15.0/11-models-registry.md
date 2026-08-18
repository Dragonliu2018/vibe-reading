---
source:
  type: "源码解读"
  project: "transformers"
  url: "https://github.com/huggingface/transformers"
title: "模型注册表"
date: "2026-08-18T16:40:20+08:00"
category: [AI, Infra, Training, transformers, CodeWiki, "5.15.0"]
tags: ["transformers", "AutoModel", "懒加载", "注册表", "4件套模板"]
description: "models/auto 用 _LazyAutoMapping 三层懒加载注册表把 model_type 解析为具体类，AutoModel.from_pretrained 据 config 懒加载 model class。2646 个模型文件遵循 4 件套统一模板。本文解读注册表与模板设计。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/transformers/CodeWiki/5.15.0/00-overview)

---

## 模块定位

模型注册表是 transformers "数百模型可发现可加载"的根因——`models/auto/` 用注册表 + 懒加载 + 工厂模式，让 `AutoModel.from_pretrained("meta-llama/Llama-2-7b")` 能据 config 的 `model_type` 自动找到并实例化正确的 model class，而 `models/` 下 2646 个文件遵循统一"4 件套"模板。`_LazyAutoMapping` 三层懒加载确保 `import transformers` 不会一次加载全部模型。它独立成模块，是把"模型如何被注册与发现"这件事上提到注册表层，与具体模型实现解耦。

边界：注册表只管"model_type→具体类的解析与懒加载"，不管模型怎么实例化加载权重（建模核心），也复用 `dynamic_module_utils` 处理外部模型代码。

## 模块架构

`models/auto/`（含 `auto_mappings.py` 1292 行 + `modeling_auto.py` 2634 行 + `configuration_auto.py` 456 行 + `auto_factory.py` 699 行）按职责分：

- **Auto 工厂基类**：`auto_factory.py:194` 的 `_BaseAutoModelClass`（`__init__` 故意抛异常强制用 `from_pretrained`/`from_config`），`_get_model_class`（L178，config→model class 解析器），`_LazyAutoMapping`（L575，懒加载 OrderedDict），`auto_class_update`（L480，工厂装饰器用 `copy_func` 复制方法注入 docstring）。
- **Config 注册表**：`configuration_auto.py:278` 的 `AutoConfig` + `_LazyConfigMapping`（L93）+ `CONFIG_MAPPING`（L48）。
- **Model 注册表**：`modeling_auto.py` 的 40+ 个 `MODEL_*_MAPPING_NAMES`（按 head 分组：`MODEL_MAPPING_NAMES`/`MODEL_FOR_CAUSAL_LM_MAPPING_NAMES`/`MODEL_FOR_SEQUENCE_CLASSIFICATION_MAPPING_NAMES` 等）→ 经 `_LazyAutoMapping` 包装成 40+ 个 `MODEL_*_MAPPING` → 定义 40+ 个 `AutoModel*` 类。
- **注册表数据**：`auto_mappings.py:24` 的 `CONFIG_MAPPING_NAMES`（**自动生成**，文件头标注"不要手动编辑"，由 `utils/check_auto.py --fix_and_overwrite` 扫描各 config 类的 `model_type` 生成）。

4 件套模板（以 llama 为例）：

```
models/llama/
├── __init__.py              # _LazyModule 延迟导入
├── configuration_llama.py   # LlamaConfig(PretrainedConfig)，model_type="llama"（注册 key 来源）
├── modeling_llama.py        # LlamaPreTrainedModel(PreTrainedModel) + LlamaModel + LlamaForCausalLM(+GenerationMixin) + ...
└── tokenization_llama.py    # LlamaTokenizer(TokenizersBackend)
```

## 调用链路

`AutoModelForCausalLM.from_pretrained` 的懒加载链路：

```
AutoModelForCausalLM.from_pretrained(repo_id)          auto_factory.py:261
├── cached_file(repo_id, "config.json") → commit_hash
├── AutoConfig.from_pretrained(repo_id)                 configuration_auto.py:303
│   ├── get_config_dict → config_dict["model_type"] = "llama"
│   └── CONFIG_MAPPING["llama"]                          # _LazyConfigMapping
│       └── importlib.import_module(".llama", "transformers.models")  ← 此刻才加载 llama 模块
│       └── getattr(module, "LlamaConfig") → LlamaConfig.from_dict → config
├── 判断代码来源:
│   ├── has_local_code = type(config) in cls._model_mapping
│   └── has_remote_code = config.auto_map 有 "AutoModelForCausalLM" 键（trust_remote_code 才走）
├── [本地路径] _get_model_class(config, MODEL_FOR_CAUSAL_LM_MAPPING)   # auto_factory.py:178
│   ├── model_mapping[type(config)] → _LazyAutoMapping.__getitem__(LlamaConfig)
│   │   ├── _reverse_config_mapping["LlamaConfig"] = "llama"
│   │   ├── _model_mapping["llama"] = "LlamaForCausalLM"（字符串）
│   │   └── _load_attr_from_module("llama", "LlamaForCausalLM") → importlib → getattr → class
│   └── 返回 LlamaForCausalLM class
└── model_class.from_pretrained(repo_id, config=config)  # → PreTrainedModel.from_pretrained
    └── kwargs["_from_auto"] = True（标记来自 Auto）
```

数据流：`repo_id → config.json → model_type="llama" → CONFIG_MAPPING 懒加载 → LlamaConfig → _get_model_class → MODEL_MAPPING 懒加载 → LlamaForCausalLM class → PreTrainedModel.from_pretrained → model 实例`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `_BaseAutoModelClass.from_pretrained` in `auto_factory.py:261` | 工厂加载入口 | 模板：取 config→判来源→取 model class→实例化 |
| `_get_model_class` in `auto_factory.py:178` | config→model class | 据 architectures 匹配，回退 list[0] |
| `_LazyAutoMapping.__getitem__` in `auto_factory.py:575` | 懒加载 model class | 访问时才 importlib，缓存到 _modules |
| `auto_class_update` in `auto_factory.py:480` | 工厂装饰器 | copy_func 复制方法注入独立 docstring |
| `AutoConfig.from_pretrained` in `configuration_auto.py:303` | 加载 config | 读 model_type 查 CONFIG_MAPPING |

</details>

## 核心实现

### 为何用 _LazyAutoMapping 三层懒加载

仓库有 2646 个文件、数百模型，若 `import transformers` 时直接加载所有模型，启动时间会爆炸（每个 modeling 文件拉入 torch 等重依赖），且绝大多数用户只需 1-2 个模型。`_LazyAutoMapping`（auto_factory.py:575）与 `_LazyConfigMapping`（configuration_auto.py:93）只在 `__getitem__` 被调用时才 `importlib.import_module` 对应单个模型模块，配合各模型 `__init__.py` 的 `_LazyModule`，实现三层延迟加载。注册表本身只存字符串（`"LlamaConfig"`/`"LlamaModel"`），不持有类引用——`_reverse_config_mapping["LlamaConfig"]="llama"` + `_model_mapping["llama"]="LlamaForCausalLM"` + `_load_attr_from_module` 动态取属性。

### trust_remote_code 的动态导入

`auto_factory.py:377-387` 的远程代码路径允许加载 Hub 上自定义模型代码：`resolve_trust_remote_code()`（dynamic_module_utils.py:712）——`trust_remote_code=None` 且有本地代码时默认 False（安全优先），仅无本地代码时交互提示；`get_class_from_dynamic_module()`（dynamic_module_utils.py:516）解析 `"repo_id--module.ClassName"` 从 Hub 下载 `.py` 到本地 cache 再 `get_class_in_module` 动态 import；`add_generation_mixin_to_remote_model`（auto_factory.py:543）为远程模型动态注入 `GenerationMixin`（v4.45 后 PreTrainedModel 不再继承它）；`register()` 方法（auto_factory.py:680）跳过 `__module__` 以 `transformers.` 开头的类，避免远程模型覆盖本地注册。

### 4 件套统一模板

每个模型目录遵循固定模板：`__init__.py`（`_LazyModule` 延迟导入，目录名=model_type）+ `configuration_*.py`（`PreTrainedConfig` 子类，`model_type` 属性是注册 key，自动生成 `CONFIG_MAPPING_NAMES` 条目）+ `modeling_*.py`（`PreTrainedModel` 子类，`__all__` 导出的类名写入 `MODEL_MAPPING_NAMES`）+ `tokenization_*.py`。动机：① **自动化注册**——`auto_mappings.py` 自动生成（`check_auto.py` 扫描各 config 的 `model_type`），消除手工维护；② **一致性**——所有模型遵循相同接口，AutoModel 工厂无需为每个模型写特殊逻辑；③ **可发现性**——`from transformers import LlamaForCausalLM` 可用且延迟加载。同一 model_type 在不同 `MODEL_*_MAPPING_NAMES` 指向不同 head（`llama` → `LlamaModel`/`LlamaForCausalLM`/`LlamaForSequenceClassification`）。

### auto_class_update 用 copy_func

`auto_factory.py:489`：`from_config = copy_func(_BaseAutoModelClass.from_config)`。若直接用 classmethod 绑定，所有 Auto 子类共享同一 function object 无法各自有独立 docstring。`copy_func` 深拷贝函数对象（含 `__code__`/`__dict__`），配合 `replace_list_option_in_docstrings` 装饰器自动注入支持模型列表，使每个 Auto 类 API 文档自动列出其支持的所有模型。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 注册表 | `CONFIG_MAPPING_NAMES`/`MODEL_*_MAPPING_NAMES`（auto_mappings.py/modeling_auto.py） | model_type→类名字符串，避免 import 环节 |
| 工厂 | `_BaseAutoModelClass`/`AutoConfig`（auto_factory.py:194） | 据 config model_type 动态选类实例化 |
| 懒加载 | `_LazyAutoMapping`/`_LazyConfigMapping`/`_LazyModule` | 三层延迟 import，避免启动加载全部 |
| 模板方法 | `_BaseAutoModelClass.from_pretrained`（L261） | 固定加载流程，子类设 `_model_mapping` |
| 装饰器 | `auto_class_update` + `copy_func`（L480） | 注入独立 docstring + 模型列表 |

## 模块间交互

`auto/` 依赖 `configuration_utils.PreTrainedConfig`（取 config，`get_config_dict`/`from_dict`）、`modeling_utils.PreTrainedModel`（加载权重，`from_pretrained`）、`dynamic_module_utils`（`get_class_from_dynamic_module`/`resolve_trust_remote_code` trust_remote_code 支持）、`generation.GenerationMixin`（`add_generation_mixin_to_remote_model`）。`auto_mappings.py` 是数据源（自动生成），被 `configuration_auto.py` 与 `modeling_auto.py` 消费。每个模型 4 件套对接框架：config 类的 `model_type` 是注册 key，modeling 类继承 `PreTrainedModel` 并 `register_for_auto_class()` 设 `_auto_class`。`_from_auto=True` 标记（auto_factory.py:264）传到 `PreTrainedModel.from_pretrained`（modeling_utils.py:4106）供 user_agent 统计与避免 AutoModel→具体 model→AutoModel 递归检查。

## 扩展方式

新增模型到注册表（完整 4 件套）：建 `models/foobar/` 的 `configuration_foobar.py`（`FoobarConfig` 设 `model_type="foobar"`）、`modeling_foobar.py`（`FoobarModel`/`FoobarForCausalLM(+GenerationMixin)`）、`tokenization_foobar.py`、`__init__.py`（`_LazyModule`+`define_import_structure`）；跑 `python utils/check_auto.py --fix_and_overwrite` 自动生成 `CONFIG_MAPPING_NAMES` 条目；在 `modeling_auto.py` 的 `MODEL_MAPPING_NAMES` 加 `("foobar","FoobarModel")` 及各 head MAPPING；在根 `__init__.py` 的 `_import_structure` 导出。新增 Auto head 变体（如 `AutoModelForImageSegmentation`）：在 `modeling_auto.py` 建 `MODEL_FOR_IMAGE_SEGMENTATION_MAPPING_NAMES` + `_LazyAutoMapping` 实例 + `AutoModelForImageSegmentation(_BaseAutoModelClass)` 经 `auto_class_update` 装饰，各模型加对应 head 类与 mapping 条目，根 `__init__.py` 导出。为现有模型新增 head（如 Llama 加 TokenClassification）：在 `modeling_llama.py` 加 `LlamaForTokenClassification(GenericForTokenClassification, LlamaPreTrainedModel)`，在 `MODEL_FOR_TOKEN_CLASSIFICATION_MAPPING_NAMES` 加 `("llama","LlamaForTokenClassification")`——config 不变、model_type 不变，无需改 `auto_factory.py`/`configuration_auto.py`。
