---
title: "Long-term memory"
source:
  type: "article"
  project: "LangChain"
  url: "https://docs.langchain.com/oss/python/langchain/long-term-memory"
  author: "LangChain"
  site: "Docs by LangChain 官方文档"
date: "2026-08-01T16:30:00+08:00"
category: [AI, Agent, Memory & Context, Blogs]
tags: ["LangChain", "Long-term Memory", "Agent", "LangGraph Store", "Memory"]
description: "Add long-term memory to LangChain agents to store and recall data across conversations and sessions"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Long-term memory](https://docs.langchain.com/oss/python/langchain/long-term-memory) · **作者** LangChain · **来源** Docs by LangChain 官方文档 · **原文发布** 2026-07-29 · **中英对照·AI 译** 2026-08-01
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

Long-term memory lets your agent store and recall information across different conversations and sessions.
Unlike [short-term memory](https://docs.langchain.com/oss/python/langchain/short-term-memory), which is scoped to a single thread, long-term memory persists across threads and can be recalled at any time.

> **译：** 长期记忆让你的 agent 能跨不同会话与 session 存储和回忆信息。与仅限于单个 thread 的[短期记忆](https://docs.langchain.com/oss/python/langchain/short-term-memory)不同，长期记忆可跨 thread 持久化，并可在任意时刻回忆。

Long-term memory is built on [LangGraph stores](https://docs.langchain.com/oss/python/langgraph/stores), which save data as JSON documents organized by namespace and key.

> **译：** 长期记忆建立在 [LangGraph stores](https://docs.langchain.com/oss/python/langgraph/stores) 之上——后者将数据保存为按 namespace 与 key 组织的 JSON 文档。

## Usage

To add long-term memory to an agent, create a store and pass it to [`create_agent`](https://reference.langchain.com/python/langchain/agents/factory/create_agent):

> **译：** 要为 agent 添加长期记忆，创建一个 store 并传给 [`create_agent`](https://reference.langchain.com/python/langchain/agents/factory/create_agent)：

```python title="InMemoryStore"
from langchain.agents import create_agent
from langchain_core.runnables import Runnable
from langgraph.store.memory import InMemoryStore

# InMemoryStore saves data to an in-memory dictionary. Use a DB-backed store in production use.
store = InMemoryStore()

agent: Runnable = create_agent(
    "claude-sonnet-4-6",
    tools=[],
    store=store,
)
```

```shell title="PostgreSQL — 安装"
pip install langgraph-checkpoint-postgres
```

```python title="PostgreSQL"
from langchain.agents import create_agent
from langchain_core.runnables import Runnable
from langgraph.store.postgres import PostgresStore  # type: ignore[import-not-found]

DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable"

with PostgresStore.from_conn_string(DB_URI) as store:
    store.setup()
    agent: Runnable = create_agent(
        "claude-sonnet-4-6",
        tools=[],
        store=store,
    )
```

> **译：** 原文此处为 InMemoryStore / PostgreSQL 两个标签页。InMemoryStore 把数据存到内存字典（生产环境请用数据库后端的 store）；PostgreSQL 版需先 `pip install langgraph-checkpoint-postgres`，再以 `PostgresStore.from_conn_string(DB_URI)` 创建 store 并 `setup()`。

Tools can then read from and write to the store using the `runtime.store` parameter. See [Read long-term memory in tools](#read-long-term-memory-in-tools) and [Write long-term memory from tools](#write-long-term-memory-from-tools) for examples.

> **译：** 随后 tools 可通过 `runtime.store` 参数读写 store。示例见 [Read long-term memory in tools](#read-long-term-memory-in-tools) 与 [Write long-term memory from tools](#write-long-term-memory-from-tools)。

> **提示**：For a deeper dive into memory types (semantic, episodic, procedural) and strategies for writing memories, see the [Memory conceptual guide](https://docs.langchain.com/oss/python/concepts/memory#long-term-memory).

> **译：** **提示**：欲深入了解记忆类型（semantic 语义、episodic 情节、procedural 程序）以及写入记忆的策略，见 [Memory 概念指南](https://docs.langchain.com/oss/python/concepts/memory#long-term-memory)。

## Memory storage

LangGraph stores long-term memories as JSON documents in a [store](https://docs.langchain.com/oss/python/langgraph/stores).

> **译：** LangGraph 把长期记忆以 JSON 文档形式存放在 [store](https://docs.langchain.com/oss/python/langgraph/stores) 中。

Each memory is organized under a custom `namespace` (similar to a folder) and a distinct `key` (like a file name). Namespaces often include user or org IDs or other labels that makes it easier to organize information.

> **译：** 每条记忆按自定义 `namespace`（类似文件夹）和独立 `key`（类似文件名）组织。namespace 常包含 user id、org id 或其他标签，以便组织信息。

This structure enables hierarchical organization of memories. Cross-namespace searching is then supported through content filters.

> **译：** 这种结构支持记忆的层级化组织，并支持通过内容过滤器跨 namespace 搜索。

```python title="InMemoryStore"
from collections.abc import Sequence

from langgraph.store.base import IndexConfig
from langgraph.store.memory import InMemoryStore


def embed(texts: Sequence[str]) -> list[list[float]]:
    # Replace with an actual embedding function or LangChain embeddings object
    return [[1.0, 2.0] for _ in texts]


# InMemoryStore saves data to an in-memory dictionary. Use a DB-backed store in production use.
store = InMemoryStore(index=IndexConfig(embed=embed, dims=2))
user_id = "my-user"
application_context = "chitchat"
namespace = (user_id, application_context)
store.put(
    namespace,
    "a-memory",
    {
        "rules": [
            "User likes short, direct language",
            "User only speaks English & python",
        ],
        "my-key": "my-value",
    },
)
# get the "memory" by ID
item = store.get(namespace, "a-memory")
# search for "memories" within this namespace, filtering on content equivalence, sorted by vector similarity
items = store.search(
    namespace, filter={"my-key": "my-value"}, query="language preferences"
)
```

```python title="PostgreSQL"
from collections.abc import Sequence

from langgraph.store.base import IndexConfig
from langgraph.store.postgres import PostgresStore  # type: ignore[import-not-found]


def embed(texts: Sequence[str]) -> list[list[float]]:
    # Replace with an actual embedding function or LangChain embeddings object
    return [[1.0, 2.0] for _ in texts]


DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable"

with PostgresStore.from_conn_string(
    DB_URI,
    index=IndexConfig(embed=embed, dims=2),  # type: ignore[arg-type]
) as store:
    store.setup()
    user_id = "my-user"
    application_context = "chitchat"
    namespace = (user_id, application_context)
    store.put(
        namespace,
        "a-memory",
        {
            "rules": [
                "User likes short, direct language",
                "User only speaks English & python",
            ],
            "my-key": "my-value",
        },
    )
    item = store.get(namespace, "a-memory")
    items = store.search(
        namespace, filter={"my-key": "my-value"}, query="language preferences"
    )
```

> **译：** 两段示例（InMemoryStore / PostgreSQL）演示了 `store.put(namespace, key, value)` 写入、`store.get(namespace, key)` 按 ID 取回、`store.search(namespace, filter=..., query=...)` 在 namespace 内按内容等值过滤并以向量相似度排序搜索。`IndexConfig(embed=..., dims=...)` 配置嵌入向量索引以支持语义搜索。

For more information about the memory store, see the [Persistence](https://docs.langchain.com/oss/python/langgraph/stores) guide.

> **译：** 关于 memory store 的更多信息，见 [Persistence](https://docs.langchain.com/oss/python/langgraph/stores) 指南。

## Read long-term memory in tools

> **译：** 在 tools 中读取长期记忆

> ℹ️ 原文此处在标签页中为 InMemoryStore / PostgreSQL 两种 store，其中 InMemoryStore 又以 `<CodeGroup>` 提供 7 个 provider 的等价示例（Google / OpenAI / Anthropic / OpenRouter / Fireworks / Baseten / Ollama），**代码完全相同，仅 `model=` 参数不同**。下方保留 Anthropic 版；其余 6 个 provider 的 model 字符串见本节末尾。

```python title="Read — InMemoryStore (Anthropic)"
from dataclasses import dataclass

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from langchain_core.runnables import Runnable
from langgraph.store.memory import InMemoryStore


@dataclass
class Context:
    user_id: str


# InMemoryStore saves data to an in-memory dictionary. Use a DB-backed store in production.
store = InMemoryStore()

# Write sample data to the store using the put method
store.put(
    (
        "users",
    ),  # Namespace to group related data together (users namespace for user data)
    "user_123",  # Key within the namespace (user ID as key)
    {
        "name": "John Smith",
        "language": "English",
    },  # Data to store for the given user
)


@tool
def get_user_info(runtime: ToolRuntime[Context]) -> str:
    """Look up user info."""
    # Access the store - same as that provided to `create_agent`
    assert runtime.store is not None
    user_id = runtime.context.user_id
    # Retrieve data from store - returns StoreValue object with value and metadata
    user_info = runtime.store.get(("users",), user_id)
    return str(user_info.value) if user_info else "Unknown user"


agent: Runnable = create_agent(
    model="anthropic:claude-sonnet-4-6",
    tools=[get_user_info],
    # Pass store to agent - enables agent to access store when running tools
    store=store,
    context_schema=Context,
)

# Run the agent
agent.invoke(
    {"messages": [{"role": "user", "content": "look up user information"}]},
    context=Context(user_id="user_123"),
)
```

```python title="Read — PostgreSQL"
from dataclasses import dataclass

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from langchain_core.runnables import Runnable
from langgraph.store.postgres import PostgresStore  # type: ignore[import-not-found]


@dataclass
class Context:
    user_id: str


DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable"

with PostgresStore.from_conn_string(DB_URI) as store:
    store.setup()
    store.put(("users",), "user_123", {"name": "John Smith", "language": "English"})

    @tool
    def get_user_info(runtime: ToolRuntime[Context]) -> str:
        """Look up user info."""
        assert runtime.store is not None
        user_info = runtime.store.get(("users",), runtime.context.user_id)
        return str(user_info.value) if user_info else "Unknown user"

    agent: Runnable = create_agent(
        "claude-sonnet-4-6",
        tools=[get_user_info],
        store=store,
        context_schema=Context,
    )

    result = agent.invoke(
        {"messages": [{"role": "user", "content": "look up user information"}]},
        context=Context(user_id="user_123"),
    )
```

> **译：** 关键点：定义带 `user_id` 的 `Context` dataclass 作为 `context_schema`；用 `@tool` 装饰的函数通过 `runtime: ToolRuntime[Context]` 参数拿到 `runtime.store`（即传给 `create_agent` 的同一个 store）与 `runtime.context`；`runtime.store.get(("users",), user_id)` 按 namespace+key 取回用户信息。调用 `agent.invoke(..., context=Context(user_id="user_123"))` 注入上下文。

> 其余 provider 的 `model=` 参数（仅此一行不同，其余代码与上方 Anthropic 版一致）：
> - `google_genai:gemini-3.6-flash`（Google）
> - `openai:gpt-5.5`（OpenAI）
> - `openrouter:z-ai/glm-5.2`（OpenRouter）
> - `fireworks:accounts/fireworks/models/glm-5p2`（Fireworks）
> - `baseten:zai-org/GLM-5.2`（Baseten）
> - `ollama:north-mini-code-1.0`（Ollama）

## Write long-term memory from tools

> **译：** 从 tools 写入长期记忆

> ℹ️ 与上一节相同，原文此处 InMemoryStore 标签页下以 `<CodeGroup>` 提供 7 个 provider 的等价示例，**仅 `model=` 参数不同**。下方保留 Anthropic 版；其余 6 个 provider 的 model 字符串与上一节一致。

```python title="Write — InMemoryStore (Anthropic)"
from dataclasses import dataclass

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from langchain_core.runnables import Runnable
from langgraph.store.memory import InMemoryStore
from typing_extensions import TypedDict

# InMemoryStore saves data to an in-memory dictionary. Use a DB-backed store in production.
store = InMemoryStore()


@dataclass
class Context:
    user_id: str


# TypedDict defines the structure of user information for the LLM
class UserInfo(TypedDict):
    name: str


# Tool that allows agent to update user information (useful for chat applications)
@tool
def save_user_info(user_info: UserInfo, runtime: ToolRuntime[Context]) -> str:
    """Save user info."""
    # Access the store - same as that provided to `create_agent`
    assert runtime.store is not None
    store = runtime.store
    user_id = runtime.context.user_id
    # Store data in the store (namespace, key, data)
    store.put(("users",), user_id, dict(user_info))
    return "Successfully saved user info."


agent: Runnable = create_agent(
    model="anthropic:claude-sonnet-4-6",
    tools=[save_user_info],
    store=store,
    context_schema=Context,
)

# Run the agent
agent.invoke(
    {"messages": [{"role": "user", "content": "My name is John Smith"}]},
    # user_id passed in context to identify whose information is being updated
    context=Context(user_id="user_123"),
)

# You can access the store directly to get the value
item = store.get(("users",), "user_123")
```

```python title="Write — PostgreSQL"
from dataclasses import dataclass

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from langchain_core.runnables import Runnable
from langgraph.store.postgres import PostgresStore  # type: ignore[import-not-found]
from typing_extensions import TypedDict


@dataclass
class Context:
    user_id: str


class UserInfo(TypedDict):
    name: str


@tool
def save_user_info(user_info: UserInfo, runtime: ToolRuntime[Context]) -> str:
    """Save user info."""
    assert runtime.store is not None
    runtime.store.put(("users",), runtime.context.user_id, dict(user_info))
    return "Successfully saved user info."


DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable"

with PostgresStore.from_conn_string(DB_URI) as store:
    store.setup()
    agent: Runnable = create_agent(
        "claude-sonnet-4-6",
        tools=[save_user_info],
        store=store,
        context_schema=Context,
    )

    agent.invoke(
        {"messages": [{"role": "user", "content": "My name is John Smith"}]},
        context=Context(user_id="user_123"),
    )
```

> **译：** 与读取示例镜像对称：定义 `UserInfo(TypedDict)` 约束 LLM 传入的参数结构；`@tool` 函数 `save_user_info` 通过 `runtime.store.put(("users",), user_id, dict(user_info))` 写入记忆。agent 运行后，可直接 `store.get(("users",), "user_123")` 取回写入的值。其余 6 个 provider（Google / OpenAI / OpenRouter / Fireworks / Baseten / Ollama）的 `model=` 参数与上一节末尾列出的一致。
