---
source:
  type: "源码解读"
  project: "multica"
  url: "https://github.com/multica-ai/multica"
title: "Agent Runtime"
date: "2026-08-11T20:31:27+08:00"
category: [AI, Agent, Team, Multica, CodeWiki, "0.3.28"]
tags: ["multica", "Go", "Agent Runtime", "CLI", "Strategy Pattern"]
description: "pkg/agent 模块用 Backend 接口统一 14 种编码 CLI（Claude Code、Codex、Copilot 等），把私有协议翻译为统一 Message/Result 事件流。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Multica/CodeWiki/0.3.28/00-overview)

---

## 模块定位

`server/pkg/agent/` 是 Multica 的多 CLI 编码代理抽象层。Multica 支持 14 种编码 CLI（Claude Code、Codex、GitHub Copilot CLI、Cursor Agent、Gemini、Hermes、Kimi、Kiro CLI、Antigravity、Qoder、OpenCode、OpenClaw、Pi、CodeBuddy），每种 CLI 的通信协议、参数格式、输出流都不同。本模块用统一的 `Backend` 接口把它们收敛为一套契约，让上层 Daemon 用同一套代码调度任意 provider，不感知具体 CLI 差异。

这是一个自包含的叶子模块——纯 Go 标准库（`os/exec`、`bufio`、`encoding/json`），不依赖 multica 任何其他内部包。唯一调用方是 `internal/daemon`。

## 模块架构

模块内部以 `Backend` interface 为核心，每个 provider 是一个适配器实现，共享一组横切工具：

- **`Backend` interface**（`agent.go:16`）——唯一契约，`Execute(ctx, prompt, opts) → *Session`
- **`Session`**（`agent.go:76`）——双 channel 流式结果容器（`Messages` + `Result`）
- **`New()` 工厂**（`agent.go:172`）——switch 14 种 provider 到对应 backend struct
- **共享工具**——`filterCustomArgs`、`buildEnv`、`stderrTail`、`runContext` 被 all provider 复用
- **辅助子系统**——`models.go`（模型发现）、`thinking.go`（推理级别发现）、`version.go`（版本门禁）

每个 provider 文件（如 `claude.go`）定义 `xxxBackend struct{ cfg Config }`，实现 `Execute` 方法，把 CLI 的私有协议（stream-json / JSON-RPC / JSONL / ACP）翻译为通用 `Message`/`Result` 事件发到 channel。

## 调用链路

从 Daemon 调用 `Execute` 到流式 drain 的主路径：

```
Daemon.executeAndDrain (internal/daemon/daemon.go:3919)
  ├─ agent.New(provider, Config{ExecutablePath, Env})     # agent.go:172 工厂
  │    └─ return &claudeBackend{cfg} / &cursorBackend{cfg} / ...
  ├─ backend.Execute(ctx, prompt, ExecOptions{Cwd, Model, Timeout, ...})
  │    ├─ buildXxxArgs(opts)          # 组装 CLI argv（如 claude.go:562 buildClaudeArgs）
  │    │    └─ filterCustomArgs(CustomArgs, xxxBlockedArgs)  # 过滤黑名单参数
  │    ├─ exec.CommandContext(runCtx, execPath, args...)
  │    ├─ go writeClaudeInput(stdin, prompt)   # 独立 goroutine 写 stdin（防死锁）
  │    └─ go scanner.Scan() loop               # 读 stdout
  │         ├─ handleAssistant    # 解析 text/thinking/tool_use 事件
  │         ├─ handleUser         # 解析 tool_result
  │         └─ handleControlRequest  # 自动批准工具调用
  │              └─ session.Messages <- msg   # 流式发送
  └─ drain loop: for msg := range session.Messages { ReportProgress(...) }
       └─ session.Result 收到最终结果
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计 |
|------|------|----------|----------|
| `New(type, cfg)` | `agent.go:172` | 工厂创建 Backend | switch 14 provider |
| `Backend.Execute` | `agent.go:16` | 启动 CLI 子进程返回 Session | 双 channel 流式 |
| `buildClaudeArgs` | `claude.go:562` | 组装 claude CLI argv | 黑名单过滤 |
| `filterCustomArgs` | `claude.go:718` | 过滤破坏协议的参数 | 最小化黑名单 |
| `handleControlRequest` | `claude.go:333` | 自动批准工具调用 | 无头模式自主 |
| `ListModels` | `models.go:94` | 发现可用模型 | 静态 catalog + 动态 discovery + 缓存 |
| `DetectVersion` | version 检测 | `cli --version` 解析 | 注册时调用 |
| `CheckMinVersion` | `version.go` | 最低版本门禁 | dev-build 自动通过 |

</details>

## 核心实现

### Backend 接口与双 channel 流式设计

整个模块只有一个核心接口：

```go title="server/pkg/agent/agent.go"
type Backend interface {
    Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error)
}

type Session struct {
    Messages <-chan Message  // 事件流，agent 完成后关闭
    Result   <-chan Result   // 恰好一个值，最终结果
}
```

`Session` 用双 channel 而非 callback 或 iterator。**为什么**：channel 天然支持 `select` + `context.Cancel`，让 Daemon 的 drain loop 可以同时监听 agent 事件和超时/取消信号。`Result` 独立于 `Messages` 关闭，保证即使 agent 崩溃没发任何 Message，最终 Result 也能到达调用方。`trySend`（`claude.go:535`）用非阻塞发送防止 channel 满时阻塞 CLI 进程的 stdout reader。

`Message` 的 `Type` 区分 `text`/`thinking`/`tool-use`/`tool-result`/`status`/`error`/`log`，统一了不同 CLI 的事件模型。`Result.Usage` 按 model 名分组记录 token 用量。

### 协议适配器——每个 provider 翻译私有协议

每个 provider 是一个适配器，把 CLI 私有协议翻译为通用 `Message`/`Result`：

| Provider | 文件 | CLI 协议 | 适配方式 |
|----------|------|----------|----------|
| Claude Code | `claude.go` | stream-json（NDJSON） | `handleAssistant`/`handleUser`/`handleControlRequest` 解析事件 |
| Codex | `codex.go` | JSON-RPC 2.0 over stdio | `codex app-server --listen stdio://` |
| Copilot CLI | `copilot.go` | JSONL 事件流 | `handleCopilotEvent` 统一事件处理 |
| Cursor Agent | `cursor.go` | stream-json | `handleCursorAssistant` |
| Hermes | `hermes.go` | ACP 协议 | ACP session 管理 |

例如 `handleAssistant`（`claude.go:265`）把 Claude 的 `claudeSDKMessage` 转换为通用 `Message{Type: MessageText, ...}`；`handleCopilotEvent`（`copilot.go:48`）把 Copilot 的 dotted event name 转换为通用 `Message`。

### 黑名单参数过滤——保护通信协议

用户可通过 `agent.CustomArgs` 传任意 CLI 参数，但每个 provider 维护一个黑名单 map，过滤掉会破坏 daemon↔agent 通信协议的参数：

```go title="server/pkg/agent/claude.go"
var claudeBlockedArgs = map[string]bool{
    "--output-format": true,   // daemon 需完全控制 stream-json 格式
    "--permission-mode": true, // 自动批准模式由 daemon 管理
    "-p": true,                // prompt 由 stdin 传入
    "--effort": true,          // 由 ThinkingLevel picker 独占管理
    // ...
}
```

**为什么用最小化黑名单而非全量白名单**：用户需要传 `--deny-tool` 等合理参数，全量白名单会过度限制。黑名单只挡破坏协议的参数。`filterCustomArgs`（`claude.go:718`）被 claude/cursor/copilot/codex 共用，每个 provider 只定义自己的 `xxxBlockedArgs` map。

### stdin/stdout 死锁防护

Claude Code 的 stream-json 模式在发出 startup banner 后才读取 stdin。如果同一个 goroutine 先写 stdin 再读 stdout，而 claude 正阻塞写 stdout（等对方读取），就形成死锁。

**解决方案**（`claude.go:102-123`）：将 prompt 写入 stdin 的操作放在独立 goroutine `writeClaudeInput` 中，与 stdout reader 并行。用 buffered channel `writeDone chan error, 1` 同步。注释明确记录了 bug 症状：`"write |1: The pipe has been been ended."` 恰好在超时时浮现。

### control_request 自动批准——无头自主模式

Claude Code 运行中通过 stdin 发送 `control_request` 请求工具使用许可。`handleControlRequest`（`claude.go:333`）自动回复 `behavior: "allow"` 批准所有工具调用，并强制把 `run_in_background: true` 改为 `false`。

**为什么**：daemon 运行在无头模式（non-interactive stream-json），没有 UI 渲染交互式问题。自动批准保证 agent 持续执行。强制前台执行是因为 Multica 管理的 run 要求前台——如果 claude 启动了后台任务（`async_launched`），daemon 标记为失败（`claude.go:228`），因为后台任务脱离了 daemon 生命周期管理。

### 模型发现双轨制

`ListModels`（`models.go:94`）为每个 provider 发现可用模型，采用静态 catalog + 动态 discovery + 缓存三轨：

- **静态 catalog**：Claude/Codex/Gemini（CLI 没有可靠的 `models list` 子命令）
- **动态 discovery**：Cursor/Copilot/Hermes/Kimi 等（shell out 到 CLI），部分有静态 fallback
- **缓存**：动态结果缓存 60 秒（`modelCacheTTL`），但**空结果不缓存**（`models.go:263`）——零模型几乎总是临时故障，缓存空值会让 picker 在整个 TTL 内空白

### stderr 尾部捕获——崩溃根因可追溯

所有 provider 的 `cmd.Stderr` 接入 `stderrTail`（`stderr_tail.go:26`），同时转发到 daemon 日志和保留最后 2KB 尾部。失败时 `withAgentStderr` 把尾部追加到 `Result.Error`。**为什么**：没有 stderr tail 时，CLI 崩溃（V8 abort、OOM）只有 `"exit status N"`，根因卡在日志文件里。2KB 足够包含典型错误行又不膨胀 `Result.Error`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 策略 | `Backend` interface + `New()` 工厂 | 14 种 CLI 统一调度，运行时选策略 |
| 工厂 | `New(agentType, cfg)` in `agent.go:172` | switch 映射 type→backend，`SupportedTypes` 白名单同步校验 |
| 适配器 | 每个 provider 文件 | 翻译私有协议为统一 Message/Result |
| 模板方法/共享工具 | `filterCustomArgs`/`buildEnv`/`stderrTail` | 横切逻辑复用，各 provider 只定义差异部分 |

## 模块间交互

该模块是叶子模块，无内部依赖。被 `internal/daemon` 调用：

| 调用点 | 位置 | 用途 |
|--------|------|------|
| `agent.New(provider, cfg)` | `daemon.go:3585` | 工厂创建 Backend |
| `backend.Execute` | `daemon.go:3928` | 启动 CLI 子进程 |
| `agent.DetectVersion`/`CheckMinVersion` | `daemon.go:91-92` | 注册时版本检测 |
| `agent.ListModels` | `daemon.go:1967` | heartbeat 模型发现 |
| `agent.ValidateThinkingLevel` | `daemon.go:3647` | 推理级别校验 |

## 扩展方式

新增一种编码代理 CLI（如 Windsurf）：

1. 新建 `server/pkg/agent/windsurf.go`——定义 `windsurfBackend struct{ cfg Config }`，实现 `Execute` 返回 `*Session`；定义 `windsurfBlockedArgs` + `buildWindsurfArgs` + `discoverWindsurfModels`
2. `agent.go` `New()` switch（`:177`）加 `case "windsurf"`；`SupportedTypes`（`:144`）加 `"windsurf"`——须与 DB `runtime_profile.protocol_family` CHECK constraint（migration 121）同步
3. `models.go` `ListModels` switch（`:95`）加分支
4. `version.go` `MinVersions`（`:13`）可选加最低版本
5. Windows 特殊调用：新建 `windsurf_invocation*.go`（build tags 分离），参考 `cursor_invocation.go`
