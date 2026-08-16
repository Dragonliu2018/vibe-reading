---
title: "修复 aspeed PCIe 端口初始化错误路径的 clk 泄漏"
source:
  project: "Linux"
  type: "commit"
  id: "7fa639"
  prType: "fix"
date: "2026-08-16T18:29:51+08:00"
category: ["OS", "Linux", "Contributions"]
tags: ["Linux Kernel", "PCI", "ASPEED", "PCIe", "Clock", "clk_prepare_enable", "Error Path", "Resource Leak", "PHY", "Contributions"]
description: "aspeed PCIe 端口初始化 aspeed_pcie_port_init() 里 clk_prepare_enable() 开了端口时钟后，如果 phy_init() 或 phy_set_mode_ext() 失败就直接返回、没调 clk_disable_unprepare()，每次 probe 失败都泄漏一个时钟引用。修法是给两个错误路径补 clk_disable_unprepare(port->clk)。Fixes 9aa0cb68fcc1，Cc: stable。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **commit** [7fa639] · **首发版本** `-` · **变更行数** +6 行 · **合并时间** 2026-08-16

---

## 背景

`drivers/pci/controller/pcie-aspeed.c` 是 ASPEED SoC 的 PCIe Root Complex 驱动。它的 `aspeed_pcie_port_init()` 在初始化每个 PCIe 端口时按顺序做三步：① `clk_prepare_enable(port->clk)` 开端口时钟；② `phy_init(port->phy)` 初始化 PHY；③ `phy_set_mode_ext(port->phy, PHY_MODE_PCIE, ...)` 设 PHY 模式。

问题在错误路径：① 成功后，如果 ② `phy_init()` 或 ③ `phy_set_mode_ext()` 失败，函数直接 `return dev_err_probe(...)` 返回——**没调 `clk_disable_unprepare()`** 把 ① 开的时钟关回去。每次 probe 失败都漏一个时钟引用（prepare/enable 计数只增不减）。

本 commit 给两个错误路径补上 `clk_disable_unprepare(port->clk)`，在 `return` 之前把时钟关掉。`Fixes: 9aa0cb68fcc1`（"PCI: aspeed: Add ASPEED PCIe RC driver"，ASPEED PCIe RC 驱动的引入 commit），`Cc: stable@vger.kernel.org` 请求 stable 回溯。

## 前置知识

### `clk_prepare_enable` / `clk_disable_unprepare`

`clk_prepare_enable(clk)` = `clk_prepare(clk)` + `clk_enable(clk)`（prepare 走可能睡眠的初始化、enable 开闸门），配对的是 `clk_disable_unprepare(clk)`（反序：disable + unprepare）。两者必须配对调用——调一次 enable 就要调一次 disable_unprepare，否则 prepare/enable 计数只增不减，时钟引用泄漏（时钟没法关、provider 没法释放）。

### PHY API

`phy_init(phy)` 初始化 PHY（可能睡眠）；`phy_set_mode_ext(phy, mode, submode)` 设 PHY 工作模式（这里设 PCIe RC 模式）。两步都可能失败（返回负 errno），失败后要回滚前面已做的步骤——本 bug 就是漏了回滚 ① 的 `clk_prepare_enable`。

## 涉及的函数与调用链

### 函数清单（文件 : 行号）

| 函数 | 位置 | 角色 |
|------|------|------|
| `aspeed_pcie_port_init` | `drivers/pci/controller/pcie-aspeed.c:751` | 端口初始化：clk_prepare_enable → phy_init → phy_set_mode_ext（本 commit 修的错误路径在这） |
| `aspeed_pcie_parse_port` | `pcie-aspeed.c:916`（调 `port_init` 在 :955） | 解析一个端口：取 clk/phy/perst → `aspeed_pcie_port_init(port)` |
| `aspeed_pcie_parse_dt` | `pcie-aspeed.c:959` | 解析 DT：遍历子节点、对每个调 `aspeed_pcie_parse_port` |
| `clk_prepare_enable` / `clk_disable_unprepare` | `include/linux/clk.h` | 时钟 enable/ disable 配对 |
| `phy_init` / `phy_set_mode_ext` | `include/linux/phy/phy.h` | PHY 初始化 / 设模式 |

### 调用链

```text title="aspeed PCIe 端口初始化调用链（改动前错误路径漏 clk_disable_unprepare）"
aspeed_pcie_probe (platform driver probe)
  └─ aspeed_pcie_parse_dt(pcie)                        # :959
       └─ aspeed_pcie_parse_port(pcie, node, slot)     # :916
            ├─ clk_prepare_enable(port->clk)            # :757  ① 开时钟
            ├─ phy_init(port->phy)                     # :763  ② 初始化 PHY（可能失败）
            ├─ phy_set_mode_ext(port->phy, ...)         # :769  ③ 设 PHY 模式（可能失败）
            └─ reset_control_deassert(port->perst) + msleep
# 改动前：② 或 ③ 失败 → return（漏 clk_disable_unprepare，clk 泄漏）
# 改动后：② 或 ③ 失败 → clk_disable_unprepare(port->clk) → return（配平）
```

## 实现

改动 +6/-2，给 `phy_init` 和 `phy_set_mode_ext` 的两个失败路径各补一句 `clk_disable_unprepare(port->clk)`：

```diff title="drivers/pci/controller/pcie-aspeed.c (aspeed_pcie_port_init)"
 	ret = phy_init(port->phy);
-	if (ret)
+	if (ret) {
+		clk_disable_unprepare(port->clk);
 		return dev_err_probe(dev, ret,
 				     "failed to init phy pcie for slot (%d)\n",
 				     port->slot);
+	}
 
 	ret = phy_set_mode_ext(port->phy, PHY_MODE_PCIE, PHY_MODE_PCIE_RC);
-	if (ret)
+	if (ret) {
+		clk_disable_unprepare(port->clk);
 		return dev_err_probe(dev, ret,
 				     "failed to set phy mode for slot (%d)\n",
 				     port->slot);
+	}
```

两处对称：`if (ret) {` 加花括号 + `clk_disable_unprepare(port->clk)` + `return dev_err_probe(...)`。时钟在 `phy_init`/`phy_set_mode_ext` 失败时、`return` 前关掉，配平 `clk_prepare_enable`。

## Review

- 本 commit 由本人（Liu Zhenlong）提交，属 `Contributions`，`prType: fix`。`Fixes: 9aa0cb68fcc1`（"PCI: aspeed: Add ASPEED PCIe RC driver"，Jacky Chou，2025-12-16）指向引入泄漏的源头 commit；`Cc: stable@vger.kernel.org` 请求 stable 回溯。
- `Compile-tested with gcc on arm64 defconfig using COMPILE_TEST; no hardware available for runtime testing`——编译验证（无实机）。
- trailer `Assisted-by: Claude:claude-opus-5` 标注 AI 协助（与本文 `aiModel` 一致）。
- 尚未进上游/lore（本地 commit，`首发版本` 暂 `-`）；待提交到 linux-pci 邮件列表后补 lore patch 链接。

## 问题

### 为什么会泄漏

`clk_prepare_enable()` 成功后，时钟的 prepare/enable 计数各 +1。之后 `phy_init()` 或 `phy_set_mode_ext()` 失败、函数直接 `return`，计数没 −1 回去——`clk_disable_unprepare()` 没调。每次 probe 走到这条失败路径都漏一次，时钟没法关、底层时钟 provider 的引用也放不掉。

### 为什么之前没发现

ASPEED PCIe 是 2025 年底（`9aa0cb68fcc1`）才进内核的新驱动，用的人少；且 clk 泄漏只在 `phy_init`/`phy_set_mode_ext` 失败时才发生（正常 probe 不触发），不崩不报——典型的「错误路径漏清理」静默泄漏，要走到特定失败路径 + 时钟资源紧张才暴露。

## 意义与影响

- **堵住 clk 泄漏**：两个失败路径都配平 `clk_prepare_enable`，probe 失败时不再漏时钟引用。
- **错误路径清理纪律**：这是「acquire → 后续步骤失败 → 按反序 undo」的最小体现——`clk_prepare_enable` 是 ①，`phy_init`/`phy_set_mode_ext` 是 ②③；②③ 失败时要 undo ①。同一种「错误路径漏清理」模式在内核里反复出现（of_node 的 `of_node_get`/`of_node_put`、tag 的 `get_tag`/`put_tag`、clk 的 `enable`/`disable`——都是 acquire 与 release 配对、错误路径要按反序回滚）。
- **`Fixes` + `Cc: stable`**：指向源头 commit + 请求 stable 回溯，让 LTS 内核也能拿到这个修复。

## 参考

- **引入泄漏的 commit** [`9aa0cb68fcc1`](https://github.com/torvalds/linux/commit/9aa0cb68fcc1)（"PCI: aspeed: Add ASPEED PCIe RC driver"，Jacky Chou，2025-12-16）：本 commit `Fixes:` 指向的源头，`aspeed_pcie_port_init` 由它引入、错误路径从那时起就漏 `clk_disable_unprepare`。
- **时钟 API**：`clk_prepare_enable` / `clk_disable_unprepare`，见 `include/linux/clk.h` 与 `drivers/clk/clk.c`（prepare/enable 计数配对管理）。

## 相关阅读

- **驱动模型与基础设施** —— [Linux CodeWiki 7.1 · 12-driver-model](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)：platform/PCI 驱动的 probe + 错误路径回滚框架，`aspeed_pcie_port_init` 的「acquire → 后续失败 → 反序 undo」正处其中，可对照看错误路径清理的通用纪律。
