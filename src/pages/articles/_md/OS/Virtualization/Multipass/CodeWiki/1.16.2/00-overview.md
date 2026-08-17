---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "Overview"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "虚拟化", "gRPC", "cloud-init"]
description: "Canonical 的轻量级 VM 管理器，一行命令拉起 Ubuntu，daemon-client + 平台抽象架构。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.16.2 · **协议** GPL-3.0 · **语言** C++20 · **代码量** ~56,000 行（src） · **仓库** [github.com/canonical/multipass](https://github.com/canonical/multipass)

---

## 总览

### 项目简介

Multipass 是 Canonical 开发的**轻量级虚拟机管理器**，面向开发者：一行 `multipass launch` 即可在 Linux/Windows/macOS 上拉起一个全新的 Ubuntu 环境。它在 Linux 用 KVM、Windows 用 Hyper-V、macOS 用 QEMU 或 Apple Virtualization.framework（AppleVZ）跑虚拟机，并自动拉取与更新 Ubuntu 镜像。由于支持 cloud-init metadata，Multipass 能在本机模拟一小片云——注入 SSH key、配置网络、跑用户脚本，VM 即开即用。

**项目边界**：Multipass 负责本地 VM 的生命周期（创建/启停/快照/挂载/镜像管理）与 cloud-init 初始化，**不负责**容器编排、集群调度或跨机分布式管理——它是单机开发者工具，不是多租户云平台。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 镜像查找 | `src/image_host/`、`src/simplestreams/` | 解析 Ubuntu Simple Streams，`multipass find` 列可用镜像 |
| 创建并启动 VM | `Daemon::launch` in `src/daemon/daemon.cpp` | 下载镜像 → cloud-init seed → 后端启动 |
| 命令行客户端 | `src/client/cli/` | 33 个子命令（launch/exec/stop/mount/info…），gRPC 调 daemon |
| 目录挂载 | `src/sshfs_mount/` | 反向 SFTP，UID/GID 双向映射 |
| VM 内执行命令 | `src/ssh/` + `src/client/cli/cmd/exec.cpp`、`shell.cpp` | libssh 封装，证书认证 |
| 快照 | `src/platform/backends/shared/base_snapshot.h` | NVI 模板方法，后端 savevm/delvm/loadvm |
| 跨平台后端 | `src/platform/backends/{qemu,hyperv,applevz,virtualbox}` | 编译时 `#ifdef` 选择，运行时 driver 切换 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Qt6 (Core/Concurrent/Network) | 核心 | 事件循环、`QCommandLineParser`、`QtConcurrent` 线程池、`QObject` signal/slot |
| gRPC + protobuf | 核心 | daemon↔client 双向流通信，`src/rpc/multipass.proto` 定义 29 个 streaming RPC |
| libssh (含 server) | 核心 | SSH 客户端 + SFTP server，`src/ssh/` 经 `Libssh` 单例间接调用 |
| yaml-cpp | 核心 | cloud-init YAML 配置生成（meta/vendor/user/network-data） |
| OpenSSL | 核心 | gRPC TLS + 客户端证书双向认证 |
| Boost (json/uuid) | 核心 | `VMMount` 序列化、实例 UUID |
| fmt | 核心 | 状态枚举 `formatter` 特化、日志 |
| xz-embedded | 可选 | `.xz` 镜像解压 |
| neargye-semver | 可选 | VM 内 sshfs FUSE 版本比较 |
| scope-guard | 可选 | RAII 事务写、资源回滚 |

### 顶层上下文图

Multipass 是单机工具，但与多个外部角色交互：

- **开发者（shell）**：经 `multipass` CLI 发命令，或经 GUI（macOS Flutter app）
- **Ubuntu Simple Streams**：`cloud-images.ubuntu.com` 的 `index.json`/`products.json`，镜像目录与 sha256 来源
- **Hypervisor**：KVM / Hyper-V / QEMU / AppleVZ / VirtualBox，由平台后端调用
- **VM 内 cloud-init**：读取 Multipass 生成的 seed ISO，完成首次初始化

---

## 快速上手

最简上手（macOS/Linux，已装 Multipass）：

```bash title="快速上手"
# 拉起一个当前 LTS Ubuntu（自动取镜像 + cloud-init）
multipass launch lts

# 看运行中的实例
multipass list

# 进 VM shell
multipass shell dancing-chipmunk

# VM 内执行命令
multipass exec dancing-chipmunk -- lsb_release -a

# 停止 / 删除
multipass stop dancing-chipmunk
multipass delete --purge dancing-chipmunk
```

预期输出 `Launched: <随机名>`，`multipass list` 显示 Running 状态与 IPv4。这证明 daemon 已拉镜像、起 VM、注入 cloud-init、SSH 就绪。

构建源码见 `BUILD.macOS.md` / `BUILD.linux.md` / `BUILD.windows.md`，核心是用 CMake + vcpkg 拉 Qt6/gRPC/libssh 等依赖。

---

## 架构设计解析

### 系统架构

Multipass 是经典的 **daemon-client 架构**：`multipassd` 守护进程（特权运行，持有 hypervisor 句柄与 VM 状态）+ `multipass` CLI 客户端（无状态，经 gRPC 与 daemon 通信）。这样设计的核心动机是**权限隔离**——只有 daemon 需要 root/特权访问 hypervisor，客户端普通用户即可；同时 VM 状态集中管理，多客户端（CLI + GUI）共享同一 daemon。

平台抽象层把"hypervisor 差异"隔离在编译时 `#ifdef` 与运行时 driver 设置之后：`Daemon` 只持有 `VirtualMachineFactory::UPtr` 抽象指针，不感知具体后端，新增/替换后端不污染 daemon 代码。

![Multipass 分层架构](/vibe-reading/images/articles/multipass/architecture.svg)

文字上，系统自上而下分五层加两组横切：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 客户端层 | `src/client/cli/` | 无状态 thin client，解析参数、分发命令、gRPC 调用、渲染输出 |
| 接口层 | `src/rpc/multipass.proto` | 隔离 daemon-client 协议，29 个双向流 RPC 定义稳定契约 |
| 编排层 | `src/daemon/` | `multipassd` 唯一控制平面，编排 VM 生命周期、镜像、挂载、快照 |
| 平台抽象层 | `src/platform/`（`backends/shared/` 基类） | 定义 `VirtualMachine`/`VirtualMachineFactory` 契约，SSH/快照/cloud-init 等待逻辑下沉基类 |
| 后端实现层 | `src/platform/backends/{qemu,hyperv,applevz,virtualbox}` | 各 hypervisor 具体实现，完全独立、同构变体 |
| 支撑模块（横切） | `src/sshfs_mount/`、`src/ssh/`、`src/iso/`、`src/daemon/default_vm_image_vault.*` + `src/image_host/` + `src/simplestreams/` | 挂载、SSH 连接、cloud-init seed、镜像管理，被编排层按需调用 |
| 基础设施（横切） | `src/utils/`、`src/settings/`、`src/logging/`、`src/process/`、`src/cert/` | 工具、配置、日志、进程抽象、证书，全局单例 |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 命令模式 | `include/multipass/cli/command.h` `Command` 抽象基类；`src/client/cli/client.cpp:89-121` `add_command<T>()` 注册 | 33 个子命令各自 `Command` 子类，统一 `run(ArgParser*)` 接口，`Client` 不感知具体命令类型 |
| 模板方法 | `BaseVirtualMachine::resize_disk`→`resize_disk_impl` in `src/platform/backends/shared/base_virtual_machine.h:119`；`Command::dispatch` in `include/multipass/cli/command.h:66-137` | 公共骨架（SSH 等待/gRPC streaming 循环）放基类，后端/命令只填少量纯虚钩子，避免重复 |
| 工厂方法 | `VirtualMachineFactory::create_virtual_machine` 纯虚 in `include/multipass/virtual_machine_factory.h`；`vm_backend()` in `src/platform/platform_osx.cpp:314` | 按 OS + driver 选择具体后端工厂，Daemon 持抽象指针与具体 hypervisor 解耦 |
| 桥接/接口隔离 | `SSHSession`（抽象）vs `PlainSSHSession`（impl）in `include/multipass/ssh/` | 上层依赖抽象头不 include libssh.h，隔离 C 库依赖 + 支持测试 mock |
| NVI（非虚接口） | `BaseSnapshot::capture/erase/apply` 标 `final` in `src/platform/backends/shared/base_snapshot.h:75-77` | 加锁/持久化/回滚等横切逻辑由基类控制，后端只实现 `_impl` |
| 单例 + 虚函数 seam | `Libssh : public Singleton<Libssh>` in `include/multipass/ssh/libssh_wrapper.h`；`Platform`、`CloudInitFileOps`、`SFTPUtils` 同模式 | 全量虚函数包 libssh C API，为可测试性留 seam（libssh 非 virtual 无法直接 mock） |
| 策略 | `MountType {Classic, Native}` in `include/multipass/vm_mount.h:31`；`Formatter` in `include/multipass/cli/formatter.h` | 挂载类型与输出格式可替换，`Daemon::make_mount` 二选一 |
| RAII | `std::unique_ptr<ssh_session_struct, deleter>` in `src/ssh/plain_ssh_session.cpp:47`；`scope_guard` 事务写 | libssh C 句柄自动释放，异常路径不泄漏 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `VirtualMachine` | 一个 VM 实例的抽象，含 10 态状态机 | Daemon 进程内，`operative_instances` map 持有 | 被 `Daemon` 编排，`BaseVirtualMachine` 实现，后端子类具体 |
| `VirtualMachineDescription` | 创建 VM 的全部输入（cores/mem/disk/image/cloud_init_iso/YAML configs） | 单次 `create_vm` 调用 | daemon 组装 → factory.configure/create 透传到后端 |
| `VMImage` | 镜像文件路径 + id + release 元数据 | vault 缓存 + 实例副本 | `DefaultVMImageVault` 管理，嵌入 `VirtualMachineDescription` |
| `Query` | 镜像查询（name/release/remote_name/Type） | 一次 `fetch_image` | client `LaunchRequest` → daemon `query_from` 转换 |
| `DaemonConfig` | daemon 的不可变依赖集（factory/vault/ssh_key_provider/logger…） | Daemon 生命周期内 const | `DaemonConfigBuilder::build` 一次性 freeze |
| `VMMount` | 一个挂载规格（source/target/uid_mappings/MountType） | 持久化在 `vm_instance_specs` | `MountHandler` 子类消费 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `VirtualMachine` | `include/multipass/virtual_machine.h` | `QemuVirtualMachine`/`HyperVVirtualMachine`/`AppleVZVirtualMachine`/`VirtualBoxVirtualMachine` | 经 `VirtualMachineFactory::create_virtual_machine` |
| `VirtualMachineFactory` | `include/multipass/virtual_machine_factory.h` | 4 后端 Factory（继承 `BaseVirtualMachineFactory`） | `vm_backend()` 按 OS/driver 返回 |
| `VMImageVault` | `include/multipass/vm_image_vault.h` | `DefaultVMImageVault`（final） | `BaseVirtualMachineFactory::create_image_vault` 默认返回 |
| `MountHandler` | `include/multipass/mount_handler.h` | `SSHFSMountHandler`（Classic）/ 后端 `make_native_mount_handler`（Native） | `Daemon::make_mount` 按 `MountType` 选择 |
| `SSHSession` / `SSHProcess` | `include/multipass/ssh/ssh_session.h`、`ssh_process.h` | `PlainSSHSession` / `PlainSSHProcess` | `BaseVirtualMachine::new_ssh_session` 构造 |
| `Command` | `include/multipass/cli/command.h` | `Launch`/`Stop`/`Exec`/… 33 个 | `Client::Client()` 构造函数 `add_command<T>()` |

核心抽象的扩展点契约：`VirtualMachineFactory` 与 `MountHandler` 定义了"如何加后端""如何加挂载类型"，具体见「典型修改场景」。

---

## 代码目录

```
multipass/
├── src/
│   ├── daemon/          # multipassd 守护进程（~7.9k 行）：Daemon/DaemonRpc/DaemonConfig
│   ├── client/
│   │   ├── cli/         # multipass CLI（main.cpp + cmd/ 下 33 个命令）
│   │   └── gui/         # macOS Flutter GUI（Dart，不在 CodeWiki 解读范围）
│   ├── platform/        # 平台抽象 + 后端（~24.7k 行）
│   │   ├── platform_{linux,osx,unix,win}.cpp   # OS 抽象 + vm_backend() 后端选择
│   │   └── backends/
│   │       ├── shared/                 # BaseVirtualMachine/BaseFactory/BaseSnapshot 基类
│   │       ├── qemu/ (linux/macos)      # QEMU 后端
│   │       ├── hyperv/                 # Hyper-V HCS 后端（Windows）
│   │       ├── applevz/               # Apple Virtualization.framework（macOS）
│   │       └── virtualbox/            # VirtualBox 后端
│   ├── sshfs_mount/     # 反向 SFTP 挂载（SftpServer/SshfsMount/MountHandler）
│   ├── ssh/             # libssh RAII 封装（SSHSession/SSHProcess/Libssh 单例）
│   ├── iso/             # cloud-init seed ISO 生成（手写 ISO9660+Joliet）
│   ├── image_host/      # 镜像源（UbuntuVMImageHost）
│   ├── simplestreams/   # Simple Streams 索引/manifest 解析
│   ├── rpc/             # multipass.proto（gRPC IDL，无 cpp）
│   ├── utils/           # 工具（yaml_node_utils 等）
│   ├── settings/        # 配置读写（Singleton）
│   ├── logging/         # 日志
│   ├── process/         # 跨平台进程抽象
│   ├── cert/            # 证书（CertProvider/CertStore）
│   └── network/         # 网络接口抽象
├── include/multipass/   # 公共头（跨模块契约层）：virtual_machine.h / vm_image_vault.h / cloud_init_iso.h ...
├── tests/               # 单元测试（tests/unit/）
├── 3rd-party/           # 第三方子模块
└── CMakeLists.txt
```

`include/multipass/` 是契约层：各模块的抽象接口与核心数据结构（`VirtualMachine`、`VMImageVault`、`CloudInitIso`、`SSHSession`、`Query`、`VirtualMachineDescription`）定义在此，供 daemon/platform/client 共享。`tests/` 见「测试体系」。

---

## 模块地图

![Multipass 模块依赖关系](/vibe-reading/images/articles/multipass/module-dependencies.svg)

依赖方向自上而下：Client 经 gRPC 调 Daemon，Daemon 持抽象指针调 Platform 后端与各支撑模块；Platform 的 `BaseVirtualMachine` 依赖 SSH 模块做 VM 内命令执行，SSHFS 也复用 SSHSession。各支撑模块互不直接耦合，均经 Daemon 编排。无 import 循环（graphify 检测为 None）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 守护进程 Daemon | `multipassd` 唯一控制平面，编排 VM 生命周期 + gRPC 服务端 | `Daemon::create_vm` in `src/daemon/daemon.cpp:3033` | 把协议、生命周期、镜像、挂载、后端调度统一在一个进程，是唯一不可拆的中央协调者 | [守护进程 Daemon](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/01-daemon) |
| 平台抽象与虚拟化后端 | 跨平台 VM 抽象 + 4 后端实现 | `VirtualMachineFactory::create_virtual_machine` | 三层抽象让 Daemon 与具体 hypervisor 解耦，新增后端不污染 daemon | [平台抽象与虚拟化后端](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/02-platform) |
| CLI 客户端 | 无状态 thin client，参数解析 + 命令分发 + gRPC | `Client::run` in `src/client/cli/client.cpp:136` | 自身不持 VM 状态，可独立编译部署，所有副作用委托 daemon | [CLI 客户端](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/03-client-cli) |
| 镜像管理 | Ubuntu 镜像查找/下载/缓存/过期 | `DefaultVMImageVault::fetch_image` in `src/daemon/default_vm_image_vault.cpp:155` | 封装 Simple Streams 协议与缓存策略，daemon 仅经 `fetch_image` 拿 `VMImage` | [镜像管理](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/04-image) |
| SSHFS 挂载 | 主机目录挂载到 VM，反向 SFTP + UID/GID 重写 | `SftpServer::run` in `src/sshfs_mount/sftp_server.cpp:563` | 封装复杂协议层（角色反转/沙箱/自愈），Daemon 只调 `activate`/`deactivate` | [SSHFS 挂载](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/05-sshfs-mount) |
| SSH 连接 | libssh C API 的 C++ RAII + 可测试 seam | `PlainSSHSession` 构造 in `src/ssh/plain_ssh_session.cpp:43` | 隔离 libssh 头依赖 + 单例虚函数 seam 支持单测 | [SSH 连接](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/06-ssh) |
| ISO 与 Cloud-init | 生成 NoCloud seed ISO | `CloudInitIso::write_to` in `src/iso/cloud_init_iso.cpp:538` | ISO 字节布局与 cloud-init YAML 语义正交，可独立测试、三路径复用 | [ISO 与 Cloud-init](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/07-iso-cloud-init) |

模块间动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

`multipassd` 启动装配链：

```
daemon_main.cpp (multipassd 入口)
  └─ DaemonConfigBuilder builder            # 收集命令行参数 → 填 builder 字段
       └─ builder.build()                   # daemon_config.cpp:101 一次性 freeze 为 const DaemonConfig
            ├─ factory = vm_backend(...)    # platform_*.cpp 按 OS + driver 选后端工厂
            ├─ vault = factory->create_image_vault(...)  # 默认 DefaultVMImageVault
            ├─ ssh_key_provider = OpenSSHKeyProvider(...) # 生成/读取 id_rsa
            └─ logger / server_address / data_directory
  └─ Daemon daemon{config}                  # daemon.cpp 构造
       ├─ load_db()                          # daemon.cpp:1282 读 multipassd-vm-instances.json 重建 VM 对象
       │    └─ 对 state==running 的实例调 on_restart 恢复 daemon 侧资源
       ├─ connect_rpc()                      # daemon.cpp:509 27 条 QObject::connect 绑 signal→slot
       └─ DaemonRpc::shutdown_and_wait 前启动 gRPC server（SSL + client cert）
```

对象装配关键点：配置来自命令行覆盖 → 平台默认值（`daemon_config.cpp:104-241` 一串 `if (x == nullptr) x = ...`）→ `build()` freeze 为 `const`，C++ 层面表达"运行时不可变配置"。`cli::parse` 只填 Builder 不调 build，让 `main_impl` 显式 `build()` 再 move 给 Daemon——构造失败不留半构造对象，测试可塞 mock。VM 状态两层持久化：规格 `VMSpecs` 序列化到 `multipassd-vm-instances.json`（`MP_FILEOPS.write_transactionally` 原子写），运行时 VM 对象进程退出即销毁，重启时 `load_db` 读 JSON 重建。

### 核心运行流程

Multipass 最重要的链路是 `multipass launch`——它横跨所有 7 个模块，是理解整个系统的主线。另一条是 `multipass mount`（挂载激活，见 [SSHFS 挂载](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/05-sshfs-mount)），第三条是 `multipass stop`（VM 停止，走 `Daemon::stop` → 后端 `shutdown`，状态机转换）。

#### 请求处理主链路：multipass launch

业务流程：用户 `multipass launch <image>` → CLI 解析 → gRPC 双向流 → daemon 鉴权 → 并发准备镜像与 cloud-init → 创建后端 VM → 启动 → 异步等 SSH/cloud-init → 挂载 → 回传进度与实例名。

![multipass launch 端到端数据流](/vibe-reading/images/articles/multipass/data-flow.svg)

文字上，链路跨 4 个进程/线程边界，数据结构逐层变换：

1. **Client 线程**：`main` (`main.cpp:52`) → `top_catch_all` → `Client` 构造（注册 33 命令、建 gRPC stub）→ `Client::run` (`client.cpp:136`) → `ArgParser::parse` 识别 `launch` → `Launch::run` (`launch.cpp:112`) 填 `LaunchRequest` proto → `Command::dispatch` (`command.h:71`) 模板方法跑 gRPC 双向流：`Write(request)` → `while(Read(reply))` 流式收 `LaunchProgress`/`CreateMessage` 更新 spinner → `Finish()` 映射 `grpc::Status` 到 `ReturnCode`。
2. **gRPC 线程 → Qt 主线程**：`DaemonRpc::launch` (`daemon_rpc.cpp:183`) 在 gRPC 线程 `verify_client_and_dispatch_operation` 验证 client cert + `Read(&request)`，然后 `emit_signal_and_wait_for_result` (`daemon_rpc.cpp:92`) 用 `std::promise<grpc::Status>` + `emit on_launch` 把调用经 Qt queued connection marshalling 到主线程 `Daemon::launch` slot，gRPC 线程 `future.get()` 阻塞等待。这是 **DaemonRpc/Daemon 分离的核心**：gRPC override 在 gRPC 线程，`Daemon` 是 `QObject` 受 Qt 线程亲和性约束，直接跨线程访问会破坏事件循环。
3. **Daemon 编排**：`Daemon::launch` (`daemon.cpp:1544`) → `create_vm` (`daemon.cpp:3033`)。`QtConcurrent::run` 在线程池跑 `make_vm_description` lambda（`daemon.cpp:3172-3288`）：`vault->fetch_image`（下载/缓存镜像，回传 `LaunchProgress`）→ `factory->configure`（生成 cloud-init seed ISO）→ `factory->prepare_source_image`/`prepare_instance_image`（qcow2 转换、resize）。`QFutureWatcher::finished` 回主线程 `factory->create_virtual_machine` 构造后端 VM（`QemuVirtualMachine` 等）→ `vm->start()` → 再 `QtConcurrent::run(async_wait_for_ready_all)` 异步等 `wait_until_ssh_up` + `wait_for_cloud_init`（SSH 探测 `/var/lib/cloud/instance/boot-finished`）+ `mount->activate`（SSHFS 挂载）。
4. **回传**：`context->set_value(grpc::Status::OK)` → `promise.set_value` 解阻塞 gRPC 线程 → `server->Write(LaunchReply{vm_instance_name})` → client `on_success` 打印 `Launched: <name>`。

关键数据结构变化：`LaunchRequest` proto（client）→ `Query`（`query_from` in `daemon.cpp:116` 转）→ `VMImage`（vault 返回）→ `VirtualMachineDescription`（daemon 组装，含 image/cloud_init_iso/YAML configs）→ 后端 `VirtualMachine` 对象。异步并发点：镜像准备与 VM 启动后等待均在 `QtConcurrent::run` 线程池；gRPC 线程与 Qt 事件循环经 promise/future 桥接；另有 `QTimer`（`daemon.cpp:1445`）每 6 小时跑镜像维护。

错误处理：daemon 侧 `Daemon::launch` try/catch `StartException`→`ABORTED`+资源清理、其他 `std::exception`→`FAILED_PRECONDITION`（`daemon.cpp:1544-1564`）；client 侧 `command.h:98-136` 把 `UNAVAILABLE` 映射到 socket 权限检查，`launch.cpp:570-623` 解析 `LaunchError` proto，`INVALID_NETWORK` 时弹 bridge 确认并 `set_permission_to_bridge(true)` **重试** `request_launch`。全局 `top_catch_all` (`main.cpp:65`) 兜底未捕获异常。

### 状态流

Multipass 的 `VirtualMachine` 有明确的 10 态生命周期状态机（`include/multipass/virtual_machine.h` `State` 枚举），状态转换合法性由 `BaseVirtualMachine::check_state_for_shutdown` (`base_virtual_machine.cpp:166`) 校验。

![VirtualMachine 状态机](/vibe-reading/images/articles/multipass/state-flow.svg)

核心转换：`off`→`starting`（`start`）→`running`（启动完成）；`running`→`stopped`（`shutdown`）；`running`→`delayed_shutdown`（延迟关机定时器）→`stopped`；`running`→`suspending`→`suspended`；`suspended`→`starting`（`resume`，QEMU 走 `refresh_start` 重置网络）；`running`→`restarting`→`running`；任意→`unavailable`（`set_available(false)`），`unavailable`→`off`（`set_available(true)`→`start`）。`unknown` 表示状态探测失败。`state` 字段 public，经 `state_mutex`/`state_wait` 保护，Daemon 与 VM 直接读写而无需 getter 层。

---

## 典型修改场景

扩展点的契约定义见「架构设计解析 > 核心概念」。

#### 场景 1：新增 CLI 子命令（如 `multipass pause`）

1. 新建 `src/client/cli/cmd/pause.h` + `pause.cpp`：继承 `cmd::Command`，实现 `run()`/`name()`/`short_help()`/`description()`，`run()` 内 `parse_args` 后 `dispatch(&RpcMethod::pause, request, on_success, on_failure, ...)`。
2. `src/client/cli/client.cpp:89-121` 构造函数加 `add_command<cmd::Pause>()`（`#include "cmd/pause.h"`），`sort_commands()` 自动排序。
3. `src/client/cli/cmd/CMakeLists.txt:16` 的 `add_library(commands STATIC ...)` 列表加 `pause.cpp`。
4. 若需新 RPC：`src/rpc/multipass.proto` 加 `rpc pause (stream PauseRequest) returns (stream PauseReply);` + message 定义，CMake 重新生成 stub。
5. daemon 侧 `src/daemon/daemon_rpc.h` 加 `pause` override + `on_pause` signal；`src/daemon/daemon.cpp:509` `connect_rpc` 加 `QObject::connect`；`Daemon` 加 `pause` slot。

> 关键：命令注册只在 `Client::Client()` 一处 `add_command`，`ArgParser::findCommand` 基于 `name()`/`aliases()` 自动发现。对应测试：`tests/unit/` 下命令相关用例。

#### 场景 2：新增虚拟化后端（新 hypervisor X）

**不动 `src/daemon/` 任何文件**——这正是 god node Facade 的价值：

1. 新建 `src/platform/backends/x/`：`x_virtual_machine.{h,cpp}`（继承 `BaseVirtualMachine`，实现 `start`/`shutdown`/`suspend`/`current_state`/`ssh_port`/`ssh_hostname`/`resize_disk_impl`/`make_specific_snapshot` 等纯虚钩子）；`x_virtual_machine_factory.{h,cpp}`（继承 `BaseVirtualMachineFactory`，实现 `create_virtual_machine`/`prepare_source_image`/`prepare_instance_image`/`hypervisor_health_check`/`remove_resources_for_impl`）。
2. 对应 OS 的 `src/platform/platform_<os>.cpp` 的 `vm_backend()` 加 `#ifdef X_ENABLED` 分支返回新工厂；`is_backend_supported()` 加判断。
3. `DaemonConfigBuilder::build` 把新 factory 透传给 `Daemon`，后者经 `config->factory->...` 多态调用——零改动。

对应测试：`tests/unit/` 下该后端用 `BaseVirtualMachine` mock 测试生命周期。

#### 场景 3：新增挂载类型（如 virtio-fs over vsock）

1. `include/multipass/vm_mount.h:31` 的 `MountType` 枚举加值。
2. `src/daemon/daemon.cpp:1981-1983` 解析 RPC `MountType` 加分支；`make_mount` (`daemon.cpp:3487-3496`) 加工厂分支返回新 `MountHandler` 子类。
3. 新建 `include/multipass/<new>_mount_handler.h` + 实现，继承 `MountHandler`，实现 `activate_impl`/`deactivate_impl`，按是否后端管理决定重写 `is_mount_managed_by_backend()`。
4. 若由 VM backend 管理（像 9p/virtio-fs）：在 `src/platform/backends/<hypervisor>/<hypervisor>_virtual_machine.cpp` 重写 `make_native_mount_handler`（参考 `qemu_virtual_machine.cpp:741`）。

对应测试：`tests/unit/` 下 `MountHandler` 相关。

---

## 测试体系

```
tests/
├── unit/              # 单元测试（gtest），main.cpp 入口
└── ...                # 集成/端到端测试
```

Multipass 的可测试性核心是**单例 + 虚函数 seam**：`Libssh`、`CloudInitFileOps`、`SFTPUtils`、`Platform`、`Settings`、`FileOps`、`ProcessFactory` 等全局依赖都是 `Singleton<T>` + 全 virtual 方法，测试侧链接 `_test` 变体（如 `libssh_wrapper_test`）注入 mock 子类覆盖。`CMakeLists.txt` 注释 `TODO: drop premock in favor of MP_LIBSSH` 说明这是刻意为测试留的 seam——libssh 是 C 库无法直接 mock，加一层虚函数让涉及 SSH 的代码可单测。

| 代码层 | 测试方式 |
| --- | --- |
| `BaseVirtualMachine` 生命周期/状态机 | mock 后端工厂 + `Libssh` mock |
| `Command` 分发/gRPC 错误映射 | mock `Rpc::StubInterface` |
| `DefaultVMImageVault` 缓存/single-flight | mock `URLDownloader`/`VMImageHost` |
| `SftpServer` 协议层 | mock `SSHSession` |
| `CloudInitIso` 字节布局 | 纯逻辑，直接单测 |

理解某个类时优先看其对应测试——很多 mock seam 实际是"可执行文档"。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**（请求如何从命令走到 VM 启动）
  `src/client/cli/main.cpp`（`main`/`main_impl`）→ `src/client/cli/client.cpp:136`（`Client::run`）→ `include/multipass/cli/argparser.h`（`parse`/`findCommand`）→ `include/multipass/cli/command.h:66-137`（`dispatch` 模板方法）→ `src/daemon/daemon_rpc.cpp:92-112`（`emit_signal_and_wait_for_result` 线程桥接）→ `src/daemon/daemon.cpp:3033`（`create_vm`）→ `src/platform/backends/shared/base_virtual_machine_factory.cpp:39`（`configure` 生成 ISO）→ `src/platform/backends/qemu/qemu_virtual_machine.cpp:269`（`start`）
- **第二遍：理解核心数据结构**
  `include/multipass/virtual_machine.h`（`State` 枚举 + 纯虚接口）→ `include/multipass/virtual_machine_description.h`（创建 VM 的全部输入）→ `include/multipass/vm_image.h`（`VMImage`）→ `include/multipass/query.h`（`Query` 镜像查询）→ `include/multipass/vm_image_vault.h`（`VMImageVault` 抽象）
- **第三遍：理解扩展机制**
  `include/multipass/virtual_machine_factory.h`（工厂抽象）+ `src/platform/platform_osx.cpp:314`（`vm_backend` 后端选择）→ `src/platform/backends/shared/base_snapshot.h:75-84`（NVI + `_impl` 钩子）→ `include/multipass/mount_handler.h:55-69`（`MountHandler` 策略）→ `include/multipass/cli/command.h`（命令模式扩展点）
- **第四遍：选重点模块深入阅读**（本文档系列）
  从「模块地图」表的"深入阅读"链接进入各模块文档。Daemon 是编排核心、Platform 是抽象典范、SSHFS 是反向 SFTP 的复杂协议实现，建议优先读这三篇。

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| daemon-client 架构 | 特权守护进程 `multipassd` 管理资源，无状态客户端 `multipass` 经 IPC 调用，实现权限隔离 |
| Simple Streams | Ubuntu 镜像发布协议，`index.json`→`products.json`，每条镜像自带 sha256/size/path |
| NoCloud datasource | cloud-init 的本地数据源类型，读 ISO 里的 `meta-data`/`user-data`/`vendor-data`/`network-config` |
| cloud-init | VM 首次启动的初始化机制，注入 SSH key、配网络、跑用户脚本，完成后写 `boot-finished` 标记 |
| QMP | QEMU Machine Protocol，JSON 控制 QEMU 进程（`qmp_capabilities` 握手、`system_powerdown` 关机） |
| AppArmor | Linux 强制访问控制，`sshfs_server` 进程用它限制只能访问用户指定的 `source_path` |
| bidirectional streaming | gRPC 双向流，client 与 server 可在单次 RPC 内多次读写（用于进度回传、密码交互） |
| NVI（Non-Virtual Interface） | 非虚接口模式，公有方法非虚（`final`），调 protected 虚方法，控制横切逻辑 |
| single-flight | 并发去重模式，同 id 的并发请求只执行一次，其他复用 `QFuture` 结果 |

### 参考资料

- [Multipass 官方文档](https://canonical.com/multipass/docs/stable/)（安装、driver、tutorial）
- [Ubuntu Simple Streams 协议](https://cloud-images.ubuntu.com/streams/v1/)（`index.json`/`products.json` 结构）
- [cloud-init NoCloud datasource](https://cloudinit.readthedocs.io/en/latest/reference/datasources/nocloud.html)
- [gRPC 概念：双向流](https://grpc.io/docs/what-is-grpc/core-concepts/#bidirectional-streaming-rpc)
- [graphify](https://github.com/sopaco/graphify)（本文用其 AST 知识图谱辅助模块识别与 import cycle 检测）
