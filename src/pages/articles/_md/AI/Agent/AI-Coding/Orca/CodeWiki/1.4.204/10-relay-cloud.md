---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "Relay 云中继"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "Relay", "E2EE", "推送"]
description: "手机与桌面从不直连：director/cell 两级路由、splice 纯帧转接、独立 push 网关、fence broker 的 Terraform 变更互斥——云永不成为状态权威。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

手机与桌面**从不直连**：各自向云端 relay 发起**出站** WebSocket，relay 把两个 session 配对后转接帧。桌面侧 `src/relay/`（74k 行）是跑在执行主机上的 relay daemon（含 `RelayAgentHookServer`——agent status 唯一 store 的 relay 版）；云端 `cloud/apps/` 部署 relay（director/cell 双角色）、独立 push gateway、以及 fence broker。架构立场（`cloud/README.md`）：**云只做中继与推送，永不持有状态权威**。

## 模块架构

![Relay 拓扑](/vibe-reading/images/articles/orca-internals/relay-topology.svg)

三块：**配对与中继**（手机→director 分配 cell→splice 桥到桌面出站连接）、**推送**（完全独立于数据路径的 OS banner 通道）、**执行主机侧**（hook server + 信封发布 + 移动订阅）。relay 不解析业务帧——`wireSplice()` 只按 close code / 排队字节预算转接，为端到端加密让路。

## 调用链路

移动 app 配对 → 中继建立 → 状态推送 → follow-up 回桌面：

```text
配对（push 通道侧）
  桌面 PushGatewayClient（src/main/runtime/push/push-gateway-client.ts）
    ——"Every method returns a result instead of throwing — push is best-effort"
  用 E2EEKeypair（X25519）向 push 网关 /v1/host/challenge 发公钥换挑战
  → 答 proof → 24h 会话（PushHostSessionStore）
  → 每台已配对手机 native token 经 /v1/devices 注册

中继建立（数据通道侧）
  桌面 RelayControlClient.connect()（relay-control-client.ts）
    Bearer JWT 连 director 分配的 cellUrl 的 /v1/host/control
    （+ RelayControlSilenceWatchdog 静默看门狗；region preference 有迟滞：
     新 region 快 20%（SWITCH_RATIO=0.8）且快 25ms（SWITCH_MINIMUM_MS）
     才换区；有 hint 的缓存 TTL 24h，no-hint 只记 1h——重测便宜 vs
     重连代价。测量不足时不写 hint：孤胜者不如 director 默认放置）
  手机连 /v1/connect/{hostId} → director 查 invite（resolveInviteForMove）
    → 回 relay-moved {cellUrl, assignmentEpoch} 并以 DRAINING 关闭
  → cell 侧 HostSessionRegistry.acceptClient/acceptControl 配对两端
  → wireSplice() 开始双向转帧

agent 状态推到手机
  远程主机上 agent CLI 的 hook POST → RelayAgentHookServer.handleRequest
    （只绑 127.0.0.1，x-orca-agent-hook-token 鉴权，slowloris 超时防护）
  → applyEvent()（缓存进 lastStatusByPaneKey；retired pane 丢弃）
  → forward(buildRelayHookEnvelope) → publishAgentHookEnvelope
    （超帧先 shed lastAssistantMessage/subagents；interactivePrompt 最后 shed
    ——阻塞式问题卡是 load-bearing；仍超则 250ms×40 重投，pending 上限 64）
  → 帧经 splice 到手机；同时 DesktopPushService 经 push 网关打 OS banner

手机发 follow-up 回桌面
  → relay splice 到桌面 socket → MobileSocketWiring（每 WebSocket 一个
    E2EEChannel + DeviceRegistry 鉴权）解密进 runtime-rpc → allowlist 裁决
```

方法速查表：

<details>
<summary>relay 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `wireSplice()` in splice-forwarder | 帧转接 | 进程级排队字节预算防慢端打爆内存 |
| `admit(source)` in relay-server | 准入控制 | pre-auth 每源每分钟限额；首帧 deadline |
| `resolveInviteForMove()` | director 分配 | `commitIdleRegionalRehome` / `control-lease-recovery` |
| `applyEvent()` in hook server | 状态收敛 | delete-then-set 使 Map 插入序 = recency（LRU 淘汰最久空闲） |
| `admissionSource()` | 取真实来源 | 只信 `x-forwarded-for` 倒数第二跳（GFE 语义） |

</details>

## 核心实现

### 状态权威在执行主机，云只做中继

依据（`docs/reference/agent-status-store.md`）："The host that runs the process is the only party that can observe it, and the client is never authoritative for execution state."——执行进程的主机是唯一观测者，客户端对执行状态永不权威。历史上（2026-09-09 审计）曾有 6 个生产者、3 个消费者、main 进程内 3 份重复行，各读者自定 precedence 导致同一 pane 桌面/手机/CLI 显示不一致；整改后 precedence 在写时裁定、读者只留 presentation policy、**mirroring is not merging**。云侧对应实现就是 splice 不解析帧，配合 `MobileSocketWiring` 的 E2EEChannel——云只见密文。push 网关同样只存聚合计数："Tokens, notification titles, notification bodies … never reach a log line"。

### push 不走 relay 数据路径

`cloud/README.md`："Provider push is the only ordinary mobile OS-banner path. The notification socket is retained only for live dismissal and reconnect tray reconciliation; it never creates or recovers banners."——避免双通道都能造 banner 导致重复/冲突。FCM 离线折叠语义不可靠也如实声明。手机**不持有** push 网关凭证——桌面用与 relay 相同的 X25519 key 完成挑战应答。

### fence broker：变更面（而非数据面）的互斥

`cloud/apps/relay-fence-broker/` 是 IAM-only 私有服务，**唯一持有 GCS durable mutation lease、Terraform checkout 和狭窄的 Compute mutation 权限**；调用它的 GitHub workflow 只有 read + invoke 权限。两个操作：`POST /v1/supersede-target`（目标 cell 被新镜像 supersede 时执行替换）、`POST /v1/fence-source`（把源 cell 从 targetCellIds 隔离）。互斥机制：`GoogleStorageMutationLease.acquire()` 用 GCS 对象 generation 做乐观锁（冲突抛 `MutationLeaseConflict` → 409）；请求必须带与当前镜像一致的 `fenceCommit`（image commit SHA，409 `fence_commit_mismatch` 拒绝旧版本流程）。**Why**：防多个部署/迁移 workflow 并发对同一组 relay cell 做 Terraform 变更时的竞态（谁在替换谁、源 cell 何时摘除）——不是手机/桌面数据面脑裂。lease 放在 broker 而非 workflow 里，是因为 workflow 身份不能持有基础设施写权限——权限最小化。

### 三条传输约束

准入控制（`RelayConnectionLedger`：hard cap + control reserve + phone/hostData 预约）；`ProcessQueuedByteBudget`（进程级排队字节预算，防一个慢端把 relay 内存打爆）；`admissionSource()` 只信 `x-forwarded-for` 倒数第二跳（GFE 语义——最后一跳是 GFE 自己）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单写多读 store 订阅 | `agent-hook-server.ts` 的 `applyEvent()` | 消除多读者 precedence 仲裁 |
| splice 纯转发 | `splice-forwarder.ts` | 不解析内容，为 E2EE 让路 |
| director/cell 两级路由 | `relay-server.ts` + `assignment-store.ts` | 分配与连接承载分离，`assignmentEpoch` 幂等 |
| region preference 迟滞 | `relay-region-preference.ts` | 换区需显著收益（快 20% 且 25ms） |
| fail-open hook + fail-soft push | 两处旁路组件 | 旁路绝不阻塞主路径 |
| request-driven replay | `replayCachedPayloadsForPanes()` | 客户端重连主动拉，非服务端盲推 |

## 模块间交互

与 [统一 RPC 层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/02-rpc)：移动帧解密后进同一个 `RpcDispatcher`（mobile allowlist）。与 [会话数据层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/07-session-data)：`RelayAgentHookRuntime` 是粘合层——hook server 的 env 注入 PTY（`ptyHandler.addEnvAugmenter`）、PTY exit/surface-retired 回调清缓存、plugin overlay（opencode/pi/omp/prime-agent 四种 agent 的状态插件按需物化，客户端推送插件源码、字节上限校验）。与 [SSH 远程执行](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/09-ssh-execution-host)：远端主机的 relay daemon 就是 `src/relay/` 同一套代码（`ssh-relay-deploy.ts` 部署）；桌面经 `relay-connect-channel.ts` 把新 SSH channel 桥接到持有活跃 PTY 的远端 daemon。

## 扩展方式

**新增一种推送到移动端的事件**（如 `agent_blocked_on_permission`）：

1. 契约：`src/shared/agent-hook-relay` 的 `AgentHookRelayEnvelope` 字段 + 按需 `cloud/packages/push-contract`；
2. 生产：hook 脚本 POST → `normalizeHookPayload()` 归一化 → `applyEvent()` 自动获得缓存/replay/retired-suppression 语义，**无需新生产者**；
3. 传输：`agent-hook-envelope-publication.ts` 评估是否加进 `SHED_ORDER`（`interactivePrompt` 必须最后）；
4. OS banner：桌面 `desktop-push-service.ts` → 云端 durable-push-store（README 警告：不兼容 queue 格式需停旧 revision 并清 fixtures，无迁移）；
5. **不需要动**：cloud relay（splice 不解析帧）、fence broker、postgres-schema——数据通路与告警通路解耦的直接验证。
