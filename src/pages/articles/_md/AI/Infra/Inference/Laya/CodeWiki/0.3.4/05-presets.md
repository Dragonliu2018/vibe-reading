---
source:
  type: "源码解读"
  project: "Laya"
  url: "https://github.com/NandhaKishorM/laya"
title: "应用预设"
date: "2026-09-21T00:15:00+08:00"
category: [AI, Infra, Inference, Laya, CodeWiki, "0.3.4"]
contentType: "CodeWiki"
tags: ["Laya", "预设", "邮件清洗", "guardrails", "分类"]
description: "laya/presets.py 与 laya/email.py 解读：五套开箱问题模板的 schema 设计与启发式邮件清洗流水线。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/00-overview)

---

## 模块定位

`laya/presets.py`（187 行）与 `laya/email.py`（90 行）构成**应用层**：前者把五类常见生产决策场景固化成问题模板，后者提供邮件输入的清洗与结构化。它们是全项目唯一**不含任何逻辑分支、不 import 任何内部模块**的代码——预设是"会返回新 dict 的函数"，每次调用都是独立拷贝，用户改返回值不影响他人。这个"纯模板"定位是有意为之：业务 schema 的变化频率远高于引擎，隔离它们让核心零改动。

## 模块架构

五套预设按业务域划分，每套都是"一个无参（或单参）函数返回问题字典"，与 `Agent.predict` / `Router.predict` 的 `questions` 参数直接对接：

| 预设 | 函数 | 业务场景 | 原语组合 |
| --- | --- | --- | --- |
| 工单分诊 | `triage_questions()` | 客服工单的意图/急迫度/挫败感/流失风险 | choice（`intent`）+ noul×3（`is_urgent` / `refund_requested` / `churn_risk`）+ score（`frustration` 四档） |
| 邮件分诊 | `email_questions(categories=None)` | 入站邮件的团队路由 + 垃圾/钓鱼过滤 | choice + noul×3 + score |
| 输入护栏 | `guard_questions()` | LLM 实时输入的越狱/注入/敏感数据检测 | noul×3 + score + choice |
| 内容审核 | `moderation_questions()` | 帖子的毒性/骚扰/威胁/垃圾 + 严重度 | noul×4（`toxic` / `harassment` / `threat` / `spam`）+ score（`severity` 四档） |
| 模型路由 | `router_questions()` | 请求难度/领域/工具需求 → 小大模型分派 | score（`difficulty` 四档）+ choice（`domain` 六域）+ noul×2（`needs_tools` / `is_sensitive`） |

`email.py` 与 `presets.py` 里各有一个 `email_questions()`（内容相同、`email.py:56` 的版本早于 presets 的收录）——历史双胞胎，公共 API 从 `presets` 导出（`__init__.py:16`）。

## 调用链路

预设的消费路径极短：`triage_questions()` 等返回 dict → 原样传给 `predict(state, questions)` → `_to_internal()` 规范化（`agent.py:230`）→ `render_options()` 渲染。邮件场景多一步前置：`email_state(subject, body, sender)` → `clean_email_body(body)` 清洗 → 组装成 `{"subject", "body", "from", ...}` state → 同上。链路细节见概览的[数据流](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/00-overview#核心运行流程)。

<details>
<summary>函数速查表</summary>

| 函数 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `triage_questions()` | 客服分诊五问 | instructions 用反引号锚定字段名（`` `message` ``） |
| `email_questions(categories)` | 邮件分诊五问，类目可覆盖 | 默认六类目 dict，传参即定制 |
| `guard_questions()` | 护栏五问 | `topic` 的 criteria 全 None（纯标签无描述） |
| `moderation_questions()` | 审核五问 | severity 四级 rubric 嵌入描述文本 |
| `router_questions()` | 大小模型路由四问 | difficulty 四级 + domain 六域 |
| `clean_email_body()` | 去引用/签名/免责声明 | 从 60% 处开始找签名（签名不会出现在正文前半） |
| `email_state()` | 组装邮件 state | None 值字段不入 dict |

</details>

## 核心实现

### 问题 schema 的写法约定

五套预设示范了三种原语的**全部典型写法**，这是用户自定义预设的事实标准：

```python title="laya/presets.py"
"intent": {
    "type": "choice",
    "instructions": "What does the customer want in `message`?",
    "criteria": {"refund": "money returned or a duplicate charge reversed", ...},
},
"frustration": {
    "type": "score",
    "instructions": "How frustrated does the customer sound in `message`?",
    "criteria": ["calm and neutral", "concerned but civil",
                 "clearly annoyed", "very angry or using strong language"],
},
"is_urgent": {"type": "noul", "instructions": "Does `message` communicate time pressure?"},
```

三个约定：instructions 里用反引号包裹字段名（`` `message` ``），把模型注意力锚定到 state 的具体字段；`choice` 的 criteria 是"标签 → 描述"dict（描述帮模型理解边界，纯标签场景可全传 None，`guard_questions()` 的 `topic` 即范例）；`score` 的 criteria 是**有序** rubric 列表——顺序本身就是语义（渲染成 `level 0: calm and neutral` …，`render_options()` in `common.py`）。`noul` 可以完全省略 criteria（默认 true/false 描述），也可像 `email_questions()` 的 `is_phishing` 那样显式给双档描述。

### clean_email_body：启发式清洗流水线

```python title="laya/email.py"
def clean_email_body(body: str, max_chars: int = 3000) -> str:
    for line in text.split("\n"):
        if any(p.match(line) for p in _QUOTE_HEADERS) and lines:
            break                                   # 1. 引用头即止（On ... wrote:）
        if line.lstrip().startswith(">"):
            continue                                # 2. 逐行引用直接丢弃
        lines.append(line.rstrip())
    cut = len(lines)
    for i in range(max(1, min(int(len(lines) * 0.6), len(lines) - 8)), len(lines)):
        if len(lines[i].strip()) <= 40 and any(p.match(lines[i]) for p in _SIGNATURE_MARKERS):
            cut = i                                  # 3. 从 60% 处起找签名行
            break
```

四类噪声各有针对性正则（`email.py:5-20`）：引用头四条模式（`On … wrote:` 行、`---- Original Message ----` / `---- Forwarded Message ----` 分隔线、8 个以上下划线的分隔线、`From:` 行）触发**截断**——引用头之后全是历史，整段丢弃比逐行过滤干净；`>` 前缀的逐行引用直接跳过；签名检测**只从正文 60% 处开始扫**（`len(lines) * 0.6`，且不超过倒数第 8 行）并要求行长短于 40——三条签名模式是 `--` 分隔线、`best/kind/warm/many thanks/thanks/thank you/regards/cheers/sincerely` 开头的致谢行、`sent from my iphone/android/mobile/ipad`，这类模式词在正文前半出现通常是内容而非签名，这个起点约束就是防误切的护栏；免责声明段落（`confidential`、`intended … for the … addressee/recipient`、`if you … received this e-mail/message in error` 的组合正则）按**段落级**剔除。返回前把行内空白压缩为单空格、段落以双换行拼接，最终压到 3000 字符（`max_chars`）。所有启发式的共同取向：宁可少删（保留噪声），不可多删（丢正文）——因为下游是分类决策不是逐字任务。

### email_state：None 不入 state

`email_state()` 的 `state.update({k: v for k, v in extra.items() if v is not None})` 把 None 字段挡在 state 外——空值字段会白白消耗 `max_len` 预算，而 `serialize_state()` in `common.py` 会把整个 dict 转 JSON 进序列。`clean=True`（默认）串联 `clean_email_body`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 原型（每次调用即拷贝） | `presets.py` 各函数 | 用户可安全改返回值，互不污染 |
| 参数化默认 | `email_questions(categories=None)` | 一处传参定制类目，不动其余问题 |
| 管线过滤 | `clean_email_body()` in `laya/email.py` | 四类噪声四道独立关卡，可读可测 |

## 模块间交互

**没有**内部交互——零 import（这正是模块独立性的全部内容）。对外只通过数据形状耦合：返回的 dict 必须符合 `_to_internal()` 的契约（`type` / `instructions` / `criteria` 三键）。`__init__.py` re-export 全部五个预设函数 + `clean_email_body` / `email_state`。`tests/test_criteria.py` 间接覆盖其渲染路径（结构化 criteria 值回归）。

## 扩展方式

- **新业务预设**：照 `triage_questions()` 的模式写一个返回问题字典的函数（三种原语写法见上），注册进 `__init__.py` 即完成——预设层对引擎完全透明。
- **定制邮件类目**：`email_questions(categories={"my": "描述", ...})` 单参数覆盖，无需子类或包装。
- **新输入域的清洗器**（如工单系统转义、聊天记录拼接）：仿照 `email.py` 的"正则表 + 管线函数"结构，产出一个扁平 state dict 即可接入。
