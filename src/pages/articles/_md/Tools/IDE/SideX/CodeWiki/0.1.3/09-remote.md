---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "远程开发"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "russh", "bollard", "Docker", "SSH", "remote"]
description: "SideX 远程开发——russh SSH + bollard Docker + 隧道，exec-based 文件操作，devcontainer 支持"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/00-overview)

---

## 模块定位

`sidex-remote` 实现远程开发——SSH 连接（russh）和 Docker 容器（bollard），让 SideX 编辑远程机器/容器内代码，对应 VSCode 的 Remote-SSH / Dev Containers。它定义了一个 `RemoteTransport` trait 抽象不同远程后端，支持 SSH exec-based 文件操作、Docker exec、devcontainer.json 完整解析、以及一个半完成的 SideX Server JSON-RPC 协议和隧道（tunnel）能力。当前是一个功能基本可用但有明确缺口的过渡态。

## 模块架构

```
命令层  commands/remote.rs   RemoteManagerStore（~380 行），7 个 remote_* 命令
        ├─ commands/proxy.rs  fetch_url/proxy_request（HTTP 代理转发，~274 行）
        ↓
crates/sidex-remote/（~4711 行）
  ├─ manager.rs       RemoteManager + ConnectionKind（SSH/Container/Server/Tunnel）
  ├─ transport.rs      RemoteTransport trait（9 方法：connect/exec/read_file/...）
  ├─ ssh.rs            SshTransport（russh 0.46，exec-based 文件操作）
  ├─ container.rs      ContainerTransport（bollard 0.18）+ devcontainer.json 解析
  ├─ server.rs         SideX Server JSON-RPC 协议（fs/readFile 等，半完成）
  ├─ tunnel.rs         TunnelServer/TunnelClient（tokio-tungstenite WebSocket）
  └─ ...
```

`RemoteManagerStore`（`remote.rs:22`）`inner: Arc<Mutex<RemoteManager>>`——双重 Arc（外层 Tauri manage，内层自行 clone）。前端 `sidexRemoteService.ts` 经 invoke 调 7 个 `remote_*` 命令，做 snake_case→camelCase 转换，注册为 VSCode DI singleton。

## 调用链路

SSH 连接 + 文件操作：

```
前端 sidexRemoteService.connectSSH({host, port, auth, ...})
  → invoke('remote_connect_ssh') → remote.rs → RemoteManager::connect_ssh
      → SshTransport::connect  in ssh.rs
         ① russh::client::connect(config, addr, handler).await  建立 SSH 会话
         ② authenticate_publickey / authenticate_password
         ③ session.channel_open_session() 开 channel
文件操作（exec-based，非 SFTP）：
  → transport.exec("cat <path>")        读文件（cat 输出 stdout）
  → transport.exec("find <dir> -type")  列目录
  → transport.exec("stat -c ...")        获取元数据
  → 大文件/二进制：base64 编码经 stdout 传输
```

Docker：`connect_container` → `bollard::Docker::connect` → `container_exec` 走 `docker exec` 在容器内执行命令。devcontainer.json 解析（`container.rs`）支持 image/dockerfile/dockerComposeFile/forwardPorts/mounts/lifecycle hooks/features/remoteUser/runArgs/gpuSupport 全字段。

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `connect_ssh` in `ssh.rs` | SSH 连接 | russh 纯 Rust，async-native，无 C 依赖 |
| `exec` in `ssh.rs:774` | 执行远程命令 | exec-based 而非 SFTP，兼容性好但大文件差 |
| `check_known_host` in `ssh.rs:333` | host 校验 | 指纹计算待核实 |
| devcontainer 解析 in `container.rs` | JSONC + 全字段 | 容器命名 `sidex-{fxhash(workspace_path)}` |
| `fetch_url` in `proxy.rs` | HTTP 代理转发 | 解决远程网络/反爬 |

## 核心实现

### exec-based 文件操作（无 SFTP）

SSH transport 用 `cat`/`find`/`stat`/`base64` 而非 SFTP subsystem——只需 session channel，不需 SFTP channel 类型；即使远程禁用 SFP 也能工作。代价：大文件效率差（base64 膨胀 33%、全量读入内存）。server.rs 的 SideX Server JSON-RPC（`fs/readFile`/`fs/writeFile`）也用 base64——全栈一致。注意 `exec_inner`（`ssh.rs:774`）当前 stderr 始终空、exit_code 硬编码 -1——**这是 SSH transport 最影响功能的未完成点**，需用 `ChannelMsg::Data`/`ExtendedData`/`ExitStatus` 替代单一 read 循环。

### 认证

`SshAuth` 枚举：`Password`、`PublicKey { key_path, passphrase }`、`Agent`。`Agent` 不是真正 ssh-agent——它加载 `~/.ssh/id_ed25519` 或 `id_rsa` 默认密钥文件走 `authenticate_publickey`（`ssh.rs:570`），简化实现。凭证以 `SshAuthPayload` 从前端传入（`remote.rs:97`），sidex-remote 本身不存储——`src-tauri/src/commands/secrets.rs` 提供 OS-keyring-backed 存储（`sidex_auth::SecretStorage`），前端经 `secret_get/set` 存取，存储与使用解耦。

### 隧道 + SideX Server

`tunnel.rs` 的 `TunnelServer`/`TunnelClient` 通过 relay WebSocket 配对（tokio-tungstenite），JSON-RPC 走 WebSocket text frame 中转，允许连 NAT/防火墙后的机器（类似 VS Code Tunnels）。**但 tunnel 尚未接入 `RemoteTransport` trait**——`manager.rs:169` `bail!("tunnel transport not yet wired into RemoteTransport")`。`server.rs` 的 SideX Server JSON-RPC（`fs/readFile` 等）是统一远程文件访问的预期方案，但本地 `commands/fs.rs` 不做 `remoteAuthority` 路由——远程文件操作需前端显式调 `remote_exec_ssh` 或未来 SideX Server。这是 VSCode Remote Server 架构的半完成状态。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy | `transport.rs` `RemoteTransport` trait | `SshTransport`/`ContainerTransport` 可换后端 |
| 连接管理 | `RemoteManager` ConnectionKind | 多后端统一管理 |
| 代理转发 | `proxy.rs` | HTTP 代理解决远程网络 |
| Memento | `container.rs` fxhash 容器命名 | 确定性命名，workspace 路径哈希 |

## 模块间交互

`sidex-remote` 独立，依赖 `russh`/`bollard`/`reqwest`/`tokio-tungstenite`，**不依赖** sidex-git（push/pull 走本地系统 git CLI）或其他 sidex crate。被 `commands/remote.rs` + `commands/proxy.rs` 调用。前端 `sidexRemoteService.ts` 桥接 7 个 `remote_*` 命令，`main.ts:93` 接受 `vscode-remote`/`vscode-vfs` URI scheme 表明前端远程感知，但 `commands/fs.rs` 不做 remoteAuthority 路由——远程文件需显式走 remote 命令。

## 扩展方式

**新增一种远程后端（如 Podman）**：创建 `crates/sidex-remote/src/podman.rs` impl `RemoteTransport`（9 方法）→ `manager.rs` 的 `ConnectionKind` 加 `Podman` 变体 + `connect_podman` → `remote.rs` 加 `remote_connect_podman` 命令 → `lib.rs` 注册 → 前端 `sidexRemoteService.ts` 加 wrapper。Podman 与 Docker API 兼容，bollard 理论可连 Podman socket，核心改动可能仅连接方式。

**修改 SSH 认证（接入真正 ssh-agent）**：`ssh.rs:570` 的 `Agent` 分支读 `$SSH_AUTH_SOCK` 连 ssh-agent，请求 identities 逐个 `authenticate_publickey`；修复 `check_known_host` 用 `russh_keys::PublicKey::fingerprint()` 与 known_hosts 比较。

**修复 SSH exec 的 stderr/exit_code**：用 `ChannelMsg::Data`/`ExtendedData { ext: 1 }`(stderr)/`ExitStatus` 替代当前 `stream.read()` 单一循环，提取真实退出码。

> 待核实：tunnel 何时接入 RemoteTransport；SideX Server JSON-RPC 何时统一远程 fs；devcontainer lifecycle hooks 执行时机。
