---
source:
  type: "源码解读"
  project: "FastGen"
  url: "https://github.com/NVlabs/FastGen"
title: "数据集"
date: "2026-08-11T15:45:00+08:00"
category: [AI, Generative, FastGen, CodeWiki, "0.1.0"]
tags: ["FastGen", "Python", "PyTorch", "扩散模型", "蒸馏"]
description: "FastGen 数据集模块深度解读：ImageDataset class-conditional、BaseWDSLoader 模板方法、ImageWDSLoader/VideoWDSLoader 策略、DeterministicWDS 断点恢复、AugmentPipe 增强管道。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Generative/FastGen/CodeWiki/0.1.0/00-overview)


## 模块定位

数据集模块（`fastgen/datasets/`，2730 行，9 文件）负责 class-conditional 图像加载和 WebDataset 大规模视频/latent 流式加载。核心是 `BaseWDSLoader` 模板方法 + `ImageWDSLoader`/`VideoWDSLoader` 策略子类，统一产出 `dict(real, condition, neg_condition)` 格式——无论像素图像、预计算 latent 还是视频，下游 `FastGenModel` 无需区分数据来源。`DeterministicWDS` 通过 shard 级 fast-forward 支持断点精确恢复。

---

## 模块架构

两条数据路径并行：**class-conditional**（`ImageDataset` + `ImageFolderDataset` + `InfiniteSampler`）用于 CIFAR-10/ImageNet 类标签场景；**WebDataset**（`BaseWDSLoader` → `WDSLoader` → `ImageWDSLoader`/`VideoWDSLoader`）用于大规模 shard 化图像/视频/latent。`AugmentPipe`（EDM 风格增强管道）不在 dataloader 内，而在 `Trainer.preprocess_data` 中调用。`decoders.py` 提供视频/图像/latent 解码函数。

---

## 调用链路

WebDataset 管道（数据流转）：

```
BaseWDSLoader.__init__()                              # wds_utils.py:377
└── self.loader = self._create_loader()               # wds_utils.py:468
    ├── [deterministic]: DeterministicWDS              # wds_utils.py:530
    │   ├── fast-forward 到 sampler_start_idx          # wds_utils.py:607
    │   ├── offset = start_idx + worker_id + num_workers*rank  # wds_utils.py:628
    │   └── dataset.slice(offset, maxsize, splitsize)  # wds_utils.py:651
    └── self._pipeline(dataset)                        # 子类 override
        └── WDSLoader._pipeline:                       # wds_dataloaders.py:381
            ├── dataset.select(filter_items)           # 过滤缺失 key
            ├── dataset.map(decoder)                   # 字节 → tensor
            └── dataset.map(_preprocess)               # → dict(real, condition, ...)

Trainer.preprocess_data(data)                          # trainer.py:375
├── augment_pipe(data) [if not None]                  # trainer.py:391
├── VAE encode real/noise                              # trainer.py:404
└── text_encoder.encode(condition)                     # trainer.py:412
→ model.single_train_step(data) → _prepare_training_data  # model.py:447
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `ImageDataset.__getitem__()` `class_cond_dataset.py:89` | 返回 dict(real, condition, neg_cond, idx) | uint8 自动归一化 [-1,1] |
| `ImageDataset.get_label()` `class_cond_dataset.py:113` | int64 → onehot | 服务 class-conditional |
| `BaseWDSLoader._create_loader()` `wds_utils.py:468` | 创建 loader 骨架 | deterministic 分流 |
| `BaseWDSLoader._pipeline()` `wds_utils.py:454` | identity（子类 override） | 模板方法钩子 |
| `WDSLoader._pipeline()` `wds_dataloaders.py:381` | filter→decode→preprocess | 三步管道 |
| `WDSLoader._preprocess()` `wds_dataloaders.py:286` | 映射到输出 dict | key_map 提取 |
| `DeterministicWDS.__iter__()` `wds_utils.py:596` | shard fast-forward + 切片 | 精确恢复 |
| `AugmentPipe.process()` `augment.py:344` | 像素/几何/颜色增强 | 管道模式，概率控制 |
| `InfiniteSampler.__iter__()` `samplers.py:31` | 无限循环 | iteration-based 训练 |

</details>

---

## 核心实现

### ImageDataset class-conditional 与统一接口

`ImageDataset`（`class_cond_dataset.py:23`）是抽象基类，`__getitem__`（`class_cond_dataset.py:89`）返回统一 dict：

```python title="datasets/class_cond_dataset.py"
def __getitem__(self, idx):
    raw_idx = self._raw_idx[idx]
    image = self._load_raw_image(raw_idx)   # 子类实现
    if self.xflip: image = image[:, :, ::-1]
    if image.dtype == np.uint8:
        image = image.astype(np.float32) / 127.5 - 1   # 像素路径
    else:
        image = image.astype(np.float32)                # latent 路径
    return {"real": image.copy(), "condition": self.get_label(idx),
            "neg_condition": np.zeros(self.label_shape), "idx": idx}
```

`get_label`（`class_cond_dataset.py:113`）自动 int64 → onehot。`neg_condition` 全零向量预留 negative prompt 位置，与 WDSLoader 产出格式一致——下游 model 无需区分数据来源。同时支持像素（CIFAR-10）和 latent（ImageNet SD VAE latent）通过 `dtype == uint8` 检查自动选归一化路径。`ImageFolderDataset`（`class_cond_dataset.py:176`）支持本地 ZIP/目录/S3（rank0 下载 + `synchronize` 同步）。用自己的 `ImageDataset` 而非 torchvision 的原因：onehot 转换、统一 dict 接口、像素/latent 双路径、xflip 翻倍、S3 rank0 同步。

### BaseWDSLoader 模板方法与 WDSLoader 管道

`BaseWDSLoader._create_loader`（`wds_utils.py:468`）是模板方法——选 deterministic/非 deterministic 路径 → 调 `self._pipeline(dataset)` → 包装 WebLoader。`_pipeline`（`wds_utils.py:454`）基类 identity，子类 `WDSLoader._pipeline`（`wds_dataloaders.py:381`）override 为 `select(filter_items) → map(decoder) → map(_preprocess)` 三步管道。`WDSLoader` 处理预计算 latent/embedding，`key_map` 映射输出 key 到 shard 文件扩展名（如 `{"real": "latent.pth", "condition": "txt_emb.pth"}`）。`presets_map` 用注册表（`PRESET_CONSTANTS`）索引预设值（如 `neg_prompt_wan`）。

### ImageWDSLoader / VideoWDSLoader 策略模式

两者继承 `WDSLoader`，覆盖 `decoders` property 提供不同解码策略：`ImageWDSLoader`（`wds_dataloaders.py:419`）追加 `decode_image(image_transform)`（Resize→CenterCrop→ToTensor→Normalize [-1,1]）；`VideoWDSLoader`（`wds_dataloaders.py:487`）追加 `decode_video_segment`（随机片段）或 `decode_video_full`，override `_preprocess` 加 `_transform_video`（permute→取前 N 帧→resize→center_crop→归一化→permute）。共用逻辑（shard 发现/过滤/deterministic 选择/管道骨架/constants 机制），各自扩展解码和变换。

### DeterministicWDS 断点精确恢复

`DeterministicWDS`（`wds_utils.py:530`）继承 `IterableDataset`，用 `shard_count_file`（每 shard 样本数 JSON）实现 fast-forward（`wds_utils.py:607`）：根据 `sampler_start_idx` 跳过已训练 shard。`offset = start_idx + worker_id + num_workers * get_rank()`（`wds_utils.py:628`），`dataset.slice(offset, maxsize, splitsize)`（`wds_utils.py:651`）分布式切片。解决普通 WebDataset `resampled=True` 随机有放回无法恢复的问题。deterministic 模式自动 `num_workers=1`（`wds_utils.py:433`），因多 worker 并发顺序不确定。

### AugmentPipe EDM 风格增强管道

`AugmentPipe`（`augment.py:280`）源自 EDM 论文，所有增强默认关闭（概率乘数=0）。三大类：pixel blitting（xflip/yflip/rotate90/translate）、geometric（scale/rotate/aniso/translate，仿射矩阵 `G_inv` + wavelet 上采样）、color（brightness/contrast/hue/saturation，4x4 颜色矩阵 `M`）。`process(images)`（`augment.py:344`）返回 `(augmented, aug_condition_labels)`——每种增强生成 condition label 用于条件化模型。`__call__(data)`（`augment.py:549`）读 `data["real"]` 增强，合并 `aug_condition` 到 `data["condition"]`。在 `Trainer.preprocess_data`（`trainer.py:391`）而非 dataloader 内调用——仅 EDM/EDM2 实验用。

### InfiniteSampler iteration-based 训练

`InfiniteSampler`（`samplers.py:9`）用于 class-conditional `ImageLoader`——`__iter__` 无限循环（`samplers.py:35`），每 epoch 重新 shuffle，stride `num_replicas` 跨 rank 划分。扩散模型训练以 iteration 数（非 epoch）驱动，需无限数据流。WebDataset 路径不用 InfiniteSampler，用 `resampled=True`（`wds_utils.py:698`）或 `DeterministicWDS.slice`（`wds_utils.py:651`）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `BaseWDSLoader._create_loader` `wds_utils.py:468` | loader 创建骨架，`_pipeline` 子类实现 |
| 管道 | `WDSLoader._pipeline` `wds_dataloaders.py:381` + `AugmentPipe.process` | filter→decode→preprocess 串行 |
| 策略 | `ImageWDSLoader`/`VideoWDSLoader` `decoders` | 同接口不同解码策略 |
| 注册表 | `PRESET_CONSTANTS`/`PRESET_FILTERS` `wds_dataloaders.py:91/183` | 名称索引预设值/过滤函数 |

---

## 模块间交互

datasets 被 `configs.data` 引用（`LazyCall` 定义，扇入 59），`Trainer.run` 通过 `instantiate(config.dataloader_train)`（`trainer.py:166`）创建。dataloader 产出 `dict(real, condition, neg_condition)` → `Trainer.preprocess_data` 做 VAE/text encode → `FastGenModel._prepare_training_data`（`model.py:447`）提取 `real_data`/`condition`。`AugmentPipe` 在 `Trainer.preprocess_data` 调用，不在 dataloader 内。`ImageFolderDataset` S3 下载用 `utils.io_utils.s3_load` + `utils.distributed.synchronize`。

---

## 扩展方式

新增数据集格式：在 `decoders.py` 加 `decode_xxx(key, data)` 函数（检查扩展名→解码→返回 tensor），在 `WDSLoader.decoders` property 追加，在 `configs/data.py` 加 `LazyCall` config 模板。如需特殊 transform，继承 `WDSLoader` override `_preprocess`（参考 `VideoWDSLoader._preprocess` `wds_dataloaders.py:569`）。修改增强：在 `AugmentPipe.process`（`augment.py:344`）加 stage（选参数→执行→累积 condition label）。
