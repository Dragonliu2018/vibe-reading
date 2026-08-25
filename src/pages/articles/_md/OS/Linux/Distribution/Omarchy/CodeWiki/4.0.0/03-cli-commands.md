---
source:
  type: "源码解读"
  project: "Omarchy"
  url: "https://github.com/basecamp/omarchy"
title: "CLI 命令生态"
date: "2026-08-25T10:44:29+08:00"
category: [OS, Linux, Distribution, Omarchy, CodeWiki, "4.0.0"]
tags: ["Omarchy", "Bash", "CLI", "路由"]
description: "Omarchy 的用户操作面——元数据驱动路由器扫描文件头注释自动注册 ~425 个命令，两阶段分发，helper facade 标准化底层工具。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/Distribution/Omarchy/CodeWiki/4.0.0/00-overview)

---

## 模块定位

CLI 命令生态是 Omarchy 的用户操作面：`bin/omarchy` 路由器扫描 `bin/omarchy-*` 文件头注释即元数据，自动构建路由表并分发；~425 个命令按 66 个分组（`GROUP_DESCRIPTIONS`）组织；helper facade（`omarchy-notification-send`/`omarchy-pkg-add` 等）包装底层工具做标准化与安全兜底；`omarchy-shell` 桥接 Quickshell IPC。它解决"一个入口管住所有操作、新增命令零配置"的问题，独立于桌面实现——路由器只认文件名与注释，不碰 QML。

## 模块架构

```
bin/
├── omarchy                 路由器（1090 行）：扫描元数据 → 路由表 → 分发
├── omarchy-*               ~425 个命令（文件名 = group-name，可被注释覆盖）
│   ├── install-*  (33)     theme-*  (30)  hw-*  (26)  hyprland-*  (24)
│   ├── launch-*   (22)     update-* (21)  remove-* (20) restart-* (16)
│   └── menu/toggle/pkg/capture/...
├── omarchy-shell           Quickshell IPC 桥（qs ipc 转发，不启动 shell）
├── omarchy-notification-send  notify-send facade（glyph/exec hint）
├── omarchy-pkg-add          pacman/AUR facade（missing 检测 + sudo 分流 + 验证）
├── omarchy-cmd-present/missing  命令存在性 helper
├── omarchy-done             幂等标记（check/mark/ensure）
└── omarchy-dev-*            开发工具（link/unlink/status/benchmark）
```

路由器在顶层，命令文件自洽（文件即路由声明），helper facade 是被其他命令复用的标准库，`omarchy-shell` 是跨进程到桌面 Shell 的 IPC 桥。

## 调用链路

`omarchy <args>` 的分发采用两阶段策略——先试零元数据开销的快速路径，失败再加载全量元数据：

```
main() (bin/omarchy:1070)
  └ dispatch_fast_or_help() (line 946)
       └ resolve_direct_route(): 从最长前缀递减探测文件系统
           omarchy capture screenshot region → 试 capture-screenshot-region ✗ → capture-screenshot ✓
       └ remaining = args[DIRECT_RESOLVED_COUNT:]
           ├ remaining_has_help_flag → show_command_help / show_command_json
           ├ 无剩余且 command_requires_args → show help
           └ 否则 exec "$binary" "${remaining[@]}"      ← 直接 exec，不 fork
  └（快速路径未命中）→ dispatch_or_help() (line 1009)
       └ load_commands(): 扫描全部 omarchy-* 元数据建 ROUTE_TO_KEY
       └ resolve_route(): 查关联数组（命中 alias / 覆盖 group 的命令）
       └ 命中 → exec；未命中 → "Unknown command" + suggest_command 前缀建议
```

快速路径命中时**零元数据开销**——`omarchy capture screenshot region` 不需加载任何路由表。只有走 alias 或元数据覆盖 group/name 的命令才进全量路径。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 | 关键决策 |
| --- | --- | --- | --- |
| `register_command(file)` | `bin/omarchy:166` | 扫前 80 行 `# omarchy:` 注释建元数据 | 遇非注释行即 break，80 是上限非固定读取量 |
| `register_route(route, key, is_alias)` | `bin/omarchy:148` | 注册路由 + collision 检测 | 冲突不覆盖，保留先注册者，记入 `ROUTE_COLLISIONS` |
| `resolve_direct_route(argc, args)` | `bin/omarchy:386` | 文件系统探测最长前缀 | 零元数据开销 |
| `remaining_has_help_flag()` | `bin/omarchy:123` | 扫描整个 remainder 找 `--help` | `--` 后停止，防 help 被当参数转发 |
| `show_group_help(group)` | `bin/omarchy:796` | 打印组命令列表 | 由 `GROUP_DESCRIPTIONS` 驱动 |
| `shell_ipc()` (各命令内) | 如 `omarchy-theme-set:34` | 包装 `omarchy-shell` | 2s 超时 + 静默失败 |

</details>

## 核心实现

### 元数据扫描与路由注册

`register_command()`（`bin/omarchy:166-310`）逐行读命令文件前 `METADATA_SCAN_LIMIT=80` 行（`bin/omarchy:6`），解析 `# omarchy:key=value` 注释。正则 `^[[:space:]]*#[[:space:]]*omarchy:([[:alnum:]_-]+)=(.*)$`（`bin/omarchy:202`）允许前导空格。支持键：`group`/`name`（覆盖文件名推断）、`summary`/`args`/`examples`（help 文本）、`alias`/`aliases`（`|` 分隔多别名）、`hidden`/`requires-sudo`（仅接受 `"true"`）。遇非注释行立即 `break`，所以 80 行是上限而非固定读取量——5 行注释的命令只读 6 行。

未显式声明 `group`/`name` 时从文件名推断（`bin/omarchy:251-263`）：`omarchy-capture-screenshot` → stem `capture-screenshot` → group `capture`、name `screenshot`、route `omarchy capture screenshot`。`register_route()`（`bin/omarchy:148`）检测 collision——两个命令声明同路由时记入 `ROUTE_COLLISIONS` 且**不覆盖**（保留先注册者），`omarchy commands --check` 报告。

### 两阶段分发

快速路径 `dispatch_fast_or_help`（`bin/omarchy:946`）用文件系统探测免加载元数据：`resolve_direct_route` 从最长前缀递减试 `bin/omarchy-<prefix>` 是否存在且可执行，命中后处理剩余参数。`remaining_has_help_flag`（`bin/omarchy:123`）**扫描整个 remainder** 找 `--help`/`-h`——因为路由可能在参数中间命中（如 `omarchy update aur --help`，`update` 匹配后剩余 `aur --help`），只看第一个 token 会漏掉 help。`--` 标记命令自身参数边界，扫描到 `--` 停止。

全量路径 `dispatch_or_help`（`bin/omarchy:1009`）只在快速路径失败时触发：`load_commands` 扫描全部 `omarchy-*` 建 `ROUTE_TO_KEY`，`resolve_route` 查关联数组——命中 alias 与元数据覆盖 group/name 的命令。两条路径都用 `exec` 直接替换进程（`bin/omarchy:990`），不 fork。

### helper facade 层

helper 命令包装底层工具做标准化与安全兜底。`omarchy-notification-send`（`bin/omarchy-notification-send`）包装 `notify-send`，注入 Omarchy 专有 hints（`omarchy-glyph`、`omarchy-exec`）让 Quickshell shell 识别 glyph 与点击回调。`--exec` 点击回调**不通过 libnotify action 传递**而通过 hint 字符串——因为 libnotify action 会阻塞直到点击，且 shell 重启时丢失未回答回调。统一 `app_name="omarchy-action"` 保证 DND 穿透一致。`AGENTS.md` 明确规定 "do not call `notify-send` directly"。

`omarchy-pkg-add`（`bin/omarchy-pkg-add`）包装 `pacman -S`：先 `omarchy-pkg-missing` 检测避免重复装、root/非 root 分流（root 直接执行、非 root 用 sudo）、装后 `pacman -Q` 二次验证（处理 pacman 偶尔不报错的边界）。`omarchy-pkg-drop` 同理替代 `pacman -R*`。

`omarchy-shell`（`bin/omarchy-shell`）是 IPC 桥：`output=$(timeout --kill-after=1s "$ipc_timeout" qs ipc -n -p "$OMARCHY_PATH/shell" call -- "$@")`（`bin/omarchy-shell:59`），转发到运行中的 shell，不启动 shell。

### hw-* exit-code 约定

`hw-*` 命令不输出文本，仅用 exit code（0=匹配/1=不匹配）作布尔值供条件判断。`omarchy-hw-match`（`bin/omarchy-hw-match`）就两行：`grep -qi "$1" /sys/class/dmi/id/product_name || grep -qi "$1" /sys/class/dmi/id/product_family`。调用方 `if omarchy-hw-framework16; then ...`。`omarchy-hw-nvidia-gsp` 读 `/sys/bus/pci/devices`（而非 `lspci`，避免唤醒 runtime-suspended GPU）按 vendor/device 判断 Turing+。检测命令与消费方分离，install 脚本条件执行（见[安装装配](04-install-assembly)）。

`AGENTS.md` 规定：Omarchy 默认包集安装的命令是 **runtime invariants**，直接调用不加 `omarchy-cmd-present` 防御检查——缺失它们 Omarchy 本身无法启动，防御检查永远不触发且降低可读性。`omarchy-cmd-present` 只用于真正可选的依赖（如 `1password`）或安装阶段（包集未完整时）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Metadata-Driven Dispatch | `register_command` 扫 `# omarchy:` | 命令文件自洽，存在即注册删除即注销，零漂移 |
| Convention over Configuration | `bin/omarchy:251` 文件名推断 | 不加注释也能生成有效 fallback route |
| Front Controller | `bin/omarchy` 单入口 | 路由/help/校验集中管控 |
| Helper Facade | `omarchy-notification-send`/`omarchy-pkg-add` | 标准化 + 集中修改 + 安全兜底 |
| Exit-Code-as-Boolean | `omarchy-hw-*` | 硬件检测作布尔供条件判断 |

## 模块间交互

CLI 命令是最大消费方：经 `omarchy-shell` IPC 操作 [Shell 框架](01-shell-framework) 与 [插件系统](02-plugin-system)（如 `omarchy-shell shell summon`/`setPluginEnabled`）；`omarchy-theme-set*` 驱动 [主题系统](05-theme-system)；`omarchy-migrate`/`omarchy-update*` 驱动[迁移更新](06-migration-update)；`omarchy-apply-system`/`omarchy-provision-user` 驱动[安装装配](04-install-assembly)。命令用 `$OMARCHY_PATH` 定位非 bin 资源（`themes/`、`shell/`、`config/`、`migrations/`）。`bin/omarchy` 自身不依赖 `OMARCHY_PATH`——用 `BASH_SOURCE` 推导 `OMARCHY_BIN_DIR` 自定位。

## 扩展方式

- **新增命令**：建 `bin/omarchy-<group>-<verb>`，头部写 `# omarchy:summary=...` 等，`chmod +x`。无需改路由器。新分组在 `bin/omarchy` 的 `GROUP_DESCRIPTIONS` 加一行。
- **加 alias**：命令头部 `# omarchy:aliases=omarchy foo | omarchy bar`，`|` 分隔。跑 `omarchy commands --check` 确认无 collision。
- **改 helper 行为**：改 `bin/omarchy-notification-send`/`omarchy-pkg-add` 等单一文件，所有调用方自动受益。
