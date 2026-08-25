---
source:
  type: "源码解读"
  project: "Omarchy"
  url: "https://github.com/basecamp/omarchy"
title: "安装与系统装配"
date: "2026-08-25T10:44:29+08:00"
category: [OS, Linux, Distribution, Omarchy, CodeWiki, "4.0.0"]
tags: ["Omarchy", "Arch Linux", "安装", "系统装配"]
description: "Omarchy 发行版的装配管线——三层 $HOME 填充、env bootstrap 单一真源、root 编排与硬件 quirks、幂等标记。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/Distribution/Omarchy/CodeWiki/4.0.0/00-overview)

---

## 模块定位

安装与系统装配是 Omarchy 作为发行版的"自维护"底座：两个 Arch 包（`omarchy` + `omarchy-settings`）从单 repo 构建；三层机制填充用户 `$HOME`（seed/finalize/resync）；`env-bootstrap` 是 `OMARCHY_PATH` 单一真源；root 侧 `omarchy-apply-system` 编排配置/硬件/登录/收尾；`omarchy-done` 提供幂等标记协议。它解决"装好就能用、已有用户能拿新默认、硬件各得其所"的问题，与运行时桌面分离——装配是一次性或显式触发的生命周期，不在桌面会话里跑。

## 模块架构

```
装配流水线
  omarchy-settings 包 → /etc/skel/** (seed 源) + /etc drop-ins + /usr/share 资产
  omarchy 包        → /usr/bin/omarchy-* + install/ + migrations/ + themes/ + shell/

三层 $HOME:
  Seed     /etc/skel/. ──(useradd -m)──▶ 新用户 $HOME
  Finalize omarchy-provision-user (每用户一次): skill 链接 + xdg + install/user/all.sh + migration markers
  Resync   omarchy-reinstall-configs: cp -af /etc/skel/. ~/ (破坏性)

Root 编排:
  omarchy-apply-system (chroot root)
    ├ install/config/all.sh     (theme-system/lockout/PAM/docker/snapper/firewall/enable-services)
    ├ omarchy-apply-hardware → install/hardware/all.sh (vendor + generic + Intel/ASUS/Apple/Lenovo quirks)
    ├ install/login/all.sh     (SDDM)
    └ install/post-install/all.sh (pacman/udev/localdb)
  omarchy-provision-user --force --first-install (chroot as install user)
  omarchy-provision-first-run (首次图形登录)
```

`default/` 是"既是 seed 源又是系统资产"的双重身份：它既经 PKGBUILD 装到 `/etc/skel/` 与 `/usr/share/omarchy/default/`，又包含 `env-bootstrap`、systemd unit、字体、SDDM/Plymouth 主题等系统级资产。

## 调用链路

ISO 安装的完整 root→user 编排链：

```
omarchy-apply-system --install-user dhh --first-install (root, in chroot)
  ├ source install/helpers/logging.sh → run_logged (每子脚本输出→/var/log/omarchy-install.log)
  ├ source install/config/all.sh      (root 配置: theme-system/lockout/PAM/docker/snapper/firewall/services)
  ├ omarchy-apply-hardware             → source install/hardware/all.sh (vendor quirks + generic + Intel/ASUS/Apple)
  ├ source install/login/all.sh       (SDDM)
  └ source install/post-install/all.sh (pacman restore/udev reload/localdb)

omarchy-provision-user --force --first-install (chroot as install user)
  ├ skill 链接 ~/.{agents,claude,codex,pi/agent}/skills/omarchy → $OMARCHY_PATH/default/agents/skills/omarchy
  ├ xdg-user-dirs + gtk bookmarks (需 $HOME 展开)
  ├ source install/user/all.sh (theme/chromium/git/xcompose/mise/hardware quirks/keyring)
  ├ omarchy-refresh-applications + xdg-settings/xdg-mime defaults
  ├ --first-install → touch 所有 migrations marker (新装不跑历史迁移)
  └ omarchy-done mark finalize-user

omarchy-provision-first-run (首次图形登录, user manager 已活)
  ├ omarchy-done check first-run-user (已完成则 exit)
  ├ omarchy-provision-user --force (重新 finalize)
  ├ run_first_run_step: hook-install + enable-user-units + gnome-theme + welcome + wifi toasts
  └ 全部成功 → omarchy-done mark first-run-user；有失败不 mark，下次重试
```

resync 是显式破坏性路径：`omarchy-reinstall-configs` 做 `cp -af /etc/skel/. ~/`（等效对新用户 `useradd -m`），再 `omarchy-refresh-limine`/`-plymouth` 与 nvim refresh。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 | 关键决策 |
| --- | --- | --- | --- |
| `run_logged(script)` | `install/helpers/logging.sh` | bash -eE 子进程执行 + 日志 | errexit 临时关，单脚本失败不中断整体 |
| `omarchy-done check/mark/ensure` | `bin/omarchy-done` | 幂等标记 | `ensure` 用 `noclobber` 原子写，存在则非零 |
| `omarchy-provision-user` | `bin/omarchy-provision-user` | 一次性用户 finalize | 不复制 `~/.config`（/etc/skel 已 seed） |
| `omarchy-apply-hardware` | `bin/omarchy-apply-hardware` | 硬件编排入口 | source install/hardware/all.sh |
| `omarchy-dev-link/unlink` | `bin/omarchy-dev-*` | OMARCHY_PATH 重指 | 写 /etc/omarchy.conf + sudoers secure_path |

</details>

## 核心实现

### 三层 $HOME 装配

三层分工避免 `/etc/skel` 误触及 finalize 重复复制：

- **Seed**：`omarchy-settings` 包把静态默认装到 `/etc/skel/`，Arch 的 `useradd -m` 在创建用户时复制到 `$HOME`（含 chown）。这是唯一触及全新用户 `$HOME` 的机制。覆盖 `.bashrc`、`.config/**`、nautilus 扩展、hypr toggles、branding。
- **Finalize**（`bin/omarchy-provision-user`，`docs/file-layout.md` 仍称 `omarchy-finalize-user`）：每用户一次，只做 `/etc/skel` 做不到的事——需 `$HOME` 展开（gtk bookmarks 的 `file://$HOME/`）、需 live `OMARCHY_PATH`（dev-aware skill 链接）、需运行时状态（xdg defaults）、`install/user/all.sh` 的 per-user 硬件 quirks。**不复制 `~/.config`**——已 seed。`--first-install` 时 touch 所有 migration marker。
- **Resync**（`bin/omarchy-reinstall-configs`）：破坏性，`cp -af /etc/skel/. ~/` 覆盖回 shipped defaults，加 limine/plymouth/nvim refresh。已有用户取新默认用它。

### env-bootstrap 单一真源

`default/bash/env-bootstrap` 是 `OMARCHY_PATH` 唯一真源（`default/bash/env-bootstrap`）：

```bash title="default/bash/env-bootstrap"
if [ -f /etc/omarchy.conf ]; then
  . /etc/omarchy.conf                       # omarchy-dev-link 写入
  : "${OMARCHY_PATH:=/usr/share/omarchy}"
else
  OMARCHY_PATH=/usr/share/omarchy           # 强制默认，防残留继承值
fi
export OMARCHY_PATH
# 仅 dev-link 模式 prepend PATH（生产环境二进制已在 /usr/bin/omarchy-*）
if [ "$OMARCHY_PATH" != /usr/share/omarchy ]; then
  case ":$PATH:" in *":${OMARCHY_PATH%/}/bin:"*) ;; *) PATH="..." ;; esac
fi
```

它被四个 entry point source（幂等）：`/etc/profile.d/omarchy.sh`（登录 shell）、`/etc/skel/.bashrc`（交互式）、`default/uwsm/env.d/10-omarchy`（Hyprland 会话）、`default/bash/envs`（SSH/非登录）。确保任何入口都正确设 `OMARCHY_PATH`，这是开机链路与所有命令的前提。

### root 编排与硬件检测

`omarchy-apply-system`（root，chroot）经 `run_logged` 逐个 source `install/config/all.sh`、`omarchy-apply-hardware`（→ `install/hardware/all.sh`）、`install/login/all.sh`、`install/post-install/all.sh`。`run_logged`（`install/helpers/logging.sh`）用 `bash -eE` 子进程执行每个子脚本、输出统一重定向到 `/var/log/omarchy-install.log`，errexit 临时关使单脚本失败不中断整体。

硬件检测是 `omarchy-hw-*`（exit code 布尔）+ `install/hardware/*.sh`（消费方）分离。`install/hardware/all.sh` 按 vendor quirks（`omarchy-hw-asus-rog`/`-framework16`/`-surface`）→ generic（network/bluetooth/nvidia/vulkan）→ Intel/ASUS/Apple/Lenovo 子目录条件执行。`install/hardware/nvidia.sh` 双层检测：`lspci` 判断有无 NVIDIA，再 `omarchy-hw-nvidia-gsp`（读 `/sys/bus/pci/devices` 按 device id 判 Turing+）选 `nvidia-open-dkms` 或 `nvidia-580xx-dkms`。

### omarchy-done 幂等协议

`bin/omarchy-done` 三子命令（`~/.local/state/omarchy/done/<name>` marker）：`check`（读存在性）、`mark`（无条件写）、`ensure`（`set -o noclobber; : >"$marker"` 原子写——存在则非零，调用方 `omarchy-done ensure X && do_work` 条件执行）。`omarchy-provision-user`/`omarchy-provision-first-run` 实际用 `check` + `mark` 组合（先 check 已完成则 exit，全部成功后 mark），失败不 mark 下次重试，保证半完成状态不标完成。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Three-Layer Population | seed/finalize/resync | 分离"静态默认/运行时检测/破坏性重置"触发，避免 `/etc/skel` 误触 |
| Env Bootstrap Single Source | `default/bash/env-bootstrap` | `OMARCHY_PATH` 一处定义，四入口 source |
| Hardware Quirk Detection | `omarchy-hw-*` exit code + `install/hardware/*.sh` | 检测与消费分离，quirks 独立可增 |
| Idempotency Marker | `omarchy-done` check/mark/ensure | 一次性步骤可安全重试 |
| Dev-Link / Unlink | `omarchy-dev-link` 写 `/etc/omarchy.conf` + sudoers | 开发模式重指 `OMARCHY_PATH` 不污染运行环境 |
| etc-overrides | `default/` + PKGBUILD scriptlet `cp -f` | `/etc` 文件被上游包拥有，直接装会冲突 |

## 模块间交互

装配在 provisioning 时与 [主题系统](05-theme-system)（`install/user/theme.sh` 设默认主题 Tokyo Night）、[迁移更新](06-migration-update)（`omarchy-provision-user --first-install` touch 所有 migration marker；`omarchy-provision-first-run` enable `omarchy-migrate-notify.service`）交互。`run_logged` 与 `omarchy-hw-*` 复用 [CLI 命令](03-cli-commands)的 helper（`omarchy-pkg-add`/`omarchy-notification-send`）。`default/` 经 PKGBUILD 映射到 `/etc/skel` + `/usr/share/omarchy/default`（resync 源）+ `/usr/lib/systemd/user` 等。被上游包拥有的 `/etc` 文件走 `etc-overrides` scriptlet `cp -f`（tradeoff：用户改会在升级被覆盖，记在 PKGBUILD）。

## 扩展方式

- **新增硬件 quirk**：写检测 `bin/omarchy-hw-<model>`（读 `/sys/class/dmi/id/`），写 root 侧 `install/hardware/<vendor>/fix-<model>.sh`（`if omarchy-hw-<model>; then ...` 包裹），在 `install/hardware/all.sh` 加 `run_logged`。per-user quirk 放 `install/user/hardware/` 接入 `install/user/all.sh`。
- **新增 root 配置步骤**：写 `install/config/<name>.sh`（写 `/etc/...`），在 `install/config/all.sh` 加 `run_logged`。
- **新增首次登录 toast**：写 `install/user/first-run/<name>.sh`（用 `omarchy-notification-send`），在 `bin/omarchy-provision-first-run` 的 `run_first_run_step` 加一行（放 `omarchy-notification-wait` 之后）。
