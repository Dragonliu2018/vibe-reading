---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "SSH 连接"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "libssh", "RAII", "SSH"]
description: "libssh C API 的 C++ RAII 封装 + 单例虚函数 seam，重连逻辑在调用方。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/00-overview)

---

## 模块定位

SSH 模块（`src/ssh/`）将 libssh 的 C API 封装为 C++ RAII 资源 + 可测试的虚函数接缝（seam），让上层（daemon、sshfs_mount、client CLI）以 `SSHSession`/`SSHProcess`/`SSHClient`/`SFTPClient` 面向接口编程，不直接碰 libssh 句柄。

> 注：graphify god node 列出的 `ssh_channel (21 edges)` 不是独立类，是 libssh C 类型被 21 处引用。真正的聚合节点是 `Libssh` 单例（`include/multipass/ssh/libssh_wrapper.h`），聚合 ~60 个虚函数覆盖 session/channel/event/connector/pki/sftp 全栈。

## 模块架构

抽象接口 + Plain 实现 + 单例 seam：

- **SSHSession**（`include/multipass/ssh/ssh_session.h`）：抽象接口，`exec`/`is_connected`/`is_moved`/`operator ssh_session`/`force_shutdown`
- **SSHProcess**（`ssh_process.h`）：抽象接口，`exit_recognized`/`exit_code`/`read_std_output`/`read_std_error`
- **PlainSSHSession / PlainSSHProcess**（`plain_ssh_session.h`、`plain_ssh_process.h`）：具体实现，`unique_ptr<ssh_session_struct, deleter>` RAII 持句柄
- **Libssh**（`libssh_wrapper.h`，god node）：`Singleton<Libssh>`，~60 个虚函数包 libssh C 函数，宏 `MP_LIBSSH` 展开 `Libssh::instance()`
- **SSHClient**（`ssh_client.h`）：交互式 SSH（shell + exec，带 console/PTY）
- **SFTPClient**（`sftp_client.h`）：SFTP 文件传输（push/pull/from_cin/to_cout）
- **SSHKeyProvider**（`ssh_key_provider.h`）：认证密钥抽象，`OpenSSHKeyProvider`（daemon 侧文件持久化 RSA 2048）/ `SSHClientKeyProvider`（client 侧 base64 blob 临时导入）

## 调用链路

建立连接 → 执行命令 → 取回输出：

```
PlainSSHSession::PlainSSHSession(host, port, user, key_provider)  plain_ssh_session.cpp:43
  ├─ session = MP_LIBSSH.ssh_new()                # RAII, deleter = ssh_free
  ├─ set_option(HOST/PORT/USER/TIMEOUT/NODELAY/CIPHERS/SSH_DIR)
  ├─ throw_on_error(ssh_connect, ...)             # ::ssh_connect()
  ├─ set_option(TIMEOUT, &established_max)         # 连上后切到 ~无限超时
  └─ throw_on_error(ssh_userauth_publickey, ..., key_provider.private_key())

PlainSSHSession::exec(cmd)                         plain_ssh_session.cpp:127
  ├─ unique_lock lock{mut}                         # 锁住 session
  └─ return make_unique<PlainSSHProcess>(*session, cmd, std::move(lock))

PlainSSHProcess 构造 → make_channel               plain_ssh_process.cpp:73,99
  ├─ MP_LIBSSH.ssh_is_connected(session)
  ├─ channel = MP_LIBSSH.ssh_channel_new(session)  # RAII
  ├─ throw_on_error(ssh_channel_open_session)
  └─ throw_on_error(ssh_channel_request_exec, cmd.c_str())

PlainSSHProcess::exit_code(timeout)               plain_ssh_process.cpp:129
  └─ read_exit_code(timeout, true)
       ├─ ExitStatusCallback cb{channel, exit_result}   # 注册 channel_exit_status 回调
       ├─ event = MP_LIBSSH.ssh_event_new()             # RAII
       ├─ MP_LIBSSH.ssh_event_add_session(event, session)
       └─ while ssh_event_dopoll(event, timeout)        # 轮询直到回调写 exit_result

PlainSSHProcess::read_std_output()                plain_ssh_process.cpp:207
  └─ read_stream(out) → ssh_channel_read_timeout 循环
```

交互式 SSHClient：`SSHClient::exec`（`ssh_client.cpp:86`）→ `exec_string`（空则 `ssh_channel_request_shell` 交互 shell，否则 `ssh_channel_request_exec`）→ `handle_ssh_events`（3 个 connector 桥接 fd↔channel，`ssh_event_dopoll` 60s 轮询）→ `get_ssh_exit_code`。

## 核心实现

### Libssh 单例虚函数 seam：为可测试性而非解耦

`Libssh` 类把 libssh 每一个 C 函数包成 virtual 方法（~60 个），`libssh_wrapper.cpp` 里每个方法体一行 `return ::ssh_xxx(...)`。测试侧链接 `libssh_wrapper_test`（每个方法可被 mock 子类覆盖）。**为什么**：libssh 是 C 库，函数非 virtual、无法直接 mock；不加这层，涉及 SSH 的代码（reconnect、channel 生命周期、event 轮询）完全无法单测。代价是 `Libssh` 成 god node（60+ 方法），所有调用多一次虚函数间接。

### RAII 资源封持 + 锁传递

每个 libssh 句柄（session/channel/key/event/connector/sftp）都用 `unique_ptr<T, deleter>` 管理，析构自动释放（`plain_ssh_session.cpp:47`、`plain_ssh_process.cpp:80`）。`PlainSSHSession::exec` 把 `unique_lock<mutex>` move 给 `PlainSSHProcess`，`exit_code`/`release_channel` 再 move 出——进程存活期间持锁，避免 exec 与 exit_code 之间有窗口期。**为什么**：libssh session 非线程安全，需串行化 channel 操作；锁传递而非重新加锁避免窗口期。`std::variant<monostate, int, exception_ptr> exit_result` 缓存退出码/异常，`exit_code` 可多次调不重复 poll。

### 重连逻辑在调用方而非 SSH 模块

`PlainSSHSession` 本身不做重连：构造时连接 + 认证，析构时 disconnect，`is_connected()` 只查当前状态。重连放在 `BaseVirtualMachine::ssh_exec_process`（`base_virtual_machine.cpp:243-281`）——exec 时若 `!is_connected()` 则 `renew_ssh_session()`（丢弃旧 session、new 一个），且 exec 抛 `SSHException` 后尝试一次重试（注释 `disconnections are often only detected after attempted use`）。**为什么**：重连策略与 VM 生命周期强耦合，放 SSH 模块会引入对 VM 的反向依赖。`new_ssh_session()` 还在加锁状态下检查 `MP_UTILS.is_running(current_state())`，避免对 stopped VM 浪费连接。

### 认证只用公钥 + 两段式超时

`PlainSSHSession` 构造调 `ssh_userauth_publickey(nullptr, key_provider.private_key())`，密钥经 `SSHKeyProvider` 抽象注入。**为什么只用公钥**：Multipass 管理本地 VM，认证密钥在 VM 创建时经 cloud-init 注入，不需密码交互；`SSHKeyProvider` 抽象让 daemon（`OpenSSHKeyProvider`，密钥存 `cache_dir/ssh-keys/id_rsa`）和 client（`SSHClientKeyProvider`，从 daemon 下发的 base64 blob 临时导入）共用同一认证路径，只换密钥来源。

连接超时两段式：构造时先设 `SSH_OPTIONS_TIMEOUT = 5`（秒，防 VM boot 时 `ssh_connect` 永久阻塞），`ssh_connect` 后改设为 `numeric_limits<long>::max()`（避免连接态下误超时）。**为什么**：libssh 的 `SSH_OPTIONS_TIMEOUT` 同时管 connect 和 connected 两阶段无法分别配，两段式赋值是唯一 workaround。

## 模块间交互

被谁调用：`BaseVirtualMachine`（`new_ssh_session`/`ssh_exec_process`/`renew_ssh_session`/`drop_ssh_session`，VM 持缓存 session 复用）、`sshfs_mount`（`SshfsMount`/`SftpServer` 接收已建 session）、client CLI `exec`/`shell`/`transfer`（直接 SSH 到 VM 不经 daemon）、`utils`（`run_in_ssh_session`）、Windows `smb_mount_handler`（用 SFTP 替代 sshfs）。依赖 libssh 第三方、`SSHKeyProvider`、`Singleton`、`platform`（`MP_PLATFORM.shutdown_socket`）、`standard_paths`、`exceptions`（`SSHException`/`SSHProcessTimeoutException`）。

## 扩展方式

换底层 SSH 库（libssh → libssh2）：因 `Libssh` 是虚函数 seam，可先写 `LibsshImpl2` 子类逐步替换；改 `plain_ssh_session.h` 的 `session` 成员类型、`plain_ssh_process.h` 的 `ChannelUPtr` 类型、`ssh_key_provider.h` 的 `ssh_key` 返回类型；**不需要改** `SSHSession`/`SSHProcess` 抽象、`SSHClient`/`SFTPClient` 公共接口、上层 `BaseVirtualMachine`/daemon/sshfs_mount。加认证方式（密码/GSSAPI）：`plain_ssh_session.cpp:82-86` 构造加 `ssh_userauth_password`/`ssh_userauth_gssapi` + `Libssh` 加虚函数 + `libssh_wrapper.cpp` 加 delegate + `SSHKeyProvider` 扩展凭据接口。调重连/超时策略：`base_virtual_machine.cpp:243-281` `ssh_exec_process` 改循环次数/退避 + `plain_ssh_session.cpp:61` connect_timeout + `ssh_process.h:49` exit_code 默认超时。
