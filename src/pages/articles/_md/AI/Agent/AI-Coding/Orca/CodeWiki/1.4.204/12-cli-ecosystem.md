---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "CLI 与工具生态"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "CLI", "Skills", "Computer Use"]
description: "orca CLI 的懒加载 handler manifest、skills 的双 manifest bundle 与中立 canonical root、computer use 独立 sidecar 的 EDR/TCC 理由。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

"Agents drive Orca too"是这个模块的使命：`orca` CLI（`bin.orca = ./out/cli/index.js`，~4.8 万行，160+ 子命令）让 agent 自己开 worktree、截图、填表单——形成 agentic 闭环。附带两个生态子系统：**Skills**（`src/main/skills/`，34k 行——跨 agent 的技能发现/打包/安装/分享）与 **Computer Use**（`src/main/computer/`——agent 操控桌面应用的独立 sidecar）。

## 模块架构

![CLI 与工具生态](/vibe-reading/images/articles/orca-internals/cli-ecosystem.svg)

CLI 是三层注册：`CommandSpec`（`src/cli/command-spec.ts`，19 行纯类型）→ specs 定义（`src/cli/specs/`）→ `HandlerGroup` manifest（`handler-group-manifest.ts`，24 组懒加载）。skills 是"发现 → 打包 → 安装"三段。computer use 是进程隔离的 sidecar。

## 调用链路

**orca 命令连上运行中的 Orca**：

```text
main()（src/cli/index.ts）
  → parseArgs(argv, COMMAND_PATHS) + validateCommandAndFlags
     # 语法/flag 错误先于 runtime 查找报出
  → loadRuntimeClientClass() 懒加载 RuntimeClient
     # 注释：RuntimeClient 图是 CLI 199 个急切模块中的 153 个
     # （zod/ws/tweetnacl）——help 和 flag 错误路径不付这笔钱
  → RuntimeClient 读 userData 下的 orca-runtime.json（getRuntimeMetadataPath）
     # RuntimeMetadata {runtimeId, pid, transports, authToken}
  → sendRequest()：findTransport('unix','named-pipe') → net.createConnection
     # 一次请求一个连接；写一行 JSON {id, authToken, method, params}
     # 服务端可穿插 {"_keepalive":true} 帧刷新客户端超时（支撑 10 分钟长轮询）
     # 校验响应 id 与 _meta.runtimeId（运行中 Orca 换代即拒）
  → Orca 未运行：launchOrcaApp() detached 拉起 Electron（macOS 用 open 走 bundle 生命周期）
     # 远端走 websocket-transport + --pairing-code；headless 场景 serveOrcaApp()
     # spawn orca --serve（含 ShipIt 自更新监督 serve-update-supervisor.ts）
```

**skill 从发现到安装**：

```text
发现 discoverSkills()：buildSkillDiscoverySources()
  = 17 个固定 home roots（~/.codex/skills、~/.claude/skills、~/.agents/skills …）
  + 每个本地 repo/cwd 7 个 root + Claude plugin cache
  → SkillScanCoalescer LRU（1024 项，TTL 10s）合并多 pane 重复扫描
  → 根不可达时降级：serve 5min 内最后已知结果（避免卡死 root 把已装 skill 显示成未安装）

分享 createSkillBundleArchive()：
  → 并发 4 观察各源（逐文件 sha256/identity sha256/classification）
  → mkdtemp 暂存 → 【staging 后重观察比对】（防打包期间源被改）
  → 写双 manifest + deterministic gzip 到 .pid.uuid.tmp
  → 【自解压验证】extractSkillBundleArchive（校验 digest）
  → Windows-retry rename 上位
  → SkillCloudService.createShare() → orca://skill-share/<id>

安装 SkillShareDeepLinkState.capture(argv)（deep link 校验协议 URL）
  → 领取 download-grant → installSkillBundle()
  → beginSkillExtractionRecovery（崩溃恢复 journal）
  → 按 selectedSkillIds 过滤 → 逐 skill 冲突预检
     （missing/unchanged/clean-update/modified/unowned/external-link/name-collision）
  → installSharedExtractedSkill
```

方法速查表：

<details>
<summary>CLI/skills 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `dispatch()` in `src/cli/dispatch.ts` | 路由分发 | `buildRoutes()` 摊平 Map，重复注册 throw；只加载命中组 |
| `specPaths(spec)` | 展开 path+aliases | 惯用同义动词免重复 spec |
| `buildSkillDiscoverySources()` | 构造扫描 root 集 | 17 固定 + 7/repo 按公式定容 |
| `createSkillBundleArchive()` | 打包 | 写后自解压验证，"交付物不经验证不算存在" |
| `dispatch()` in `sidecar-entry.ts` | sidecar 命令分发 | 请求串行 + 每请求 id + 超时即杀进程重启 |

</details>

## 核心实现

### 懒加载分组：瘦客户端的量化收益

`HandlerGroup = { name, keys, load }`——keys 是急切声明的字符串数组（构建路由表**不加载任何组**），`load` 是动态 import。`dispatch.ts` 注释明说是让"每次调用跳过 24 个未命中组的传递模块图"；`index.ts` 注释量化了 RuntimeClient 图占 153/199 个急切模块。双注册面（specs 与 handlers）不允许漂移：`registry-parity.ts`、`cli-command-name-parity.test.ts`、`main-module-bundle-parity.test.ts` 三重守卫。

### 双 manifest：一个包两个生态

`createSkillBundleArchive` 的 tar.gz 同时装两份 manifest：给其他 agent 生态看的 agent-plugin manifest（`AGENT_PLUGIN_MANIFEST_PATH`）+ Orca 自己的 bundle manifest（`ORCA_SKILL_BUNDLE_MANIFEST_PATH`，含 digest/校验）。why：(a) 同一个包既是 Claude 插件生态认的 plugin 又是 Orca 认的 bundle；(b) `selectedSkillIds` 允许从 bundle 里挑着装，per-skill digest 支撑细粒度冲突决策（`keep-local`/`replace-unmodified`/`replace-and-discard-local`）；(c) 逐文件 sha256 + bundleDigest + 自解压回环，安装端解压即验。manifest 变化由 `verify:skill-bundle-manifest` 的生成物对账兜底。

**canonical root 是 `~/.agents/skills` 而非某个 agent 的目录**：agent 生态是多元的，选中立目录避免 Orca"寄生"在单一 agent 的家目录里；其他家目录（`~/.claude/skills` 等）降级为 placement 副本，且**只写检测到该 provider 实际存在的机器**（`readsCanonicalRoot` 的 provider 不复制）。

### computer sidecar：三个独立的理由

`sidecar-entry.ts`（130 行）是纯 Node 独立进程（`ELECTRON_RUN_AS_NODE` fork，绕过 Electron 的 asar require 集成；`app.asar.unpacked`）。三个理由都有代码注释背书：

1. **UI Automation 调用不可取消地挂死**，唯一回收手段是杀进程（`desktop-script-runtime-host.ts` "Why kill rather than wait"）——隔离让主进程永远活着，`sidecar-client.ts` 超时直接 `shutdown()` 重启；
2. **安全合规**：Windows 上每次 click 一个 powershell.exe 会重复 emit 内联 `Add-Type` P/Invoke，被 Defender for Endpoint 标记为可疑 MSIL——常驻 `-Serve` 进程把短命 PID 风暴折叠成一个；
3. **TCC 归因**：macOS native helper 经 LaunchServices 启动使 TCC 正确评估辅助功能授权（`macos-native-provider-transport.ts` L100）。

### agent 反向驱动的证据

flag 校验器与 agent 自省共享同一集合：`args.ts` 的 `effectiveAllowedFlags` 注释 "validation and **agent discovery** must expose the same effective flag set"；专门的 `agent-context` introspection 命令（`handlers/introspection.ts`）与全局 `--json` flag 服务于 agent 在终端里脚本化 Orca 的场景。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Handler-group manifest + 懒加载路由 | `handler-group-manifest.ts` + `dispatch.ts` | 冷启动成本与命令面解耦 |
| Spec↔handler parity 守卫 | `registry-parity.ts` 等 | 双注册面不漂移 |
| 写前验证回环 | `createSkillBundleArchiveUnobserved` | 交付物经过自身读取器验证 |
| 崩溃恢复 journal | `skill-extraction-recovery.ts` 等 | 多步文件事务可续/回滚 |
| 进程隔离 sidecar | `sidecar-entry.ts` / `desktop-script-runtime-host.ts` | 挂死可杀、EDR/TCC 友好 |

## 模块间交互

与 [统一 RPC 层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/02-rpc)：每个 CLI 命令的 handler 用 `ctx.client` 发 RPC（`ssh-remote-orca-cli.ts:107` 是 CLI 侧的 RPC 消费者）；SSH relay 桥在 Orca 主机上执行 CLI 但用 `ORCA_CLI_CWD` 传远端 cwd。与 [主进程启动与生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/01-startup)：`orca-runtime.json` 与 agent-hooks 的 `endpoint.env` 是单实例锁存在的直接原因。与 [终端守护进程](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/04-terminal-daemon)：`orca serve` 的 `build:orcad` 同一构建体系。skills 写入边界：只权威写 `~/.agents/skills`，WSL 场景经 `skill-wsl-*.ts` 在 distro 内重放同样语义。

## 扩展方式

**新增 orca 子命令**：`src/cli/specs/<组>.ts` 加 `CommandSpec` → `src/cli/handlers/<组>.ts` 加 handler → `handler-group-manifest.ts` 对应组 keys 加名（漏改被 parity 测试当场拦下）→ 服务端 `rpc/methods/` 加方法（catalog 会要求同步，见[统一 RPC 层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/02-rpc)）。

**新增 skill 来源**：`skill-discovery-sources.ts` 的 `buildSkillDiscoverySources()` 加 source；可安装则加 `SKILL_INSTALL_PROVIDERS`（`skill-install-providers.ts`）+ `skill-provider-destinations.ts` 的 destination root；bundled guides 变化重跑 `generate:skill-bundle-manifest`。

**新增 computer 动作**：`sidecar-entry.ts` 的 `dispatch()` switch 加 case + provider 接口方法（`macos-native-provider-client.ts` / `desktop-script-provider-client.ts` 各自实现）+ CLI 侧 `handlers/computer.ts` 与 flag 校验（`computer-action-flags.ts`）。
