---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "SSHFS 挂载"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "SFTP", "libssh", "FUSE"]
description: "反向 SFTP + UID/GID 双向重写 + 路径沙箱 + 崩溃自愈，主机目录挂载到 VM。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/00-overview)

---

## 模块定位

`sshfs_mount` 模块（`src/sshfs_mount/`）封装了"主机进程 ↔ VM 内 sshfs"的反向 SFTP 通信、UID/GID 双向重写、路径沙箱与崩溃自愈这一整套复杂协议层，让 Daemon 只需把它当 `MountHandler` 子类调 `activate`/`deactivate`，与 Native mount（9p/virtio-fs，由 VM backend 管理）按 `MountType` 策略替换。

## 模块架构

五个核心组件：

- **SftpServer**（`src/sshfs_mount/sftp_server.h`，god node 58 edges）：SFTP 协议层 + 文件操作 + UID/GID 重写 + 路径沙箱，`run()` 主循环 `process_message` switch 17 个 SFTP 消息类型
- **SshfsMount**（`sshfs_mount.h`）：把 `SftpServer` 放独立线程跑，`stop()`/`alive()`，`State{Unstarted,Running,Stopped}`
- **SSHFSMountHandler**（`include/multipass/sshfs_mount/sshfs_mount_handler.h`）：daemon 侧 handler，继承 `MountHandler`，用外部进程 `sshfs_server` 实现 mount
- **MountHandler**（`include/multipass/mount_handler.h`）：抽象基类（Template Method），`activate()`/`deactivate()` 非虚（加锁 + active flag），子类实现 `activate_impl`/`deactivate_impl`
- **VMMount**（`include/multipass/vm_mount.h`）：数据载体，`MountType{Classic,Native}` + `source_path` + `gid_mappings`/`uid_mappings`，boost::json 序列化持久化

跨平台进程规格 `SSHFSServerProcessSpec`（`src/platform/backends/shared/sshfs_server_process_spec.h`）继承 `ProcessSpec`，定义外部 `sshfs_server` 进程的 `program()`/`arguments()`/`environment()`/`apparmor_profile()`。

## 调用链路

从 daemon 收到 mount 请求到 SFTP 数据读写：

```
Daemon::create_missing_mounts                         daemon.cpp:3454
  └─ Daemon::make_mount                               daemon.cpp:3487
       ├─ MountType::Classic → new SSHFSMountHandler  sshfs_mount_handler.cpp:120
       └─ MountType::Native  → vm->make_native_mount_handler  qemu_virtual_machine.cpp:741

mount->activate(server)                               mount_handler.h:55 (加锁模板方法)
  └─ SSHFSMountHandler::activate_impl                 sshfs_mount_handler.cpp:143
       ├─ vm->new_ssh_session() / has_sshfs / install_sshfs_for  (VM 内装 multipass-sshfs snap)
       ├─ config.host = vm->ssh_hostname(); config.port = vm->ssh_port()
       ├─ platform::make_sshfs_server_process(config)  sshfs_mount_handler.cpp:164
       │     └─ MP_PROCFACTORY.create_process(SSHFSServerProcessSpec)
       └─ start_and_block_until_connected(process)    # 等子进程 stdout 输出 "Connected"

[新进程] sshfs_server main()                          sshfs_server.cpp:75
  ├─ new PlainSSHSession(host,port,...)                # 反向 SSH: 主机→VM
  └─ new SshfsMount(...) → make_sftp_server 工厂       sshfs_mount.cpp:125-162
       ├─ get_sshfs_exec_and_options                  # 探测 VM 内 sshfs 路径 + FUSE 版本
       ├─ mpu::make_target_dir + set_owner_for        # VM 内创建目标目录
       └─ new SftpServer(...)                          sftp_server.cpp:299
            ├─ create_sshfs_process: ssh_session->exec("sudo <sshfs_line> :src tgt")
            │     (在 VM 内拉起 sshfs 当 SFTP client)  sftp_server.cpp:234-245
            └─ make_sftp_session: sftp_server_new      # libssh 作 SFTP server  sftp_server.cpp:58-90

[循环] SftpServer::run()                              sftp_server.cpp:563
  └─ sftp_get_client_message → process_message        # switch 17 个 SFTP 消息
       └─ handle_open/read/write/mkdir/...
            ├─ get_validated_path → validate_path     # 路径沙箱
            ├─ MP_FILEOPS.* 读写主机本地文件
            ├─ mapped_uid_for/mapped_gid_for          # host→guest, 回包重写 attr
            └─ reverse_uid_for/reverse_gid_for        # guest→host, chown 时重写
```

## 核心实现

### 反向 SFTP（server/client 角色反转）

主机进程 `sshfs_server` 作 libssh SFTP server（`make_sftp_session` in `sftp_server.cpp:58-90`，`sftp_server_new`），VM 内 `sshfs` 作 SFTP client（`create_sshfs_process` in `sftp_server.cpp:234-245`，经 `ssh_session->exec("sudo sshfs ...")` 拉起）。

**为什么反转**：VM 常在 NAT 后或无持久 SSH server；主机总是持有 VM 的 SSH 凭据（`config.private_key`），主机→VM 连接天然成立。反向 SFTP 让连接方向不变、又把 SFTP 协议层与沙箱放在主机侧（`apparmor_profile` in `sshfs_server_process_spec.cpp:87-154` 限制只暴露 `source_path`）。VM 内只需装 `sshfs` snap，无需跑额外 server。

### UID/GID 双向映射 + 权限闸

`id_mappings` 是 `vector<pair<int,int>>`，`first`=host id，`second`=guest id（`include/multipass/id_mappings.h:34`）。

- 正向（host→guest）：`mapped_uid_for`/`mapped_gid_for`（`sftp_server.cpp:352-360`）→ 回包 `sftp_attributes` 时把 `QFileInfo::ownerId()` 翻译成 VM 看到的 uid/gid
- 反向（guest→host）：`reverse_uid_for`/`reverse_gid_for`（`:362-370`）→ VM 内 chown 时把请求的 uid/gid 翻译回主机 id 后做实际 `MP_PLATFORM.chown`
- 权限闸：`has_id_mappings_for`（`:400-404`）在 `handle_open`/`mkdir`/`opendir`/`remove`/`rename`/`setstat` 等顶部检查主机文件 owner/group 是否有映射，无映射即 `reply_perm_denied`

**为什么**：防止 VM 内 root 借 SFTP 读主机其他用户文件；同时 VM 内 `ubuntu` 的 uid（1000）与 macOS 主机 uid（501）不同，不映射会导致 VM 内文件显示成 alien uid、权限错乱。

### SSHFS 进程崩溃自愈

`SftpServer::run`（`sftp_server.cpp:563-625`）检测到 `sftp_get_client_message` 返回 `nullptr` 且 `sshfs_process->exit_code(250ms) != 0` 时（`:580-616`）：用 `findmnt --source :<source_path>` 找 VM 内残留 sshfs 挂载点 → `sudo umount` 清理 → 重新 `create_sshfs_process` + `make_sftp_session`。**为什么**：VM 内 sshfs 偶发挂掉（FUSE、网络抖动），只在 SFTP 层重连，对 daemon 完全透明，不必重启整个 mount 生命周期。

### 路径沙箱（协议层 + AppArmor 双重防御）

`get_validated_path`（`sftp_server.cpp:463-477`）每个请求先 `get_absolute_path`（相对路径补 `source_path` 前缀）再 `validate_path`（`:406-451`）用 `std::mismatch` 检查 `final_path` 是否以 `source_path` 为前缀。`follows_symlinks`（`:275-296`）按 SFTP 消息类型区分是否 follow symlink，处理 broken symlink 沿父目录上溯拒绝。**为什么**：`sshfs_server` 已有 AppArmor 沙箱，但 SFTP server 仍要在协议层拒绝 path traversal，纵深防御。

### 挂载生命周期 = 外部进程生命周期 + 持久化 specs

`activate_impl` 启动外部 `sshfs_server` 进程（`make_sshfs_server_process` + `start_and_block_until_connected`），`deactivate_impl` `terminate`+`wait_for_finished(5000)`，失败再 `kill()`。`VMMount` specs 持久化在 `vm_instance_specs[name].mounts`（`daemon.cpp:1986,2006`），VM 启动时 `init_mounts`→`create_missing_mounts` 重建 handler。**为什么**：VM 重启后自动重挂，无需用户重发 RPC。进程退出码 `9` = `SSHFSMissingError`（`sshfs_mount_handler.cpp:213` 检测、`sshfs_server.cpp:141` `exit(9)`），daemon 据此提示用户在 VM 内装 `multipass-sshfs` snap。

## 模块间交互

- 被 Daemon 调用：mount RPC `Daemon::mount`→`make_mount`+`activate`；VM 启停 `init_mounts`/`stop_mounts`/`update_mounts`；running 状态恢复 `mount->activate`（捕获 `SSHFSMissingError` 提示）
- 依赖 SSH 模块：`SSHSession`/`PlainSSHSession`/`SSHClientKeyProvider`/`libssh_wrapper`
- 依赖 settings（`mounts_key` privileged mounts 总开关）、utils（VM 内路径探测/目录创建/FUSE 版本比较）、`MP_FILEOPS`/`MP_PLATFORM`（文件/权限原语）
- 与 platform/shared 的 `sshfs_server_process_spec` 间接使用（AppArmor 沙箱限制 `source_path`）

## 扩展方式

新增挂载类型（如 virtio-fs over vsock）：`include/multipass/vm_mount.h:31` 的 `MountType` 枚举加值 → `src/daemon/daemon.cpp:1981-1983` 解析加分支 + `make_mount`（`:3487-3496`）加工厂分支 → 新建 `MountHandler` 子类实现 `activate_impl`/`deactivate_impl` → 若由后端管理则重写 `make_native_mount_handler`（参考 `qemu_virtual_machine.cpp:741`）。改 UID/GID 映射逻辑：`include/multipass/id_mappings.h:34` 换元素类型 + `sftp_server.cpp:247-273` 的 `mapped_id_for`/`reverse_id_for` 核心查找逻辑 + `sshfs_server_process_spec.cpp:34-42` 序列化 + `sshfs_server.cpp:44-72` 反序列化。
