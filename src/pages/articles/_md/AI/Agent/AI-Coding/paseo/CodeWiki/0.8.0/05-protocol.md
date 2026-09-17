---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "协议与校验"
date: "2026-09-17T23:56:40+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "Zod", "zod-aot", "协议兼容"]
description: "paseo protocol 包——7228 行 messages.ts 的 discriminatedUnion 信封、zod-aot AOT 校验（Hermes 上 10.9ms→2.5ms）带两个编译器补丁、append-only 协议契约与 COMPAT 截止日治理。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/protocol/`（~25,000 行）是 client 与 daemon 之间 WebSocket 协议的**单一真源**：全部消息的 zod schema、派生的 TypeScript 类型（`z.infer`）、以及为移动端性能生成的 AOT 校验代码。App、CLI、Desktop、SDK、server 五方都 import 这一个包——协议演进（新旧版本任意组合共存于 wild）的全部成本被压进这一个包里。

它解决三个问题：协议怎么描述（schema 组织）、校验怎么快（zod-aot）、新旧怎么共存（append-only 契约 + capability gate）。

## 模块架构

```
packages/protocol/src/
├── messages.ts（7228 行）              # 核心：全部 WS 消息 schema + envelope
├── 常量/纯类型模块                      # agent-lifecycle.ts / agent-labels.ts /
│                                       # client-capabilities.ts（CLIENT_CAPS）…
├── 域 schema 子目录                     # chat/ schedule/ loop/ search/
│                                       # browser-automation/ binary-frames/
├── provider-manifest.ts                # AGENT_PROVIDER_DEFINITIONS（03 篇）
├── forge-manifest.ts / check-traits.ts # 11 篇的 forge 注册表
├── validation/ws-outbound.ts           # 运行时校验边界（safeParse）
└── generated/validation/ws-outbound.aot.ts  # 生成物（gitignore）

codegen/ws-outbound.compile.ts          # 4 行：compile(WSOutboundMessageSchema)
scripts/generate-validation-aot.mjs     # 生成器（含两个编译器补丁）
tests/validation/ws-outbound.test.ts    # 补丁回归测试（8 case）
```

## 调用链路

**出站消息的校验链**（daemon → client 方向）：

```
Session.emit() → websocket-server 序列化
  → client 侧收帧
  → validateWSOutboundMessage() in validation/ws-outbound.ts
     → ws-outbound.aot.ts 生成的校验代码（zod-aot）
     # 只 safeParse，不 normalize/repair
```

**生成链**（构建期）：`codegen/ws-outbound.compile.ts` 的 `compile(WSOutboundMessageSchema)` 作为 zod-aot discovery 入口 → `scripts/generate-validation-aot.mjs`（先打两个编译器补丁再生成）→ `src/generated/validation/ws-outbound.aot.ts`。生成由 npm lifecycle hooks 驱动（`prebuild`/`pretypecheck`/`pretest`/`watch`），安装时不生成。

<details>
<summary>schema 速查表</summary>

| 导出 | 位置 | 职责 |
| --- | --- | --- |
| `WSInboundMessageSchema` | `messages.ts:7126` 附近 | client→daemon 顶层信封（hello/ping/recording_state/session 四选一） |
| `WSOutboundMessageSchema` | `messages.ts` 尾部 | daemon→client 顶层信封（pong/session） |
| `WSHelloMessageSchema` | `messages.ts` | clientId/clientType/protocolVersion/capabilities |
| `SessionInboundMessageSchema` | `messages.ts:3068` | 入站 session 消息巨型 discriminatedUnion |
| `SessionOutboundMessageSchema` | `messages.ts:6461` | 出站 session 消息巨型 discriminatedUnion |
| `extractSessionMessage` / `wrapSessionMessage` | `messages.ts` | `{type:"session", message}` 的拆包/封包 |
| `deriveAgentStateBucket` | `agent-state-bucket.ts` | 纯派生逻辑（非 schema） |

</details>

## 核心实现

### 信封结构

顶层 WS 信封是 `z.discriminatedUnion("type", ...)`：入站 `[WSPingMessage, WSHelloMessage, WSRecordingStateMessage, WSSessionInbound]`，出站 `[WSPongMessage, WSSessionOutbound]`。`session` 变体把 `SessionInbound/OutboundMessageSchema`（各自又是巨型 discriminatedUnion）包在 `{type:"session", message:...}` 里；`extractSessionMessage`/`wrapSessionMessage` 做拆包封包，ping/recording_state 被视为 WS 层独有。schema 文件分两层：**常量/纯类型模块**（如 `agent-lifecycle.ts` 的 `AGENT_LIFECYCLE_STATUSES`、`client-capabilities.ts` 的 `CLIENT_CAPS` 全枚举）与**域 schema 模块**（`chat/`、`schedule/` 等）——`messages.ts` 顶部 import 全部模块，是聚合点。

### zod-aot：为什么 AOT 以及两个补丁

动因是移动端性能（`docs/protocol-validation.md` 量化）：Hermes 上 353KB provider snapshot 用 JSON.parse + 运行时 Zod 需 ~10.9ms/5.9MB，AOT 后 ~2.5ms/1.2MB——**4 倍多的差距在每条入站消息上累积**。

生成器对 zod-aot（exact-pinned 0.20.4，年轻库）打了两个字符串锚点补丁，形状变了就 throw "update the patch"：

- `ensureZodAotRuntimeImportExtensionPatch`——emitter 保留 `.js` 后缀（Node ESM 打包必需）；
- `ensureZodAotDiscriminatedUnionOutputPatch`——discriminated-union 分支需回写 output 变量，否则 `.default()` 字段丢失。

补丁归本包所有，视为"编译器的一部分"，回归测试（8 个 case：defaults-in-branches、tool_call 状态路由、`.js` import、minimal envelope 等）锁行为。

**schema-purity 规则**由此而来：WS 消息 schema 禁 `.transform()/.catch()/.preprocess()`（生成器只编译纯结构声明）；共享 literal tag 必须 `z.discriminatedUnion()`；`.default()` 只许放 primitive leaf。normalize 逻辑移到显式 consumer——provider model normalization 就是从 schema 移出才让 zod-aot 能编译热路径。

一个有趣的反直觉：生成 validator 保留 unknown keys（`passthrough` 容忍），而运行时 Zod 会 strip——入站分发只按已知 `type`/payload 走，所以宽松不构成问题。

### 兼容契约：append-only + capability gate

`docs/protocol-compatibility.md` 拆成两个契约：

- **protocol contract**（双向必须可解析）：新字段一律 `.optional()`；禁止 optional→required、删字段、`string`→`enum` 之类的 narrowing；
- **feature contract**（功能可用性）：不兼容的功能靠 `server_info` 的 `features.*` 一次性 gate，**禁止 fallback 降级路径**——新旧任意组合都存在于 wild（app 商店更新 vs daemon 随意更新），单一 gate 点避免防御分支扩散。

治理靠纪律而非版本协商：`protocolVersion` 仅是 hello 里的 int（当前 = 1），兼容主要靠 optional 字段。全仓库 292 处 `// COMPAT(name): added in vX, remove after <日期>` 注释构成**带截止日期的清理 backlog**——`rg "COMPAT("` 即清单。客户端能力对等地放 hello 的 `capabilities`（`CLIENT_CAPS` 全枚举）。

### RPC 命名空间

点分命名，方向为末段（`docs/rpc-namespacing.md`）：`checkout.forge.set_auto_merge.request` ↔ `.response`；operation 段必须是动词（`get_noun` 而非 `noun`）；request 参数平铺顶层，response 数据放 `payload` 下，`requestId` 两边都带作为关联键。旧 flat 名（如 `checkout_pr_merge_request`）保留但不新增，迁移走"先加新名 → gate → 旧名过期 → COMPAT 标记删除"。

注意：主链路的 agent 消息仍是 snake_case 的 SessionInboundMessage（`create_agent_request` 等），dotted namespace 只用于新式操作——两代命名并存是迁移中的现实。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单一真源 + z.infer | `messages.ts` | schema 即类型，手写类型必然漂移 |
| AOT 代码生成 | `generate-validation-aot.mjs` | 移动端热路径性能 |
| 编译器补丁 + 回归测试 | `tests/validation/ws-outbound.test.ts` | 依赖年轻上游，补丁行为被锁 |
| discriminatedUnion | 全部消息 schema | 穷尽 switch + 穷尽校验 |
| capability gate | `server_info` features | 新旧版本任意组合共存 |

## 模块间交互

被五方 import：server（01 篇入站校验）、client SDK（06 篇）、CLI、App、Desktop。出站校验生成只覆盖 daemon→client 方向（client 是性能敏感端）；入站方向由 server 侧运行时 Zod 校验（`WSInboundMessageSchema.safeParse()` in `handleRawMessage()`）。

## 扩展方式

新增一个 RPC 消息类型：

1. `src/messages.ts`（或域子目录）定义 `XxxRequestSchema`（`type: z.literal("ns.op.request")`，参数平铺）与 `XxxResponseSchema`（结果在 `payload`，含 `requestId`）；
2. request 加入 `SessionInboundMessageSchema` 数组（`messages.ts:3068`），response 加入 `SessionOutboundMessageSchema` 数组（`:6461`）；
3. 文件尾加 `export type XxxRequest = z.infer<...>`；
4. 需旧 daemon 探测的新能力：`server_info` 的 `features` 加 optional flag + COMPAT 注释；新字段全 optional；
5. 生成代码无需手改——lifecycle hooks 自动重跑；复杂 union 形状建议跑 `tests/validation/ws-outbound.test.ts` 确认未被补丁回归击中。
