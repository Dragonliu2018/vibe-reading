---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Agent 编排与运行时"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "LangGraph", "Agent"]
description: "DeerFlow Agent 编排与运行时子系统：Lead Agent 装配、中间件栈、Run 生命周期管理的协作关系。"
readingTime: "5 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview)

---

## 子系统定位

本子系统是 harness 的心脏——回答"agent 是怎么被装配出来、怎么跑起来的"。三个模块分工明确：**Lead Agent** 负责 agent 图的装配（model + tools + middlewares + prompt + state schema → `create_agent`）和 `DeerFlowClient` 入口；**Middlewares** 负责把横切关注点（循环检测/压缩/激活/重试/安全）从 agent 核心解耦成 15+ 层洋葱栈；**Runtime** 负责一次 run 的完整生命周期（创建/启动/流式执行/取消/恢复/持久化）。三者协作链路：入口调用 `make_lead_agent` 装配图 → `build_middlewares` 组装中间件栈 → `run_agent` worker 用 `agent.astream()` 驱动执行，中间件在每个 model/tool 调用前后介入。

## 挂载模块

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Lead Agent & Client | agent 图装配 + 嵌入式 facade + 子代理 + LLM 工厂 | `make_lead_agent` / `DeerFlowClient` / `SubagentExecutor` | 装配车间，决定 agent 长什么样 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration-01-lead-agent) |
| Middlewares | 15+ 中间件洋葱栈 | `build_middlewares` / `IsolatedMiddleware` | 横切关注点解耦，可配置启停 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration-02-middlewares) |
| Runtime | Run 生命周期 + 事件溯源 + lease | `RunManager` / `run_agent` / `RunJournal` | run 的状态机与多 worker 协调 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/01-agent-orchestration-03-runtime) |

## 子系统内模块关系

```
入口（Gateway / TUI / Channels）
        │
        ▼
  DeerFlowClient / make_lead_agent   ← Lead Agent 模块
        │
        ├─ create_chat_model          (Models 工厂)
        ├─ get_available_tools        (→ 能力层 C)
        └─ build_middlewares ──────────┐
                                      ▼
                               Middlewares 模块（15+ 中间件）
                                      │
                                      ▼
                               create_agent → CompiledGraph
                                      │
        run_agent worker ◀────────────┘   ← Runtime 模块
        │
        ├─ RunManager.create_or_reject / try_start / cancel
        ├─ agent.astream() (中间件在每个 model/tool 调用介入)
        ├─ RunJournal (事件溯源 + token 统计)
        └─ bridge.publish() → StreamBridge → SSE
```

Lead Agent 装配图时调 `build_middlewares`（Middlewares 模块）组装栈；Runtime 的 `run_agent` worker 驱动装配好的图执行，中间件在执行期介入。三个模块是装配-执行关系，非松散集合。
