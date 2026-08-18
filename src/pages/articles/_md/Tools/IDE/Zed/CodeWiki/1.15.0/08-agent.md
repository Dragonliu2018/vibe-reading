---
source:
  type: "源码解读"
  project: "zed"
  url: "https://github.com/zed-industries/zed"
title: "AI 代理"
date: "2026-08-18T11:06:09+08:00"
category: [Tools, IDE, Zed, CodeWiki, "1.15.0"]
tags: ["zed", "Rust", "code editor", "GPUI", "CRDT"]
description: "Zed AI Agent：agentic loop、工具注册表、多 LLM provider 抽象、沙箱权限"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/00-overview)

---

## 模块定位

`agent` crate 是 Zed 内置 AI 编程助手的核心——它实现了一个完整的 agentic loop：用户提示 → 模型流式响应 → 工具调用 → 工具执行 → 结果回传 → 循环至完成。`agent` 管理会话线程（`Thread`）、工具注册表、沙箱执行、权限授权；`agent_ui` 提供对话面板 UI；`language_models` + 各 provider crate（`anthropic` / `open_ai` / `ollama` 等）抽象 LLM 访问。

Zed 的 Agent 不是简单的代码补全——它是一个能读写文件、执行终端命令、搜索代码库、调用 LSP 的自主代理。它通过 ACP（Agent Client Protocol）与模型交互，通过工具注册表扩展能力。

---

## 模块架构

```
agent/                          # AI Agent 核心（87K 行）
├── src/agent.rs                # Agent 顶层管理
├── src/thread.rs               # Thread（会话状态机 + agentic loop）
├── src/thread_store.rs         # ThreadStore（多会话管理）
├── src/tools/                  # 工具实现（每个文件一个工具）
│   ├── edit_file_tool.rs       # 编辑文件
│   ├── grep_tool.rs            # 代码搜索
│   ├── find_path_tool.rs       # 查找文件
│   ├── list_directory_tool.rs  # 列目录
│   ├── read_file_tool.rs       # 读文件
│   ├── delete_path_tool.rs     # 删除文件
│   ├── move_path_tool.rs       # 移动/重命名
│   ├── fetch_tool.rs           # HTTP 抓取
│   ├── ask_user_tool.rs        # 向用户提问
│   ├── create_thread_tool.rs   # 创建子 agent
│   ├── diagnostics_tool.rs     # LSP 诊断
│   ├── get_code_actions_tool.rs # 代码操作
│   ├── go_to_definition_tool.rs # 跳转定义
│   ├── find_references_tool.rs # 查找引用
│   ├── apply_code_action_tool.rs # 应用代码操作
│   └── ...
├── src/tool_permissions.rs     # 工具权限授权
├── src/sandboxing.rs           # 沙箱执行
├── src/templates/              # 提示模板
├── src/pattern_extraction.rs   # 模式提取
└── src/db.rs                   # 会话持久化

agent_ui/                       # AI 对话面板 UI（84K 行）
├── src/agent_panel.rs          # AgentPanel（主面板）
└── ...                         # 消息渲染 / 工具调用 UI / 授权弹窗

language_model_core/           # LLM 抽象核心
language_model/                # LanguageModel / LanguageModelProvider trait
language_models/               # 注册表 + 配置
language_models_cloud/         # 云端模型（Zed AI）

anthropic/ open_ai/ ollama/    # 各 LLM provider 实现
google_ai/ deepseek/ mistral/  # （15+ provider crate）
open_router/ lmstudio/ bedrock/ x_ai/ copilot/
```

---

## 调用链路

**Agentic loop 链路**（用户输入提示到工具执行循环）：

```
用户输入提示 → AgentPanel → Thread::stream_completion()
  │
  ├─ 组装 messages 历史 + system prompt + 工具 schema
  │
  └─ LanguageModel::stream_completion(request, cx)     (language_model.rs:65)
       │
       ├─ 流式返回 delta（文本 / thinking / tool_call）
       │
       ├─ Thread::handle_stream_event(event)
       │    │
       │    ├─ AgentText(delta) → 追加到当前消息，UI 更新
       │    ├─ AgentThinking(delta) → 追加思考，UI 更新
       │    │
       │    └─ ToolCall(tool_call) → 进入工具执行:
       │         │
       │         ├─ 查 tools registry: BTreeMap<name, Arc<dyn AnyAgentTool>>
       │         │
       │         ├─ 权限检查 (tool_permissions.rs):
       │         │    ├─ 已授权（sandbox_grants）→ 直接执行
       │         │    └─ 需授权 → ThreadEvent::ToolCallAuthorization
       │         │         └─ UI 弹窗 → 用户批准/拒绝
       │         │
       │         ├─ 执行工具 (sandboxing.rs 沙箱):
       │         │    ├─ edit_file_tool → MultiBuffer::edit / Buffer::edit
       │         │    ├─ grep_tool → search crate
       │         │    ├─ list_directory_tool → Worktree::read_dir
       │         │    └─ fetch_tool → http_client
       │         │
       │         ├─ ThreadEvent::ToolCallUpdate → UI 显示结果
       │         │
       │         └─ 工具结果作为新 message 加入历史
       │              │
       │              └─ 继续调用 LanguageModel::stream_completion
       │                   （循环直到模型返回 Stop）
       │
       └─ Stop(reason) → running_turn 结束
            └─ ThreadEvent::Stop → UI 更新为完成状态
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `Thread::stream_completion()` | 启动一轮模型调用 | `running_turn` 持有整个轮次的 Task，跨多次请求存活 |
| `LanguageModel::stream_completion()` (`language_model.rs:65`) | 流式调用 LLM | trait 抽象——provider 无关，运行时切换模型 |
| `Thread::handle_stream_event()` | 处理流式响应 | 解析 tool_call 并触发工具执行 |
| Tool 执行 | `tools/*.rs` 各工具 `run()` | 沙箱隔离 + 权限授权 |

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `Thread::new()` | `thread.rs` | 创建会话线程 |
| `Thread::new_subagent()` | `thread.rs` | 创建子 agent（继承父上下文） |
| `Thread::insert_user_message()` | `thread.rs` | 添加用户消息 |
| `Thread::retry()` | `thread.rs` | 重试上一轮 |
| `Thread::cancel()` | `thread.rs` | 取消当前轮次 |
| `LanguageModelProvider::load()` | `language_model.rs:344` | 加载 provider 实例 |
| `Thread::summarize()` | `thread.rs` | 上下文压缩（context compaction） |

</details>

---

## 核心实现

### `Thread`：会话状态机

`Thread`（`thread.rs:1243`）是 Agent 的核心——一个 AI 对话会话的完整状态：

```rust title="crates/agent/src/thread.rs"
pub struct Thread {
    id: acp::SessionId,
    prompt_id: PromptId,
    title: Option<SharedString>,
    summary: Option<SharedString>,
    messages: Vec<Arc<Message>>,
    /// Holds the task that handles agent interaction until the end of the turn.
    /// Survives across multiple requests as the model performs tool calls and
    /// we run tools, report their results.
    running_turn: Option<RunningTurn>,
    /// When set, the current turn ends at the next message boundary instead of
    /// running to completion. The UI sets this to deliver a "steering" queued
    /// message mid-task.
    end_turn_at_next_boundary: bool,
    pending_message: Option<AgentMessage>,
    pub(crate) tools: BTreeMap<SharedString, Arc<dyn AnyAgentTool>>,
    cumulative_token_usage: TokenUsage,
    pub(crate) project: Entity<Project>,
    pub(crate) action_log: Entity<ActionLog>,
    pub(crate) context_server_registry: Entity<ContextServerRegistry>,
    project_context: Entity<ProjectContext>,
    model: ThreadModel,
    thinking_enabled: bool,
    thinking_effort: Option<String>,
    subagent_context: Option<SubagentContext>,    // 子 agent 上下文
    running_subagents: Vec<WeakEntity<Thread>>,   // 子 agent 弱引用
    sandbox_grants: Rc<RefCell<ThreadSandboxGrants>>,  // 会话级授权
    // ...
}
```

两个设计决策值得注意：

1. **`running_turn` 跨请求存活**：一个"轮次"（turn）可能包含多次模型调用——模型返回 tool_call，执行工具，把结果回传模型，模型继续。`running_turn` 是持有整个轮次的 Task，直到模型返回 `Stop` 才结束。这让用户看到的是连续的 agent 行为，而非离散的请求。

2. **`end_turn_at_next_boundary` 中途引导**：用户可以在 agent 执行中途发送新消息"引导"agent。设置此标志后，当前轮次在下一个消息边界结束（而非跑到完成），让用户新消息介入。这是"steering"——中途调整 agent 方向。

`ThreadEvent`（`thread.rs:872`）是 Thread 向 UI 通信的事件流：`UserMessage` / `AgentText` / `AgentThinking` / `ToolCall` / `ToolCallUpdate` / `ToolCallAuthorization` / `Elicitation` / `SubagentSpawned` / `Retry` / `ContextCompaction` / `Stop`。每个事件对应 UI 的一次更新——流式文本追加、工具调用卡片、授权弹窗等。

### `LanguageModel`：Provider 抽象

`LanguageModel` trait（`language_model.rs:65`）抽象所有 LLM provider：

```rust title="crates/language_model/src/language_model.rs"
pub trait LanguageModel: Send + Sync {
    fn stream_completion(&self, request: LanguageModelRequest, cx: ...)
        -> Task<Result<LanguageModelCompletionEvent>>;
    // ... 模型能力查询 / token 计数 / 速率限制
}

pub trait LanguageModelProvider: 'static {
    fn load(&self, model: &str, cx: ...) -> Task<Result<Box<dyn LanguageModel>>>;
    // ... provider 元数据 / 认证
}
```

Zed 支持 15+ provider：`anthropic`（Claude）、`open_ai`（GPT）、`google_ai`（Gemini）、`deepseek`、`mistral` / `codestral`、`ollama` / `lmstudio` / `llama_cpp`（本地模型）、`open_router`、`bedrock`、`x_ai`、`copilot`。每个 provider crate 实现 `LanguageModelProvider` 和 `LanguageModel`。`ThreadModel` 在 `Thread` 中持有当前选用的模型实例，运行时可切换——用户可以在对话中途换模型。

### 工具系统

`Thread` 的 `tools: BTreeMap<SharedString, Arc<dyn AnyAgentTool>>` 是工具注册表。每个工具（`crates/agent/src/tools/*.rs`）实现 `AnyAgentTool` trait，提供：

- `name()`——工具名（如 `"edit_file"`）
- `input_schema()`——JSON Schema 描述输入参数（传给模型让它知道如何调用）
- `run(input, cx)`——异步执行，返回流式结果

工具覆盖了完整的代码操作能力：文件读写（`edit_file` / `read_file` / `delete_path` / `move_path` / `create_directory` / `list_directory`）、代码搜索（`grep` / `find_path` / `find_references` / `go_to_definition`）、LSP 交互（`diagnostics` / `get_code_actions` / `apply_code_action`）、网络（`fetch`）、用户交互（`ask_user`）、子 agent（`create_thread`）。

**沙箱与权限**：`sandboxing.rs` 为终端/文件操作提供沙箱隔离；`tool_permissions.rs` 管理用户授权——破坏性工具（删除、执行命令）需要用户批准。`ThreadSandboxGrants` 记录会话内已授权的操作，避免重复弹窗——用户批准一次"删除文件"后，同会话内的后续删除自动放行。授权通过 `ThreadEvent::ToolCallAuthorization` 请求 UI 交互。

### 子 Agent

`Thread::new_subagent()`（`thread.rs`）创建子 agent 线程——主 agent 可以生成子 agent 处理子任务。子 agent 继承父的 `project` / `project_context` / `model` / `templates`，但有独立的消息历史和工具上下文。`subagent_context` 记录父线程关系，`running_subagents` 持有子 agent 弱引用用于取消传播。这让复杂任务可以分解——主 agent 协调，子 agent 并行处理子任务。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Agentic loop | `Thread::running_turn` | 跨多次请求的连续轮次，工具调用后自动续调模型 |
| Provider 抽象 | `LanguageModel` / `LanguageModelProvider` trait | 15+ provider 统一接口，运行时切换模型 |
| 工具注册表 | `BTreeMap<SharedString, Arc<dyn AnyAgentTool>>` | 工具按名注册，模型通过 schema 发现并调用 |
| 事件流 | `ThreadEvent` + `EventEmitter` | UI 通过事件订阅实时更新，与 agent 逻辑解耦 |
| 沙箱 + 权限 | `sandboxing.rs` + `tool_permissions.rs` + `ThreadSandboxGrants` | 破坏性操作需授权，会话级授权避免重复弹窗 |
| 子 Agent | `new_subagent` + `running_subagents` | 任务分解，子 agent 独立上下文并行处理 |

---

## 模块间交互

- **依赖**：`project`（文件操作 / LSP / 搜索）、`language_model` + 各 provider crate（LLM 访问）、`gpui`（Entity/View/事件）、`acp_thread`（Agent Client Protocol）、`context_server`（MCP 工具）、`search`（grep 工具）、`http_client`（fetch 工具）、`terminal`（终端工具）。
- **被依赖**：`agent_ui`（AgentPanel UI）、`zed`（`initialize_agent_panel` 创建面板）、`agent_settings` / `agent_skills`（配置与技能）。
- **交互方式**：`Thread` 通过 `Entity<Project>` 调用 `Project` 的方法执行文件操作（`open_path` / `save_buffer` / `search`）；通过 `LanguageModel` trait 调用 LLM（provider 无关）；通过 `ThreadEvent` 向 `agent_ui` 推送 UI 更新；通过 `ContextServerRegistry` 接入 MCP 工具。工具执行结果作为消息回传模型形成循环。无循环依赖——`agent` 不依赖 `agent_ui`（UI 订阅 agent 事件，反向依赖）。

---

## 扩展方式

**新增一个 Agent 工具**（如"运行测试"）：

1. `crates/agent/src/tools/` 新增工具文件（如 `run_tests_tool.rs`），实现 `AnyAgentTool` trait——提供 `name()` / `input_schema()` / `run()`
2. `crates/agent/src/tools.rs` 在工具注册表注册
3. 若需权限授权，在 `tool_permissions.rs` 添加权限规则
4. 若需 UI 交互（如展示测试结果），扩展 `ThreadEvent`（`thread.rs:872`）
5. 对应测试：`crates/agent/tests/`

**新增一个 LLM provider**（如"接入新模型 API"）：

1. 创建 provider crate（如 `crates/my_provider/`），实现 `LanguageModelProvider` 和 `LanguageModel` trait（`language_model/src/language_model.rs:65`）
2. `crates/language_models/src/` 在注册表注册 provider
3. `assets/settings/` 添加 provider 配置 schema
4. 对应测试：provider crate 内的集成测试
