---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "Overview"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "TypeScript", "Cordis", "Agent", "Plugin"]
description: "DeepSeek AI 开源的 agent harness——基于 vendored Cordis 的 everything is a plugin 架构，从 profile/bundle 装配到 turn/step 驱动、session log 真相源与 capability seam 执行生态的端到端解读。"
readingTime: "28 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> **版本** 0.1.0-rc.5 · **协议** MIT · **语言** TypeScript 6.0 / Node.js ≥ 22.19 · **代码量** ~520,000 行 TS/TSX（2305 文件）+ ~2,600 行 Python · **仓库** [GitHub](https://github.com/deepseek-ai/deepseek-harness)
>
> 本文基于 `main` 分支 commit `47f943859b`（`0.1.0-rc.5` 发布后的持续开发版本）。DeepSeek Harness 处于 *developer preview*，迭代迅速，**会有破坏性变更**。

---

## 总览

### 项目简介

**DeepSeek Harness**（命令行名 `dsh`）是 [DeepSeek AI](https://deepseek.com) 开源的 agent harness——一个把大模型变成可执行 agent 的运行时框架。它不只是一次模型调用，而是把"模型适配、工具注册、会话日志、沙箱执行、审批策略、子 agent 委托"等 agent 需要的全部能力组织成一个可替换的插件生态。

核心架构选择是 **"everything is a plugin"**：整个产品没有特权核心，连 agent loop 本身、模型适配器、会话日志都是挂在共享 context 上的插件。扩展 dsh 不是 fork 源码，而是在其它插件旁挂载一个新插件。这套机制由 vendored 的 [Cordis](https://github.com/cordiverse/cordis) 框架提供——插件向共享 `ctx` 贡献 services、typed events 和 reversible effects，所有 registration 都是 effect，插件卸载时确定性 unwind。

dsh 解决的问题是：当 agent 产品需要在部署间切换模型 provider、把执行搬到远程沙箱、或增减能力时，如何避免代码分叉。它的答案是 **capability seam**——每个能力（filesystem、subprocess、shell、LLM……）都拆成 Service Definition / Service Provider / Consumer 三角色，换掉一个 provider 就能搬动整个 execution world，无需 provider forks。

核心使用场景：作为 Web UI 本地运行（`dsh web`，浏览器访问 `127.0.0.1:3080`），或作为 headless 一次性 runner、ACP 自动化 server、JSON-RPC out-of-process SDK 嵌入其它产品。**项目边界**：dsh 是 harness 框架，负责组装与驱动 agent 能力栈；它本身不内置模型权重，模型经 `ctx.llm` 的 adapter 接入（DeepSeek provider 是其一）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| 插件化 agent loop | `packages/core/agent-loop` | turn/step 驱动，本身是可替换插件 |
| 工具管线 | `packages/core/tools` | scoped registry + 三段 waterfall 守卫管线 |
| 会话日志（真相源） | `packages/core/session` | append-only SessionEvent log，model-visible ⟺ logged |
| LLM 流式适配 | `packages/llm/llm` + `llm-pi-ai` + `llm-deepseek` | provider-neutral 消息/流词汇，单 adapter swap 切换 |
| 沙箱执行 | `packages/sandbox` + `fs` + `subprocess` + `shell` | bwrap/Landlock/Seatbelt，execution world 共享 |
| Profile/Bundle 装配 | `packages/boot/app-boot` + `packages/bundle/*` | 分层 patchable 组合，任意行可被替换 |
| 子 agent 委托 | `packages/subagent` + `workflow` | fresh child vs delegated turn，同接口 |
| Web GUI 双半 | `packages/host` + `packages/client` + `apps/web` | host BFF + 浏览器 shell，Typert 类型图 RPC |
| 自我修改 | `packages/extensions` | agent 经 `node:vm` sandbox 挂载自己写的插件 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Cordis（vendored） | 核心 | 插件 / effect / typed event / waterfall 框架 |
| TypeScript 6.0 | 核心 | 全量 strict + noImplicitAny，双 face 编译（host/client） |
| pnpm 11 workspace | 核心 | ~50 包 monorepo，linkWorkspacePackages + strictDepBuilds |
| tsdown + tsc | 核心 | lib/types 产出，`DSH_BUILD_FACE` 驱动 host/client 分面 |
| @earendil-works/pi-ai | 可选 | LLM 多 provider 适配（模型目录更新） |
| node-pty | 可选 | 持久 PTY 后端（跨平台 ConPTY） |
| Vitest 4 | 开发 | 单测 + e2e + snapshot + web 测试矩阵 |
| oxlint / knip / jscpd | 开发 | lint / 未用代码 / 重复检测门禁 |
| VitePress | 开发 | 文档站（docs/ 投影） |

### 版本历史

dsh 当前处于 `0.1.0-rc.5` 的 *developer preview*：无外部消费者，**优先正确地基座而非兼容性**——可以自由 rename/repackage 并同步更新所有引用。`AGENTS.md` 明确"Remove this section at the first tagged release"，且后端拒绝旧 on-disk 格式、SQLite 用单调 `SCHEMA_VERSION`、`dsh-session` 的 `SESSION_FORMAT_VERSION` 保持 `0` 无兼容承诺。这意味着本文描述的 API 在后续版本可能调整。

---

## 快速上手

```sh
# 方式一：npx（需 Node.js）
npx @deepseek-ai/dsh web          # 启动 Web UI，默认 http://127.0.0.1:3080

# 方式二：从源码
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build                    # tsc 产出 lib/types + tsdown bundle + web 构建
pnpm dsh web                       # 启动 Web UI
```

端到端验证：浏览器打开 `127.0.0.1:3080`，新建会话发送一条消息，模型流式回复即证明 agent loop + LLM + session log 全链路打通。

查看本机实际 boot 的插件树（任意一行都可被自己的 patch 替换）：

```sh
dsh --profile web --dump-config
```

> 仅外部操作与结果验证。内部启动调用链见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

dsh 的架构思想可以用一句话概括：**把"一个 agent 产品"拆成一棵可替换的插件树，每个能力都是三角色契约（seam），让"换一个 provider"等于"换一个产品"**。它解决的是 agent 产品在多部署、多 provider、多执行环境下的代码分叉问题——传统做法是每加一个 provider 或一个远程沙箱就 fork 一份代码，dsh 用插件 + seam 把 fork 降为配置。

分层上，dsh 自顶向下分五层，外加一组横切的交互/护栏关注点。上层依赖下层，每一层都是 Cordis 插件，没有特权核心：

![分层架构](/vibe-reading/images/articles/deepseek-harness/architecture.svg)

各层职责与代码目录映射：

| 架构层 | 包含目录 | 层职责（为什么存在） |
| --- | --- | --- |
| 装配与入口 | `apps/cli`、`packages/boot/app-boot`、`packages/bundle/*`、`packages/preset` | 把分散的插件组合成一棵可 boot 的树，任意 config 行可被 patch 替换 |
| 应用面 | `apps/web`、`packages/host`、`packages/client`、`packages/api`、`packages/typert` | host/client 双半：BFF + 浏览器 shell，Typert 类型图 RPC 做 wire 契约 |
| 核心引擎 | `packages/core/*`（agent-loop、agent、tools、session、system-prompt、scope） | 产品 API 脊柱：turn/step 驱动、工具管线、session log 真相源 |
| 能力生态 | `packages/llm`、`fs`、`shell`、`subprocess`、`sandbox`、`subagent`、`workflow`、`skill` 等 | capability seam providers，一个 swap 搬动整条 execution world |
| Cordis 框架 | `vendor/cordis`、`loader`、`include`、`group`、`cosmokit`、`schemastery` | 插件 / reversible effect / typed event / waterfall 范式底座 |

横切层「交互与护栏」（`interaction`、`guard`、`plan`、`todo`、`context`、`compaction`、`hooks`）不属任何一级层，而是挂在 `agent/*` 与 `tools/*` 事件上的监听器——它们拦截驱动而不侵入 loop。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 插件宿主 + Registry | `vendor/cordis/src/registry.ts` `RegistryService` | 无特权核心，扩展即挂载，卸载即回滚 |
| Reversible Effect（Disposable） | `vendor/cordis/src/fiber.ts` `Fiber.effect()` | registration 随插件卸载逆序 unwind，确定性 teardown |
| Waterfall Middleware | `vendor/cordis/src/events.ts` `waterfall` | 多插件包裹单一决策（agent/pre-step、tools/execute、llm/stream），listener `next()` 委派 |
| Capability Seam（三角色） | `packages/shell/shell` + `bash-local` + `tool-bash` | 换 provider 不改 Consumer，execution world 整体迁移 |
| Append-only Log + Projection | `packages/core/session` `Session.append` + `deriveMessages` | model-visible ⟺ logged，fork/resume/replay 都从 log 派生 |
| Layered Composition（profile/bundle/patch） | `packages/boot/app-boot/src/profile.ts` | 用户无需 fork 代码即可改任意 config 行 |
| Two-Face Build | `tsconfig.host.json` / `tsconfig.client.json` | 同名 ctx key 在两侧 merge 不同实现，单 ts.Program 无法并存 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `Context`（ctx） | 共享服务仓库 + scope 载体 | 进程级，boot 时 `new Context()` | 持有所有 `Service` 子类实例 |
| `Fiber` | 插件运行实例（状态机） | 插件 mount→unmount | 持有 `_disposables`（effects） |
| `Session` | 一个会话的 append-only log | 会话级 | 持有 `SessionEvent[]`、`SurfaceManager` |
| `Agent` | 一个驱动单元（inbox + status + ctx） | 由 `AgentLoop` factory 创建 | 持有 `Inbox`、`Phase` 状态机 |
| `Turn` / `Step` | turn = 零或多 step；step = 一次 model 请求 + 工具 | turn 内 | 写入 `turn/*`、`step/*` durable 事件 |
| `SessionEvent` | log 的一条不可变事实 | 永久（持久化） | `seq` 单调，`ignorable` 控制兼容性 |
| `ToolDefinition` | 一个 model-facing 工具的声明 | 插件级 | schema + execute + output.render |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `Service` | `vendor/cordis/src/service.ts` | 所有 ctx 服务 | 构造器自注册 `ctx.reflect.provide` |
| `Agent`（接口） | `packages/core/agent/src/runtime-types.ts` | `ReactLoopAgent` | `ctx.agents.setFactory(AgentLoop)` |
| `LlmAdapter` | `packages/llm/llm/src/index.ts` | `DeepSeekAdapter`、`PiAiAdapter` | `ctx.llm.registerAdapter` |
| `ShellExecutor` | `packages/shell/shell/src/index.ts` | `LocalBashExecutor`、`SandboxBashExecutor` | `inject` 后挂 `ctx.shell` |
| `SubagentProvider` | `packages/subagent/subagent/src/types.ts` | `subagent-fork-in-process` 等 | `ctx.subagents.registerProvider` |

这些抽象是扩展点的契约：实现新 provider 即继承对应抽象并在 `apply()` 注册。

---

## 代码目录

```
deepseek-harness/
├── apps/
│   ├── cli/                 # dsh 命令入口（bin.ts → profile-boot/plugin/dump-config）
│   └── web/                 # Web UI 前端（React，~20k 行）
├── packages/                # @deepseek-ai/dsh-* 工作区（~50 包，按 group 分）
│   ├── core/                # 产品 API 脊柱：agent-loop/agent/tools/session/system-prompt/scope
│   ├── llm/                 # LLM 能力：llm(seam) + llm-pi-ai + llm-deepseek
│   ├── fs/ shell/ subprocess/ terminal/ lsp/ web/   # 执行能力生态
│   ├── sandbox/ e2b/        # 沙箱隔离（bwrap/Landlock/Seatbelt）+ 远程 E2B POC
│   ├── subagent/ workflow/ skill/ acp/ sdk/   # 委托与协议
│   ├── interaction/ guard/ plan/ todo/ context/ compaction/ goal/ hooks/  # 交互护栏
│   ├── boot/ bundle/ preset/   # 装配（app-boot + bundle patch 层 + per-session preset）
│   ├── host/ client/ api/ typert/   # Web GUI 双半 + BFF + 类型图 RPC
│   ├── session/ session-query/  # 持久化（JSONL/SQLite）+ 检索（lineage/FTS）
│   ├── settings/ credentials/ storage/ identity/   # 基础设施
│   └── extensions/          # agent 自我修改（动态挂载插件）
├── vendor/                  # vendored Cordis 源码（cordis/cosmokit/schemastery/loader/include/group/hmr）
├── native/landlock-run/    # Landlock 沙箱启动器（node addon）
├── python/                  # Python SDK + 打包运行时
├── examples/                # 可运行 cordis.yml leaves（ACP/headless/JSON-RPC/MCP demo）
├── docs/                    # 架构文档 + 生成 catalog + cookbook + postmortem
└── scripts/                 # 仓库门禁与生成器（~40 verify-* 脚本）
```

只解释一级目录与关键二级。详细文件级分析留给各模块文档。`docs/` 是权威架构文档（`architecture.md`、`cordis-primer.md`、`subsystems/*`），修改 `packages/` 前必读。`scripts/` 维护大量不变量门禁（如 `verify-cordis-config`、`verify-runtime-closure`）——它们把可机械检查的契约编进 CI。

---

## 模块地图

dsh 的职责分化出 10 个有效模块，全部单层并列（概览 + 10 模块文件）。模块数由项目客观职责分化决定，不人为分层：

![模块依赖关系](/vibe-reading/images/articles/deepseek-harness/module-dependencies.svg)

核心引擎层（Agent Loop / Tool 管线 / Session 日志）是产品 API 脊柱，能力生态与 Cordis 框架可替换，交互护栏横切挂在事件上。模块间动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Cordis 插件内核 | 插件/effect/event/waterfall 范式 | `vendor/cordis/src/{context,fiber,events}.ts` | 它是"everything is a plugin"成立的底座，与产品逻辑正交 | [01-cordis-plugin-kernel](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/01-cordis-plugin-kernel) |
| Agent Loop 执行核心 | turn/step 驱动 + prompt 装配 | `packages/core/agent-loop/src/agent.ts` | 驱动器本身也是可替换插件，无特权 | [02-agent-loop](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/02-agent-loop) |
| Tool 工具管线 | scoped registry + 三段守卫管线 | `packages/core/tools/src/index.ts` | 工具是 model-facing 能力入口，与 provider 解耦 | [03-tool-pipeline](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/03-tool-pipeline) |
| Session 日志与持久化 | append-only log + 投影 + 持久化 | `packages/core/session/src/index.ts` | model-visible ⟺ logged 的真相源 | [04-session-log](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/04-session-log) |
| LLM 能力层 | LLM seam + 消息/流词汇 + adapter | `packages/llm/llm/src/index.ts` | provider-neutral 词汇让历史可跨 provider 重放 | [05-llm-capability](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/05-llm-capability) |
| 执行能力生态 | capability seam 三角色落地 | `packages/shell/shell/src/index.ts` | 一个 swap 搬动整个 execution world | [06-execution-capabilities](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/06-execution-capabilities) |
| 装配与启动 | profile/bundle/patch 分层组合 | `packages/boot/app-boot/src/index.ts` | 让"换配置"替代"改代码" | [07-assembly-boot](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/07-assembly-boot) |
| 客户端与 Host | Web GUI 双半 + Typert RPC | `packages/host/apiproxy` + `packages/client/runtime` | host/client 进程隔离 + 类型安全 wire | [08-client-host](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/08-client-host) |
| 交互与护栏 | approval/permission/guard/plan | `packages/interaction/user-approval` | 拦截驱动而不侵入 loop，部署可换策略 | [09-interaction-guard](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/09-interaction-guard) |
| 委托与协议 | subagent/workflow/skill/acp/sdk | `packages/subagent/subagent/src/index.ts` | 把"另一个 agent"藏在同接口后 | [10-delegation](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/10-delegation) |

---

## 运行时行为

### 启动流程

从命令行到插件树 mount 的调用链（`apps/cli/src/bin.ts` 与 `packages/boot/app-boot/src/index.ts`）：

```
bin.ts parseDshArgs(argv)                   # args.ts 分派 profile/plugin/dump-config
  └─ loadLayeredEnv('dsh')                   # inherited > project .env > user .env 快照
  └─ runProfile({environment, profile, patches, args})
     └─ composeProfile(name, patches)        # 叠层：bundlePatches → profile → home → --patch
     └─ boot(NAME, rootConfig, allPatches, prepare)
        ├─ new Context(); ctx.plugin(Loader)  # 装 Cordis Loader 服务
        ├─ prepare(ctx)                       # 注入 env snapshot + provideCmdline(args, exit)
        ├─ mountRootInclude(ctx, config, patches)   # 注册 cordis:include + cordis:group builtin
        ├─ ctx.get('loader').await()          # 并发 mount 全树直至 settle
        └─ assertEntriesActivated(ctx)        # 审计 fiber 状态，失败带原 stack 抛出
```

对象装配发生在 `boot()` 内：`new Context()` 建 root context → `ctx.plugin(Loader)` 装加载器服务 → `prepare` 注入 launcher facts（环境快照经 `DSH_LAUNCH_ENVIRONMENT_KEY`、`provideCmdline` 给退出权）→ `mountRootInclude` 把 patch layers 注册为 `cordis:include` entry。Loader 并发 mount 插件树直至 `await()` settle，`assertEntriesActivated` 审计所有 fiber 状态（failed/pending 会汇总抛出）。配置来自分层 `cordis.patch.yml`（bundle → profile → home → `--patch` overlay，last-write-wins，按 id 整行替换）。插件以 `inject` 声明依赖，`AgentLoop` 的 `static inject = ['agents','sessions','llm','tools','systemPrompt']` 决定其 mount 时机——等这五个服务就绪才执行 callback。

之后控制权交给被 mount 的 surface 插件：`web-app` 的 `webStartup` 启动 HTTP server；`headless` 的 `headless-runner` 跑一次性 task 后 `ctx.appExit`。

### 核心运行流程

dsh 运行时最重要的链路是 **一次 turn 的完整流转**。它把 agent loop、session log、LLM、tool 管线、交互护栏串成一条事件流。下图展示 turn/start → turn/end 的全流程，青色为 durable session event（写进 log），蓝色为 waterfall（多插件包裹、`next()` 委派），粉色为 serial（无 `next()`，listener 顺序不影响 outcome）：

![Turn Step 流程](/vibe-reading/images/articles/deepseek-harness/turn-flow.svg)

数据流文字解读：`turn()` 在 session log 开 `turn/start`，`preStep()` 从 inbox 原子 claim 一批 input 并经 `ctx.systemPrompt.assemble()` 装配 prompt sections + tool schemas，再经 `agent/pre-step` waterfall——listener 可 rewrite 消息或 reject（reject 仍关闭一个 durable turn，因 claimed batch 已原子移除、turn 已 open）。`step()` 内 `buildRequest()` 跑 `agent/request` waterfall 产出 `LlmCallConfig`，`ctx.llm.prepareCall()` 绑定 adapter + retry policy 后 `ctx.llm.stream()` 经 `llm/stream` waterfall 流式——raw `assistant/chunk` 边到边写 log（保 replay 保真），`BlockAssembler` 折叠成 `assistant/message` 锚点。若有 tool-call，`executeToolCalls()` 用 bounded pool 调度，经 `tools/pre-execute`（allow/deny/ask）→ `tools/execute`（around-dispatch，timeout/retry）→ `tools/post-execute`（accept/block/replace）三段 waterfall，产出 `tool/result` durable 事件。step/end 后若 tools 欠新请求或 next-step input 到达则 claim 下一个 step；否则 `agent/turn-stopping` serial 让 listener 决定是否 `agent.steer()` 注入继续，最终 `turn/end`。

#### 数据流：启动→一次 turn→log 持久化

```
cli → app-boot → cordis loader → core/agent-loop (turn driver)
  → core/session.append (durable events)
  → llm/llm.stream (waterfall) → assistant/chunk* → assistant/message
  → core/tools (pre/execute/post waterfall) → tool/result
  → session/flush (parallel) → persistence backend (JSONL/SQLite)
```

跨模块边界：cli→app-boot 传参数；app-boot→cordis loader 以 entry list + patch layers 组合；loader→agent-loop 经 ctx 共享 service + session event log；agent-loop→llm 经 `ctx.llm.stream`；agent-loop→tools 经 `TOOL_RUNTIME_SCHEDULER` 的 prepare/dispatch/finalize。异步并发：`llm/stream` 是 `AsyncIterable<StreamChunk>`，`for await` 逐 chunk 消费；并行 tool calls 用 bounded rolling pool + `Promise.race` overlap dispatch；workflow/subagent 用 `node:worker_threads` 隔离同步脚本。错误处理：waterfall listener 可 reject 短路；LLM finish 为 error/aborted 走 `agent/request-error` waterfall 决定 retry 或 throw `LlmError`；tool 失败被 `ToolRuntime` 统一 materialize 为 `ToolExecutionResult{isError}`（不 throw）；turn 级 try/catch 把 `signal.aborted` 映射为 `{kind:'aborted'}`、其他 error 映射为 `{kind:'error'}`。

#### 能力 seam 的运行时落地

dsh 把每个能力拆成三角色。下图以 shell 为例展示 Consumer（model-facing tool）→ Service Definition（`ctx.shell` 抽象）→ Provider（local/sandbox/pwsh 实现）的关系，并展示 fs+subprocess+shell 共享 execution world 时一次 provider swap 如何搬动整条链：

![Capability Seam](/vibe-reading/images/articles/deepseek-harness/capability-seam.svg)

### 状态流

dsh 运行时的核心状态机是 **Agent 的 `Phase`**（`packages/core/agent-loop/src/agent.ts`）：

- `idle`（持 `lastTurn`）→ `wakeDriver()` → `running`（持 `abort`、`turn`、`step`、`wakeRequested`）
- `running` → turn 循环结束且无 pending → `idle`
- 任意态 → `runMaintenance()` → `maintenance`（持 `abort`、`lastTurn`、`wakeRequested`）→ 完成后回 `idle` 或 `running`

`Phase` 是 closed union，`setPhase()` 发布 `agent/status` 事件。`AgentHandle.dispose()` 是 teardown capability——只有持有者能销毁 agent。`Fiber`（Cordis 侧）也有独立状态机 `PENDING→LOADING→ACTIVE→FAILED/UNLOADING→DISPOSED`，`_setEpoch()` 在依赖变化时触发 reload/unload。Session 侧无显式状态机，而是 append-only log + surface 投影——状态从事件流 fold 而非维护 live mirror。

---

## 典型修改场景

#### 场景 1：新增一个 model provider

在 `packages/llm/llm-<name>/` 写 `<Name>Adapter extends LlmAdapter`（实现 `stream(): AsyncIterable<StreamChunk>`，把 provider SSE 翻译为 chunk 词汇），`apply(ctx, config)` 调 `ctx.llm.registerAdapter([PROVIDER], adapter)` + `registerConfigurableProviders([{provider, settingsNs, settingsPath}])`。仿 `llm-deepseek` 加 idle watchdog 与错误分类。无需改 agent-loop / session / UI。

#### 场景 2：把执行指向远程沙箱

`cordis.yml` 加载 `ctx.e2b`（`E2BRuntime` 持共享 sandbox handle），把 `subprocess-local` 换成 `subprocess-e2b`、`fs-local` 换成 `fs-e2b`。bash / lsp / terminal 经 `ctx.subprocess`/`ctx.fs` 自动跟随——无需 bash-e2b、lsp-e2b 等 per-capability fork。改 `cordis.patch.yml`，不动代码。

#### 场景 3：加一个 loop hygiene 规则

在 `packages/guard/` 下新建 function/namespace plugin，镜像 `repeat-tool-reminder` 形态（`apply(ctx, config)` + `WeakMap<Agent, state>` + 把 reminder `prependContext` 到 `PostToolDecision.additionalContexts`）。或注册 `tools/execute` around-dispatch wrapper 做 timeout/retry。参考 `guard/timeout-policy/src/index.ts:56`。

扩展点契约定义见「架构设计解析 > 核心概念」的核心抽象表。每个场景的测试：dsh 要求非平凡 model-/user-visible 行为变更在同一个 PR 加 keyless snapshot（`test:snapshot`），provider 行为用 real-API e2e（`test:e2e`，无 key 自跳过）。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `apps/cli/src/bin.ts` 的 `parseDshArgs` → `profile-boot.ts` 的 `runProfile` → `packages/boot/app-boot/src/index.ts` 的 `boot()` → `packages/core/agent-loop/src/agent.ts` 的 `turn()` / `step()` → `packages/core/tools/src/index.ts` 的 `execute()` pipeline
- **第二遍：理解核心数据结构**
  `packages/core/session/src/types.ts` 的 `SessionEvent` / `SessionEventMap` → `packages/core/session/src/index.ts` 的 `deriveMessages()` → `packages/llm/llm/src/message.ts` 的 `Message` / `StreamChunk`
- **第三遍：理解插件与 seam 机制**
  `vendor/cordis/src/{context,fiber,events,service}.ts` 的 `ctx.effect/on/waterfall` → `packages/shell/shell/src/index.ts` 的 `ShellExecutor` 抽象 → `packages/shell/bash-local` 与 `bash-sandbox` 的 provider 实现 → `packages/shell/tool-bash` 的 Consumer
- **第四遍：选择重点子模块深入阅读**（上方模块地图链接的 10 个模块文件）

---

## 附录

**术语表**

| 术语 | 含义 |
| --- | --- |
| Cordis | dsh vendored 的插件框架，提供 ctx/effect/event/waterfall |
| profile | Harness home 里的命名组合，列出它 stack 的 bundles |
| bundle | Cordis config rows + 代码的发行格式，patchable |
| patch | `cordis.patch.yml`，按 id target 整行替换或插新行 |
| seam（capability seam） | 一个可替换能力，含 Service Definition / Provider / Consumer 三角色 |
| turn / step | turn = 零或多 step；step = 一次 model 请求 + 它调用的工具 |
| durable event | 写进 session log 的事实（turn/* step/* user/message assistant/* tool/*） |
| waterfall | around-middleware 事件，listener MUST `next()` 委派 |
| execution world | fs+subprocess+shell 共享的后端世界，一次 swap 整体迁移 |
| Typert | dsh 的类型图生成器，build-time 从 TS 源产出 RPC 契约 |
| face | 编译面，host（Node 侧）/ client（浏览器侧） |

**参考资料**

- [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness) · [架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/architecture.md) · [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/cordis-primer.md)
- [Cordis 框架](https://github.com/cordiverse/cordis) · 论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)
