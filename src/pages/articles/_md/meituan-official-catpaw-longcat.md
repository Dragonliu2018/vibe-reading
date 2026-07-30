---
title: "美团正式发布 CatPaw：全场景 AI Agent，从个人提效到企业智能化"
source:
  type: "article"
  project: "Meituan"
  url: "https://tech.meituan.com/2026/07/28/CatPaw-LongCat.html"
  author: "美团CatPaw"
  site: "美团技术团队"
date: "2026-07-30T20:30:00+08:00"
category: [AI, Agent, AI Coding, CatPaw, Official]
tags: ["美团", "CatPaw", "LongCat", "AI Agent", "数字员工", "Managed Agents", "本地生活"]
description: "美团搭载开源万亿参数 LongCat 2.0 模型的 AI Agent 平台 CatPaw 正式上线，提供全场景 AI 智能工作台与企业级 Managed Agents 开发托管能力，融合美团本地生活行业积累。"
readingTime: "7 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [美团正式发布 CatPaw：全场景 AI Agent，从个人提效到企业智能化](https://tech.meituan.com/2026/07/28/CatPaw-LongCat.html) · **作者** 美团CatPaw · **来源** 美团技术团队 · **原文发布** 2026-07-28 · **转载** 2026-07-30

---

美团本月正式开源了 LongCat 2.0，描述为"总参数 1.6T，平均激活约 48B"的万亿参数模型，号称是"首个在五万张国产算力卡上完成全流程训练与推理"的此类模型。开源之后，搭载该模型的 AI Agent 平台 CatPaw 正式上线。

CatPaw 提供开箱即用的 AI 智能工作台与企业级 Agent 开发托管能力，并融合美团在本地生活领域的行业积累，助力企业构建 AI 数字员工。据称已在美团内部"累计覆盖 9 万员工、搭建 Agent 3 万个"。

## 全时段运行，多终端协作的 AI 智能工作台

### 移动/PC/云端，全时段多端协作

CatPaw 提供独立的移动端 App 与 PC 客户端，双端任务实时同步。移动端支持随时发起任务、查看进度与远程确认关键决策；PC 端专注本地深度执行，具备文件操作、浏览器控制与终端命令等能力。

云端模式支持 7×24 小时不间断运行，本地设备关机或断网也不受影响。长程任务与定时任务于云端持续运转，完成后随时查看成果。

![多端协作示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/multi-device.png)

### 深耕本地生活，融合美团业务生态

CatPaw 在通用 AI Agent 能力基础上，融入了美团在本地生活领域的全链路行业认知。从门店经营、评价体系、营销转化到履约配送，这些积累被封装为即装即用的专家与技能，覆盖门店评价诊断与优化、商品文案生成、营销物料设计评估、活动策划、经营数据分析等场景。

CatPaw 定位既是"全能 AI 助手"，也是"真正懂本地生活生意的智能搭档"。

![本地生活融合示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/local-life.png)

### 专家与技能，丰富能力即装即用

CatPaw 支持 AI 专家，每位专家集成多项技能与子代理，完成特定领域复杂任务。从专家广场一键安装即可使用，也可通过对话将工作方式封装为专属专家，团队共享复用。

平台内置丰富技能库，开箱即用。内嵌浏览器支持操作过程一键录制，将日常高频流程自动生成专属技能。支持跨会话长期记忆，自动记忆用户个性化偏好、操作习惯与历史上下文，跨设备、跨对话保持连续理解。

![专家与技能示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/skills.png)

### 对话即交付，多 Agent 自主协同

用户只需明确最终目标，Agent 便会"自主规划步骤并在授权范围内深度执行"：读取文件、操作浏览器、运行终端命令，直接交付 Excel、可视化报告或代码等成果。

面对跨领域复杂任务，系统动态进行任务拆解，调度多个具备专属工具的 Agent 并发处理，各 Agent 在独立环境中互不干扰，进度实时可见，结果自动汇总。

![多 Agent 协同示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/multi-agent.png)

## 从 AI 工作台到业务系统：Managed Agents

CatPaw Managed Agents 是企业级 AI Agent 开发与托管平台，提供开箱即用的工程底座，无需从零搭建底层基建，即可快速构建、部署与管理专属 Agent。

### 数字员工，扫码即用灵活配置

数字员工是运行在飞书、企微等 IM 中的 AI 虚拟同事，@ 即可唤醒使用。平台预置多种角色模板，扫码即用；美团在本地生活领域的积累也沉淀为专属模板。

支持通过 AI 对话描述需求，快速生成专属数字员工。从 Agent 创建到环境部署、会话初始化，全程自动完成，无需手动配置。提示词、知识库、凭证、工具均支持在线管理，团队可按业务场景灵活搭建。

![数字员工示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/digital-employee.png)

### 企业级安全，数据隔离可控

Agent 运行环境严格隔离，租户间数据互不可见。凭证集中托管，确保 Agent 全程零接触敏感资产。支持分级权限管控与私有化部署，满足企业合规与安全审计要求。

![企业安全示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/security.png)

### Agent 托管运行，持续在线

支持按需配置运行环境，一键托管上线，资源动态扩缩。沙箱环境轻量隔离，百毫秒级冷启动，闲时自动释放，兼顾响应速度与成本。

![Agent 托管示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/managed-agent.png)

### 可视化运维，全链路可观测

提供统一的运维管理界面，会话记录完整留存可追溯，支持在线调试实时排查问题，模型调用量与消耗清晰可见。多维度数据统计与分析，帮助团队持续评估 Agent 表现、优化运行效果。

![可视化运维示意图](/vibe-reading/images/articles/meituan-official-catpaw-longcat/ops-observability.png)

## 从个人提效到组织智能化：与商家一起探索更多可能

CatPaw 在全场景 AI 能力之上提供组织级管理与管控能力，满足商家规模化落地 AI 的管理需求。

CatPaw 提供统一管理后台，支持团队账号体系。团队成员与权限集中管理，用量明细与消耗实时可查，成本清晰可控。AI 专家和技能支持按团队或角色集中配置与精准下发，一线员工开箱即用。

此外，CatPaw 还提供与美团业态深度关联的专属专家与技能，覆盖外卖、服务零售、医药健康等多个行业。以服务零售为例，美团商家运营专家整合了经营数据分析、评价管理、门店装修等核心场景。

CatPaw 将持续深入行业场景，让 AI Agent "真正成为驱动经营增长的数字化伙伴"，并诚邀美团合作商家抢先体验。

体验地址：`https://catpaw.meituan.com/`
