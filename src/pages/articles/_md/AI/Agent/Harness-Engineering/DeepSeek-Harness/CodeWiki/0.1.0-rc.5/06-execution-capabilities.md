---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "执行能力生态"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Capability Seam", "Sandbox", "Subprocess", "Shell"]
description: "capability seam 三角色在 fs/shell/subprocess/sandbox/terminal/lsp/web 的落地——一次 provider swap 如何搬动整个 execution world。"
readingTime: "16 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

`packages/fs`、`shell`、`subprocess`、`terminal`、`lsp`、`web`、`sandbox`、`e2b`、`code-runtime` 这组包是 capability seam 模式在执行侧的落地。它们共同回答一个问题：当 agent 需要读写文件、跑 shell、起 LSP 时，如何让"换一个执行后端"等于"换一个产品"而不需要 per-capability fork。dsh 的答案是 fs+subprocess+shell 共享一个 execution world——指向远程 sandbox 时，Bash/PTY/LSP 一起跟着走。

![Capability Seam](/vibe-reading/images/articles/deepseek-harness/capability-seam.svg)

## 模块架构

每个 capability 是一个三角色 seam。以 shell 为例：

```
Consumer (tool-bash)            Service Definition (shell)           Provider (bash-*)
  ctx.tools.register(            ShellExecutor extends Service         bash-local: LocalBashExecutor
    defineTool({...}))           ctx.shell                              bash-sandbox: extends + ctx.sandbox.confine
  dispatch →                     abstract resolve(req):Spec            pwsh-local
  ctx.shell.run(                 abstract run(spec):Result
    ctx.shell.resolve(req))      abstract start(spec):Process
```

关键接口签名：
- `ctx.fs: FileSystem`（`fs/src/index.ts:86`）— `resolve(path): Promise<FsTarget>`、`processPath(target): string`、`readText`/`writeText(...,sandboxPolicy?)`/`editText`
- `ctx.subprocess: SubprocessRuntime`（`subprocess/src/index.ts:102`）— `resolveExecutable(command, env?): Promise<string>`、`spawn(spec): SubprocessHandle`、`spawnTerminal(spec)`
- `ctx.shell: ShellExecutor`（`shell/src/index.ts:65`）— `resolve(request): ShellExecSpec`、`run(spec): Promise<ShellRunResult>`、`start(spec): ShellProcess`
- `ctx.sandbox: SandboxProvider`（`sandbox/src/index.ts:158`）— `confine(argv, policy): ConfinedArgv`
- `ctx.e2b: E2BRuntime`（`e2b/src/index.ts:74`）— `getSandbox(): Promise<Sandbox>`

## 调用链路

一条 tool 调用链（tool-bash 前景执行）：

```
ctx.tools.register(defineTool({...}))  (tool-bash/src/index.ts:242)
  → dispatch → ctx.shell.run(ctx.shell.resolve({command, signal}))  (line 380)
     └─ SandboxBashExecutor.resolve(request)  # stamp sandboxPolicy  (bash-sandbox:84)
        └─ run → this.confine()  (bash-sandbox:95,177)
           └─ ctx.sandbox.confine(argv, policy)  (bash-sandbox:178)  # wrap argv，不改
              └─ this.runArgv(spec, confined.argv)  (bash-sandbox:98, 继承自 LocalBashExecutor)
                 └─ ctx.subprocess.spawn(spec)  # SubprocessRuntime (local 或 e2b)
```

## 核心实现

### 三角色为何完整才构成 seam

以 shell 为例：`ShellExecutor`（`shell/src/index.ts`）是 Service Definition，拥有 ctx key + 类型词汇（`ShellExecRequest`/`ShellExecSpec`/`ShellRunResult`）且与实现无关；`LocalBashExecutor`（`bash-local`）/`SandboxBashExecutor`（`bash-sandbox`）是 Provider，实现抽象方法但不触碰 Consumer；`tool-bash`（`tool-bash/src/index.ts:242`）是 Consumer，注入 service 而不知 provider 身份。换一个 provider（local→sandboxed→remote E2B），整个产品行为改变，而 tool 层零修改。

### 共享 execution world 与 e2b 远程落地

fs/subprocess/shell 共享一个 execution world：`FileSystem.processPath(target)`（`fs/src/index.ts:126`）返回该 backend 世界中可被 subprocess 打开的绝对路径；`SubprocessRuntime.resolveExecutable`/`spawn`（`subprocess/src/index.ts:118`）在同一世界解析可执行文件；`LocalBashExecutor` 通过 `ctx.subprocess.spawn` 起进程。

e2b 的关键设计（`e2b/src/index.ts`）：`E2BRuntime`（core，非 seam）拥有**一个**共享 `Sandbox` SDK handle + 共享 `cwd` + `runtimeRoot`。`fs-e2b`（`FileSystem` 实现，全远程）与 `subprocess-e2b`（`E2BSubprocessRuntime extends SubprocessRuntime`，`subprocess-e2b/src/index.ts:52`，spawn/spawnTerminal/resolveExecutable 全走 `ctx.e2b`）都 `await this.ctx.e2b.getSandbox()`。一个 swap（`subprocess-local`→`subprocess-e2b` + `fs-local`→`fs-e2b` + 加载 `ctx.e2b`），bash/lsp/terminal 全跟着走远程——因为它们都经 `ctx.subprocess`/`ctx.fs`，不直接持有进程或文件。无需 provider forks。

### request/spec 分离

`ShellExecutor.resolve(request: ShellExecRequest): ShellExecSpec`（`shell/src/index.ts:85`）。`ShellExecRequest`（`types.ts:38`）字段全可选（`workdir?`/`timeoutMs?`/`stdin?`）；`ShellExecSpec`（`types.ts:86`）字段必填（`workdir: string`/`timeoutMs: number`/`stdoutMaxBytes: number`）。defaulting/capping 集中在一个命名步骤，`run()`/`start()` 只接收 fully-resolved spec，永不 `request.workdir ?? defaultDir`。`SandboxBashExecutor.resolve` 额外 stamp `sandboxPolicy`（`bash-sandbox/src/index.ts:84`）。这防跨包边界隐式默认导致 provider 间行为漂移，让 caps/guards 可见可测。

### sandbox confinement

`LocalSandboxProvider.confine(argv, policy): ConfinedArgv`（`sandbox-local/src/index.ts:316`）返回 `{argv: [...runnerArgv, '--', ...argv], enforcement, denialSignatures, runnerFailureRules}`——**不改 argv，只 wrap**。三后端由 `PLATFORM_CHAINS`（`sandbox-local/src/index.ts:159`）按平台选：`linux:[bwrap,landlock]`、`darwin:[seatbelt]`、`win32:[windows-acl]`。profile builder 在 `sandbox-local/src/profiles.ts`：`bwrapProfileArgs`（mount bind）、`landlockProfileArgs`（Landlock grants）、`seatbeltProfileArgs`（SBPL `(deny file-write*)`）。Consumer（bash-sandbox）在 spawn 前调 `ctx.sandbox.confine(['bash','-c',command], policy)`（`bash-sandbox/src/index.ts:177`）。fail-closed：无可用 runner 抛 `SandboxUnavailableError`（`sandbox/src/index.ts:131`），命令绝不 unconfined 运行；`danger-full-access` 模式直接 bypass。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Seam | 每个 capability 一个抽象 `Service` 子类 | ctx key 一实现一 context，重复注册抛错 |
| Adapter | `E2BSubprocessRuntime extends SubprocessRuntime`（`subprocess-e2b:52`）、`fs-e2b` | 把 E2B SDK 适配到 seam contract |
| Provider-registry | `ctx.shell`/`ctx.fs` 单槽 + `inject` 声明 | `SandboxBashExecutor.inject=['subprocess','sandbox','sandboxPolicy']` |
| Policy-interceptor | `fs/write-intent`、`fs/edit-intent` waterfall（`fs/src/index.ts:58,66`） | 注入 observed-state 检查 |
| Sandbox-wrapper | `LocalSandboxProvider.confine` wrap argv | consumer 在 spawn 前调用 |

## 模块间交互

各 capability 是 `core/tools` 的 Consumer 的依赖目标：`tool-bash`/`tool-fs`/`tool-web`/`tool-terminal` `inject=['tools', '<capability>']` 调 `ctx.tools.register` 并在 body 调对应 `ctx.<capability>`。shell 依赖 subprocess（`LocalBashExecutor` 经 `ctx.subprocess.spawn`）；bash-sandbox 依赖 sandbox + subprocess + sandboxPolicy。fs 的 `processPath` 与 subprocess 的 `resolveExecutable` 共享同一 backend 世界。e2b 同时提供 fs-e2b + subprocess-e2b，共享一个 `ctx.e2b.getSandbox()`。

## 扩展方式

- **新增 sandbox backend**：继承 `SandboxProvider`（`sandbox/src/index.ts:158`）实现 `confine`；在 `sandbox-local/src/profiles.ts` 加 profile builder；在 `sandbox-local/src/index.ts` 的 `PLATFORM_CHAINS`（`L159`）+ `runnerArgv`（`L336`）+ `DENIAL_SIGNATURES`（`L205`）+ `RUNNER_FAILURE_RULES`（`L231`）注册。
- **把 execution 指向远程**：`cordis.yml` 加载 `ctx.e2b`（`E2BRuntime`），swap `subprocess-local`→`subprocess-e2b`、`fs-local`→`fs-e2b`；bash/lsp/terminal 经 `ctx.subprocess`/`ctx.fs` 自动跟随。
- **新增 fs policy**：在新 plugin 里注册 `fs/write-intent` 或 `fs/edit-intent` listener（`fs/src/index.ts:58,66`），返回 `FsWriteIntent` 拦截；不改 provider（fs-local/fs-sandbox/fs-e2b 均无需改动）。

## 重要设计决策

为什么一个 swap 搬动整个 execution world：bash-sandbox/lsp-stdio/terminal-bash 全经 `ctx.subprocess` spawn，fs 经 `ctx.fs`，换 subprocess/fs provider + 加载共享 `ctx.e2b`，三者同指远程。解决：避免 per-capability remote fork（不需要 bash-e2b、lsp-e2b 各自实现远程）。代码：`e2b/src/index.ts`（共享 handle），`subprocess-e2b/src/index.ts:52` extends 同一抽象。为什么 sandbox 是 seam 不是硬编码：`SandboxProvider` 抽象，consumer 调 `ctx.sandbox.confine()`，允许 per-platform 后端 + operator `runnerCommand` override + `danger-full-access` bypass，且 bash/fs 共用同一 `ctx.sandboxPolicy` 保证不同 capability 不指向不同 root。为什么 request/spec 分离：`resolve()` 是显式 defaulting 边界，`run()` 不做 `?? default`，防止跨 provider 默认值漂移，caps/guards 集中可见可测。
