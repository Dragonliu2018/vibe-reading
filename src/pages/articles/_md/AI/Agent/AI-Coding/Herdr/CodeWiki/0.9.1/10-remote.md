---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "远程多机"
date: "2026-09-17T10:55:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
tags: ["herdr", "Rust", "SSH", "分布式"]
description: "herdr 远程多机：SSH stdio 桥、ProfileId 身份模型、supervisor 指数退避重连与 --machine 远程 CLI 转发。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/remote/`（约 5,900 行）+ `src/client/endpoint.rs` + `client/endpoint/` 子树 + `cli/machine.rs` 实现 "several machines, one window"：本地工作与保存的 SSH 机器聚合在一个 herdr 窗口里，agent 列表合并、各连接独立重连。三条产品路径都从这里走：`herdr --remote <target>`（交互式 SSH 附加）、保存的 machine（TUI 内 sidebar 切换 + 后台 supervisor 重连）、`herdr --machine <label> <command>`（0.9.1 新增的远程 CLI 转发）。

这个模块的核心立场是一条安全红线：**失败的远端命令绝不回退 Local**（`cli/target.rs:92` 的 `remote_error`、散布在 cli/status.rs:183、cli/server.rs:33、worktree.rs:326 等处的 `is_remote()` 守卫）。`--machine` 语境下静默操作本机会造成"以为在 build 机器上执行了 agent prompt 结果落在本机"的危险幻觉——宁可硬失败。

## 模块架构

![remote 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-10-remote.svg)

交互式附加是五步链：剥参数 → prepare（探测/安装远端二进制）→ ensure（远端 server 生命周期判定）→ SshStdioBridge（本地 unix socket 与 `ssh -T` stdio 的双向桥）→ 本地 client 经桥附加。保存 machine 的运行时腿在 `client/endpoint/supervisor.rs`：`EndpointSupervisors` 为每个 enabled profile 维护 `ReconnectState`，到期 `connect_once` → `remote::connect_saved_ssh`。身份模型刻意用**不透明 ProfileId**（sha256 生成的 32 位十六进制）而非 SSH target 字符串——target 可改名、可含敏感字符、同一 target 不同 session 必须是两个 endpoint（storage key 测试 `endpoint_storage_keys_do_not_contain_ssh_targets` 守护这一点）。

## 调用链路

**`herdr --remote <target>`**：

```
run_remote() in remote/attach.rs:41
├─ extract_remote_args()（remote/args.rs）→ 回写干净的 reattach 命令
├─ prepare_remote_herdr() in attach.rs:1080
│    ├─ detect_remote_platform（uname + Windows 探测）
│    ├─ remote_binary_candidates（PATH/Homebrew/mise/nix 多候选发现）
│    └─ 不满足 endpoint 需求 → 交互确认后 download_release_asset
│         （读 herdr.dev/latest.json，scp + prepare/commit 脚本原子落盘）
├─ ensure_remote_server_ready() in attach.rs:1688
│    └─ restart_policy 判定 → live_handoff_remote_server 或 stop_remote_server
├─ SshStdioBridge::start() in attach.rs:2447
│    ├─ bind_private_local_listener（本地 0600 unix socket）
│    └─ 每连接一条 ssh -T <target> <远端 bridge 命令>，双线程拷贝 stdio
│         + discard_remote_output_preamble 剥 SSH banner
└─ run_client_process：本地 client 连桥，reattach 命令经 HERDR_REATTACH_COMMAND 注入
```

**保存 machine 的后台重连**：

```
EndpointSupervisors::reconcile_profiles（增删改 profile）
└─ spawn_due 到期 → connect_once() in supervisor.rs:259
   └─ remote::connect_saved_ssh()（remote/saved.rs）
      ├─ find_installed_remote_herdr（只发现、不安装）
      ├─ SshStdioBridge::start（noninteractive=true，启用 idle-timeout）
      └─ do_handshake 协商 EndpointNegotiation（surface-interest/health-check）
         ├─ failure_needs_attention（权限/host key/协议不兼容）→ Attention 态停止重试
         └─ 网络超时 → retry_delay：INITIAL_RETRY_DELAY << min(attempt,8)
            封顶 MAX_RETRY_DELAY（指数退避）
```

**`herdr --machine <label> <command>`**：

```
cli/target.rs::maybe_run
├─ parse_machine_prefix → resolve_machine（label 歧义要求用 profile-id）
├─ validate_machine_command（白名单：只允许 API-backed 命令，拒绝 attach TUI）
└─ 线程局部 TargetScope 挂起 MachineTarget
   └─ CLI 命令里任何 api_client() 调用（target.rs:63）懒启动 SavedSshApiBridge
      （SSH 起远端 herdr --session <s> remote-api-bridge，本地桥 socket 接入）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `run_remote()` in `attach.rs:41` | 交互式附加入口 | 五步链 |
| `prepare_remote_herdr()` in `attach.rs:1080` | 远端二进制治理 | 安装必须交互确认 |
| `remote_install_running_server_plan()` in `restart_policy.rs` | 纯函数决策 | Keep/LiveHandoff/StopRequired |
| `connect_once()` in `supervisor.rs:259` | 单次重连 | 失败二分：attention vs 退避 |
| `saved_ssh_failure_needs_attention()` in `saved.rs` | 错误分类 | 纯字符串启发式，新失败模式需补 needle |
| `wait_with_output_timeout()` in `process.rs` | 15s 超时执行 | 双线程读 stdout/stderr 防管道死锁 |
| `validate_machine_command()` in `cli/target.rs` | 命令白名单 | 拒绝 attach TUI |

</details>

## 核心实现

### SshStdioBridge：不走端口转发

桥的实现值得细看：本地绑定 0600 unix socket，后台线程 accept，每个连接起一条 `ssh -T <target> <远端 bridge 命令>`，upload/download 双线程把 socket 流与 ssh stdio 双向拷贝，`discard_remote_output_preamble` 剥掉 SSH banner（否则会把 MOTD 混进协议流）。好处：不需要远端开任何端口，ssh 的认证/加密/ControlMaster 复用全免费（`RemoteSsh` 可写托管 ssh config 含 keepalive）。

### restart_policy：管的是远端 server，不是网络重连

容易混淆的两层：supervisor 管网络重连（退避）；`restart_policy.rs` 管**远端 server 是否需要重启**——saved endpoint（require_surface_interest=true）要求远端 server 具备 surface-interest + health-check 能力且以 detached daemon 运行，否则 stop/换新。为什么：多机联邦里远端 server 必须在本地 TUI 关闭后仍活着（`prepare_saved_ssh` 注释：EOF 只关临时 attachment，named server 继续跑），且旧 server 不知道 surface-interest 协议会把整屏渲染流量推给无人的客户端。全模块是无副作用决策函数，易测试。

### 防闪烁的跨机器切换事务

`client/endpoint/activation/` 的 `PendingEndpointActivation` 是 "endpoint handoff 的唯一 owner"：`ActivationPhase`（ReleasingSource → ActivatingTarget → ReleasingTargetForRollback → RestoringSource → SynchronizingPresentation → AwaitingPresentationEffects）逐相位推进，`ActivationEvidence` 收集快照/surface revision 一致性证据，`ActivationBeginError::Preflight|Partial` 区分"可能已被对端观察到的半事务"。`EndpointLease{endpoint_id, generation, boot_id, minimum_revision}` 防陈旧 generation 的假激活。为什么这么重：多机窗口里切换机器若不等渲染一致会出现错帧或残影。

### 兼容性看能力不看版本号

attach.rs 测试 `saved_machine_compatibility_uses_capabilities_not_release_or_private_protocol` 把立场写进了名字：兼容性看 `endpoint_protocol_generation`/capabilities，不看 release 号——远端 herdr 是用户自己装的，版本五花八门，能力协商是唯一可靠的语言。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Supervisor 托管生命周期 | `EndpointSupervisors` in `endpoint/supervisor.rs` | 每 endpoint 独立重连状态机 |
| 纯函数策略 | `restart_policy.rs` | 无副作用易测试 |
| 两阶段事务 + 回滚 | `activation/model.rs` | 跨机器切换不闪残影 |
| 消息闸门 | `accepts_endpoint_message` in `message_policy.rs` | 非活动 endpoint 只收元数据 |
| trait 抽象传输 | `EndpointTransport` in `endpoint/registry.rs` | RAII 绑定 bridge 存活期 |

## 模块间交互

`remote/` 依赖 `ipc`（本地 socket）、`server::autodetect`（host.rs 在远端拉起 daemon）、`protocol::endpoint`（世代常量）、`config`。`client/endpoint/` 反向调用 `remote::connect_saved_ssh`——saved machine 的运行时腿在 client、安装升级腿在 remote/。`cli/machine.rs`（list/add/rename/remove/enable/disable）走 `EndpointCatalog` + `remote::prepare_saved_ssh`。`EndpointCatalog` 持久化在 `config::state_dir()/client/endpoints.json`，`#[serde(deny_unknown_fields)]` + 私有 0600 写入，`validate()` 拒绝密码内嵌/控制字符/超长标签。

## 扩展方式

- **新增远端平台（如 arm64 Windows）**：`RemotePlatform::from_uname`（`attach.rs:153`）、`asset_key()`、`prepare_windows_remote_herdr`，测试 `remote_platform_maps_uname_values`
- **machine 命令白名单扩容**：`cli/target.rs::validate_machine_command` 加 match 分支；注意 `ENDPOINT_COMMAND_TIMEOUT`（60s，`client/endpoint_commands.rs`）与 `MAX_RETIRED_REQUESTS_PER_ENDPOINT=128` 墓碑上限
- **调整重连退避 / Attention 判定**：`supervisor.rs::retry_delay` 与 `saved.rs::saved_ssh_failure_needs_attention` 的错误 kind/关键词列表

---

## 边缘机制速查

闭卷验证补充：

### restart policy 与身份

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `remote_server_restart_reason` | `remote/restart_policy.rs` | 四原因枚举：EndpointProtocol / SurfaceInterest / HealthCheck / DaemonDetach；remote_install_running_server_plan 在可 live handoff 时返回 LiveHandoff 而非 StopRequired
| `ProfileId::generate` | `client/endpoint.rs` | sha256(进程 id : UNIX_EPOCH 纳秒 : 原子序列号) 取 PROFILE_ID_BYTES 字节；storage_key() 返回 local / ssh:<id>——存储 key 刻意不含 SSH target
| `validate_profile_path_id / saved_bridge_path` | `remote/saved.rs` | 强校验 32 位十六进制；桥 socket 路径含 pid 与截取的 profile_id（remote_bridge_endpoint_path）
| `saved_ssh_failure_needs_attention` | `remote/saved.rs` | PermissionDenied 与 stderr 含 host key verification failed 等关键词 → Attention；普通网络超时不触发（重试可能自愈）

### supervisor 与 CLI 细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `退避常量` | `client/endpoint/supervisor.rs` | retry_delay 指数左移封顶 MAX_RETRY_DELAY，Local 用 MAX_LOCAL_RETRY_DELAY；STABLE_CONNECTION_PERIOD 后重置；Attention/Disabled 置 next_attempt=None 停止重试（record_status）
| `connect_once 接受条件` | `client/endpoint/supervisor.rs` | RenderEncoding::SemanticFrame + negotiation 须 supports_surface_interest（非本地还须 supports_health_check）；reconcile_profiles 在 target/session 变更时退役旧连接（generation 置 None）
| `machine add 流程` | `cli/machine.rs` | parse_add_args 支持 --label/--remote-session/= 号/positional（expand_equals_args）；缺省会话 DEFAULT_SESSION_NAME；prepare_saved_ssh 成功后重新 load_catalog 再 add_ssh——防 prepare 等待期间用户并发编辑 catalog 被覆盖；prepare 失败退出码非零
| `prepare_saved_ssh / saved_bridge_command` | `remote/attach.rs` | 以 prepare_remote_herdr(live_handoff=false, require_surface_interest=true) 调用；远端用 saved_bridge_command 起桥；最后 remote_server_status 校验；SshStdioBridge 绑定 BRIDGE_SOCKET_PERMISSION_MODE=0600、accept 轮询 BRIDGE_ACCEPT_POLL