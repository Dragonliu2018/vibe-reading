---
source:
  type: "源码解读"
  project: "Omarchy"
  url: "https://github.com/basecamp/omarchy"
title: "插件系统"
date: "2026-08-25T10:44:29+08:00"
category: [OS, Linux, Distribution, Omarchy, CodeWiki, "4.0.0"]
tags: ["Omarchy", "QML", "插件", "Quickshell", "IPC"]
description: "Omarchy 桌面的扩展点——manifest 驱动的插件发现/校验/加载、6 种 kind 分流、shell.json 持久化与 IPC 契约。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/Distribution/Omarchy/CodeWiki/4.0.0/00-overview)

---

## 模块定位

插件系统是 Omarchy 桌面的扩展点：顶栏、面板、浮层、菜单、后台服务全部是插件，由 `PluginRegistry` 按 `manifest.json` 声明发现、校验、加载，经 `shell` IPC 召唤/隐藏，启用状态持久化到 `shell.json`。它解决"桌面 UI 可热插拔、第三方可扩展、不重启 Shell"的问题。`PluginRegistry` 是 `QtObject` 实例（非 singleton），由 ShellRoot 持有并注入（见[Shell 框架](01-shell-framework)）。

## 模块架构

![插件发现 / 加载 / 召唤生命周期](/vibe-reading/images/articles/omarchy-internals/plugin-lifecycle.svg)

`PluginRegistry`（`shell/services/PluginRegistry.qml`）是心脏，持有 `installedPlugins`（id→manifest 字典）、`registryRevision`（递增版本号驱动 QML binding 刷新）、`lastEnableError`。它不直接读写文件——通过两个闭包与 shell.json 交互：`shellConfigProvider()`（读当前配置）与 `shellConfigMutator(fn)`（深拷贝→fn→persist，由 `shell.qml:149-150` 注入）。`BarWidgetRegistry` 负责 bar widget component 的 register/unregister。`shell.qml` 的 `IpcHandler target="shell"`（`shell.qml:872`）暴露 summon/hide/toggle/setPluginEnabled/listPlugins 等方法，被 `bin/omarchy-shell` 桥接。

## 调用链路

插件从发现到运行的四阶段链：

```
rescan() (PluginRegistry.qml:662)
  └ bash 子进程扫描 firstPartyDir(mindepth 2-3) + ~/.config/omarchy/plugins/(顶层)
     输出 ===<kind>::<dir>=== <manifest> === EOM ===
  → parseScanOutput (line 551): JSON.parse → validateManifest → 盖 __sourceDir/__isFirstParty
  → installedPlugins 合并（first-party 优先，omarchy.* 命名空间保留给 first-party，line 602-609）

加载（按 kind 分流，shell.qml）:
  bar           → activeBarId (line 167) → pluginBarLoader ‖ defaultBarLoader
  bar-widget    → syncPluginWidgets (line 669) → BarWidgetRegistry.register → Bar.qml layout 实例化
  panel/overlay/menu → computePanelEntries (line 586) → Instantiator Loader.active = keepLoaded ‖ open
  service       → _syncServices (line 323) → ensureService() → createObject(serviceHost)

召唤: omarchy-shell shell summon omarchy.menu '{"menu":"system"}'
  → shell.summon(id, payload) (line 440)
  → resolveEnabledId()（clone 时路由到活跃 clone）
  → isEnabled() 检查 → openPanelIds[id]=true → pendingPayloads push
  → deliverIfLoaded() → item.open(payloadJson)
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 | 关键决策 |
| --- | --- | --- | --- |
| `validateManifest(m, path)` | `PluginRegistry.qml:43` | 校验 schemaVersion=1、必填字段、id 合法、entryPoints 路径安全 | 路径遍历双重防御（`isSafeEntryPoint` + `entryPointUrl`） |
| `isEnabled(id)` | `PluginRegistry.qml:110` | 判断插件启用 | first-party 非 bar 默认启用除非 `disabledPlugins[]`；第三方 present⇔enabled |
| `resolveEnabledId(id)` | `PluginRegistry.qml` | clone 路由 | 内置 id 被 clone 时路由到活跃 clone（`omarchy.clonedFrom`） |
| `setEnabled(id, val, placement)` | `PluginRegistry.qml:449` | enable/disable 状态机 | 按 kind 操作 shell.json 不同字段（见核心实现） |
| `barTarget(config, placement, fallback)` | `PluginRegistry.qml` | 计算 bar widget 插入位置 | before/after/index/anchor |
| `rescan()` | `PluginRegistry.qml:662` | 重扫插件目录 | bash 子进程异步，`scanning` 标志防并发 |
| `localPluginIdForPath(path)` | `PluginRegistry.qml` | inotify 路径→plugin id | 150ms debounce Timer 热重载用户插件 |

</details>

## 核心实现

### manifest 契约与校验

每个插件目录（一方在 `shell/plugins/`，三方向 `~/.config/omarchy/plugins/<id>/`）须有 `manifest.json`。完整 schema（`shell/services/PluginRegistry.qml:43-91` 校验）：

```json title="shell/plugins/agents/manifest.json（最完整示例）"
{
  "schemaVersion": 1,                       // 必填，当前仅 1
  "id": "omarchy.agents",                   // 必填，不含 "/" 或 ".."
  "name": "Agents", "version": "1.0.0",     // 必填
  "kinds": ["bar-widget"],                  // 必填，非空，6 种合法值
  "activation": "on-demand",                 // 可选
  "entryPoints": { "barWidget": "Panel.qml" },  // 必填，kind→相对路径（不能 / 开头、不含 ..）
  "keepLoaded": true,                        // 可选，Loader 常驻
  "barWidget": {                             // bar-widget 元数据
    "displayName": "Agents", "category": "AI", "allowMultiple": false,
    "defaults": { "refreshIntervalSec": 900 },   // 默认 inline settings
    "schema": [ { "key": "refreshIntervalSec", "type": "integer", "min": 30, "max": 3600 } ]
  }
}
```

六种 `kind`：`bar`（全局唯一，`bar.id` 选中即加载）、`bar-widget`（注册到 BarWidgetRegistry，bar layout 引用即实例化）、`panel`/`overlay`/`menu`（Instantiator Loader，`keepLoaded` 或 summon 时 active）、`service`（`_syncServices` 启动时加载单例，无 UI）。校验在 `validateManifest()` 与 `entryPointUrl()` 两层做路径安全检查，防御 `..` 遍历。

### 按 kind 分流加载

`shell.qml` 按 manifest 的 `kinds` 数组走不同加载路径。`bar` 用 `selectedBarId`（`shell.qml:167`，读 `shellConfig.bar.id`）选 strategy——选中内嵌 `omarchy.bar` 用 `defaultBarComponent`，选第三方用 `pluginBarLoader`，加载失败 `activeBarId` fallback 回 `defaultBarId`。`panel`/`overlay`/`menu` 的 Loader `active = keepLoaded || openPanelIds[id]`（`shell.qml:625`）：`keepLoaded: true`（如 OSD、lock、menu）常驻，`open()` 只切 `visible`；默认 `keepLoaded: false` 隐藏即卸载。`service` 在 `_syncServices` 用 `Qt.createComponent(Component.PreferSynchronous)` 加载，存入 `_services` map，disable/移除时删除实例。

### shell.json 持久化与 enable 状态机

`setEnabled(id, value, placement)`（`PluginRegistry.qml:449`）通过 `shellConfigMutator` 闭包操作 shell.json 深拷贝，按 kind 走不同分支：

- **bar**：`value=true` → `config.bar.id = key`；`value=false` → 删除或回退到 `clonedFrom`
- **bar-widget**：`value=true` → clone 场景原地替换 `entry.id`，否则 `barTarget()` 计算位置后 `splice` 插入 layout；`value=false` → `splice` 删除
- **first-party 非 bar-widget**：`value=true` → 从 `disabledPlugins[]` 移除；`value=false` → 加入
- **第三方非 bar-widget**：`value=true` → push 到 `config.plugins[]`；`value=false` → 移除
- **clone 恢复**：禁用 clone 时 `restoreCloneSource()` 恢复源插件

操作完 `registryRevision++` + `pluginsChanged()`，触发 `shell.qml` 的 `_syncServices()`/`computePanelEntries()`/`syncPluginWidgets()` 重新同步。shell.json 的 `bar.id` 选 active bar、`bar.layout.<section>` 列 bar widget、`plugins[]` 列第三方非 bar、`disabledPlugins[]` 记 first-party 关闭项——**"third-party enabled ⇔ present in shell.json"** 是唯一事实来源，没有单独的 enabled 标志。

### 第三方安装与 clone 路由

`omarchy plugin add <url>`（`bin/omarchy-plugin-add`）：gum 确认（安全警告）→ `git clone` 到 staging → `omarchy-plugin-validate` 校验 → id 冲突检查 → `mv` 到 `~/.config/omarchy/plugins/<id>/` → `omarchy-shell shell rescanPlugins` → 轮询发现（最多 2s）→ 可选 `--enable` 选 section。

`omarchy plugin clone <built-in-id>`（`bin/omarchy-plugin-clone`）复制 first-party 到 `~/.config/omarchy/plugins/<user>.<id>/`，改写 manifest id 为 `username.omarchy.xxx`，设 `omarchy.clonedFrom`，enable clone。`resolveEnabledId()` 据此把对内置 id（如 `omarchy.clock`）的 IPC 调用路由到活跃 clone（如 `ace.clock`），**所以 clone 不需要改任何调用方**。移除活跃 clone 自动切回内置源。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Registry + Manifest-Driven Loading | `PluginRegistry.qml` + `manifest.json` | 契约声明式，kind 分流，新增插件零代码改 |
| IPC Facade | `shell.qml:872` IpcHandler + `bin/omarchy-shell` | bash argv 全 string，IPC 是 CLI↔Shell 唯一桥梁 |
| Strategy | `shell.qml:167` `selectedBarId` | bar.id 选 active bar，失败 fallback 内嵌 bar |
| Clone Routing | `resolveEnabledId()` + `omarchy.clonedFrom` | clone 内置 id 后旧调用方无须改 |
| Closure Injection | `shellConfigProvider`/`shellConfigMutator` | PluginRegistry 不做文件 IO，职责分离 |

## 模块间交互

插件系统依赖 [Shell 框架](01-shell-framework)（ShellRoot 装配 PluginRegistry、Commons/Ui 提供原语与组件）、[CLI 命令](03-cli-commands)（`bin/omarchy-shell` 桥接 IPC、`bin/omarchy-plugin-*` 包装 IPC）、[主题系统](05-theme-system)（插件经 Color/Style 取主题 token）。inotify 监视 `~/.config/omarchy/plugins/`，用户改插件文件 150ms debounce 后 `reloadPlugins()` 热重载。`omarchy-shell shell rescanPlugins` 是手动强制重载入口。

## 扩展方式

- **新增 first-party bar widget**：`shell/plugins/<name>/` 加 `manifest.json`（`kinds:["bar-widget"]`、`entryPoints.barWidget`、`barWidget` 元数据）+ `BarWidget.qml`（继承 `BarWidget`，设 `moduleName`），在 `config/omarchy/shell.json` 默认布局加 entry。无需改 PluginRegistry/shell.qml。
- **新增 panel 插件**：`manifest.json` `kinds:["panel"]` + `entryPoints.panel`，QML 实现 `open(payloadJson)`/`close()`/`opened` 属性，可选 `keepLoaded:true`。
- **支持多实例**：manifest 设 `barWidget.allowMultiple:true`，shell.json 在不同 section 重复放 `{ "id":"omarchy.xxx" }`，每个 ModuleSlot 独立 `settings`。
- **第三方插件**：`omarchy plugin add <git-url> --enable --yes`（非交互）。
