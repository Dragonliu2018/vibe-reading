---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Tool 工具系统"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Tool", "Registry", "MCP", "Destructive Gate"]
description: "jcode Tool 工具系统——30+ 工具、Registry 注册表、destructive gate 两阶段门控、refuse-over-truncate、MCP 适配器、communicate swarm 枢纽"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

Tool 模块是 agent 操作外部世界的执行层——30+ 工具（bash/edit/read/write/webfetch/communicate/...）、工具注册表、安全门控、MCP 适配。模块位于 `crates/jcode-app-core/src/tool/`（入口 `mod.rs`）+ `jcode-tool-core`（`Tool` trait）+ `jcode-tool-types`（`ToolOutput`）+ `jcode-base/src/mcp/`（MCP 协议）+ `jcode-command-risk`（破坏性命令评估）。

---

## 模块架构

- **jcode-tool-core** — `Tool` trait + `ToolContext` + `ensure_intent_in_schema`
- **jcode-tool-types** — `ToolOutput`/`ToolImage` + `resolve_tool_name` 别名归一化
- **app-core/src/tool/mod.rs** — `Registry` 注册表 + `execute()` + `SessionToolPolicy`
- **tool/bash.rs / edit.rs / read.rs / write.rs / ...** — 各 native 工具实现
- **tool/bash_destructive_gate.rs** — 两阶段破坏性命令门控
- **tool/communicate.rs** — swarm 通信枢纽（20+ action）
- **tool/ambient.rs** — ambient 专用工具
- **base/src/mcp/** — MCP client/manager/pool/protocol/schema_cache

`Registry`（`mod.rs:136`）持有 `tools: Arc<RwLock<HashMap<String, Arc<dyn Tool>>>>`、`skills`、`compaction`。Clone 时 tools 和 skills 共享 Arc，但 compaction 新建——防止并行 subagent 互相篡改消息历史。

---

## 调用链路

```
Agent 产出 tool_call (name, input)
  └─ Registry::execute()                       mod.rs:645
       ├─ inflight::mark_tool_in_flight()       防重复注入 synthetic result
       ├─ resolve_tool_name()                   别名归一化 (functions.bash→bash, communicate→swarm)
       ├─ session_tool_policy 检查              allowed/disabled 白名单
       ├─ tools.get(resolved_name)
       │    └─ 未找到 → closest_tool_names() Levenshtein 建议
       ├─ pre_tool hook (可选)                  外部策略门控, exit 2 = Block
       ├─ tool.execute(input, ctx).await
       │    ├─ [bash] destructive_command_refusal()
       │    └─ [MCP]  McpProxy → McpManager → McpClient.call_tool()
       ├─ fire_post_tool_hook()
       └─ guard_context_overflow()              输出裁剪/拒绝
            ├─ >90% budget 或 >50k tokens → 拒绝(返回 refusal)
            ├─ accept_large_output=true → 截断返回
            └─ 正常 → 原样返回
```

**Bash destructive gate**（`bash_destructive_gate.rs:738`）：

```
BashTool::execute()
  → destructive_command_refusal(command, justification, working_dir)
      → jcode_command_risk::assess()     Stage 1: blast-radius 评估
      → jcode_command_risk::gate()       Stage 2: justification 验证
          ├─ Allow  → None (继续执行)
          ├─ Deny   → Some(reason) (直接拒绝, 如 rm -rf /)
          └─ Reflect→ Some(prompt) (要求模型给出 justification 重试)
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `Registry::execute()` | 工具执行主入口 | inflight 防重复 + policy + hook + guard |
| `base_tools()` | 无状态工具 OnceLock 缓存 | 进程级共享，减少启动延迟 |
| `destructive_command_refusal()` | bash 破坏性门控 | 两阶段：blast-radius + justification |
| `guard_context_overflow()` | 输出裁剪 | refuse-over-truncate |
| `resolve_tool_name()` | 别名归一化 | 兼容不同 provider 工具名 |
| `create_mcp_tools()` | MCP 适配器 | connect-on-first-call |

---

## 核心实现

### Tool Trait 与 Schema 注入

```rust title="crates/jcode-tool-core/src/lib.rs:144"
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput>;
    fn to_definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: self.description().to_string(),
            input_schema: ensure_intent_in_schema(self.parameters_schema()),
        }
    }
}
```

`to_definition` 默认调用 `ensure_intent_in_schema`（`lib.rs:48`），集中注入 `intent`（required）和 `accept_large_output`（optional）两个 schema 属性，避免每个工具手动声明。MCP proxy 也覆盖——无需逐工具编辑。

### Refuse-over-Truncate

`guard_context_overflow`（`mod.rs:754`）默认**拒绝**超大输出，返回 token cost 和缩小建议；只有 `accept_large_output: true` 才截断返回。Why：截断默认是更坏的失败——caller 付出全部 context 却只得到不含答案的前缀。`CONTEXT_GUARD_THRESHOLD = 0.90`，`SINGLE_OUTPUT_MAX_TOKENS = 50_000`（防止 1M window 下 30% 仍允许 300k token 的单个结果）。

### Destructive Gate 两阶段

`bash_destructive_gate.rs` 独立文件，注释："the only thing standing between a model's rm -rf and the user's data"。Stage 1 纯 blast-radius 评估（`/`、`$HOME`、credential stores 等灾难性目标直接 Deny）；Stage 2 将 `Confirm` 转为反思 prompt——blind retry 无法满足，模型必须解释为什么该命令服务于用户请求。`justification` 字段仅在被拒绝后重试时使用。

### Communicate 工具 = Swarm 通信枢纽

`CommunicateTool`（`communicate.rs`）实现 swarm 全生命周期——20+ action：`spawn`/`stop`（worker 管理）、`message`/`broadcast`/`dm`（消息传递）、`propose_plan`/`run_plan`/`plan_status`（DAG 任务图）、`assign_role`/`assign_task`（角色分配）、`read_context`/`summary`（上下文共享）。通过 `transport::send_request` 向 server 发 `Request` 枚举。`run_plan` 有 driver claim 机制（`communicate.rs:794`）防止同 session 并发驱动。

### MCP 适配器与 Advertise-Early

`create_mcp_tools()`（`mod.rs`）将远端 MCP tool schema 包装为 `Arc<dyn Tool>` proxy，注册名格式 `mcp__server__tool`。Proxy connect-on-first-call，避免阻塞启动。

**Advertise-early**（`mod.rs:988`）：从 `McpSchemaCache` 磁盘缓存预注册 proxy 工具，connection 在后台异步进行。Why：避免首次 tool snapshot 缺少 MCP 工具导致的 prompt-cache miss（issue #206 Phase 2）。

`McpManager`（`manager.rs:48`）支持 shared pool（daemon 模式跨 session 复用）和 owned（per-session 有状态 server 如 Playwright）两种模式。

### Base Tools OnceLock 缓存

`Registry::base_tools()`（`mod.rs:191`）用 `OnceLock` 缓存无状态工具，per-session 只做 Arc clone（cheap refcount bump）；`SkillTool` 和 `CommunicateTool` 每次 clone 新建（因含 session 级状态）。`insert_tool_timed` 包装初始化计时用于 profiling。

### 工具名别名归一化

`resolve_tool_name`（`jcode_tool_types`）：`functions.bash`→`bash`、`communicate`→`swarm`、`task`→`subagent`。不同 provider/API 用不同工具名暴露给模型，模型在 batch 子调用中可能用任一形式。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 注册表 | `Registry` OnceLock | 无状态工具进程级共享 |
| 命令模式 | `Tool` trait execute(input, ctx) | input 为 Value，工具内 Deserialize |
| 安全门控 | `bash_destructive_gate.rs` 两阶段 | blast-radius + justification 反思 |
| MCP 适配器 | `McpProxy` + `McpManager` | 远端 tool 统一为 Tool trait |
| Schema 注入 | `ensure_intent_in_schema` | 集中装饰，无需逐工具编辑 |
| Advertise-early | `McpSchemaCache` 预注册 | 防 prompt-cache miss |

---

## 模块间交互

- **Agent ↔ Tool**：agent 产出 `tool_call`，调 `Registry::execute()`；`ToolContext.execution_mode` 区分 `AgentTurn`（模型驱动）vs `Direct`（用户直接调用）。
- **Tool ↔ Safety**：`pre_tool`/`post_tool` hook 外部策略门控；bash 额外有内嵌 destructive gate。
- **Tool ↔ MCP**：`register_mcp_tools_for_dir()`（`mod.rs:918`）创建 `McpManager`，注册 `mcp` 管理工具 + proxy 工具。
- **Tool ↔ Swarm**：`CommunicateTool` 通过 `transport::send_request` 向 server发 `Request`，接收 `ServerEvent`。
- **Tool ↔ Compaction**：`guard_context_overflow` 依赖 `CompactionManager` 的 `token_budget()` 做输出裁剪。

---

## 扩展方式

**新增 native 工具**：(1) `tool/` 下新建 `xxx.rs` 实现 `Tool` trait；(2) `mod.rs` 顶部 `mod xxx;`；(3) `base_tools()` 加 `insert_tool_timed("xxx", xxx::XxxTool::new)`；(4) 若需 session 级依赖，在 `Registry::new()` 的 session_tools 段添加。

**新增 MCP server**：在 `.mcp.json` 或全局 config 添加 server 配置——`register_mcp_tools_for_dir()` 自动读取 → `McpManager::connect_all()` → 注册 proxy。无需改代码，支持运行时 `mcp connect` 动态添加。

**调整 destructive gate 规则**：修改 `jcode-command-risk` crate 的 `assess()` 和 `gate()`，`bash_destructive_gate.rs` 是薄包装层。
