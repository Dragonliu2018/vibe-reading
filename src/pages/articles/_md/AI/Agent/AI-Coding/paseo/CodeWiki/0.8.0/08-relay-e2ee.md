---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "Relay 端到端加密"
date: "2026-09-18T00:00:05+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "Curve25519", "NaCl", "E2EE"]
description: "paseo relay 包——Curve25519 + NaCl box 的零知识中继、公钥走 URL fragment 的 QR 配对、客户端预派生单 RTT 握手、对称的 client/daemon channel API 与 binaryCiphertext 能力协商。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/relay/src/`（~3,300 行）解决"daemon 在防火墙/NAT 后，手机在外面"的远程访问问题，且**不牺牲 local-first 承诺**：relay 是零知识中继——只路由加密字节，看不到任何内容。加密是真正的端到端（daemon ↔ client 直接握手派生密钥），relay 无法读、无法伪造、无法强制轮换密钥。

> 注意：本仓库的 `cloudflare-adapter.ts` 是 **legacy**——`docs/architecture.md:174` 明确生产 relay 是 [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) 的分布式 Elixir 服务，本实现 "retained as legacy code and is not deployed"。但 `crypto.ts` 与 `encrypted-channel.ts` 是**在用的**协议库——客户端与 daemon 两侧的 E2EE 由这两个文件（经 `@getpaseo/relay/e2ee` 入口）提供。

## 模块架构

```
crypto.ts（纯密码学层）
├── generateKeyPair()        # Curve25519
├── deriveSharedKey()        # scalarMult + 全零检测 + box.before(HSalsa20)
├── encrypt()/decrypt()      # box.after / box.open.after（XSalsa20-Poly1305）
└── 线格式：[24B nonce][ciphertext]

encrypted-channel.ts（协议层，18KB）
├── createClientChannel(transport, daemonPublicKeyB64, events)
├── createDaemonChannel(transport, daemonKeyPair, events)
│      # 两者对称 API：send/close/onMessage/...
├── e2ee_hello / e2ee_ready 握手
└── binaryCiphertext 能力协商（binary raw vs base64 text）

cloudflare-adapter.ts（legacy，未部署）
└── RelayDurableObject：每 session 一个 DO + WebSocket hibernation
```

分层决策（`crypto.ts:10-12` 注释）：crypto 与 channel 分层——**换传输、换帧表示不动密码学**。

## 调用链路

**配对与连接链**（QR 码扫起到加密帧流动）：

```
daemon 侧首次启动
└── loadOrCreateDaemonKeyPair()            # 持久化 $PASEO_HOME/daemon-keypair.json
└── generateLocalPairingOffer() in pairing-offer.ts（server 包）
   └── createConnectionOfferV2 → encodeOfferToFragmentUrl()
      # daemonPublicKeyB64 + relay endpoint 编进 URL fragment
      # —— 浏览器不会把 fragment 发给任何服务器：
      #    relay 与 app 静态服务器都拿不到配对内容

手机扫码 → 取出公钥与 endpoint
└── createClientChannel(transport, daemonPublicKeyB64, ...)
   ├── 本地直接 deriveSharedKey()          # 拿到公钥即可算，无需等 daemon 回复 → 单 RTT 握手
   ├── 发 {type:"e2ee_hello", key, capabilities:{binaryCiphertext:true}}
   │    # 每 1s 重发直到收到 e2ee_ready（HANDSHAKE_RETRY_MS，处理 ready 丢失）
   ← daemon 收 hello → 派生 sharedKey → 回 e2ee_ready
   └── 此后双方 send()/onMessage() 全走加解密
```

<details>
<summary>方法速查表</summary>

| 导出 | 位置 | 职责 |
| --- | --- | --- |
| `generateKeyPair()` | `crypto.ts` | Curve25519 密钥对 |
| `deriveSharedKey(secret, peerPub)` | `crypto.ts:142-149` | scalarMult + 小贡献子公钥全零检测（RFC 7748）+ box.before |
| `encrypt()/decrypt()` | `crypto.ts` | XSalsa20-Poly1305（box.after） |
| `createClientChannel()` | `encrypted-channel.ts` | 客户端侧半通道（预派生密钥） |
| `createDaemonChannel()` | `encrypted-channel.ts` | daemon 侧半通道（bufferedMessages 暂存早到密文） |
| `handleDaemonRehello()` | `encrypted-channel.ts` | 重试 hello：常数时间 keysEqual() 比对，不一致 close 1008 |
| `createRelayTransportAdapter()` | `relay-transport.ts:435`（server 包） | Node ws → Transport 接口适配 |
| `base64EncryptedWireByteLength()` | `crypto.ts` | 供上层预算（40B overhead = nonce 24 + tag 16） |

</details>

## 核心实现

### 密码学层：三个值得讲的细节

`deriveSharedKey()` 先做 `nacl.scalarMult` 并用**全零检测拒绝小贡献子公钥**（`crypto.ts:142-149`，RFC 7748 要求——攻击者发特殊公钥使共享密钥恒为零）。`encrypt()`/`decrypt()` 是 `box.after`/`box.open.after`，线格式 `[24B nonce][ciphertext]`——**nonce 随机 24B 前置而非计数器**：免帧序同步（重连/乱序都无所谓），代价是 base64 下 33% 膨胀。`ensurePrng()` 兼容无 `crypto.getRandomValues` 的环境注入 PRNG。

帧表示的原则写在 crypto 层头注释：**"帧类型永不从明文字节推断"**——保持纯字节，语义留给上层。

### 握手：客户端预派生 + 健壮性细节

客户端**先本地派生 sharedKey 再发 hello**（拿到 QR 公钥即可算，无需等 daemon 回复）——握手只需一轮 RTT。健壮性处理了三个边角：

- `HANDSHAKE_RETRY_MS` 每 1s 重发 hello 直到 ready（处理 ready 丢失）；
- daemon 侧 `bufferedMessages` 暂存**早到的密文帧**（`encrypted-channel.ts:265-272` 注释：异步派生期间下一条已加密消息会被误判为第二个 hello）；
- `handleDaemonRehello()` 允许客户端重试 hello——daemon 重派生 sharedKey 用**常数时间 `keysEqual()`** 比对，一致则重发 ready，不一致 `rejectKeyRotation()` 以 close code 1008 拒绝（**防 relay 强制密钥轮换攻击**）；
- `pendingSends`（上限 200）缓存握手期发送。

### 帧编码与能力协商

协商 `binaryCiphertext` 后：应用层 binary 走**原始二进制帧**、text 走 base64 文本帧；未协商的对端两者都 base64（`supportsBinaryCiphertext()` in `encrypted-channel.ts` 判定，`COMPAT(binaryCiphertext)` 注释标注 2027-01-27 删 legacy 路径）。`decodePlaintext()` 用 WebSocket opcode 决定解出 string 还是 ArrayBuffer——帧类型由 opcode 携带，不由明文字节推断（呼应上面的原则）。

解密失败视为 fatal 并 close 1011（`encrypted-channel.ts:448-459` 注释）：让对端重连重握手，而非维持一个半死会话。

### 零知识属性

relay 只能看到：IP、时序、消息尺寸、serverId/connectionId、明文 hello/ready（仅含公钥与能力声明）。没有 daemon secret key 就无法派生 sharedKey；注入/伪造均过不了 Poly1305 认证（`SECURITY.md` "Why the relay can't attack you"）。legacy Cloudflare DO 的 `webSocketMessage()` 对消息零解析纯转发（仅 control socket 例外）——实现层面也贯彻了零知识。

### 传输可插拔

`Transport` 接口（send/close/onmessage/onclose/onerror，`TransportMessage.isBinary` 必须保真）是唯一的传输契约——实现它即可复用整套 E2EE。server 包的 `createRelayTransportAdapter()`（`relay-transport.ts:435`）把 Node `ws` 适配进来；client SDK 的 `createRelayE2eeTransportFactory()`（06 篇）在浏览器/RN 侧做同样的事。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 分层（crypto/channel） | `crypto.ts:10-12` 注释 | 换传输/帧表示不动密码学 |
| 对称 API | `createClientChannel` / `createDaemonChannel` | 两侧代码形状一致，配对逻辑好推理 |
| 能力协商 + COMPAT | binaryCiphertext | 新旧对端共存（base64-only 回退） |
| 适配器 | `Transport` 接口 | Node/浏览器/RN 三环境复用 |

## 模块间交互

- 被 client SDK（06 篇）在 relay URL 场景包装成 E2EE transport；
- 被 daemon（01 篇）经 `createRelayRuntime()` 的 `attachSocket` 注入 WS server——relay socket 与直连 socket 走同一会话/背压路径；
- QR 配对链路在 server 包的 `pairing-offer.ts`（公钥走 URL fragment 的设计在那里实现）。

## 扩展方式

- **换加密库**（如迁 WebCrypto X25519 + AES-GCM）：只改 `crypto.ts` 五个导出函数 + `ENCRYPTED_PAYLOAD_OVERHEAD_BYTES`；hello/ready 协议帧可不动（nonce/tag 长度变了需新 capability 位）；
- **加新 relay 传输**：实现 `Transport` 接口即可复用整套 E2EE；
- **改 relay 路由拓扑**（legacy adapter）：改 `fetchV2()` 的 tag 命名与 `webSocketMessage()` 转发表；对齐 Elixir 生产 relay 行为时 `cutover-proxy.ts`（17 行，纯换 protocol/host 转发）是流量切换点。
