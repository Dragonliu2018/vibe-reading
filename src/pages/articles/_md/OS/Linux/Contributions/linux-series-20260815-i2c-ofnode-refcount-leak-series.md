---
title: "一次性修复 5 个 i2c 总线驱动的 device_node 引用计数泄漏"
source:
  project: "Linux"
  type: "series"
  id: "20260815"
  url: "https://lore.kernel.org/linux-i2c/20260815181204.2321-1-dragonliu2018@gmail.com/"
  prType: "fix"
date: "2026-08-16T02:51:28+08:00"
category: ["OS", "Linux", "Contributions"]
tags: ["Linux Kernel", "I2C", "Device Tree", "of_node", "引用计数", "Patch Series", "i2c_del_adapter", "mpc", "cpm", "ibm_iic", "opal", "pnx", "Contributions"]
description: "一个 5-patch 系列统一修复 mpc/cpm/ibm_iic/opal/pnx 五个 i2c 总线驱动的 device_node 引用计数泄漏：各驱动 probe 里有 of_node_get 却漏了配对的 of_node_put，加上 i2c_del_adapter() 末尾 memset 清零 of_node 使 put 变空操作。系列用同一套 cache-before-del + 错误路径补 put 一次收口，Fixes 分别指向 9fd049/b41a216/470834508f87 三个引入 of_node_get 的源头 commit。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [cover 0/5](https://lore.kernel.org/linux-i2c/20260815181204.2321-1-dragonliu2018@gmail.com/T/#t) · **首发版本** `-` · **变更行数** +29 行 · **合并时间** 2026-08-15

---

## 背景

Linux 的 i2c adapter 驱动里，`adap->dev.of_node = of_node_get(...)` 这套「probe 时取 device tree 节点引用」的模式，自 2010 年 commit `9fd049`（`of/i2c: Generalize OF support`）立下后被多个驱动照搬。但不少驱动**只学了 get、漏了配对的 `of_node_put`**：probe 里取了引用，错误路径和 remove 里却没还——引用计数永远多一，泄漏一个 `device_node`。雪上加霜的是 `i2c_del_adapter()` 末尾那句 `memset(&adap->dev, 0, ...)`（commit `bd4bc3dbded9` 加的），会在 remove 时把 `adap->dev.of_node` 清成 `NULL`，就算驱动在 `i2c_del_adapter()` 之后写了 `of_node_put(adap->dev.of_node)`，读到的也是 `NULL`、`of_node_put(NULL)` 是空操作——put 形同虚设。

这是**一类**问题、**一个**根因、**五个**驱动同时中招：mpc、cpm、ibm_iic 三个的 `of_node_get` 由 `9fd049`（2010）引入，opal 的由 `470834508f87`（"i2c: Driver to expose PowerNV platform i2c busses"）引入，pnx 的由 `b41a216`（2012，`i2c: Add device tree support to i2c-pnx.c`）引入——五个都「加了 get 没加 put」，泄漏了 16 年。

本系列（`[PATCH 0/5] i2c: fix device_node refcount leaks in 5 bus drivers`）把五个驱动一次性收口，用**同一套写法**：remove 里先快照 `node = adap->dev.of_node`、再 `i2c_del_adapter`、再 `of_node_put(node)`（cache-before-del，绕开 memset），并在 probe 的错误路径补 `of_node_put(adap->dev.of_node)`。每个 patch 的 `Fixes:` 都指向引入 `of_node_get` 的那个源头 commit。

![5 个 i2c 驱动的 of_node 泄漏 → 统一修复](/vibe-reading/images/articles/linux-series-20260815-i2c-ofnode-refcount-leak-series/fan-in.svg)

上图把五个驱动（红，各自 `of_node_get` 漏 put、`Fixes` 指向各自源头）汇到同一个修复（绿）：remove 的 cache-before-del + probe 错误路径补 put，根因都是 `i2c_del_adapter()` 末尾的 `memset`（`bd4bc3dbded9`）。同一模式、五处落地。

## 前置知识

### `of_node_get` / `of_node_put` 与 9fd049 模式

`device_node` 带 `kref` 引用计数：`of_node_get()` +1、`of_node_put()` −1、归零释放；`of_node_put(NULL)` 是静默空操作。2010 年 `9fd049` 给 i2c adapter 驱动立下「probe 里 `adap->dev.of_node = of_node_get(...)` 存指针时取引用、配套 `of_i2c_register_devices(adap)` 读它枚举子设备」的模式。详见 [通用化 OF I2C 支持并确立 adap->dev.of_node 的 of_node_get 模式](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support)。

### `i2c_del_adapter()` 末尾的 `memset`（根因）

`i2c_del_adapter()`（`drivers/i2c/i2c-core-base.c`）在 `device_unregister()` 之后做 `memset(&adap->dev, 0, sizeof(adap->dev))`（`bd4bc3dbded9` 引入），把整个 `adap->dev` 清零——连 `adap->dev.of_node` 一起变 `NULL`。所以**任何在 `i2c_del_adapter()` 之后才 `of_node_put(adap->dev.of_node)` 的代码，读到的都是 `NULL`，put 是空操作**。这正是 mtd 的 `56570bd`、qcom-CCI 的 `8eacce3` 修过的同一根因，本系列给另五个驱动再修一遍。

### cache-before-del 修复模式

解法是把 `of_node_put` 要用的指针在 `i2c_del_adapter()` **之前**快照到局部变量：`node = adap->dev.of_node` → `i2c_del_adapter`（内部 memset 清零 `adap->dev`，但 `node` 不受影响）→ `of_node_put(node)`（用快照，真实归还）。i2c-mux 的 `i2c_mux_del_adapters` 早就是这套写法。

## 涉及的驱动与调用链

### 5 个驱动一览

| # | 驱动 | 文件 | probe / remove | of_node_get 来源（`Fixes`） | fix patch | 行数 |
|---|------|------|----------------|------------------------------|-----------|------|
| 1/5 | mpc | `i2c-mpc.c` | `fsl_i2c_probe` / `fsl_i2c_remove` | `9fd049927ccb`（9fd049, 2010） | `05f3fcfa` | +5/-1 |
| 2/5 | cpm | `i2c-cpm.c` | `cpm_i2c_probe` / `cpm_i2c_remove` | `9fd049927ccb`（9fd049, 2010） | `b99957fe` | +3 |
| 3/5 | ibm_iic | `i2c-ibm_iic.c` | `iic_probe` / `iic_remove` | `9fd049927ccb`（9fd049, 2010） | `3e637e0b` | +4 |
| 4/5 | opal | `i2c-opal.c` | `i2c_opal_probe` / `i2c_opal_remove` | `470834508f87`（PowerNV i2c） | `c167abf7` | +5/-1 |
| 5/5 | pnx | `i2c-pnx.c` | `i2c_pnx_probe` / `i2c_pnx_remove` | `b41a216dafe4`（b41a216, 2012） | `05515d15` | +12/-3 |

mpc/cpm/ibm_iic 的 `of_node_get` 都来自 `9fd049`（它当年给这三个 PowerPC 驱动一起加的），所以这仨 `Fixes:` 都指向 `9fd049927ccb`；pnx 的来自 `b41a216`（2012 给 i2c-pnx 加 DT 支持时加的）；opal 的来自 `470834508f87`（POWER 平台 i2c 驱动的起源）。pnx 改动最大（+12/-3）是因为它的 probe 错误路径最多、要补的 `of_node_put` 也最多。

### 共性调用链（改动前 → 改动后）

```text title="remove 路径（5 驱动同构）"
改动前：i2c_del_adapter(adap) → of_node_put(adap->dev.of_node)
                              ↑ memset 已清零 of_node → put(NULL) 空操作 → 泄漏
改动后：node = adap->dev.of_node → i2c_del_adapter(adap) → of_node_put(node)
        ↑ 快照在 memset 之前取，不受影响 → 真实归还 → 配平
```

```text title="probe 错误路径（5 驱动同构）"
改动前：i2c_add_*adapter 失败 → return（of_node_get 拿的引用没还）
改动后：i2c_add_*adapter 失败 → of_node_put(adap->dev.of_node) → return
```

## 实现

五个 patch 的改动同构，以 mpc（最简，+5/-1）为代表：

```diff title="drivers/i2c/busses/i2c-mpc.c (fsl_i2c_probe · 错误路径)"
 	result = i2c_add_numbered_adapter(&i2c->adap);
-	if (result)
+	if (result) {
+		of_node_put(i2c->adap.dev.of_node);
 		return result;
+	}
```

```diff title="drivers/i2c/busses/i2c-mpc.c (fsl_i2c_remove · cache-before-del)"
 static void fsl_i2c_remove(struct platform_device *op)
 {
 	struct mpc_i2c *i2c = platform_get_drvdata(op);
+	struct device_node *node = i2c->adap.dev.of_node;
 
 	i2c_del_adapter(&i2c->adap);
+	of_node_put(node);
 };
```

其余四个（cpm / ibm_iic / opal / pnx）改法完全对称，只是 adapter 句柄不同（`cpm->adap` / `dev->adap` / `adapter` / `alg_data->adapter`）、错误路径数量不同：

| 驱动 | adapter 句柄 | probe 错误路径补的 put | remove 快照+put |
|------|--------------|----------------------|-----------------|
| cpm | `cpm->adap` | 1 处（`out_clk`） | `node = cpm->adap.dev.of_node` → `of_node_put(node)` |
| ibm_iic | `dev->adap` | 1 处 | `node = dev->adap.dev.of_node` → `of_node_put(node)` |
| opal | `adapter` | 1 处 | `node = adapter->dev.of_node` → `of_node_put(node)` |
| pnx | `alg_data->adapter` | 4 处（3 个早期返回 + `out_clock`） | `node = alg_data->adapter.dev.of_node` → `of_node_put(node)` |

pnx 错误路径最多（4 处 put），所以行数最大（+12/-3）；其余 4 个各 1 处错误路径 put + remove 的快照 put。

## Review

- 本系列由本人（Liu Zhenlong）提交到 linux-i2c 邮件列表，5 个 patch + 1 个 cover letter（`[PATCH 0/5]`，2026-08-15 18:12 UTC，见 meta 行各 patch 链接）。cover 把五个驱动列在一封里、统一说明。
- 每个 patch 的 `Fixes:` 都精确指向**引入 `of_node_get` 的那个源头 commit**：mpc/cpm/ibm_iic → `9fd049927ccb`，opal → `470834508f87`，pnx → `b41a216dafe4`——便于 stable 机器人按 `Fixes` 链回溯到正确的「引入债」节点。
- **qcom-CCI 的同款修复不在本系列里**：`8eacce3`（`i2c: qcom-cci: fix device_node refcount leak ...`）是更早（2026-08-15 14:09 UTC）单独发的 standalone `[PATCH]`，不在本 5-patch 系列中。它和本系列是同一根因、同一解法的**兄弟 patch**，详见[修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak)。
- 本系列对应本地 `fix-i2c-ofnode-refcount-leak` 分支上的 5 个 commit（`05f3fcfa`/`b99957fe`/`3e637e0b`/`c167abf7`/`05515d15`）；尚未进上游，故 `首发版本` 暂 `-`。

## 问题

### 为什么 5 个驱动同时中招

因为它们**当年加 `of_node_get` 时都没配对 `of_node_put`**。`9fd049`（2010）给 mpc/cpm/ibm_iic 三个一起加的，写法上只「存指针取引用」、没在 remove/错误路径还；`b41a216`（2012）给 pnx 加 DT 支持时同样只取不还；opal 的 `470834508f87` 也是。这是 of_node 引用计数系列里反复出现的「半套模式」——学了 9fd049 的 get、漏了 put，形态和 qcom-CCI（`02a4a6` 漏 get）不同、根子都在「没把取/放配平」。

### 为什么拖了 16 年才修

因为 `of_node_put(NULL)` 静默成功——`i2c_del_adapter()` 末尾的 `memset` 让 remove 里那句 put 读到 `NULL`、变成空操作，不崩不报。开机常驻的 DT 节点引用永不归零，泄漏被「节点常驻」掩盖；只有 overlay / 反复 probe-remove 才会真正阻碍节点回收。所以这是「非 overlay 不可见」的静默泄漏，和 qcom-CCI、mtd 的 of_node 泄漏一样，靠 device tree 引用计数校验器才能逮到。

### 为什么用一个系列而不是 5 个散 patch

同一根因（`i2c_del_adapter` 的 `memset` + 缺 `of_node_put`）、同一解法（cache-before-del + 错误路径补 put）、5 个驱动——一个系列比 5 个散 patch 更能说清「这是一类问题、一次收口」，也便于维护者一次性审。这正是「同模式多驱动修复」走 patch 系列而非散 patch 的典型场景。

## 意义与影响

- **一次性收口 16 年的 of_node 引用债**：mpc/cpm/ibm_iic 自 2010（`9fd049`）、pnx 自 2012（`b41a216`）、opal 自其起源——五个驱动漏掉的 `of_node_put` 在一个系列里全部补齐，统一用 cache-before-del 绕开 `i2c_del_adapter` 的 `memset` 陷阱。
- **统一在 cache-before-del 模式上**：和 qcom-CCI 的 `8eacce3`、mtd 的 `56570bd`、i2c-mux 的 `i2c_mux_del_adapters` 同一套写法——「在会清零结构的函数之前快照指针」成了 i2c adapter 卸载路径的统一纪律。
- **`Fixes` 链把债追到源头**：每个 patch 的 `Fixes:` 指向引入 `of_node_get` 的那个 commit（`9fd049`/`b41a216`/`470834508f87`），让 stable 回溯和将来阅读都能顺藤摸到「get 是哪年加的、put 是哪年才补的」。
- **`i2c_del_adapter()` 的 `memset` 是个长期地雷**：任何「在 `i2c_del_adapter()` 之后才碰 `adap->dev.*`」的 i2c adapter 驱动都中过这雷——本系列 + `8eacce3` + `56570bd` 一共修了 6 个驱动，但根因（`bd4bc3dbded9` 的 `memset`）仍在，新驱动若再犯还会踩。

## 参考

- **系列线程** [lore.kernel.org/linux-i2c/20260815181204.2321-1-dragonliu2018@gmail.com](https://lore.kernel.org/linux-i2c/20260815181204.2321-1-dragonliu2018@gmail.com/T/)（`[PATCH 0/5] i2c: fix device_node refcount leaks in 5 bus drivers`）：cover + 5 patch 全部来路。
- **引入 `of_node_get` 的三个源头 commit**：`9fd049927ccb`（mpc/cpm/ibm_iic，2010）、`b41a216dafe4`（pnx，2012）、`470834508f87`（opal）——本系列各 patch `Fixes:` 指向的目标，即「债」的起点。

## 相关阅读

- **通用化 OF I2C 支持并确立 adap->dev.of_node 的 of_node_get 模式** —— [Linux commit-9fd049](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support)：mpc/cpm/ibm_iic 三个驱动 `of_node_get` 的源头（也是本系列 patch 1/5–3/5 的 `Fixes:` 目标）。9fd049（2010）立模式时只加 get、没加 put，埋下本系列修的债；建议与本篇对照看「模式立」与「债还」。
- **为 i2c-pnx 添加 device tree 支持并套用 adap->dev.of_node 的 of_node_get 模式** —— [Linux commit-b41a216](/vibe-reading/articles/OS/Linux/PRs/linux-commit-b41a216-of-i2c-pnx-dt-support)：pnx 的 `of_node_get` 来源（本系列 patch 5/5 的 `Fixes:` 目标）。b41a216（2012）给 pnx 加 DT 支持时加了 get 漏了 put，本系列 05515d1 补齐。
- **修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏** —— [Linux commit-8eacce](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak)：同根因、同解法的兄弟 patch（系列外单独发的）。qcom-CCI 的 `8eacce3` 和本系列五 patch 是同一套 cache-before-del，根因同是 `i2c_del_adapter` 的 `memset`（`bd4bc3dbded9`）。
- **修复 del_mtd_device 清零顺序引发的 of_node 引用泄漏** —— [Linux commit-56570b](/vibe-reading/articles/OS/Linux/PRs/linux-commit-56570b-mtd-del-device-of-node-refcount)：同 cache-before-del 模式的 mtd 实例。mtd 是驱动自己的 `memset` 在 put 前清零，本系列是 `i2c_del_adapter` 内部的 `memset` 干同样的事——跨子系统同形态。
- **I2C 子系统** —— [Linux CodeWiki 7.1 · 13-i2c-subsystem](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/13-i2c-subsystem)：Linux i2c 子系统的 CodeWiki 解读，adapter 注册/注销与 OF 枚举在其中，本系列五个驱动的 probe/remove 正处该框架。
