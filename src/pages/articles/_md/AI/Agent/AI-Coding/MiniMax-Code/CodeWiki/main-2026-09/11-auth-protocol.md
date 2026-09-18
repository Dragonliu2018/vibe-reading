---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "认证与共享协议"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "OAuth", "设备码流", "lease", "协议层"]
description: "oauth-core + oauth-lease-protocol + protocol + config + shared + agent-extension 解读——RFC 8628 设备码流（MCodeOAuthCore 状态机 + 双文件 0600 存储）、lease 协议 v1（unix socket + capability）、region 命名空间隔离、.example.invalid 防泄漏、agent-extension SPI"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

六个小包构成最底层：`oauth-core/`（MiniMax 账号 OAuth）、`oauth-lease-protocol/`（lease 协议）、`protocol/`（共享数据契约）、`config/`（区域/环境配置）、`shared/`（工具库，不依赖任何包）、`agent-extension/`（扩展 SPI 胶水）。它们独立成层的理由：**凭据生命周期横跨所有模块**（tui 登录 UI、model-system 鉴权、工具子进程 lease），必须沉到最底避免循环依赖。

## 模块架构

![mcode login 流程](/vibe-reading/images/articles/minimax-code/auth-login.svg)

`MCodeOAuthCore`（auth-core.ts:152，885 行）是唯一状态机类：`getStatus/login/cancelLogin/getAccessToken({requiredScopes, minValidityMs})/handleUnauthorized/logout({revoke})/watch(listener)`。错误族完整（`AuthRequiredError`/`AuthScopeUpgradeRequiredError`/`AuthDomainConflictError` 等）。常量契约在 contracts.ts：`MCODE_OAUTH_CLIENT_ID='mcode-public'`、scopes `['agent.default']`、audience `'agent-backend'`。`HttpOAuthClient` 实现 `startDeviceAuthorization`（PKCE：32 字节 code_verifier + S256 challenge）/`pollDeviceToken`/`refreshToken`/`revokeToken`。

## 调用链路

`mcode login` 完整流程：

```
tui/src/auth/factory.ts createDefaultMcodeAuthApplication
  → resolveMcodeAuthEnvironment（region/buildEnv）→ resolveMCodeOAuthEndpointConfig
  → McodeAuthApplication.login → MCodeOAuthCore.runLogin（auth-core.ts:385）
     CrossProcessAuthLock.withLock（proper-lockfile 30s stale）下读状态
     → 竞选 authorizing lease（leaseId + 10 分钟 authorizationLeaseMs）
     → 非 owner 进程 waitForAuthorization 轮询 state 文件共享 userCode
     → owner：startDeviceAuthorization（RFC 8628 设备码流，非浏览器回调重定向）
        publishAuthorizationProgress 把 userCode/verificationUri 写进 state
        pollDeviceToken 轮询（兼容 MiniMax 变体：status pending/slow_down 响应体、
          user_code 作 polling 参数、毫秒级 expired_in）
     → commitLogin：先 credentialStore.put 再 stateStore.write，两步均持锁；abort 同锁回滚
     → FileStore 写 auth.json（dataDir/auth/{buildEnv}/{region}/mcode-public/，0600 原子写）
```

token 进入模型调用：accessToken 投影写 `dataDir/local-runtime.auth.json`（config/src/local-runtime-auth-context.ts）→ model-system 的 `resolveLocalProviderCredentials` 读取 → managed-login 注入 Bearer 头。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `runLogin()` in auth-core.ts:385 | 登录状态机 | 设备码流 + 跨进程锁 + lease 竞选 |
| `getAccessToken()` in auth-core.ts:249 | 取 token | 乐观读 + 锁内复查，不足 minValidityMs 才刷新 |
| `refreshCredential()` in auth-core.ts:673 | 刷新 | invalid_grant 先写 anonymous 再删 secret |
| `handleUnauthorized()` | 401 处理 | 按 generation/loginEpoch 区分 retry/logout |
| `acquireLease()` in lease-broker.ts | lease 发放 | 缓存 + single-flight + epoch 失效 |
| `resolveAuthLeaseEndpoint()` in endpoints.ts | 端点解析 | unix socket / Windows 命名管道 |
| `resolveProviderAuthMode()` in config/provider-auth-mode.ts | authMode 判定 | managed-login 判定唯一入口 |

</details>

## 核心实现

### 双文件存储与跨进程

state（`auth-state.json`，非敏感、可 watch）与 credential（`auth.json`，secret）分文件；`assertNoSensitiveKeys()` 用正则主动禁止 token 字段入 state。**不用 keychain**：legacy `os-keyring` 已退役为 anonymous；FileStore 强制 0600/0700 权限校验（Windows 无 POSIX 位则跳过）。why：跨平台 + 多进程原子共享（atomic-write + lockfile），牺牲加密换可移植与可恢复——`recoverInterruptedCredentialCommit()` 处理"credential 已写 state 未写"的中间态。

### region 命名空间与 scope 升级

region = namespace 隔离：路径含 `{buildEnv}/{region}`，keychain service 名同样编码；`assertLoginStateDomain()` 允许 cn/en 并存但禁止环境冲突（`AuthDomainConflictError` 提示先登出）。账号端点：cn → `account.minimax.cn`，global → `account.minimax.io`。scope 升级机制（`assertCredentialContract`）：新增 scope 后旧凭据抛 `AuthScopeUpgradeRequiredError`，tui 收到 `requiresInteractiveLogin()` 引导重登——**旧 token 不静默失效，显式要求用户重新授权**。

### lease 协议 v1

`AUTH_LEASE_PROTOCOL_VERSION=1`，三方法 `status | lease | unauthorized`，六错误码。`endpoints.ts` 的端点：unix socket `run/mcode-auth-lease-v1.sock`。`node-client.ts`/`node-server.ts` 提供长度前缀 JSON 帧（codec.ts，4 字节 BE + ≤64KB）。每个方法的解析都 `requireExactKeys` 精确键校验——加字段必须同步 parse 两处。broker 侧实现在 mcode-tools-host（见[工具体系](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/10-tools-sandbox)）。

### `.example.invalid` 占位机制

非 prod 环境 URL 全部用 `example.invalid`（保留 TLD，RFC 2606 保留域）：`endpoint-config.ts` 的 `account-pre.example.invalid`、`config.ts:1566` PRESET_BASE_URLS 的 `matrix-test.example.invalid`。why：source preview 对外发布时防内部测试环境真实域名泄漏，同时保留结构让 CI 用 env override（`MCODE_OAUTH_*_ENDPOINT` 三个必须全配或全不配）。`check:source` 会拒绝内部地址。

### protocol 与 agent-extension

`protocol/src/local.ts`（1761 行）纯 CLI/TUI 数据结构（`SessionKind`/`SessionMessageView`/`ForkSessionInput` 等，数字枚举保兼容）；`runtime.ts` 定义 `IAgentConfig`/`IModelRef`/`IRuntimeEvent`（schema `archon.runtime.event.v1`）。两者都无 RPC envelope/路由/鉴权头——这是"进程内单体"在类型层的体现。`agent-extension`（index.ts 自述 "owns only SPI glue"）：实现 `@mavis/agent-runtime` 的 `AgentExtension`/`ExtensionAPI`（SPI 面为 `pi.registerTool`/`pi.contributeSystemPrompt`/`pi.registerReminderProvider`），导出 13 个内置 extension，不构造模块实例、不给默认列表。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双存储分离 | state/credential 分文件 + assertNoSensitiveKeys | watch 能力与 secret 隔离 |
| 乐观读 + 锁内复查 | `getAccessToken`（auth-core.ts:249） | 快路径无锁 |
| 世代计数 | generation/loginEpoch | 并发登录仲裁、401 区分 retry/logout |
| capability 文件即本地授权 | socket 目录 0700 + cap 0600 + timingSafeEqual | 本地 IPC 的最小信任根 |
| 策略/门面 | `token-provider.ts` freeze 出 provider/manager 两级视图 | provider 无 login/logout 权限 |

## 模块间交互

oauth-core 仅被 tui 直接依赖（登录 UI + `createMcodeSharedAuthSession`）；model-system **不直接 import**——经 `@mavis/config` 的 `resolveProviderAuthMode()` + `local-runtime.auth.json` 文件投影解耦。lease-protocol 被 mcode-tools-host（服务端）和 tui（客户端）依赖。protocol 被 agent-core/agent-tools/local-runtime(-v2)/tui 广泛共享。shared 是零依赖最底层；config 依赖 shared。

## 扩展方式

- **新增 region（如 "jp"）**：`oauth-core/src/contracts.ts` 的 `AuthRegion` 加字面量 → `endpoint-config.ts` 的 `ACCOUNT_ORIGINS` 加列 → `config/src/config.ts` 的 `MavisRegion` + `PRESET_BASE_URLS` 加 key → `state-store.ts` 的 `isOptionalAuthScope()` 放行。
- **新增 lease 方法**：`oauth-lease-protocol/src/contracts.ts` 加 `AuthLeaseMethod` 分支 + parse 精确键校验同步两处 → broker handler 加分支 + client 加方法；协议版本不变要求双向兼容。
- **新增 OAuth scope**：`MCODE_OAUTH_SCOPES` 追加 → `assertCredentialContract` 自动对旧凭据抛升级错误 → tui 引导重登。
