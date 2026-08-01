---
title: "Short-term memory"
source:
  type: "article"
  project: "LangChain"
  url: "https://docs.langchain.com/oss/python/langchain/short-term-memory"
  author: "LangChain"
  site: "Docs by LangChain 官方文档"
date: "2026-08-01T17:00:00+08:00"
category: [AI, Agent, Memory & Context, Blogs]
tags: ["LangChain", "Short-term Memory", "Agent", "Checkpointer", "Middleware"]
description: "LangChain 短期记忆：通过 checkpointer 实现 thread 级会话持久化、管理对话历史；介绍 trim/delete/summarize 等消息管理策略与 @before_model/@after_model 中间件。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Short-term memory](https://docs.langchain.com/oss/python/langchain/short-term-memory) · **作者** LangChain · **来源** Docs by LangChain 官方文档 · **原文发布** 2026-07-31 · **中英对照·AI 译** 2026-08-01
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。
> 📎 本文讲 thread 内的短期记忆；跨会话/跨 thread 的长期记忆见 [LangChain 官方文档 Long-term memory（中英对照）](/vibe-reading/articles/langchain-official-long-term-memory)，建议对照阅读。

---

## Overview

Memory is a system that remembers information about previous interactions. For AI agents, memory is crucial because it lets them remember previous interactions, learn from feedback, and adapt to user preferences. As agents tackle more complex tasks with numerous user interactions, this capability becomes essential for both efficiency and user satisfaction.

> **译：** 记忆是一个能记住先前交互信息的系统。对 AI agent 而言，记忆至关重要——它让 agent 能记住过往交互、从反馈中学习、并适应用户偏好。随着 agent 处理更复杂任务、面对大量用户交互，这一能力对效率与用户满意度都不可或缺。

Short term memory lets your application remember previous interactions within a single thread or conversation.

> **译：** 短期记忆让你的应用能在单个 thread 或单次会话内记住先前的交互。

> **注：** A thread organizes multiple interactions in a session, similar to the way email groups messages in a single conversation.
>
> **译：** thread 把一次 session 内的多次交互组织起来，类似于邮件把多条消息归到同一个会话里的方式。

Conversation history is the most common form of short-term memory. Long conversations pose a challenge to today's LLMs; a full history may not fit inside an LLM's context window, resulting in a context loss or errors.

> **译：** 对话历史是短期记忆最常见的形式。长对话对当今 LLM 是个挑战：完整历史可能放不进 LLM 的 context window，导致上下文丢失或报错。

Even if your model supports the full context length, most LLMs still perform poorly over long contexts. They get "distracted" by stale or off-topic content, all while suffering from slower response times and higher costs.

> **译：** 即便模型支持完整上下文长度，多数 LLM 在长上下文下表现仍不佳：会被陈旧或跑题的内容"分心"，同时响应更慢、成本更高。

Chat models accept context using [messages](https://docs.langchain.com/oss/python/langchain/messages), which include instructions (a system message) and inputs (human messages). In chat applications, messages alternate between human inputs and model responses, resulting in a list of messages that grows longer over time. Because context windows are limited, many applications can benefit from using techniques to remove or "forget" stale information.

> **译：** Chat 模型通过 [messages](https://docs.langchain.com/oss/python/langchain/messages) 接收上下文，包括指令（system message）和输入（human message）。在聊天应用中，消息在人类输入与模型响应间交替，形成随时间增长的消息列表。由于 context window 有限，许多应用可受益于移除或"遗忘"陈旧信息的技术。

> **提示**：Need to remember information **across** conversations? Use [long-term memory](/vibe-reading/articles/langchain-official-long-term-memory) to store and recall user-specific or application-level data across different threads and sessions.
>
> **译：** **提示**：需要**跨**会话记住信息？用[长期记忆](/vibe-reading/articles/langchain-official-long-term-memory)在不同 thread 与 session 间存储和回忆用户级或应用级数据。

## Usage

To add short-term memory (thread-level persistence) to an agent, you need to specify a `checkpointer` when creating an agent.

> **译：** 要为 agent 添加短期记忆（thread 级持久化），创建 agent 时需指定一个 `checkpointer`。

> **Info**：LangChain's agent manages short-term memory as a part of your agent's state.
>
> By storing these in the graph's state, the agent can access the full context for a given conversation while maintaining separation between different threads.
>
> State is persisted to a database (or memory) using a checkpointer so the thread can be resumed at any time.
>
> Short-term memory updates when the agent is invoked or a step (like a tool call) is completed, and the state is read at the start of each step.
>
> **译：** LangChain 的 agent 把短期记忆作为 agent state 的一部分来管理。通过将其存入 graph 的 state，agent 既能访问某次会话的完整上下文，又能保持不同 thread 间的隔离。state 借由 checkpointer 持久化到数据库（或内存），使 thread 可在任意时刻恢复。短期记忆在 agent 被调用或某个步骤（如 tool 调用）完成时更新，并在每步开始时读取 state。

> ℹ️ 原文此处在 `<CodeGroup>` 中提供 7 个 provider 的等价示例（Google / OpenAI / Anthropic / OpenRouter / Fireworks / Baseten / Ollama），**代码完全相同，仅 `model=` 参数不同**。下方保留 Anthropic 版；其余 6 个 provider 的 model 字符串见本节末尾。

```python title="Usage — Anthropic"
from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver


def get_user_info() -> str:
    """Look up information about the current user."""
    return "No user profile on file."


agent = create_agent(
    model="anthropic:claude-sonnet-4-6",
    tools=[get_user_info],
    checkpointer=InMemorySaver(),
)

thread_config = {"configurable": {"thread_id": "1"}}
response = agent.invoke(
    {"messages": [{"role": "user", "content": "Hi! My name is Bob."}]},
    thread_config,
)["messages"][-1].content

print(response)  # "Hi Bob! Nice to see you here. How are you doing?"

response = agent.invoke(
    {"messages": [{"role": "user", "content": "What's my name?"}]},
    thread_config,
)["messages"][-1].content

print(response)  # "You are Bob!"
```

> **译：** 关键：`checkpointer=InMemorySaver()` 启用 thread 级持久化；`thread_config = {"configurable": {"thread_id": "1"}}` 标识 thread；两次 `agent.invoke(..., thread_config)` 共用同一 thread，故第二次能回答 "What's my name?" → "You are Bob!"。`InMemorySaver` 仅用于开发，生产环境见下方。

### In production

In production, use a checkpointer backed by a database:

> **译：** 生产环境用数据库后端的 checkpointer：

```shell title="Install"
pip install langgraph-checkpoint-postgres
```

```python title="In production — PostgreSQL"
from langchain.agents import create_agent
from langgraph.checkpoint.postgres import PostgresSaver

def get_user_info() -> str:
    """Look up information about the current user."""
    return "No user profile on file."

DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable"
with PostgresSaver.from_conn_string(DB_URI) as checkpointer:
    checkpointer.setup() # auto create tables in PostgreSQL
    agent = create_agent(
        "gpt-5.5",
        tools=[get_user_info],
        checkpointer=checkpointer,
    )
```

> **注：** For more checkpointer options including SQLite, Postgres, and Azure Cosmos DB, see the [list of checkpointer libraries](https://docs.langchain.com/oss/python/langgraph/checkpointers#checkpointer-libraries) in the Persistence documentation.
>
> **译：** 更多 checkpointer 选项（SQLite、Postgres、Azure Cosmos DB 等）见 Persistence 文档中的 [checkpointer 库列表](https://docs.langchain.com/oss/python/langgraph/checkpointers#checkpointer-libraries)。

> 其余 6 个 provider 的 `model=` 参数（仅此一行不同，其余代码与上方 Anthropic 版一致）：
> - `google_genai:gemini-3.6-flash`（Google）
> - `openai:gpt-5.5`（OpenAI）
> - `openrouter:z-ai/glm-5.2`（OpenRouter）
> - `fireworks:accounts/fireworks/models/glm-5p2`（Fireworks）
> - `baseten:zai-org/GLM-5.2`（Baseten）
> - `ollama:north-mini-code-1.0`（Ollama）

## Customizing agent memory

By default, agents use [`AgentState`](https://reference.langchain.com/python/langchain/agents/middleware/types/AgentState) to manage short term memory, specifically the conversation history via a `messages` key.

> **译：** 默认情况下，agent 用 [`AgentState`](https://reference.langchain.com/python/langchain/agents/middleware/types/AgentState) 管理短期记忆，具体是通过 `messages` key 管理对话历史。

You can extend [`AgentState`](https://reference.langchain.com/python/langchain/agents/middleware/types/AgentState) to add additional fields. Custom state schemas are passed to [`create_agent`](https://reference.langchain.com/python/langchain/agents/factory/create_agent) using the [`state_schema`](https://reference.langchain.com/python/langchain/middleware/#langchain.agents.middleware.AgentMiddleware.state_schema) parameter.

> **译：** 可以扩展 [`AgentState`](https://reference.langchain.com/python/langchain/agents/middleware/types/AgentState) 添加额外字段。自定义 state schema 通过 [`state_schema`](https://reference.langchain.com/python/langchain/middleware/#langchain.agents.middleware.AgentMiddleware.state_schema) 参数传给 [`create_agent`](https://reference.langchain.com/python/langchain/agents/factory/create_agent)。

```python title="Customizing agent memory — CustomAgentState"
from langchain.agents import create_agent, AgentState
from langgraph.checkpoint.memory import InMemorySaver


class CustomAgentState(AgentState):
    user_id: str
    preferences: dict

agent = create_agent(
    "gpt-5.5",
    tools=[get_user_info],
    state_schema=CustomAgentState,
    checkpointer=InMemorySaver(),
)

# Custom state can be passed in invoke
result = agent.invoke(
    {
        "messages": [{"role": "user", "content": "Hello"}],
        "user_id": "user_123",
        "preferences": {"theme": "dark"}
    },
    {"configurable": {"thread_id": "1"}})
```

> **译：** `class CustomAgentState(AgentState)` 添加 `user_id`、`preferences` 等自定义字段；`create_agent(..., state_schema=CustomAgentState, ...)` 启用；调用时可在 invoke 的输入中直接传入这些字段的值。

## Common patterns

With [short-term memory](#usage) enabled, long conversations can exceed the LLM's context window. Common solutions are:

> **译：** 启用[短期记忆](#usage)后，长对话可能超出 LLM 的 context window。常见解法有：

- [**Trim messages**](#trim-messages) — Remove first or last N messages (before calling LLM)
- [**Delete messages**](#delete-messages) — Delete messages from LangGraph state permanently
- [**Summarize messages**](#summarize-messages) — Summarize earlier messages in the history and replace them with a summary
- **Custom strategies** — Custom strategies (e.g., message filtering, etc.)

> **译：**
> - [裁剪消息](#trim-messages)（Trim）—— 调用 LLM 前移除最前/最后 N 条消息
> - [删除消息](#delete-messages)（Delete）—— 从 LangGraph state 中永久删除消息
> - [摘要消息](#summarize-messages)（Summarize）—— 摘要较早的消息并用摘要替换
> - **自定义策略** —— 如消息过滤等

This allows the agent to keep track of the conversation without exceeding the LLM's context window.

> **译：** 这让 agent 能跟踪对话而不超出 LLM 的 context window。

### Trim messages

Most LLMs have a maximum supported context window (denominated in tokens).

> **译：** 多数 LLM 有最大支持的 context window（以 token 计）。

One way to decide when to truncate messages is to count the tokens in the message history and truncate whenever it approaches that limit. If you're using LangChain, you can use the trim messages utility and specify the number of tokens to keep from the list, as well as the `strategy` (e.g., keep the last `max_tokens`) to use for handling the boundary.

> **译：** 决定何时截断消息的一种方式是统计消息历史中的 token 数，接近上限就截断。若用 LangChain，可用 trim messages 工具，指定保留的 token 数及处理边界的 `strategy`（如保留最后 `max_tokens`）。

To trim message history in an agent, use the [`@before_model`](https://reference.langchain.com/python/langchain/agents/middleware/types/before_model) middleware decorator:

> **译：** 要在 agent 中裁剪消息历史，用 [`@before_model`](https://reference.langchain.com/python/langchain/agents/middleware/types/before_model) 中间件装饰器：

```python title="Trim messages — @before_model"
from langchain.messages import RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.checkpoint.memory import InMemorySaver
from langchain.agents import create_agent, AgentState
from langchain.agents.middleware import before_model
from langgraph.runtime import Runtime
from langchain_core.runnables import RunnableConfig
from typing import Any


@before_model
def trim_messages(state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
    """Keep only the last few messages to fit context window."""
    messages = state["messages"]

    if len(messages) <= 3:
        return None  # No changes needed

    first_msg = messages[0]
    recent_messages = messages[-3:] if len(messages) % 2 == 0 else messages[-4:]
    new_messages = [first_msg] + recent_messages

    return {
        "messages": [
            RemoveMessage(id=REMOVE_ALL_MESSAGES),
            *new_messages
        ]
    }

agent = create_agent(
    "gpt-5.5",
    tools=[...],
    middleware=[trim_messages],
    checkpointer=InMemorySaver(),
)

config: RunnableConfig = {"configurable": {"thread_id": "1"}}

agent.invoke({"messages": "hi, my name is bob"}, config)
agent.invoke({"messages": "write a short poem about cats"}, config)
agent.invoke({"messages": "now do the same but for dogs"}, config)
final_response = agent.invoke({"messages": "what's my name?"}, config)

final_response["messages"][-1].pretty_print()
"""
================================== Ai Message ==================================

Your name is Bob. You told me that earlier.
If you'd like me to call you a nickname or use a different name, just say the word.
"""
```

### Delete messages

You can delete messages from the graph state to manage the message history.

> **译：** 可以从 graph state 中删除消息以管理消息历史。

This is useful when you want to remove specific messages or clear the entire message history.

> **译：** 当你想移除特定消息或清空全部消息历史时很有用。

To delete messages from the graph state, you can use the `RemoveMessage`.

> **译：** 要从 graph state 删除消息，可用 `RemoveMessage`。

For `RemoveMessage` to work, you need to use a state key with [`add_messages`](https://reference.langchain.com/python/langgraph/graph/message/add_messages) [reducer](https://docs.langchain.com/oss/python/langgraph/graph-api#reducers).

> **译：** `RemoveMessage` 生效的前提：state key 需带 [`add_messages`](https://reference.langchain.com/python/langgraph/graph/message/add_messages) [reducer](https://docs.langchain.com/oss/python/langgraph/graph-api#reducers)。

The default [`AgentState`](https://reference.langchain.com/python/langchain/agents/middleware/types/AgentState) provides this.

> **译：** 默认的 [`AgentState`](https://reference.langchain.com/python/langchain/agents/middleware/types/AgentState) 已提供此能力。

To remove specific messages:

> **译：** 删除特定消息：

```python title="Delete — remove specific"
from langchain.messages import RemoveMessage

def delete_messages(state):
    messages = state["messages"]
    if len(messages) > 2:
        # remove the earliest two messages
        return {"messages": [RemoveMessage(id=m.id) for m in messages[:2]]}
```

To remove **all** messages:

> **译：** 删除**全部**消息：

```python title="Delete — remove all"
from langgraph.graph.message import REMOVE_ALL_MESSAGES

def delete_messages(state):
    return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES)]}
```

> **Warning**：When deleting messages, **make sure** that the resulting message history is valid. Check the limitations of the LLM provider you're using. For example:
>
> * Some providers expect message history to start with a `user` message
> * Most providers require `assistant` messages with tool calls to be followed by corresponding `tool` result messages.
>
> **译：** **警告**：删除消息时务必确保结果消息历史是合法的。请查你所用的 LLM provider 的限制，例如：
> - 部分 provider 要求消息历史以 `user` 消息开头
> - 多数 provider 要求带 tool call 的 `assistant` 消息后紧跟对应的 `tool` 结果消息

```python title="Delete — @after_model full example"
from langchain.messages import RemoveMessage
from langchain.agents import create_agent, AgentState
from langchain.agents.middleware import after_model
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.runtime import Runtime
from langchain_core.runnables import RunnableConfig


@after_model
def delete_old_messages(state: AgentState, runtime: Runtime) -> dict | None:
    """Remove old messages to keep conversation manageable."""
    messages = state["messages"]
    if len(messages) > 2:
        # remove the earliest two messages
        return {"messages": [RemoveMessage(id=m.id) for m in messages[:2]]}
    return None


agent = create_agent(
    "gpt-5-nano",
    tools=[...],
    system_prompt="Please be concise and to the point.",
    middleware=[delete_old_messages],
    checkpointer=InMemorySaver(),
)

config: RunnableConfig = {"configurable": {"thread_id": "1"}}

stream = agent.stream_events(
    {"messages": [{"role": "user", "content": "hi! I'm bob"}]},
    config,
    version="v3",
)
for snapshot in stream.values:
    print([(message.type, message.content) for message in snapshot["messages"]])

stream = agent.stream_events(
    {"messages": [{"role": "user", "content": "write a short poem about cats"}]},
    config,
    version="v3",
)
for snapshot in stream.values:
    print([(message.type, message.content) for message in snapshot["messages"]])

stream = agent.stream_events(
    {"messages": [{"role": "user", "content": "what's my name?"}]},
    config,
    version="v3",
)
for snapshot in stream.values:
    print([(message.type, message.content) for message in snapshot["messages"]])
```

```text title="Output"
[('human', "hi! I'm bob")]
[('human', "hi! I'm bob"), ('ai', 'Hi Bob! Nice to meet you. How can I help you today? I can answer questions, brainstorm ideas, draft text, explain things, or help with code.')]
[('human', "hi! I'm bob"), ('ai', 'Hi Bob! Nice to meet you. How can I help you today? I can answer questions, brainstorm ideas, draft text, explain things, or help with code.'), ('human', "write a short poem about cats")]
[('human', "hi! I'm bob"), ('ai', 'Hi Bob! Nice to meet you. How can I help you today? I can answer questions, brainstorm ideas, draft text, explain things, or help with code.'), ('human', "write a short poem about cats"), ('ai', 'There once was a cat on a wall, Who barely moved at all...')]
[('human', 'write a short poem about cats'), ('ai', 'There once was a cat on a wall, Who barely moved at all...')]
[('human', 'write a short poem about cats'), ('ai', 'There once was a cat on a wall, Who barely moved at all...'), ('human', "what's my name?")]
[('human', 'write a short poem about cats'), ('ai', 'There once was a cat on a wall, Who barely moved at all...'), ('human', "what's my name?"), ('ai', "I don't know your name - you haven't told me!")]
[('human', "what's my name?"), ('ai', "I don't know your name - you haven't told me!")]
```

> **译：** 注意输出：删除最早两条消息后，agent 丢失了"我叫 Bob"的信息，最后回答"我不知道你的名字——你没告诉过我！"。这印证了删除消息可能丢失上下文。

### Summarize messages

The problem with trimming or removing messages, as shown above, is that you may lose information from culling of the message queue.
Because of this, some applications benefit from a more sophisticated approach of summarizing the message history using a chat model.

> **译：** 上述裁剪/删除消息的问题在于可能因裁剪而丢失信息。因此，有些应用受益于更精细的方式：用 chat model 对消息历史做摘要。

![Summary](/vibe-reading/images/articles/langchain-official-short-term-memory/summary.png)

To summarize message history in an agent, use the built-in [`SummarizationMiddleware`](https://docs.langchain.com/oss/python/langchain/middleware#summarization):

> **译：** 要在 agent 中摘要消息历史，用内置的 [`SummarizationMiddleware`](https://docs.langchain.com/oss/python/langchain/middleware#summarization)：

```python title="Summarize messages — SummarizationMiddleware"
from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware
from langgraph.checkpoint.memory import InMemorySaver
from langchain_core.runnables import RunnableConfig


checkpointer = InMemorySaver()

agent = create_agent(
    model="gpt-5.5",
    tools=[...],
    middleware=[
        SummarizationMiddleware(
            model="gpt-5.4-mini",
            trigger=("tokens", 4000),
            keep=("messages", 20)
        )
    ],
    checkpointer=checkpointer,
)

config: RunnableConfig = {"configurable": {"thread_id": "1"}}
agent.invoke({"messages": "hi, my name is bob"}, config)
agent.invoke({"messages": "write a short poem about cats"}, config)
agent.invoke({"messages": "now do the same but for dogs"}, config)
final_response = agent.invoke({"messages": "what's my name?"}, config)

final_response["messages"][-1].pretty_print()
"""
================================== Ai Message ==================================

Your name is Bob!
"""
```

> **译：** `SummarizationMiddleware(model=..., trigger=("tokens", 4000), keep=("messages", 20))`：当 token 达 4000 触发摘要，保留最近 20 条消息；摘要由独立的 `model` 生成。即便历经多轮对话，agent 仍记得名字 → "Your name is Bob!"。更多配置见 [`SummarizationMiddleware`](https://docs.langchain.com/oss/python/langchain/middleware#summarization) 文档。

## Access memory

You can access and modify the short-term memory (state) of an agent in several ways:

> **译：** 可以通过多种方式访问和修改 agent 的短期记忆（state）：

### Tools

#### Read short-term memory in a tool

Access short term memory (state) in a tool using the `runtime` parameter (typed as `ToolRuntime`).

> **译：** 在 tool 中通过 `runtime` 参数（类型为 `ToolRuntime`）访问短期记忆（state）。

The `runtime` parameter is hidden from the tool signature (so the model doesn't see it), but the tool can access the state through it.

> **译：** `runtime` 参数对 tool 签名是隐藏的（模型看不到），但 tool 可通过它访问 state。

```python title="Read short-term memory in a tool"
from langchain.agents import create_agent, AgentState
from langchain.tools import tool, ToolRuntime


class CustomState(AgentState):
    user_id: str

@tool
def get_user_info(
    runtime: ToolRuntime
) -> str:
    """Look up user info."""
    user_id = runtime.state["user_id"]
    return "User is John Smith" if user_id == "user_123" else "Unknown user"

agent = create_agent(
    model="gpt-5-nano",
    tools=[get_user_info],
    state_schema=CustomState,
)

result = agent.invoke({
    "messages": "look up user information",
    "user_id": "user_123"
})
print(result["messages"][-1].content)
# > User is John Smith.
```

> **译：** `runtime.state["user_id"]` 读取自定义 state 字段；`runtime` 参数对模型不可见。

#### Write short-term memory from tools

To modify the agent's short-term memory (state) during execution, you can return state updates directly from the tools.

> **译：** 执行期间要修改 agent 的短期记忆（state），可直接从 tool 返回 state 更新。

This is useful for persisting intermediate results or making information accessible to subsequent tools or prompts.

> **译：** 这对持久化中间结果、或让后续 tool/prompt 能访问信息很有用。

```python title="Write short-term memory from tools"
from langchain.tools import tool, ToolRuntime
from langchain_core.runnables import RunnableConfig
from langchain.messages import ToolMessage
from langchain.agents import create_agent, AgentState
from langgraph.types import Command
from pydantic import BaseModel


class CustomState(AgentState):
    user_name: str

class CustomContext(BaseModel):
    user_id: str

@tool
def update_user_info(
    runtime: ToolRuntime[CustomContext, CustomState],
) -> Command:
    """Look up and update user info."""
    user_id = runtime.context.user_id
    name = "John Smith" if user_id == "user_123" else "Unknown user"
    return Command(update={
        "user_name": name,
        # update the message history
        "messages": [
            ToolMessage(
                "Successfully looked up user information",
                tool_call_id=runtime.tool_call_id
            )
        ]
    })

@tool
def greet(
    runtime: ToolRuntime[CustomContext, CustomState]
) -> str | Command:
    """Use this to greet the user once you found their info."""
    user_name = runtime.state.get("user_name", None)
    if user_name is None:
       return Command(update={
            "messages": [
                ToolMessage(
                    "Please call the 'update_user_info' tool it will get and update the user's name.",
                    tool_call_id=runtime.tool_call_id
                )
            ]
        })
    return f"Hello {user_name}!"

agent = create_agent(
    model="gpt-5-nano",
    tools=[update_user_info, greet],
    state_schema=CustomState,
    context_schema=CustomContext,
)

agent.invoke(
    {"messages": [{"role": "user", "content": "greet the user"}]},
    context=CustomContext(user_id="user_123"),
)
```

> **译：** tool 通过返回 `Command(update={...})` 写入 state（如 `user_name` 与 `messages`）。`greet` 工具可读取 `runtime.state.get("user_name")`，若为空则指示先调 `update_user_info`。

### Prompt

Access short term memory (state) in middleware to create dynamic prompts based on conversation history or custom state fields.

> **译：** 在中间件中访问短期记忆（state），以基于对话历史或自定义 state 字段创建动态 prompt。

```python title="Dynamic prompt — @dynamic_prompt"
from langchain.agents import create_agent
from typing import TypedDict
from langchain.agents.middleware import dynamic_prompt, ModelRequest


class CustomContext(TypedDict):
    user_name: str


def get_weather(city: str) -> str:
    """Get the weather in a city."""
    return f"The weather in {city} is always sunny!"


@dynamic_prompt
def dynamic_system_prompt(request: ModelRequest) -> str:
    user_name = request.runtime.context["user_name"]
    system_prompt = f"You are a helpful assistant. Address the user as {user_name}."
    return system_prompt


agent = create_agent(
    model="gpt-5-nano",
    tools=[get_weather],
    middleware=[dynamic_system_prompt],
    context_schema=CustomContext,
)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "What is the weather in SF?"}]},
    context=CustomContext(user_name="John Smith"),
)
for msg in result["messages"]:
    msg.pretty_print()
```

```text title="Output"
================================ Human Message =================================

What is the weather in SF?
================================== Ai Message ==================================
Tool Calls:
  get_weather (call_WFQlOGn4b2yoJrv7cih342FG)
 Call ID: call_WFQlOGn4b2yoJrv7cih342FG
  Args:
    city: San Francisco
================================= Tool Message =================================
Name: get_weather

The weather in San Francisco is always sunny!
================================== Ai Message ==================================

Hi John Smith, the weather in San Francisco is always sunny!
```

> **译：** `@dynamic_prompt` 装饰的函数接收 `ModelRequest`，从中读 `runtime.context["user_name"]` 动态生成 system prompt（"Address the user as John Smith"），最终回复会带上用户名。

### Before model

Access short term memory (state) in [`@before_model`](https://reference.langchain.com/python/langchain/agents/middleware/types/before_model) middleware to process messages before model calls.

> **译：** 在 [`@before_model`](https://reference.langchain.com/python/langchain/agents/middleware/types/before_model) 中间件中访问短期记忆（state），在模型调用前处理消息。

![Before model 中间件流程：start → before_model → model →（tools / end）](/vibe-reading/images/articles/langchain-official-short-term-memory/middleware-before-model.png)

```python title="Before model — trim messages"
from langchain.messages import RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.checkpoint.memory import InMemorySaver
from langchain.agents import create_agent, AgentState
from langchain.agents.middleware import before_model
from langchain_core.runnables import RunnableConfig
from langgraph.runtime import Runtime
from typing import Any


@before_model
def trim_messages(state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
    """Keep only the last few messages to fit context window."""
    messages = state["messages"]

    if len(messages) <= 3:
        return None  # No changes needed

    first_msg = messages[0]
    recent_messages = messages[-3:] if len(messages) % 2 == 0 else messages[-4:]
    new_messages = [first_msg] + recent_messages

    return {
        "messages": [
            RemoveMessage(id=REMOVE_ALL_MESSAGES),
            *new_messages
        ]
    }


agent = create_agent(
    "gpt-5-nano",
    tools=[],
    middleware=[trim_messages],
    checkpointer=InMemorySaver()
)

config: RunnableConfig = {"configurable": {"thread_id": "1"}}

agent.invoke({"messages": "hi, my name is bob"}, config)
agent.invoke({"messages": "write a short poem about cats"}, config)
agent.invoke({"messages": "now do the same but for dogs"}, config)
final_response = agent.invoke({"messages": "what's my name?"}, config)

final_response["messages"][-1].pretty_print()
"""
================================== Ai Message ==================================

Your name is Bob. You told me that earlier.
If you'd like me to call you a nickname or use a different name, just say the word.
"""
```

### After model

Access short term memory (state) in [`@after_model`](https://reference.langchain.com/python/langchain/agents/middleware/types/after_model) middleware to process messages after model calls.

> **译：** 在 [`@after_model`](https://reference.langchain.com/python/langchain/agents/middleware/types/after_model) 中间件中访问短期记忆（state），在模型调用后处理消息。

![After model 中间件流程：start → model → after_model →（end / tools）](/vibe-reading/images/articles/langchain-official-short-term-memory/middleware-after-model.png)

```python title="After model — validate response"
from langchain.messages import RemoveMessage
from langgraph.checkpoint.memory import InMemorySaver
from langchain.agents import create_agent, AgentState
from langchain.agents.middleware import after_model
from langgraph.runtime import Runtime


@after_model
def validate_response(state: AgentState, runtime: Runtime) -> dict | None:
    """Remove messages containing sensitive words."""
    STOP_WORDS = ["password", "secret"]
    last_message = state["messages"][-1]
    if any(word in last_message.content for word in STOP_WORDS):
        return {"messages": [RemoveMessage(id=last_message.id)]}
    return None

agent = create_agent(
    model="gpt-5-nano",
    tools=[],
    middleware=[validate_response],
    checkpointer=InMemorySaver(),
)
```

> **译：** `@after_model` 在模型生成响应后运行。此例检查最后一条消息是否含敏感词（password/secret），有则用 `RemoveMessage` 将其移除。
