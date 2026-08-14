---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "装配与启动"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Profile", "Bundle", "Boot", "Cordis"]
description: "dsh 如何用 profile/bundle/patch 分层组合把分散插件装成一棵可 boot 的树，以及 host/client 双 face 编译。"
readingTime: "14 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

`packages/boot/app-boot`、`packages/bundle/*`、`packages/preset`、`apps/cli`、`apps/web` 这组包负责把分散的插件组合成一棵可 boot 的插件树。dsh 的核心设计是"换配置"替代"改代码"——一个运行中的 `dsh` 是从有序 layers 在 boot 时组合的 plugin tree，任意一行 config 都可被自己的 patch 替换。这层独立是因为它把"产品形态"从代码里抽出来：web app、headless runner、自定义 profile 之间的差异只是 patch layers 不同，不重写代码。

## 模块架构

```
profile ($DSH_HOME/profiles/<name>)
  ├─ package.json { dsh.profile: { bundles: [...] } }   # 列出它 stack 的 bundles
  ├─ cordis.patch.yml                                    # 用户层 patch
  └─ out-of-tree plugins
bundle (npm 包, package.json { dsh: { bundle: { patch: "./cordis.patch.yml" } } })
  └─ cordis.patch.yml  ──按 id target 整行替换或 insert 新行──▶ config rows
layer apply 顺序：
  bundlePatches (按 dsh.profile.bundles 顺序) → profile.patches → homePatches ($DSH_HOME) → overlays (--patch)
boot():
  new Context() → ctx.plugin(Loader) → prepare → mountRootInclude → loader.await() → assertEntriesActivated
two faces:
  host face (tsconfig.host.json)  ← Node 侧 plugin tree (dsh bin)
  client face (tsconfig.client.json) ← 浏览器 shell (apps/web)
```

四种首层抽象（`packages/boot/app-boot/src/profile.ts`）：**profile** 持 `package.json`（`dsh.profile` manifest）+ 用户 `cordis.patch.yml`，`PROFILE_TEMPLATES = { web: ['dsh-base','dsh-web-app'], headless: ['dsh-base','dsh-headless'] }`（`profile.ts:114`）；**bundle** 是 npm 包，manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；**patch** 是顶层 YAML 数组（`PatchOptions`），按 `id` target 整行替换 `config` 或 `insert` 新行，**不 deep-merge**——override 必须重述保留字段；**layer 顺序**：`bundlePatches` → `profile.patches` → `homePatches` → `overlays`。

## 调用链路

```
bin.ts:27  parseDshArgs(argv, version)                    # args.ts 分派 profile/plugin/dump-config
  ├─ loadLayeredEnv('dsh')                                # inherited > project .env > user .env 快照
  └─ runProfile({environment, profile, patches, args})    # profile-boot.ts:207
     └─ composeProfile(name, patchFiles)                 # profile-boot.ts:142
        ├─ prepareProfile → loadProfile + 重写空 root cordis.yml
        ├─ loadOptionalPatches(homePatchPath())          # home 层
        ├─ loadOverlayPatches(--patch 文件)               # overlay 层
        └─ composeEntries([bundlePatches, profile.patches, homePatches, overlays])  # profile.ts:413
     └─ installFailLoud(NAME, process, release)          # 转 unhandled rejection 为 stderr + exit(1)
     └─ boot(NAME, rootConfig, allPatches, prepare)      # index.ts:757
        ├─ new Context(); ctx.provide('dshHomePath', dshHomePath)
        ├─ ctx.plugin(Loader)                             # 装 Cordis Loader 服务
        ├─ prepare(hostCtx)                               # 注入 LaunchEnvironmentSnapshot + provideCmdline(args, exit)
        ├─ mountRootInclude(ctx, config, patches)         # index.ts:486, 注册 cordis:include + cordis:group builtin
        ├─ ctx.get('loader').await()                      # 并发 mount 全树直至 settle
        └─ assertEntriesActivated(ctx, binName)           # index.ts:692, 审计 fiber 状态
```

之后控制权交给被 mount 的 surface 插件：`web-app` 的 `webStartup` 启 HTTP server；`headless` 的 `headless-runner` 跑一次性 task 后 `ctx.appExit`。`dsh --profile web --dump-config` 走 `dump-config.ts:runDumpConfig` → `renderConfigDump`（`index.ts:379`），用同一 `applyEntryPatches` 离线合成，故输出与 boot 一致。

## 核心实现

### Two Faces（host / client）

构建分两 face（`package.json` `build:lib:host` / `build:lib:client`）：
- **host face**：`tsc -b tsconfig.host.json` + `tsdown --env.DSH_BUILD_FACE host`。产出 Node 侧 Cordis 插件、Loader、agent loop、sandbox 等；Typert generator 仅此阶段运行。
- **client face**：`tsc -b tsconfig.client.json` + `tsdown --env.DSH_BUILD_FACE client`。产出浏览器 bundle（`packages/client/dsh-client-*` React UI、connection RPC）+ 各 client 插件 loader 入口。

为何分：两侧对 Cordis `Context` 同名 key（`sessions`、`loader`…）做 `declare module` merge 但服务实现不同；一个 `ts.Program` 无法同时看到两份 merge（`tsconfig.client.json` 注释、`AGENTS.md:117`）。

### Preset（per-session agent composition）

`packages/preset/agent-presets/`：一个 preset = 一个目录持 `agent.cordis.yml`（plugin row 列表，含 `cordis:group` isolate realm）。roster 把它**每进程 mount 一次**于 standing scope，每个命名它的 session 通过 `dsh-scope` parent chain 加入（`agent → preset → global`，nearest shadow farthest）。tools/prompt sections 落在 preset 层，故多 session 共享一份实例、状态按 Session/Agent key 隔离。入口 `ctx.agentPresets.mount(agentCtx, id?)`（只在 agent factory `setup` 钩子调用）。

**与 profile 的区别**：profile 组装**进程级 plugin tree**（注册哪些 service/adapter/registry）；preset 组装**agent-plane 的 tool/prompt 投影**（同一进程树内，不同 agent 看到不同工具集与 persona）。base bundle 的 `tools`/`system-prompt`/`agent-loop` 行是空/默认值，preset 覆盖之。preset 用 `cordis:group` + `isolate: { terminals: true }` 给 service row 私有 realm，避免跨 preset 撞名。

### Fail-loud 与 bounded teardown

`installFailLoud`（`index.ts:609`）转 late unhandled rejection 为一行 stderr + `exit(1)`。`boot()` catch 内 `ctx.fiber.dispose()`，terminal-owning surface 经 `release` 在 exit 前恢复终端。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Layered-composition | `profile.ts` `loadProfile` 按 `dsh.profile.bundles` 顺序叠 | 升级只动 patch 文件 |
| Patch-overlay | `applyEntryPatches`（vendored `cordis-plugin-include`）按 id last-write-wins | `composeEntries` 与 `boot` 用同一调用，dump ≡ mount |
| DI-container (profile as composition root) | `boot()` `new Context()` → `provide` → `ctx.plugin(Loader)` → `prepare` | 插件以 effect 注册 service，unload 回滚 |
| Two-face-build | `tsconfig.host.json`/`tsconfig.client.json` + `DSH_BUILD_FACE` env | 同名 ctx key 两 merge，单 ts.Program 无法并存 |
| Fail-loud + bounded teardown | `installFailLoud` + `ctx.fiber.dispose()` | misconfiguration 失败响亮，exit 前释放终端 |

## 模块间交互

`apps/cli` 的 `bin.ts` 是唯一命令入口，分派到 `profile-boot.ts`/`plugin.ts`/`dump-config.ts`。`app-boot` 被 cli 调用（`runProfile`→`boot`），内部用 vendored `cordis-plugin-include` 的 `composeEntries`/`applyEntryPatches`。bundle 包（`base`/`web-app`/`headless`）提供 patch layers；preset 提供 per-session composition。`boot()` mount 的 plugin tree 包含 `core/agent-loop`（其 `static inject` 决定 mount 时机）。watchUserPatches × 2（profile patch + home patch）做 HMR 热重载用户层。

## 扩展方式

- **新增一个 profile**：`dsh plugin --profile foo add <pkg>` → `plugin.ts:runPlugin` 调 `initProfile`（`profile.ts:152`）写 `package.json`（`dsh.profile.bundles: DEFAULT_PROFILE_BUNDLES`）+ 空 `cordis.patch.yml` + `pnpm-workspace.yaml`；pnpm 完成后 `reconcilePlugins` 把声明了 `dsh.bundle` 的依赖 append 进 `bundles` 列表。无 shipped template 的名字须先 init。
- **给一个 bundle 加 patch / override**：编辑该 bundle 的 `cordis.patch.yml`（如 `packages/bundle/web-app/cordis.patch.yml`），按 id target 行 restated config；或更上层用 profile/home `cordis.patch.yml` override 而不改 bundle。改完 `dsh --profile web --dump-config` 核验。
- **新增一个 preset**：把现有 preset 目录整体复制到首个 `user` trust root（`ctx.agentPresets.copy(from, id)`），或 shipped 端在 `apps/cli/config/agent-presets/` 下加目录持 `agent.cordis.yml` + `preset.yml`（name/description/order）；`composeProfile` 已把 `SHIPPED_PRESET_ROOT` 注入 `agent-presets` row 的 `roots`。

## 重要设计决策

为什么用 profile/bundle/patch 分层而非硬编码 plugin 列表：architecture.md "Any row it prints can be replaced by a patch of your own"——用户无需 fork 代码即可改任意行 config；bundle 作为"patchable rows 的发行格式"让升级只动 patch 文件。为什么任意 row 可被 patch 替换：patch 按 id 替换**整行 config**而非 deep-merge——避免合并歧义、强制 override 显式重述字段、使 `--dump-config` 输出即权威。代价：override 需重述保留字段（已知限制）。为什么分 host/client 两 face：两侧 Cordis `Context` merge 同 key 不同实现，单 `ts.Program` 不能并存，且浏览器 bundle 需 purity。为什么 root config 每次重写为空：vendored Loader 的 tree write-back 可能把 composed rows 烘焙进 root 文件致下次 boot 重复 insert，root 只作 `baseUrl` 锚点，全部组合由 patch 层提供。
