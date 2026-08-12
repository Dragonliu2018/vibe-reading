---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "记忆与持久化"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "Memory", "Persistence"]
description: "DeerFlow 记忆与持久化子系统：长期记忆的多后端架构与应用数据持久层。"
readingTime: "4 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview)

---

## 子系统定位

本子系统是 DeerFlow 的"状态与数据归落地"。**Memory** 模块是 agent 的长期记忆——从对话中用 LLM 提取 facts、用 FTS5 检索、异步队列写入、注入回 system prompt；做成可插拔多后端（自研 DeerMem 文件存储、Honcho/OpenViking 远程服务、mem0 平台、noop 模板），整个后端文件夹可 vendor 到其他 agent 项目。**Persistence** 模块是应用数据持久层——基于 SQLAlchemy 2.0 async ORM 管理 runs 元数据、thread 归属、channel 连接、cron 任务等，与 LangGraph checkpointer 完全分离。两者都通过 `deerflow.runtime.user_context` 的 contextvar 做多用户隔离，共享 SQLite/Postgres 双后端策略。

## 挂载模块

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Memory | 长期记忆（提取/检索/注入/异步队列） | `MemoryManager` ABC / `DeerMem` / `MemoryUpdateQueue` | agent 记忆是可插拔后端，契约可移植 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/02-memory-persistence-01-memory) |
| Persistence | 应用数据持久层 + schema 迁移 | `init_engine` / `RunRepository` / `bootstrap_schema` | DB 层与 LangGraph checkpoint 分离 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/02-memory-persistence-02-persistence) |

## 子系统内模块关系

```
agent run 产出对话
     │
     ▼
MemoryMiddleware.after_agent()          ← Memory 模块
     └─ MemoryUpdateQueue (防抖+背压)
          └─ MemoryUpdater (LLM 提取 facts)
               └─ FileMemoryStorage (事务日志+原子写)
                    └─ FTS5Retrieval (BM25×time_decay 检索)
                         │
                         ▼
                   注入回 system prompt (<memory>…</memory>)

  ─────────────────  分界  ─────────────────

RunManager / channels / scheduler
     │
     ▼
RunRepository / ChannelConnectionRepository / ...  ← Persistence 模块
     └─ async_sessionmaker → SQLAlchemy AsyncEngine
          └─ bootstrap_schema (三路分支 + advisory lock)
          └─ Alembic migrations (safe_add_column 幂等)
```

Memory 与 Persistence 各管各的数据（记忆 facts/summaries vs 应用元数据），通过 user_id 共享多租户隔离语义，但无直接调用关系——Memory 的 FileMemoryStorage 用文件（非 DB），Persistence 管 ORM 表。
