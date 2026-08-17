---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "守护进程 Daemon"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "虚拟化", "gRPC", "Qt"]
description: "multipassd 守护进程：gRPC 服务端 + VM 生命周期编排 + 不可变配置装配。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/00-overview)

---

## 模块定位

Daemon 模块（`src/daemon/`）是 `multipassd` 的唯一控制平面：它把 gRPC 协议、VM 生命周期编排、镜像下载/缓存、SSHFS 挂载、Settings、跨平台后端调度统一在一个进程内。向上对 client 暴露稳定的双向流 RPC 接口，向下用 `VirtualMachineFactory::UPtr` 抽象指针隔离各平台 hypervisor 后端——这是 daemon-client 架构中唯一不可拆分的中央协调者。

## 模块架构

三个核心组件 + 线程模型：

- **DaemonRpc**（`src/daemon/daemon_rpc.h:53`）：继承 `multipass::Rpc::Service`（gRPC 生成），在 gRPC 线程执行 RPC override。职责仅限协议处理 + 客户端证书校验 + signal/future 桥接，**不碰 VM 状态**。
- **Daemon**（`src/daemon/daemon.h:47`）：继承 `QObject` + `VMStatusMonitor`，在 Qt 主线程执行。持有 `std::unique_ptr<const DaemonConfig> config`、`InstanceTable operative_instances`/`deleted_instances`，编排 VM 全生命周期。
- **DaemonConfig / DaemonConfigBuilder**（`src/daemon/daemon_config.h:43-88`）：不可变依赖集（factory/vault/ssh_key_provider/logger/server_address/data_directory），`Builder::build` 一次性 freeze 为 `const`。
- **InstanceTable**：`name → std::unique_ptr<VirtualMachine>` 的 map，Daemon 的运行时 VM 注册表。

线程模型是本模块的设计核心：gRPC override 在 gRPC 线程跑，而 `Daemon` 是 `QObject` 受 Qt 线程亲和性约束——直接跨线程访问会破坏事件循环。解法见核心实现。

## 调用链路

以 `multipass launch` 为例，Daemon 侧三层调用链（gRPC override → Qt signal/slot → Daemon 编排 → 后端）：

```
[gRPC 线程] DaemonRpc::launch                          daemon_rpc.cpp:183
  └─ verify_client_and_dispatch_operation(on_launch)   daemon_rpc.cpp:545
       ├─ server->Read(&request)                       # 读 LaunchRequest
       ├─ client_cert_store->verify_cert(cert)         # 失败→UNAUTHENTICATED
       └─ emit_signal_and_wait_for_result              daemon_rpc.cpp:92
            ├─ std::promise<grpc::Status> promise
            ├─ emit on_launch ────────────────────────→ [Qt 主线程] Daemon::launch slot
            └─ future.get()  (阻塞 gRPC 线程)                          daemon.cpp:1544
                                                                       └─ create_vm        daemon.cpp:3033
  # data: LaunchRequest* proto → DaemonRpcContext{promise,...}

Daemon::create_vm                                        daemon.cpp:3033
  ├─ validate_create_arguments → CheckedArgs            daemon.cpp:3042
  ├─ preparing_instances.insert(name)                    daemon.cpp:3088
  ├─ QtConcurrent::run(make_vm_description)             # 异步线程池  daemon.cpp:3172-3288
  │    ├─ config->vault->fetch_image(query,...)         # Image 模块, 返回 VMImage
  │    ├─ config->factory->configure(vm_desc)            # ISO 模块, 生成 cloud-init seed
  │    └─ factory->prepare_source_image / prepare_instance_image
  │   # data: → VirtualMachineDescription (含 image/cloud_init_iso/YAML)
  ├─ ◀ QFutureWatcher::finished ◀────────────────────────────────────
  ├─ config->factory->create_virtual_machine(vm_desc)   # Platform 后端  daemon.cpp:3116
  │   # data: VirtualMachineDescription → VirtualMachine::UPtr
  ├─ operative_instances[name]->start()                 daemon.cpp:3129
  └─ QtConcurrent::run(async_wait_for_ready_all)        daemon.cpp:3141
       ├─ vm->wait_until_ssh_up                         # BaseVirtualMachine
       ├─ vm->wait_for_cloud_init                       # SSH 探测 boot-finished
       └─ mount->activate(server)                       # SSHFS 模块
  └─ context->set_value(grpc::Status::OK) → promise.set_value
```

数据类型逐层变换：`LaunchRequest` proto → `Query`（`query_from` 转）→ `VMImage`（vault 返回）→ `VirtualMachineDescription`（daemon 组装）→ 后端 `VirtualMachine`。`connect_rpc`（`daemon.cpp:509-539`）用 27 条 `QObject::connect` 把所有 RPC signal 绑到对应 Daemon slot。

## 核心实现

### DaemonRpc：gRPC 线程 → Qt 主线程桥接

`DaemonRpc` 的每个 override（`launch`/`start`/`stop`/`delet`/`snapshot`/`restore`…）都走 `verify_client_and_dispatch_operation`（`daemon_rpc.cpp:545-575`）：读请求 → 验证 client cert → `emit_signal_and_wait_for_result`（`daemon_rpc.cpp:92-112`）`emit` Qt signal 并 `future.get()` 阻塞。

**为什么这样设计**：gRPC override 在 gRPC 线程执行，`Daemon` 是 `QObject` 受 Qt 线程亲和性约束——直接跨线程访问会破坏 Qt 事件循环。`emit` queued signal 让 Qt 把调用 marshalling 到主线程 `Daemon::launch` slot；`std::promise<grpc::Status>` + `future.get()` 把结果桥回 gRPC 线程。这样 Daemon 状态只在主线程被修改，gRPC 线程阻塞在自己身上不拖死事件循环。`DaemonRpcContextImpl`（`include/multipass/daemon_rpc_context.h:37`）持 promise 引用 + mutex 保护 `set_value`。

### Daemon::create_vm：VM 生命周期编排

`create_vm`（`daemon.cpp:3033-3289`）是所有创建类命令（`launch`/`start` 已删实例）的共用编排核心：参数校验 → `preparing_instances.insert` → `QtConcurrent::run(make_vm_description)` 在线程池跑镜像下载 + cloud-init ISO + 镜像准备 → `QFutureWatcher::finished` 回主线程 `create_virtual_machine` + `start` → 再 `QtConcurrent::run(async_wait_for_ready_all)` 异步等 SSH/cloud-init + 挂载。

**为什么镜像准备异步**：`fetch_image` 可能下载几 GB，是 launch 最耗时操作，放线程池不阻塞主线程事件循环（其他 RPC 仍可响应）。`QFutureWatcher::finished` 信号是跨线程回主线程的钩子。`async_wait_for_ready_all`（`daemon.cpp:3605`）用 `QFutureSynchronizer` 管理多 VM 并行等待，`async_wait_for_ssh_and_start_mounts_for`（`daemon.cpp:3518`）串行跑 SSH up → cloud-init → mount。

### VM 状态两层持久化

Daemon 把规范化"规格"（`VMSpecs`：cores/mem/disk/MAC/mounts/state/deleted/metadata）与运行时 VM 对象分开。前者序列化到 `multipassd-vm-instances.json`（`MP_FILEOPS.write_transactionally` 原子写，`daemon.cpp:3014`），后者进程退出即销毁。后端经 `VMStatusMonitor::persist_state_for` 回调（`daemon.cpp:2991-2995`）把 `state` 字段写回 specs。重启时构造函数 `load_db`（`daemon.cpp:1282-1429`）读 JSON 逐条重建 VM 对象，对 `state == running` 的实例调 `on_restart` 恢复 daemon 侧资源。镜像 vault 另起独立 JSON（`multipassd-image-records.json` / `multipassd-instance-image-records.json`），与实例 DB 解耦。

**为什么两层**：规格是声明式可持久化的（用户配置快照），VM 对象含 hypervisor 句柄不可序列化；分层让重启后能恢复规格 + 重建对象，且镜像缓存与实例状态互不污染。

## 模块间交互

Daemon 是中央协调者，依赖几乎全部其他模块：

- **Platform**：持 `config->factory`（`VirtualMachineFactory::UPtr`）调 `create_virtual_machine`/`prepare_source_image`/`hypervisor_health_check`/`remove_resources_for`/`clone_bare_vm`，不感知具体后端
- **Image**：持 `config->vault`（`VMImageVault::UPtr`）调 `fetch_image`/`prune_expired_images`/`update_images`
- **SSHFS Mount**：`Daemon::make_mount`（`daemon.cpp:3487`）按 `MountType` 选 `SSHFSMountHandler` 或后端 native；`init_mounts`/`stop_mounts`/`update_mounts` 管生命周期
- **ISO/Cloud-init**：经 `factory->configure` 间接调 `CloudInitIso`
- **Settings**：`MP_SETTINGS` 读写持久化设置（`daemon_init_settings.cpp` 注册 handler）
- **Logging**：`config->logger`（`MultiplexingLogger`）

被 client 经 gRPC（`multipass.proto` 的 29 个 streaming RPC）调用；被后端经 `VMStatusMonitor` 回调上报状态。

## 扩展方式

新增一个 VM 生命周期命令（如 `pause`）：

1. `src/rpc/multipass.proto` 加 `rpc pause` + `PauseRequest`/`PauseReply` message，重新生成 stub
2. `src/daemon/daemon_rpc.h:53` 加 `pause` override + `on_pause` signal；`daemon_rpc.cpp` 实现 override 走 `verify_client_and_dispatch_operation`
3. `src/daemon/daemon.h:47` 加 `pause` public slot；`daemon.cpp:509` `connect_rpc` 加 `QObject::connect(&rpc, &DaemonRpc::on_pause, &daemon, &Daemon::pause)`
4. `daemon.cpp` 实现 `Daemon::pause`：`select_instances_and_react` 选实例 → `cmd_vms(selection, [](auto& vm){ vm.suspend(); })`（仿 `suspend`，`daemon.cpp:2221-2256`）
5. 若后端需新语义：`include/multipass/virtual_machine.h` + 各后端加 `pause()` 虚函数；若复用 `suspend` 则跳过
6. client 侧加 `pause` 命令（见 [CLI 客户端](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/03-client-cli) 扩展方式）

新增一个持久化设置项：`daemon_init_settings.cpp` 的 `register_global_settings_handlers` 注册新 key + `include/multipass/constants.h` 加常量；影响实例行为处读 `MP_SETTINGS.get_as<bool>(...)`。新增 VM 后端**不动本模块**（见 [平台抽象](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/02-platform) 扩展方式）。
