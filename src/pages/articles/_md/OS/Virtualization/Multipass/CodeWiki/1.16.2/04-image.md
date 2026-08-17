---
source:
  type: "源码解读"
  project: "Multipass"
  url: "https://github.com/canonical/multipass"
title: "镜像管理"
date: "2026-08-17T11:04:42+08:00"
category: [OS, Virtualization, Multipass, CodeWiki, "1.16.2"]
tags: ["Multipass", "C++", "Simple Streams", "镜像缓存"]
description: "DefaultVMImageVault：Simple Streams 协议 + 两层缓存 + single-flight 去重 + sha256 校验。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Virtualization/Multipass/CodeWiki/1.16.2/00-overview)

---

## 模块定位

Image 模块把"从哪找镜像（image_host / simplestreams）、怎么下（URLDownloader）、怎么缓存去重与校验、怎么过期升级"全部封进 `VMImageVault`/`VMImageHost` 抽象背后，daemon 仅经 `fetch_image`/`remove`/`update_images`/`prune_expired_images` 等少数接口拿 `VMImage`，完全不感知 Simple Streams 协议、镜像 URL、网络下载与本地去重——使得镜像源协议、缓存策略与下载实现都可独立替换。模块跨 `src/daemon/default_vm_image_vault.*` + `src/image_host/` + `src/simplestreams/` + `include/multipass/` 相关头。

## 模块架构

四个层次：

- **VMImageVault 抽象**（`include/multipass/vm_image_vault.h`）：纯虚接口，`fetch_image`/`remove`/`has_record_for`/`prune_expired_images`/`update_images`/`clone`/`image_host_for`
- **DefaultVMImageVault**（`src/daemon/default_vm_image_vault.h`，god node 36 edges，`final`）：默认实现。持 `URLDownloader*`、`cache_dir`/`data_dir`/`images_dir`、`days_to_expire`、两份 `unordered_map` 缓存（`prepared_image_records` 按镜像 id、`instance_image_records` 按 VM 名）、`in_progress_image_fetches`（single-flight）
- **VMImageHost 抽象 + UbuntuVMImageHost**（`include/multipass/image_host/`）：镜像源策略，`info_for`/`all_info_for`/`supported_remotes`/`update_manifests`；`UbuntuVMImageHost` 持 `vector<pair<string, unique_ptr<SimpleStreamsManifest>>>` manifests
- **SimpleStreamsIndex / SimpleStreamsManifest**（`src/simplestreams/`）：Ubuntu Simple Streams 协议解析

数据结构：`VMImage`（`image_path`/`id`/`original_release`/`current_release`/`release_date`/`os`/`aliases`）、`VMImageInfo`（manifest 侧，含 `sha256`/`size`/`image_location`/`verify`）。

## 调用链路

`fetch_image` 主链：

```
DefaultVMImageVault::fetch_image                       default_vm_image_vault.cpp:155
  ├─ [fast path] instance_image_records[query.name] 命中 → 直接返回      (:163)
  ├─ Query::Type::LocalFile                                              (:172)
  │     └─ .xz → extract_file; prepare(); verify_file_hash; persist      (:188-208)
  └─ HttpDownload | Alias                                                (:212)
       ├─ HttpDownload: id=checksum?*checksum:sha256(url)
       │     url_downloader->last_modified(url) → 比对 release_date       (:228-240)
       ├─ Alias: info = info_for(query)
       │     └─ BaseVMImageHost[shared_lock] → UbuntuVMImageHost::info_for_impl
       │        → match_alias / 遍历 products                              (ubuntu_image_host.cpp:117)
       ├─ get_image_future(id) 命中 → 复用 QFuture (single-flight)        (:243/311)
       │     否则 QtConcurrent::run(download_and_prepare_source_image)    (:274/325)
       └─ future.result() → finalize_image_records                        (:340-343)

download_and_prepare_source_image                     default_vm_image_vault.cpp:538
  ├─ url_downloader->download_to(image_location, local_path, size, IMAGE, monitor)
  ├─ info.verify → verify_file_hash(path, id)                            (:574-579)
  ├─ .xz → extract_file                                                  (:581-585)
  └─ prepare(source_image); remove_source_images                         (:587-588)

finalize_image_records                                 default_vm_image_vault.cpp:641
  ├─ image_instance_from(prepared, dest_dir) → copy_to_dir   (实例副本)
  ├─ instance_image_records[name]=...; prepared_image_records[id]=...
  └─ persist_instance_records(); persist_image_records  → 两份 JSON DB   (:665-673)
```

manifest 拉取链（独立路径，`update_manifests` 触发，`ubuntu_image_host.cpp:245`）：`fetch_manifests` → `download(index.json)` → `SimpleStreamsIndex::get_image_downloads`（按 `datatype=="image-downloads"` 定位）→ `download(products.json)` → `SimpleStreamsManifest::fromJson`（按架构过滤、选 image key）。

## 核心实现

### Simple Streams 协议解析

Ubuntu cloud-images 以 `index.json`→`products.json` 发布镜像目录，每条 item 自带 `sha256`+`size`+`path`。`SimpleStreamsIndex::get_image_downloads`（`simple_streams_index.cpp:28`）按 `datatype=="image-downloads"` 定位 manifest path；`SimpleStreamsManifest::fromJson`（`simple_streams_manifest.cpp:78`）按架构过滤、选 image key（`uefi1.img` > `img.xz`(core) > `disk1.img`），产 `vector<VMImageInfo>` 含 sha256。这样把 alias "22.04" 解析到具体 URL + 校验值，**无需随版本更新改代码**；镜像源 `UbuntuVMImageRemote` 只配 `official_host`+`uri`+`mirror_key`，换源改配置即可。

### 两层缓存 + single-flight 去重 + 两份独立 DB

- `prepared_image_records`（按 image id 共享）：源镜像只读，同 release 多 VM 只下一次
- `instance_image_records`（按 VM 名）：每 VM 一份可变副本，由 `image_instance_from`→`copy_to_dir` 产生（VM 可扩盘、cloud-init 修改）
- `in_progress_image_fetches`（按 id 存 `QFuture`）：`get_image_future` 命中即复用，避免重复下载（single-flight）
- 落盘分 `multipassd-image-records.json`（cache_dir）与 `multipassd-instance-image-records.json`（data_dir）

`finalize_image_records`（`:641-663`）一次写两份且 prepared record 的 `Query::name` 清空以与具体 VM 解耦。**为什么**：源镜像只读可共享（省带宽/磁盘），实例镜像可被 VM 修改，分层隔离互不污染；并发请求同 id 只下一次网。

### last_modified 复用 + sha256 校验 + mirror 不被信任

HttpDownload 路径用 `url_downloader->last_modified(url)` 比对 `prepared_image_records[id].image.release_date`（`:228-240`），远端未变直接复用缓存；下载后若 `info.verify` 则 `verify_file_hash(path, id)`（`:574-579`），id 即 manifest 的 sha256，防损坏防篡改。`SimpleStreamsManifest::fromJson` 同时收 official 与 mirror 两份 products.json，用 mirror 的下载路径但仅保留与 official product 字节相等的版本（`if (!official_version || version != *official_version) continue;` at `:139-141`）。**为什么**：mirror 加速但可能被劫持/出错，用 official 做权威一致性校验，兼得速度与可信度。

## 模块间交互

- 被谁调用：Daemon 经 `config->vault` 调（`daemon.cpp:3225` `fetch_image`、镜像维护 `QTimer`、`update_images`/`prune_expired_images`）；`BaseVirtualMachineFactory::create_image_vault` 默认返回 `DefaultVMImageVault`
- 依赖：`URLDownloader`（下载）、`utils`/`logging`/`settings`、`MP_IMAGE_VAULT_UTILS`（extract/verify hash）

## 扩展方式

新增一个镜像源（如自定义 manifest）：实现 `VMImageHost` 子类（`info_for`/`all_info_for`/`supported_remotes`/`update_manifests`），在 `DaemonConfigBuilder` 注册到 `image_hosts` 列表；`fetch_image` 的 `Alias` 路径经 `image_host_for(remote_name)` 找到。改缓存策略：调 `days_to_expire` 或改 `prune_expired_images`（`default_vm_image_vault.cpp`）/`finalize_image_records` 的 `last_accessed` 维护。支持新压缩格式：`download_and_prepare_source_image`（`:581`）加分支 + `vm_image_vault_utils.h` 补 decoder。
