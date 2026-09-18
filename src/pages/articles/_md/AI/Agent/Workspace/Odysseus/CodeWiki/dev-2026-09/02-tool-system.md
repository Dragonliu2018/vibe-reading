---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "工具系统"
date: "2026-09-18T17:22:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "工具调用", "安全门控", "审批"]
description: "Odysseus 工具系统：ToolBlock 统一管线、多方言解析、ToolEffect × ResultIntegrity 能力矩阵、digest 封印的一次性审批、不可信上下文传播门与两级文件 sandboxing——这是全库安全设计密度最高的模块。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

工具系统回答的问题是：**模型"想"做一件事之后，怎么安全地把它做掉**。Odysseus 给 agent 开放了 bash、python、文件读写、日历、邮件、网络抓取、MCP 全域工具——权力极大，因此这个模块把"每个工具危险吗、结果可不可信、谁批准、在哪个目录里跑"做成了独立于循环编排的完整安全体系。它在架构里是 [Agent 执行引擎](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/01-agent-engine)的执行臂：agent_loop 每轮把 `ToolBlock` 交给它，它决定放行、拦截还是找人审批。

代码分布在 `src/tools/`（11 文件 4020 行，函数式旧层）、`src/agent_tools/`（11 文件 4421 行，类封装新层，被 import 35 次）、`src/tool_schemas.py`（1595 行 schema）、`src/tool_parsing.py`（1522 行多方言解析）、`src/tool_execution.py`（1417 行执行器）、`src/tool_capabilities.py`（708 行能力矩阵）、`src/tool_index.py`（629 行 RAG 选择）、`src/tool_approvals.py`（513 行审批存储）、`src/tool_approval_scopes.py`（审批范围）、`src/tool_policy.py` / `src/tool_security.py`（策略与安全上下文）。

## 模块架构

核心抽象只有一个 namedtuple：`ToolBlock = namedtuple("ToolBlock", ["tool_type", "content"])` in `src/agent_tools/__init__.py:116`——工具名 + 原始文本，解析、审批、执行全程围绕它流转。**没有装饰器、没有基类**，`execute` 只是鸭子类型约定（`async def execute(self, content: str, ctx: dict) -> dict`）。实现分两层并存（历史迁移产物）：类封装层（新，`src/agent_tools/` 下每域一个类，注册进模块级 `TOOL_HANDLERS` dict，`:37`，并用 `TOOL_HANDLERS.update(ADMIN_TOOL_HANDLERS)` 合并管理员工具）；函数封装层（旧，`do_*` 前缀函数在 `src/tools/`，`src/tool_implementations.py` 作 re-export shim 保持旧 import 路径兼容）。`_execute_tool_block_impl()` in `src/tool_execution.py:965` 里的 `__import__("src.agent_tools")` 旁注明是循环依赖的临时 HACK（issue #4277 拟把注册表迁到独立 registry.py）。

四条防线串联成管线：**能力矩阵**（静态声明）→ **审批门控**（动态决策）→ **执行闸**（运行时四道闸）→ **结果信任传播**（事后观察）。每条防线独立可测，这是这个模块最大的结构优点。

## 调用链路

![工具调用管线](/vibe-reading/images/articles/odysseus-codewiki-dev-2026-09/tool-pipeline.svg)

模型输出 → `parse_tool_blocks()` in `src/tool_parsing.py:1284`（多方言解析总入口，串联 `_parse_misfenced_web_lookup()`、`_parse_raw_openai_tool_call_json()`、`_parse_xml_invoke()`、`_parse_stepfun_tool_call()`、`_parse_gemma_tool_call()` 等十余种格式——不同模型把工具调用写成 fenced block / XML / 裸 JSON 的混乱输出都要接住；fence 匹配靠 `_TOOL_BLOCK_RE`（`:33`，`(?![\w-])` 负向断言防 ` ```python3 ` 被前缀误匹配成 python 工具），`_CODE_FENCE_TAGS = frozenset({"bash", "python"})`（`:43`）的 bash/python 同行文本一律视为展示文本（如 ` ```python title="x.py" `）不当参数，其他标签的同行文本须与正文合并后能整体过 `json.loads` 才执行；**空内容的 fence** 只有 `BUILTIN_EMAIL_TOOLS`（`src/tool_security.py` 导入）标签仍生成 `ToolBlock(tag, "")` 派发——空参数让工具自身校验去应答，静默丢弃曾让模型断定 email 工具坏了——bash/python 等其余标签空内容直接跳过；原生 function call 则由 `function_call_to_tool_block()` in `src/tool_schemas.py:1370` 反向转成 ToolBlock 统一管线）→ 参数解析 `_parse_tool_args()` in `src/tool_utils.py:60`（leaf 模块，刻意不 import 任何 src 模块以断循环依赖，还能解包小模型常见的 `{"body": {...}}` 信封）→ 能力门控 `ToolRunSecurityContext.decision_for()` in `src/tool_capabilities.py:654` → 通过则 `execute_tool_block()`（薄包装：校验 security_context 必传、claim 审批、用 contextvar `_active_workspace` 绑定本轮 workspace）→ `_execute_tool_block_impl()` 分派到 `TOOL_HANDLERS`、`_MCP_TOOL_MAP`（`_call_mcp_tool()` in `src/tool_execution.py:679`）或 `do_*` 直调 → `format_tool_result()`（`:1359`）格式化为 markdown 喂回模型，`_append_tool_results()`（agent_loop.py:2993）同时调 `tool_result_should_arm_gate()` 判断结果是否引入了不可信内容。未通过则 `tool_approval_store.create()` in `src/tool_approvals.py:339` 生成 `PendingToolApproval`，返回 `{"approval_required": True, "ask_user": ...}` 卡片；用户在浏览器点击 → `peek()/consume()`（`routes/chat_routes.py:1164/1189`）→ 以 `ExactToolApproval` 重入 `run_agent`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `parse_tool_blocks()` :1284 (tool_parsing.py) | 多方言解析总入口 | 十余种格式串联，接各种模型方言 |
| `_parse_tool_args()` :60 (tool_utils.py) | JSON/dict 参数解析 | leaf 模块断循环依赖；解 `{"body":…}` 信封 |
| `decision_for()` :654 (tool_capabilities.py) | 能力门控判定 | 未知工具 fail high |
| `execute_tool_block()` :810 (tool_execution.py) | 执行薄包装 | contextvar 绑定 workspace |
| `_execute_tool_block_impl()` :965 | 四道闸 + 分派 | `__import__` 临时 HACK（#4277） |
| `_resolve_tool_path()` :357 | 无 workspace 时路径校验 | allowlist roots + sensitive denylist + hardlink 检查 |
| `_resolve_tool_path_in_workspace()` | 有 workspace 时收紧 | realpath 先解 symlink 防逃逸 |
| `vet_workspace()` :466 | 绑定时拒绝敏感目录/根 | 根的 dirname==自身即拒绝 |
| `observe_tool_result()` :686 (tool_capabilities.py) | 结果信任观察 | 外部内容标记 untrusted，武装门 |
| `ExactToolApproval.matches()/claim()` :276/294 (tool_approvals.py) | 一次性审批消费 | `_canonical_digest()` 防重放 |
| `get_tools_for_query()` :518 (tool_index.py) | RAG 工具选择 | ChromaDB top-8 + `ALWAYS_AVAILABLE` 保底 |
| `index_mcp_tools()` :224 (tool_index.py) | MCP 工具进索引 | 与内置工具同池检索 |

</details>

## 核心实现

### 能力矩阵：把"危险吗"变成静态声明

`src/tool_capabilities.py:21-42` 定义了两个正交维度：`ToolEffect`（12 种效果，READ_PRIVATE … DESTRUCTIVE）与 `ResultIntegrity`（SYSTEM / WORKSPACE_UNTRUSTED / EXTERNAL_UNTRUSTED）。`_register()`（`:60`）静态声明每工具的能力，`capabilities_for_action()` 按 action 细分（如 `manage_calendar` 的 list 只读 vs create_event 写私有）。设计动机：门控逻辑（`decision_for()`）只读矩阵不看工具实现——新增工具忘记声明则按 `_UNKNOWN_CAPABILITIES` fail high：`known=False`、`result_integrity=EXTERNAL_UNTRUSTED`、effects 给满 8 种（READ_PRIVATE / WRITE_WORKSPACE / WRITE_PRIVATE / EXECUTE_CODE / NETWORK_EGRESS / EXTERNAL_SIDE_EFFECT / ADMIN_CHANGE / DESTRUCTIVE）——未知即最严；`mcp__email__` 前缀工具剥离前缀后按裸名查表（仅当裸名在 `BUILTIN_EMAIL_TOOLS` 中才复用其能力）。plan mode 用 allowlist 而非 blocklist（新工具默认禁用）。fail-safe 默认贯穿：宁可多问一次用户，不放行一个没声明过的工具。

### 审批门控与封印消费

审批三档 scope（`ToolApprovalScope` in `src/tool_approval_scopes.py:145`）：`SINGLE_ACTION`（默认，一次）、`TASK`、`CHAT_SESSION`。`ExactToolApproval` 用 `_canonical_digest()` 封印工具 content 做一次性匹配消费（`claim()`），destructive 动作防重放——同一审批不能执行两次。`consume()`（`src/tool_approvals.py:426`）的 `allow_continuation=False` 分支返回 `ExactToolApproval(pending, scope=SINGLE_ACTION, allow_remaining_actions=False)`：调用方没有可续会话（skill tester、无人值守审计）时，"Allow once" 按钮不能借聊天卡片复用同一 wire 值扩大成全程豁免；**鉴权检查在破坏性消费（pop）之前**——owner/session 不匹配先返回 None，泄漏或猜到的 opaque approval id 无法销毁他人的 pending。同一 owner + 非空 session 的 `create()` 会取代（supersede）旧 pending。`CHAT_SESSION` 档走 HMAC 签名 grant（`sign_chat_session_grant()`）持久化在服务端 transcript——**防 fork 会话继承授权**：fork 出的新会话 transcript 里没有带签名的 grant，门控重新武装。delegated credential（API token 调用）硬拒 `is_public_blocked_tool()`，任何审批不可豁免——token 拿到的会话永远不能跑管理员级工具。

### 不可信上下文传播门

这套机制防的是 prompt injection 的"接力"：`observe_tool_result()`（`tool_capabilities.py:686`）观察每次工具结果——web_fetch 抓回的网页、MCP isError 文本都算外部内容，一旦发现 `external_untrusted_context_seen=True`，此后**任何带 `POST_EXTERNAL_BLOCKED_EFFECTS` 效果的工具都要 exact approval**。即看过网页的 agent 想发邮件、改文件，必须人来解锁。网页内容本身经 `untrusted_context_message()` in `src/prompt_security.py:64` 包裹进 guard 块（不能进 system role）。

### 两级文件 sandboxing

`_resolve_tool_path()` in `src/tool_execution.py:357` 的检查顺序（docstring 明示）：非空校验 → 敏感子路径 deny（`.ssh` / `.gnupg` / `id_rsa` 等，casefold 大小写不敏感——即使根在 allowlist 内也拦）→ app-state 路径 → 硬链接文件拒绝 → allowlist 包含（agent_workspace / uploads / mail-attachments / personal 等数据子目录 + `/tmp` + `$TMPDIR` + `tool_path_extra_roots` 设置项；**`$HOME` 不在默认 allowlist**——要访问主目录需显式配置额外 root）；有 workspace 时 `_resolve_tool_path_in_workspace()` 收紧到 workspace 内（相对路径解析到 workspace 下、逃逸即拒绝）。绑定时的 `vet_workspace()`（`:466`）拒绝敏感目录与文件系统根。**为什么 realpath 先解 symlink**：模型给的路径不可信，符号链接可以指到边界外。注释明说 bash/python 本身"shell starts there but is not sandboxed"（shell 从那里启动但不沙箱）——进程级不隔离，用 plan-mode/admin blocklist 补偿。这是坦率的取舍：完全沙箱（容器/用户命名空间）与"自托管便利性"冲突，Odysseus 选了路径级防护 + 审批门。

### 工具选择的 RAG 化

`ToolIndex`（`src/tool_index.py`）不把全部 schema 塞 prompt——`BUILTIN_TOOL_DESCRIPTIONS`（`:69`）为每工具写富描述用于向量化，`get_tools_for_query()`（`:518`）用 ChromaDB 检索 top-8，叠加 `ALWAYS_AVAILABLE`（manage_memory/ask_user/update_plan）保底，MCP 工具也经 `index_mcp_tools()`（`:224`）进同一池。文件头注释直说动机：**避免 agent prompt 膨胀压垮小模型**。超时回退 `_KEYWORD_HINTS` 关键词匹配。

### `#!bg` 后台作业

bash 工具首行命中 `_BG_MARKERS`（`src/tool_execution.py:734`，含 `#!bg` / `#bg` / `# bg` / `#background` / `@background` 等变体，由 `_split_bg_marker()` `:737` 识别）且 **session_id 存在**时，命令 detach 成后台 job（`bg_jobs.launch()`，返回 `bg_job_id`）；无 session_id 或无标记则正常前台执行。状态从磁盘 exit-code 文件推导（重启安全），完成后 `bg_monitor` 重新唤起 agent auto-continue。长命令（模型下载、训练）不再阻塞 SSE 流。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 注册表 + 门面 | `TOOL_HANDLERS` in `src/agent_tools/__init__.py:37` | 按名注册，执行器零改动扩工具 |
| 策略枚举矩阵 | `ToolEffect` × `ResultIntegrity` in `src/tool_capabilities.py:21-42` | 危险性静态声明，门控与实现解耦 |
| 审批门控 + 封印消费 | `ExactToolApproval.matches()/claim()` in `src/tool_approvals.py:276/294` | digest 一次性匹配防重放 |
| 能力协商 | `_tool_schemas_for_route()` in `src/agent_loop.py:4484` | 按端点能力裁剪 schema |

## 模块间交互

被 agent_loop 全量消费（解析/执行/审批）；`bg_jobs` 由 `#!bg` 触发、`bg_monitor` 唤起 agent；MCP 工具经 `_MCP_TOOL_MAP`（`tool_execution.py:563`）映射为 `mcp__<server>__<tool>` 限定名走 `mcp.call_tool()`，断连时 `_direct_fallback()`（`:690`）兜底老式工具名直调；`routes/chat_routes.py` 承载审批卡片 peek/consume/retire 入口；task_scheduler 与 teacher_escalation 复用同一 approval store。与记忆模块的交互经 MCP：`manage_memory` 是内置 MCP server 暴露的工具。

## 扩展方式

新增一个 agent 工具要动七处（漏一处即静默失败，顺序即依赖序）：① `src/tools/<域>.py` 写 `do_xxx()`（或注册 `TOOL_HANDLERS`）；② `src/tool_schemas.py` 加 `FUNCTION_TOOL_SCHEMAS` 条目；③ `src/agent_tools/__init__.py` 的 `TOOL_TAGS` 加名字——cookbook 工具曾因漏这步 fence 解析静默失败；④ `src/tool_execution.py` 的 elif 链或 `_MCP_TOOL_MAP`；⑤ `src/tool_capabilities.py` `_register()` 声明 effects/integrity（不声明 fail high）；⑥ `src/tool_index.py` 的 `BUILTIN_TOOL_DESCRIPTIONS` 加检索描述；⑦ 视情况更新 `src/tool_security.py` 的 `NON_ADMIN_BLOCKED_TOOLS` / `PLAN_MODE_READONLY_TOOLS`。对应测试：`tests/test_action_intents*.py`、`tests/tools/`。
