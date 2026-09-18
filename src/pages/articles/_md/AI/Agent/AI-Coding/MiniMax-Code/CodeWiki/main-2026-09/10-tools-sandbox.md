---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "工具体系与沙箱"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "沙箱", "seatbelt", "CDP", "lease broker", "Matrix"]
description: "agent-tools + browser-core + mcode-tools-host + sandbox 解读——本地工具包装 pi 增值层、cloud 走 Matrix 网关三段式、lease broker 给子进程发短效 token（capability 文件 + unix socket）、bash 经 seatbelt/SRT 沙箱、CDPHelper 三源快照"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

工具体系由四个包加一个 service 组成：`agent-tools/`（~2.3 万行，工具定义与注册）、`browser-core/`（~1.3 万行，CDP 浏览器控制）、`mcode-tools-host/`（lease broker 宿主）、`service/sandbox/` + `third_party/sandbox-runtime`（沙箱执行）。它们共同回答一个问题：**模型决定"调什么工具"之后，本地如何安全地"执行它"**——凭证隔离（子进程不持 Refresh Token）、路径隔离（沙箱）、能力隔离（browser 的快照锚定）。

## 模块架构

![lease broker 与沙箱执行](/vibe-reading/images/articles/minimax-code/tools-lease.svg)

工具面分三路：**本地工具**（read/write/edit/bash，包装 pi coding-agent 的实现再加增值层）、**cloud 工具**（Matrix 网关 18 个工具，可内嵌也可作为 stdio MCP server 形态被拉起）、**browser 工具**（CDPHelper 驱动）。装配点：`buildLocalToolRegistry()`（agent-tools/src/desktop/index.ts:118）与 `buildMatrixTools()`（cloud/matrix-tools/index.ts:178）。沙箱是替换式注入：`LocalBashTool` 在 `sandboxOperationsFactory` 存在时用 pi 的 `createBashTool(workspaceRoot, {operations: factory.create({...})})` 替换默认实现。

## 调用链路

三条执行链：

```
cloud（如 matrix_image_synthesize）：
  tool call → MatrixImageSynthesizeTool.execute（tools/image-synthesize.ts:72）
  ① uploadInputFiles：workspace 文件经 ossMediaClient PUT 到 OSS → input_urls
  ② callMatrixToolRaw：DesktopMatrixClient.postGatewayJson
     path 重写 /matrix/api/v1/mcp/ → 本地 /mavis/api/v1/mcp/；Bearer（managed 或 lease token）
     Undici Agent dispatcher 放宽 headers/body timeout
  ③ downloadOutputFile：path-guard 边界校验后落盘 + registerAigcIfPresent（v5 水印 OSS key 对）
browser：
  buildLocalBrowserRuntimeTools（desktop/local-browser.ts:142）compact/full 两种暴露形态
  → BrowserCoreSession 持 CDPHelper → inspect 三源合并（DOMSnapshot.captureSnapshot
    + DOM.getDocument + Accessibility.getFullAXTree，文件头注释明示遵循 browser-use 设计）
  → 动作：snapshot ref → ElementMapManager 解析 backendNodeId → CDP 派发
sandbox bash：
  LocalBashTool.execute（local-pi-tools.ts:383）→ createSandboxBashOperationsFactory（deferred-port.ts:69）
  → 每次 spawn 前 LocalSandboxService.beginInvocation()
     #admitInvocation（local-sandbox-service.ts:352）：backend capability 查询 → srtCommandId
     → 调用上下文（session 临时目录 · git safeDirectories · filesystem 规则）
  → lease.backend.wrap()（macOS 即 srt-macos.ts 的 SandboxManager.wrapWithSandbox
     seatbelt profile 重写命令 + 注入 GIT_TEMPLATE_DIR / MAVIS_TRASH_FORCE_MV）
  → nativeOperations.exec(wrapped.command) → finally lease.finish() 释放引用计数
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `execute()` in tools/image-synthesize.ts:72 | cloud 工具三段式 | 上传/调用/下载路径分离 |
| `execute()` in desktop/local-pi-tools.ts:383 | bash 执行 | 前台/后台双模式，软 yield 自动晋升后台 |
| `execute()` in local-pi-tools.ts:105 | read 执行 | 设备/FIFO/二进制/PDF/notebook/video 前置 guard 链 |
| `beginInvocation()` in local-sandbox-service.ts | 沙箱调用租约 | 引用计数 + 观测 trace |
| `ensureAttached()` in browser-core/src/cdp-helper.ts:105 | debugger 附加 | `recoverDebuggerAfterInterruption` 中断恢复 |
| `waitForDOMStable()` in cdp-helper.ts | DOM 稳定等待 | isDirty 去抖，变化后才重抓快照 |
| `startMcodeToolsAuthLeaseBroker()` in mcode-tools-host/src/lease-broker.ts:42 | lease 服务 | 43 字符 capability + 0600 原子写 |

</details>

## 核心实现

### 短时 lease token：宿主是唯一凭据持有者

mcode-tools 子进程（独立 CLI，甚至可能脱离宿主运行）不能持有 Refresh Token——README 明言"宿主是唯一 credential-store/Refresh Token 拥有者"。机制：broker 生成 43 字符 capability（base64url 32 字节）原子写 `run/mcode-auth-lease-v1.cap`（0600），监听 unix socket（`run/mcode-auth-lease-v1.sock`，Windows 命名管道按 dataDir sha256 前 16 hex）；协议 v1 三方法 status/lease/unauthorized，4 字节长度前缀 JSON 帧（≤64KB），`timingSafeEqual` 校验 capability，连接数 32 / 请求数 256 上限。launcher 渲染时 **unset 全部继承的 API/auth/沙箱 env**，只注入宿主控制的 broker 坐标——防恶意环境变量把子进程指向假端点或解除沙箱。generation 单调递增 + epoch：宿主登出/刷新即 `invalidate()`，旧 lease 全部 AUTH_REQUIRED；`acquireLease` 有缓存 + in-flight 去重（single-flight）。

### mcode-tools bundle 与 sandbox fork 的出处

mcode-tools 是 build 时下载的 integrity 校验资源包：`manifest.json` 声明 entry 与逐文件 SHA-256，`validateMcodeToolsResource()`（resource.ts:53）校验 buildEnv/包名/协议版本兼容、拒符号链接。sandbox-runtime fork 自 **anthropic-experimental/sandbox-runtime v0.0.74**（Anthropic 实验性 Claude Code 沙箱，`upstream.json` 溯源），vendored 版本 `0.0.74-mcode.2`。fork 保留的改动（README）：SecurityServer 控制、独立 unlink scope、deny-first 网络、每次调用的 sanitized baseEnv、caller 提供临时目录、Node fs 替代 `which`（省 1s 进程启动超时）。两条刻在注释里的安全判断值得记录：**`.git/config` 恒可写**（init/clone/worktree 都需要，且任何可写 workspace 的模式下 agent 本就能写任意可执行文件，禁它只会破坏 Git 正常用法）；**trash 强制 mv 进笼子**（`MAVIS_TRASH_FORCE_MV`——桌面 trash 走 Finder Apple Events 在另一个非沙箱进程执行 unlink，内核永远不会评估 `unlinkAllowOnly`，delete_guard 会静默失效）。

### 本地工具：pi 之上的增值层

read/write/edit/bash **不在 mcode 原生实现**——包装 `@earendil-works/pi-coding-agent` 的 `createReadTool/createWriteTool/createEditTool/createBashTool`，mcode 加价值层：PDF/notebook/视频读取分发（`LocalReadTool.execute` 前置 guard 链）、BOM/编码保持的 write capture、行号前缀重试 edit、env 双层消毒（`sanitizeBashSubprocessEnv`）、输出截断与 continuation hint、沙箱 operations 替换。`@bindTool(def)` 装饰器把 ToolDef schema 与 impl 类静态关联，`toRuntimeTool()` 统一转 `RuntimeTool`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Port/Adapter 接口倒置 | `LocalSandboxBashOperationsFactory`（agent-tools/src/desktop/types.ts:309） | agent-tools 不依赖 sandbox 实现 |
| Deferred/两阶段绑定 | `createDeferredLocalSandboxBashOperationsFactory`（deferred-port.ts:20） | V1 工具图先建、V2 service 就绪后 bind，未绑定且启用时 fail-closed |
| Capability 探询 | `adapter.getCapabilities?.()` 决定 browser 工具形态；`assertSandboxBackendCapabilities()` | backend 能力决定暴露形态 |
| 单飞去重 | lease broker 的 inFlight promise（lease-broker.ts:94-123） | 并发 lease 请求合并 |
| 装饰器绑定 | `@bindTool(LocalReadToolDef)`（local-pi-tools.ts:94） | schema 与实现静态关联 |

## 模块间交互

`@mavis/oauth-lease-protocol` 提供协议常量与 socket 端点解析，mcode-tools-host 是服务端消费方；tui 侧 `prepareTuiMcodeToolsIntegration()` 起进程内 broker。MCP 形态下同一批 Matrix 工具由 `matrix-mcp-server.ts:159` 在 stdio 子进程内执行（`local-runtime-v2/src/service/mcp/runtime/builtin-matrix.ts` 拉起）。

## 扩展方式

- **新增 cloud 工具**：`cloud/matrix-tools/tool-defs.ts` 加 `MatrixXxxToolDef`（名称须与 McpService thrift 声明顺序一致，见 index.ts:127 注释）→ `tools/` 新建工具类（照 image-synthesize.ts 三段式）→ `buildMatrixTools()` 注册 + `MATRIX_TOOL_NAMES` 插入。
- **新增沙箱规则**：macOS 改 `service/sandbox/backend/srt-macos.ts` 的 `runtimeConfig()`（denyRead/denyWrite/unlinkAllowOnly 集合）或 `effective-policy.ts`；新平台则新增 backend 并注册 descriptor（仿 `initialize.ts:46`），`selector.ts` 按 priority 自动选取。
- **新增本地工具**：`desktop/` 新建 `local-xxx.ts`（`@bindTool` + `ToolImpl`）→ `buildLocalToolRegistry()` 挂入（adapter 可选则条件注册）。
