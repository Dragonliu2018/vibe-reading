---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "CLI"
date: "2026-09-17T23:58:55+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "Commander", "CLI", "SSH"]
description: "paseo CLI——Docker 风格命令面（run/ls/attach/send/wait）、classifyInvocation 路径探测双形态、withOutput 命令/呈现解耦、SSH 隧道远程 daemon、daemon 发现四源探测。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/cli/src/`（~29,800 行）是 `@getpaseo/cli`——"Everything you can do in the app, you can do from the terminal"。它是 Docker 风格的命令面（`paseo run/ls/logs/wait`），也是桌面端 launcher（`paseo ~/proj` 直接开桌面 app），还是脚本化编排的入口（`--output-schema` 结构化输出）。与 App 走**同一 WebSocket 协议**（直接用 `@getpaseo/client/internal/daemon-client`），不做任何旁路。

## 模块架构

```
index.ts（bin）→ run.ts: runCli() → classify.ts: classifyInvocation()
├── cli.ts: createCli()                 # commander 注册全部命令
├── commands/
│   ├── agent/      run/ls/import/clone/attach/logs/stop/delete/send/inspect/wait/archive
│   ├── daemon/     start/stop/status/restart/reload/set-password/pair
│   ├── hub/        login/logout/deploy/connect/projects/export/init/permissions
│   ├── terminal/   ls/create/kill/capture/send-keys
│   ├── script/ schedule/ heartbeat/ permit/ provider/ plugin/ speech/
│   ├── project/ workspace/（setup/create/ls/rename/archive）
│   └── open.ts     openDesktopWithProject()（classify 转入）
├── output/ with-output.ts + render.ts  # CommandResult + OutputSchema → table/json/yaml/quiet
├── ssh/ ssh-tunnel.ts                  # 本地随机端口 + ssh 子进程对接
└── utils/  client.ts / provider-model.ts / local-daemon.ts / client-id.ts
```

## 调用链路

**`paseo run --provider codex/gpt-5.5 --worktree feature-x "..."` 的链**：

```
runCli() in run.ts
└── classifyInvocation() in classify.ts
    └──（非命令且是已存在目录 → open-project 转桌面端；空 argv → onboard）
└── runRunCommand() in commands/agent/run.ts
    ├── resolveProviderAndModel()（utils/provider-model.ts）   # 拆 provider/model
    ├── connectToDaemonOrThrow()（utils/client.ts）            # 连 daemon
    ├── resolveRunWorkspace()
    │     # 优先级：--workspace > $PASEO_AGENT_ID（agent 自调用）
    │     #        > $PASEO_WORKSPACE_ID（终端导出）> --new-workspace local|worktree > 裸 run 新建
    ├── client.createAgent()
    └── 默认前台：client.waitForFinish()                       # --background/-d 才退出
```

值得注意：**run 本身不流式打印输出**——流式属于 `attach`（`commands/agent/attach.ts`）：先 `fetchProjectedTimelineItems()` 补历史，再 `client.subscribeAgentTimeline()` 订阅增量，`printTimelineItem()`/`printStreamEvent()` 把 assistant_message/reasoning/tool_call/todo/permission 事件渲染到终端。`logs` 则用 `formatAgentActivityTranscript()` 输出活动纪要。三个命令三种读取姿态（等待/跟随/纪要），对应三种使用场景。

`--output-schema`：借 `@getpaseo/server` 的 `getStructuredAgentResponse()`（02 篇）做 schema 约束的结构化输出，失败可 `sendMessage` 重试（maxRetries=2），最终文本经 `resolveStructuredResponseMessage()` 回退到 `fetchAgentTimeline` tail 200 条取 assistant_message。

<details>
<summary>命令速查表</summary>

| 命令组 | 代表命令 | 职责 |
| --- | --- | --- |
| agent（顶层直出） | `run/ls/attach/send/wait/archive` | agent 工作流主面 |
| 本地快捷 | `status/reload/restart` | daemon 快捷别名 |
| daemon | `start/stop/pair/set-password` | daemon 生命周期与配对 |
| hub | `login/deploy/connect` | 云 Hub 接入 |
| terminal | `create/kill/capture/send-keys` | workspace 终端 |
| workspace | `setup/create/ls/archive` | workspace 管理（worktree 是隐藏 legacy 别名） |
| schedule/heartbeat | `create/ls/run-once/...` | 定时任务 |
| permit / provider / plugin / speech | — | 权限/模型目录/插件/语音 |

</details>

## 核心实现

### classifyInvocation：单二进制双形态

`classify.ts` 的路径探测让 `paseo ~/proj` 不报错而是调 `commands/open.ts` 的 `openDesktopWithProject()`——CLI 同时是桌面端 launcher。空 argv 默认走 `onboard`。命令解析在 commander 之前完成，形态分流对 commander 透明。

### withOutput：命令与呈现解耦

`output/with-output.ts` 的 `withOutput()` 统一包裹 action：命令只返回 `CommandResult + OutputSchema`（列定义），由 `render.ts` 的 `render()` 分派 table/json/yaml/quiet 渲染；错误统一为 `{code, message, details}` 的 CommandError 契约。`--output-schema` 自动强制 JSON（`extractOutputOptions`）。命令逻辑零呈现代码——这是 CLI 可脚本化的根基。

### daemon 管理：不自动拉起

CLI **不自动拉起 daemon**：连不上直接抛 `DAEMON_NOT_RUNNING`，提示 "Start the daemon with: paseo daemon start"（`utils/client.ts` 的 `buildDaemonConnectionCommandError()`）。显式启动走 `commands/daemon/start.ts` → `local-daemon.ts` 的 `startLocalDaemonDetached()`：detached + unref 启动 node runner（`resolveDaemonRunnerEntry()` 经 `require.resolve("@getpaseo/server")` 向上找）、`~/.paseo/daemon.log` 收日志、`paseo.pid` 记 PID、1200ms 宽限期探测早退（失败时 tail 日志）。

**连接发现四源**（`resolveDefaultDaemonHosts()`）：`$PASEO_LISTEN`（IPC）> pid 文件里的 listen/sockPath > config.json > 默认 `localhost:6767`。支持 tcp://、unix socket（`ws+unix://` + ws `socketPath`）、pairing offer URL（relay + E2EE）。

### SSH 隧道

`ssh/ssh-tunnel.ts` 的 `createSshTunnel()`：本地起 127.0.0.1 随机端口 TCP listener，首个连接进来时 spawn `ssh` 子进程，把 socket 与 ssh 的 stdin/stdout 对接；隧道参数来自 `@getpaseo/protocol/ssh-transport` 的 `buildSshTunnelArgs()`。`--host ssh://...` 时 `client.ts` 的 `connectToDaemon()` 先建隧道再对 `127.0.0.1:port` 走普通 WS。设计上刻意不做远程安装——错误文案写明 "SSH transport does not install or start it"。

### 与 client SDK 的关系

CLI 直接用 `@getpaseo/client/internal/daemon-client` 的 `DaemonClient`，注入 Node 侧 ws 工厂 `createNodeWebSocketFactory()`（处理 headers/unix socketPath），`clientType: "cli"`、稳定 `clientId`（`utils/client-id.ts` 的 `getOrCreateCliClientId()`）、**`reconnect: {enabled: false}`**——一次性命令不需要重连（App 才需要）。同一协议客户端，两种连接姿态。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 命令/呈现分离 | `withOutput()` in `output/with-output.ts` | 命令可脚本化（--output json） |
| 形态分流 | `classifyInvocation()` in `classify.ts` | 单二进制兼做桌面 launcher |
| COMPAT 别名治理 | `cli.ts:206`（worktree 命令组） | legacy 别名 + hideHelp + 明确移除日期（remove after 2027-01-17） |
| detached 守护进程 | `startLocalDaemonDetached()` in `utils/local-daemon.ts` | daemon 独立于 CLI 调用者生命周期 |

## 模块间交互

- 下游：`@getpaseo/client/internal/daemon-client`（06 篇）+ `@getpaseo/protocol`；
- 横向：`--output-schema` 直接借 `@getpaseo/server` 的 `getStructuredAgentResponse()`（罕见的 cli→server 直接依赖，为结构化输出复用）；
- Desktop 捆绑 CLI 为 `bin/paseo`（12 篇），daemon 探测也复用 `daemon status --json`。

## 扩展方式

新增一个子命令：

1. `commands/<组>/` 新建 `foo.ts`：导出 `addFooOptions(cmd)`（commander 选项）+ `runFooCommand()` 返回 `SingleResult/ListResult + OutputSchema`（columns 定义表头）；
2. `cli.ts` 的 `createCli()`（顶层）或 `commands/<组>/index.ts` 注册：`addJsonAndDaemonHostOptions(addFooOptions(program.command("foo"))).action(withOutput(runFooCommand))`；流式命令（如 attach）用 `withGlobalOptions` 不套 withOutput；
3. 校验失败抛 `{code, message, details} satisfies CommandError`；
4. `cli-surface.test.ts` 需同步命令面快照测试。
