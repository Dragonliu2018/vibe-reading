---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "技能·权限·上下文横切"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "Skills", "权限", "Compaction", "MCP", "Cron"]
description: "agent-modules 十个二级包解读——IO-free 领域原语 + host ports 注入；skills 五级来源 O_NOFOLLOW 安全校验、PermissionEngine 三步流（bash AST + fs 路径能力）、双代 compaction、MCP 项目配置、system-reminder 28 provider 责任链"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

`packages/agent-modules/` 的十个二级包（skills/permission/context-manager/cron/goal/background-task/runaway-guard/system-reminder/session-report/conversation-contract，合计 ~4.2 万行）+ v2 的服务化装配（`service/{mcp,cron,pin,background-bash,workspace}`）。它们是**无宿主 IO 的领域原语库**：每个包 = 一个可独立测试的决策原语 + host ports。`goal/index.ts` 头注释说得直白："IO-free by design… the same impls work in local-runtime today and could be reused by cloud-runtime later"。宿主是 v1（local-runtime）与 v2（local-runtime-v2）两代——这正是独立成包的理由：原语不绑定任何一代宿主。

## 模块架构

![权限与横切模块](/vibe-reading/images/articles/minimax-code/permission-skills.svg)

十个包按消费者分三类：**turn 组装时消费**（skills 目录注入、conversation-contract 契约）、**每次工具调用时消费**（permission 三步流）、**每次 LLM 调用前消费**（context-manager/compaction）。`agent-extension` 包把它们包装成 pi 扩展（`contextManagerExtension`、`runawayGuardExtension` 等 13 个），宿主 `createAgentRuntime({base:[...]})` 挂载。`conversation-contract` 是横向契约：`ConversationSession`（runtime/sessionKind）、`ConversationSource` 14 值枚举（api/cron/task/channel:wechat…——所有横切入口的身份标识）、`ConversationIngress`（submit/steer）。

## 调用链路

三条主链路：

```
Skill：SkillRegistry.refresh()（registry.ts:95，五级 root 扫描）
  → resolvePrecedence（SOURCE_RANK：project > workspace > agent > global/user > builtin）
  → turn-system local-agent-config-builder.ts:522 调 renderCatalog()（20k 字符预算）注入 system prompt
  → 模型调 skill 工具（agent-tools/src/desktop/local-skill.ts → readSkillByName）按需加载全文
  → watch()（200ms debounce / 1s max-wait）热更新 → onDidChangeRuntimeSkills 通知 turn 能力重算
权限：beforeLocalToolCall hook → LocalPermissionFacade.checkPermission（facade.ts:449）
  → PermissionEngine.checkPermission（engine.ts:188 三步流）
       Step1 Reject（whole-tool deny/ask → 工具 checker → content 规则，bypass 免疫）
       Step2 Allow（bypassPermissions / whole-tool allow）→ Step3 fallback ask
  → ask：permission.ask 事件 → TUI 弹窗 → allowOnce/allowAlways/deny 回流 settle waiter
Compaction：PiBeforeLlmCallHook → probeBeforeLlm（token 计数 / 字节数）
  → 超阈值 → compactBeforeLlm → ToolResultArchiver（tool_archive）→ llm_checkpoint
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `refresh()` in skills/src/registry.ts:95 | 扫描五级 root | `O_NOFOLLOW` + dev/ino/size/mtime 稳定性校验 |
| `checkPermission()` in permission/src/engine.ts:188 | 三步决策 | reject→allow→ask，checker registry |
| `checkBashPermission()` in tools/bash-permission.ts:1493 | bash 判定 | shell AST 解析，危险命令 HARD deny，rm→trash 重写 |
| `evaluatePathCapability()` in tools/path-capability.ts | fs 判定 | 路径边界检查（与 bash 的命令级分析互补） |
| `beforeLlmCall` in context-manager/src/manager.ts | v1 压缩钩子 | 远程 count_tokens，headers/tools 必须透传 |
| `buildReminder()` in system-reminder/src/service.ts | 出站消息提醒 | turn 计数驱动退避间隔 |
| `observe()` in runaway-guard/src/guard.ts | 循环检测 | 纯 turn-local，无持久化无 IO |

</details>

## 核心实现

### skills：五级来源与安全边界

同名 skill 按 `SOURCE_RANK` 优先级遮蔽（winners/losers 可诊断）。SKILL.md 读取带 `O_NOFOLLOW` + dev/ino/size/mtime 稳定性校验、symlink 出 root 拒绝——防 TOCTOU 与路径逃逸。catalog 是 20k 字符预算的目录注入 system prompt，全文按需由 `skill` 工具加载——与 Claude Code 的 skills 机制同构。

### permission：三步流与两套 checker

bash 与 read 的判定本质不同：**bash 是命令级 AST 分析**（bash-ast.ts/bash-split.ts 解析；灾难性 rm/磁盘抹除/反壳 HARD deny；SOFT ask；rm→trash 重写；敏感读走 LLM gate），**read 是路径级边界检查**（`evaluatePathCapability`：workspace 内 allow、密钥路径 ask、越界 ask/deny）。`applyAskGate`（ask-gate.ts:66）单点强制 bypassPermissions 模式"永不弹卡"不变量——模式在入口快照一次，防 PUT /config 中途翻转造成降级。不确定输入升级云网关 `POST /mavis/api/v1/permission/check` 分类器。MCP 工具按 `matchesMcpServerRuntimeName` 做 server 级整组规则。

### compaction 两代并存与 MCP 接入

v1 经 `contextManagerExtension` 把 `ContextManager.beforeLlmCall` 挂 pi `before_llm_call`：token 计数优先远程 `count_tokens`（manager.ts:192 注释强调 headers/tools 必须透传否则系统性低估），`selectPlan()` 用 toolCall/toolResult 组完整性（`findToolGroupStartForIndex`）选安全切点。v2 `AutomaticContextCompactor` 先归档后摘要（详见 [Turn 执行系统](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/03-turn-system)）。MCP：`initializeMcpService`（v2 service/mcp/initialize.ts:39）建 `McpConnectionPool`；`ProjectMcpRuntime.resolve()` 按 session+workspace 读项目 `.mcp` 配置，digest 变化才重建 snapshot；工具名由 `buildMcpToolRuntimeName` 规整为 `mcp__server__tool`（总长 80、server 段 48）。

### cron 双轨与 system-reminder 成本意识

双 cron 并存：`agent-modules/cron`（daemon 时代 host-ports 版，v1 使用）与 v2 `service/cron`（Sqlite repo + SchedulerClient 重写版）；`buildMavisCronAdapter` 对两套后端分派。`system-reminder` 的 `createDefaultRegistry`（providers.ts:823）注册 28 个 provider，注释保留了 "relevantMemoryProvider removed —— 低相关精度每轮浪费 ~500-1000 tokens" 这类**成本决策记录**；`disableSrModels` 命中时降级 criticalOnly（critical provider 不被 allowlist 绕过）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Hexagonal / Host-Ports | `configureCronHost`（cron/src/host-utils.ts）、`configurePermissionHost` | 领域包零 IO，宿主注入端口 |
| Strategy Registry | `PermissionEngine.checkers: Map`（engine.ts:157） | 工具级判定策略可插拔 |
| Chain of Responsibility | `SystemReminderRegistry.append/appendCritical/appendFor` | framework 分链 + critical 降级链 |
| Extension SPI 装配层 | agent-extension 的 13 个内置 extension | 原语→pi 扩展的翻译 |
| Observer 隔离副作用 | `ContextManagerObserver.onCompactionCommitted`（manager.ts:326） | observer 异常不影响决策 |

## 模块间交互

`turn-system/agent-host/preparation/local-agent-config-builder.ts` 是主要汇点（skill catalog 渲染、`TaskSessionBindingCapability` 消费）；permission 的会话消息源经 `RuntimeConversation['query']` 适配。v1 侧 `LocalSkillService`/`LocalPermissionFacade` 是进程级实现（`initSkillService/getSkillService` fail-closed 单例，对应 ADR desktop-service-ownership 的 domain-facade 模型）。

## 扩展方式

- **新增 skill 来源层级**：改 `registry.ts:72` 的 `SOURCE_RANK`（或 `local-runtime/src/skills/roots.ts` 加 root 构造），`watch()` 自动覆盖。
- **新增工具权限 checker**：`permission/src/tools/` 实现 `ToolPermissionChecker` + `registerDefaultCheckers` 注册；规则匹配在 `context.ts` 的 `getContentRulesForTool`，持久化 codec 在 `local-runtime/src/permissions/rule-codec.ts`。
- **新增 system-reminder provider**：`providers.ts` 实现 + `createDefaultRegistry`（:823）`append`/`appendCritical` 注册。
