---
source:
  type: "源码解读"
  project: "Omarchy"
  url: "https://github.com/basecamp/omarchy"
title: "Shell 框架"
date: "2026-08-25T10:44:29+08:00"
category: [OS, Linux, Distribution, Omarchy, CodeWiki, "4.0.0"]
tags: ["Omarchy", "QML", "Quickshell", "桌面 Shell"]
description: "Omarchy 桌面 Shell 的基座——ShellRoot 装配、Commons 原语单例、33 个 Ui 组件、property injection 避免 singleton 副本。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/Distribution/Omarchy/CodeWiki/4.0.0/00-overview)

---

## 模块定位

Shell 框架是 Omarchy 桌面运行的基座：单一 Quickshell 进程的 `ShellRoot` 入口、`Commons/` 原语单例（Style/Color/Util/Border）、`Ui/` 可复用组件库（33 个）、`services/` 注册表。它解决"桌面 UI 共享一套主题 token 与组件"的问题，与插件系统（`plugins/`）分离——框架提供砖块，插件提供业务。本模块不含各插件实现（见[插件系统](02-plugin-system)），只讲承载它们的运行时与组件库。

## 模块架构

```
shell/
├── shell.qml              ShellRoot 入口（装配注册表 + shell.json 加载 + bar 渲染）
├── Commons/               原语单例（被所有 Ui 与插件 import）
│   ├── Style.qml          样式 token（spacing/font/corner/bar 尺寸，读 shell.toml）
│   ├── Color.qml          颜色 token（surface roles，读 shell.toml）
│   ├── Util.qml           纯函数（颜色混合、格式化等）
│   ├── Border.qml + BorderGeometry.js   边框 spec 工厂（surfaceSpec/controlSpec/flat）
│   └── Shadow.qml         阴影原语
├── Ui/                    33 个可复用组件
│   ├── BorderSurface.qml  主题感知边框基类（消费 Border spec）
│   ├── BorderOverlay.qml  Shape 路径渲染边框（渐变/分侧宽度）
│   ├── Panel.qml          面板基类（open/close 生命周期）
│   ├── PanelController.qml 面板控制
│   ├── Button.qml / Toggle.qml / Dropdown.qml / TextField.qml ...
│   └── PopupCard.qml / KeyboardPanel.qml ...
└── services/              注册表（property 注入给插件，非 singleton import）
    ├── PluginRegistry.qml     插件中央注册表（见插件系统模块）
    ├── BarWidgetRegistry.qml  bar widget component 注册表
    └── AppLibrary.qml         应用库 + AppSearch.js + hidden-entries.sh
```

`Commons/` 是底层原语（被 `Ui/` 与 `plugins/` 共同 `import qs.Commons`），`Ui/` 建在 Commons 之上，`services/` 是 ShellRoot 持有并注入下去的共享状态。三层自下而上：原语 → 组件 → 注册表/入口。

## 调用链路

ShellRoot 的启动装配链（开机完整链路见概览 boot-flow）：

```
shell.qml Component.onCompleted (line 141)
  ├ firstPartyDir / shellConfigProvider / shellConfigMutator 注入 PluginRegistry (line 148-150)
  ├ pluginRegistry.rescan()                          扫描插件目录
  ├ shell._syncServices()                           加载 service 类插件
  └ applyShellConfig() (line 72)                    读 shell.json
       ├ FileView defaultsFile (line 117, watchChanges) → loadDefaults
       ├ FileView userConfigFile (line 130, watchChanges) → 覆盖默认
       └ 解析失败 → fallback defaultsConfig → builtinShellConfig (line 36)
  → bar 渲染 (line 225): defaultBarLoader ‖ pluginBarLoader → configureBar() 注入
  → BarWidgetRegistry 同步 (syncPluginWidgets, line 669)
  → IpcHandler target="shell" 就绪 (line 872)
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 | 关键决策 |
| --- | --- | --- | --- |
| `applyShellConfig()` | `shell.qml:72` | 读默认+用户 shell.json，设 shellConfig | 无 deep-merge：有效用户配置完全覆盖，无效完全 fallback |
| `configureBar()` | `shell.qml:214` | 向 bar 实例注入 omarchyPath/shell/registry | `if ("prop" in item)` 容错注入，不要求插件声明全部 property |
| `mutateShellConfig(fn)` | `shell.qml` | 深拷贝→fn→persistShellConfig | PluginRegistry 经此闭包写 shell.json，不做文件 IO |
| `_syncServices()` | `shell.qml:323` | 按 manifest kinds=service 加载单例 | 启动时加载，disable/移除时删除实例 |
| `syncPluginWidgets()` | `shell.qml:669` | 同步 bar-widget 组件到 BarWidgetRegistry | Asynchronous createComponent，非阻塞 |
| `computePanelEntries()` | `shell.qml:586` | 筛选 panel/overlay/menu 启用项 | Instantiator + Loader，keepLoaded 决定常驻 |

</details>

## 核心实现

### Property Injection 与 builtin fallback

`shell.qml` 的 `ShellRoot` 顶部直接 new 出三个注册表实例并暴露为 property（`shell.qml:18-20`）：

```qml title="shell/shell.qml"
property PluginRegistry pluginRegistry: PluginRegistry { }
property BarWidgetRegistry barWidgetRegistry: BarWidgetRegistry { }
property AppLibrary appLibrary: AppLibrary { }
```

注释明示**为什么不用 QML singleton import**：相对路径 import 不共享 singleton 状态，会"silently leave consumers with their own empty copies"。所以注册表必须是 ShellRoot 持有的实例，再通过 `configureBar()`（`shell.qml:214`）和 Loader `onLoaded`（`shell.qml:627`）用 `if ("omarchyPath" in item) item.omarchyPath = ...` 的形式注入到每个插件实例——`if ("prop" in item)` 容错，不要求所有插件都声明这些 property。

`shell.json` 加载用两个 `FileView`（`defaultsFile` line 117、`userConfigFile` line 130，都 `watchChanges: true`），用户改完即时热重载。`applyShellConfig()` 不做 deep-merge——用户配置有效则完全覆盖默认，无效则完全 fallback 到 `defaultsConfig`，默认文件也读不到时再 fallback 到硬编码的 `builtinShellConfig`（`shell.qml:36`），保证 bar 在任何情况下都能渲染。

### Commons 原语：Style / Color / Border

`Commons/Style.qml` 与 `Color.qml` 是两个 token 单例，从 `~/.local/state/omarchy/current/theme/shell.toml` 读值（由主题系统渲染生成，见[主题系统](05-theme-system)）。`Color.qml` 暴露 `Color.foreground`/`Color.background`/`Color.accent` 及 surface role 对象（如 `Color.menu.border`、`Color.popups.background`）；`Style.qml` 暴露 `Style.spacing.*`、`Style.font.*`、`Style.cornerRadius`、`Style.bar` 尺寸。主题切换时 `omarchy-theme-set` 经 IPC `applyTheme` 让二者热重载。

`Border.qml` + `BorderGeometry.js` 是边框原语，提供三个 spec 工厂（`shell/Commons/Border.qml`）：

- `Border.surfaceSpec(section, token, fallbackColor, fallbackWidth)` — 读 shell 主题 token
- `Border.controlSpec(state, foreground, accent)` — 共享控件边框
- `Border.flat(color, width)` — 不被主题覆盖的本地边框

`Ui/BorderSurface.qml` 是消费这些 spec 的基类，`Ui/BorderOverlay.qml` 用 QtQuick.Shapes 路径渲染渐变边框与分侧宽度（CSS-style `border-width = "2 4 6 8"`）。所有插件与 shell QML 应优先用 `BorderSurface` 而非手写边框，这样主题切换能统一生效。

### Ui 组件库

`Ui/` 33 个组件覆盖桌面常用控件：`Panel.qml`（面板基类，panel/overlay/menu 插件继承它获得 `open(payloadJson)`/`close()` 生命周期）、`Button.qml`/`Toggle.qml`/`Dropdown.qml`/`TextField.qml`（共享控件，受 `[controls]` token 约束）、`PopupCard.qml`（bar flyout 弹卡）、`KeyboardPanel.qml`（键盘面板）等。`PanelController.qml` 提供面板召唤/隐藏的通用控制逻辑。

组件统一从 `Commons` 取 token、从 `BorderSurface` 取边框，保证全套 UI 在主题切换时一致变化。`Ui/qmldir` 导出全部 33 个组件供 `import qs.Ui` 使用。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Property Injection | `shell.qml:18-20` 注入注册表 | 相对路径 import 不共享 singleton，注入保证单一实例 |
| Singleton Token | `Commons/Style.qml`、`Color.qml` | 全局主题 token 唯一来源，主题切换一处生效 |
| Template Method | `Ui/Panel.qml` 的 `open()`/`close()` | 插件继承获得统一面板生命周期契约 |
| Spec Factory | `Commons/Border.qml` surfaceSpec/controlSpec/flat | 边框声明式 spec，渲染细节封装在 BorderSurface/BorderOverlay |

## 模块间交互

Shell 框架向**插件系统**提供运行时宿主——ShellRoot 装配 PluginRegistry 并经 property injection 喂给每个插件（见[插件系统](02-plugin-system)）；向**主题系统**消费 token——Color/Style 读 `current/theme/shell.toml`（见[主题系统](05-theme-system)）；向**CLI 命令**暴露 IPC——`IpcHandler target="shell"`（`shell.qml:872`）被 `bin/omarchy-shell` 桥接（见[CLI 命令](03-cli-commands)）。`AppLibrary`（`services/`）聚合应用列表供 bar 菜单与启动器使用，`hidden-entries.sh` 过滤隐藏项。

## 扩展方式

- **新增 Ui 组件**：在 `Ui/` 加 `MyWidget.qml`，在 `Ui/qmldir` 导出，组件内 `import qs.Commons` 用 Style/Color/Border，继承 `BorderSurface` 取主题边框。
- **新增 Commons 原语**：在 `Commons/` 加 `.qml`，`qmldir` 导出，从 shell.toml 读值时遵循 `Color.qml` 的 `pick`/`composed` 模式。
- **改全局间距/字号**：改 `default/themed/shell.toml.tpl` 的 `[spacing]`/`[font]` section（见[主题系统](05-theme-system)），所有用 `Style.spacing.*` 的组件自动生效。
