---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "SSH 与 Tailnet Lock"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "SSH", "Tailnet Lock", "信任链"]
description: "Tailscale SSH 身份即鉴权与 incubator 会话引擎、TKA 哈希签名链防协调服务器作恶的机制解读。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

两个安全特性各自独立成域：**Tailscale SSH**（`ssh/tailssh/`，1,653 行 tailssh.go + 1,239 行 incubator.go）基于 tailnet 身份做 SSH 服务——不需要管理 authorized_keys，鉴权由 ACL 决定；**Tailnet Lock（TKA）**（`tka/`）用哈希签名链锁定 tailnet 成员变更——即使协调服务器被攻破或作恶，也无法悄悄塞进一个未授权节点。二者共同点是**把信任锚从传统基础设施（sshd 配置/CA 体系）换到 tailnet 密钥体系**。

## 模块架构

### Tailscale SSH 的分层

- `ssh/tailssh/`：SSH 服务端主体（`tailssh.go` 协议与策略、`incubator.go` 会话进程管理、`process_unix.go`/`auditd_linux.go` 平台细节）；
- `feature/ssh/ssh.go`（452B）：feature gate 注册，`init()` 调 `tailssh.Register()`；
- 策略来源：`SSHPolicy` 由控制面下发进 netmap（ACL 里的 ssh 规则）。

### TKA 的核心概念

| 概念 | 定义位置 | 说明 |
| --- | --- | --- |
| AUM | `tka/aum.go:132` | Authority Update Message：CBOR 编码的链上消息，5 种 `AUMKind`（AddKey/RemoveKey/UpdateKey/Checkpoint/NoOp），`PrevAUMHash` 指向父 → **BLAKE2s 哈希链** |
| State | `tka/state.go:26` | `LastAUMHash + Keys（含 Votes 权重，上限 4096）+ DisablementValues + StateID`；`applyVerifiedAUM`（state.go:162）纯函数式状态转移 |
| KeyID | `tka/key.go:85` | 公钥的 blake2s 摘要 |
| NodeKeySignature | `tka/sig.go:74` | `SigDirect`（信任密钥直接签 node key）/ `SigRotation`（嵌套旧签名链，防克隆回滚）/ `SigCredential`（包装 preauth key） |
| Chonk | `tka/tailchonk.go:33` | 本地 AUM 存储（FS 实现按 base32 哈希文件名），`Compact` 按 MinChain/MinAge 回收 |

## 调用链路

### Tailscale SSH 数据流

```
peer TCP:22 → netstack 拦截（shouldProcessInbound in netstack.go:1255
              → getTCPHandlerForPort in ipn/ipnlocal/netstack.go:47 判定 22 + ShouldRunSSH()）
  → LocalBackend.handleSSHConn → tailssh.HandleSSHConn
  → gliderssh 握手（NoClientAuth: true）
  → clientAuth (tailssh.go:325)
       └─ setInfo (tailssh.go:641): lb.WhoIs("tcp", srcIPPort) 源地址反查节点+UserProfile
            （拒绝非 Tailscale IP；PasswordCallback/PublicKeyCallback 也走 clientAuth
             ——密码/公钥内容无关紧要，身份由 WireGuard 层 node key 背书）
  → evalSSHPolicy/matchRule (tailssh.go:1173/1199)  第一条匹配的 SSHRule
  → SSHAction(Accept/HoldAndDelegate/...)
  → sshSession.run (tailssh.go:920) → newIncubatorCommand (incubator.go:126)
       └─ exec 用户 login shell（root 场景重新执行 tailscaled be-child ssh，
          beIncubator (incubator.go:390) 注册 OS 会话、setuid/gid、降权后起目标进程）
```

策略会话期间可变：`OnPolicyChange`（tailssh.go:194）+ `checkStillValid`（tailssh.go:807）在 netmap 更新后复查已建立连接。还支持 SFTP（内嵌 Go SFTP）、agent forwarding、会话录制（asciinema cast 格式，`startNewRecording`）。

### HoldAndDelegate：浏览器二次确认

`SSHAction`（tailcfg.go:2755）是状态机指令：Accept/Reject/Message/SessionDuration/HoldAndDelegate。需要 check 模式重新验证时，规则带 `HoldAndDelegate` URL：`clientAuth` 先把提示文本以 SSH **banner** 打到客户端终端，`expandDelegateURLLocked`（tailssh.go:720）填 `$SRC_NODE_IP/$SSH_USER/$LOCAL_USER` 占位符，`fetchSSHAction`（tailssh.go:823）**长轮询该 URL 最长 30 分钟**直到返回 Accept/Reject。

### TKA 工作流

```
启用: TailnetLockInit (ipnlocal/tailnet-lock.go:705)
  → tka.Create 生成 genesis AUM（信任密钥 + disablement values + 随机 StateID）
  → 两阶段 RPC: tkaInitBegin 上传 genesis → control 返回 NeedSignatures（现有全部节点）
  → 本机用 NetworkLockKey 逐个 signNodeKey → tkaInitFinish
  （先签后启用：避免启用瞬间全网断连）
跟进: tkaSyncIfNeeded (tailnet-lock.go:357)（每次 netmap 更新时从 local.go:2015 调用）
  ├─ 启用 → tkaFetchBootstrap 取 genesis
  ├─ 禁用 → 验证 disablement secret 后 tkaApplyDisablementLocked 清空
  └─ 落后 → tkaSyncLocked 走 SyncOffer 交换
验证点（防 control 作恶的关键）: tkaFilterNetmapLocked (tailnet-lock.go:189)
  （local.go:2035 调用——不在 controlclient，而在客户端收 netmap 之后）
  → 逐 peer 调 NodeKeyAuthorizedWithDetails (tka.go:688)
  → 验签失败的节点从 netmap 中剔除（delta 更新走 tkaFilterDeltaMutsLocked:150 改写为 Remove）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `clientAuth` in `ssh/tailssh/tailssh.go:325` | 身份即鉴权 | NoClientAuth + WhoIs 反查 |
| `evalSSHPolicy` in `tailssh.go:1173` | 规则评估 | 首条匹配，RuleExpires 短时免确认 |
| `fetchSSHAction` in `tailssh.go:823` | 确认长轮询 | 30 分钟上限 |
| `beIncubator` in `incubator.go:390` | 会话进程降权 | 复刻 sshd 的 PAM/auditd 语义 |
| `aumVerify` in `tka/tka.go:421` | AUM 验证 | 至少 1 个受信 KeyID 签名 |
| `SyncOffer` in `tka/sync.go:77` | 状态同步 | head + Checkpoint 祖先链交换 |

</details>

## 核心实现

### 为什么不复用系统 sshd

(a) sshd 的 authorized_keys 与系统账号绑定，无法表达 tailnet ACL 的"用户/节点/过期时间"语义，且控制面改 ACL 无法即时生效于 sshd；(b) netstack 用户态栈里连接根本不经过 22 端口的内核监听（见[netstack 模块](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/05-netstack)）；(c) 需要每连接的 tailnet 身份、会话录制、check 再验证、SessionDuration 强杀等 sshd 不具备的钩子。代价是 incubator 自行复刻 sshd 的会话/降权/auditd（`auditd_linux.go` 记录登录事件）语义。

### TKA 验证规则与 Votes 的真实语义

`aumVerify`（tka.go:421）：格式合法 + 父哈希匹配 + **至少 1 个来自受信 KeyID 的有效签名**（签名数不是 quorum 门槛）；特例：不能删除 state 中最后一个 key。**Votes 权重不是准入门槛，而是确定性分叉裁决**：`pickNextAUM`/`advanceByPrimary`（tka.go:134/180）按 `AUM.Weight`（aum.go:324，去重签名者后累加 Votes）+ 哈希排序选主链——所有节点跑同一规则即可对主链达成共识，无需拜占庭容错（参与者都是持有信任密钥的自家人）。

### 为什么是自签哈希链而不是 WebPKI/Merkle 树

目标是对**内部协调服务器**去信任，而非对公网身份——WebPKI 证书解决不了"control 谎报节点列表"的问题。节点授权需要的是可验证的**撤销语义**（RemoveKey 立即生效、rotation 链防克隆），X.509 吊销模型（CRL/OCSP）依赖外部基础设施且时延高。哈希链 + Checkpoint 实现类透明度日志的可审计性，但**点对点可同步**（`SyncOffer`，节点间/control 皆可），无需公网可达的日志服务器；Checkpoint 即"树头"，`Compact` 免去永久增长。多签 Votes 用于分叉裁决而非 CA 式层级信任。撤签/恢复用 `TailnetLockGenerateRecoveryAUM → CosignRecovery → SubmitRecoveryAUM`（fork 链多签）。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 策略模式 | `SSHAction` in `tailcfg.go:2755` | 控制面远程编排会话行为（Accept/Hold/强杀） |
| 纯函数状态转移 | `applyVerifiedAUM` in `tka/state.go:162` | 验证与状态机可独立测试 |
| 增量同步协议 | `computeSyncIntersection` in `tka/sync.go:132` | 公共祖先 + 缺失集互发 |

## 模块间交互

SSH：入口在 netstack（22 端口拦截）→ ipnlocal（`handleSSHConn`）→ tailssh；策略从 netmap 的 `SSHPolicy` 读取（可用 `TS_SSH_POLICY_FILE` 调试覆盖）。TKA：`tka` 包被 `ipn/ipnlocal/tailnet-lock.go`（1,653 行编排）消费；`feature/tailnetlock/`（63 行）目前仅注册 C2N 调试端点 `/debug/tka/log`，注释明言"未来所有 tailnet lock 代码应迁到这里"。老命名 `NetworkLock*` 全部是 `TailnetLock*` 的 Deprecated 别名。

## 扩展方式

新增 SSH 认证动作/确认方式：改 `SSHAction`（tailcfg）+ `clientAuth` 状态机；新平台会话支持：改 `incubator_*.go`（`incubator_plan9.go` 是范本）+ `process_unix.go`；新 AUM 类型：遵循 `AUM` 结构体注释的 CBOR 兼容规则（只加可选字段、字段号永不改），`applyVerifiedAUM` 加 case。
