---
title: "Architecture overview"
source:
  type: "article"
  project: "MCP"
  url: "https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture"
  author: "Model Context Protocol"
  site: "Model Context Protocol 官方文档"
date: "2026-08-01T16:00:00+08:00"
category: [AI, Agent, MCP, Official]
tags: ["MCP", "Model Context Protocol", "Architecture", "JSON-RPC", "Client-Server", "Primitives"]
description: "MCP 官方架构概览：客户端-服务端架构、数据层（JSON-RPC 2.0 协议、Discovery、三大原语 Tools/Resources/Prompts、Notifications）与传输层（Stdio / Streamable HTTP），并给出完整的发现、工具调用、实时通知交互示例。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Architecture overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture) · **作者** Model Context Protocol · **来源** 官方文档 · **原文发布** 2026-07-28 · **中英对照·AI 译** 2026-08-01
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

This overview of the Model Context Protocol (MCP) discusses its [scope](#scope) and [core concepts](#concepts-of-mcp), and provides an [example](#example) demonstrating each core concept.

> **译：** 本文是对 Model Context Protocol（MCP）的概览，讨论其[范围](#scope)与[核心概念](#concepts-of-mcp)，并提供了一个[示例](#example)来演示每个核心概念。

Because MCP SDKs abstract away many concerns, most developers will likely find the [data layer protocol](#data-layer-protocol) section to be the most useful. It discusses how MCP servers can provide context to an AI application.

> **译：** 由于 MCP SDK 已经抽象掉了许多细节，大多数开发者可能会觉得[数据层协议](#data-layer-protocol)一节最有用——它讨论了 MCP 服务端如何向 AI 应用提供上下文。

For specific implementation details, please refer to the documentation for your [language-specific SDK](https://modelcontextprotocol.io/docs/2026-07-28/sdk).

> **译：** 具体实现细节请参考你所使用的[语言专属 SDK](https://modelcontextprotocol.io/docs/2026-07-28/sdk) 文档。

## Scope

The Model Context Protocol includes the following projects:

> **译：** Model Context Protocol 包含以下项目：

- [MCP Specification](https://modelcontextprotocol.io/specification/latest): A specification of MCP that outlines the implementation requirements for clients and servers.
- [MCP SDKs](https://modelcontextprotocol.io/docs/2026-07-28/sdk): SDKs for different programming languages that implement MCP.
- **MCP Development Tools**: Tools for developing MCP servers and clients, including the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [MCP Reference Server Implementations](https://github.com/modelcontextprotocol/servers): Reference implementations of MCP servers.

> **译：**
> - [MCP 规范（Specification）](https://modelcontextprotocol.io/specification/latest)：MCP 规范， outlining 了客户端与服务端的实现要求。
> - [MCP SDK](https://modelcontextprotocol.io/docs/2026-07-28/sdk)：不同编程语言实现的 MCP SDK。
> - **MCP 开发工具**：用于开发 MCP 服务端与客户端的工具，包括 [MCP Inspector](https://github.com/modelcontextprotocol/inspector)。
> - [MCP 参考服务端实现](https://github.com/modelcontextprotocol/servers)：MCP 服务端的参考实现。

> MCP focuses solely on the protocol for context exchange—it does not dictate how AI applications use LLMs or manage the provided context.

> **译：** MCP 只关注上下文交换的协议本身——它不规定 AI 应用如何使用 LLM 或如何管理所提供的上下文。

## Concepts of MCP

### Participants

MCP follows a client-server architecture where an MCP host — an AI application like [Claude Code](https://www.anthropic.com/claude-code) or [Claude Desktop](https://www.claude.ai/download) — establishes connections to one or more MCP servers. The MCP host accomplishes this by creating one MCP client for each MCP server. Each MCP client maintains a dedicated connection with its corresponding MCP server.

> **译：** MCP 采用客户端-服务端架构：一个 MCP host——即像 [Claude Code](https://www.anthropic.com/claude-code) 或 [Claude Desktop](https://www.claude.ai/download) 这样的 AI 应用——与一个或多个 MCP 服务端建立连接。MCP host 通过为每个 MCP 服务端创建一个 MCP client 来实现这一点。每个 MCP client 与其对应的 MCP 服务端维护一条专用连接。

Local MCP servers that use the STDIO transport typically serve a single MCP client, whereas remote MCP servers that use the Streamable HTTP transport will typically serve many MCP clients.

> **译：** 使用 STDIO 传输的本地 MCP 服务端通常只服务单个 MCP client，而使用 Streamable HTTP 传输的远程 MCP 服务端通常会服务多个 MCP client。

The key participants in the MCP architecture are:

> **译：** MCP 架构中的关键参与者有：

* **MCP Host**: The AI application that coordinates and manages one or multiple MCP clients
* **MCP Client**: A component that maintains a connection to an MCP server and obtains context from an MCP server for the MCP host to use
* **MCP Server**: A program that provides context to MCP clients

> **译：**
> - **MCP Host**：协调并管理一个或多个 MCP client 的 AI 应用
> - **MCP Client**：与 MCP 服务端保持连接、并从 MCP 服务端获取上下文供 MCP host 使用的组件
> - **MCP Server**：向 MCP client 提供上下文的程序

**For example**: Visual Studio Code acts as an MCP host. When Visual Studio Code establishes a connection to an MCP server, such as the [Sentry MCP server](https://docs.sentry.io/product/sentry-mcp/), the Visual Studio Code runtime instantiates an MCP client object that maintains the connection to the Sentry MCP server.
When Visual Studio Code subsequently connects to another MCP server, such as the [local filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem), the Visual Studio Code runtime instantiates an additional MCP client object to maintain this connection.

> **译：** **例如**：Visual Studio Code 充当 MCP host。当 VS Code 与某个 MCP 服务端（如 [Sentry MCP server](https://docs.sentry.io/product/sentry-mcp/)）建立连接时，VS Code 运行时会实例化一个 MCP client 对象来维护与 Sentry MCP 服务端的连接。当 VS Code 随后连接到另一个 MCP 服务端（如[本地文件系统服务端](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)）时，VS Code 运行时会再实例化一个 MCP client 对象来维护这条连接。

![MCP host 中每个 client 与对应 server 维护专用连接](/vibe-reading/images/articles/mcp-official-architecture/mcp-clients-servers.png)

Note that **MCP server** refers to the program that serves context data, regardless of
where it runs. MCP servers can execute locally or remotely. For example, when
Claude Desktop launches the [filesystem
server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem),
the server runs locally on the same machine because it uses the STDIO
transport. This is commonly referred to as a "local" MCP server. The official
[Sentry MCP server](https://docs.sentry.io/product/sentry-mcp/) runs on the
Sentry platform, and uses the Streamable HTTP transport. This is commonly
referred to as a "remote" MCP server.

> **译：** 注意，**MCP server** 指的是提供上下文数据的程序，与它在哪里运行无关。MCP 服务端可以在本地或远程执行。例如，当 Claude Desktop 启动[文件系统服务端](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)时，该服务端使用 STDIO 传输，因此运行在本地同一台机器上——这通常称为"本地"MCP 服务端。而官方的 [Sentry MCP server](https://docs.sentry.io/product/sentry-mcp/) 运行在 Sentry 平台上，使用 Streamable HTTP 传输——这通常称为"远程"MCP 服务端。

### Layers

MCP consists of two layers:

> **译：** MCP 由两层组成：

* **Data layer**: Defines the JSON-RPC based protocol for client-server communication, including capability and version discovery, and core primitives, such as tools, resources, prompts and notifications.
* **Transport layer**: Defines the communication mechanisms and channels that enable data exchange between clients and servers, including transport-specific connection establishment, message framing, and authorization.

> **译：**
> - **数据层（Data layer）**：定义基于 JSON-RPC 的客户端-服务端通信协议，包括能力与版本发现，以及核心原语（如 tools、resources、prompts 和 notifications）。
> - **传输层（Transport layer）**：定义使客户端与服务端之间能够交换数据的通信机制与通道，包括传输相关的连接建立、消息帧封装与授权。

Conceptually the data layer is the inner layer, while the transport layer is the outer layer.

> **译：** 概念上，数据层是内层，传输层是外层。

#### Data layer

The data layer implements a [JSON-RPC 2.0](https://www.jsonrpc.org/) based exchange protocol that defines the message structure and semantics.
This layer includes:

> **译：** 数据层实现了一个基于 [JSON-RPC 2.0](https://www.jsonrpc.org/) 的交换协议，定义了消息结构与语义。该层包括：

* **Discovery**: Lets clients query a server's supported protocol versions, capabilities, and identity through the `server/discover` request
* **Server features**: Enables servers to provide core functionality including tools for AI actions, resources for context data, and prompts for interaction templates from and to the client
* **Client features**: Enables servers to elicit input from the user. Sampling is [deprecated](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) as of protocol version `2026-07-28`.
* **Utility features**: Supports additional capabilities like notifications for real-time updates and progress tracking for long-running operations

> **译：**
> - **发现（Discovery）**：让 client 通过 `server/discover` 请求查询服务端支持的协议版本、能力与身份
> - **服务端特性（Server features）**：使服务端能提供核心功能，包括用于 AI 动作的 tools、用于上下文数据的 resources、以及用于交互模板的 prompts
> - **客户端特性（Client features）**：使服务端能向用户征集输入。Sampling 自协议版本 `2026-07-28` 起已[弃用](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)。
> - **工具特性（Utility features）**：支持额外能力，如用于实时更新的 notifications 和用于长时间运行操作的进度跟踪

#### Transport layer

The transport layer manages communication channels and authentication between clients and servers. It handles connection establishment, message framing, and secure communication between MCP participants.

> **译：** 传输层管理客户端与服务端之间的通信通道与认证。它处理连接建立、消息帧封装以及 MCP 参与者之间的安全通信。

MCP supports two transport mechanisms:

> **译：** MCP 支持两种传输机制：

* **Stdio transport**: Uses standard input/output streams for direct process communication between local processes on the same machine, providing optimal performance with no network overhead.
* **Streamable HTTP transport**: Uses HTTP POST for client-to-server messages with optional Server-Sent Events for streaming capabilities. This transport enables remote server communication and supports standard HTTP authentication methods including bearer tokens, API keys, and custom headers. MCP recommends using OAuth to obtain authentication tokens.

> **译：**
> - **Stdio 传输**：使用标准输入/输出流，在同一台机器上的本地进程之间进行直接进程通信，提供最佳性能且无网络开销。
> - **Streamable HTTP 传输**：使用 HTTP POST 发送 client→server 消息，可选 Server-Sent Events 实现流式能力。该传输支持远程服务端通信，并支持标准 HTTP 认证方式（包括 bearer token、API key 和自定义 header）。MCP 建议使用 OAuth 获取认证 token。

The transport layer abstracts communication details from the protocol layer, enabling the same JSON-RPC 2.0 message format across all transport mechanisms.

> **译：** 传输层从协议层抽象出通信细节，使相同的 JSON-RPC 2.0 消息格式能跨所有传输机制使用。

### Data Layer Protocol

A core part of MCP is defining the schema and semantics between MCP clients and MCP servers. Developers will likely find the data layer — in particular, the set of [primitives](#primitives) — to be the most interesting part of MCP. It is the part of MCP that defines the ways developers can share context from MCP servers to MCP clients.

> **译：** MCP 的核心部分是定义 MCP client 与 MCP server 之间的 schema 与语义。开发者可能会觉得数据层——尤其是[原语](#primitives)集合——是 MCP 最有趣的部分。它定义了开发者可以将上下文从 MCP 服务端共享给 MCP client 的方式。

MCP uses [JSON-RPC 2.0](https://www.jsonrpc.org/) as its underlying RPC protocol. Client and servers send requests to each other and respond accordingly. Notifications can be used when no response is required.

> **译：** MCP 使用 [JSON-RPC 2.0](https://www.jsonrpc.org/) 作为底层 RPC 协议。client 与 server 互相发送请求并相应地响应。当不需要响应时，可使用 notifications。

#### Statelessness and discovery

MCP is a stateless protocol（每个请求都包含处理它所需的所有信息，因此服务端不会从之前的请求中推断任何内容）. Every request carries the protocol version and the capabilities（client 或 server 支持的功能与操作，如 tools、resources 或 prompts） relevant to that request in its `_meta` field, so the server can process each request on its own. Clients should also identify themselves in the same field unless configured not to. Servers advertise their supported versions and capabilities through the mandatory [`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) request, which clients may send before any other request. Detailed information can be found in the [specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#statelessness), and the [example](#example) showcases the per-request metadata and the discovery sequence.

> **译：** MCP 是一个无状态协议。每个请求在其 `_meta` 字段中携带协议版本和与该请求相关的能力，因此服务端可以独立处理每个请求。client 也应在该字段中标识自己（除非配置为不这么做）。服务端通过强制的 [`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) 请求公布其支持的版本与能力，client 可以在任何其他请求之前发送它。详细信息见[规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#statelessness)，[示例](#example)展示了每请求元数据与发现流程。

#### Primitives

MCP primitives are the most important concept within MCP. They define what clients and servers can offer each other. These primitives specify the types of contextual information that can be shared with AI applications and the range of actions that can be performed.

> **译：** MCP 原语是 MCP 中最重要的概念。它们定义了 client 与 server 能向彼此提供什么。这些原语指定了可共享给 AI 应用的上下文信息类型，以及可执行的动作范围。

MCP defines three core primitives that *servers* can expose:

> **译：** MCP 定义了三种 *server* 可暴露的核心原语：

* **Tools**: Executable functions that AI applications can invoke to perform actions (e.g., file operations, API calls, database queries)
* **Resources**: Data sources that provide contextual information to AI applications (e.g., file contents, database records, API responses)
* **Prompts**: Reusable templates that help structure interactions with language models (e.g., system prompts, few-shot examples)

> **译：**
> - **Tools**：AI 应用可调用的可执行函数，用于执行动作（如文件操作、API 调用、数据库查询）
> - **Resources**：向 AI 应用提供上下文信息的数据源（如文件内容、数据库记录、API 响应）
> - **Prompts**：可复用模板，帮助结构化与语言模型的交互（如系统 prompt、few-shot 示例）

Each primitive type has associated methods for discovery (`*/list`), retrieval (`*/get`), and in some cases, execution (`tools/call`).
MCP clients will use the `*/list` methods to discover available primitives. For example, a client can first list all available tools (`tools/list`) and then execute them. This design allows listings to be dynamic.

> **译：** 每种原语类型都有相关方法：发现（`*/list`）、获取（`*/get`），某些情况下还有执行（`tools/call`）。MCP client 会用 `*/list` 方法发现可用原语。例如，client 可以先列出所有可用 tools（`tools/list`）再执行它们。这种设计允许列表是动态的。

As a concrete example, consider an MCP server that provides context about a database. It can expose tools for querying the database, a resource that contains the schema of the database, and a prompt that includes few-shot examples for interacting with the tools.

> **译：** 举一个具体例子，考虑一个提供数据库上下文的 MCP 服务端。它可以暴露查询数据库的 tools、一个包含数据库 schema 的 resource，以及一个包含与这些 tools 交互的 few-shot 示例的 prompt。

For more details about server primitives see [server concepts](https://modelcontextprotocol.io/docs/2026-07-28/learn/server-concepts).

> **译：** 关于服务端原语的更多细节见 [server concepts](https://modelcontextprotocol.io/docs/2026-07-28/learn/server-concepts)。

MCP also defines primitives that *clients* can expose. These primitives allow MCP server authors to build richer interactions.

> **译：** MCP 还定义了 *client* 可暴露的原语。这些原语让 MCP 服务端作者能构建更丰富的交互。

* **Elicitation**: Allows servers to request additional information from users. This is useful when server authors want to get more information from the user, or ask for confirmation of an action. Servers request user input with the `elicitation/create` method.

> **译：**
> - **Elicitation**：允许服务端向用户请求额外信息。当服务端作者想从用户获取更多信息，或请求确认某个动作时很有用。服务端用 `elicitation/create` 方法请求用户输入。

Elicitation requests are delivered through the [Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) pattern, explained in the [elicitation overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts#elicitation).

> **译：** Elicitation 请求通过 [Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) 模式交付，详见 [elicitation 概览](https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts#elicitation)。

**Deprecated**: The following client primitives are deprecated as of protocol version `2026-07-28`.

> **译：** **已弃用**：以下 client 原语自协议版本 `2026-07-28` 起已弃用。

* **Sampling**: Allows servers to request language model completions from the client's AI application. This is useful when server authors want access to a language model, but want to stay model-independent and not include a language model SDK in their MCP server. Servers request completions with the `sampling/createMessage` method, also delivered through the Multi Round-Trip Requests pattern. New implementations should integrate directly with LLM provider APIs.
* **Logging**: Enables servers to send log messages to clients for debugging and monitoring purposes. New implementations should log to `stderr` (stdio transport) or use OpenTelemetry.

> **译：**
> - **Sampling**：允许服务端从 client 的 AI 应用请求语言模型补全。当服务端作者想访问语言模型、但希望保持模型无关且不在其 MCP 服务端中引入语言模型 SDK 时很有用。服务端用 `sampling/createMessage` 方法请求补全，同样通过 Multi Round-Trip Requests 模式交付。新实现应直接集成 LLM provider API。
> - **Logging**：使服务端能向 client 发送日志消息，用于调试与监控。新实现应记录到 `stderr`（stdio 传输）或使用 OpenTelemetry。

For more details about client primitives see [client concepts](https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts).

> **译：** 关于 client 原语的更多细节见 [client concepts](https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts)。

Besides server and client primitives, the protocol supports optional [extensions](https://modelcontextprotocol.io/extensions/overview) that build on the core protocol. For example, the [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) lets servers return a durable handle for long-running requests, so clients can poll for status and retrieve the result later.

> **译：** 除服务端与 client 原语外，协议还支持构建在核心协议之上的可选[扩展](https://modelcontextprotocol.io/extensions/overview)。例如，[Tasks 扩展](https://modelcontextprotocol.io/extensions/tasks/overview)让服务端为长时间运行的请求返回一个持久 handle，这样 client 可以轮询状态并稍后取回结果。

#### Notifications

The protocol supports real-time notifications to enable dynamic updates between servers and clients. For example, when a server's available tools change (such as when new functionality becomes available or existing tools are modified), the server can send tool update notifications to inform connected clients about these changes. Notifications are sent as JSON-RPC 2.0 notification messages (without expecting a response). Change notifications are opt-in: the client opens a long-lived [`subscriptions/listen`](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) stream naming the notification types it wants to receive, and the server delivers matching notifications on that stream.

> **译：** 协议支持实时 notifications，以实现服务端与 client 之间的动态更新。例如，当服务端的可用 tools 变化时（如新功能可用或现有 tools 被修改），服务端可发送 tool 更新 notification 来通知已连接的 client。Notifications 作为 JSON-RPC 2.0 notification 消息发送（不期望响应）。变更 notification 是 opt-in 的：client 打开一个长生命周期的 [`subscriptions/listen`](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) 流，声明它想接收的 notification 类型，服务端在该流上投递匹配的 notification。

## Example

### Data Layer

This section provides a step-by-step walkthrough of an MCP client-server interaction, focusing on the data layer protocol. We'll demonstrate discovery, tool operations, and notifications using JSON-RPC 2.0 messages.

> **译：** 本节逐步演示一次 MCP client-server 交互，聚焦数据层协议。我们将用 JSON-RPC 2.0 消息演示发现、工具操作与通知。

### Step 1: Discovery

As described in the [statelessness and discovery](#statelessness-and-discovery) section, every MCP request carries the protocol version and client capabilities in its `_meta` field, and clients should also include their identity there. A client that wants to learn what a server supports before issuing other requests sends a `server/discover` request, which every server must implement. The discovery response is typically cacheable, meaning it can be re-used so the discovery flow does not need to be performed for every request.

> **译：** 如[无状态与发现](#statelessness-and-discovery)一节所述，每个 MCP 请求在其 `_meta` 字段中携带协议版本与 client 能力，client 还应在该字段中包含其身份。一个想在发出其他请求前了解服务端支持什么的 client，会发送 `server/discover` 请求——每个服务端都必须实现它。发现响应通常是可缓存的，可被复用，因此不必对每个请求都执行发现流程。

```json title="Discover Request"
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "example-client",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": {}
      }
    }
  }
}
```

```json title="Discover Response"
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": {
      "tools": {
        "listChanged": true
      },
      "resources": {}
    },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "example-server",
        "version": "1.0.0"
      }
    },
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}
```

#### Understanding the Discovery Exchange

The `_meta` fields and the discovery response together serve several purposes:

> **译：** `_meta` 字段与发现响应共同服务于几个目的：

1. **Protocol Version Selection**: The `io.modelcontextprotocol/protocolVersion` field declares the version the client is speaking on this request, and `supportedVersions` in the response lists the versions the server accepts. If a server does not support the requested version, it rejects the request with an `UnsupportedProtocolVersionError` listing the versions it does support, and the client retries with a mutually supported version.

   > **译：** 1. **协议版本选择**：`io.modelcontextprotocol/protocolVersion` 字段声明 client 在该请求上使用的版本，响应中的 `supportedVersions` 列出服务端接受的版本。如果服务端不支持请求的版本，它会用 `UnsupportedProtocolVersionError` 拒绝请求并列出它支持的版本，client 再用一个双方都支持的版本重试。

2. **Capability Discovery**: The client declares its capabilities in `io.modelcontextprotocol/clientCapabilities` on every request, and the server returns its own `capabilities` object from `server/discover`. This tells each party which [primitives](#primitives) the other can handle (tools, resources, prompts) and whether change [notifications](#notifications) are available, so unsupported operations are never attempted.

   > **译：** 2. **能力发现**：client 在每个请求的 `io.modelcontextprotocol/clientCapabilities` 中声明其能力，服务端从 `server/discover` 返回自己的 `capabilities` 对象。这告诉双方对方能处理哪些[原语](#primitives)（tools、resources、prompts）以及是否有变更 [notifications](#notifications)，从而不会尝试不支持的操作。

3. **Identity Exchange**: The `io.modelcontextprotocol/clientInfo` field in the request's `_meta` and the `io.modelcontextprotocol/serverInfo` field in the result's `_meta` provide identification and versioning information for debugging and compatibility purposes.

   > **译：** 3. **身份交换**：请求 `_meta` 中的 `io.modelcontextprotocol/clientInfo` 字段与结果 `_meta` 中的 `io.modelcontextprotocol/serverInfo` 字段提供用于调试与兼容性的身份和版本信息。

In this example, the exchange demonstrates how MCP capabilities are declared:

> **译：** 在本例中，交换演示了 MCP 能力如何声明：

**Client Capabilities**:

* `"elicitation": {}` - The client declares it can gather additional input from the user when the server requests it

**Server Capabilities**:

* `"tools": {"listChanged": true}` - The server supports the tools primitive and can honor a `toolsListChanged` filter in [`subscriptions/listen`](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions). Clients that request this filter receive `notifications/tools/list_changed` when the tool list changes.
* `"resources": {}` - The server also supports the resources primitive (can handle `resources/list` and `resources/read` methods)

> **译：**
> **Client 能力**：
> - `"elicitation": {}` — client 声明它能在服务端请求时从用户收集额外输入
>
> **Server 能力**：
> - `"tools": {"listChanged": true}` — 服务端支持 tools 原语，并能响应 [`subscriptions/listen`](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) 中的 `toolsListChanged` 过滤器。请求该过滤器的 client 会在 tool 列表变化时收到 `notifications/tools/list_changed`。
> - `"resources": {}` — 服务端还支持 resources 原语（能处理 `resources/list` 和 `resources/read` 方法）

Calling `server/discover` is optional. Because every request carries the same `_meta` fields, a client is free to send any request directly and handle a version error if one comes back. Discovery is a convenient way to fetch the server's identity, capabilities, and supported versions in a single request.

> **译：** 调用 `server/discover` 是可选的。由于每个请求都携带相同的 `_meta` 字段，client 可以直接发送任何请求，并在返回版本错误时处理它。发现是一种用单个请求获取服务端身份、能力与支持版本的便捷方式。

#### How This Works in AI Applications

The AI application's MCP client manager connects to configured servers and stores their discovered capabilities for later use. The application uses this information to determine which servers can provide specific types of functionality (tools, resources, prompts) and whether they support real-time updates. In the Python SDK, discovery happens while the client connects. The results are then available on the client object.

> **译：** AI 应用的 MCP client manager 连接到已配置的服务端并存储其发现的能力以备后用。应用用这些信息确定哪些服务端能提供特定类型的功能（tools、resources、prompts），以及它们是否支持实时更新。在 Python SDK 中，发现发生在 client 连接时，结果随后可在 client 对象上获取。

```python title="Pseudo-code for AI application discovery"
# Pseudo Code
async with Client(stdio_client(server_config)) as client:
    if client.server_capabilities.tools:
        app.register_mcp_server(client, supports_tools=True)
    app.set_server_ready(client)
```

### Step 2: Tool Discovery (Primitives)

The client can discover available tools by sending a `tools/list` request. This request is fundamental to MCP's tool discovery mechanism: it allows clients to understand what tools are available on the server before attempting to use them.

> **译：** client 可以通过发送 `tools/list` 请求来发现可用 tools。该请求是 MCP 工具发现机制的基础：它让 client 在尝试使用之前了解服务端上有哪些 tools 可用。

```json title="Tools List Request"
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "example-client",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": {}
      }
    }
  }
}
```

```json title="Tools List Response"
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resultType": "complete",
    "tools": [
      {
        "name": "calculator_arithmetic",
        "title": "Calculator",
        "description": "Perform mathematical calculations including basic arithmetic, trigonometric functions, and algebraic operations",
        "inputSchema": {
          "type": "object",
          "properties": {
            "expression": {
              "type": "string",
              "description": "Mathematical expression to evaluate (e.g., '2 + 3 * 4', 'sin(30)', 'sqrt(16)')"
            }
          },
          "required": ["expression"]
        }
      },
      {
        "name": "weather_current",
        "title": "Weather Information",
        "description": "Get current weather information for any location worldwide",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name, address, or coordinates (latitude,longitude)"
            },
            "units": {
              "type": "string",
              "enum": ["metric", "imperial", "kelvin"],
              "description": "Temperature units to use in response",
              "default": "metric"
            }
          },
          "required": ["location"]
        }
      }
    ],
    "ttlMs": 300000,
    "cacheScope": "public"
  }
}
```

#### Understanding the Tool Discovery Request

The `tools/list` request requires no parameters beyond the standard `_meta` fields that accompany every MCP request. It also accepts an optional `cursor` parameter for [pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination), which the example above omits.

> **译：** `tools/list` 请求除每个 MCP 请求都带的标准 `_meta` 字段外不需要参数。它还接受一个可选的 `cursor` 参数用于[分页](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination)，上例中省略了它。

#### Understanding the Tool Discovery Response

The response contains a `tools` array that provides comprehensive metadata about each available tool. This array-based structure allows servers to expose multiple tools simultaneously while maintaining clear boundaries between different functionalities.

> **译：** 响应包含一个 `tools` 数组，提供每个可用 tool 的完整元数据。这种基于数组的结构让服务端能同时暴露多个 tools，同时在不同功能间保持清晰边界。

Each tool object in the response includes several key fields:

> **译：** 响应中每个 tool 对象包含几个关键字段：

* **`name`**: A unique identifier for the tool within the server's namespace. This serves as the primary key for tool execution and should follow a clear naming pattern (e.g., `calculator_arithmetic` rather than just `calculate`)
* **`title`**: A human-readable display name for the tool that clients can show to users
* **`description`**: Detailed explanation of what the tool does and when to use it
* **`inputSchema`**: A JSON Schema that defines the expected input parameters, enabling type validation and providing clear documentation about required and optional parameters

> **译：**
> - **`name`**：tool 在服务端命名空间内的唯一标识符。它作为 tool 执行的主键，应遵循清晰的命名模式（如 `calculator_arithmetic` 而非仅 `calculate`）
> - **`title`**：client 可展示给用户的可读显示名
> - **`description`**：对 tool 做什么及何时使用的详细解释
> - **`inputSchema`**：定义预期输入参数的 JSON Schema，支持类型校验并提供必填与可选参数的清晰文档

The result is marked `"resultType": "complete"` and carries two caching fields. `ttlMs` is a freshness hint in milliseconds, so this tool list can be cached for five minutes. `cacheScope` indicates who may reuse the response. The specification's [caching utility](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching) defines the full rules.

> **译：** 结果标记为 `"resultType": "complete"` 并携带两个缓存字段。`ttlMs` 是以毫秒为单位的新鲜度提示，因此该 tool 列表可缓存五分钟。`cacheScope` 指示谁可复用该响应。规范的[缓存工具](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)定义了完整规则。

#### How This Works in AI Applications

The AI application fetches available tools from all connected MCP servers and combines them into a unified tool registry that the language model can access. This allows the LLM to understand what actions it can perform and automatically generates the appropriate tool calls during conversations.

> **译：** AI 应用从所有已连接的 MCP 服务端获取可用 tools，并将它们组合成一个语言模型可访问的统一 tool 注册表。这使 LLM 能理解自己可执行的动作，并在对话中自动生成合适的 tool 调用。

```python title="Pseudo-code for AI application tool discovery"
# Pseudo-code using MCP Python SDK patterns
available_tools = []
for client in app.mcp_clients():
    tools_response = await client.list_tools()
    available_tools.extend(tools_response.tools)
conversation.register_available_tools(available_tools)
```

Clients that federate many servers can use [progressive tool discovery](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices#progressive-tool-discovery) rather than loading every tool upfront.

> **译：** 联邦多个服务端的 client 可以使用[渐进式工具发现](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices#progressive-tool-discovery)，而不必一次性加载所有 tool。

### Step 3: Tool Execution (Primitives)

The client can now execute a tool using the `tools/call` method. This demonstrates how MCP primitives are used in practice: after discovering available tools, the client can invoke them with appropriate arguments.

> **译：** 现在 client 可以用 `tools/call` 方法执行一个 tool。这演示了 MCP 原语在实践中如何使用：发现可用 tools 后，client 可以用合适的参数调用它们。

#### Understanding the Tool Execution Request

The `tools/call` request follows a structured format that ensures type safety and clear communication between client and server. Note that we're using the proper tool name from the discovery response (`weather_current`) rather than a simplified name:

> **译：** `tools/call` 请求遵循结构化格式，确保类型安全与 client-server 间清晰通信。注意我们使用发现响应中的完整 tool 名（`weather_current`），而非简化名：

```json title="Tool Call Request"
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "weather_current",
    "arguments": {
      "location": "San Francisco",
      "units": "imperial"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "example-client",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": {}
      }
    }
  }
}
```

```json title="Tool Call Response"
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "resultType": "complete",
    "content": [
      {
        "type": "text",
        "text": "Current weather in San Francisco: 68°F, partly cloudy with light winds from the west at 8 mph. Humidity: 65%"
      }
    ]
  }
}
```

#### Key Elements of Tool Execution

The request structure includes several important components:

> **译：** 请求结构包含几个重要组件：

1. **`name`**: Must match exactly the tool name from the discovery response (`weather_current`). This ensures the server can correctly identify which tool to execute.

   > **译：** 1. **`name`**：必须与发现响应中的 tool 名完全匹配（`weather_current`）。这确保服务端能正确识别要执行哪个 tool。

2. **`arguments`**: Contains the input parameters as defined by the tool's `inputSchema`. In this example:
   * `location`: "San Francisco" (required parameter)
   * `units`: "imperial" (optional parameter, defaults to "metric" if not specified)

   > **译：** 2. **`arguments`**：包含由 tool 的 `inputSchema` 定义的输入参数。本例中：
   > - `location`："San Francisco"（必填参数）
   > - `units`："imperial"（可选参数，未指定时默认为 "metric"）

3. **`_meta`**: Carries the standard per-request fields: the protocol version and client capabilities that every MCP request must include, plus the client's identity, which clients should include unless configured not to.

   > **译：** 3. **`_meta`**：携带标准每请求字段：每个 MCP 请求必须包含的协议版本与 client 能力，外加 client 身份（client 应包含，除非配置为不这么做）。

4. **JSON-RPC Structure**: Uses standard JSON-RPC 2.0 format with unique `id` for request-response correlation.

   > **译：** 4. **JSON-RPC 结构**：使用标准 JSON-RPC 2.0 格式，用唯一 `id` 关联请求-响应。

#### Understanding the Tool Execution Response

The response demonstrates MCP's flexible content system:

> **译：** 响应演示了 MCP 灵活的内容系统：

1. **`content` Array**: Tool responses return an array of content objects, allowing for rich, multi-format responses (text, images, resources, etc.)

   > **译：** 1. **`content` 数组**：tool 响应返回一个内容对象数组，支持丰富的多格式响应（文本、图像、资源等）。

2. **Content Types**: Each content object has a `type` field. In this example, `"type": "text"` indicates plain text content, but MCP supports various content types for different use cases.

   > **译：** 2. **内容类型**：每个内容对象有一个 `type` 字段。本例中 `"type": "text"` 表示纯文本内容，但 MCP 支持多种内容类型以应对不同用例。

3. **Structured Output**: The response provides actionable information that the AI application can use as context for language model interactions.

   > **译：** 3. **结构化输出**：响应提供 AI 应用可用作语言模型交互上下文的可操作信息。

This execution pattern allows AI applications to dynamically invoke server functionality and receive structured responses that can be integrated into conversations with language models.

> **译：** 这种执行模式让 AI 应用能动态调用服务端功能，并接收可集成到与语言模型对话中的结构化响应。

#### How This Works in AI Applications

When the language model decides to use a tool during a conversation, the AI application intercepts the tool call, routes it to the appropriate MCP server, executes it, and returns the results back to the LLM as part of the conversation flow. This enables the LLM to access real-time data and perform actions in the external world.

> **译：** 当语言模型在对话中决定使用某个 tool 时，AI 应用会拦截该 tool 调用，将其路由到合适的 MCP 服务端、执行它，并把结果作为对话流的一部分返回给 LLM。这使 LLM 能访问实时数据并在外部世界执行动作。

```python title="Pseudo-code for AI application tool execution"
# Pseudo-code for AI application tool execution
async def handle_tool_call(conversation, tool_name, arguments):
    client = app.find_mcp_client_for_tool(tool_name)
    result = await client.call_tool(tool_name, arguments)
    conversation.add_tool_result(result.content)
```

### Step 4: Real-time Updates (Notifications)

MCP supports real-time notifications that enable servers to inform clients about changes without being polled for them. This demonstrates the notification system, a key feature that keeps clients synchronized and responsive.

> **译：** MCP 支持实时 notifications，使服务端无需被轮询即可告知 client 变更。这演示了 notification 系统——让 client 保持同步与响应的关键特性。

#### Subscribing to Changes

Change notifications are opt-in. To receive them, the client opens a long-lived notification stream by sending a [`subscriptions/listen`](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) request with a `notifications` filter naming the event types it wants. Here the client asks for tool list changes:

> **译：** 变更 notification 是 opt-in 的。要接收它们，client 通过发送一个 [`subscriptions/listen`](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) 请求打开一个长生命周期 notification 流，带一个声明它想要的事件类型的 `notifications` 过滤器。这里 client 请求 tool 列表变更：

```json title="Listen Request"
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "subscriptions/listen",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "example-client",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": {}
      }
    },
    "notifications": {
      "toolsListChanged": true
    }
  }
}
```

Every client request carries the `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` fields in `_meta`, and normally `io.modelcontextprotocol/clientInfo` as well, so the server can identify the client without relying on connection state.

> **译：** 每个 client 请求都在 `_meta` 中携带 `io.modelcontextprotocol/protocolVersion` 和 `io.modelcontextprotocol/clientCapabilities` 字段，通常还有 `io.modelcontextprotocol/clientInfo`，因此服务端无需依赖连接状态即可识别 client。

The server acknowledges the subscription with `notifications/subscriptions/acknowledged`, which is the first message carrying that subscription's ID in `_meta` (the server sends no other notification for that subscription before it). Its `notifications` field reflects the subset of the requested filter the server agreed to honor, with unsupported notification types omitted:

> **译：** 服务端用 `notifications/subscriptions/acknowledged` 确认订阅，这是第一条在 `_meta` 中携带该订阅 ID 的消息（服务端在此之前不会为该订阅发送其他 notification）。其 `notifications` 字段反映服务端同意响应的请求过滤器子集，不支持的通知类型被省略：

```json title="Acknowledgment"
{
  "jsonrpc": "2.0",
  "method": "notifications/subscriptions/acknowledged",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/subscriptionId": 4
    },
    "notifications": {
      "toolsListChanged": true
    }
  }
}
```

#### Understanding Tool List Change Notifications

After the acknowledgment, when the server's available tools change (for example, when new functionality becomes available, existing tools are modified, or tools become temporarily unavailable), the server delivers a notification on that stream:

> **译：** 确认之后，当服务端的可用 tools 变化时（例如新功能可用、现有 tools 被修改，或 tools 暂时不可用），服务端在该流上投递一个 notification：

```json title="Notification"
{
  "jsonrpc": "2.0",
  "method": "notifications/tools/list_changed",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/subscriptionId": 4
    }
  }
}
```

#### Key Features of MCP Notifications

1. **No Response Required**: Notice there's no `id` field in the notification. This follows JSON-RPC 2.0 notification semantics where no response is expected or sent.

   > **译：** 1. **无需响应**：注意 notification 中没有 `id` 字段。这遵循 JSON-RPC 2.0 notification 语义——不期望也不发送响应。

2. **Opt-In Based**: This notification is only sent to clients that requested `"toolsListChanged": true` in their `subscriptions/listen` filter, and it is only available from servers that declared `"listChanged": true` in their tools capability (as shown in Step 1).

   > **译：** 2. **基于 opt-in**：该 notification 只发送给在其 `subscriptions/listen` 过滤器中请求 `"toolsListChanged": true` 的 client，且只来自在 tools 能力中声明 `"listChanged": true` 的服务端（如步骤 1 所示）。

3. **Subscription-ID Tagging**: Every notification on the stream carries `io.modelcontextprotocol/subscriptionId` in `_meta`. The value is the JSON-RPC ID of the `subscriptions/listen` request that opened the stream (`4` in this example), so clients can correlate each notification with the subscription that produced it.

   > **译：** 3. **订阅 ID 标记**：流上每个 notification 都在 `_meta` 中携带 `io.modelcontextprotocol/subscriptionId`。其值是打开该流的 `subscriptions/listen` 请求的 JSON-RPC ID（本例为 `4`），因此 client 能将每个 notification 与产生它的订阅关联。

4. **Event-Driven**: The server decides when to send notifications based on internal state changes, making MCP connections dynamic and responsive.

   > **译：** 4. **事件驱动**：服务端根据内部状态变化决定何时发送 notification，使 MCP 连接动态且响应迅速。

5. **Best Effort**: There are no guarantees that every notification will be sent or received, particularly across transport reconnects. Clients should also rely on polling to preserve freshness of results.

   > **译：** 5. **尽力而为**：不保证每个 notification 都会被发送或接收，尤其在传输重连时。client 也应依赖轮询以保持结果新鲜。

#### Client Response to Notifications

Upon receiving this notification, the client typically reacts by requesting the updated tool list. This creates a refresh cycle that keeps the client's understanding of available tools current:

> **译：** 收到此 notification 后，client 通常会请求更新后的 tool 列表。这创建了一个刷新循环，使 client 对可用 tools 的认知保持最新：

```json title="Request"
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/list",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "example-client",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": {}
      }
    }
  }
}
```

#### Why Notifications Matter

This notification system is crucial for several reasons:

> **译：** 该 notification 系统至关重要，原因有几点：

1. **Dynamic Environments**: Tools may come and go based on server state, external dependencies, or user permissions
2. **Efficiency**: Clients don't need to poll for changes; they're notified when updates occur
3. **Consistency**: Ensures clients always have accurate information about available server capabilities
4. **Real-time Collaboration**: Enables responsive AI applications that can adapt to changing contexts

> **译：**
> 1. **动态环境**：tools 可能随服务端状态、外部依赖或用户权限而增减
> 2. **效率**：client 无需轮询变更；更新发生时即被通知
> 3. **一致性**：确保 client 始终拥有关于可用服务端能力的准确信息
> 4. **实时协作**：使 AI 应用能响应变化上下文

This notification pattern extends beyond tools to other MCP primitives, enabling comprehensive real-time synchronization between clients and servers.

> **译：** 该 notification 模式不止适用于 tools，还扩展到其他 MCP 原语，实现 client 与服务端之间全面的实时同步。

#### How This Works in AI Applications

The AI application keeps a notification stream open for the changes it cares about. When one arrives, it immediately refreshes its tool registry and updates the LLM's available capabilities. This ensures that ongoing conversations always have access to the most current set of tools, and the LLM can dynamically adapt to new functionality as it becomes available.

> **译：** AI 应用为它关心的变更保持一个 notification 流打开。当一个 notification 到达时，它立即刷新其 tool 注册表并更新 LLM 的可用能力。这确保进行中的对话始终能访问最新的 tool 集合，LLM 能在新功能可用时动态适配。

```python title="Pseudo-code for AI application notification handling"
# Pseudo-code for AI application notification handling
async def follow_tool_changes(client):
    async with client.listen(tools_list_changed=True) as sub:
        async for _event in sub:
            tools_response = await client.list_tools()
            app.update_available_tools(client, tools_response.tools)
            if app.conversation.is_active():
                app.conversation.notify_llm_of_new_capabilities()
```
