---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "平台扩展与可移植"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 平台扩展与可移植子系统——插件系统、公司导入导出、密钥存储与审计"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview)

---

## 子系统定位

平台扩展与可移植回答"如何扩展与迁移整个组织"。Paperclip 不让你 fork 主仓库——而是通过插件系统（out-of-process worker + capability gate）扩展能力、通过公司可移植性（导出/导入整个组织）迁移组织、通过密钥与存储系统保护敏感资产。这个子系统独立存在，是因为扩展、迁移、保护是横向的跨切面能力，与具体业务编排解耦——插件可以给全部子服务加能力，可移植性读取全部实体，密钥存储被全部 run 使用。

## 挂载模块

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| Plugin System | out-of-process 插件 + capability gate | `pluginLoader()` (`plugin-loader.ts:1068`) | 无需 fork 扩展 Paperclip，12 个 plugin-*.ts 文件 | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/04-platform-portability-01-plugins) |
| Portability & Skills | 公司导入导出 + 运行时技能注入 | `companyPortabilityService(db)` (`company-portability.ts:2992`) | #3/#4 god node，secret scrubbing + collision handling | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/04-platform-portability-02-portability-skills) |
| Secrets · Storage · Activity | 密钥管理 + 对象存储 + 审计日志 | `secretService(db)` (`secrets.ts:313`) | secret scrubbing + scoped run 注入 + immutable activity log | [→ 模块](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/04-platform-portability-03-secrets-storage-activity) |

## 子系统内模块关系

三个模块形成"扩展 → 迁移 → 保护"的横向能力：Plugins 通过 capability gate 调用 host services（包括 secrets/portability 等全部 platform service），Portability 在导出时 scrub secret（不携带密钥）、在导入时复用 skill 落库，Secrets/Storage/Activity 为 run 提供密钥注入、为附件提供对象存储、为全部 mutating action 提供不可变审计。三者都被 Heartbeat 在 run 生命周期中调用：run 前 `secretService` 注入、run 中 `companySkillService` 注入技能、run 后 `logActivity` 记审计。
