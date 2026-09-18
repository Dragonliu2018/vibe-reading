---
title: "面向 AI Agent 的数据库运维：SelectDB CLI 与 Skills 架构设计及实践"
source:
  type: "article"
  project: "SelectDB"
  url: "https://mp.weixin.qq.com/s/AK1uJStWnGaos9wtgjWDQQ"
  author: "陈明雨（Apache Doris PMC Chair）"
  site: "SelectDB 微信公众号"
date: "2026-09-18T17:30:00+08:00"
category: [Database, OLAP, "Apache Doris", Official]
contentType: "Blogs"
tags: ["SelectDB", "Apache Doris", "AI Agent", "CLI", "Skills", "智能运维", "表模型设计", "慢查询诊断", "ClickBench"]
description: "SelectDB 发布面向 AI Agent 的智能运维能力体系：CLI 为 Agent 提供结构化取证与执行入口，Skills 将数据库专家的判断过程沉淀为可审查、可执行的工作流，覆盖 Cloud 管控面与 Doris 数据面，附集群管理、表结构设计、Benchmark 调优三个端到端案例。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [面向 AI Agent 的数据库运维：SelectDB CLI 与 Skills 架构设计及实践](https://mp.weixin.qq.com/s/AK1uJStWnGaos9wtgjWDQQ) · **作者** 陈明雨 · **来源** SelectDB 微信公众号 · **原文发布** 2026-08-14 · **转载** 2026-09-18
> 原文含三段演示视频（集群生命周期管理、表结构设计与建表、ClickBench 调优），可在公众号原文中观看。

---

作者｜陈明雨，Apache Doris PMC Chair

集群该扩到几个节点、这张表该用聚合模型还是主键模型、慢查询的瓶颈在扫描还是在聚合——数据库运维中最耗时的，往往是这类没有标准答案的问题。它们高度依赖经验，而经验通常留在个别人的头脑里，很难被复用，也很难被验证。

SelectDB 正式发布面向 AI Agent 的智能运维能力体系，核心产品形态为 SelectDB CLI 与 Skills：CLI 为 Agent 提供结构化的取证与执行入口，Skills 则将数据库专家的判断过程沉淀为可审查、可执行的工作流。该体系同时覆盖管控面（Cloud）与数据面（内核），并在底层内置了四类安全机制，确保变更过程可控、关键操作始终由人确认。

本文将从数据库运维决策的复杂性出发，介绍 CLI + Skills 的架构设计，并通过三个端到端的实操案例，展示 AI Agent 如何基于自然语言完成集群管理、表结构设计与 Benchmark 调优。

## 01 业务背景：运维决策的复杂性

数据库运维的核心挑战，往往不在于命令的执行，而在于决策的准确性与连贯性。

从集群规划阶段开始，运维人员就需要做出一系列高度依赖经验的决策：规格选型（CPU、内存与缓存的最佳配比）、表模型设计（明细、聚合或主键模型的选择及字段类型定义）、分区分桶与索引设计等。

更为复杂的是，这些决策之间存在紧密的耦合关系。例如，表结构或分区分桶设计不合理，会在后期表现为慢查询，甚至直接限制集群的平滑扩容；而资源配置的偏差，则会直接影响系统的稳定性与使用成本。

过去的运维工具更多关注“如何执行”，例如扩缩容、查日志、恢复故障，这些操作通常都有确定的命令和工具。但在真实的运维场景中，更难的是“何时做出何种判断”，以及如何评估该判断可能带来的影响和风险。

如何将这些依赖经验的判断过程转化为可复用、可验证的工程化能力，是数据库智能运维需要解决的重要问题。

SelectDB CLI 与 Skills 主要围绕这一问题进行设计。

## 02 平台架构设计

### 从面向人到面向 Agent 的工具接口演进

数据库运维交互经历了传统 CLI（面向专家）与 GUI（降低门槛）两个阶段，本质上均是“面向人”的设计。AI Agent 接入后，需要理解用户意图，并将其转换为一系列可执行、可验证的步骤。传统工具在对接 Agent 时存在三类典型问题：

- **解析不稳定**：传统 CLI 经常使用 ASCII 表格等面向人阅读的格式，Agent 在解析字段、状态和异常信息时容易出现偏差。
- **上下文爆炸**：Profile 等诊断信息可能包含数千行内容，直接输入 Agent 会占用大量上下文，也增加关键信息遗漏的概率。
- **缺乏闭环**：传统报错通常只说明错误原因，但 Agent 还需要知道下一步应该如何处理。

因此，面向 Agent 的接口需要重点解决三个问题：结构化输出与一次性取证，减少多轮交互带来的上下文丢失；明确的错误码与修复建议，便于 Agent 判断下一步操作；明确的安全边界与确认机制，确保变更过程可控。

### CLI + Skills 两层能力架构全景

SelectDB 将面向 Agent 的运维能力拆分为两个层次：

- **CLI**：负责连接环境、采集证据、查询状态与提交变更，并统一返回结构化、可重试的结果，为 Agent 提供稳定的取数和执行入口。
- **Skills**：将复杂的判断逻辑、诊断路径和建议生成流程沉淀为工作流，使 Agent 能够按照相对固定的流程进行诊断与优化。

![](/vibe-reading/images/articles/selectdb-official-agent-db-ops-cli-skills/cli-skills-architecture.png)

为保障 Agent 参与数据库运维时的安全性与可控性，底层设计了四类基础安全机制：

- **取证前置**：先获取真实环境中的确定性证据，再生成建议。
- **变更预演**：清晰展示当前状态、目标状态及影响预估，涉及变更操作必须由人类确认。
- **幂等执行**：从接口层面避免 Agent 重试导致的重复变更。
- **密钥隔离**：凭证仅通过环境变量传递，避免进入 Agent 上下文或日志。

## 03 核心能力建设

### CLI：结构化取证框架

在运维诊断中，上下文的完整性非常重要。SelectDB CLI 主要遵循三项设计原则：按主题返回相对完整的信息，减少遗漏；使用 JSON 等结构化格式，减少解析异常；对大体量诊断信息进行摘要，避免占用过多上下文，实际场景中，可节省高达 90% 的 token。

![](/vibe-reading/images/articles/selectdb-official-agent-db-ops-cli-skills/cli-forensic-principles.png)

CLI 体系分为两类，实现管控面与数据面的闭环：

- **SelectDB Cloud CLI（管控面）**：覆盖 Cloud 环境运维，包括多环境认证、连接信息管理、Cluster 生命周期管理、网络控制及计费审计。例如，不同环境可以直接切换，不需要重复登录和配置连接信息。
- **Apache Doris CLI（数据面）**：专注与数据库内核的交互，提供 SQL 执行、SOCKS5 隧道、Profile 信息提取及数据分布状态探查等能力。Agent 可以直接拿到慢查询 Profile、Tablet 分布和集群状态，作为后续诊断的依据。

两类 CLI 结合起来，将 Cloud 管控面和 Doris 数据面连接起来，使 Agent 能够基于结构化的“证据快照”完成分析、规划与执行，而不是在不同系统中进行零散查询。

### Skills：领域知识工程化

CLI 解决的是 Agent 如何获取证据和执行操作，Skills 则规定 Agent 在不同场景下如何收集信息、进行判断并生成建议。每个 Skill 主要定义以下触发器、决策树、证据收集流程、建议模板四个部分：

![](/vibe-reading/images/articles/selectdb-official-agent-db-ops-cli-skills/skills-structure.png)

针对不同的运维面，Skills 同样分为两套矩阵：

- **SelectDB Cloud Skills**：涵盖环境路由、集群生命周期管理、读写分级、密钥安全及管控面故障自诊。
- **Apache Doris Skills**：涵盖资源规划、表模型设计、慢查询诊断、迁移评估，并包含 10 类实践经验和 8 项决策规则。例如什么场景该用 Unique Key 而不是 Aggregate、分桶键怎么选、分桶数怎么定、什么情况下需要调整分区策略等。

## 04 端到端场景实操

接下来通过三个完整场景，展示 Claude Code 配合 Skills 和 CLI，在 SelectDB Cloud 和 Apache Doris 中完成管控面管理、数据面操作及 Benchmark 调优。

### 场景一：管控面 - 集群生命周期管理

本场景展示如何通过自然语言完成 SelectDB Cloud 集群的生命周期管理，包括环境接入、Warehouse 选择、集群创建、扩容和删除。

用户只需要描述目标，例如：“在当前 Warehouse 下创建一个 8 核计算集群，空闲 15 分钟自动暂停；之后扩容到 16 核，演示完成后删除。”

Agent 会先探查环境和资源状态，再通过 Skills 和 CLI 完成实际操作。对于计费变更、资源删除等关键操作，会要求用户确认；如果执行过程中出现错误，也可以根据返回信息调整后继续执行。

这一场景重点体现的是运维操作的安全性和确定性：Agent 不只是执行命令，还会结合资源状态、平台约束和操作风险完成完整闭环。否则，用户往往需要在 CLI 文档、控制台和运维经验之间来回确认。

### 场景二：数据面 - 智能表结构设计与建表

本场景模拟 IoT 数据场景。用户只需要描述目标，例如：“5 万台设备持续上报数据，需要分钟级实时大盘、设备 ID 高并发点查，同时保留 90 天原始数据。”

Agent 给出的设计中，关键 DDL 包括：

```sql title="IoT 场景关键 DDL"
UNIQUE KEY(device_id)

PARTITION BY RANGE(event_time)

DISTRIBUTED BY HASH(device_id) BUCKETS ...
```

针对不同访问模式，分别使用明细模型、Unique Key 模型和聚合模型。三类查询模式差异较大，一张表很难同时做到最优，因此拆分为不同模型分别承载。

这里的关键是把 Doris 的表模型、分区、分桶等设计经验沉淀下来，将业务访问模式转化为合适的 Doris 表设计。没有 Skills，这些判断通常需要用户自己查表模型、分区、分桶等资料，再结合经验做取舍。

### 场景三：Benchmark 调优实践

本场景通过 ClickBench Benchmark，展示 Agent 如何协同管控面和数据面，从零完成集群创建、建表导数、Benchmark 跑分、性能诊断、调优及再次验证。

用户需求可以直接描述：“跑一个 ClickBench Benchmark，创建集群、建表、导数、跑分、调优，再重新跑分对比结果。”

首轮 Benchmark 后，Agent 根据实际运行结果分析慢查询，并针对分桶、bucket 数量和前缀索引等提出优化方案。重新建表和跑分后，整体性能提升约 13%。对于部分提升不明显的重查询，Agent 根据新的运行结果重新分析，最终判断主要瓶颈在 CPU 和聚合计算，而非最初判断的扫描并行度。

Benchmark 调优更依赖持续诊断和验证。Skills 让 Agent 能够基于实际跑分不断修正判断；如果完全依赖人工，往往需要反复收集 Profile、数据分布和集群信息，再交给研发或性能专家分析。

## 05 快速开始

目前 CLI 与 Skills 均已开源，可接入 Claude Code、Cursor、Copilot 等 AI 助手。后续还会补充更多场景模板，并支持 MCP Server 接入方式。

无论使用 SelectDB Cloud（www.selectdb.com/products/cloud） 还是开源 Apache Doris（doris.apache.org），都可以通过以下方式快速开始：

```bash title="快速开始"
# 1. 安装两类 CLI
npm install -g @apache-doris/doriscli    # 数据面交互
npm install -g @selectdb/cloudcli          # 管控面交互

# 2. 将领域知识接入 AI Agent 工作流
npx skills add apache/doris-skills              # 注入内核与调优经验
npx skills add selectdb/selectdb-cloud-skills   # 注入云端管控与调度经验
```

项目地址：

- apache/doris-skills
- selectdb/selectdb-cloud-skills

如果你在实际使用中遇到问题，或者有值得复用的设计和实践经验，欢迎提交 PR。相关案例会整理到 references/ 目录，方便后续遇到类似问题时快速参考。

## 相关阅读

- [Apache Doris 4.1 Spill to Disk：避免运行内存密集型查询发生 OOM](/vibe-reading/articles/Database/OLAP/Apache-Doris/Official/doris-official-spill-to-disk) —— 同公众号 Doris 查询优化文章
- [Apache Doris 4.1 Light Schema Change：秒级加列的最佳实践](/vibe-reading/articles/Database/OLAP/Apache-Doris/Official/doris-official-light-schema-change) —— 同公众号 Doris 表结构变更文章
- [阿里开源 skill-up：让 Agent Skill 可评测可回归](/vibe-reading/articles/alibaba-official-skill-up-agent-skill-eval) —— Agent Skill 评测与回归框架
- [Building effective agents](/vibe-reading/articles/anthropic-official-building-effective-agents) —— Anthropic 官方博客，构建有效 Agent 的工程实践
