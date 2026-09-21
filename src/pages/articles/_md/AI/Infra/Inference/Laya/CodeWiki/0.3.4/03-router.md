---
source:
  type: "源码解读"
  project: "Laya"
  url: "https://github.com/NandhaKishorM/laya"
title: "模型路由"
date: "2026-09-21T00:15:00+08:00"
category: [AI, Infra, Inference, Laya, CodeWiki, "0.3.4"]
contentType: "CodeWiki"
tags: ["Laya", "路由", "LRU", "多语言", "推理"]
description: "laya/router.py 解读：Router 五级路由优先级、RouteDecision 元数据、LRU 检查点生命周期与 workflow 指纹匹配。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/00-overview)

---

## 模块定位

`laya/router.py`（314 行）回答一个问题：**三个检查点，这个请求该用哪个？** 模块 docstring 给出存在理由的数据支撑：英文检查点在非拉丁文字上不是温和退化而是崩溃——20 选项 MASSIVE intent 上印地语 0.100 / 韩语 0.103（随机基线 0.050），且**错的时候照样高置信**（印地语 ECE 0.855）。模型自己的置信度给不出预警，所以选择必须发生在前向之前、由确定性代码做出。

`Router` 同时还是三个 `Agent` 的**容器**：管加载（`load` / `preload` / `attach`）、管驱逐（LRU `_evict`）、管释放（`unload`）。路由判据与缓存策略放在一个模块，因为它们共同决定"每请求的期望延迟"。

## 模块架构

内部结构是"规格表 + 容器 + 纯函数判定"三块：

- **规格层**：`DEFAULT_MODELS`（bundled repo + subfolder）/ `STANDALONE_MODELS`（独立 repo）/ `_ALIASES`（`en`、`multi`、`typed` 等习惯别名）三张表，`normalise_name()` 是唯一的归一化入口；
- **判定层**：`route()` 纯函数（不加载任何模型、可单独调用）+ `match_typed_decisions_workflow()` 指纹匹配 + `RouteDecision` 结果类型（dict 子类，可直接序列化进 API 响应）；
- **容器层**：`self._agents`（名字 → Agent 实例）与 `self._order`（LRU 顺序表，最久未用在前），`_touch` / `_evict` / `load` / `preload` / `attach` / `unload` 六个操作维护两者一致。

## 调用链路

`route()` 的判定是一条五级瀑布——**显式覆盖永远赢，检测只做兜底**：

![Router.route 路由优先级](/vibe-reading/images/articles/laya-internals/routing-precedence.svg)

每级的语义：显式 `model=` 直接归一化使用；显式 `task=` 映射到模型（`typed_decisions` 特判映射到 typed-decisions）；`auto_task_detection=True` 时问题 id 集合**精确匹配**四个 typed-decisions workflow 签名之一才走专用检查点（默认关——docstring 明说"它不该成为静默默认"）；显式 `lang=` 做 en/非 en 二分；最后才是 `analyse(state)` 的 script/语言检测（判据细节见[语言检测](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/04-language-detection)）。每级产出的 `RouteDecision` 都带人类可读的 `reason`——路由是可解释的，`router.route(...).reason` 无副作用可单独调用。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `route()` | 纯函数判定用哪个检查点 | 五级优先级；不加载不前向 |
| `predict()` | route → load → system_one | 结果附 `routing` 键原样透传决策 |
| `load()` | 取/建 Agent | 命中即 `_touch` 提到 LRU 最新端 |
| `_evict()` | 维持 max_loaded 上限 | 双视图一致性自愈（order 与 agents 对齐） |
| `preload()` | 提前构建检查点 | max_loaded 抬升防"刚建即驱逐" |
| `attach()` | 注入外部 Agent 实例 | max_loaded 跟随扩张 |
| `unload()` | 释放一个/全部 | 显式释放不受 LRU 干扰 |
| `match_typed_decisions_workflow()` | 问题 id 集合 → workflow 名 | 精确集合相等，防误捕获 |
| `normalise_name()` | 别名 → 规范名 | 未知名抛 ValueError 并列出全部合法项与别名 |

</details>

## 核心实现

### LRU 生命周期：为"语言翻转"优化

三个检查点合计 ~1.16B 参数，`max_loaded=1`（默认）意味着任一时刻至多一个驻留。模块 docstring 给出量纲：冷加载秒级（CPU 实测中位 7.4 s，T4 10.3 s），检测微秒级——**语言交替的流量在 `max_loaded=1` 下每请求都重建模型**。所以生命周期方法的组合就是围绕这个矛盾：

```python title="laya/router.py"
def preload(self, names=None):
    names = [normalise_name(n) for n in (names or list(self.models))]
    self.max_loaded = max(self.max_loaded, len(names), len(self._agents))
    for n in names:
        if n not in self._agents:      # an attached agent is already built
            self.load(n)
```

三处细节值得注意：`preload` **先抬 `max_loaded` 再加载**，否则 LRU 会立刻驱逐刚构建的模型（经典的先有鸡还是先有蛋）；`attach` 注入外部实例后同样抬升上限；`_evict` 末尾有一个一致性自愈循环——`_agents` 与 `_order` 两个视图若失同步（历史上出现过），以 `_order` 为准清掉孤儿项，容器永不进入"引用存在但不可达"的状态。`RouteDecision` 继承 dict 的设计让 `result["routing"] = dict(decision)` 直接进 API 响应，同时保留 `.model` / `.reason` 属性访问。

### workflow 指纹：精确集合匹配

```python title="laya/router.py"
_TYPED_DECISION_WORKFLOWS = {
    "agent_trace_observability": {"action", "needs_review", "outcome", "risk", "urgency"},
    "customer_service": {"action", "category", "churn_risk", "needs_human", "urgency"},
    "invoice_processing": {"discrepancy_severity", "disposition", "duplicate", "matches_order", "urgency"},
    "security_incidents": {"credential_compromise", "disposition", "severity", "true_positive", "urgency"},
}

def match_typed_decisions_workflow(questions):
    ids = set(questions or {})
    for wf, sig in _TYPED_DECISION_WORKFLOWS.items():
        if ids == sig:        # 精确相等
            return wf
    return None
```

用**集合精确相等**（`ids == sig`）而非子集/重叠匹配：一个恰好多问了个 `urgency` 的无关 schema 永远不会被误路由到只在四个 workflow 上微调过的检查点。且整条路径默认关闭（`auto_task_detection=False`），需要用户显式 opt-in——专用检查点成为静默默认被明确列为本模块要避免的行为。

### predict：路由即元数据

`predict()` 把三个阶段串起来并在结果上盖戳（`router.py:305-309`）：`route()` 判定 → `load()` 取 Agent → `agent.system_one()` 推理 → `result["routing"] = dict(decision)`。`system_one = predict` 的别名让 `Router` 可直接替换 `Agent` 使用（鸭子类型兼容）。注意 `Router` 自身**没有 device/dtype 逻辑**——这些属于 `Agent`，Router 只透传构造参数。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 | `Router.predict()` in `laya/router.py` | 单入口掩盖三检查点分派 |
| 策略 + 优先级链 | `route()` 的五级瀑布 | 显式覆盖与自动检测分层，可解释 |
| LRU 缓存 | `_touch()` / `_evict()` | 显存/内存约束下保持热检查点 |
| 别名注册表 | `_ALIASES` + `normalise_name()` | 容忍用户习惯写法，归一化集中 |
| 值对象 | `RouteDecision`（dict 子类） | 可序列化 + 属性访问两用 |

## 模块间交互

import `lang.analyse`（路由末级判据）；`Router.load()` 内延迟 import `Agent`（`router.py:175`）。被 `__init__.py` re-export（`Router` / `RouteDecision` / `DEFAULT_MODELS`）；`tests/test_router.py` 用 `_Stub` Agent 经 `attach` 注入做无权重测试——这个测法反过来印证了 `attach` 的设计价值。

## 扩展方式

- **注册第四个检查点**：`Router(models={"mine": ("my/repo", "sub")})` 构造参数即可（无需改源码）；要成为全局默认则改 `DEFAULT_MODELS` + `_ALIASES` 两张表。
- **新增路由判据**：在 `route()` 的瀑布中插入新一级（现有五级之间），注意保持"显式 > 自动"的总原则；判据本身建议做成 `lang.py` 式的纯函数。
- **调整驻留策略**：`max_loaded` 构造参数 / `preload([...])` / `unload(name)` 三个旋钮覆盖"全驻留、部分驻留、手动换出"三种部署形态。
