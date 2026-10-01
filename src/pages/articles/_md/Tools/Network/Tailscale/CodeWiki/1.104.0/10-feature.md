---
source:
  type: "源码解读"
  project: "Tailscale"
  url: "https://github.com/tailscale/tailscale"
title: "feature 特性架构"
date: "2026-10-01T22:41:19+08:00"
category: [Tools, Network, Tailscale, CodeWiki, "1.104.0"]
contentType: "CodeWiki"
tags: ["Tailscale", "Go", "模块化", "构建裁剪"]
description: "feature/ 特性架构：注册表、hooks、禁用机制、condregister 条件导入与 45 个可裁剪特性包的设计解读。"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Network/Tailscale/CodeWiki/1.104.0/00-overview)

---

## 模块定位

`feature/` 是 Tailscale 近两年最重要的架构重构：把原本散落在 ipn/wgengine 的可选特性（Taildrop、conn25、ACME、SSH、tailnetlock……共 45 个特性包、88 个 feature tag）拆成**自注册的 feature 包**，通过构建标签/环境变量控制启用禁用。根目录仅 ~620 行（`feature.go`/`disable.go`/`hooks.go`），设计文档 `feature/README.md`（441 行）是全库最重要的单篇文档。动机（README 开篇）：**IoT 几美元芯片的设备不需要 Taildrop/WebDAV/ACME/SSH**——三重价值：① 二进制体积与依赖面（depaware 快照每次 PR 显式 diff）；② 新代码的默认归宿是 `feature/<name>` 小包而非继续往 LocalBackend 倾倒（依赖倒置：经钩子被调用而非被 import）；③ 运行时攻击面收缩（某特性爆 CVE 时不必全员暴露）。

## 模块架构

四个机制组成闭环：**注册表**（特性存在的唯一事实）、**hooks**（特性向核心注入实现的通道）、**禁用**（运行时砍掉）、**condregister 条件导入**（编译期砍掉）。

```go title="feature/feature.go — 极简注册表"
var in = map[string]bool{}
func Register(name string) bool   // 重复注册 panic；返回 false = 已被禁用
```

注册表真源是 `Features` map（`feature/featuretags/featuretags.go`），记录符号名、描述、依赖 DAG；`go generate ./feature/buildfeatures` 生成 `HasFoo` 常量对（enabled/disabled 双文件）供编译器 DCE。**关键区分**：`buildfeatures.HasFoo`（未被 tag 裁掉）≠ 已注册（tsnet 不导入 condregister）——惯用写法 `buildfeatures.HasFoo && feature.IsRegistered("foo")`（README "tsnet does NOT depend on condregister" 节）。

### 谁负责 import

中央包 `feature/condregister/`，每个默认特性一个 `maybe_<name>.go`，整个文件只有构建标签 + 空导入：

```go title="feature/condregister/maybe_taildrop.go（示意）"
//go:build !ts_omit_taildrop
package condregister
import _ "tailscale.com/feature/taildrop"
```

tailscaled 导入 condregister → 全量特性进二进制；加 `ts_omit_<name>` tag 删掉该文件 → import/init/整个依赖树被裁掉。

### 典型特性包的 init

```go title="feature/taildrop/ext.go — init 自注册"
func init() {
    if !feature.Register("taildrop") { return }
    ipnext.RegisterExtension("taildrop", newExtension)
    ipnlocal.RegisterPeerAPIHandler("/v0/put/", handlePeerPut)
    localapi.Register("files/", serveFiles)
}
```

## 调用链路

### 禁用机制（disable.go）

**静态禁用**：`ts_omit_<name>` 构建标签，代码从二进制消失。**运行时禁用**：`TS_DISABLE_FEATURE=ssh,taildrop` 环境变量（`disabledEnv` in `feature/disable.go`，基于 `envknob.RegisterString`，进程启动读一次）。`Disabled(name)` 按序三层兜底：

1. `Register` 返回 false，不记录；
2. `ipnext.RegisterExtension` 静默忽略；
3. **`Hook.Set`/`Hooks.Add` 回溯调用栈**——`callerFeatureName` in `feature/disable.go` 用 `runtime.Callers` 找到第一个 `tailscale.com/feature/` 下的调用方包名，若该 feature 被禁用则跳过注册（兜住忘记调 `Register` 的子包）。

名称归一化（`normalizeFeatureName`）容忍大小写/空格/`ts_omit_` 前缀/下划线。`register_disable_test.go` 在子进程禁用全部特性并断言零注册，防止机制被破坏。注意：**v1.104 的运行时禁用只走环境变量**（syspolicy 是独立的另一个 feature 包，不在此路径上）。

### hooks 机制

两类型（均定义在 `feature/feature.go`）：`Hook[Func]`（单写者，`Set` 一次重复 panic，读取 `GetOk/GetOrNil/IsSet`）与 `Hooks[Func]`（slice，多方注册）。典型使用方（`feature/hooks.go`）：`HookCanAutoUpdate`（clientupdate）、5 个 proxy 钩子（useproxy，让 tshttpproxy 不再硬依赖）、`HookTPMAvailable`、`HookGetSSHHostKeyPublicStrings`（**ipnlocal 因此不必 import `golang.org/x/crypto/ssh`**）。铁律：hooks.go 里的签名禁止引用重型类型（net/http、crypto/tls），`depaware-min.txt` 是"神圣不可增长"的依赖快照。

## 核心实现

### Taildrop：特性化的样板

接收端 `manager`（`feature/taildrop/taildrop.go`）+ `incomingFile`（`send.go`）。两种落盘模式：**staged 模式**写 daemon 持有的 `.partial` 暂存目录，GUI 经 localapi `files/` 枚举/取走/删除；**DirectFileMode**（`managerOptions.DirectFileMode`）macOS/NAS 直写最终目录，完成时把 `.<clientID>.partial` rename 成正式名（`fsFileOps.Rename` in `fileops_fs.go`），避免二次拷贝。**断点续传靠分块校验和**：64KB 块 sha256（`blockChecksum` in `resume.go`），发送方调 `HashPartialFile` 取接收端已有块哈希，`resumeReader` 逐块比对，首个失配处开始续写。`FileOps` 接口抽象平台差异（Android 走 Storage Access Framework）。接收入口 `handlePeerPut` in `peerapi.go`（peer API `PUT /v0/put/<filename>`，capability 门控 `peercap.FileSharingSend`）。

### conn25：域路由的 app connector 替代

包注释（`conn25.go`）原文："app connector like feature that routes traffic for configured domains via connector devices and avoids the 'too many routes' pitfall of app connector"——用**"Magic IP + Transit IP"的 DNAT/SNAT 映射**（`Conn25Datapath` in `datapath.go`）替代向全 tailnet 播撒海量 /32 路由；配套 `ippool.go`（round-robin `ipSetIterator` 分配 Transit IP）与 `flowtable.go`（活跃流表）。

## 设计模式

| 模式 | 位置（文件+方法） | 为什么用 |
| --- | --- | --- |
| 注册表 + init 自注册 | `Register` in `feature/feature.go` | import 即装配，无显式调用点 |
| 依赖倒置 hook | `Hook[T]`/`Hooks[T]` in `feature/feature.go` | 核心不 import 特性，二进制可裁剪 |
| 条件导入 | `condregister/maybe_*.go` | 构建标签控制整个依赖树是否链接 |
| 调用栈回溯 | `callerFeatureName` in `feature/disable.go` | 兜住未调 Register 的子包 |

## 模块间交互

特性包向四处注册：`ipnext.Extension`（LocalBackend 扩展宿主）、`ipnlocal.RegisterPeerAPIHandler`、`localapi.Register`、各核心包的 Hook 变量。被 tailscaled（经 condregister 全量）与 tsnet（`tsnet/maybe_*.go` 按需）两类消费者导入。`register_disable_test.go` + `deptest.DepChecker`（deps_test.go）锁死裁剪成果。

## 扩展方式

新增一个 feature 的文件清单（README 末节）：① `feature/featuretags/featuretags.go` 加 `Features` 条目（含 Deps）；② 跑 `./tool/go generate ./feature/buildfeatures`；③ 建 `feature/<name>/`，init 内 `feature.Register` + 设钩子/`ipnext.RegisterExtension`；④ tailscaled 默认要 → 加 `feature/condregister/maybe_<name>.go`；⑤ tsnet 要 → 加 `tsnet/maybe_<name>.go`；⑥ 加 `deptest.DepChecker` 测试锁死 omission；⑦ 重生成 depaware 并 review diff。
