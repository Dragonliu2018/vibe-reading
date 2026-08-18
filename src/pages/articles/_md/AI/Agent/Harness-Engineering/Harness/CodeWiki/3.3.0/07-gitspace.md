---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "Gitspaces 托管开发环境"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "Gitspace", "devcontainer", "Docker", "SCM"]
description: "Harness Gitspaces：异步事件驱动三段式启动（Trigger→Resume→Finish），devcontainer.json 标准，Factory 模式可插拔 infra/scm/ide/secret"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

Gitspaces 是 Harness 的第三大产品面——类似 GitHub Codespace，一键拉起一个云端开发环境（容器内带 IDE、git 凭证、用户代码）。它解决的核心问题是：开发环境配置漂移与拉起耗时——本地搭一套带依赖的环境动辄半小时，且团队各人环境不一致。Gitspace 用 devcontainer.json 标准 + Docker 容器 + 异步事件驱动编排，把"拉码→装环境→注入凭证→起 IDE→转发端口"串成可复现流水线。本模块只做**编排**：基础设施供给（`infraprovider`）、容器内命令执行（`devcontainer.Exec` 封装 Docker exec API）、SCM 拉码、凭证注入都通过 Factory 模式可插拔。

## 模块架构

```
app/gitspace/
  orchestrator/                编排核心（Orchestrator + container/devcontainer/ide/runarg/utils）
    orchestrator_trigger.go    TriggerStart/Stop/DeleteGitspace（阶段一：异步触发）
    orchestrator_resume.go     ResumeStart/Stop（阶段二：infra 完成回调）
  infrastructure/              InfraProvisioner 编排层（参数组装 + DB 持久化 + 按 ProvisioningType 分流）
  scm/                         SCM 集成（GitnessSCM / GenericSCM + Factory）
  secret/ + platformsecret/    凭证解析（ResolverFactory：Password/SSHKey/JWT）
  platformconnector/           平台连接器（Docker registry 凭证等）
  logutil/                     流式日志（封装 livelog.LogStream）
  types/                       数据模型
infraprovider/                 基础设施提供者接口 + DockerProvider 实现
```

核心入口 `orchestrator.Orchestrator`，启动走**异步事件驱动三段式**——因为基础设施供给（provision）和容器启动都是耗时操作，不能阻塞 API 请求。

## 调用链路

Gitspace 启动三阶段：

```
阶段一 TriggerStartGitspace() in orchestrator/orchestrator_trigger.go:100
  ├─ o.scm.GetSCMRepoDetails        拉仓库详情 + 解析 .devcontainer/devcontainer.json
  ├─ ExtractGitspaceSpec            从 customizations 提取 connector 引用
  ├─ o.platformConnector.FetchConnectors   拉平台连接器（registry 凭证）
  ├─ getPortsRequiredForGitspace    合并 IDE 端口 + devcontainer forwardPorts
  └─ o.infraProvisioner.TriggerInfraEventWithOpts(Provision)   异步触发供给

阶段二 ResumeStartGitspace() in orchestrator/orchestrator_resume.go:36  (infra 完成回调)
  ├─ utils.ResolveSecret            解析 access key（SSH 密码/JWT）
  ├─ PostInfraEventComplete         确认 infra 状态 Provisioned
  ├─ GetSCMRepoDetails（重取，拿最新凭证）
  ├─ containerOrchestratorFactory.GetContainerOrchestrator   按 ProviderType 取编排器
  ├─ 解析 connectors + AI auth（decryptAIAuth → platformSecret.FetchSecret）
  └─ containerOrchestrator.CreateAndStartGitspace   创建+启动容器（见 devcontainer 步骤）

阶段三 FinishResumeStartGitspace() in orchestrator_resume.go:178  (容器启动完成)
  ├─ 生成 IDE URL、SSH 命令、Plugin URL
  └─ 设 LastUsed/ActiveTimeStarted/LastHeartbeat，状态置 Running
```

停止 `TriggerStopGitspace` in `orchestrator_trigger.go:172` → `stopGitspaceContainer` → `containerOrchestrator.StopGitspace` → `FinishStopGitspaceContainer` 触发 `InfraEventStop` → `ResumeStopGitspace` 保存状态。删除流程类似，区分 `canDeleteUserData`（是否删 volume）。

<details>
<summary>方法速查表</summary>

| 方法/接口 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `Orchestrator.TriggerStartGitspace` | `orchestrator_trigger.go:100` | 启动阶段一 | 异步触发 infra |
| `Orchestrator.ResumeStartGitspace` | `orchestrator_resume.go:36` | 启动阶段二 | infra 完成回调 |
| `InfraProvisioner.TriggerInfraEventWithOpts` | `infrastructure/trigger_infra_event.go:42` | 基础设施编排 | 按 event 分发 |
| `InfraProvider` interface | `infraprovider/infra_provider.go:24` | 提供者契约 | Provision/Stop/... |
| `DockerProvider` | `infraprovider/docker_provider.go` | 唯一自带实现 | ProvisioningType=Existing |
| `GitnessSCM.ResolveCredentials` | `scm/gitness_scm.go:153` | git 凭证 | 签发 PAT |
| `buildSetupSteps` | `orchestrator/container/embedded_docker_container_orchestrator.go:620` | 容器步骤序列 | 可增删 step |

</details>

## 核心实现

### 异步事件驱动三段式

启动分两阶段异步：阶段一 `TriggerStartGitspace` 做轻量准备（拉 SCM 详情、解析 devcontainer、取连接器、算端口）后**异步触发**基础设施供给，立即返回；阶段二 `ResumeStartGitspace` 在 infra 供给完成的事件回调里执行重活（解析 access key、取容器编排器、解密 AI auth、`CreateAndStartGitspace`）；阶段三 `FinishResumeStartGitspace` 在容器启动完成后生成访问入口（IDE URL、SSH 命令）并置 Running 状态。这种把耗时操作拆成事件回调链的设计，让 API 调用方不必长时间阻塞，也容忍 infra/container 各自的失败重试。三路事件 `events/gitspace`（gitspace 状态）、`events/gitspaceoperations`（容器操作）、`events/gitspaceinfra`（infra 状态）协调阶段流转。

### 基础设施抽象与 DockerProvider

两层抽象：`infrastructure.InfraProvisioner` in `app/gitspace/infrastructure/trigger_infra_event.go:42` 是编排层，负责参数组装、DB 持久化（`infraProvisionedStore`）、按 `ProvisioningType` 分流，`TriggerInfraEventWithOpts` 按 event 类型（Provision/Deprovision/Stop/Cleanup）分发。`infraprovider.InfraProvider` interface in `infraprovider/infra_provider.go:24` 是真正的提供者契约（`Provision`/`Find`/`Stop`/`Deprovision`/`ValidateParams`/`GenerateSetupYAML`）。

enum 定义 5 种 provider（`Docker`/`HarnessGCP`/`HarnessCloud`/`HybridVMGCP`/`HybridVMAWS`），但 `infraprovider/infra_provider_factory.go:31` 的 `NewFactory` **只注册了 `DockerProvider`**——其余 4 种待核实是否在 Harness Platform（SaaS）侧独立实现。`DockerProvider` in `infraprovider/docker_provider.go` 的 `ProvisioningType()` = `Existing`（复用宿主机已运行的 docker engine，不创建 VM），`Provision` 创建 named volume（`gitspace-<spacePath>-<identifier>`）+ 端口映射 + emit infra 事件，`Stop` = NOOP（不停 docker engine），`Deprovision` 仅 `canDeleteUserData=true` 时删 volume。

### SCM 集成与凭证注入

`scm.SCM` in `app/gitspace/scm/scm.go:41` 通过 `Factory` in `scm_factory.go` 按 `GitspaceCodeRepoType` 取 `AuthAndFileContentProvider`。`GitnessSCM` in `gitness_scm.go` 用于 Harness 自家仓库：`ResolveCredentials` 用 `bootstrap.NewGitspaceServiceSession().Principal`（见 [启动模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/01-bootstrap-wire)的 gitspaceServicePrincipal）作为 PAT 签发者，为用户创建名为 `Gitspace_Default` 的 PAT（720 天 JWT），`BuildAuthenticatedCloneURL` in `scm.go:204` 把 token 嵌入 clone URL，容器内经 `utils.SetupGitCredentials` in `orchestrator/utils/git.go:51` 写入 git credential store 使用户能 push。`GenericSCM` in `public_scm.go` 用于公开仓库，`GetFileContent` 用 `git clone --depth 1` 到 `/tmp/git/` 再 `ls-tree`+`cat-file` 读 devcontainer.json。`BuildAuthenticatedCloneURL` 已预留 GitHub/GitLab/Bitbucket 分支，但 Factory 目前只注册 Gitness + Unknown 两种 provider。

### Devcontainer 步骤序列

使用 devcontainer.json 标准（`.devcontainer/devcontainer.json`，支持 JSONC）。`DevcontainerConfig` 含 `Image`/`Features`/`RunArgs`/`ForwardPorts`/`Customizations`/lifecycle commands（`postCreateCommand`/`postStartCommand`）。容器创建 in `embedded_docker_container_orchestrator.go` 的 `runGitspaceSetupSteps`：取 image → 解析 runArgs（从 `runarg/runArgs.yaml` 静态 schema）→ PullImage → InstallFeatures（Download+Resolve+Sort+Build 新镜像）→ CreateContainer（挂 volume、端口映射、env、containerUser/remoteUser）→ ManageContainer(Start) → `setupGitspaceAndIDE` 执行步骤序列。

步骤序列 `buildSetupSteps` in `embedded_docker_container_orchestrator.go:620`：`ValidateSupportedOS` → `ManageUser` → `SetEnv` → `InstallTools` → `InstallGit` → `SetupGitCredentials` → `CloneCode` → `InstallAIAgents` → `SetupIDE` → `RunIDE` → lifecycle hooks。每个 step 是 `func(ctx, *devcontainer.Exec, GitspaceLogger) error`，可设 `StopOnFailure`。`devcontainer.Exec` in `orchestrator/devcontainer/exec.go:42` 封装 Docker exec API，是所有容器内命令执行的底层通道。

### 端口转发与日志

端口转发：`getPortsRequiredForGitspace` in `orchestrator_trigger.go:463` 合并 IDE 端口 + devcontainer `forwardPorts`，`DockerProvider.Provision` 初始化 `PortMapping{PublishedPort:0, ForwardedPort:0}`（docker 自动分配），`FinishResumeStartGitspace` 的 `getIDEPort` 从 `GitspacePortMappings` 或 `startResponse.PublishedPorts` 取端口拼 IDE URL，`getHost` 优先用 `ProxyGitspaceHost`。日志：`logutil.StatefulLogger` in `logutil/stateful_logger.go:28` 封装 [基础设施层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/09-infra)的 `livelog.LogStream`，`CreateLogStream` 建流（ID 加 1000000000 偏移避冲突），`LogStreamInstance.Write` 逐行写 `livelog.Line{Number, Message, Timestamp}`，`devcontainer.Exec.ExecuteCommandInHomeDirAndLog` 的输出经 channel 送到 logger 写流。注意 EmbeddedDockerOrchestrator 的 `StreamLogs` 当前返回 "not implemented"，推测远程 provider（HybridVM）通过 agent API 实现。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 异步事件三段式 | Trigger→Resume→Finish | 耗时操作不阻塞 API |
| Factory（infra/scm/ide/secret） | 各 `*_factory.go` 按 enum 注册 | 多后端可插拔 |
| 步骤序列 | `buildSetupSteps` `[]step` 切片 | 可增删/StopOnFailure |
| 两层 infra 抽象 | InfraProvisioner 编排 + InfraProvider 实现 | 编排与实现解耦 |

## 模块间交互

`Orchestrator` 依赖 `scm.SCM`、`infrastructure.InfraProvisioner`、`container.Factory`、`ide.Factory`、`secret.ResolverFactory`、`platformconnector`、`platformsecret`、`events.Reporter`（三路 gitspace 事件）、`gitspacesettings.Service`、`store.GitspaceInstanceStore`/`GitspaceConfigStore`/`SpaceStore`、`infraprovider.Service`。复用 [git](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/05-git)的 `git.Interface` 读 devcontainer、[启动模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/01-bootstrap-wire)的 gitspaceServicePrincipal 签发 PAT。

## 扩展方式

**新增基础设施提供者（如 k8s）**：实现 `infraprovider.InfraProvider` interface（`ProvisioningType` 按 New/Existing 选），在 `infraprovider/infra_provider_factory.go:NewFactory` 注册。若 `ProvisioningType=New`，`InfraProvisioner` 走 `provisionNewInfrastructure`（含 `infraProvisionedStore` 持久化 + pending 去重）。同时在 `container/orchestrator_factory.go:NewFactory` 注册对应 `container.Orchestrator` 实现。

**新增 SCM（如 GitHub）**：实现 `scm.AuthAndFileContentProvider` + `scm.ListingProvider`，在 `scm/scm_factory.go:NewFactory` 按 `GitspaceCodeRepoType` 注册。`BuildAuthenticatedCloneURL` 已预留 GitHub 分支，只需实现 provider 的 `ResolveCredentials`/`GetFileContent`。

**改 devcontainer 启动逻辑**：修改 `EmbeddedDockerOrchestrator.buildSetupSteps` 的 `[]step` 切片——增删步骤或调 `StopOnFailure`。lifecycle hooks 从 container labels 或 devcontainer config 提取（`ExtractLifecycleCommands`）。镜像构建在 `runGitspaceSetupSteps` 前段（features→新 image），改镜像构建逻辑在此。
