---
source:
  type: "源码解读"
  project: "Laya"
  url: "https://github.com/NandhaKishorM/laya"
title: "语言检测"
date: "2026-09-21T00:15:00+08:00"
category: [AI, Infra, Inference, Laya, CodeWiki, "0.3.4"]
contentType: "CodeWiki"
tags: ["Laya", "Unicode", "语言检测", "路由", "启发式"]
description: "laya/lang.py 解读：26 组 Unicode 区块的精确 script 检测、7 语停用词加权启发式与保守路由边际设计。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/00-overview)

---

## 模块定位

`laya/lang.py`（182 行）是**路由的前置信号源**：为"这个 state 英文检查点读不读得懂"这一个二分决策提供判据。模块 docstring 开宗明义地缩小了问题域——不需要识别 100 种语言，只需要回答"是英语拉丁文本，还是英文检查点读不了的东西"。这决定了它的两个信号层级：script 检测是**精确的**（Unicode 区块计数），拉丁语系判断是**尽力而为的停用词启发式**（拿不准就当英语）。

它被刻意写成**零第三方依赖**的纯 Python（无 langdetect / fasttext）：路由路径上每请求都要跑，微秒级是硬指标（README 实测 <0.5 ms）；且外部语言检测库的依赖树会把一个轻量推理包拖重。

## 模块架构

四个函数构成自顶向下的漏斗，公共入口是 `analyse()`：

![语言检测流程](/vibe-reading/images/articles/laya-internals/script-detection.svg)

`state_text()` 先把任意嵌套 state 拍平成一段文本；`script_profile()` / `detect_script()` 在 Unicode 区块上计数；拉丁字母才进入 `guess_latin_language()` 的停用词启发式；`is_english()` 是二分便捷包装。`analyse()` 汇总输出五元组：`script` / `script_profile` / `language` / `is_english` / `non_latin_fraction`——`Router.route()` 只消费其中三个字段。

## 调用链路

`Router.route()` → `analyse(state)` → `state_text()`（`_iter_text` 递归收集字符串叶子，深度限 6 层，截 4000 字符）→ `script_profile()` + `detect_script()`（一趟遍历同时算）→ 分支：非拉丁直接返回 `is_english=False`；拉丁则 `guess_latin_language()` 给出语言码或 None。`detect_script` 与 `script_profile` 是同一段计数逻辑的两种视图（众数 vs 比例），`analyse` 里先后各调一次——**纯函数无状态，重复计算换代码清晰**。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `_iter_text()` | 递归收集 state 的字符串叶子 | 深度限 6 防循环引用炸栈 |
| `state_text()` | 拼接 + 截 4000 字符 | 忽略 dict key（字段名通常是英文） |
| `detect_script()` | 众数 script | 无字母返回 `"unknown"` |
| `script_profile()` | 各 script 占比 | 供 `non_latin_fraction` 计算 |
| `guess_latin_language()` | 拉丁文本语言码（或 None） | 非 英需 `max(2, en+2)` 边际胜出 |
| `analyse()` | 汇总五元组 | unknown 保守视为 is_english=True |
| `is_english()` | 二分便捷包装：`bool(analyse(state)["is_english"])` | 路由判据的直接消费形态 |

分词用 `_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)`——匹配纯字母词（排除数字与下划线），`guess_latin_language()` 以 `_WORD.findall(text)` 提取并转小写后与停用词表比对。变音符信号来自 `_NON_EN_DIACRITICS` 字符集（`àâäãáåçéèêëíìîïñóòôöõøúùûüýÿßæœđłşţğıåäö`），`diac_rate = 命中字符数 / len(text.lower())`，2%（0.02）以下视为无变音符证据。

</details>

## 核心实现

### script 检测：26 组 Unicode 区块的精确计数

```python title="laya/lang.py"
_SCRIPT_RANGES = [
    ("greek",  ((0x0370, 0x03FF), (0x1F00, 0x1FFF))),
    ("hangul", ((0x1100, 0x11FF), (0x3130, 0x318F), (0xAC00, 0xD7AF))),
    ("han",    ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))),
    ...  # 共 26 组
]

def detect_script(text: str) -> str:
    for ch in text:
        if not ch.isalpha():
            continue
        cp = ord(ch)
        if cp < 0x0250 or 0x1E00 <= cp <= 0x1EFF:      # Latin + Latin Extended Additional
            latin += 1
            continue
        for name, ranges in _SCRIPT_RANGES:
            if any(lo <= cp <= hi for lo, hi in ranges):
                counts[name] = counts.get(name, 0) + 1
```

覆盖的选择性本身就是论点：列出的 26 组恰好是 **ModernBERT 的 50k 英文 BPE 词表读不了的**文字系统（docstring 原话）。拉丁的判定不只是"基本拉丁区块"——`cp < 0x0250` 连 IPA 扩展也算进拉丁（英文检查点对音标文本也不会全盲），外加 Latin Extended Additional（越南文等）。取**计数的众数**而非"出现即判"：一段夹英文技术词的日文正文不会被几个拉丁字母带偏。`script_profile()` 返回的比例派生出 `non_latin_fraction`，正是 `route()` 理由文案里 `non-Latin script (devanagari, 100% of letters)` 的数据来源。

### 停用词启发式：边际设计防误路由

```python title="laya/lang.py"
def guess_latin_language(text):
    words = [w.lower() for w in _WORD.findall(text)]
    if len(words) < 4:
        return None
    scores = {lg: sum(1 for w in words if w in sw) for lg, sw in _STOP.items()}
    ...
    if best_lg and best >= max(2, en + 2):        # 主判据：清晰边际
        return best_lg
    if diac_rate >= 0.04 and best_lg and best >= en:  # 辅助：变音符背书
        return best_lg
    return "en" if en else None
```

拉丁语系的功能词高度重叠（`_STOP` 的注释举例：de/la/le/un/e/que 在多语通用），所以**原始计数不可信，边际才可信**。三条保守规则：词数 <4 直接返回 None（短输入故意不判）；非英语要以 `max(2, en+2)` 的停用词优势压倒英语才判非英——普通英语**永不**被误路由；变音符率 ≥4% 可以把门槛降到"打平即可"（`é`/`ü` 这类字符本身就是非英语证据）。另有一条前置短路：非英语停用词计数为 0 且变音符率 <2% 时，直接判英语（有英语停用词）或 None。这是典型的**不对称代价设计**：把英语误判成非英语（多走一个稍慢的检查点）代价小，把非英语误判成英语（送进会崩溃的检查点）代价大——判据整体向"当英语"倾斜。

`analyse()` 对三种情况的返回（`lang.py:159-177`）：`unknown`（无字母）→ `language=None` 且保守置 `is_english=True`、`non_latin_fraction=0.0`；非拉丁 script → `language=None`、`is_english=False`；拉丁 → `language` 取 `guess_latin_language()` 的结果（语言码或 None），`is_english = lang in (None, "en")`。`non_latin_fraction = round(1.0 − script_profile 的 latin 占比, 4)`，是 `route()` 理由文案百分比的来源。`detect_script()` 与 `script_profile()` 共用同一套字符分类（拉丁条件 + `_SCRIPT_RANGES` 区块表、命中即 break 一字符归一 script），只是返回视图不同：前者返回计数众数（无字母时 `"unknown"`），后者返回占比 dict（无字母时空 `{}`）。`detect_script()` 计数并列时取遍历顺序中先出现的 script（`max()` 的 tie-breaking），拉丁计数最后插入 counts，因此并列时非拉丁 script 优先胜出——同样偏向"路由到多语言检查点"的安全侧。

### state_text：只看值不看键

`_iter_text()` 收集 dict 的**值**而忽略键（`state_text` 的 docstring："keys are usually English"）——`{"body": "मुझसे दोबारा..."}` 的路由判据来自印地语正文而不是英文键名。深度限制 6 层防御病态嵌套与（间接的）循环结构，`max_chars=4000` 保证检测成本与 state 大小脱钩。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 数据表驱动 | `_SCRIPT_RANGES` / `_STOP` in `laya/lang.py` | 判据全部落成声明式数据，加语言 = 加表项 |
| 漏斗过滤 | `analyse()` 的三级分支 | 先精确（script）后启发式（语言），便宜的先跑 |
| 保守默认 | `unknown → is_english=True` | 拿不准时走默认检查点而非报错 |

## 模块间交互

唯一消费者是 `router.py` 的 `analyse` import（`router.py:33`）；`__init__.py` 把 `analyse` 重导出为 `detect_language`（公共 API 语义命名）。零内部依赖、零第三方依赖，处于依赖图最底层之一（与 `presets` / `email` 同级）。`tests/test_router.py` 直接测试本模块的六个函数（六语样例的 script 断言）。

## 扩展方式

- **新增一门拉丁语系识别**（如波兰语 / 罗马尼亚语）：`_STOP` 加该语停用词集合即可，边际逻辑自动生效；非拉丁语系则加 `_SCRIPT_RANGES` 区块。
- **接入专业检测库**：`Router` 已留显式 `lang=` 覆盖参数——上游已有可靠语言信息的调用方直接传参，绕过启发式（docstring 建议的做法）。
- **调整保守度**：`guess_latin_language()` 的边际常数（`en + 2`、`diac_rate` 0.04 阈值）是三个魔法数，改动即改变误路由率与漏检率的折衷。
