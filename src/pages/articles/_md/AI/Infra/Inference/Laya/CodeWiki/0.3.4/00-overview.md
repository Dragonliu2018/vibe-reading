---
source:
  type: "源码解读"
  project: "Laya"
  url: "https://github.com/NandhaKishorM/laya"
title: "Overview"
date: "2026-09-21T00:15:00+08:00"
category: [AI, Infra, Inference, Laya, CodeWiki, "0.3.4"]
contentType: "CodeWiki"
tags: ["Laya", "Python", "决策模型", "RLCD", "多语言"]
description: "Laya v0.3.4 源码解读概览：非自回归 System 1 决策引擎的整体架构、三检查点路由与模块地图。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.3.4 · **协议** Apache-2.0 · **语言** Python ≥ 3.8 · **代码量** ~1,435 行（`laya/` 包）+ 训练 notebook ~600 行 · **仓库** [GitHub](https://github.com/NandhaKishorM/laya)

---

## 总览

### 项目简介

Laya 是 Convai Innovations 开源的**非自回归 System 1 决策引擎**：对任意 state（文本、邮件、工单或 JSON 文档）上定义的类型化问题（`choice` / `score` / `noul`）在**单次编码器前向**内给出带校准概率的决策——单问 33 ms、批处理 7.2 ms/问（T4 实测）。它不生成文本，因此没有输出可解析、没有幻觉空间，适合做分流、分级、风控这类"要一个结构化判断而不是一段话"的场景。

训练侧用**强化学习 + 严格正当评分规则**（RLCD，`proper_reward` in `laya/common.py`）替代普通交叉熵，使输出的概率分布本身成为优化目标——这是它敢于把 `confidence` 直接暴露给业务做自动化门控的底气。推理侧由 `Router`（`laya/router.py`）在三个检查点之间按请求选择：英文（ModernBERT-large, 421M）、多语言（mmBERT-base, 322M, 100+ 语言）、typed-decisions 微调版（421M）。

**项目当前边界**：Laya 负责"类型化决策"这一件事；它不负责文本生成、不负责零样本通用推理——README 的 Honest limits 一节明确承认 base 检查点在 typed-decisions 上零样本接近随机（0.362 vs 0.318 随机基线），全部能力来自微调。它是"快速可专化的底座"，高基数选项（>20 选）也是已知短板。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 三种决策原语 | `laya/common.py` | `choice`（多选一）/ `score`（序数分级）/ `noul`（P(true) 校准概率） |
| 单次前向多问并行 | `laya/agent.py` 的 `system_one()` | 所有问题拼成一个 batch，一次 forward 全部回答 |
| 三检查点路由 | `laya/router.py` 的 `Router.route()` | script/语言检测 + 显式覆盖，带 reason 元数据 |
| 无依赖语言检测 | `laya/lang.py` | 26 组 Unicode 区块 + 7 语停用词启发式，纯 Python 微秒级 |
| 应用预设 | `laya/presets.py` | triage / email / guard / moderation / router 五套问题模板 |
| 邮件清洗 | `laya/email.py` | 去引用、签名、免责声明，构造 `email_state` |
| RLCD 微调 | `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb` | GRPO 式策略梯度 + 严格正当评分规则 + 温度校准 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| torch ≥ 2.0 | 核心 | 模型前向、autocast 混合精度、张量组装 |
| transformers ≥ 4.45 | 核心 | `AutoModel` / `AutoTokenizer` 加载 ModernBERT / mmBERT 编码器 |
| safetensors | 核心 | 检查点权重加载（`load_file` in `laya/agent.py`） |
| huggingface_hub | 核心 | `snapshot_download` 按需下载检查点（支持 subfolder 前缀过滤） |
| numpy | 核心 | 推理后概率运算（softmax / 期望分数） |

值得注意的"零依赖"设计：语言检测（`laya/lang.py`）不依赖 langdetect / fasttext / polyglot 任何第三方库——路由只需要一个二分决策，作者为此手写了检测器（见[语言检测](#模块地图)模块文档）。

### 版本历史

v0.3.4（解读基线）将 **Route Mode 提升为 README 首选 Quickstart**——路由从可选特性变成推荐入口，反映出"英文检查点在非拉丁文字上崩溃"这一事实已被定位为产品级问题（v0.3.x 系列持续补齐：tokenizer 跨版本自愈、LRU 生命周期、workflow 指纹匹配、criteria 结构化值渲染修复）。项目整体仍处 Beta（`Development Status :: 4 - Beta`）。

---

## 快速上手

```bash
pip install laya
```

```python title="quickstart.py"
from laya import Router

router = Router(preload=True)          # 三个检查点常驻内存，路由只花微秒

state = {"body": "I was billed twice for March. Please refund today."}
questions = {
    "department": {"type": "choice", "instructions": "Which department?",
                   "criteria": {"billing": "invoices, payments, refunds",
                                "technical": "bugs, outages",
                                "other": "everything else"}},
    "urgent": {"type": "noul", "instructions": "Is this urgent?"},
}

res = router.predict(state, questions)
print(res["answers"]["department"]["choice"])   # -> billing
print(res["answers"]["department"]["confidence"])  # -> 0.94（归一化熵置信度）
print(res["routing"]["model"])                 # -> english（含路由理由）
```

预期输出：`department` 得到 `billing` 与逐选项概率；同一段代码换成印地语 state，`routing["model"]` 自动变为 `multilingual` 且理由写明 `non-Latin script (devanagari, ...)`。首次运行会从 Hugging Face Hub 下载权重（数百 MB）；纯 CPU 也能跑（193–464 ms/问），无 GPU 不阻塞验证。

---

## 架构设计解析

### 系统架构

Laya 的核心架构思想是**把"决策"从生成式范式里剥离出来**：LLM 做分类要先构造 prompt、逐 token 自回归、再解析输出——每一步都引入延迟和不确定性；Laya 把选项文本直接编进输入序列（每个选项前插一个 MASK token，见[决策模型](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model)），让**双向编码器在 MASK 位上打分**，一次前向同时得到所有选项的 logit。代价是它只能回答"在给定选项空间上的分布"，换来的是 33 ms、零解析、可校准。

第二层思想是**路由先于前向**：英文检查点在非拉丁文字上不是优雅降级而是崩溃（高棉语 0.000 准确率 @ 0.952 置信度——模型错得很有把握，置信度门控救不了），所以语言判断必须在 forward 之前、由确定性代码完成，而不是事后看模型自己的置信度。

![Laya 分层架构](/vibe-reading/images/articles/laya-internals/architecture.svg)

四层职责与依赖方向自上而下：应用预设层提供开箱问题模板（纯数据，无内部依赖）；路由决策层检测语言并分派检查点；推理运行时层负责加载、设备降级与单次前向编排；模型核心层承载架构与序列构造；底层是外部依赖。图中虚线表示预设层的 `state+questions` 不经过路由层逻辑、直接作为 `system_one` 的输入。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 应用预设层 | `laya/presets.py`, `laya/email.py` | 把"常见业务问题"固化为可复用模板，隔离业务 schema 与模型输入格式 |
| 路由决策层 | `laya/router.py`, `laya/lang.py` | 在前向之前做出确定性的检查点选择，防英文检查点静默崩溃 |
| 推理运行时层 | `laya/agent.py` | 隔离加载/设备/降级等脏细节，给上层一个稳定的 `predict` 契约 |
| 模型核心层 | `laya/common.py` | 承载模型架构与序列构造，不依赖任何上层 |
| 外部依赖 | — | 适配 PyTorch / transformers / Hub，可替换 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 + 策略路由 | `Router.predict()` in `laya/router.py` | 一个入口掩盖"三检查点选谁"的分派细节，路由判据可插拔（model/task/lang/script 四级覆盖） |
| LRU 缓存 + 延迟加载 | `Router.load()` / `_evict()` in `laya/router.py` | 三个检查点共 ~1.16B 参数不可能全驻留时，按 `max_loaded` 驱逐最久未用者 |
| 别名注册表 | `_ALIASES` + `normalise_name()` in `laya/router.py` | 容忍 `en`/`multi`/`typed` 等用户习惯写法，集中一处归一化 |
| 依赖注入（attach） | `Router.attach()` in `laya/router.py` | 进程已有同款检查点时注入实例，避免第二份 421M 参数重复占显存 |
| 模板数据 + 注册 | `presets.py` 各 `*_questions()` | 预设即函数，调用即拷贝，用户可改返回值不影响他人 |
| 自愈适配器 | `_fix_tokenizer_config()` in `laya/agent.py` | 加载时就地修复 tokenizer_config 的跨 transformers 版本不兼容字段 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Agent` | 单检查点推理运行时（`agent.py`），别名 `RLAgent` | 构造时加载权重，进程内常驻 | 持有 `DecisionModel`、tokenizer、temperature 表 |
| `Router` | 三检查点分派器 + LRU 容器（`router.py`） | 长生命周期，按需加载/驱逐 `Agent` | 组合 1..3 个 `Agent`，调用 `lang.analyse` |
| `RouteDecision` | 路由结果（dict 子类，`router.py`）：model/repo/reason/detection/workflow | 单请求 | 由 `route()` 产出，随结果返回 |
| `DecisionModel` | 编码器 + 决策头（`common.py`） | 随 Agent | 包装任意 `AutoModel` 编码器 |
| 问题定义 dict | `{"type", "instructions", "criteria"}` | 单请求 | `_to_internal()` 规范化后交 `build_sequence` |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| 三种问题原语（`QTYPES`） | `laya/common.py` | `choice` / `score` / `noul` | dict 常量，`render_options()` 按类型分发 |
| 编码器可替换 | `DecisionModel.__init__()` 的 `encoder` 参数 | ModernBERT-large、mmBERT-base | `build_model()` 从 `rl_agent_config.json` 的 `encoder` 字段构造 |
| 检查点可注册 | `Router.__init__(models=...)` | 三个官方 + 用户自定义路径 | `DEFAULT_MODELS` / `STANDALONE_MODELS` + `normalise_name` |

---

## 代码目录

```
laya-repo/
├── laya/                    # 包本体（~1,435 行）
│   ├── __init__.py          # 公共 API 汇出（51 行）
│   ├── common.py            # 模型架构 + 序列构造 + 评分规则（251 行）
│   ├── agent.py             # Agent 推理运行时（360 行）
│   ├── router.py            # Router 路由与 LRU（314 行）
│   ├── lang.py              # script/语言检测（182 行）
│   ├── presets.py           # 五套应用预设（187 行）
│   └── email.py             # 邮件清洗工具（90 行）
├── notebooks/
│   └── laya_finetune_typed_decisions_2xT4_kaggle.ipynb   # RLCD 微调全流程
├── tests/                   # 三套测试（无 pytest 框架，裸 assert 脚本）
│   ├── test_criteria.py     # criteria 渲染回归（无权重）
│   ├── test_router.py       # 路由/检测/LRU（无权重，stub Agent）
│   └── test_local_e2e.py    # 端到端（需本地权重）
├── assets/                  # logo 与基准图
├── BENCHMARKS.md            # 基准明细（51 语言逐语言数据）
└── pyproject.toml           # 包定义（v0.3.4）
```

特殊点：`research/` 目录（基准 JSON 结果）不在发布包里，只在 README/BENCHMARKS 中被引用。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/laya-internals/module-dependencies.svg)

依赖方向非常干净：`router → lang`（检测）与 `router → agent`（`load()` 内**延迟 import**，避免导入 laya 就触发 torch 加载）、`agent → common`（构造序列与模型）。`presets` / `email` 是纯模板，不 import 任何内部模块——这保证了它们可以被单独复制进用户代码。`__init__.py` 只做 re-export，构成稳定的公共 API 面。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| [决策模型](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model) | 模型架构、token 序列构造、评分规则 | `DecisionModel.forward()` | 纯数学与张量逻辑，不碰 IO/设备 | [01-decision-model](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model) |
| [推理运行时](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/02-agent-runtime) | 检查点加载、设备降级、单次前向编排 | `Agent.system_one()` | 加载/降级/精度全是工程脏活，与模型定义解耦 | [02-agent-runtime](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/02-agent-runtime) |
| [模型路由](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/03-router) | 检查点选择与 LRU 生命周期 | `Router.route()` / `predict()` | 路由判据与缓存策略独立演进，且是纯函数可单测 | [03-router](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/03-router) |
| [语言检测](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/04-language-detection) | script 精确检测 + 拉丁语系启发式 | `analyse()` | 被设计为无依赖微秒级，是路由的前置信号源 | [04-language-detection](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/04-language-detection) |
| [应用预设](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/05-presets) | 五套问题模板 + 邮件清洗 | `triage_questions()` 等 | 纯数据层，零内部依赖，业务向 | [05-presets](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/05-presets) |
| RLCD 训练与温度校准（深度附件） | 微调循环、评分奖励、校准 | notebook `train_ddp.py` | 训练逻辑不进运行时包，只共享 `common.py` 原语 | [01-decision-model-rlcd-training](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model-rlcd-training) |

模块间的动态调用顺序见下方「核心运行流程」的链路一；LRU 驱逐/预载的运行时行为见[模型路由](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/03-router)。

---

## 运行时行为

### 启动流程

以推荐的 `Router(preload=True)` 为例，装配链如下（各步文件与职责）：

```
Router.__init__(preload=True)                    # laya/router.py
├─ self.models = dict(DEFAULT_MODELS)            #   三个 (repo, subfolder) 规格表
├─ self._agents / self._order = {}, []           #   LRU 容器与顺序表初始化
└─ self.preload()
    ├─ max_loaded 抬升到覆盖全部预载项           #   防 LRU 立刻驱逐刚建的模型
    └─ self.load(name) × 3
        ├─ Agent(repo, subfolder=...)            #   laya/agent.py
        │   ├─ snapshot_download(allow_patterns) #     只下载该 subfolder
        │   ├─ _fix_tokenizer_config()           #     就地修复跨版本字段
        │   ├─ 读 rl_agent_config.json            #     max_len/head_max_len/temperature
        │   ├─ build_model()                     #     AutoModel + DecisionModel 头
        │   ├─ _verify_compatibility()           #     权重前缀/形状/缺失键校验
        │   └─ 设备解析 → .to(device) → eval()   #     OOM 则降级 CPU + 打印原因
        └─ self._evict()                         #   维持 max_loaded 上限
```

对象装配的关键决策：**没有 DI 容器，全部显式构造**——`Router` 组合 `Agent`，`Agent` 组合 `DecisionModel` + tokenizer + cfg dict。配置的单一真源是检查点目录里的 `rl_agent_config.json`（`max_len`、`head_max_len`、`temperature`、`temperature_by_options`），运行期可改（README 的 Banking77 处方就是改 `agent.cfg["head_max_len"] = 512`）。token 认证从 `HF_TOKEN` 环境变量兜底（`Router.__init__` 与 `Agent.__init__` 各自读取）。

### 核心运行流程

以下三条链路覆盖了日常运行的几乎全部路径：一条主干（路由推理），两条关键支线（加载降级、检测判据）。

#### 主链路：Router.predict 路由 + 单次前向

业务流程：用户提交 state + 问题字典 → 检测/覆盖判据选出检查点 → LRU 取出（或加载）Agent → 所有问题拼 batch 单次前向 → 逐问题温度缩放输出类型化答案 + 置信度 + 路由元数据。

![端到端数据流](/vibe-reading/images/articles/laya-internals/data-flow.svg)

文字描述：`route()`（`router.py`）按五级优先级（显式 model > task > workflow 指纹 > lang > script 检测）产出 `RouteDecision`；`load()` 命中 LRU 或触发下载构造；`system_one()`（`agent.py`）先把问题字典经 `_to_internal()` 规范化，`build_sequence()` 产出 `ids + markers`（每个选项一个 MASK 位），`collate_items()` 拼成带 padding 的批张量；`DecisionModel.forward()` 返回 `logits[N,k]` 与 act_logits；最后按 `temp_bucket(qtype, k)` 分桶取温度做 softmax，`confidence_from_probs()` 算归一化熵置信度，按问题类型组装 `choice`/`score`（期望分数）/`noul`（P(true)）三种答案。设计上的关键点：**多问并行不靠循环而靠 batch 维**——10 个问题是一次 forward 的 batch=10，这就是 7.2 ms/问的来源。

#### 支线一：检查点加载与两级降级

业务流程：构造 Agent → 下载/校验/构型 → 上设备（失败则 CPU 降级）→ 推理中 OOM 再降级一次。

![Agent 加载链](/vibe-reading/images/articles/laya-internals/agent-load.svg)

文字描述：见上图标注。两级降级分别在 `Agent.__init__`（`.to(device)` 抛 OOM → 转_cpu + fp32 + 打印原因与夜间版 torch 安装建议）和 `system_one()` 内（前向 OOM → 同样落 CPU 重跑）。细节展开在[推理运行时](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/02-agent-runtime)模块文档。

#### 支线二：语言/文字检测判据

业务流程：任意嵌套 state → 收集字符串叶子 → Unicode 区块计数定 script → 拉丁字母再走停用词启发式 → 二分结论 english / multilingual。

![语言检测流程](/vibe-reading/images/articles/laya-internals/script-detection.svg)

文字描述：`state_text()` 忽略 dict 的 key（通常是英文字段名）只取值；`detect_script()` 对 26 组 Unicode 区块精确计数取众数；`guess_latin_language()` 用 7 语停用词加权计分，要求非英语以 `max(2, en+2)` 的**安全边际**胜出才判非英语——保证普通英语永不误路由。细节见[语言检测](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/04-language-detection)。

---

## 典型修改场景

#### 场景 1：新增一套应用预设（如工单优先级模板）

- 新增 `laya/presets.py` 中的 `def ticket_priority_questions()`，返回问题字典（模式照抄 `triage_questions()`）
- 在 `laya/__init__.py` 的 import 与 `__all__` 中注册导出
- 对应测试：`tests/test_criteria.py` 的模式（若含结构化 criteria 值）

#### 场景 2：新增第四个检查点进路由

- `laya/router.py`：`DEFAULT_MODELS` 加 `"name": (repo, subfolder)`；`_ALIASES` 加习惯别名
- `normalise_name()` 无需改（自动接受新 key）；若要参与 workflow 指纹，`_TYPED_DECISION_WORKFLOWS` 加签名集合
- 对应测试：`tests/test_router.py`（stub Agent 即可验证，不下载权重）

#### 场景 3：支持高基数选项（50+ 选项的 choice）

- 运行时调参：`agent.cfg["head_max_len"] = 512`、`agent.cfg["max_len"] = 1024`（README "Honest limits" 的处方，无代码改动）
- 或改默认值：训练/检查点的 `rl_agent_config.json`（`common.py` 的 `build_sequence()` 读这两个参数）
- 若做两步粗到细分层选择，则在上层自编排两次 `predict`，Laya 本体不需要改

---

## 测试体系

```
tests/
├── test_criteria.py      # 单元：criteria 渲染回归（PR #2 修复的 dict 值崩溃）
├── test_router.py        # 单元：script/语言检测、路由优先级、LRU（stub Agent，零权重）
└── test_local_e2e.py     # 端到端：真权重真前向（默认 ~/laya_models）
```

| 代码层 | 测试类型 |
| --- | --- |
| `common.py` 渲染逻辑 | `test_criteria.py`（单元，毫秒级） |
| `router.py` + `lang.py` | `test_router.py`（单元，stub 注入 `Router.attach`） |
| `agent.py` + 全链路 | `test_local_e2e.py`（E2E，需下载权重） |

三层都没有用 pytest——是自包含的 `PASS/FAIL` 断言脚本（`check()` 函数累加结果），直接 `python3 tests/test_router.py` 运行。想理解路由行为，优先读 `test_router.py`：它用 `_Stub` 类演示了 `attach` 注入测试替身的标准姿势。

---

## 阅读源码推荐路线

- 第一遍：理解主流程（一天可读完的量）
  `laya/router.py` 的 `Router.predict()` → `route()` → `laya/agent.py` 的 `Agent.system_one()` → `laya/common.py` 的 `build_sequence()` → `DecisionModel.forward()`
- 第二遍：理解核心数据结构
  `laya/common.py` 的 `QTYPES` / `render_options()`（三种原语如何变成选项文本）→ `collate_items()`（markers 如何变成 `marker_pos`/`marker_mask` 张量）→ `confidence_from_probs()`
- 第三遍：理解路由机制与工程韧性
  `laya/lang.py` 的 `detect_script()` + `guess_latin_language()`（边际设计）→ `laya/router.py` 的 `_evict()` / `preload()` → `laya/agent.py` 的 `_fix_tokenizer_config()` / `_verify_compatibility()`（两处自愈）
- 第四遍：理解训练侧（可选深入）
  `laya/common.py` 的 `proper_reward()`（评分奖励）→ `notebooks/` 的 `train_ddp.py` cell（GRPO 循环 + `fit_one_temp` 校准），配合[RLCD 训练深度附件](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model-rlcd-training)

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| System 1 决策 | 借 Kahneman 双系统术语：快速、直觉型判断（对应此处单次前向），区别于自回归生成的 System 2 推理 |
| `noul` | Laya 自造词的第三种原语：无选项的二值判断，输出校准的 P(true) |
| RLCD | README 原文 "reinforcement learning against strictly proper scoring rules (RLCD)"：用严格正当评分规则当奖励做强化学习 |
| 严格正当评分规则 | 数学性质：期望得分只在报告真实分布时最大（log score / spherical score / RPS 都是） |
| RPS | Ranked Probability Score，对序数（score 型）分布的 CDF 距离惩罚 |
| ECE | Expected Calibration Error，置信度分桶后 |置信度 − 实际准确率| 的加权平均，越低越校准 |
| marker | 序列里每个选项前的 MASK token 位，`marker_pos` 记录其索引，scorer 只在这些位打分 |
| `head_max_len` | 序列头部（问题 + 全部选项）的 token 预算，english 192 / multilingual 256 |
| GRPO | Group Relative Policy Optimization：同 prompt 采一组样本、组内归一化优势的策略梯度 |
| mmBERT | 多语言 mmBERT-base 编码器（laya-multilingual 检查点用，1024 token 上下文） |

### 参考资料

- [Laya GitHub 仓库](https://github.com/NandhaKishorM/laya)（解读基线 v0.3.4）
- [BENCHMARKS.md](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md)：51 语言逐语言基准明细
- [Hugging Face 模型页](https://huggingface.co/convaiinnovations/laya)：三检查点权重
- [作者工程复盘（Dev.to）](https://dev.to/nandakishor_m_6cc0adfde9f/i-built-non-autoregressive-decision-models-a-year-ago-then-a-frontier-lab-called-it-a-18me)
