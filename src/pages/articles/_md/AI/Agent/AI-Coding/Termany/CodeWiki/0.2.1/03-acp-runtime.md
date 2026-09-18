---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "ACP 运行时"
date: "2026-09-18T15:45:30+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "ACP", "JSON-RPC"]
description: "apps/server 的 ACP 子系统：Runtime 类管理 agent 子进程的 JSON-RPC 生命周期（prompt 流式、权限悬挂、坏 UTF-8 恢复），managed bridge 免系统 Node，nativeAcp 先 probe 再发协议，acpConfigCompatibility 归一化新旧字段，凭证边界把密钥留在 server。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

ACP（Agent Client Protocol）子系统把 11 家 coding agent 接成**同一种结构化聊天进程**：JSON-RPC 2.0 over stdio（newline-delimited JSON），Termany 经官方 `@agentclientprotocol/sdk` 消费。为什么用 ACP 而不是各家 CLI 自己的 flag/SDK？因为一套聊天 UI 需要统一的事件模型——`AcpRuntimeEvent` 的 delta/thought/tool/permission（acpRuntime.ts:34-42）让前端不为每个 agent 写解析器，权限走结构化 request/response 而非终端里的 y/n 提问。代价被集中消化在本模块：cancel 不响应的 adapter、缺终态的 tool call、坏 UTF-8、legacy 字段——全是 adapter 生态不齐的兼容层。

模块横跨 `acpRuntime.ts`（673 行核心）、`managedAcp.ts`（打包 bridge）、`nativeAcp.ts`（CLI 自带 ACP）、`fastClawRuntime.ts`（acp-http 第三形态）、`agentChat.ts`（BYOK 内置助手）、`agentConfig.ts`（注册表）、`agentDetection.ts`（探测）、`agentCredentials.ts` / `botIdentity.ts` / `agentImages.ts` / `geminiAuth.ts`（配套）。

## 模块架构

```text title="ACP 子系统内部结构"
index.ts 路由（/api/agent/acp/*）
└── promptAcpRuntime()（编排层：activity → acquire → applySavedConfig → prompt）
     └── acquire()（唯一入口：换 agent / 配置变 / 显式 cwd 变才重建）
          ├── protocol "acp"      → Runtime（stdio JSON-RPC）
          │     ├── distribution managed → managedAcp.prepareManagedAcpLaunch（打包 bridge）
          │     ├── distribution system  → nativeAcp 探测后直跑 CLI
          │     └── AcpConfigCompatibility TransformStream（归一化新旧字段）
          └── protocol "acp-http" → FastClawRuntime（HTTP + SSE，BeeAI ACP 0.2）

BYOK 旁路：/api/agent/chat → agentChat.streamAgentChat（provider 直连，非 ACP）
```

`AcpRuntimeTarget`（acpRuntime.ts:544-555）是 pane 级会话定位符 `{paneId, agentId, cwd, cwdExplicit?, config?}`——`cwdExplicit` 的语义（注释 L548-551）只有用户显式选的目录不匹配才重启会话；从终端继承的 cwd 随用户 `cd` 漂移，绝不能杀掉活跃会话。

## 调用链路

一轮 prompt 的 server 侧链路：

```text
promptAcpRuntime(target, prompt, emit, signal, …)          ← acpRuntime.ts:639
├─ emit {type:"activity", "Starting agent"}
├─ acquire(input)                                          ← :565（runtimes Map 按 paneId 复用）
│    └─ 需重建时 Runtime.create(paneId, agent, cwd)         ← :181
│         ├─ managed：prepareManagedAcpLaunch → spawn(process.execPath, [bridge.mjs])
│         ├─ system：resolveExecutable → checkNativeAcpSupport → spawn(CLI)
│         ├─ ndJsonStream(stdin/stdout) → client({name:"Termany"}).connect()
│         ├─ initialize（60s 超时）→ 能力协商（promptCapabilities.image / loadSession）
│         └─ buildSession(cwd).start() → ActiveSession
├─ emit {type:"activity", "Thinking"}
└─ runtime.prompt(prompt, emit, signal, botIdentity, images)  ← :264
     ├─ this.prompting 互斥（并发第二轮抛 "already responding"）
     ├─ abort → session/cancel → 3s 宽限（CANCEL_GRACE_MS）后整个 close
     └─ while(true) await session.nextUpdate()             ← 流式 update 分发
          ├─ agent_message_chunk / thought_chunk → emit {type:"delta"|"thought"}
          ├─ tool_call / tool_call_update → emit {type:"tool"}（formatToolInput → "$ cmd"）
          ├─ message.kind === "stop" → 补发未完结 tool 的 completed → emit {type:"done"}
          └─ 流里出现 U+FFFD → recoverFinalText()（惰性恢复，见下）
```

方法速查表：

<details>
<summary>关键函数速查</summary>

| 函数 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `acquire()` | 会话所有权唯一入口 | 聊天流与选择器菜单共用，认知不分裂 |
| `Runtime.create()` | spawn + 握手 | `detached: true` 独立进程组；stderr 尾部留 8KB 报错 |
| `Runtime.prompt()` | 一轮流式执行 | 防重入；cancel 宽限 3s 强杀（adapter 会忽略 cancel） |
| `Runtime.requestPermission()` | 权限悬挂 | requestId = randomUUID，resolve 存 pendingPermissions Map |
| `Runtime.respondPermission()` | 应答回写 | 校验 optionId，resolve JSON-RPC response 回 stdin |
| `recoverFinalText()` | 坏 UTF-8 恢复 | session/load 重放 agent 自己的 transcript 抓权威文本 |
| `setConfigOption()` | 模型选择 | legacy kind 走 `session/set_model`，新协议走 setConfigOption |
| `closeAcpRuntimes()` | 进程退出清理 | index.ts shutdown 时调用 |

</details>

## 核心实现

### Runtime：进程生命周期与流式翻译

`Runtime` 类（acpRuntime.ts:140-507）每个 pane 一个实例。spawn 用 `detached: true` 建独立进程组（配套 `agentProcess.ts` 的进程组 kill：SIGTERM → 1.5s → SIGKILL，Windows `taskkill /T /F`）。进程 exit 时 `connection.close()` + `cancelPermissions()`（统一 resolve `cancelled`）+ 从 `runtimes` Map 自摘除。

流式循环里的三个防御值得一读：

1. **cancel 宽限**（`CANCEL_GRACE_MS`，L101-103）：注释明说是 workaround——"几个 adapter 会忽略 session/cancel 导致 nextUpdate() 永久阻塞"，3 秒后整个 close。
2. **假 spinner 清理**（L350-354）：turn 结束时给未收到终态的 tool call 补发 `status:"completed"`，清掉前端永久转圈的 spinner。
3. **坏 UTF-8 惰性恢复**（`recoverFinalText`，L383-411）：流里出现 U+FFFD 说明 adapter 的 stdio 编码坏了——dispose 当前 session、`session/load` 重放 agent 自己持久化的 transcript、在 1 秒静默窗口内抓 `agent_message_chunk` 重建权威文本，再 re-attach，`emit {type:"replace"}` 让前端整体替换。**只有恢复文本的 U+FFFD 计数确实少于流式文本时才 emit replace**（否则重放没帮上忙就不动）。正常 turn 零开销。

### managed bridge：免系统 Node

`managedAcp.ts` 的 `DEFINITIONS` 只有两家：`@agentclientprotocol/claude-agent-acp` 与 `codex-acp`，被 `scripts/bundle-server.mjs` esbuild 成 `acp/*.mjs` 放进 Tauri resources。`prepareManagedAcpLaunch()`（L62-89）的关键在 env：用 **Termany 自带的 Node**（`process.execPath`）跑 bridge，并通过 `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` 把 bridge 指向用户已登录 CLI 的绝对路径——注释（L57-61）点明分工："bridge 属于 Termany，认证的 agent CLI 属于用户"。`packages/core/agentRuntime.ts` 同样写明动机：**避免要求系统 Node/npx 或下载第二份 agent 二进制**。dev 环境用 `createRequire(process.cwd())` 解析 npm 依赖。

### nativeAcp：先 probe 再发协议

`checkNativeAcpSupport()`（nativeAcp.ts:19-51）只在配置恰好等于内置 preset 时探测：跑 `--help`（如 `grok agent stdio --help`），正则匹配 `\bacp\b`。为什么必须先验证（L16-18 注释）：老版本 CLI 会把未知 `acp` 参数当 prompt 进入交互模式，把协议 JSON 灌进交互式 agent。一个细节：**先剥 ANSI 转义序列**——FORCE_COLOR 环境下彩色 help 里 "acp" 的词边界会被转义码尾字符吃掉导致误判。结果按 `mtimeMs:size` 缓存。

### acpConfigCompatibility：新旧协议归一化

老 native agent（含 Gemini）在新 session 响应里仍返回独立的 `models`/`modes` 字段而非统一的 `configOptions`。`normalize()`（L17-44）在 SDK 校验丢弃 legacy 字段**之前**截获响应，把 models/modes 合成 `config_option`，并把 `current_model_update` 通知改写成 `config_option_update`；`legacyKind()` 让 `setConfigOption` 知道该用旧 method `session/set_model` 还是新 `session/setConfigOption` 回写。这个 TransformStream 插在 `ndJsonStream` 与 SDK 连接之间。

### 延迟预算驱动的缓存

`acpRuntimeConfig` 的选择器列表经 SQLite `setMeta("acpConfigOptions")` 缓存（`rememberConfig`/`cachedConfig`，L519-542）——优先返回活跃 runtime 的 live config，`acp-http` 协议直接返回 null（无 config options 概念）。注释（L584-595）给出理由：冷启动一个 adapter 要 2-3 秒，"三秒才填满的下拉框是没人再开的下拉框"。配套地，`setAcpConfigOption` 无会话时不启动 agent（L609-617 注释：选模型是用户说话前唯一操作，不能是最慢一步）——无 session 时改选择只是"调用方记忆的 pick"，由后续 `acquire()` 启动会话时经 `applyConfig` 重放；`acp-http` 例外，会真的 acquire 启动 runtime。

### 凭证与身份边界

三个小模块划清边界：`agentCredentials.ts` 的 `subscriptionEnvironment()` 在 spawn 前删除会盖掉 CLI 登录态的 env（claude 的 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`，codex 的 `OPENAI_API_KEY` 等）——文件头注释解释动机：Codex adapter 的 SDK 会静默用 env key 切到按 token 计费，用户看到的是莫名其妙的 "Credit balance is too low"；终端 pane 是用户自己的 shell 保留 export，但 Termany 会话要"一个 agent 一个账号"。真正的 BYOK 凭证存 `config.ts` 的 provider 表（读取时 `maskKey()` 掩码，浏览器永不见到明文）。`botIdentity.ts` 的 `botAcpPrompt()` 把 Bot profile 作为独立 user text block 前置而非 system prompt（ACP 没有可移植的 system-prompt override，且每轮刷新支持热改）；profile 明确指示 agent 不要因 Bot 名字谎报自己的模型/工具。`agentImages.ts`：输入侧按路径读文件转 base64（≤8 张、≤20MB、双 vision 兼容格式）；输出侧按 `sha256(mime+NUL+bytes)` 去重落盘 `~/.termany/agent-images/`——历史只存路径不存 base64，不让 SQLite 吸收兆级 payload。`geminiAuth.ts` 没有 OAuth 流程：只读 `~/.gemini/settings.json`，若 `selectedType === "oauth-personal"` 则报错——Google 于 2026-06-18 关停了 Gemini CLI 个人 OAuth，API-key/Vertex/企业版放行。

### agentDetection：双轨探测

`agentDetection.ts` 的 `detectAgentExecutable`（agentDetection.ts:116-168）把"终端 CLI 装没装"（`terminalInstalled`）与"conversation runtime 可不可用"（`installed`）分开探测（runtime 可能是 managed bridge 或 HTTP 端点而非 CLI 本体）。managed 分支要求 CLI 已装 **且 bridge bundle 存在**（`managedAcpAdapterPath` 找不到打包产物时报 "Termany's … ACP bridge is missing"）。探测基石是 `shellPath.ts` 的 `resolveExecutable()`——在**用户 login shell 里**跑 `command -v`，因为 Finder 启动的 macOS bundle 继承 launchd 的裸 PATH。acp-http 走 `detectHttpAcp`（L67-93）：先 `GET /ping`（不带 auth）验证返回 JSON 的 `protocol === "acp/0.2"`，再 `GET /agents?limit=1` 带 `Authorization: Bearer <apiKey>` 验证 key（3s 超时、`redirect: "error"`）。本地 runtime 检测成功后立刻跑 `checkGeminiAuthSupport` + `checkNativeAcpSupport`，失败时 `installed: false` 带 error——把不兼容的 CLI 挡在 Bot picker 之外（L113-115 注释）。

### BYOK 旁路：streamAgentChat

`agentChat.ts` 的 `streamAgentChat()`（L144-185）是未配置 runtime 时的内置助手通道（非 coding agent）：消息清洗（末 80 条、单条 10 万字符）→ `botIdentityPrompt` 拼 system → 按 provider 分派 `streamAnthropic`（/v1/messages）或 `streamOpenAI`（/chat/completions）→ `consumeSse` 归一化 → `onText` 回调。index.ts:944-946 的注释点明设计："Normalize all upstream streaming protocols to newline-delimited JSON so **API keys and provider quirks stay on the server side**"。

`agentConfig.ts` 的注册表向后兼容有三道规则：**已移除的 agent**（`REMOVED_AGENT_IDS = {charm, kilocode, droid}`）只在 `runtime.distribution !== "custom"` 时才被清除——用户用熟悉命令 id 自建 adapter 的条目保留；**runtimeRevision 回填**——`sanitize()` 里 `inheritsDefaultAgentRuntime` 为真的旧注册表（在内置 adapter 出现前写入、runtime 为 null）自动取新默认，否则 agent 不会出现在聊天 picker；**保存约束**——`saveAgentConfigs` 截到最多 64 个 agent（`slice(0, 64)`），`orderedRegistry` 把非内置 custom agent 排前、内置项按 `BUILTIN_AGENTS` 产品序覆盖 fallback。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 + 分层 | index.ts 只见 `acpRuntime`，其下 managed/native/fastClaw 两层 | ACP 差异不外溢到路由层 |
| 判别联合分发 | `AgentRuntimeConfig.protocol`/`distribution` | 三种形态一套类型 |
| 悬挂 Promise 作跨进程回调 | `requestPermission`/`respondPermission` | agent 的 JSON-RPC request ↔ 用户点击，天然异步解耦 |
| 缓存驱动的延迟预算 | `cachedConfig`/`rememberConfig` | 冷启动 2-3s 不可接受 |
| 环境净化 | `subscriptionEnvironment` | 订阅登录态与 env key 的冲突主动消解 |

## 模块间交互

依赖 `@termany/core` 的 `AgentRuntimeConfig`/`defaultAgentRuntime`（经 `agentConfig.ts`/`nativeAcp.ts`），以及 `shellPath.resolveExecutable`、`db.ts` 的 meta KV。被 `index.ts` 的 6 个 ACP 路由消费（config/chat/cwd/pick-cwd/permission + agents detect）。上游前端是 `AgentPane` 的 NDJSON 消费循环（见[Agent 聊天前端](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/08-web-agent-chat)）。注意 web 侧还有一套**会话 id 命名空间约定**（`groupMemberSessionId`/`groupControllerSessionId`/`directA2ASessionId`）把群聊/A2A 编码进 paneId，server 按 paneId 复用进程——跨层共享的契约是这几个 id 构造函数。

## 扩展方式

**接入一个新 agent**：core 的 `BUILTIN_RUNTIMES` 加预设 → `agentConfig.ts` 的 `BUILTIN_AGENTS` 加条目 → 若 CLI 可能是旧版，`nativeAcp.ts` 的 `NATIVE_AGENTS` 加 id 并补 help 参数与匹配正则 → 特殊需求仿 `geminiAuth.ts` 写启动前检查（在 `Runtime.create` 与 `detectAgentExecutable` 两处接线）。managed 桥接型则改 `managedAcp.ts` 的 `DEFINITIONS` + `bundle-server.mjs` 打包清单。对应测试：`nativeAcp.test.ts`、`managedAcp.test.ts`、`agentConfig.test.ts`。

**新增一种 ACP 消息类型渲染**：`AcpRuntimeEvent` 加事件变体 → `prompt()` 的 update 分发循环加翻译分支 → 若属 config 类新字段还需 `acpConfigCompatibility.normalize()` 在 SDK 校验前截获改写 → 前端 NDJSON switch 加渲染分支。

**升级 managed bridge**（如 claude-agent-acp 0.76 → 0.8x）：`apps/server/package.json` 改版本 → 若新版已统一 configOptions 可删对应 legacy 分支 → core 的 `AGENT_RUNTIME_REVISION` bump + 视情况加旧 preset 匹配强制老注册表迁移。
