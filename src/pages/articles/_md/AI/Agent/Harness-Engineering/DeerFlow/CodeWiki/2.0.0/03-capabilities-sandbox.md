---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "能力扩展与沙箱"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "Skills", "Sandbox", "MCP"]
description: "DeerFlow 能力扩展与沙箱子系统：技能、工具/扩展/MCP、沙箱、社区工具的协作关系。"
readingTime: "5 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/00-overview)

---

## 子系统定位

本子系统是 agent 的"手和眼"——agent 能做什么、能调什么工具、在哪儿执行代码、怎么扩展新能力。四个模块全做成**可插拔**：**Skills** 是声明式能力包（SKILL.md frontmatter + SkillScan 安全扫描 + 多用户隔离存储），`/skill-name` 斜杠激活；**Tools/Extensions/MCP** 是工具聚合框架（内置+MCP+skill+ACP 四源聚合、async→sync 适配、扩展中间件语义注入、MCP 持久 session pool）；**Sandbox** 是代码执行隔离（可插拔 provider：local/AIO/E2B/Boxlite/Tenki + warm-pool + 跨进程 ownership）；**Community** 是外部能力 provider 目录（搜索/爬虫/浏览器/图片/天气，约定式接口动态导入）。共同设计哲学：**配置驱动切换、零侵入扩展、安全隔离**。

## 挂载模块

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Skills | 声明式技能包（发现/解析/校验/扫描/存储/激活） | `Skill` / `SkillStorage` / `analyze_skill_package` | 技能是"powered by extensible skills"卖点 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox-01-skills) |
| Tools/Extensions/MCP | 工具聚合 + 扩展注入 + MCP 外部协议 | `get_available_tools` / `ExtensionRegistry` / `MCPSessionPool` | 聚合/注入/协议三层正交 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox-02-tools-extensions-mcp) |
| Sandbox | 代码执行沙箱（抽象 + 多 provider + warm-pool） | `SandboxProvider` ABC / `LocalSandbox` / `AioSandboxProvider` | 沙箱是 agent 执行代码的隔离边界 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox-03-sandbox) |
| Community | 外部能力 provider 目录（搜索/爬虫/浏览器） | `web_search_tool` / `BrowserSession` | 可插拔外部能力，约定式接口 | [→ 模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox-04-community) |

## 子系统内模块关系

```
Lead Agent 装配时:
  └─ get_available_tools(groups, include_mcp, ...)         ← Tools 模块
       ├─ resolve_variable(cfg.use) → 加载 community provider 的 tool 函数  ← Community
       ├─ BUILTIN_TOOLS (present_file, ask_clarification, review_skill_package)
       ├─ get_cached_mcp_tools() → MCP 工具 (持久 session pool)             ← MCP
       └─ ACP 工具

运行时:
  └─ SkillActivationMiddleware (用户 /skill-name)         ← Skills
       └─ 读取 SKILL.md → 注入上下文 → SkillToolPolicyMiddleware 过滤工具集

  └─ agent 调 execute_command 工具 → SandboxProvider.acquire  ← Sandbox
       └─ warm-pool 复用 / 冷启动 + ownership lease
       └─ Sandbox.execute_command (LocalSandbox subprocess / E2B 云 / AIO 容器)
```

Skills 提供声明式能力包，Tools 聚合所有工具来源（含 Community 和 MCP），Sandbox 提供代码执行隔离边界。Community 的 provider 被 Tools 的 `resolve_variable` 动态加载；Sandbox 的 provider 被 `get_sandbox_provider` 动态加载——两者都靠 config 的 `use` 字符串动态导入，共享"可插拔 provider"哲学。
