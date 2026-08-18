---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "制品仓库"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "OCI", "Docker", "Maven", "NPM", "distribution"]
description: "Harness 制品仓库：内嵌 CNCF distribution，多格式（Docker/OCI/Maven/NPM/Cargo/Go/Python）支持，StorageDriver 抽象 FS/S3/GCS，BlobFindAndLock 上传并发安全"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

制品仓库是 Harness 的第四大产品面——一个支持 Docker/OCI、Maven、NPM、Cargo、Go package、Python/PyPI、NuGet、RPM、Generic、HuggingFace 等多格式的 registry。它的特殊性是**内嵌了 CNCF distribution 的代码**（manifest/storage/driver 三层文件头标注 `Source: github.com/distribution/distribution`），在其上扩展了多格式 package 支持、upstream proxy（源自 Harbor）、webhook、event 系统、quarantine、reindexing 等 Harness 原生能力。它解决的核心问题是：DevOps 全栈里制品仓库是必备一环，而开源 distribution 只支持 OCI——Harness 把它扩成全格式，并与主 app 共享认证、事件、作业调度。go.mod 的 `replace github.com/harness/gitness/registry => ./registry` 把本地目录映射成独立 Go module，是 monorepo 内部 module 组织手段（非 distribution 的 replace）。

## 模块架构

```
registry/
  app/
    api/                      HTTP 层
      handler/                按格式分包（oci/maven/npm/cargo/gopackage/python/nuget/rpm/generic/huggingface）
      router/                router.go 挂载 /v2/* /maven/* /generic/* /pkg/
      controller/pkg/         每格式业务控制器
      wire.go                 DefaultStorageProvider 按 config switch
    pkg/                      CoreController 按 RegistryType 分发 Local/Remote
      docker/ maven/ npm/ cargo/ ...  每格式 local + remote 实现
    storage/                  StorageService + StorageResolver + blob 读写（源自 distribution）
    store/                    数据库 DAO（Blob/Manifest/Image/Artifact/DownloadStat）
    manifest/                 OCI/Docker manifest 解析（schema2/ocischema/manifestlist）
    driver/                   存储后端抽象（filesystem/s3-aws/gcs）
    remote/                   upstream proxy adapter（源自 Harbor）
    dist_temp/ auth/ common/ helpers/ metadata/ utils/
  config/                     openapi/
  gc/                         GC（interface 已定义，实现为 Noop——真实 GC 未开源）
  job/                        异步任务（复用主 app job.Executor）
  services/                   asyncprocessing/ webhook/
  types/                      数据模型
```

## 调用链路

一次 `docker push`（push manifest）的链路：

```
HTTP /v2/<repo>/manifests/<tag>
  └─ RegistryRouter.IsEligibleTraffic（前缀 /v2/）  in app/router/router.go（主）
  └─ registry/app/api/router/router.go  挂载 /v2/* 到 OCI handler
  └─ docker/controller.go  鉴权（委托主 app authn/authz）+ 解析 manifest
        ├─ StorageService（storageservice.go）经 StorageResolver 解析 StorageTarget
        │     → OciBlobStore（OCI 路径，含 resumable digest/multipart）
        ├─ blobWriter（blobwriter.go）driver.FileWriter 写 blob，支持 Resume 断点续传
        ├─ UnmarshalManifest（manifests.go:126）按 Content-Type 查 mappings → UnmarshalFunc
        ├─ digest.FromBytes(b) 校验摘要 + blobWriter.Commit → validateBlob
        ├─ 写 app/store DAO（Blob/Manifest/Image/Artifact）
        └─ 发布 ArtifactCreated event
  └─ webhook service（监听 ArtifactCreated）→ gitnesswebhook.WebhookExecutor
```

<details>
<summary>方法速查表</summary>

| 方法/接口 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `CoreController` | `app/pkg/core_controller.go` | 格式分发 | LocalRegistry/RemoteRegistry |
| `StorageService` | `app/storage/storageservice.go` | blob 入口 | StorageResolver 解析 target |
| `OciBlobStore`/`GenericBlobStore` | `app/storage/` | blob 读写 | OCI 路径 / 通用路径 |
| `blobWriter` | `app/storage/blobwriter.go` | chunked 写 | `Resume()` 断点续传 |
| `UnmarshalManifest` | `app/manifest/manifests.go:126` | manifest 解析 | Content-Type→mappings |
| `StorageDriver` interface | `app/driver/storagedriver.go` | 后端抽象 | FS/S3/GCS |
| `DefaultStorageProvider` | `app/api/wire.go:87` | 后端选择 | config switch |
| `gc.Service` | `gc/interface.go` | GC 契约 | 实现为 Noop |

</details>

## 核心实现

### 分层与边界

分层为 **api → pkg/services → storage/store**：api 层 handler 按格式分包，router 挂 `/v2/*`(OCI)、`/maven/*`、`/generic/*`、`/pkg/`；pkg 层 `CoreController` in `app/pkg/core_controller.go` 按 `RegistryType` 分发 LocalRegistry/RemoteRegistry，每格式有独立子包含 local + remote 实现；storage 层 blob 读写抽象源自 distribution；store 层是 registry 专用数据库 DAO。

与主 app 的边界是 **共享 service 接口**：registry 复用主 app 的 `SpaceStore`/`TokenStore`/`PrincipalStore`/`SpacePathStore`（合称 `corestore`）、`authn.Authenticator`/`authz.Authorizer`、`events.System`、`job.Executor`、`gitnesswebhook.WebhookExecutor`、`url.Provider`、`audit.Service`、`secret.Service`、`encrypt.Encrypter`、`refcache.SpaceFinder`。registry 独有 `app/store`（registry 专用表 DAO）、`app/auth`（OCI scope 模型）、`app/storage`、`app/manifest`、`app/remote`。边界即"共享 store/auth/events/job，独立 storage/manifest/driver"。

### 多格式与 manifest 解析

`manifest` 包 in `app/manifest/manifests.go` 仅处理 OCI/Docker manifest 格式：`Manifest` interface + `UnmarshalManifest()` 按 Content-Type header 查 `mappings` map 分发——`schema2/manifest.go` 处理 Docker v2（`application/vnd.docker.distribution.manifest.v2+json`，`init()` 注册 UnmarshalFunc）；`ocischema/manifest.go` 处理 OCI Image Manifest v1（支持 `ArtifactType`/`Subject`/`Annotations`）；`manifestlist/` 处理多架构 manifest list。digest 校验：`digest.FromBytes(b)` 计算规范摘要，`blobWriter.Commit()` 调 `validateBlob()` 验证摘要匹配。签名不在本模块处理（外部 cosign/notation，待核实）。非 OCI 格式（Maven/NPM/Cargo 等）不走 manifest 包，直接用 `GenericBlobStore` + 自定义 metadata（`app/store` DAO）。

### blob 存储与并发安全

`StorageDriver` interface in `app/driver/storagedriver.go` 抽象三种后端（filesystem/s3-aws/gcs），通过 `factory.Create()` 注册创建，`DefaultStorageProvider()` in `app/api/wire.go:87` 按 config switch 选后端。`StorageService` in `storageservice.go` 经 `StorageResolver` in `provider.go`（默认 `StaticStorageResolver`）解析 `StorageTarget`，产出 `OciBlobStore`（OCI 路径，含 resumable digest/multipart）或 `GenericBlobStore`。

上传是 **chunked/resumable**：`blobWriter` in `blobwriter.go` 持 `driver.FileWriter`，支持 `Resume()` 断点续传；`genericBlobStore.Write()` 用 `io.MultiWriter` 同时流式写入并计算 SHA1/256/512/MD5。下载支持 redirect：`driver.RedirectURL()` 返回 S3/GCS presigned URL，fallback 到 `FileReader` 流式读取。

GC 与上传并发安全：`gc/interface.go` 定义 `Service` interface（`Start`/`BlobFindAndLockBefore`/`ManifestFindAndLockBefore`），但 `gc/garbagecollector.go` 是 **Noop**——真实 GC 未开源。数据模型 `types/gc.go`（`GCBlobTask`/`GCManifestTask`）有 `ReviewAfter`/`ReviewCount` 字段，暗示 **mark-sweep + 时间延迟 review queue** 模式（源自 GitLab container-registry）。`BlobFindAndLockBefore` 的 lock 机制处理上传并发——锁定 blob 防止 GC 与活跃上传竞争。

### 认证、webhook、异步任务

认证 `registry/app/auth/auth.go` 实现 Docker/OCI **scope-based access control**：`AccessSet` 映射 `Resource`→`ActionSet`，`AppendAccess()` 按 HTTP method 映射（GET/HEAD→pull、POST/PUT/PATCH→pull+push、DELETE→delete），是 Docker registry token auth 模型。实际认证委托主 app 的 `authn`/`authz`（见 `docker/controller.go:51`）。

webhook `services/webhook/service.go` 在 `NewService` 注册事件 reader 监听 `ArtifactCreatedEvent`/`ArtifactDeletedEvent` in `app/events/artifact/artifacts.go`：push manifest → docker controller 发 `ArtifactCreated` event → webhook service 消费 → 调 `gitnesswebhook.WebhookExecutor.TriggerForEvent`（复用主 app 的 `WebhookExecutor`，传 `ArtifactRegistryTrigger`）。parent 层级含 Registry + 祖先 Spaces（inherited，`getParentInfoRegistry`）。

异步任务 `registry/job/` 仅一个 handler `JobRpmRegistryIndex` in `rpm_registry_index.go`（type=`rpm_registry_index`，构建 RPM registry 索引），复用主 app 的 `job.Executor`。事件系统 `app/events/artifact`（ArtifactCreated/Deleted）、`app/events/asyncprocessing`（post-processing）、`app/events/replication`。`reindexing.Service` in `reindexing/service.go` 协调 hard/soft delete 和 restore 的重建索引流程。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| RegistryType 分发 | `CoreController` Local/Remote | 本地仓库与 upstream proxy 统一接口 |
| StorageDriver 抽象 | `driver/storagedriver.go` | FS/S3/GCS 可切换，redirect 支持 |
| Content-Type 注册表 | manifest `mappings` + `init()` | 多 manifest 格式可扩展 |
| mark-sweep + review queue | `gc` 数据模型 | 延迟删除防并发竞争 |
| 共享 service 接口 | corestore/auth/events/job | 与主 app 解耦又复用 |

## 模块间交互

通过共享 service 接口与主 app 交互：共享 `corestore`（Space/Token/Principal）、`events.System`、`job.Executor`、`WebhookExecutor`、`refcache.SpaceFinder`、`authn`/`authz`/`url`/`audit`/`secret`/`encrypt`。registry 独有的 `app/store` 通过 `dbtx.Transactor` 与主 app 共享数据库事务。作为独立子系统，由 [启动模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/01-bootstrap-wire)的 `RegistryRouter` 接入主路由链。

## 扩展方式

**新增制品格式**：在 `app/api/handler/<fmt>/` 加 handler、`app/pkg/<fmt>/` 加 controller（实现 `pkg.Artifact` interface 的 Local+Remote）、`app/api/router/<fmt>/` 加路由、`app/remote/adapter/<fmt>/` 加 upstream adapter，在 `app/api/wire.go` 的 `WireSet` 注册 `NewXxxHandlerProvider`。OCI 格式无需改 manifest；非 OCI 格式用 `GenericBlobStore`。

**换 storage 后端**：在 `app/driver/<backend>/` 实现 `StorageDriver` interface（含 `Register()`），在 `app/api/wire.go` 的 `DefaultStorageProvider()` 加 case，在 `config/` 加参数解析。

**改 GC 策略**：实现 `gc.Service` interface（替换 `Noop`），在 `gc/wire.go` 的 `ServiceProvider` 返回新实现，用 `GcStorageClient.RemoveBlob()` 执行删除，review queue 表 `GCBlobTask`/`GCManifestTask` 提供 mark 数据。
