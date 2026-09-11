---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Tool 工具系统"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "Tool Registry", "MCP", "Safety", "Destructive Gate", "Batch"]
description: "jcode Tool 工具系统——Registry 执行管线（inflight→policy→hook→execute→telemetry）、destructive gate 两阶段门控、batch 并行工具、MCP 共享进程池、intent schema 注入、上下文溢出保护"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

Tool 子系统是模型与真实世界之间的全部边界：30+ 内置工具、`Registry` 执行管线、安全门控（destructive gate、context guard、pre/post hook）、MCP 动态工具接入。它独立于 agent 循环存在的原因：工具执行是 IO 密集且需要统一安全层和遥测的横切面——agent 循环只该关心"何时执行什么"，"怎么安全地执行"全部收在这里。`bash_destructive_gate.rs` 头注释的定位足够说明这个模块的分量："this is the only thing standing between a model's `rm -rf` and the user's data."

---

## 模块架构

```
jcode-tool-core        Tool trait + ToolContext + ensure_intent_in_schema
jcode-tool-types       ToolOutput/ToolImage + resolve_tool_name 别名映射
jcode-command-risk     Stage 1 确定性风险评估（独立 crate，零 IO）
jcode-app-core/src/tool/
  ├─ mod.rs            Registry + 执行管线 + context guard（1300+ 行）
  ├─ read/write/edit/multiedit/patch/apply_patch/ls/bash/browser/open/...
  ├─ batch.rs          并行子调用
  ├─ communicate.rs    swarm 工具（137.9K）
  ├─ ambient.rs        schedule 工具 + ambient 专属工具
  ├─ bash_destructive_gate.rs   两阶段门控胶水层
  └─ selfdev/ goal.rs todo.rs memory.rs webfetch.rs websearch.rs ...
jcode-base/src/mcp/    McpManager（每 session）+ SharedMcpPool（跨 session 共享）
```

`Tool` trait（`jcode-tool-core/src/lib.rs:145`）四要素：`name()` / `description()` / `parameters_schema()` / `execute(input, ctx)`。`to_definition()` 默认实现在中央统一注入 `intent` 字段（见下）。`ToolContext` 携带 session_id/working_dir/tool_call_id 等，`resolve_path` 处理相对路径。

**注册分两层**：`base_tools()`（`tool/mod.rs:312`）注册 26 个无状态工具进 `OnceLock` 进程级缓存（每 session 只做 Arc bump 克隆）；`Registry::new()` 追加 per-session 工具——`skill_manage`（需 SkillRegistry 引用）、`swarm`（每 session 新建，因 description 内嵌用户可编辑的 swarm prompt——已存在会话保持定义稳定保 KV cache，新 agent 立即看到 prompt 修改）、`batch`（需 `WeakRegistry` 防 Arc 环）、`conversation_search`（需独立 `CompactionManager`）、`integration_tools`（仅 `sponsors.enabled`）。`Registry::clone` 每次给新鲜 `CompactionManager`——防并行 subagent 互相污染消息历史统计。

---

## 调用链路

```
Registry::execute(name, input, ctx) [tool/mod.rs:766]
  1. inflight::mark_tool_in_flight(&ctx.tool_call_id)      RAII 引用计数
  2. SessionToolPolicy 白名单（allowed/disabled）
  3. 未知工具恢复：closest_tool_names() → "Did you mean" + 全量列表（#104）
  4. pre_tool hook 闸门（默认关闭，exit 2 = Block）
  5. TOOL_LIFECYCLE start 日志
  6. tool.execute(input, ctx)
  7. telemetry::record_tool_execution + post_tool hook
  8. guard_context_overflow → 溢出默认拒绝而非截断
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `execute()` in `tool/mod.rs:766` | 执行管线入口 | inflight 防误补重复 tool_result |
| `base_tools()` in `tool/mod.rs:312` | 无状态工具注册 | OnceLock + `insert_tool_timed` 计时 |
| `destructive_command_refusal()` in `bash_destructive_gate.rs` | 两阶段门控入口 | Catastrophic 目标任何 justification 都解不开 |
| `assess()` in `jcode-command-risk` | Stage 1 blast-radius | 分类按破坏半径而非命令名 |
| `gate()` in `jcode-command-risk/src/gate.rs` | Stage 2 反思门 | 刻意不用第二个模型 |
| `normalize_batch_input()` in `batch.rs:132` | 修 LLM 错误格式 | name→tool、arguments→parameters、平铺参数收拢 |
| `call_tool()` in `mcp/manager.rs:360` | MCP 工具调用 | connect-on-first-call，30s 超时 |
| `guard_context_overflow()` in `tool/mod.rs:881` | 上下文溢出保护 | 拒绝只花几十 token，明码标价 |

</details>

---

## 核心实现

### inflight 标记：一次生产事故的防御

`inflight.rs` 头注释记录了事故 `session_clover_1785560899476`：106 秒的 bash 调用执行中，"missing tool output" 修复路径（agent 的 `repair_missing_tool_outputs`）误判为被中断的调用，注入了合成 tool_result；真实结果 28 秒后到达造成重复 `tool_use_id`，**Anthropic 永久拒绝后续请求**。`mark_tool_in_flight` RAII 引用计数让修复路径能区分"慢"与"断"。

### destructive gate：issue #604 的回应

`jcode-command-risk` crate 头注释直说背景：jcode 执行 `bash` 本来没有任何自有门控，唯一检查是 opt-in 且默认关闭的 `pre_tool` hook——"A model that decides to run `rm -rf ~` is obeyed immediately. That is issue #604, where a user lost their home directory."

**Stage 1**（`assess()`，确定性、零 IO）：`tokenize` 分段 → 剥 wrapper（`WRAPPER_COMMANDS` 18 个：`sudo/doas/env/nice/xargs/timeout` 等，`wrapper_flag_takes_value` 处理 `nice -n 10` 带值 flag）→ `sh -c` 内嵌脚本递归评估（`split_segments` 后对 shell 的非 flag 参数递归调 assess）→ `find -delete`/`git clean`/`chmod -R` 条件性破坏看 flag → 输出重定向按写目标处理 → 管道喂入的删除（`find ~ | xargs rm`，`receives_pipe`）升 Confirm——无法枚举受影响文件。四档 `RiskLevel`：Safe / Low（工作目录内或 /tmp，可恢复）**直接放行**（`runs_immediately()` 只对这两档为 true）/ Confirm（进入 Stage 2）/ Catastrophic（`gate()` 直接 Deny，任何 justification 都解不开）。**Catastrophic targets**（`paths.rs::is_catastrophic_target`，L135）：系统根精确匹配（`/`、`/usr`...——但 `/home`、`/Users` **刻意不在递归保护列表**：用户自己的项目在其下，home 目录本身由单独的精确匹配保护）、`$HOME` 本身、凭证目录递归保护（`PROTECTED_CREDENTIAL_SUBPATHS = [.ssh/.gnupg/.aws/.kube/.docker]`——单个私钥等于整个目录）、配置/文档根**精确**匹配（`.config`/`.jcode`/`.claude`/`Documents`——单文件可正常编辑）、设备节点、`~/*` 裸 glob。`normalize()` 词法压掉 `..`（`rm -rf ~/../..` 无法穿保护），不做 I/O（防慢速/不存在路径攻击）。设计原则："**误报只花一轮反思，漏报花掉一个 home 目录**"——解析歧义时升级而非放行。

**Stage 2**（`gate()`，反思门，`gate.rs`）：**刻意不用第二个模型**（文档明说理由：贵、加延迟、会被产生该命令的同一套推理说动、多一个要对齐的东西），而是把 structured refusal 交回**生成模型本身**。`GateOutcome` 三态：Allow / Reflect{prompt} / Deny{reason}——`Confirm` + 实质 justification → **Allow**；`Confirm` + 无/敷衍 justification → Reflect，reflection prompt 强制对照"用户实际请求的哪一件事需要删这个？用户点名了这个路径还是你推断的？"；`Catastrophic` → **Deny**（理由文本明说"如果用户真想要，请自己在 agent 外执行"）。`Justification::is_substantive()`（`MIN_JUSTIFICATION_LEN = 25`）：≥25 字符且不在 `EMPTY_AFFIRMATIONS` 空肯定列表（yes/ok/okay/sure/confirmed/proceed/do it/continue/y/approved/go ahead）——**盲重试同一调用会再次失败**，这是核心属性。

### 上下文溢出保护：拒绝而非截断

`guard_context_overflow`（`tool/mod.rs:881`）：`CONTEXT_GUARD_THRESHOLD = 0.90`、`SINGLE_OUTPUT_MAX_FRACTION = 0.30`、`SINGLE_OUTPUT_MAX_TOKENS = 50_000`（注释：1M 窗口的 30% 是 30 万 token，某次全库 grep 曾一次烧掉 233k token）。超限默认**拒绝**——拒绝只花几十 token、明码标价、给出收窄建议；模型可用 `"accept_large_output": true` 明确付费重试（只认真布尔或字符串 "true"——意外花光剩余上下文必须是无歧义的 yes）。上下文已 ≥90% 时连 opt-in 也无效，直接建议 /compact。

### intent schema：为什么中央强制注入

`ensure_intent_in_schema`（`jcode-tool-core/src/lib.rs:48`）在 `Tool::to_definition()` 中央统一注入 required 的 `intent` 字段（"why this call is being made"）。三个理由：**MCP 代理工具不可能自己声明**——schema 来自远端 `tools/list`，只有中央注入才能让每个工具（含 MCP）都向模型索要 intent；避免几十个 schema 手工各写一遍必然漏掉；`accept_large_output` 逃生口同时注入但不进 required（否则每次调用都要模型回答 token 预算问题）。description 刻意极简（"each word is paid forever"），完整解释留在只在相关时显示的 refusal 消息里。

### resolve_tool_name：三层动因的别名机制

`jcode-tool-types/src/lib.rs:71` 把传输层名字映射回规范名：`shell_exec`→`bash`、`file_grep`→`agentgrep`、`communicate`→`swarm`、`task`→`subagent`、`Bash`/`Read`/`Write`/`Edit`/`Grep`/`Agent`/`ScheduleWakeup`→ 规范名（Anthropic OAuth PascalCase 的 batch 子调用盲区，issue #486——OAuth 面对顶层调用做 provider 端反向映射，但 batch 子调用名绕过了那条映射）、`grep`→`agentgrep`（native grep 已删但模型仍高频调用——agentgrep 的 grep 模式把 `pattern` 作为 `query` 别名所以直接能工作）、`todoread`/`todowrite`→`todo`、`discover_tools`→`integration_tools`（改名后旧词表模型仍输出）。只剥离 `functions.` 前缀（API 命名空间），其他前缀原样保留。放 tool-types 而非 Registry 是为了让 config 等低层 crate 规范化工具名而不依赖整个工具子系统。

### batch 工具：并行子调用

`batch.rs`：`MAX_PARALLEL = 10`，子调用里再嵌 `batch` 直接报错。`normalize_batch_input()`（L132）修三类 LLM 常见错误：`name`→`tool` 键名、`arguments`/`args`/`input`→`parameters`、参数平铺在 `tool` 旁边而非嵌套；顶层 `intent` 和 `accept_large_output` 下传进 parameters（否则 context guard 按子调用跑会再次扣住结果）。每个子调用经 `Registry::execute` 走完整管线（policy/hook/guard 全生效），`FuturesUnordered` 并行，`BusEvent::BatchProgress` 发进度，结果按原 index 重排；每子工具输出预算 `50_000 / num_tools` 字符。agent 侧的 **batch nudge**（`turn_loops.rs:30`，`SEQUENTIAL_TOOL_ROUNDS_BEFORE_BATCH_NUDGE = 3`）在连续 3 轮单工具调用后注入提醒。

### MCP 共享池：N×M → M 进程

`SharedMcpPool`（`jcode-base/src/mcp/pool.rs`）：`shared: true`（默认）的 server 由 pool 持有子进程，session 拿轻量 `McpHandle` clone（引用计数）；`shared: false`（如 Playwright 的浏览器状态）由 `McpManager` 的 `owned_clients` 每 session 独立 spawn。pool 的 `connect_all()` 跳过两类 server：`shared: false` 的（issue #557——绝不能在 daemon 全局池里启动）和 `is_enabled()` 为 false 的 disabled server（issue #436——仍可按名按需连接）。并发连接去重用 Leader/Wait 模式（`begin_connect` 返回 `ConnectAttempt::Connected/Leader/Wait`，Waiter 持有与 Leader 相同的 `Arc<Notify>` 在 `notified()` 上等待）；失败后 `FAILED_CONNECT_RETRY_COOLDOWN = 30s` 冷却防死进程反复重启；reload 时用构造时固定的 config_dir 重新解析配置（不跟随 daemon 当前 cwd）。

**request/response ID 关联**（`client.rs`）：每个 `McpClient`/`McpHandle` 持 `request_id: Arc<AtomicU64>` + `pending: Arc<Mutex<HashMap<u64, oneshot::Sender>>>`——多 session 并发请求同一进程互不干扰，这是共享池能工作的前提。

**暴露策略**（`mcp_tools_mode`）：`Auto`（默认）用 `aggregate_prompt_token_estimate` 估算 `mcp__*` 定义 token，超 `mcp_tools_token_threshold`（默认 8000）转 deferred；`Deferred` 只暴露固定的 `mcp_search` + `mcp_call` 搜索/执行面。**advertise-early**（`mod.rs:1125`，#206 Phase 2）：spawn 时先从磁盘 schema cache 注册代理工具（connect-on-first-call），首个 tool 快照就含 MCP 工具**零 prompt-cache miss**；后台连接完成后幂等重注册刷新 live schema 并回写 cache。

---

## 模块间交互

向上被 agent 循环的 `registry.execute` 调用（mpsc 版经 `tokio::spawn` 可后台化）；`BusEvent::FileTouch` 由 read/edit/write/apply_patch 发布（swarm 冲突检测的入口）；`communicate.rs` 的 swarm 工具经 `transport::send_request` 向 server 发 `Request::Comm*` JSON 请求，内部还维护一层动作别名（`inbox`→`read`、`kill`→`stop`）——工具内部再挡一层模型词汇漂移。MCP 工具（`mcp__server__tool` 代理）与固定面（`mcp`/`mcp_search`/`mcp_call`）由 `register_mcp_tools_for_dir` 动态注册。

---

## 扩展方式

**新增工具**（4 步）：`tool/` 下新建 `xxx.rs` 实现 `Tool` trait 四要素（`to_definition()` 默认即获 intent 注入）→ `mod.rs` 顶部 `mod xxx;` → 无状态进 `base_tools()` / 需 session 依赖进 `Registry::new()` → 模型可能用旧名则加 `resolve_tool_name` 映射。**工具定义排序**：`definitions()` 按名排序输出——确定性排序是 prompt cache 命中的关键。对应测试：`tool/*_tests.rs`、`escape_hatch_tests`。
