---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "统一 RPC 层"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "RPC", "Zod", "Electron IPC"]
description: "Orca 的统一 RPC 层：590 个 defineMethod、四类客户端共享一个 RpcDispatcher、字节级+类型级双 drift gate 的契约目录、移动端默认拒绝 allowlist 与 E2EE 传输。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

Orca 有四类客户端——桌面 renderer、`orca` CLI、headless/remote 客户端、移动 app——它们**版本独立漂移**（桌面、server、CLI、mobile 各自更新，混合版本是常态）。统一 RPC 层的意义在于：鉴权、参数校验、错误映射、协议兼容只写一份。它横跨 `src/main/ipc/`（814 个 `ipcMain.handle` 文件的桌面高频专用通道）、`src/main/runtime/rpc/`（dispatcher 与 590 个方法定义）、`src/main/runtime/runtime-rpc/`（WebSocket/Unix socket 传输与配对）、`src/preload/`（contextBridge）与 `src/shared/rpc-contract/`（参数契约目录）。

注意 Orca 是**双通道并行**：IPC 层（`ipc/filesystem/filesystem-git-status-handlers.ts` 这类直接调服务的 handler）是"渲染进程专用高频通道"，RPC 层是"runtime 统一业务面"——后者同时服务桌面（`runtime:call`）、CLI（Unix socket）、headless/remote（WebSocket）、移动（E2EE WebSocket）。

## 模块架构

核心是三个原语 + 一个目录 + 两种传输：

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `defineMethod()` | `rpc/core.ts` | 定义一个类型化方法（名字 literal + zod schema + handler） |
| `RpcDispatcher` | `rpc/dispatcher.ts` | 查 registry → fence → parse → invoke → 信封 |
| `RpcContext` | `rpc/core.ts:64` | handler 第二参数（约 25 个字段，几乎每行带 `// Why:` 注释） |
| 契约目录 | `shared/rpc-contract/rpc-params-catalog.generated.ts` | 方法名 → shared schema 的生成物映射 |
| `ALL_RPC_METHODS` | `rpc/methods/index.ts` | 95 个 `*_METHODS` 数组拼合的平铺清单 |
| `RuntimeRpcLifecycle` | `runtime-rpc/runtime-rpc-lifecycle.ts` | 传输层（继承 WebSocket dispatch / request admission） |

`methods/index.ts` 的注释自陈设计意图："a flat manifest keeps registration order explicit and provides one grep-point for 'what methods does the RPC server expose?' — useful when **auditing the security boundary**"。

## 调用链路

![RPC 分发链路](/vibe-reading/images/articles/orca-internals/rpc-dispatch.svg)

桌面链路：renderer 调 `window.api.runtime.call({method: 'git.status', params})` → preload 的 `runtimeApi.call` 走 `ipcRenderer.invoke('runtime:call')` → `src/main/ipc/runtime.ts` 的 handler 先校验 `event.senderFrame === event.sender.mainFrame`（防 iframe 伪造），然后 `new RpcDispatcher({runtime, methods: ALL_RPC_METHODS}).dispatch(...)`——桌面 renderer 的 `authToken: 'desktop-ipc'`、`clientKind: 'runtime'`，并硬编码注入一组 desktop renderer 的 `clientCapabilities`。

移动链路多三道门：E2EE 帧经 `MobileSocketWiring` 解密 → `deviceRegistry.validateToken()` 验证已配对设备 → **`device.scope === 'mobile' && !MOBILE_RPC_METHOD_ALLOWLIST.has(request.method)` 直接 `forbidden`**（`runtime-rpc-websocket-dispatch.ts:76-87`）→ 长轮询并发预算（`classifyRuntimeLongPoll` + `admitLongPoll`，防手机端轮询打爆 runtime）→ 才进同一个 dispatcher。

```ts title="src/main/runtime/rpc/dispatcher.ts（dispatch 骨架）"
async dispatch(request: RpcRequest, options?: DispatchCallOptions): Promise<RpcResponse> {
  const method = this.registry.get(request.method)
  if (!method) return errorResponse(request.id, meta, 'method_not_found', ...)
  const migrationFence = orchestrationMigrationFence(request, meta)  // 契约围栏
  if (migrationFence) return migrationFence
  const parsedParams = parseRpcRequestParams(request, method, meta)  // zod 校验
  if (parsedParams.error) return parsedParams.error
  if (isStreamingMethod(method)) return errorResponse(..., 'method_not_supported', ...)
  const result = await invokeDispatcherUnaryMethod({ runtime, request, method, params, context, ... })
  return successResponse(request.id, meta, result)   // 信封带 _meta.runtimeId
}
```

流式方法（`defineStreamingMethod()`，`core.ts:160`）走 `dispatchStreaming()` 委托 `RpcStreamingDispatcher`，通过 `reply(response)` 回调多次发帧；桌面订阅帧走 `runtime:subscription:<id>` 事件通道。

## 核心实现

### defineMethod 与“类型擦除只发生一次”

```ts title="src/main/runtime/rpc/core.ts"
export function defineMethod<TName extends string, TSchema extends ZodType | null, TResult>(
  spec: RpcTypedMethod<TName, TSchema, TResult>
): RpcTypedMethod<TName, TSchema, TResult>
```

`RpcTypedMethod` 是"作者视角"——literal 方法名、params schema、producer result 全部保留在类型里。存储进 registry 前由 `eraseRpcMethods()`（`core.ts:214-227`）做一次降级到 `RpcMethod`（handler 参数 `unknown`）。注释明确写了为什么必须显式擦除：contravariance 使得赋值无法绕过，而 dispatcher 只会用"已 parse 过的 unknown"调用 handler——**调用侧永远拿到的都是 parse 后的类型安全值**。`buildRegistry()`（`core.ts:235`）构建 `Map<string, RpcAnyMethod>`，重复名直接 `throw duplicate_rpc_method`。

`RpcContext` 约定 handler 的运行环境：`signal`（客户端断开即中止 long-poll）、`connectionId`（per-socket 清理）、`clientKind: 'mobile' | 'runtime'`（触发移动端 payload 截断 diet）、`clientCapabilities`/`updateClientCapabilities`（**能力协商绑定在已认证 socket 上，绝不信任请求体自报**）、`sendBinary`（终端二进制帧绕过 JSON-RPC）。

### 契约目录的三道防漂移机制

`rpc-params-catalog.generated.ts`（1100+ 行）把每个方法名映射到 shared zod schema。它由 `config/scripts/generate-rpc-params-catalog.mjs` 生成，防漂移靠三道机制：

1. **读回 registry 而非手写清单**——esbuild 把 `methods/index.ts` 与所有 shared schema 打进一个 bundle，用"schema 对象引用"（而非结构）从 `method.params` 反查它来自哪个模块哪个 export。注释点明理由："two structurally identical schemas are still two different wire contracts"；
2. **字节级 drift gate**——`pnpm lint` 里的 `verify:rpc-params-catalog` 以 `--check` 模式比对生成文件与磁盘字节，不一致 exit 1；生成物还必须经 oxfmt（"the drift gate compares bytes, so the generator must emit exactly what the formatter would produce"）；
3. **类型级 parity gate**——`rpc-params-type-parity.ts` 用条件类型逐方法检查 `Parameters<Method['handler']>[0]` 与 `RpcParams<Method['name']>` 双向 assignable，mismatch 编译失败。

目录里还有 `RPC_METHODS_WITHOUT_SHARED_PARAMS` 显式列出无法进 shared 契约的方法（如 `emulator.install`、`orchestration.send`）——"gap visible instead of absent"。

### mobile allowlist：默认拒绝的攻击面收敛

`runtime-rpc/runtime-rpc-mobile-method-allowlist.ts` 是一个 294 行的 `Set`（约 300 个方法）。为什么存在：手机是**经公网 relay、E2EE 进来的攻击面最大的客户端**，只放行只读 + 明确审过的移动场景方法（git 读写、github/gitlab/linear 操作、terminal 控制、`orchestration.workerTerminalUserInput`）。未列方法即使 dispatcher 认识也返回 `forbidden`——`runtime.clientCapabilities.update` 也只允许 mobile scope 在已认证 socket 上调用（`websocket-dispatch.ts:144-149`），防止请求体伪造能力。

### wire 兼容性策略

`shared/protocol-version.ts`（`RUNTIME_PROTOCOL_VERSION = 3`，兼容窗口 `[2, 3]`，60+ 个 `*_RUNTIME_CAPABILITY` 常量）给出明确规则：删方法/改字段语义/改加密与终端帧 framing/auth 必须 bump 版本；新增方法、可选字段、可忽略事件不 bump。**新 stream opcode 必须 capability-negotiated**——`shared/terminal-stream-protocol.ts:32` 注释："Negotiated per stream; older hosts reject unknown opcodes, so clients send only after capability confirmation"，因为二进制帧没有版本信封，老 host 静默丢弃未知 opcode。

### 为什么 E2EE 而不是 TLS

`runtime-rpc-lifecycle.ts:80`："WebSocket uses per-device tokens + E2EE (tweetnacl) instead of TLS since React Native can't pin self-signed certs"——移动端安全模型的根因性约束。桌面 renderer 则用假 token `'desktop-ipc'`（信任来自 Electron frame 校验），remote 用 device token；`fingerprintAuthenticatedPairingCredential(token)` 把调用者身份钉进 federation 而不向 handler 暴露原始 token。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 生成式契约目录 | `rpc-params-catalog.generated.ts` + 生成脚本 | 590 方法的手写清单必然漂移，生成+对账才可信 |
| Registry + 平铺 manifest | `rpc/core.ts` + `methods/index.ts` | 安全边界审计需要单一 grep 点 |
| Allowlist（default-deny） | `runtime-rpc-mobile-method-allowlist.ts` | 攻击面最大的客户端获得最窄方法面 |
| Capability negotiation | `shared/protocol-version.ts` | 混合版本是常态，能力在认证 socket 上协商 |
| Transport 抽象 | `rpc/transport.ts`（22 行接口） | 同一 dispatcher 挂 Unix socket / WebSocket / relay 三种传输 |

## 模块间交互

IPC 层与 RPC 层的分工：`ipc/` 的 814 个文件里，多数是"高频桌面专用通道"直接调 runtime/git 服务；`ipc/runtime.ts` 是通用入口，把 `runtime:call`/`runtime:subscribe` 桥到 dispatcher。RPC handler 只是薄壳——`(params, {runtime}) => runtime.xxx(...)`，业务全部在 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime) 的方法面。CLI 侧（见 [CLI 与工具生态](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/12-cli-ecosystem)）从 `orca-runtime.json` 发现端点，一次请求一个 Unix socket 连接，服务端穿插 `{"_keepalive":true}` 帧支撑 10 分钟长轮询。移动端经 [Relay 云中继](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/10-relay-cloud) 的 splice 帧到达。

## 扩展方式

新增 `foo.bar` 方法的完整清单：

1. `src/shared/rpc-contract/foo-params.ts` 写 zod schema（无参数则 `params: null`）；
2. `src/main/runtime/rpc/methods/foo.ts` 用 `defineMethod` 定义 handler；
3. `rpc/methods/index.ts` 把 `FOO_METHODS` 加进 `ALL_RPC_METHODS`；
4. 跑 `pnpm run generate:rpc-params-catalog` 重新生成目录（否则 lint 的 drift gate 挂掉）；
5. 手机可用则加进 `MOBILE_RPC_METHOD_ALLOWLIST`；
6. 需要新状态时在 `OrcaRuntimeService` 加 service 方法——handler 不写业务；
7. 只有桌面 UI 高频调用才考虑 preload 专用 bridge，否则直接 `window.api.runtime.call`。
