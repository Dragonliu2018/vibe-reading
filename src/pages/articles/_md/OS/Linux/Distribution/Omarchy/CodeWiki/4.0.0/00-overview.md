---
source:
  type: "源码解读"
  project: "Omarchy"
  url: "https://github.com/basecamp/omarchy"
title: "Overview"
date: "2026-08-25T10:44:29+08:00"
category: [OS, Linux, Distribution, Omarchy, CodeWiki, "4.0.0"]
tags: ["Omarchy", "Bash", "QML", "Hyprland", "Quickshell", "Linux 发行版"]
description: "DHH 的 Arch + Hyprland 发行版——单一 Quickshell 桌面、元数据驱动 CLI 路由、三层装配、模板主题与 per-user 迁移框架。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 4.0.0（Quattro） · **协议** MIT · **语言** Bash 5 / QML · **代码量** ~75,000 行（shell 38.6k + test 27.3k + default 4.7k + migrations 2.6k + install 1.4k + themes 1.3k） · **仓库** [GitHub](https://github.com/basecamp/omarchy)

---

## 总览

### 项目简介

Omarchy 是 David Heinemeier Hansson（DHH）打造的一款美观、现代且带有强烈个人主张的 Linux 发行版。它构建在 Arch Linux 与 Hyprland（Wayland 合成器）之上，核心是一套自研的 **Quickshell QML 桌面 Shell**——顶栏（bar）、面板（panel）、浮层（overlay）、菜单（menu）与后台服务（service）全部作为插件，运行在单一长驻 Quickshell 进程中。整个仓库构建出两个 Arch 包（`omarchy` 与 `omarchy-settings`），从 SDDM 登录、桌面 Shell 到系统更新形成完整的用户体验闭环。

Omarchy 的核心价值在于"观点化整合"：它不让你在十几个 dotfile 仓库间拼凑桌面，而是把引导（Limine）、登录（SDDM）、合成器（Hyprland）、桌面 Shell（Quickshell）、包管理（pacman guard）、迁移、主题、更新打包成一个自洽整体，每个环节都有专用 `omarchy-*` 命令支撑。

**项目边界**：Omarchy 是桌面 Linux 的观点化配置层与运行时框架，不替换内核或 Arch 核心打包机制，而是在其之上提供端到端整合。它负责"装好就能用、更新不踩坑、主题一键切换"，不负责重新发明 Wayland 协议或包管理器。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 桌面 Shell | `shell/` | 单一 Quickshell 进程，bar/panel/overlay/menu/service 全插件化 |
| CLI 命令生态 | `bin/` + `bin/omarchy` | ~425 个 `omarchy-*` 命令，文件头注释即元数据，路由器自动发现 |
| 安装与装配 | `install/` + `default/` | 三层 `$HOME` 填充（seed/finalize/resync）+ 硬件 quirks + root 编排 |
| 主题系统 | `themes/` + `default/themed/` | `colors.toml` → `.tpl` 模板渲染 → QML `Color`/`Style` 单例 |
| 迁移框架 | `migrations/` + `bin/omarchy-migrate` | per-user 幂等迁移，登录时通知 |
| 更新管线 | `bin/omarchy-update*` + ALPM hooks | lock → snapshot → pacman → migrate → restart，pacman guard 拦截直连 |
| 应用配置 | `config/` | 默认 `~/.config` 模板，`omarchy-refresh-config` 拷贝 |
| 系统配置 | `etc/` | `/etc` drop-ins（systemd、sudoers、mkinitcpio 等） |
| 测试 | `test/` | `shell.d` 单元 + `acceptance.d` 图形验收（disposable VM） |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Bash 5 | 核心语言 | CLI 路由器、`omarchy-*` 命令、`install/`/`migrations/` 脚本 |
| QML + JavaScript | 核心语言 | Quickshell 桌面 Shell 与全部插件 |
| TOML | 核心数据 | 主题 `colors.toml`/`shell.toml` |
| Lua | 核心配置 | Hyprland 配置（`config/hypr/`） |
| Python | 可选 | nautilus-python 文件管理器扩展 |
| [Quickshell](https://quickshell.org/) | 核心运行时 | 桌面 Shell 进程宿主，提供 IPC、Wayland 窗口 |
| Hyprland | 核心运行时 | Wayland 合成器 |
| uwsm | 核心 | Wayland 会话管理，设 `$OMARCHY_PATH` |
| SDDM | 核心 | 登录管理器（自带 Omarchy 主题） |
| pacman + yay | 核心 | 包管理（pacman 系统 + yay AUR） |
| Snapper | 核心 | Btrfs 系统快照（更新前自动） |
| Limine | 核心 | bootloader |
| Plymouth | 核心 | 启动动画 |
| PipeWire + WirePlumber | 核心 | 音频栈 |
| gum | 核心 | 交互式 CLI picker（命令确认、菜单） |

### 版本历史

Omarchy 采用 git tag 标记发行版本，`version` 文件跟踪下一开发周期。`v4.0.0` 对应默认分支 `quattro`（意大利语"四"），是一次重大重构：桌面 Shell 从分散组件收敛为**单一 Quickshell 进程 + 插件注册表**架构（`shell/README.md` 记录了 phase 1–8a 的八阶段演进），并引入包化的更新管线与 ALPM pacman guard。从 3.x 升级走专用 `bin/omarchy-upgrade-to-quattro`，不走常规迁移运行器。本文解读基线即 `v4.0.0` tag（commit `f0020448`，2026-08-14）。

---

## 快速上手

Omarchy 是完整发行版，代码阅读者最快"跑起来"的方式是 **dev-link 模式**——把当前 checkout 链接到系统，无需重装即可让 `omarchy-*` 命令走 checkout 的 `bin/`，QML 改动 `omarchy-restart-shell` 即时生效。

```bash title="dev-link：从 checkout 运行 Omarchy（需已在 Omarchy 系统上）"
cd /path/to/omarchy
omarchy dev link          # 写 /etc/omarchy.conf 指向此 checkout，改 sudoers secure_path
omarchy dev status         # 验证：OMARCHY_PATH 应指向 checkout
omarchy version            # 4.0.0.alpha（version 文件跟踪开发周期）
omarchy-restart-shell      # 重启桌面 Shell，加载 checkout 的 QML
```

端到端验证：改任意 `shell/plugins/bar/` 下的 QML → `omarchy-restart-shell` → 顶栏立即反映改动；`omarchy`（无参数）列出 66 个命令分组；`omarchy shell ping` 通过 IPC 呼叫运行中的 Shell 返回 `ok`。

仅看桌面层（不装发行版）可直接 `quickshell -p "$OMARCHY_PATH/shell"`，但需要完整 Hyprland 会话环境。

> dev-link 改了 `sudoers secure_path`，因为 `sudo` 不走 `PATH` 而走 `secure_path`——不加它，`sudo omarchy-*` 会静默跑到打包副本而非 checkout。`omarchy dev unlink` 还原。

---

## 架构设计解析

### 系统架构

Omarchy 的架构思想是**"单进程桌面 + 元数据命令 + 自维护装配"**：把一个 Wayland 桌面通常散在十几个 dotfile 里的东西——顶栏、面板、锁屏、通知、菜单——收敛进单一 Quickshell 进程，让它们共享服务、以 IPC 通信、按 manifest 声明加载；再用一个扫描文件头注释的路由器把 ~425 个 `omarchy-*` 命令统一在一个入口下；最后用三层 `$HOME` 装配、per-user 迁移和 ALPM guard 让发行版"装好能用、更新不踩坑"。`OMARCHY_PATH` 是贯穿所有层的单一真源——由 uwsm 会话环境注入，Lua、Quickshell、bash 脚本都从它派生路径，dev-link 模式只改写一个 `/etc/omarchy.conf` 就能把整条链路重指到开发 checkout。

![Omarchy 分层架构](/vibe-reading/images/articles/omarchy-internals/architecture.svg)

四层从上到下：会话引导层负责开机到 Hyprland 就绪并确立 `OMARCHY_PATH`；桌面 Shell 层是核心产品，单一 Quickshell 进程以插件化方式承载全部桌面 UI；命令自动化层是用户操作面，路由器分发 `omarchy-*` 命令、helper facade 包装底层工具、`omarchy-shell` 桥接 IPC；装配维护层是发行版的"自维护"底座，负责安装、主题渲染、迁移、更新管线与 pacman guard。下层 provisions 上层（图中右侧箭头），但运行时桌面 Shell 与 CLI 对等——CLI 经 IPC 操作 Shell，Shell 经状态文件/IPC 回馈 CLI。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 会话引导层 | `default/wayland-sessions/`、`default/bash/env-bootstrap`、`default/uwsm/`、`config/hypr/` | 从登录到 Hyprland 就绪，确立 `OMARCHY_PATH` 单一真源，后续所有层不靠猜路径 |
| 桌面 Shell 层 | `shell/`（`shell.qml`、`Commons/`、`Ui/`、`services/`、`plugins/`） | 承载全部桌面 UI 与逻辑，单进程共享服务、插件化扩展、property injection 避免 singleton 副本 |
| 命令自动化层 | `bin/`（`omarchy` 路由器 + `omarchy-*` + `omarchy-shell`） | 统一用户操作面，元数据驱动路由、helper facade 标准化底层工具、IPC 桥接 Shell |
| 装配维护层 | `install/`、`default/`（seed）、`themes/`+`default/themed/`、`migrations/`、`bin/omarchy-update*` | 发行版自维护：三层装配、主题渲染、per-user 迁移、更新管线与 ALPM guard |

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Metadata-Driven Dispatch | `bin/omarchy` `register_command()` 扫描 `# omarchy:` 注释 | 命令文件自洽——存在即注册、删除即注销，零配置零漂移 |
| Plugin Registry + Manifest Loading | `shell/services/PluginRegistry.qml` + `manifest.json` | 插件契约声明式，kind 分流加载，第三方 git clone 即装不跑 install hooks |
| Property Injection | `shell/shell.qml` 注入 `pluginRegistry`/`barWidgetRegistry` 给插件 | 相对路径 import 不共享 singleton 状态，注入保证单一实例 |
| Three-Layer Population | `/etc/skel` seed + `omarchy-provision-user` finalize + `omarchy-reinstall-configs` resync | 分离"静态默认/运行时检测/破坏性重置"三种触发，避免 `/etc/skel` 误触 |
| Idempotent Per-User Migration | `migrations/*.sh` + `bin/omarchy-migrate` + `omarchy-done` marker | 迁移操作 `$HOME` 状态，多用户机每用户各跑一次，幂等 + marker 防重 |
| Owned Update Pipeline + Guard | `bin/omarchy-update` + `bin/omarchy-update-pacman-guard` ALPM hook | `omarchy update` 独占可见管线，guard 拦截直连 `pacman -Syu` 把用户 nudge 回正规路径 |
| Template Rendering + Staging | `default/themed/*.tpl` + `bin/omarchy-theme-set-templates` + `next-theme` 目录 | 主题原子切换，手写文件不被生成覆盖，用户定制跨主题存活 |

### 核心概念

Omarchy 最重要的"东西"是这几个对象：

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| ShellRoot | Quickshell 进程入口（`shell.qml`） | 每图形会话一个 | 装配 PluginRegistry/BarWidgetRegistry/AppLibrary |
| PluginRegistry | 插件中央注册表 | ShellRoot 持有，property 注入 | 扫描 manifest → installedPlugins → 驱动加载 |
| manifest.json | 插件契约（id/kinds/entryPoints） | 静态文件，随插件目录 | PluginRegistry 校验后据此加载 |
| shell.json | 用户桌面配置唯一文件 | 用户可改，热重载 | bar 布局 + 插件启用 + idle，无 deep-merge |
| `OMARCHY_PATH` | checkout 单一真源路径 | uwsm 注入，会话级 | Lua/Quickshell/bash 全派生路径 |
| omarchy-update | 更新管线入口 | 用户触发，一次性 | 编排 lock→snapshot→pacman→migrate→restart |
| migration `.sh` | 一次性修复脚本 | 每用户每脚本一次 | `omarchy-migrate` 遍历执行 + marker |
| `colors.toml` + `.tpl` | 主题调色板与模板 | `omarchy-theme-set` 时渲染 | 生成 `current/theme/` 供 Color/Style 读 |

扩展点的契约——插件 kind 系统与命令/hook 注册：

| 契约 | 定义位置 | 实现方 | 注册方式 |
| --- | --- | --- | --- |
| `bar-widget` kind | `manifest.json` `kinds` + `barWidget` | `shell/plugins/bar/widgets/*`、第三方 | BarWidgetRegistry register，bar layout 引用即实例化 |
| `panel`/`overlay`/`menu` kind | `manifest.json` `kinds` + `entryPoints` + `open()`/`close()` | `shell/plugins/panels/*`、第三方 | Instantiator Loader，`summon` IPC 触发加载 |
| `service` kind | `manifest.json` `kinds` + `keepLoaded` | `shell/plugins/*/Service.qml` | `_syncServices()` 启动时加载单例 |
| `omarchy-*` 命令 | `bin/omarchy-*` 文件头 `# omarchy:` | 任意 `bin/omarchy-*` 脚本 | 路由器扫描自动注册路由 |
| `omarchy:hook` | `~/.config/omarchy/hooks/<name>{,.d/}` | 用户脚本 | `omarchy-hook <name>` 遍历执行 |

## 模块地图

Omarchy 按职责分化为六个模块，单层并列——概览本篇 + 六个模块文档各成一篇。

![模块依赖关系](/vibe-reading/images/articles/omarchy-internals/module-dependencies.svg)

依赖方向：CLI 命令是最大消费方，通过 IPC（`omarchy-shell`）、命令调用、状态文件与所有其他模块交互；插件系统与 Shell 框架相互依赖（Shell 托管插件，插件用 Commons/Ui）；主题系统生成 Color/Style token 供 Shell 消费；安装装配在 provisioning 时设主题、标记迁移已应用；迁移更新通过 `omarchy-restart-shell` 回到 Shell、通过 `omarchy-update-dev` 关心 checkout。模块间不存在循环依赖。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| Shell 框架 | Quickshell 进程入口、Commons 原语、Ui 组件库、服务注册表 | `shell/shell.qml` | 桌面运行基座与可复用建筑块，与"插件业务"分离 | [Shell 框架](01-shell-framework) |
| 插件系统 | manifest 发现/校验/加载、6 种 kind、IPC、shell.json 持久化 | `shell/services/PluginRegistry.qml` | 插件契约与加载机制自成体系，是桌面扩展点 | [插件系统](02-plugin-system) |
| CLI 命令 | 元数据驱动路由、~425 命令、helper facade、IPC 桥 | `bin/omarchy` | 用户操作面与路由/分发逻辑独立于桌面实现 | [CLI 命令生态](03-cli-commands) |
| 安装装配 | 三层 $HOME 装配、硬件 quirks、root 编排、finalize/first-run | `bin/omarchy-apply-system` + `bin/omarchy-provision-user` | 发行版安装与系统装配是独立生命周期，与运行时桌面分离 | [安装与系统装配](04-install-assembly) |
| 主题系统 | colors.toml 调色板、.tpl 模板渲染、Color/Style token | `bin/omarchy-theme-set` + `default/themed/*.tpl` | 主题渲染与原子切换是独立子系统，跨多个应用 | [主题系统](05-theme-system) |
| 迁移更新 | per-user 幂等迁移、更新管线、ALPM guard、登录通知 | `bin/omarchy-migrate` + `bin/omarchy-update` | 升级/迁移是发行版自维护的独立关切，与桌面 UI 无关 | [迁移与更新](06-migration-update) |

模块间的动态调用顺序见运行时行为 > 核心运行流程。

## 运行时行为

### 启动流程

Omarchy 的启动从 SDDM 登录到桌面 Shell 就绪，是一条由 `OMARCHY_PATH` 串起的环境变量→进程→QML 装配链：

```
SDDM 登录 → omarchy.desktop (uwsm start -g Hyprland)
  → uwsm source default/uwsm/env.d/10-omarchy
  → env-bootstrap: 读 /etc/omarchy.conf 或 fallback /usr/share/omarchy → export OMARCHY_PATH
  → Hyprland 加载 config/hypr/hyprland.lua
  → bootstrap.lua 设 Lua package.path (含 $OMARCHY_PATH/?.lua)
  → default/hypr/autostart.lua: omarchy-launch-shell
  → omarchy-launch-shell (bin/): quickshell -n -p $OMARCHY_PATH/shell (crash supervisor)
  → shell.qml ShellRoot Component.onCompleted:
      ├ firstPartyDir / shellConfigProvider / shellConfigMutator 注入 PluginRegistry
      ├ pluginRegistry.rescan() (bash 扫描 plugins/ + ~/.config/omarchy/plugins/)
      ├ _syncServices() 加载 service 插件
      └ applyShellConfig() 读 shell.json (默认 ‖ 用户，无 deep-merge)
  → bar 渲染 (defaultBarLoader 或 pluginBarLoader) + BarWidgetRegistry 同步
  → IpcHandler target="shell" 就绪 → omarchy-shell 可调
```

对象装配的关键：ShellRoot 在 `shell.qml` 里 `property PluginRegistry pluginRegistry: PluginRegistry { }` 直接 new 出三个注册表实例（`shell.qml:18-20`），再通过 `configureBar()` 和 Loader `onLoaded` 把它们连同 `omarchyPath`/`manifest` 注入给每个插件——**不用 QML singleton import**，因为相对路径 import 会让每个消费者拿到各自的空副本（`shell.qml` 注释明示）。`shell.json` 加载用 FileView `watchChanges: true`，用户改完即时热重载；默认配置缺失时 fallback 到硬编码的 `builtinShellConfig`，保证 bar 永远能渲染。

### 核心运行流程

下面两条链路覆盖 Omarchy 最核心的运行场景：开机到桌面就绪、一次系统更新。

#### 引导链路：开机 → 桌面 Shell 就绪

业务流程：SDDM 登录 → uwsm 启 Hyprland → env-bootstrap 定 `OMARCHY_PATH` → Hyprland autostart 启 Quickshell → ShellRoot 发现插件、加载 shell.json、渲染 bar → IPC 就绪。

![开机 → 桌面 Shell 就绪](/vibe-reading/images/articles/omarchy-internals/boot-flow.svg)

数据从 `default/bash/env-bootstrap`（bash）经 uwsm env.d 进入 Hyprland 进程环境，Quickshell 用 `Quickshell.env("OMARCHY_PATH")` 读取——**跨 default→shell 边界靠环境变量**。`omarchy-launch-shell` 用 `QS_DISABLE_FILE_WATCHER=1 QS_NO_RELOAD_POPUP=1` 启动并加 `-n`（不自动重载），Omarchy 手动管理 shell 重启，防止包升级半写状态触发重载产生双引擎代；父脚本带 crash supervisor（最多 5 次/分钟重试）。`shell.json` 不做 deep-merge——用户配置有效则完全覆盖默认，无效则完全 fallback，避免部分覆盖的不一致。

#### 维护链路：omarchy update 更新管线

业务流程：bar 更新指示器 → 点击 → `omarchy-update` 录制日志 → 锁+空间+确认 → 快照+抑制休眠 → 包更新 → 迁移 → 钩子 → 状态刷新 → 重启决策。

![omarchy update 管线](/vibe-reading/images/articles/omarchy-internals/update-flow.svg)

管线刻意排序：包缓存裁剪在快照前（缓存 sharing 快照子卷，先裁再照省空间）；keyring 在包更新前（签名验证需要有效密钥）；包更新在迁移前（迁移随包发布、针对新版本）；sleep 抑制器在重启决策前显式释放（防 reboot 抢在 EXIT trap 前终止进程留下持久 inhibitor）。bar 的 `SystemUpdate.qml` 用 6 小时定时器调 `omarchy-update-available`（exit 0=有更新），点击经 `omarchy-launch-floating-terminal-with-presentation` 启 `omarchy-update`。完成后 `omarchy-update-status` 经 IPC（`omarchy-shell -q omarchy.system-update refresh/clear`）刷新所有 bar 实例的指示器——**跨 bin→shell 边界靠 IPC**。shell 无条件重启（`omarchy-restart-shell`）：更新常替换 QML，旧进程可能延迟加载新文件到旧代码，用 marker 会漏，无条件重启最安全。

### 状态流

Omarchy 没有单一中心状态机，但有两个关键的对象生命周期状态：

- **迁移状态**：每个迁移脚本对应 `~/.local/state/omarchy/migrations/<file>` marker——存在=已应用，缺失=pending。`omarchy-migrate` 遍历，缺失则执行并 touch。`omarchy-provision-user --first-install` 把所有已发布迁移标记为已应用（新装机器不跑历史迁移）。状态"枚举"是文件系统 marker 存在性，转换触发者是 `omarchy-migrate`（应用）与 `omarchy-provision-user`（标记）。
- **更新并发状态**：`${XDG_RUNTIME_DIR:-/tmp}/omarchy-update.lock` flock 锁 + `omarchy-update-stay-awake` 的 systemd-inhibit sleep 抑制器 + `~/.local/state/omarchy/indicators/stay-awake` 指示文件，三者通过 `OMARCHY_UPDATE_LOCK_FD` 关联——inhibitor 进程的 fd 继承了锁，锁释放时 inhibitor 须被清理。`~/.local/state/omarchy/reboot-required` 与 `restart-*-required` 是重启决策 marker，`omarchy-update-restart` 消费。

## 典型修改场景

#### 场景 1：新增一个 `omarchy-*` 命令（如 `omarchy-capture-qr`）

创建 `bin/omarchy-capture-qr`，头部写 `# omarchy:summary=...`、`# omarchy:args=...` 等元数据，`chmod +x`。**无需改路由器**——`bin/omarchy` 启动时自动扫描 `omarchy-*` 发现新文件，文件名推断 group/name。若新增分组（如 `vpn`），在 `bin/omarchy` 的 `GROUP_DESCRIPTIONS` 加一行即可。跑 `omarchy commands --check` 验证无路由碰撞。对应测试：`./test/cli` + `test/shell.d/command-metadata`。

#### 场景 2：新增一个 first-party 桌面插件（bar widget）

在 `shell/plugins/` 下建目录，写 `manifest.json`（`kinds: ["bar-widget"]`、`entryPoints.barWidget`、`barWidget` 元数据）与 `BarWidget.qml`（继承 `BarWidget`，设 `moduleName`），在 `config/omarchy/shell.json` 默认布局加 `{ "id": "omarchy.<name>" }`。**无需改 PluginRegistry/shell.qml/Bar.qml**——发现与加载自动。第三方版改为 `omarchy plugin add <url> --enable`。对应测试：`test/shell.d/plugin-validate-test.sh` + 图形 `test/acceptance.d/`。

#### 场景 3：新增一个 per-user 迁移

`omarchy-dev-add-migration` 生成 `migrations/<timestamp>.sh`（0644、无 shebang），开头 `echo` 描述，用 `$OMARCHY_PATH` 与 `omarchy-pkg-add` 等 helper，**必须幂等**（先查现有状态再改）。**无需改任何其他文件**——`omarchy-migrate` 自动遍历 `migrations/*.sh`。测试用 `HOME=$(mktemp -d) bash -euo pipefail migrations/<ts>.sh`。对应测试：`test/shell.d/migrate-*-test.sh`。

---

## 代码目录

```shell title="仓库顶层结构"
omarchy/
├── bin/                 # ~425 个 omarchy-* 命令 + omarchy 路由器（1090 行）
├── shell/               # Quickshell 桌面 Shell（38.6k 行，核心）
│   ├── shell.qml        # ShellRoot 入口，装配三个注册表
│   ├── Commons/         # 原语单例：Style/Color/Util/Border
│   ├── Ui/              # 33 个可复用组件：Panel/Button/Toggle/BorderSurface
│   ├── services/        # 注册表：PluginRegistry/BarWidgetRegistry/AppLibrary
│   └── plugins/         # 一方插件：bar/menu/panels/osd/lock/agents/...
├── default/             # /etc/skel seed + env bootstrap + systemd/fonts/sddm/plymouth
├── install/             # 安装脚本：config/hardware/login/post-install/provisioning/user
├── themes/              # 24 套主题（colors.toml + 可选 shell.toml）
├── migrations/          # per-user 幂等迁移脚本（unix-timestamp.sh 命名）
├── config/              # 默认 ~/.config 模板（hypr/foot/ghostty/tmux/...）
├── etc/                 # /etc drop-ins（systemd/sudoers/mkinitcpio/NetworkManager）
├── agents/skills/       # 任务指南（command-metadata/install-scripts/shell-dev/...）
├── docs/                # 架构参考（file-layout/omarchy-shell/theming/migrations/update-process）
├── manual/              # 终端用户手册（发布到 learn.omacom.io）
├── test/                # shell.d 单元 + acceptance.d 图形验收
├── plans/               # 设计计划文档
└── version              # 开发周期版本号（4.0.0.alpha）
```

几个特殊目录值得注意：`default/` 同时是 `/etc/skel` 的 seed 源、`/usr/share/omarchy/default` 的 resync 源，还是 `systemd` user unit、字体、SDDM/Plymouth 主题的归宿——它"既是默认配置又是系统资产"；`etc/` 只放 Omarchy 拥有的 `/etc` drop-in，被上游包拥有的 `/etc` 文件走 `default/` + `etc-overrides` scriptlet `cp -f` 机制（见安装模块）；`agents/skills/` 是给代码贡献者的任务程序指南，`docs/` 是系统形态参考，`manual/` 是终端用户文档——三套文档按读者分层。

---

## 测试体系

```shell title="test/ 结构"
test/
├── all              # 聚合 runner：跑 test/cli + test/shell，故意不跑图形 acceptance
├── cli              # CLI 路由、命令元数据、主题 helper、safe dispatch 覆盖
├── shell            # 跑 test/shell.d/*-test.sh 全部 shell 测试
├── shell.d/         # 各 shell 测试，source base-test.sh 取根路径/断言/Node helper
└── acceptance.d/    # 图形验收（disposable VM，不在开发会话跑）
```

| 代码层 | 测试类型 | 入口 |
| --- | --- | --- |
| `bin/omarchy` 路由 + 命令元数据 | CLI 测试 | `./test/cli` |
| `shell/` QML 行为 | shell 单测 + 图形验收 | `./test/shell`、`test/acceptance.d/` |
| `themes/` 主题 helper | CLI 测试 | `./test/cli` |
| `migrations/` 迁移 | shell 单测 | `test/shell.d/migrate-*-test.sh` |
| 插件 manifest 校验 | shell 单测 | `test/shell.d/plugin-validate-test.sh` |

新增 shell 测试放 `test/shell.d/*-test.sh` 即被 `./test/shell` 自动拾取。图形验收在一次性 VM 跑而非当前会话（见 `agents/skills/acceptance-tests.md`），因为它们要操作真实窗口。视觉改动除自动测试外还须在运行 UI 里验证（`agents/skills/visual-verification.md`）。要理解某个 `omarchy-*` 命令，优先读它对应的测试——测试是可执行文档。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `bin/omarchy`（路由器，`register_command` 扫描元数据 + `dispatch_fast_or_help` 两阶段分发）→ `bin/omarchy-update`（更新管线步骤序列）→ `shell/shell.qml`（ShellRoot 装配三个注册表与 `shell.json`）
- **第二遍：理解桌面 Shell 架构**
  `shell/services/PluginRegistry.qml`（插件发现/校验/加载/IPC）→ `shell/Commons/Style.qml` + `Color.qml`（主题 token 单例）→ `shell/Ui/Panel.qml`（面板基类与生命周期）→ `shell/plugins/bar/`（bar 插件与一个 widget）
- **第三遍：理解装配与更新**
  `docs/file-layout.md`（三层 `$HOME` 与 build-time map）→ `bin/omarchy-apply-system` + `install/config/all.sh` + `install/hardware/all.sh`（root 编排）→ `bin/omarchy-provision-user`（一次性用户 finalize，`docs/file-layout.md` 仍称 finalize-user）→ `bin/omarchy-migrate` + `bin/omarchy-update` + `bin/omarchy-update-pacman-guard`（迁移与更新管线）
- **第四遍：理解主题与扩展**
  `themes/catppuccin/colors.toml` + `default/themed/shell.toml.tpl`（调色板与模板）→ `bin/omarchy-theme-set` + `bin/omarchy-theme-set-templates`（激活与渲染）→ 任一 `manifest.json`（如 `shell/plugins/osd/manifest.json`，插件契约）→ 各模块深度文档

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| Quattro | Omarchy 4.0 的代号，默认分支名 |
| Quickshell | QtQuick 桌面 Shell 框架，Omarchy 的运行时宿主 |
| ShellRoot | `shell.qml` 的根组件，Quickshell 进程入口 |
| `OMARCHY_PATH` | Omarchy checkout 的单一真源路径，由 uwsm 会话环境注入 |
| shell.json | 用户桌面配置的唯一文件（bar 布局 + 插件启用 + idle） |
| manifest.json | 插件清单，声明 id/kinds/entryPoints |
| dev-link | 把 checkout 链接到系统的开发模式（写 `/etc/omarchy.conf`） |
| ALPM guard | pacman 前置事务钩子，拦截直连 `pacman -Syu` |
| seed/finalize/resync | 三层 `$HOME` 填充机制（`/etc/skel` / `omarchy-provision-user` / `omarchy-reinstall-configs`） |

### 参考资料

- 仓库架构文档：`docs/file-layout.md`、`docs/omarchy-shell.md`、`docs/theming.md`、`docs/migrations.md`、`docs/update-process.md`
- 贡献者任务指南：`agents/skills/`（command-metadata、install-scripts、shell-dev、migrations、acceptance-tests）
- 外部依赖：[Quickshell](https://quickshell.org/)、[Hyprland](https://hyprland.org/)、[uwsm](https://github.com/vladimir-codes/uwsm)
- 官网：[omarchy.org](https://omarchy.org)
