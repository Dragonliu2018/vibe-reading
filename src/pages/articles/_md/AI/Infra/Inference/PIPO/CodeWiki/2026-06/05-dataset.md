---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "数据构建"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "数据流水线", "SFT", "蒸馏数据"]
description: "从 9B teacher rollout 构建 SFT/RL 数据、缓存 dataset 与 swift_plugin 的 max_length 补丁"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/00-overview)

---

## 模块定位

`pipo/dataset/` 把 9B teacher 的 rollout 结果构造成训练数据。它独立于训练框架——上游消费 `sglang_eval.py` 产出的 `*-results.jsonl`（含 accuracy，由评测回流填入），下游产出 SFT/RL 的 JSONL 给 `swift_sft.sh`/`swift_opd.sh`。核心是两套 builder（SFT 选最短正确 completion 作 assistant response；RL 只留 user prompt，让 student 自己 rollout），加一层缓存避免重复 tokenize。

## 模块架构

- **`build_sft_data_on_results_jsonl.py`（452 行）**：`main`（`L370`）按 `SFT_SOURCE_REGISTRY`（`L336`）分派到 `build_rows_dapo_math`/`build_rows_codeforces`，用 `_pick_shortest_correct`/`_pick_all_correct` 选正确 completion，组装 ms-swift `{"messages":[user,assistant]}` 格式。
- **`build_rl_data_on_results_jsonl.py`（368 行）**：`main`（`L285`）按 `RL_SOURCE_REGISTRY`（`L254`）分派，`avg_acc >= acc_threshold`（默认 0.5）才保留，只输出 `{"messages":[user],"source":...,"source_index":...}`——无 assistant response。
- **`swift_sft_dataset.py`（60 行）**：`SFTDataset` 从缓存 parquet 读 `text`/`prompt_length`，`__getitem__` tokenize 并把 prompt 部分_labels 设 -100。
- **`export_cached_dataset.sh`**：调 `swift export --to_cached_dataset true` 预 tokenize 成 parquet。

两组 builder 用策略表分派不同 dataset 的特有处理（dapo_math 的 accuracy 直接在 jsonl；codeforces 需额外 exec stats JSON）。

## 调用链路

```
sglang_eval.py (9B teacher rollout) → {dataset}-results.jsonl (completion_texts, finished, n_tokens; accuracies 待填)
  → pipo/eval/eval.sh 回填 accuracies (eval_utils.merge_lcb_eval_into_jsonl 等) + 生成 codeforces-exec-statistics-*.json
build_sft_data_on_results_jsonl.py:main (L370)
  ├─ infer_dataset_name(jsonl_path) → "dapo_math" / "codeforces"
  ├─ SFT_SOURCE_REGISTRY 查 spec{builder, needs_stats}
  ├─ needs_stats(codeforces)? → resolve_codeforces_stats_path + 读 exec stats
  ├─ builder: load_jsonl_by_micro_index → 逐题 _pick_shortest_correct → messages_from_chat
  └─ write_swift_sft_jsonl → {"messages":[user,assistant]} 每行
export_cached_dataset.sh: swift export --to_cached_dataset true → data/*.jsonl.cache/train (parquet)
  → swift_sft.sh --cached_dataset 加载 → PIPOSeq2SeqTrainer.compute_loss
```

RL 路径类似但 `_pick` 换成 `compute_average_accuracy(record) >= acc_threshold`，输出无 assistant。

<details>
<summary>方法速查表</summary>

| 函数 | 一行职责 |
| --- | --- |
| `infer_dataset_name` (L42) | 从 `<dataset>-results.jsonl` 推断 dataset 名 |
| `load_jsonl_by_micro_index` (L62) | 按 micro_index 去重加载 |
| `_pick_shortest_correct` (L173) | 在正确且 finished 的 completion 中选最短 |
| `messages_from_chat` (L84) | 组装 ms-swift `{"messages":[user,assistant]}` |
| `compute_average_accuracy` (rl:L116) | 单题所有 completion 的平均 accuracy |
| `resolve_codeforces_stats_path` (L157) | 自动发现 codeforces exec stats JSON |

</details>

## 核心实现

### SFT vs RL 数据格式差异

| 字段 | SFT | RL |
| --- | --- | --- |
| `messages` | `[user, assistant]` 两条 | `[user]` 一条（无 assistant response） |
| `source`/`source_index` | 无 | `"dapo_math"`/`"codeforces"` + `micro_index` |
| 选择策略 | per-completion（选最短正确或全部） | per-question（`avg_acc >= threshold`） |

SFT 含完整 user+assistant 对——直接监督学习；RL 只留 user prompt——student 自己 rollout 生成 response，不需要预置答案。RL 的 `source`/`source_index` 用于 OPD 训练追踪题目来源。

### 为何从 9B teacher rollout 构数据

原数据集只有题目（user prompt），无高质量 assistant response。PIPO 用 9B teacher rollout 生成多个 completion，经评测筛选正确者，选**最短正确答案**作 SFT target——最短正确答案信息密度高、冗余少，减少训练时无谓生成长度。`--length all` 选项则保留所有正确 completion 增加多样性。RL 只选 teacher 通过率够高的题（`avg_acc >= 0.5`）——若 teacher 在某题全错，student 学不到有效 reward 信号。

### 为何缓存 dataset

长 CoT 序列 tokenize 是 CPU 密集型，Qwen3.5 一次可能数十分钟。`export_cached_dataset.sh` 调 `swift export --to_cached_dataset true` 预 tokenize 成 parquet（含 `text`、`prompt_length` 列），`swift_sft.sh --cached_dataset` 直接加载，跳过每次 run 重复 tokenize。`SFTDataset.__getitem__` 仍需一次 tokenize（parquet 存的是文本），但已省掉"JSONL→messages→template→tokenize"完整预处理链。

### swift_plugin 的 max_length 补丁

`swift_plugin._patch_cached_dataset_max_length`（`L15-98`）是关键 monkey-patch：ms-swift 默认在加载 cached dataset 时按 `max_length` 过滤掉超长样本，使数据集大小随 `max_length` 变。PIPO 希望数据集大小不变，让 truncation 在训练时由 `LazyLLMDataset` 完成（`--truncation_strategy right`）。补丁临时把 `args.max_length` 设 `None` 绕过过滤。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `SFT_SOURCE_REGISTRY`/`RL_SOURCE_REGISTRY` + builder 函数 | 按 dataset 分派不同处理 |
| 缓存 | `export_cached_dataset.sh` + parquet | 避免重复 tokenize |
| 流水线 | rollout→eval→build→cache→train | 数据闭环 |

## 模块间交互

上游消费 `sglang_eval.py` 的 `*-results.jsonl`（accuracy 由 `pipo/eval` 回流填入，codeforces 额外有 `eval_openr1_codeforces.py` 产 exec stats JSON）。下游 SFT JSONL 经 `export_cached_dataset.sh` 缓存后由 `swift_sft.sh --cached_dataset` 加载，喂给 `PIPOSeq2SeqTrainer`；RL JSONL 由 `swift_opd.sh --dataset` 加载喂给 `PIPOGKDTrainer`。`SFTDataset` 是 standalone 备用 Dataset 类（ms-swift 内部用自己的 dataset 类加载 cached parquet）。

## 扩展方式

- **新增数据源**：在 `build_sft_data_on_results_jsonl.py` 加 `build_rows_xxx`，在 `SFT_SOURCE_REGISTRY` (L336) 注册；RL 侧同理（`RL_SOURCE_REGISTRY` L254，dataset 名带 `_rl` 后缀）。确保 `sglang_eval.py` rollout 输出符合 `<dataset>-results.jsonl` 命名。
- **改 SFT prompt 模板**：改 `messages_from_chat` (L84)，如加 system prompt。同步检查 `export_cached_dataset.sh:10` 的 `--add_non_thinking_prefix false`。
- **调 RL 筛选策略**：改 `compute_average_accuracy` (rl:L116) 或 threshold（`build_rl_data_on_results_jsonl.py:147-149`），如从 accuracy 改 pass@k。
