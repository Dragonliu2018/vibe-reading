---
source:
  type: "源码解读"
  project: "Omarchy"
  url: "https://github.com/basecamp/omarchy"
title: "主题系统"
date: "2026-08-25T10:44:29+08:00"
category: [OS, Linux, Distribution, Omarchy, CodeWiki, "4.0.0"]
tags: ["Omarchy", "主题", "TOML", "模板"]
description: "Omarchy 主题子系统——colors.toml 调色板经 .tpl 模板渲染成 shell.toml，Color/Style 单例消费，原子 staging 切换。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/Distribution/Omarchy/CodeWiki/4.0.0/00-overview)

---

## 模块定位

主题系统是 Omarchy 的外观子系统：`themes/<name>/colors.toml` 定义调色板，`omarchy-theme-set` 触发激活流程——拷主题到 staging、渲染 `default/themed/*.tpl` 模板、原子切换到 `~/.local/state/omarchy/current/theme`、IPC 通知 Shell 热切换。它解决"一套主题跨桌面/Hyprland/终端/编辑器一致切换、用户定制跨主题存活"的问题，是独立子系统，不依赖桌面运行时（渲染是 bash 脚本，无外部模板引擎）。

## 模块架构

![主题激活流程 · omarchy-theme-set](/vibe-reading/images/articles/omarchy-internals/theme-activation.svg)

三层数据：`colors.toml`（调色板，单一颜色真源）→ `default/themed/*.tpl`（模板，把颜色注入语义 surface role）→ `shell.toml`（生成的 surface role + spacing + 字号，被 QML `Color`/`Style` 单例读）。`omarchy-theme-set`（`bin/omarchy-theme-set`）编排激活，`omarchy-theme-set-templates`（`bin/omarchy-theme-set-templates`）是渲染器，`omarchy-theme-set-foot`/`-tmux`/`-gnome`/`-vscode` 等子命令把生成状态应用到各应用。

## 调用链路

`omarchy-theme-set <name>` 的激活链（对应上图）：

```
omarchy-theme-set <name> (bin/omarchy-theme-set)
  ├ 建 staging dir = ~/.local/state/omarchy/current/next-theme
  ├ 拷 themes/<name>/ → staging
  ├ 叠加用户主题 ~/.config/omarchy/themes/<name>/ → staging
  ├ （若无 colors.toml）omarchy-theme-colors-from-alacritty 从 alacritty.toml 反生成
  ├ omarchy-theme-set-templates: 渲染 default/themed/*.tpl + 用户 ~/.config/omarchy/themed/*.tpl
  │    占位符 {{ accent }} {{ mix a b 15% }} {{ hypr_gradient ... }} 替换
  │    手写文件（如 themes/<name>/shell.toml）不被模板覆盖
  ├ mv staging → ~/.local/state/omarchy/current/theme + 写 theme.name
  └ omarchy-shell shell applyTheme <base64 payload> (IPC 热切换)
       → Color/Style 单例重读 shell.toml → 全套 UI 切换
```

激活后 `omarchy-theme-set` 还跑 `post_theme_commands` 数组（`bin/omarchy-theme-set:190`）——`omarchy-theme-set-foot`/`-tmux`/`-gnome`/`-pi`/`-claude`/`-browser`/`-vscode`/`-obsidian`/`-keyboard` 各自把 `current/theme/` 下对应文件写入应用配置，再 `omarchy-hook theme-set` + `omarchy-theme-bg-cache` 预热。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 | 关键决策 |
| --- | --- | --- | --- |
| `omarchy-theme-set-templates` | `bin/omarchy-theme-set-templates` | 渲染 .tpl | 手写文件不覆盖；用户 .tpl 优先于内置 |
| `omarchy-theme-colors-from-alacritty` | `bin/` | alacritty→colors.toml | 无 colors.toml 时反向派生 |
| `omarchy-theme-current` | `bin/` | 取当前主题名 | 读 `current/theme.name` |
| `Color.pick/composed` | `shell/Commons/Color.qml` | 读 shell.toml token | surface role + alpha 合成 |
| `apply_shell_section_overrides` | `bin/omarchy-theme-set-templates:360` | glob `shell.*.toml` 替换 section | 文件名决定目标 section |

</details>

## 核心实现

### colors.toml 调色板

`themes/<name>/colors.toml` 是颜色唯一真源（`themes/catppuccin/colors.toml`、`themes/tokyo-night/colors.toml` 等 24 套）。key 语义分组：`accent`/`selection`/`muted`、`background`/`dark_background`/`darker_background`/`lighter_background`、`foreground`/`dark_foreground`/`light_foreground`/`bright_foreground`、`red`/`green`/`yellow`/`blue`/`magenta`/`cyan` + bright 变体。canonical 名优先，legacy 别名（`bg`/`fg`/`dark_bg` 等）同时暴露以兼容旧主题——解析后 canonical 值也经 legacy 名可达。

### shell.toml surface roles

`shell.toml`（默认由 `default/themed/shell.toml.tpl` 生成）把颜色注入语义 surface role，shell UI 不直接引用 palette key 而引用 `Color.menu.border`/`Style.spacing.md`。section 如 `[bar]`/`[controls]`/`[popups]`/`[tooltip]`/`[notifications]`/`[launcher]`/`[menu]`/`[polkit]`/`[lock]`/`[image-picker]`/`[spacing]`/`[font]`。边框用**单 key**（`border = "#7aa2f7"` 或 `border = "rgba(...) rgba(...) 45deg"` 渐变），不加 `border-gradient`；`border-width` 接受 CSS-style list（`2` / `"2 4"` / `"2 4 6 8"`），per-side key（`border-width-left`）覆盖 list；`border-alpha` 作用于实色与每个渐变 stop。主题可只覆盖一个 section：`themes/<name>/shell.lock.toml` 替换 `[lock]`（文件名决定 section）。

### .tpl 模板占位符

`default/themed/*.tpl` 是纯文件，`omarchy-theme-set-templates` 用 bash + sed + awk 替换占位符（无外部模板引擎）。对 color key `accent`：

| 占位符 | 输出 |
| --- | --- |
| `{{ accent }}` | `#7aa2f7` |
| `{{ accent_strip }}` | `7aa2f7` |
| `{{ accent_rgb }}` | `122,162,247` |
| `{{ mix background foreground 15% }}` | 两色按比例混合 |
| `{{ hypr_gradient hyprland_active_border accent }}` | Hyprland Lua 表格（fallback 第二参数） |
| `{{ shell_gradient hyprland_active_border accent }}` | shell border token |
| `{{ gradient_start hyprland_active_border accent }}` | 首色（flat-color 消费者） |

`hypr_gradient` 的第二参数是 fallback——`hyprland_active_border` 未定义时用 `accent`。Hyprland 模板用 `hypr_gradient` 因 Lua 配置要 Lua string（实色）或 table（渐变）。

### 原子激活与分层覆盖

激活用 staging directory 原子切换：渲染全在 `next-theme/`，完成后 `mv` 到 `current/theme`，Shell 永远看到完整状态（`flock` 保护并发）。**模板不覆盖手写文件**——`themes/<name>/shell.toml` 或 `hyprland.lua` 永远胜过 `shell.toml.tpl`/`hyprland.lua.tpl`，主题保留完全控制特定文件的能力。两条用户定制路径：用户 `~/.config/omarchy/themed/*.tpl` 优先于内置 `.tpl`（同名时内置输出被跳过，跨主题生成时定制）；用户 `~/.config/omarchy/themes/<name>/` 叠加到 first-party 主题（运行时定制）。current theme state 放 `~/.local/state/`（不 `~/.config/`），把 `~/.config/` 留给用户 dotfile 版本管理（用户主题、hooks、shell 布局、themed 覆盖）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Template Rendering | `default/themed/*.tpl` + `omarchy-theme-set-templates` | 一调色板多应用配置生成，无外部引擎 |
| Semantic Color Tokens | colors.toml→shell.toml→Color/Style | UI 引用语义 role 而非 palette key，主题切换一处生效 |
| Staging Directory | `next-theme` → `current/theme` | 原子切换，Shell 永远见完整状态 |
| Layered Override | 用户主题叠加 + 手写胜生成 + 用户 .tpl 优先 | 两层用户定制路径（生成时/运行时） |

## 模块间交互

主题系统向 [Shell 框架](01-shell-framework) 的 `Color`/`Style` 单例（`shell/Commons/Color.qml`、`Style.qml`）提供 token——读 `current/theme/shell.toml`，`omarchy-theme-set` 经 IPC `applyTheme` 触发热重载。向 Hyprland 生成 `current/theme/hyprland.lua`（由 `default/themed/hyprland.lua.tpl` + `hypr_gradient`）。`omarchy-theme-set-*` 子命令把 `current/theme/` 应用到 foot/tmux/gnome/vscode/obsidian 等。[安装装配](04-install-assembly) 在 `install/user/theme.sh` 设默认主题 Tokyo Night；`install/config/theme-system.sh` 设 root 侧主题链接。[CLI 命令](03-cli-commands) 的 `omarchy-theme-*` 是本模块的操作面。

## 扩展方式

- **新增主题**：`themes/<name>/colors.toml`（调色板）。能用模板表达就只放 colors.toml；需覆盖某文件加手写 `themes/<name>/<file>`（如 `shell.toml`）。
- **新增 .tpl 输出新应用配置**：加 `default/themed/<app>.<ext>.tpl`（渲染器自动 glob），可选加 `bin/omarchy-theme-set-<app>` 读 `current/theme/<app>.<ext>` 写应用路径，在 `omarchy-theme-set` 的 `post_theme_commands` 数组追加。用户也可放 `~/.config/omarchy/themed/<app>.<ext>.tpl` 跨主题定制。
- **新增 shell.toml section**：加 `default/themed/shell.toml.tpl` 的 section + `Color.qml` 对应 `QtObject` surface 属性（`pick`/`composed` 模式），主题可选 `themes/<name>/shell.<section>.toml` 覆盖。
