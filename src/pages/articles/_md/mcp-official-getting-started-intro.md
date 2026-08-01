---
title: "What is the Model Context Protocol (MCP)?"
source:
  type: "article"
  project: "MCP"
  url: "https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro"
  author: "Model Context Protocol"
  site: "Model Context Protocol 官方文档"
date: "2026-08-01T15:00:00+08:00"
category: [AI, Agent, MCP, Official]
tags: ["MCP", "Model Context Protocol", "AI Agent", "Open Protocol", "USB-C for AI"]
description: "MCP（Model Context Protocol）是连接 AI 应用与外部系统的开源标准——如同 AI 应用的 USB-C 接口，让 Claude、ChatGPT、VS Code、Cursor 等统一接入数据源、工具与工作流，一次构建处处集成。"
readingTime: "3 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [What is the Model Context Protocol (MCP)?](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro) · **作者** Model Context Protocol · **来源** 官方文档 · **原文发布** 2026-07-28 · **中英对照·AI 译** 2026-08-01
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

MCP (Model Context Protocol) is an open-source standard for connecting AI applications to external systems.

> **译：** MCP（Model Context Protocol，模型上下文协议）是一个用于连接 AI 应用与外部系统的开源标准。

Using MCP, AI applications like Claude or ChatGPT can connect to data sources (e.g. local files, databases), tools (e.g. search engines, calculators) and workflows (e.g. specialized prompts)—enabling them to access key information and perform tasks.

> **译：** 借助 MCP，Claude、ChatGPT 等 AI 应用可以连接到数据源（如本地文件、数据库）、工具（如搜索引擎、计算器）以及工作流（如专用 prompt）——从而获取关键信息并执行任务。

Think of MCP like a USB-C port for AI applications. Just as USB-C provides a standardized way to connect electronic devices, MCP provides a standardized way to connect AI applications to external systems.

> **译：** 可以把 MCP 想象成 AI 应用的 USB-C 接口。正如 USB-C 为连接电子设备提供了一种标准化方式，MCP 也为连接 AI 应用与外部系统提供了一种标准化方式。

![MCP connects AI applications to external systems](/vibe-reading/images/articles/mcp-official-getting-started-intro/mcp-simple-diagram.png)

## What can MCP enable?

- Agents can access your Google Calendar and Notion, acting as a more personalized AI assistant.
- Claude Code can generate an entire web app using a Figma design.
- Enterprise chatbots can connect to multiple databases across an organization, empowering users to analyze data using chat.
- AI models can create 3D designs on Blender and print them out using a 3D printer.

> **译：**
> - Agent 可以访问你的 Google Calendar 和 Notion，充当更个性化的 AI 助手。
> - Claude Code 可以根据 Figma 设计稿生成一整个 Web 应用。
> - 企业聊天机器人可以连接组织内的多个数据库，让用户通过对话来分析数据。
> - AI 模型可以在 Blender 上创建 3D 设计，并用 3D 打印机打印出来。

## Why does MCP matter?

Depending on where you sit in the ecosystem, MCP can have a range of benefits.

> **译：** 取决于你在生态系统中所处的位置，MCP 能带来一系列不同的收益。

- **Developers**: MCP reduces development time and complexity when building, or integrating with, an AI application or agent.
- **AI applications or agents**: MCP provides access to an ecosystem of data sources, tools and apps which will enhance capabilities and improve the end-user experience.
- **End-users**: MCP results in more capable AI applications or agents which can access your data and take actions on your behalf when necessary.

> **译：**
> - **开发者（Developers）**：MCP 减少了构建或集成 AI 应用 / agent 时的开发时间与复杂度。
> - **AI 应用或 agent**：MCP 提供了对数据源、工具和应用生态的访问能力，从而增强能力并改善终端用户体验。
> - **终端用户（End-users）**：MCP 带来更强大的 AI 应用或 agent，它们可以访问你的数据，并在必要时代你执行操作。

## Broad ecosystem support

MCP is an open protocol supported across a wide range of clients and servers. AI assistants like [Claude](https://claude.com/docs/connectors/building) and [ChatGPT](https://developers.openai.com/api/docs/mcp/), development tools like [Visual Studio Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers), [Cursor](https://cursor.com/docs/context/mcp), [MCPJam](https://docs.mcpjam.com/getting-started), and many others all support MCP — making it easy to build once and integrate everywhere.

> **译：** MCP 是一个开放协议，在广泛的客户端与服务端中得到支持。诸如 [Claude](https://claude.com/docs/connectors/building) 和 [ChatGPT](https://developers.openai.com/api/docs/mcp/) 这样的 AI 助手，[Visual Studio Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers)、[Cursor](https://cursor.com/docs/context/mcp)、[MCPJam](https://docs.mcpjam.com/getting-started) 等开发工具，以及更多其他工具都支持 MCP——这让"一次构建，处处集成"变得轻松。

## Start Building

- [Build servers](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server) — Create MCP servers to expose your data and tools
- [Build clients](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-client) — Develop applications that connect to MCP servers
- [Build MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) — Build interactive apps that run inside AI clients

> **译：**
> - [构建服务端](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server)（Build servers）—— 创建 MCP 服务端以暴露你的数据与工具
> - [构建客户端](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-client)（Build clients）—— 开发连接到 MCP 服务端的应用
> - [构建 MCP 应用](https://modelcontextprotocol.io/extensions/apps/overview)（Build MCP Apps）—— 构建运行于 AI 客户端内部的交互式应用

## Learn more

- [Understand concepts](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture) — Learn the core concepts and architecture of MCP

> **译：**
> - [理解核心概念](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)（Understand concepts）—— 学习 MCP 的核心概念与架构
