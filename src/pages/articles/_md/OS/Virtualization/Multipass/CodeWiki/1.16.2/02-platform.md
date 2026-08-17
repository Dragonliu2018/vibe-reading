---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "平台抽象与虚拟化后端"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "虚拟化", "QEMU", "Hyper-V"]
description: "三层抽象 + 4 后端：VirtualMachine/Factory 接口 → Base* 模板基类 → qemu/hyperv/applevz/virtualbox。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/00-overview)

---

## 模块定位

Platform 模块（`src/platform/`，~24.7k 行，最大模块）通过三层抽象把"hypervisor 差异"封装在编译时 `#ifdef` 选择的 `vm_backend()` 工厂函数中，使 Daemon 仅依赖 `VirtualMachineFactory::UPtr` 抽象指针，与具体 hypervisor 实现完全解耦——新增或替换后端不影响 Daemon 及其他后端。

## 模块架构

三层抽象 + 4 个同构后端：

- **接口层**（`include/multipass/`）：`VirtualMachine` 纯虚接口（`virtual_machine.h`，30+ 纯虚方法 + `State` 枚举）；`VirtualMachineFactory` 纯虚工厂（`virtual_machine_factory.h`）
- **模板基类层**（`src/platform/backends/shared/`）：`BaseVirtualMachine`（god node 92 edges）、`BaseVirtualMachineFactory`、`BaseSnapshot`（god 42）——把 SSH/快照/cloud-init 等待等公共逻辑下沉
- **后端实现层**（`src/platform/backends/{qemu,hyperv,applevz,virtualbox}`）：各继承 `Base*`，实现少量纯虚钩子，同构变体
- **平台单例**（`include/multipass/platform.h`）：`Platform : public Singleton<Platform>`（`MP_PLATFORM` 宏），封装 OS 特定行为；`vm_backend()` 按 OS + driver 选后端工厂

4 后端各自继承 `BaseVirtualMachineFactory` + `BaseVirtualMachine`，编译时经 `#ifdef QEMU_ENABLED`/`APPLEVZ_ENABLED`/`VIRTUALBOX_ENABLED`/`HYPERV_HCS_ENABLED` 隔离，运行时经 `vm_backend()` 的 driver 字符串选择，**彼此无交叉引用**。

## 调用链路

`create_virtual_machine` → `start` 的多态分派链：

```
Daemon::launch()                                              daemon.cpp:1375
  └─ config->factory->create_virtual_machine(vm_desc, ssh_key_provider, *this)
       │  [虚函数分派 → 具体后端工厂]
       ├─ QemuVirtualMachineFactory::create_virtual_machine  qemu_virtual_machine_factory.cpp:59
       │    └─ std::make_unique<QemuVirtualMachine>(desc, qemu_platform, monitor, ...)
       │         └─ BaseVirtualMachine 构造 → zone.add_vm(*this)
       └─ [hyperv] HyperVVirtualMachineFactory::create_virtual_machine
       └─ [applevz] AppleVZVirtualMachineFactory::create_virtual_machine

vm->start()  [VirtualMachine::start() 纯虚 → 多态分派]
  └─ QemuVirtualMachine::start()                       qemu_virtual_machine.cpp:269
       ├─ initialize_vm_process() → make_qemu_process(desc)  qemu_vm.cpp:98
       ├─ vm_process->start()                          # 启动 QEMU 进程
       ├─ vm_process->wait_for_started()
       └─ vm_process->write(qmp_execute_json("qmp_capabilities"))  # QMP 握手

vm->wait_until_ssh_up(timeout)  [BaseVirtualMachine 非虚实现]
  └─ BaseVirtualMachine::wait_until_ssh_up            base_virtual_machine.cpp:346
       ├─ drop_ssh_session()                          # 清旧缓存
       └─ utils::try_action_for(timeout, try_to_ssh)
            └─ try_to_ssh()
                 ├─ detect_aborted_start()
                 ├─ refresh_start()                  # 虚函数，QemuVirtualMachine 重写（suspend 恢复重置网络）
                 └─ ssh_and_cross_to_running()
                      └─ state = State::running; handle_state_update()
```

**关键**：`create_virtual_machine` 是纯虚工厂方法，分派到具体后端；`start` 也是纯虚，后端各自实现 hypervisor 交互（QEMU 进程/QMP、HyperV HCS API、AppleVZ Virtualization.framework、VirtualBox）；但 `wait_until_ssh_up`/`wait_for_cloud_init`/`take_snapshot` 等是 `BaseVirtualMachine` 的非虚实现，所有后端共享。

## 核心实现

### VirtualMachine 接口与 10 态状态机

`include/multipass/virtual_machine.h` 定义纯虚接口 + `State` 枚举（`off`/`stopped`/`starting`/`restarting`/`running`/`delayed_shutdown`/`suspending`/`suspended`/`unknown`/`unavailable`）。`state` 字段 public，经 `state_mutex`/`state_wait` 保护——Daemon 与 VM 直接读写而无需 getter/setter 层。状态转换合法性校验集中在 `BaseVirtualMachine::check_state_for_shutdown`（`base_virtual_machine.cpp:166`，拒绝 `suspended` 时 `Powerdown`、`starting` 时 `shutdown` 等）。状态机全貌见概览「运行时行为 > 状态流」。

### BaseVirtualMachine 模板方法：公共逻辑下沉

4 后端的 VM 生命周期差异仅在 hypervisor 交互层（进程管理/QMP/HCS API/Virtualization.framework），但 SSH 连接、cloud-init 等待、快照元数据管理、状态机校验逻辑完全相同。`BaseVirtualMachine` 把这些放为非虚方法，后端只实现少量纯虚钩子：

- `resize_disk()`（非虚）→ 调纯虚 `resize_disk_impl()`（后端如 QEMU `qemu-img resize`）
- `take_snapshot()`（非虚）→ 调纯虚 `make_specific_snapshot()`（后端如 QEMU `savevm`）
- `set_available(bool)`（非虚模板方法）编排 `start()`/`shutdown()` 调用顺序（`base_virtual_machine.cpp:210`）
- `wait_until_ssh_up`/`wait_for_cloud_init`/`ssh_exec` 非虚，复用 `SSHSession`

### BaseVirtualMachineFactory + 后端选择

`BaseVirtualMachineFactory`（`base_virtual_machine_factory.h`）提供公共逻辑：`clone_bare_vm`/`remove_resources_for`/`create_image_vault`（默认返回 `DefaultVMImageVault`）/`configure`（生成 cloud-init seed ISO）。`create_virtual_machine` 仍纯虚，由具体后端工厂实现。

后端选择在 `vm_backend()`（`platform_linux.cpp:452`、`platform_osx.cpp:314`、`platform_win.cpp:927`）：**编译时 `#ifdef` 排除不可用后端**（macOS 无 HyperV、Windows 无 AppleVZ），**运行时 driver 设置让用户在同 OS 多后端间切换**（macOS 可选 qemu/applevz/virtualbox）。每个 `#ifdef` 守卫确保不可用后端不编译进二进制。

### BaseSnapshot：NVI（非虚接口）

`BaseSnapshot`（`base_snapshot.h`）把 `capture()`/`erase()`/`apply()` 标 `final`，内部调纯虚 `capture_impl()`/`erase_impl()`/`apply_impl()`。横切逻辑（加锁、JSON 持久化、父子链维护、scope_guard 回滚、文件原子移动）由基类控制，后端只填 3 个钩子（QEMU `savevm`/`delvm`/`loadvm`，HyperV/VBox 各自的快照 API）。`SnapshotDescription` + 父子 `std::shared_ptr<Snapshot> parent` 构成快照链。

## 模块间交互

- **被 Daemon 调用**：`Daemon` 经 `DaemonConfig::factory`（`daemon_config.h:47`）持 `VirtualMachineFactory::UPtr`，调 `create_virtual_machine`/`prepare_source_image`/`hypervisor_health_check`/`networks`/`remove_resources_for`/`clone_bare_vm`
- **依赖 SSH**：`BaseVirtualMachine` 持 `std::unique_ptr<SSHSession>` 缓存，`ssh_exec_process`（`base_virtual_machine.cpp:243-281`）exec 时复用、断线 `renew_ssh_session` 重连一次（重连逻辑在调用方而非 SSH 模块，保持 SSH 无状态）
- **依赖 ISO**：`BaseVirtualMachineFactory::configure` 调 `CloudInitIso` 生成 seed
- **依赖 Image Vault**：`create_image_vault` 默认返回 `DefaultVMImageVault`
- **依赖 Platform 单例**：`MP_PLATFORM` 做路径转换、网络查询、文件权限

## 扩展方式

新增一个虚拟化后端 X（**不动 Daemon**）：

1. **新建 Factory**（`src/platform/backends/x/x_virtual_machine_factory.{h,cpp}`，继承 `BaseVirtualMachineFactory`）：实现 `create_virtual_machine`（返回 `XVirtualMachine`，必选）、`prepare_source_image`/`prepare_instance_image`（镜像格式转换/resize）、`hypervisor_health_check`、`remove_resources_for_impl`、`clone_vm_impl`（不支持则基类抛 `NotImplementedOnThisBackendException`）
2. **新建 VM**（继承 `BaseVirtualMachine`）：实现 `start`/`shutdown`/`suspend`/`current_state`（核心生命周期，必选）、`ssh_port`/`ssh_hostname`/`ssh_username`、`management_ipv4`、`resize_disk_impl`、`make_specific_snapshot`、`handle_state_update`
3. **注册到平台选择**：对应 OS 的 `src/platform/platform_<os>.cpp` 的 `vm_backend()` 加 `#ifdef X_ENABLED` 分支；`is_backend_supported()` 加判断
4. `DaemonConfigBuilder::build` 把新 factory 透传给 Daemon，后者经 `config->factory->...` 多态调用——零改动

给现有后端加新能力（如新挂载类型）：`VirtualMachine` 接口加纯虚方法 → `BaseVirtualMachine` 提供默认（通常抛 `NotImplementedOnThisBackendException`）→ 仅需要的后端重写（参考 `QemuVirtualMachine::make_native_mount_handler` in `qemu_virtual_machine.cpp:741`）。
