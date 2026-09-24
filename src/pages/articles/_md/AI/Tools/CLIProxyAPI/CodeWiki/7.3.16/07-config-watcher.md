---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "配置与凭据热重载"
date: "2026-09-25T00:05:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "fsnotify", "热重载", "事件驱动"]
description: "配置与凭据热重载：fsnotify 双目录监听、150ms debounce 与 YAML 字节快照防引用共享、单文件增量合成 + 墓碑 revision 防删除复活、generation 三层版本机制、Management 写路径故意复用同一条 reload 链"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`internal/watcher/`（5 个非测试文件 ~1.5k 行 + `diff/` + `synthesizer/` 两个子包）是代理进程的**控制面感知层**：config.yaml 和 auth 目录的一切磁盘变化——手工编辑、Management API 写盘、OAuth 刷新器回写 token——都经它变成进程内的增量更新，**不重启、不丢运行时状态**。下游消费方是 Service（配置应用与凭据定点注册）与 `api.Server`（字段级 diff 重启子组件）。

一个先澄清的事实：config 侧**没有结构化事件类型**（全仓不存在 `ConfigChangeEvent`）——fsnotify 事件直接触发回调链，只有 auth 侧产出 `AuthUpdate` 结构化事件进队列。这个不对称是刻意的：config 变更低频且天然全局（走全量重载），auth 变更高频且必须局部（走单文件增量）。

## 模块架构

```
fsnotify（configPath + authDir 双 watch）
   │
   ├── config 事件 ──► scheduleConfigReload（150ms debounce）
   │                    └── reloadConfigIfChanged（SHA-256 去重）
   │                         └── reloadConfig：LoadConfig + oldConfigYaml 字节快照反序列化
   │                              ├─ diff.BuildConfigChangeDetails（脱敏变更清单日志）
   │                              └─ reloadClients → reloadCallback → Service.applyWatcherConfigUpdate
   │                                   └─ Server.UpdateClientsContext（字段级 diff 应用）
   │
   └── auth 事件 ──► authFileUnchanged（SHA-256 去重 + Remove 1s debounce）
                        └── addOrUpdateClientLocked：synthesizer 只合成这一个文件
                             └── computePerPathUpdatesLocked（path 内 set-diff）
                                  └─ stampAuthUpdatesLocked（墓碑 revision）
                                       └─ dispatchLoop（sync.Cond）→ authQueue(256) → Service 定点更新
```

组织成三段流水：**感知**（`events.go` 的 `handleEvent`，events.go:67——去重与 debounce 全在这一层）、**合成**（`synthesizer.SynthesizeAuthFile` 把 config 字段与 auth JSON 合成 `coreauth.Auth` 条目）、**派发**（`dispatcher.go` 的去重队列与 `clients.go` 的回调）。`Watcher struct`（`watcher.go:33`）持有全部缓存 map：`lastAuthHashes`（事件级去重）、`fileAuthsByPath`（path → auth ID 集合，set-diff 的依据）、`authRevisions`（**含删除墓碑**的单调序号）、`fileObservations`（作废 in-flight 扫描用）、`oldConfigYaml`（YAML 字节快照）。

## 调用链路

两条主链路（字段名均为实地核查）：

```
config 链（全量重载 + 字段级应用）：
Watcher.start(events.go:29) 注册双 watch
└── handleEvent → scheduleConfigReload(config_reload.go:29)     # 150ms debounce，timer 重置
    └── reloadConfigIfChanged(config_reload.go:51)               # 重读文件 SHA-256，相同即跳过
        └── reloadConfig(config_reload.go:88)
            ├── config.LoadConfig                                # 新配置
            ├── oldConfigYaml 反序列化 → old                      # 字节快照防引用共享
            ├── diff.BuildConfigChangeDetails                    # 人类可读脱敏 diff 日志
            └── reloadClients(clients.go:25)
                └── w.reloadCallback(cfg)(clients.go:146)
                    └── Service.applyWatcherConfigUpdate(service_config.go:18)
                        └── commitConfigUpdate（configSequence 乐观锁）
                            └── Server.UpdateClientsContext(server_reload.go:45)
                                # oldCfg 逐字段比对 ~20 项（request-log/logging/
                                # RemoteManagement 启停 Management 路由…）
                                # 应用后 yaml.Marshal(cfg) 存新快照

auth 链（单文件增量 → 事件 → 队列 → 定点更新）：
handleEvent → authFileUnchanged(events.go:153) 去重
└── addOrUpdateClientLocked(clients.go:172)
    └── synthesizer.SynthesizeAuthFile（只合成这一个文件）
        └── computePerPathUpdatesLocked(clients.go:306)
            # 对该 path 的 old/new ID 集合 set-diff → Add/Modify/Delete 三类 AuthUpdate
            └── stampAuthUpdatesLocked(dispatcher.go:222)        # 打墓碑 revision
                └── dispatchAuthUpdates(dispatcher.go:242)
                    └── dispatchLoop(dispatcher.go:280) → authQueue(256)
                        └── Service.consumeAuthUpdates(service_auth.go:49，批量 drain)
                            └── handleAuthUpdates(service_auth.go:99)
                                # 按 revision 丢弃过期 → 定点注册/删除（不走全量 rebuild）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `handleEvent` in `internal/watcher/events.go:67` | fsnotify 事件分流 config/auth | 感知层集中去重 |
| `scheduleConfigReload` in `config_reload.go:29` | config 写事件 150ms debounce | 编辑器连发写事件收敛成一次 |
| `reloadConfigIfChanged` in `config_reload.go:51` | SHA-256 去重后触发重载 | 同内容不重载 |
| `reloadConfig` in `config_reload.go:88` | 全量重读 + diff 日志 + 回调 | `oldConfigYaml` 字节快照 |
| `addOrUpdateClientLocked` in `clients.go:172` | 单文件增量合成 | OAuth 刷新高频写不触发全量重扫 |
| `computePerPathUpdatesLocked` in `clients.go:306` | path 内 set-diff 产三类事件 | Add/Modify/Delete 语义完备 |
| `stampAuthUpdatesLocked` in `dispatcher.go:222` | 事件打单调 revision | 墓碑机制防删除复活 |
| `dispatchLoop` in `dispatcher.go:280` | cond-var 派发循环 | `pendingUpdates` 按 auth ID 去重合并 |
| `handleAuthUpdates` in `service_auth.go:99` | 消费端定点更新 | 注释明言避免全局 plugin rebuild 阻塞 PATCH |
| `UpdateClientsContext` in `internal/api/server_reload.go:45` | 字段级 diff 应用到 server | oldCfg 反序列化自字节快照 |
</details>

## 核心实现

### 去重与 debounce：感知层的三道闸

fsnotify 对一次保存可能报多个事件（编辑器先 truncate 再写、原子替换先 Rename 后 Write），重载路径又重（`LoadConfig` + 客户端重建），所以感知层叠了三道闸：**config 侧 150ms debounce**（`config_reload.go:35`，timer 重置式——连续写事件只触发最后一次）；**auth 侧 SHA-256 内容去重**（`authFileUnchanged` in `events.go:153`，hash 不变直接吞掉事件）；**Remove 事件 1s debounce 窗口**（`shouldDebounceRemove` in `events.go:195`——很多"删除"其实是原子替换的中间态，等 1 秒后文件又出现了）；Replace 后另有 50ms stat 复查（`events.go:103`）处理 Rename→Write 竞态。注意 `triggerServerUpdate`（`clients.go:476`，1s debounce）在 v7.3.16 已无调用方（全仓仅剩定义处），是遗留代码。

### YAML 字节快照：为什么旧配置不能存指针

字段级 diff 的正确性依赖"旧值真的是旧值"。`reloadConfig` 把旧 config 存为 `yaml.Marshal` 的**字节快照**（`config_reload.go:108-111`），`UpdateClientsContext` 用时反序列化（`server_reload.go:55-59`）。Why 不直接存 `*config.Config`：Go 的结构体赋值是浅拷贝，新旧两个 Config 若共享内部 slice/map 指针，"旧对象"会随新对象一起变——字段 diff（`oldCfg.X != cfg.X`）永远判等，热重载静默失效。字节快照是唯一便宜且彻底的深拷贝。这也是全仓的通用手法：`Server` 侧同样维护自己的 `s.oldConfigYaml` 快照。

### 删除复活：墓碑 revision 与作废扫描

最难的一类竞态：**慢扫描拿到过期快照**。全量重扫（`refreshAuthState` in `dispatcher.go:138`）遍历目录期间，用户删了一个 auth 文件——扫描的内存视图里它"还在"，扫完后按视图派发 Add/Modify，一个刚被删除的凭据就"复活"了。两层防御：

- `authRevisions` 是**含删除墓碑**的单调序号：Delete 事件也占一个 revision（`stampAuthUpdatesLocked`，`dispatcher.go:222`），消费端 `handleAuthUpdates` 按 revision 丢弃乱序到达的旧事件——扫描产出的低 revision Add 落后于删除的高 revision，直接扔掉；
- `changedDuringScan`（`dispatcher.go:152-159`）用 `fileObservations`（**内容未变也记账**的纯事件计数）在扫描期间收到任何事件就作废对应条目——不依赖内容 hash，纯粹以"事件发生过"作废。

### 单文件增量合成：OAuth 刷新高频写的生存前提

auth 事件走 `addOrUpdateClientLocked` → `synthesizer.SynthesizeAuthFile` **只合成这一个文件**，经 `computePerPathUpdatesLocked` 对该 path 的 old/new ID 集合做 set-diff 产出事件；只有 `authDirChanged`（目录本身迁移）才触发全量重扫（`config_reload.go:137→142`）。Why：OAuth token 刷新循环每 15 分钟扫一遍全部凭据、429 重试还会额外回写——每次都全量重扫会重建所有客户端，在途请求抖动。去重合并还发生在派发前：`pendingUpdates` 按 auth ID 合并（`dispatchAuthUpdates` in `dispatcher.go:242`），同一凭据短时间多次变更只投递最终态。

### generation 三层版本：谁的旧值都不能覆盖新值

revision 机制实际是三层，各解决一层竞态：

| 层 | 定义位置 | 解决什么 |
|---|---|---|
| `AuthUpdate.revision` | `internal/watcher/dispatcher.go:258` | 派发队列内事件乱序 |
| `Service.authRevisions` | `sdk/cliproxy/service_auth.go:130-133` | 消费端队列堆积时的过期过滤 |
| `Auth.Generation`/`RegistrationEpoch` | Conductor 递增（`conductor_lifecycle.go:213-216`） | 持久化回写 vs 运行时状态覆盖 |

第三层最微妙：watcher 从磁盘合成的 `Auth` 是"纯文件视图"，但 Conductor 在调度中已给同一凭据累积了冷却/ModelState——Service 用 `isStaleCoreAuth`（`service_auth.go:478`）拒绝旧 Generation 的合成结果覆盖 Conductor 已推进的状态。三个来源（文件、Management API、运行时回写）在没有任何全局锁的情况下靠单调序号达成最终一致。

### Management 写路径：故意绕远路

Management API 保存配置不是直接改内存：`SaveConfigPreserveComments`（`internal/config/config_yaml.go:14`，yaml.Node 树原地合并，**保留用户注释与键序**）写盘 → `reloadConfigAfterManagementSave`（`management/handler.go:189`，generation 单调门闩）→ `configReloadHook` → builder 注册的 `service.reloadConfigFromWatcher`（`builder.go:301`）→ 与手工编辑**同一个** `Watcher.ReloadConfigIfChanged`。Why 绕一圈：写盘本身就会触发 fsnotify 事件，如果 Management 另走一条"直接应用"的捷径，就会出现两套应用逻辑漂移 + 双重重载；复用同一条 hash 去重的路径，保证"Management 改"和"手工改"语义严格一致。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 观察者（生产者-消费者） | `authQueue`(256) + `dispatchLoop` in `dispatcher.go:280` | 感知与消费解耦，批量 drain |
| Debounce（多层） | `config_reload.go:35` / `events.go:195` | 收敛编辑器/原子替换的事件风暴 |
| 快照隔离 | `oldConfigYaml` in `config_reload.go:108` + `server_reload.go:55` | 字节快照深拷贝防引用共享 |
| 墓碑 + 单调 revision | `authRevisions` + `stampAuthUpdatesLocked` in `dispatcher.go:222` | 无锁最终一致，防删除复活 |
| 闭包包装（版本兼容） | `WatcherWrapper` in `sdk/cliproxy/types.go:103` | SDK 层持函数字段而非具体类型，internal watcher 演进时 nil 检查优雅降级 |

## 模块间交互

依赖 `internal/config`（加载与注释保真写回）、`synthesizer`/`diff` 子包、`sdk/cliproxy/auth`（Auth 类型）；被 `sdk/cliproxy`（Service 装配，经 `WatcherWrapper` 闭包）和 `internal/api/handlers/management`（auth 文件 CRUD 直接 import synthesizer 合成——管理面与 watcher 共享同一套文件→Auth 语义）引用。与 Conductor 不直接调用，靠 `Auth.Generation` 间接协作（见上节第三层）。下游配置应用详见 [01-service-core](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/01-service-core)；Management 侧的写入口详见 [11-management](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/11-management)。

## 扩展方式

**新增一个 config 字段的热重载**改三处：`internal/config/config_types.go`（字段定义）→ `internal/watcher/diff/config_diff.go` 的 `BuildConfigChangeDetails`（加 diff 日志行）→ `internal/api/server_reload.go` 的 `UpdateClientsContext`（加 `oldCfg == nil || oldCfg.X != cfg.X` 分支调用对应 setter）；若字段影响凭据合成再加 `synthesizer/config.go`。

**新增一种 auth 事件动作**（如 "disable"）：`internal/watcher/watcher.go:73` 加 `AuthUpdateAction` 常量 → `computePerPathUpdatesLocked`（`clients.go:306`）产出该动作 → `sdk/cliproxy/service_auth.go` 的 `handleAuthUpdates` switch 加处理分支。

**新增凭据文件类型**（非 .json）：`internal/watcher/events.go:75`（`isAuthJSON` 后缀过滤）+ `synthesizer/file.go` 解析 + `loadFileClients`（`clients.go:376`）的后缀判断。
