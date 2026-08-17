---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "ISO 与 Cloud-init"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "cloud-init", "ISO9660", "NoCloud"]
description: "手写 ISO9660+Joliet 生成 NoCloud seed ISO，4 个 cidata 文件 + instance-id 重生成。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/00-overview)

---

## 模块定位

ISO9660+Joliet 的字节布局与 cloud-init 的 YAML 语义是两个正交关注点：`iso` 模块（`src/iso/`，~791 行）只负责把若干 `(name, data)` 对打包成 NoCloud 兼容的 seed ISO 并能读回来，不解析文件内容；内容生成住在 `src/utils/yaml_node_utils` 和 `src/daemon`。这让 ISO 读写代码可独立测试、被 create/clone/network-change 三条路径复用，且未来换 seed 格式（如 raw disk + FAT）只动这一个模块。

## 模块架构

两个核心类 + ISO 二进制结构：

- **CloudInitIso**（`include/multipass/cloud_init_iso.h:32-56`）：持 `vector<FileEntry{name,data}>` 平坦列表，`add_file`/`contains`/`at`/`operator[]`/`erase`/`write_to`/`read_from`
- **CloudInitFileOps**（`:59-80`）：`Singleton<CloudInitFileOps>` + 全 virtual（可 mock），`update_identifiers`/`add_extra_interface_to_cloud_init`/`get_instance_id_from_cloud_init`，宏 `MP_CLOUD_INIT_FILE_OPS`
- **ISO 二进制结构**（`src/iso/cloud_init_iso.cpp` 匿名 namespace）：`VolumeDescriptor`/`PrimaryVolumeDescriptor`（type=0x01, vol id "cidata"）/`JolietVolumeDescriptor`（type=0x02, UCS-2 escape）/`VolumeDescriptorSetTerminator`（0xFF）/`RootDirRecord`/`FileRecord`/`ISOFileRecord`（8.3 大写）/`JolietFileRecord`（UCS-2）/`RootPathTable`

## 调用链路

**Create VM（首次生成 seed ISO）：**

```
daemon.cpp make_vm_description lambda (~:3220)
  ├─ mpu::make_cloud_init_meta_config(name)      → vm_desc.meta_data_config      daemon.cpp:3262
  ├─ YAML::Load(request->cloud_init_user_data())  → vm_desc.user_data_config     daemon.cpp:3263
  ├─ prepare_user_data(user, vendor)                                           daemon.cpp:3264 → :188
  │     └─ vendor 由 make_cloud_init_vendor_config 构造                        daemon.cpp:134
  │           └─ YAML::Load(mp::base_cloud_init_config)                       daemon.cpp:157 → base_cloud_init_config.h:21
  │               注入 ssh-rsa key / timezone / default_user / pollinate
  ├─ mpu::make_cloud_init_network_config(mac, extra) → vm_desc.network_data_config  daemon.cpp:3269
  └─ config->factory->configure(vm_desc)                                       daemon.cpp:3274
        └─ BaseVirtualMachineFactory::configure     base_virtual_machine_factory.cpp:39-57
              ├─ CloudInitIso iso                                             (:46)
              ├─ iso.add_file("meta-data", emit_cloud_config(meta_data_config))    (:47)
              ├─ iso.add_file("vendor-data", emit_cloud_config(vendor_data_config))(:48)
              ├─ iso.add_file("user-data", emit_cloud_config(user_data_config))    (:49)
              ├─ iso.add_file("network-config", emit_cloud_config(network_data_config)) (:50-51)
              └─ iso.write_to(cloud_init_iso)                                  (:53)  落盘
```

**Mount（backend 各自挂载，路径经 `VirtualMachineDescription::cloud_init_iso` 传 `include/multipass/virtual_machine_description.h:48`）：** QEMU `-cdrom`（`qemu_vm_process_spec.cpp:117`）、HyperV `Add-VMDvdDrive -Path`（`hyperv_virtual_machine.cpp:185`）、VBox storage controller（`virtualbox_virtual_machine.cpp:252/:324`）、HCS（`hcs_virtual_machine.cpp:387`）。

**Clone / 改网络（原地改 ISO，不重建）：** `BaseVirtualMachineFactory::clone_bare_vm`（`base_virtual_machine_factory.cpp:93`）→ `MP_CLOUD_INIT_FILE_OPS.update_identifiers`（`:109`）→ `CloudInitFileOps::update_identifiers`（`cloud_init_iso.cpp:743`）：`iso.read_from` → `iso.at("meta-data")=新值` → `iso["network-config"]=新值` → `iso.write_to`。

## 核心实现

### 为何手写 ISO9660+Joliet 而非依赖 genisoimage/mkisofs

Multipass 跨 Linux/macOS/Windows，不能假设宿主机装了这些工具。`iso` 模块是 ~791 行的自包含写入器，产出最小 NoCloud 兼容 ISO（只有根目录 + 平坦文件列表），writer 跳过 ISO9660 大部分目录层级机制，reader 只走 Joliet 描述符 → 根目录记录 → 文件记录三跳。位置：`src/iso/cloud_init_iso.cpp:34-62`（格式注释）、`write_to :538`、`read_from :631`；设计文档 `src/iso/cloud_Init_Iso_read_me.md:13-15`。

### 为何拆成 meta/vendor/user/network 四个独立 cidata 文件

与 cloud-init NoCloud datasource 契约 1:1 对应，拆分让 clone/改网络时只重写 `meta-data`+`network-config` 不动 `user-data`（`update_identifiers` `cloud_init_iso.cpp:743` 只改这两个）。vendor-data vs user-data 的拆分还做权限隔离：Multipass 控制的 SSH key 放 vendor-data 防用户覆盖，`prepare_user_data`（`daemon.cpp:188`）再把 vendor keys 并入 user-data 作默认。位置：四个 `add_file` 在 `base_virtual_machine_factory.cpp:47-51`。

### 为何每次改 ISO 都重新生成 instance-id

cloud-init 用 `instance-id` 做 datasource 缓存键：改了 meta-data/network-config 但 instance-id 不变，重启 VM 会跳过 cloud-init。`make_cloud_init_meta_config_with_id_tweak`（`yaml_node_utils.cpp:184`）给原 id 追加 `_e`，强制下次启动重新求值；`update_cloud_init_with_new_extra_interfaces_and_new_id`（`cloud_init_iso.cpp:724`）和 `add_extra_interface_to_cloud_init`（`:764`）都走这条。位置：`yaml_node_utils.cpp:189-196`、`cloud_init_iso.cpp:734-735,772-773`。

## 模块间交互

- 被 `BaseVirtualMachineFactory::configure` 调（create VM 时生成 seed）；`clone_bare_vm` 调（clone/改网络时原地改）
- 依赖 `utils/yaml_node_utils`（YAML 生成 + id-tweak）、`daemon`（vendor/user/network config 组装）、`MP_FILEOPS`（文件读写）
- 生成的 ISO 经 `VirtualMachineDescription::cloud_init_iso` 传给后端挂载

## 扩展方式

注入一个新 cloud-init 字段（如默认装一个包）：不动 `iso` 模块（它对内容无感）——进 vendor-data 编辑 `src/daemon/base_cloud_init_config.h:21` 的 constexpr 字符串或扩展 `make_cloud_init_vendor_config`（`daemon.cpp:134-186`，参考 `config["write_files"].push_back(...)` `:178-182`）；进 user-data 编辑 `prepare_user_data`（`daemon.cpp:188-206`）。改 network-config 生成逻辑（接口命名/route metric/DHCP-static）：改 `src/utils/yaml_node_utils.cpp` 的 `make_cloud_init_network_config`（`:201`）+ `interface_details` struct（`:33-49`，硬编码 `eth{}` 命名、extra `route_metric=200`）+ `add_extra_interface_to_network_config`（`:227`）。给 seed ISO 增加新 cidata 文件（如 `disk-setup`）：`BaseVirtualMachineFactory::configure`（`base_virtual_machine_factory.cpp:46-53`）加一行 `iso.add_file("disk-setup", ...)`，`CloudInitIso::write_to`（`:538`）已泛化遍历 `files` 会自动多写 FileRecord；若需 clone 时原地改，仿 `update_identifiers`/`add_extra_interface_to_cloud_init` 在 `CloudInitFileOps`（`cloud_init_iso.h:59`）加 virtual 方法。
