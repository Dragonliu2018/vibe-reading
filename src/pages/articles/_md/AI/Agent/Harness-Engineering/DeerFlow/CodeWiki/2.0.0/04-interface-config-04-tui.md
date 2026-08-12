---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "TUI"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "Textual", "TUI"]
description: "DeerFlow 终端工作台解析：Textual App、Command 注册表、MVC 分离、plan_launch 纯决策函数与降级。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 接口与配置](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/04-interface-config)

---

## 模块定位

本模块属于 **接口与配置** 子系统。`tui/`（2.3k 行）是终端交互界面——`[project.scripts] deerflow = "deerflow.tui.cli:main"` 的入口。基于 Textual 框架，让用户在终端跑 agent、看 trace、调命令，是除 gateway(HTTP) 和 channels(IM) 之外的第三种交互入口，也是唯一不经过网络层的入口（`DeerFlowClient` 直连 harness）。textual 是可选依赖——核心 harness 不依赖它，缺 textual 时降级为 headless help；`deerflow --print`/`--json` 仍可用。LLM Space 姊妹项目用它调试 agent。

## 核心实现

### DeerFlowTUI — Textual App 主类（god 59）

```python title=backend/packages/harness/deerflow/tui/app.py
class DeerFlowTUI(App):
    CSS = f"""Screen {{ background: {THEME.bg}; ... }}"""  # 内联全部布局样式
    BINDINGS = [
        Binding("ctrl+c", "interrupt", "Interrupt / Quit", priority=True),
        Binding("ctrl+l", "redraw", show=False),
        Binding("down", "nav_down", show=False, priority=True),  # 历史或 palette
        Binding("tab", "palette_complete", show=False),
        Binding("enter", "palette_accept", show=False),
    ]
    def __init__(self, session, plan): ...
    def compose(self): ...   # 5 区域: header/scroll/status/palette/composer
    def on_mount(self): ...  # _load_session_info (list_models + list_skills) + 定时器(spinner 0.1s, flush 0.06s)
    def _handle_submit(self, text): ...  # 分类: builtin/skill/unknown/message
    def _send_to_agent(self, text): ...  # 启动 worker 线程
    def _stream_worker(self, text, thread_id): ...  # 后台线程跑 stream_actions
    def _on_action(self, action): ...   # UI 线程回调: reduce state + 刷新
    def _open_model_picker(self): ...   # SelectScreen 选模型
    def _handle_goal(self, args): ...   # /goal set/show/clear
```

### Command — 命令注册表（god 56）

```python title=backend/packages/harness/deerflow/tui/command_registry.py
@dataclass(frozen=True)
class Command:
    name: str; description: str; category: Literal["builtin","skill"] = "builtin"
@dataclass(frozen=True)
class Resolution:
    kind: Literal["builtin","skill","unknown","message"]; name: str = ""; args: str = ""
BUILTIN_COMMANDS = (   # 17 个内建命令
    Command("help", "Show commands and keybindings"),
    Command("new", "Start a fresh thread"),
    Command("clear", "Clear the transcript display"),
    Command("threads", "Open the thread switcher"),
    Command("goal", "Set, show or clear the active goal"),
    Command("model", "Open the model picker"),
    Command("skills", "Browse enabled and available skills"),
    Command("tools", "Show built-in, MCP and sandbox tools"),
    Command("mcp", "Show MCP server status"),
    Command("memory", "Show memory status and injected facts"),
    Command("usage", "Show token usage and context"),
    Command("config", "Show resolved config paths and overrides"),
    Command("quit", "Exit the TUI"),
    # ...
)
def build_registry(skills) -> list[Command]: ...  # 合并 builtin + 动态 skill 命令
def resolve(text, skills) -> Resolution: ...     # 分类输入行
```

### Session — TUI 会话桥接

```python title=backend/packages/harness/deerflow/tui/session.py
@dataclass
class Session:
    client: DeerFlowClient              # 核心 LLM agent 客户端
    writer: ThreadMetaWriter | None     # 持久化 writer（让 TUI 会话在 Web UI 可见）
    _loop: _LoopThread | None           # 后台 DB 事件循环线程
    def resolve_thread(self, plan) -> str | None: ...  # --resume / --continue
    def recent_threads(self, limit=20) -> list[dict]: ...
    def close(self): ...  # 停 DB loop + dispose engine
def open_session(persistence: bool = True) -> Session: ...  # 构造 DeerFlowClient + checkpointer
```

### runtime 桥接 — stream_actions + translate

```python title=backend/packages/harness/deerflow/tui/runtime.py
class _ClientLike(Protocol):
    def stream(self, message, *, thread_id=None, **kwargs) -> Iterator[Any]: ...
def translate(event) -> list[Action]: ...
    """纯函数: 一个 StreamEvent → 0 或多个 reducer Action。
    messages-tuple → AssistantDelta/ToolStarted/ToolResult; end → RunEnded(usage); values(title) → ThreadTitle"""
def stream_actions(client, message, *, thread_id=None, **kwargs) -> Iterator[Action]: ...
    """驱动 client.stream(), yield 包裹序列: RunStarted → translate() → RunEnded。异常 → AssistantError + RunEnded。"""
```

## 调用链路

```
$ deerflow "hello"
  ▼ cli.main(argv) → plan_launch(argv, stdin_isatty, stdout_isatty, env)  [纯决策, 无 I/O]
  ▼ → LaunchPlan(mode="tui"|"print"|"json"|"headless-help")
  ▼ mode="tui" → _run_tui(plan):
       try: from deerflow.tui.app import run_tui  (lazy import)
       except ModuleNotFoundError(textual missing): 降级 headless help
       → run_tui(plan): session = open_session(persistence=True) → DeerFlowTUI(session, plan).run()
  ▼ DeerFlowTUI.on_mount: _load_session_info + _refresh_all + 定时器 + (plan.message 则立即发送)
  ▼ 用户输入 → on_input_changed (/开头触发 palette) → on_input_submitted → _handle_submit
  ▼ resolve(text, skills) → Resolution:
       builtin → _handle_builtin(name, args) → 16 分支
       skill/unknown/message → _send_to_agent(text)
  ▼ _send_to_agent: thread_id=uuid4() (if None) → _dispatch(UserSubmitted) → run_worker(_stream_worker, thread=True, group="agent")
  ▼ _stream_worker (worker 线程):
       writer.ensure_created(thread_id, metadata={"source":"tui"})
       for action in stream_actions(client, text, thread_id):  [runtime.py]
         yield RunStarted → for event in client.stream(message, thread_id): yield from translate(event) → yield RunEnded
         if _cancelled: break
         call_from_thread(_on_action, action)  [跨线程回 UI]
       writer.set_title(thread_id, latest_title) (if not cancelled)
  ▼ _on_action (UI 线程): state = reduce(state, action) → _refresh_status + (RunEnded 立即刷新 / else 等 0.06s flush 合并)
  ▼ render.py (纯函数, 无 Textual 依赖): render_transcript(state) → Rich Renderable
       UserRow→Text; AssistantRow→Markdown(完成)/Text(流式); ToolRow→Table 卡片
       → #transcript/#header/#status Static.update()
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 命令模式 | `command_registry.py` 全文 | `Command` frozen dataclass + `resolve` 分类 + `_handle_builtin` 分发。注册表单一数据源驱动 help/palette/classify，加命令只需 `BUILTIN_COMMANDS` 加一行 + `_handle_builtin` 加分支 |
| MVC 分离 | `app.py`(Controller)/`view_state.py`(Model)/`render.py`(View) | `ViewState` 不可变 frozen dataclass，`reduce(state, action)` 纯 reducer；`render.py` 纯渲染函数（无 Textual 依赖，可纯 pytest 测试） |
| Facade 桥接 | `runtime.py` `stream_actions`+`translate` | `DeerFlowClient.stream()` 返回原始 `StreamEvent`，`translate` 翻译为 reducer 可消费的 `Action`；`_ClientLike` Protocol 不强依赖 `DeerFlowClient` 可 mock |
| 降级 | `cli.py` `_run_tui` + `pyproject.toml` `tui=["textual>=0.80"]` | textual 可选，lazy import + `try/except ModuleNotFoundError` 降级 headless help；核心 harness 不依赖 textual |
| Worker 线程 | `app.py` `_stream_worker` + `_on_action` | `DeerFlowClient.stream()` 是同步 generator，`run_worker(thread=True)` 独立线程跑，`call_from_thread` 回 UI 线程执行 reducer，`group="agent"` 确保同时只一个 run |
| Reducer/Flux | `view_state.py` `reduce` | 纯函数 reducer，state 不可变，可纯 pytest 测试无需终端 |

## 模块间交互

- **依赖**：`deerflow.client`（DeerFlowClient）、`deerflow.runtime.checkpointer.provider`（get_checkpointer）、`deerflow.runtime.goal`（parse_goal_command，跨包）、`deerflow.config.paths`（persistence）、`deerflow.tui.*`（command_registry/render/runtime/view_state/theme/input_history/widgets）。
- **被调用**：`pyproject.toml` 的 `[project.scripts] deerflow` console script → `cli.main`。
- **与 gateway/channels 分工**：三者共享 `DeerFlowClient`。TUI 通过 `open_session()` 构造 embedded client + checkpointer，唯一不经过网络层的入口；`writer`（`ThreadMetaWriter`）把终端会话写入 `threads_meta` 表，让 Web UI sidebar 看到 TUI 创建的会话——这是 TUI 与 gateway 的数据互通点。

## 核心实现（续）

### 为什么单独做 TUI

终端工作台面向开发者在终端内调试 agent——gateway 需 HTTP server + 前端部署，TUI 零部署成本（`pip install deerflow-harness[tui]` 后直接 `deerflow`）。适合快速验证 agent 行为（`deerflow --print "问题"` 一行出答案）、CI 冒烟测试（`--json` 流式 NDJSON 可管道处理）、无 GUI 的 SSH 环境。

### 为什么用 Textual

Python 生态最成熟的终端 UI 框架——App/Screen/Widget 组件体系、CSS 样式、键绑定、worker 线程（`run_worker`+`call_from_thread`）、ModalScreen。对比 raw curses/urwid，declarative CSS + dataclass state 管理让 `DeerFlowTUI` 只需 ~160 行 CSS + ~20 方法即可实现完整 chat TUI（palette 补全/模态选择/流式渲染/spinner）。`>=0.80` 保证 `run_worker(thread=True)` 等新 API 可用。

### 为什么命令做成 Command 注册表

**单一数据源驱动一切**——`BUILTIN_COMMANDS` 一处定义自动驱动 `/help` 文本（`format_command_help` 遍历生成）、斜杠 palette 实时过滤（`build_registry`+`filter_commands`）、输入分类（`resolve` 查 `_BUILTIN_NAMES`）、动态合并 skill 命令。新增命令只需 `BUILTIN_COMMANDS` 加一行 + `_handle_builtin` 加 elif，`format_command_help` docstring 明说："Derived from BUILTIN_COMMANDS so the help text can never drift out of sync."

### 为什么 textual 可选

核心 harness（`DeerFlowClient`/checkpointer/runtime）不依赖 textual——`pip install deerflow-harness`（不带 `[tui]`）仍可用 `deerflow --print`/`--json` headless 调用；gateway/channels 部署不需装 textual；CI/容器精简。`_run_tui` lazy import + `try/except ModuleNotFoundError` 降级。

### 为什么 session 独立

`Session` 把 `DeerFlowClient` 构造/thread 解析/持久化 writer 封装为独立单元：`open_session(persistence=False)` headless（不启 DB loop/engine，避免无谓连接池）；`open_session(persistence=True)` TUI（启 `_LoopThread` + `ThreadMetaWriter` 让终端会话在 Web UI 可见）；`close()` 停 DB loop + dispose engine 防泄漏。headless 和 TUI 复用同一构造逻辑，生命周期与 app 解耦（`run_tui` 的 `finally: session.close()`）。

### 为什么 reducer 纯函数化

`reduce(state, action) -> state` 纯函数 + `ViewState` frozen dataclass——流式 delta 合并/tool 卡片渲染/error 行展示可纯 pytest 测试无需终端；runtime bridge 和 Textual app 都依赖 view_state 互不依赖；0.06s `_flush_transcript` 合并依赖 state 不可变性（多次 `reduce` 产生新 state，最后 flush 统一渲染）。

### 为什么 worker 线程而非 async

`DeerFlowClient.stream()` 是同步 generator（LangGraph `stream` 同步变体）。Textual `run_worker(thread=True)` 让同步 generator 在独立线程跑，每个 yielded action 通过 `call_from_thread` 回 UI 线程，避免把同步 API 包装为 async 的开销，保证 UI 不阻塞。`exclusive=True, group="agent"` 确保同时只一个 agent run。

## 扩展方式

### 新增 TUI 命令（如 /debug）

`command_registry.py` 的 `BUILTIN_COMMANDS` 加 `Command("debug", "Toggle debug mode")`（自动让 /help、palette、resolve 生效）；`app.py` 的 `_handle_builtin` 加 elif 分支。无需改 `format_command_help`（遍历注册表生成）。

### 加 widget（如 skill 侧边栏）

`tui/widgets/` 新建 `skill_panel.py` 继承 Widget；`app.py` 的 `compose()` yield 它 + CSS 加样式 + `_load_session_info` 把 skill 名传给它。

### 改渲染样式（如代码高亮）

`render.py` 的 `render_transcript()` 的 `AssistantRow` 分支改（流式用 plain Text，完成用 `Markdown()`）；`theme.py` 的 `THEME` token 切色全站生效。

### 新增 headless 参数（如 --timeout）

`cli.py` 的 `build_parser()` 加 `add_argument("--timeout")`，`plan_launch` 解析存入 `LaunchPlan`，`_run_overrides` 传给 `client.chat/stream`。`plan_launch` 是纯函数可直接加单测验证决策。

对应测试：`backend/tests/tui/` 下 `test_command_registry.py` + `test_view_state.py` + `test_cli_plan_launch.py`。
