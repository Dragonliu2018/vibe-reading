---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "评测系统"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "评测", "SGLang", "LiveCodeBench"]
description: "sglang_eval.py in-process 评测入口、三阶段评分流水线、benchmark 加载与断点续跑"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/00-overview)

---

## 模块定位

评测系统是 PIPO 的端到端验证入口，兼做 OPD rollout 的产出方。`sglang_eval.py` 用 **in-process `sglang.Engine`**（不开 HTTP server）跑生成，支持 PIPO/EAGLE/常规三种路径；`pipo/eval/` 做三阶段后处理评分（规则→LiveCodeBench 执行→Excel 汇总）。它独立于训练——既验证加速后的 checkpoint 质量，也为数据构建与 OPD 提供 `results.jsonl`。

## 模块架构

- **`sglang_eval.py`（398 行）**：`main`（`L229`）解析 CLI → 构造 `engine_kwargs`（`enable_pipo`/`disable_radix_cache`/`PIPO_CONF_THRESHOLD`）→ `sgl.Engine(**kwargs)` → `load_datasets` → 逐题 `async_generate`（多 sample）→ 写 `*-results.jsonl`（原子写 `fcntl.LOCK_EX` + 断点续跑）→ 调 `pipo/eval/eval.sh`。
- **`benchmark_loader.py`（231 行）**：`load_datasets`/`list_datasets` 加载 AIME/GPQA/LiveCodeBench/LongBench/IFBench/codeforces，MCQ 题打乱选项。
- **`evaluator.py`（57 行）+ `eval_utils.py`（194 行）**：`evaluator_map` 按 dataset 分派 `MathEvaluator`/`MCQEvaluator`；`eval_utils` 提供去重/原子写/统计计算/LCB 格式转换。
- **三阶段**：`eval_1_rule.py`（规则评分 AIME/GPQA/LB2）→ `eval_2_lcb.sh`（LiveCodeBench 执行评分）→ `eval_3_export_to_excel.py`（跨 benchmark 平均 + `stats.xlsx`）。
- **`eval_openr1_codeforces.py`（693 行）**：codeforces 执行评分（`piston` 本地/HTTP，多进程），`eval_one_question`（graphify degree 14）是核心。

之所以用 in-process Engine 而非 HTTP server：避免网络开销、简化部署、与 OPD 训练器 colocate SGLang 的模式一致。

## 调用链路

```
sglang_eval.py:main (L229)
  ├─ get_args (L159)  --model_path/--enable_pipo/--pipo_conf_threshold/--enable_eagle/--datasets/--num_samples
  ├─ enable_pipo? → engine_kwargs{enable_pipo, disable_radix_cache=True}; os.environ["PIPO_CONF_THRESHOLD"]
  ├─ sgl.Engine(**engine_kwargs) (L312)  in-process 引擎
  ├─ load_datasets (benchmark_loader) → 逐题 async_generate ×num_samples → run_streaming
  ├─ 原子写 *-results.jsonl (fcntl.LOCK_EX) + 断点续跑(跳过已处理 dataset+micro_index)
  └─ 调 pipo/eval/eval.sh (除非 --skip_eval)
        ├─ eval_1_rule.py  规则评分(AIME/GPQA/LB2) → 回写 accuracies 到 jsonl
        ├─ eval_2_lcb.sh   LiveCodeBench(convert→执行→merge)
        └─ eval_3_export_to_excel.py  跨 benchmark 平均 → stats.xlsx
```

<details>
<summary>方法速查表</summary>

| 函数 | 一行职责 |
| --- | --- |
| `main` (sglang_eval.py:L229) | 评测入口：建引擎→生成→写→调 eval |
| `make_record` (sglang_eval.py:L56) | 构 result record（completion_texts/finished/n_tokens；accuracies=None 待填） |
| `load_datasets`/`list_datasets` (benchmark_loader.py) | 加载/列举数据集 |
| `evaluator_map` (evaluator.py) | 按 dataset 分派评分器 |
| `eval_one_question` (eval_openr1_codeforces.py:L316) | codeforces 执行评分（degree 14 god node） |
| `compute_statistics` (eval_utils.py:L90) | per-length-bucket 统计 |
| `reeval_record`/`export_excel` | 重评 + Excel 导出 |

</details>

## 核心实现

### PIPO engine 初始化

`sglang_eval.py` L287-290 启动 PIPO 推理路径时三件事：`engine_kwargs["enable_pipo"]=True`、`engine_kwargs["disable_radix_cache"]=True`（强制，required for correctness）、`os.environ["PIPO_CONF_THRESHOLD"]=str(args.pipo_conf_threshold)`（被 SGLang `tp_worker._pipo_conf_threshold` 读取）。`exp_name` 从采样参数构建，PIPO 启用时 append conf threshold。

### 断点续跑与原子写

`main` 从已存在的 `*-results.jsonl` 加载已处理 `(dataset, micro_index)` 对并跳过，支持 `--start_index`/`--end_index` 与 `--remaining_ratio_start`/`--remaining_ratio_end` 做部分评测。结果用 `fcntl.LOCK_EX` 文件锁原子写——支持多进程并行评测同一 dataset 不冲突。

### 执行型 vs 规则型评分

执行型 dataset（`codeforces`/`livecodebench`/`ifbench`）跳过规则评分，只存文本与 metadata——它们的正确性要跑代码判。其他 dataset 用 `evaluator.evaluator_map[dataset]` 抽答案 + 算 accuracy。LiveCodeBench 三步：`convert_jsonl_to_lcb_input` → 执行 → `merge_lcb_eval_into_jsonl` 回写 `accuracies`+`pass@k`。codeforces 由 `eval_openr1_codeforces.py` 跑 `piston`（本地编译/HTTP）多进程判，产 `codeforces-exec-statistics-*.json`（含 `micro_indices_sorted`/`all_pass1_sorted`），这个 JSON 不回写 results.jsonl，是 eval.sh 三阶段之外的补充路径，被 `build_*_data` 脚本消费。

### 三阶段后处理与 Excel

`eval_3_export_to_excel.py`（260 行）解析路径、跨 benchmark 平均、导出 `stats.xlsx`；`merge_stat_excels.py`（224 行）合并多个 stats.xlsx 做对比（ours 行左移一桶对齐）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `evaluator_map` (evaluator.py) | 按 dataset 分派评分器 |
| 流水线 | `eval.sh` 三阶段 | 规则→执行→汇总解耦 |
| 断点续跑 | load 已处理对跳过 (sglang_eval.py) | 长评测可中断恢复 |
| 原子写 | `fcntl.LOCK_EX` | 多进程并行不冲突 |

## 模块间交互

`sglang_eval.py` 消费 `pipo/qwen3_5` 模型（PIPO 路径经 SGLang `qwen3_5_pipo`）与 SGLang 引擎；`eval_2_lcb.sh` 调 `third_party/LiveCodeBench/lcb_runner`；`build_*_data` 脚本消费本模块的 `results.jsonl`（数据回流）。OPD 训练器 `_prepare_sglang_engine` 复用同样的 in-process + force PIPO 模式做 rollout。

## 扩展方式

- **新增 benchmark**：在 `benchmark_loader.py` 加 processor + 在 `evaluator_map`/`eval_utils` 加评分；`sglang_eval.py --datasets` 加名。
- **改 presence_penalty 默认**：`sglang_eval.py` 的 `--presence_penalty`（默认 1.5）。
- **改 PIPO gating**：`--pipo_conf_threshold`，`>=0` 启用门控，`<0` 总提交，`=1.0` 跳 Phase2。
