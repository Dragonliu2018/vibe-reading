---
title: "CatPaw Managed Agents 技术架构"
source:
  type: "article"
  project: "CatPaw"
  url: "https://catpaw.meituan.com/docs#/agent/architecture"
  author: "美团 CatPaw"
  site: "CatPaw 文档"
date: "2026-08-01T11:00:00+08:00"
category: [AI, Agent, AI Coding, CatPaw, Official]
tags: ["AI Agent", "CatPaw", "美团", "Sandbox", "MicroVM"]
description: "美团自研的 AI Agent 平台，面向 Agent 全生命周期，提供多端、全链路的智能化解决方案。"
readingTime: "6 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [CatPaw Managed Agents 技术架构](https://catpaw.meituan.com/docs#/agent/architecture) · **作者** 美团 CatPaw · **来源** CatPaw 文档 · **转载** 2026-08-01

---

CatPaw Managed Agents 是美团自研的 AI Agent 平台，面向 Agent 全生命周期，提供多端、全链路的智能化解决方案。无论是产品能力覆盖度、工程化成熟度还是规模化验证，都是接入 AI Agent 能力的第一选择。

## 核心架构——"脑手分离"

CatPaw Managed Agents 架构的核心设计哲学是"脑手分离"，把 Agent 拆成两个相互配合、但职责清晰的部分：

- 🧠 **Agent Loop（大脑）**：负责理解用户意图、规划任务步骤并决定下一步调用什么工具。基于大语言模型的推理能力，处理对话上下文、工具选择与结果解析。
- 🤲 **Sandbox（双手）**：负责真正执行操作，如运行代码、读写文件和执行终端命令。运行在独立 MicroVM 中，提供硬件级安全隔离。

两者通过标准化协议通信，可以独立升级、独立扩缩，也可以适配不同产品形态。这种分离使得"思考"与"执行"可以各自优化——Agent Loop 可以分布式千万级扩容，而 Sandbox 池可按需快速扩展与闲时回收。

### 分离带来的优势

- ⚡ **弹性扩缩**：Agent Loop 和 Sandbox 可独立扩缩容。高并发场景下 Sandbox 池可快速扩展、闲时回收，做到极低成本运行 Agent；而 Agent Loop 保持轻量，支持分布式千万级扩容
- 🔄 **多产品复用**：同一套 Agent Loop 引擎可以对接不同形态的 Sandbox（本地 CLI、远端 MicroVM、浏览器沙箱），同时支撑桌面 / Web / Server 等业务场景
- 🚀 **极速响应**：会话状态与执行环境解耦，Agent Loop 启动不再依赖沙箱资源加载，首次会话加载从约 15 秒降至最低约 2 秒
- 🛡️ **安全隔离**：所有执行动作都交给 Sandbox 完成，即使代码运行异常也不会影响 Agent Loop 稳定性，更不会逃逸到宿主环境

![CatPaw Managed Agents 脑手分离架构图](/vibe-reading/images/articles/catpaw-official-managed-agents-architecture/brain-hand-separation.png)

## Harness（脑）

### Agent Loop

CatPaw Managed Agents 采用 ReAct 风格的 Agent Loop。Agent 会不断经历：理解上下文 → 思考下一步 → 调用工具 → 等待结果 → 继续思考。但这个 loop 并不是固定运行在某台机器上，而是会在分布式系统中的不同节点之间流转。整个流程是全异步的，依靠事件流驱动——用户发送消息、模型发起工具调用、工具返回结果，都成为推动 loop 运转的事件。

![Agent Loop 分布式架构图](/vibe-reading/images/articles/catpaw-official-managed-agents-architecture/agent-loop-distributed.png)

### Session 管理

由于 Agent Loop 会在分布式节点间流转，系统必须保证 Agent 无论在哪个节点继续执行，都能"记得"之前发生过什么。CatPaw Managed Agents Core 会根据 sessionId 找回历史数据，恢复历史消息，追加新 message，发起下一次模型请求。

- **Session 事件驱动**：loop 由 `user_message`、`tool_use`、`tool_result` 等事件驱动，过程派生的状态事件、summary 事件、thinking 事件等也会入库供 SDK 层消费
- **Session 会话数据**：由 system/user/assistant/tool 等各类 messages 构成，每次请求大模型都会取出所有有效 messages，经过上下文模板拼装后请求。触发 summary 时历史 messages 置为归档状态，追加一条有效的 summary message

### 工具调用

CatPaw Managed Agents 将 tool set 分为 3 类：

| 类型 | 描述 | 示例 |
| --- | --- | --- |
| 服务端工具 | 由 CatPaw Managed Agents 或平台侧统一提供，处理服务端能力和平台能力 | `todo_write`、`fetch_rules`、`km_search`、`web_fetch`、`web_search`、`docs_search`、`codebase_search`、`GenerateImage`、`McpTool`、`multiagent` |
| 沙箱工具 | 操作文件系统、代码仓库和终端环境，更接近 Agent 的"执行能力" | `read_file`、`write`、`string_replace`、`run_terminal_cmd`、`grep`、`glob_file_search`、`list_dir`、`delete_file` |
| 自定义工具 | 面向用户开放，以实现低成本地接入业务已有能力 | 用户可将已有 thrift 接口包装成自定义工具，支持同步调用和异步 callback |

### 上下文管理

对 Agent 来说，上下文不是简单地把历史消息塞进模型，而是在每一轮请求前，把系统规则、用户意图、工具结果和历史记忆重新整理成一份"可思考的材料"。

- **上下文组装**：将上下文分为 system prompt、context prompt 和 user/tool prompt 三部分，每一部分都有单独的 prompt 模板。每个 turn 都从云端加载会话数据，结合模板和参数组装完整的消息列表来请求模型。
- **自动压缩 Summary**：当上下文 Token 使用率达到窗口阈值时自动触发压缩，将历史消息生成结构化摘要。system_prompt、rules、skills 描述永远不会被压缩。压缩只针对用户与 Agent 的对话历史。
- **动态上下文**：将压缩前的对话 transcript、过大的工具结果、历史图片等上下文以文件形式存在沙箱中，并在运行时上下文尾部追加文件引用地址，引导大模型通过 `tail`、`grep` 等命令进行"回忆"。

### 多 Agent 协作

当单个 Agent 无法独立完成复杂任务时，CatPaw Managed Agents 支持多种多 Agent 协作模式：

- **Coordinator 协调者模式**：Coordinator 负责理解需求、拆分任务、安排 Worker 执行，多个 Worker 可并行处理不同子任务，适合跨模块、长链路的大型任务
- **Agent Team 智能体团队**：Team Lead 负责把控方向，多个 Teammate 各自拥有完整工具能力且可直接沟通，共享任务列表和团队记忆，像一个有分工有协作的项目小组
- **Plan with SOTA**：flash 模型执行任务前先自动切换到 SOTA 模型进行 Plan，再将 Plan 派发给 flash 模型执行，弥补 flash 级别模型在方案设计上的不足
- **Advisor 协作模型**：给 flash 模型配置 advisor 工具，遇到卡点时向 SOTA 模型请教，SOTA 基于完整上下文给出判断但不使用任何工具

## Sandbox（手）

Sandbox 是 Agent 的"双手"——如果说 LLM 是大脑负责思考，那么 Sandbox 就是让 Agent 真正"动手做事"的执行引擎。每个 Agent 会话获得一个完整、安全、隔离的操作系统级运行环境。

### 核心职责

- **代码执行** — 运行终端命令、执行代码片段，支持多语言（Python、Node.js、Shell 等）
- **Tools 隔离与执行** — Agent 调用的 tools 最终只在 Sandbox 中完成执行，执行环境与决策环境完全分离
- **Skill 加载与执行** — 动态加载 Agent 技能并提供其所需的运行时依赖
- **文件系统操作** — 完整的文件读写、目录管理，支持用户自定义文件挂载
- **MCP Server 运行时** — 承载 Model Context Protocol 服务，扩展 Agent 的工具调用能力
- **完整开发环境** — 等同一台配置好的远程开发机，Agent 在其中可以完成从编码到调试的全流程

### MicroVM + Sandbox Gateway

CatPaw Managed Agents Sandbox 底层采用 MicroVM（轻量级虚拟机）实现硬件级隔离，并通过 Sandbox Gateway 进行智能生命周期管理：

- **毫秒级冷启动**：从创建到可执行命令，延迟可控制在百毫秒量级
- **极低内存开销**：单实例基础内存占用远低于传统 VM，单节点可承载更高密度实例
- **动态监听**：实时监听 Agent ReAct 循环中的工具调用请求
- **按需拉起**：检测到需要执行环境时，从预热池中秒级分配就绪的 Sandbox 实例
- **闲时释放**：Agent 进入思考阶段或无交互时，自动将 Sandbox 暂停，不对 CPU/内存计算资源计费
- **无缝恢复**：下次工具调用到来时，透明恢复执行环境，用户无感知

![Sandbox Gateway 架构图](/vibe-reading/images/articles/catpaw-official-managed-agents-architecture/sandbox-gateway.png)

### 三层镜像架构

Sandbox 运行环境通过三层镜像结构组织，在启动速度、灵活性和可维护性之间取得最佳平衡：

| 层级 | 名称 | 描述 | 变更 |
| --- | --- | --- | --- |
| **Base Layer** | 基础运行时层 | Linux 内核、基础工具链、主流语言运行时，变更频率极低（月级），所有实例共享同一份基础镜像 | 月级 |
| **App Layer** | 应用层 | 按场景定制的工具和依赖，如 CatPaw Managed Agents Tool Server、Agent Browser、数据分析等，通过模板机制一次构建多处复用 | 周级 |
| **Service Layer** | 服务层 | MCP Server、File Manager 等动态加载的运行时服务，最为灵活，可在运行时动态启停 | 实时 |

### 文件持久化管理——自研 CatPaw Managed Agents 文件系统

- **存算分离，弹性无限**：Sandbox 本地不存储数据文件，数据全部在 S3 上持久化，不受 Sandbox 生命周期影响
- **透明兼容 POSIX**：对沙箱内的应用程序来说，文件就是普通文件路径，无需 SDK 接入或代码改造
- **按需加载**：文件挂载是惰性的，只有实际读取的文件才会从存储节点拉取数据，配合 gRPC 流式分块传输，大文件也不会撑爆内存
- **细粒度权限隔离**：不同 session 只能看到自己挂载的文件，权限由 Sandbox Gateway 中的挂载关系决定

## 安全与合规

CatPaw Managed Agents 平台默认全部兜底安全能力，业务方无需写一行安全代码。安全能力按三层组织：

- **① Agent 身份认证**：人 ↔ 容器 ↔ Token 三方绑定、AI 流量自动染色、凭证集中托管（Credential Vault）——凭证不进 LLM、不进业务进程环境变量
- **② Agent 执行安全**：五点拦截链覆盖 Prompt 注入全路径；送 LLM 前自动脱敏 PII 信息；敏感凭据防外泄；Skill 全量扫描与运行时监测
- **③ 可观测 · 可管控 · 可追溯**：全链路日志 + 端到端 Trace；异常行为主动检测 + 运行时远程阻断；完整行为链支持合规审计与逆向定位

## 模型智能路由网关

CatPaw Managed Agents 提供了多家模型供应商，模型智能路由网关作为统一接入层，对上层业务屏蔽差异——Agent 只需发起一次调用，由网关自动完成模型选择、流量调度、容错重试与全链路监控。

### 路由引擎

路由决策由多步流水线驱动：

条件匹配 → 检查定向规则 → 会话粘连 → 动态策略 → 权重分流 → 降级备选 → 多模态兜底

- **容量保障**：用户级集群限频、模型达上限自动排除、新模型灰度放量、限额管控
- **可靠性**：多种重试策略、请求适配管线屏蔽供应商协议差异、流式输出、流式风控审核
