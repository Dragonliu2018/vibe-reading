---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "工作执行引擎"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 工作执行引擎子系统——唤醒队列、原子 checkout、周期调度、孤儿恢复"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview)

---

## 子系统定位

工作执行引擎是 Paperclip 的运行时核心——回答"agent 到底怎么跑起来的"。它包含整个系统最重要的 god node `heartbeatService()`（172 条边，graphify 全图第一），负责从触发、入队、原子领取、执行准备、adapter 调用到终态恢复的完整链路。其他三个子系统（组织治理、工作区运行时、平台扩展）都围绕它工作：组织治理为 run 提供身份与预算约束，工作区运行时为 run 提供 git worktree 与环境租约，平台扩展为 run 注入 secret 与技能。

这个子系统独立存在，是因为"让 agent 跑起来"本身就是一组高度内聚的复杂问题——并发唤醒的原子性、瞬态失败的有界退避、进程丢失的检测恢复、coalescing 去重——这些都需要一个统一的队列消费者模型来治理，而不是散落在各 service 里。

## 挂载模块

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| Heartbeat & Recovery | DB-backed 唤醒队列与执行引擎 | `heartbeatService(db)` (`heartbeat.ts:3385`) | 12,338 行的编排枢纽，串联全部子服务 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/01-work-execution-01-heartbeat-recovery) |
| Work & Task System | 任务票据系统与原子 checkout | `issueService(db)` (`issues.ts:3273`) | issue 是 agent 工作的基本单位，承载 goal ancestry 与依赖 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/01-work-execution-02-work-task) |
| Routines & Schedules | 周期性任务调度 | `routineService(db)` (`routines.ts:533`) | 独立的触发源（cron/webhook），每次执行创建 tracked issue | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/01-work-execution-03-routines) |

## 子系统内模块关系

三个模块构成"触发 → 票据 → 执行"的流水线：Routines 是触发源之一（cron 到期创建 issue 并唤醒 agent），Issues 提供任务票据与原子 checkout 语义，Heartbeat 是执行引擎把 issue 交给 agent adapter 跑起来。Recovery 作为 Heartbeat 的子模块，持有 `enqueueWakeup` 引用形成回调闭环——当 run 失败时按 errorCode 分类决定是否重试。
