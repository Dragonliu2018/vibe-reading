---
source:
  type: "源码解读"
  project: "Omarchy"
  url: "https://github.com/basecamp/omarchy"
title: "迁移与更新"
date: "2026-08-25T10:44:29+08:00"
category: [OS, Linux, Distribution, Omarchy, CodeWiki, "4.0.0"]
tags: ["Omarchy", "迁移", "更新", "ALPM", "systemd"]
description: "Omarchy 的自维护引擎——per-user 幂等迁移、omarchy update 独占管线、ALPM guard 拦截直连 pacman、登录通知。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/Distribution/Omarchy/CodeWiki/4.0.0/00-overview)

---

## 模块定位

迁移与更新是 Omarchy 作为包化发行版的"自维护"引擎：per-user 幂等迁移修复 pacman 管不了的状态（`migrations/*.sh` + `omarchy-migrate`）；`omarchy update` 独占完整更新管线（lock→snapshot→pacman→migrate→restart）；ALPM guard 拦截直连 `pacman -Syu` 把用户 nudge 回正规路径；登录时 `omarchy-migrate-notify` 提示 pending 迁移。它解决"升级不踩坑、多用户各跑各的迁移、绕过 guard 也有兜底"的问题，与桌面 UI 无关。

## 模块架构

```
更新管线 omarchy-update (bin/omarchy-update)
  ├ script(1) 录制 /tmp/omarchy-update.log
  ├ omarchy-update-lock (flock + OMARCHY_UPDATE_LOCK_FD)
  ├ omarchy-update-requires-free-space (10G)
  ├ omarchy-update-confirm (gum) ‖ -y
  ├ omarchy-update-pkg-prune → omarchy-snapshot → omarchy-update-stay-awake start
  ├ omarchy-update-dev → omarchy-update-keyring → omarchy-update-system-pkgs (OMARCHY_UPDATE_PACMAN=1 pacman -Syu)
  ├ omarchy-migrate → omarchy-hook post-update
  ├ omarchy-update-aur-pkgs → omarchy-update-mise → omarchy-update-orphan-pkgs
  ├ omarchy-update-analyze-logs → omarchy-update-status (IPC 刷新 shell 指示器)
  └ omarchy-update-stay-awake stop → omarchy-update-restart (reboot ‖ restart shell)

迁移 migrations/*.sh (0644, 无 shebang, bash -euo pipefail)
  └ omarchy-migrate: wait pacman db.lck(900s) → 遍历 → per-user marker → dismiss 通知

ALPM hooks (default/libalpm/hooks/)
  ├ 00-omarchy-update-guard.hook     (PreTransaction, omarchy-update-pacman-guard, AbortOnFail)
  ├ 10-omarchy-hyprland-reload-pause.hook  (settings 安装前暂停 Hyprland 重载)
  └ 90-omarchy-hyprland-reload-resume.hook (settings 安装后恢复 + hyprctl reload)

登录通知 omarchy-migrate-notify.service (After=graphical-session.target, ConditionPathIsDirectory)
  └ omarchy-migrate-notify: update_in_progress? → --pending? → wait 通知服务 → critical 通知
```

## 调用链路

完整更新管线见概览 update-flow SVG。三条触发路径：

```
Path 1（正规）: omarchy update
  script(1) → lock → free-space → confirm → prune → snapshot → stay-awake start
  → dev → keyring → system-pkgs → migrate → hook → aur/mise/orphan → analyze
  → status(IPC) → stay-awake stop → restart(reboot ‖ restart-shell)

Path 2（绕过）: sudo pacman -Syu
  → ALPM PreTransaction → omarchy-update-pacman-guard → AbortOnFail + 打印指引
  → 用户绕过: sudo env OMARCHY_ALLOW_DIRECT_PACMAN=1 pacman -Syu → 包更新无迁移/hook/restart
  → 下次登录: migrate-notify → --pending → critical 通知 → 点击开终端 omarchy-migrate

Path 3（登录）: graphical-session.target
  → omarchy-migrate-notify.service → omarchy-migrate-notify
  → update_in_progress()? (读自己 XDG_RUNTIME_DIR 锁，update 中则静默)
  → omarchy-migrate --pending → omarchy-notification-wait → 再查 update_in_progress
  → omarchy-notification-send critical（点击开终端 omarchy-migrate）
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 | 关键决策 |
| --- | --- | --- | --- |
| `wait_for_pacman_transaction` | `bin/omarchy-migrate:68` | 等 db.lck 最多 900s | 超时不阻塞，下次登录重试 |
| `pending_migrations` | `bin/omarchy-migrate` | 列 pending | exit 0=有 pending，非 0=无（反直觉） |
| `omarchy-update-pacman-guard` | `bin/` | 检测 `-S -u` 放行规则 | `OMARCHY_UPDATE_PACMAN=1` 内部、`OMARCHY_ALLOW_DIRECT_PACMAN=1` 用户绕过 |
| `update_in_progress()` | `bin/omarchy-migrate-notify:7` | 查自己 runtime 锁 | 不读 `/tmp`，防一个用户静音另一个 |
| `omarchy-update-stay-awake` | `bin/` | systemd-inhibit sleep:idle | 关闭 `OMARCHY_UPDATE_LOCK_FD` 再启，PID+start_time 验证 |
| `omarchy-update-restart` | `bin/` | reboot ‖ restart markers ‖ shell 无条件 | kernel/Hyprland→gum confirm reboot |

</details>

## 核心实现

### 迁移模型与 omarchy-migrate

迁移脚本是 `migrations/<unix-timestamp>.sh`（`omarchy-dev-add-migration` 用 `git log -1 --format=%cd --date=unix` 生成时间戳）。格式硬约束：权限 `0644`（非 executable）、无 shebang、`bash -euo pipefail` 执行、开头 `echo` 描述、用 `$OMARCHY_PATH`、**必须幂等**（先查现有状态再改）。per-user marker 在 `~/.local/state/omarchy/migrations/<filename>`——marker 文件名完全对应脚本名。`omarchy-migrate` 遍历 `migrations/*.sh`，marker 缺失则执行并 `touch`，已存在跳过。`--pending` 退出码反直觉：`0`=有 pending（有事要做），非 `0`=无。

`omarchy-provision-user --first-install` 把所有已发布迁移标记为已应用（`bin/omarchy-provision-user:115`），新装机器不跑历史迁移。4.0 升级走 `bin/omarchy-upgrade-to-quattro`（91.7K 自包含脚本）而非迁移运行器——因为 4.0 是从"直接安装"到"包化"的布局重构，迁移运行器在 `omarchy-migrate` 的 `bash -euo pipefail` 上下文里没能力做包管理层面的布局转换。

### omarchy update 管线

`bin/omarchy-update` 用 `set -e` + ERR trap（红色错误 + 社区链接）+ EXIT trap（`omarchy-update-stay-awake stop`）。步骤刻意排序：`omarchy-update-pkg-prune` 在 `omarchy-snapshot` 前（缓存 sharing 快照子卷，先裁再照省空间）；`omarchy-update-keyring` 在 `omarchy-update-system-pkgs` 前（签名验证需有效密钥）；`omarchy-update-system-pkgs`（`OMARCHY_UPDATE_PACMAN=1 pacman -Syu --noconfirm --overwrite '/usr/share/omarchy/*'`）在 `omarchy-migrate` 前（迁移随包发布、针对新版本）；`omarchy-update-stay-awake stop` 在 `omarchy-update-restart` 前显式释放（防 reboot 抢在 EXIT trap 前终止进程留下持久 inhibitor）。`omarchy-update-system-pkgs` 首次失败 `exec` 接管到 `omarchy-update-system-pkgs-when-conflicted`（清理冲突文件重试），二次失败交 ERR trap。`omarchy-update-analyze-logs` 扫 `/tmp/omarchy-update.log` 查已知失败模式（如 initramfs 生成失败）。

### ALPM guard 与登录通知

`omarchy-update-pacman-guard`（`bin/`）由 `default/libalpm/hooks/00-omarchy-update-guard.hook`（`PreTransaction` + `AbortOnFail`）调用。检测 `pacman -Syu` 类命令（`--sync` + `--sysupgrade` 或 `-S` + `-u` 组合），放行规则：`OMARCHY_UPDATE_PACMAN=1`（`omarchy-update-system-pkgs`/`-refresh-pacman`/`-reinstall-pkgs`/`-upgrade-to-quattro` 设）或 `OMARCHY_ALLOW_DIRECT_PACMAN=1`（用户显式绕过）。命中直连升级则 abort + 打印 "Woah partner..." 指引。**guard 不自动启动 `omarchy update`**——它已在事务 setup 路径（持有 `db.lck`），再启 `omarchy update` 会死锁。

登录通知是兜底：`omarchy-migrate-notify.service`（`After=graphical-session.target`、`ConditionPathIsDirectory=/usr/share/omarchy/migrations`）在登录时跑 `omarchy-migrate-notify`。**登录是唯一触发点**——旧的 `omarchy-update-user-notify.path` 用 path watcher 监视迁移目录，但 pacman 每次 `omarchy update` 都写该目录（含 `omarchy-migrate` 即将应用的那步），watcher 分不清 bypassed pacman 和 update 内部事务，会在可见更新终端里通知正在应用的迁移。通知器**只提示不后台跑迁移**——迁移可能需 `$HOME`/DBus/sudo/用户交互。`update_in_progress()` 读自己 `XDG_RUNTIME_DIR` 锁（不读 `/tmp` 回退路径），防一个用户 update 持有共享 `/tmp` 锁时静音另一个用户的通知。

### 锁与 sleep 抑制器

`omarchy-update-lock`（`bin/`）用 `flock -n` 非阻塞锁 `${XDG_RUNTIME_DIR:-/tmp}/omarchy-update.lock`，通过 `OMARCHY_UPDATE_LOCK_FD` 环境变量传 fd 给子进程。`omarchy-update-stay-awake`（`bin/`）后台 `systemd-inhibit --what=sleep:idle --mode=block sleep infinity`，**启动时关闭继承的 `OMARCHY_UPDATE_LOCK_FD`**（`{OMARCHY_UPDATE_LOCK_FD}>&-`）——否则 inhibitor 子进程继承锁 fd，`omarchy-update` 被 kill 后 inhibitor 仍持锁 → 后续 update 永远等锁 → notifier 永远认为 update 进行中 → 所有用户迁移通知被永久静默。stop 时用 PID + process_start_time 验证未复用才 kill，等 zombie 状态确认终止。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Idempotent Per-User Migration | `migrations/*.sh` + marker | 操作 `$HOME` 状态，多用户机每用户各跑，幂等防重 |
| Owned Update Pipeline | `bin/omarchy-update` 独占 | 可见管线统一编排，其他入口是叶子 |
| Guard Pattern | ALPM `PreTransaction` + AbortOnFail | 拦截直连 pacman，nudge 回正规路径 |
| Lock + Inhibitor | `flock` + `systemd-inhibit` + `OMARCHY_UPDATE_LOCK_FD` | 防并发 update + 防休眠，fd 关联防泄漏 |
| Notifier-Prompt-Not-Background | `omarchy-migrate-notify` | 只提示不后台跑，迁移可能需交互 |
| Compatibility Symlink | `omarchy-update-user-notify`→`migrate-notify` | 旧 unit 名兼容，迁移 `1785095882` 重定向 |

## 模块间交互

迁移更新经 `omarchy-restart-shell` 回到 [Shell 框架](01-shell-framework)（shell 无条件重启，更新常替换 QML 旧进程会延迟加载新文件）；经 `omarchy-provision-user --first-install` 与[安装装配](04-install-assembly)交互（标记所有迁移已应用、first-run enable migrate-notify）；`omarchy-update-dev` fast-forward dev checkout 关心 [CLI 命令](03-cli-commands)的 dev-link 模式；ALPM hooks（`10-`/`90-` pause/resume）在 `omarchy-settings` 升级时暂停 Hyprland 自动重载防半写状态。`omarchy-update-status` 经 IPC（`omarchy-shell -q omarchy.system-update refresh/clear`）刷新 [Shell](01-shell-framework) bar 的更新指示器。

## 扩展方式

- **新增迁移**：`omarchy-dev-add-migration`（生成时间戳文件），编辑 `migrations/<ts>.sh`（开头 echo、用 `$OMARCHY_PATH` 与 `omarchy-pkg-add` 等 helper、幂等）。无需改任何其他文件——`omarchy-migrate` 自动遍历。测试 `HOME=$(mktemp -d) bash -euo pipefail migrations/<ts>.sh`。
- **新增更新后重启检查**：在 `bin/omarchy-update-restart` 加检查逻辑（如 `uname -r` vs `/usr/lib/modules/*/vmlinuz` 的 kernel 更新模式）。新 restart marker 遵循 `~/.local/state/omarchy/restart-<service>-required` 命名，循环自动处理。
- **改 pacman guard 放行**：改 `bin/omarchy-update-pacman-guard` 放行条件（第 8 行 `if`）或检测逻辑。无需改 ALPM hook 文件。
