---
title: "为 i2c-pnx 添加 device tree 支持并套用 adap->dev.of_node 的 of_node_get 模式"
source:
  project: "Linux"
  type: "commit"
  id: "b41a216"
  url: "https://github.com/torvalds/linux/commit/b41a216dafe4dd23c95cb4203de288f773a097a6"
  prType: "feat"
date: "2026-08-16T02:22:28+08:00"
category: ["OS", "Linux", "PRs"]
tags: ["Linux Kernel", "I2C", "Device Tree", "OF", "of_node", "PNX", "LPC32xx", "of_match", "v3.5"]
description: "2012 年 Roland Stigge 给 i2c-pnx（NXP PNX/LPC32xx）驱动加 device tree 支持：新增 of_match 绑定、从 DT 读 clock-frequency、per-instance timeout，并套用 9fd049 立的 adap->dev.of_node = of_node_get() 模式 + of_i2c_register_devices。但只加了 get、漏了配对的 put，留下 imbalance，14 年后由 05515d1 补齐。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20120420](https://lore.kernel.org/all/1334928849-18079-1-git-send-email-stigge@antcom.de/) · **commit** [b41a216](https://github.com/torvalds/linux/commit/b41a216dafe4dd23c95cb4203de288f773a097a6) · **首发版本** v3.5-rc1 · **变更行数** +84 行 · **合并时间** 2012-05-22

---

## 背景

`drivers/i2c/busses/i2c-pnx.c` 是 NXP PNX / LPC32xx 的 I2C 控制器驱动。2012 年前后，它还是**纯 platform 资源驱动**——靠 `mach/*` 头文件和硬编码常量（`I2C_PNX_SPEED_KHZ`、`I2C_PNX_TIMEOUT`）配置，不走 device tree。ARM DT 化浪潮里，它得跟上。

本 commit（Roland Stigge，`i2c: Add device tree support to i2c-pnx.c`）给它补上 DT 支持，一次做五件事：

1. **新增 DT binding 文档** `Documentation/devicetree/bindings/i2c/pnx.txt`，定义 `compatible = "nxp,pnx-i2c"`、`reg`、`interrupts`、`clock-frequency`。
2. **of_match 绑定**：加 `i2c_pnx_of_match[]` + `MODULE_DEVICE_TABLE(of, ...)` + `.of_match_table`，让 platform 总线能用 DT 匹配到这个驱动。
3. **套用 9fd049 模式**：probe 里 `adap->dev.of_node = of_node_get(pdev->dev.of_node)`，并调 `of_i2c_register_devices(&adap)` 枚举 DT 子节点——正是 2010 年 `9fd049` 给 i2c adapter 立的引用计数模式。
4. **配置从 DT 取**：`of_property_read_u32(node, "clock-frequency", &speed)`，硬编码 `I2C_PNX_SPEED_KHZ` 降级为 `*_DEFAULT`；`timeout` 从编译期宏改成 `alg_data->timeout`（per-instance，为日后从 DT 读 timeout 留口子）。
5. **`wait_timeout` / `wait_reset` 改签名**：去掉 `timeout` 参数、改读 `data->timeout`，让超时随实例走。

第 3 点是和 of_node 引用计数系列连上的关键——本 commit 是 9fd049 模式的**早期采用者**，把 `adap->dev.of_node = of_node_get()` 套到又一个驱动上。但它**只学了 get、漏了 put**，埋下 14 年后才补的 imbalance（见「问题」与「意义与影响」）。

![i2c-pnx 加上 DT 支持后的 probe 调用链](/vibe-reading/images/articles/linux-commit-b41a216-of-i2c-pnx-dt-support/dt-probe.svg)

上图是 b41a216 给 probe 接上 DT 后的调用链：`of_match_table` 匹配 `nxp,pnx-i2c` 触发 probe → ① `of_node_get` 取 adapter 节点引用（绿，套用 9fd049 模式）→ ② 从 DT 读 `clock-frequency`、设 per-instance `timeout` → ③ 注册 adapter → ④ `of_i2c_register_devices` 枚举子节点。绿点那行是本 commit 学来的模式，但配对的 `of_node_put` 它一处都没加。

## 前置知识

### 9fd049 立的 `adap->dev.of_node = of_node_get()` 模式

2010 年的 commit `9fd049`（Grant Likely，`of/i2c: Generalize OF support`）给 i2c adapter 驱动立了规矩：probe 里把 `device_node` 存进 `adap->dev.of_node` 时，要 `of_node_get()` 取一份自己的引用；配套的 `of_i2c_register_devices(adap)` 从 `adap->dev.of_node` 读节点、枚举子设备。本 commit 把这套原样搬到 i2c-pnx。详见 [通用化 OF I2C 支持并确立 adap->dev.of_node 的 of_node_get 模式](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support)。

### platform 驱动的 DT 匹配

platform 驱动通过 `.of_match_table` 暴露一组 `of_device_id`（`compatible` 字符串）；内核 platform 总线在枚举 DT 节点时，按 `compatible` 匹配到驱动、触发其 `probe`，`pdev->dev.of_node` 就是匹配上的那个节点。

### `of_i2c_register_devices(adap)`

9fd049 引入的函数：遍历 `adap->dev.of_node` 的子节点，逐个解析 `reg`/`compatible`/中断、注册成 `i2c_client`。b41a216 在 probe 末尾手动调它。**后来**（自动注册落地后）i2c 核心在 `i2c_register_adapter()` 里代劳了这一步，驱动不再需要手动调——所以这行在当前 i2c-pnx.c 里已被移除（见下）。

## 涉及的函数与调用链

### 函数清单（2012 位置 / 当前 2026 位置）

| 函数 | 2012 位置（b41a216） | 当前位置 | 角色 |
|------|-----------|------|------|
| `i2c_pnx_probe` | `i2c-pnx.c`（约 :615） | `i2c-pnx.c:595`（of_node_get 在 :632） | probe：套用 of_node_get 模式、从 DT 读 clock-frequency、设 timeout、调 of_i2c_register_devices |
| `i2c_pnx_remove` | `i2c-pnx.c`（b41a216 未改） | `i2c-pnx.c:720` | remove：b41a216 时无 of_node_put；**当前**有 `node = adap.dev.of_node` → `i2c_del_adapter` → `of_node_put(node)`（由 05515d1 补，见下） |
| `wait_timeout` / `wait_reset` | `i2c-pnx.c`（:75 / :89） | `i2c-pnx.c:98 / :109` | 改签名：去掉 `timeout` 形参、读 `data->timeout`（per-instance） |
| `i2c_pnx_arm_timer` | `i2c-pnx.c:100` | `i2c-pnx.c` | 用 `alg_data->timeout` 替代 `I2C_PNX_TIMEOUT` 宏 |
| `of_i2c_register_devices` | `of_i2c.c`（9fd049 引入） | `i2c-core-of.c:84` | probe 末尾调它枚举 DT 子节点（当前由 i2c 核心自动调，驱动不再手动调） |

### 调用链

```text title="i2c_pnx_probe 接上 DT 后的调用链（改动后）"
of_match_table 匹配 "nxp,pnx-i2c" → i2c_pnx_probe(pdev)
  ├─ adap->dev.of_node = of_node_get(pdev->dev.of_node)   # ① 套用 9fd049 模式（取引用）
  ├─ of_property_read_u32(of_node, "clock-frequency", &speed)  # ② 从 DT 取时钟
  ├─ alg_data->timeout = I2C_PNX_TIMEOUT_DEFAULT          #   per-instance timeout
  ├─ i2c_add_numbered_adapter(adap)                        # ③ 注册 adapter
  └─ of_i2c_register_devices(&adap)                        # ④ 枚举 DT 子节点（当前已移除）
```

### 当前状态（14 年后）

- **`adap->dev.of_node = of_node_get(pdev->dev.of_node)`（行 632）原样还在**——9fd049 模式在这驱动里活到现在。
- **`of_i2c_register_devices` 的手动调用已移除**——i2c 核心后来在 `i2c_register_adapter()` 里自动注册 OF 从设备，驱动不再需要调。
- **probe 错误路径与 remove 里的 `of_node_put` 是 2026 年由 `05515d1` 补的**（见「意义与影响」）——b41a216 当年只加了 get、没加配对的 put。
- `timeout` 后来从 msec（`u32`）演进成 jiffies（`msecs_to_jiffies(...)` 存、`jiffies_to_msecs(...)` 用），per-instance 的设计保留。

## 实现

### 新增 DT binding 文档

```text title="Documentation/devicetree/bindings/i2c/pnx.txt（新增）"
* NXP PNX I2C Controller

Required properties:
 - reg: Offset and length of the register set for the device
 - compatible: should be "nxp,pnx-i2c"
 - interrupts: configure one interrupt line
 ...
Optional properties:
 - clock-frequency: desired I2C bus clock frequency in Hz, Default: 100000 Hz
```

> 这份 `.txt` 后来随 DT binding 整体迁 YAML 而移除，但 `nxp,pnx-i2c` 这个 compatible 一直留着。

### of_match 绑定 + 头文件

```diff title="drivers/i2c/busses/i2c-pnx.c"
 #include <linux/slab.h>
+#include <linux/of_i2c.h>
 ...
+#ifdef CONFIG_OF
+static const struct of_device_id i2c_pnx_of_match[] = {
+	{ .compatible = "nxp,pnx-i2c" },
+	{ },
+};
+MODULE_DEVICE_TABLE(of, i2c_pnx_of_match);
+#endif
+
 static struct platform_driver i2c_pnx_driver = {
 	.driver = {
 		.name = "pnx-i2c",
 		.owner = THIS_MODULE,
+		.of_match_table = of_match_ptr(i2c_pnx_of_match),
 	},
```

### per-instance timeout + 改 wait_* 签名

```diff title="include/linux/i2c-pnx.h"
 struct i2c_pnx_algo_data {
 	struct i2c_adapter	adapter;
 	phys_addr_t		base;
 	int			irq;
+	u32			timeout;
 };
```

宏改名（`I2C_PNX_TIMEOUT`→`_DEFAULT`、`I2C_PNX_SPEED_KHZ`→`_DEFAULT`），暗示它们成了「可被覆盖的默认值」；`wait_timeout`/`wait_reset` 去掉 `timeout` 形参、改读 `data->timeout`，`i2c_pnx_arm_timer` 也改用 `alg_data->timeout`：

```diff title="drivers/i2c/busses/i2c-pnx.c (wait_timeout)"
-static inline int wait_timeout(long timeout, struct i2c_pnx_algo_data *data)
+static inline int wait_timeout(struct i2c_pnx_algo_data *data)
 {
+	long timeout = data->timeout;
 	while (timeout > 0 && (ioread32(I2C_REG_STS(data)) & mstatus_active)) {
```

### probe：套用 of_node_get 模式 + 从 DT 取配置

```diff title="drivers/i2c/busses/i2c-pnx.c (i2c_pnx_probe)"
+	u32 speed = I2C_PNX_SPEED_KHZ_DEFAULT * 1000;
 ...
+	alg_data->timeout = I2C_PNX_TIMEOUT_DEFAULT;
+#ifdef CONFIG_OF
+	alg_data->adapter.dev.of_node = of_node_get(pdev->dev.of_node);
+	if (pdev->dev.of_node) {
+		of_property_read_u32(pdev->dev.of_node, "clock-frequency",
+				     &speed);
+		/*
+		 * At this point, it is planned to add an OF timeout property.
+		 * ... sth. like the following can be put here:
+		 * of_property_read_u32(pdev->dev.of_node, "timeout",
+		 *                      &alg_data->timeout);
+		 */
+	}
+#endif
```

`of_node_get` 那行就是 9fd049 模式；`clock-frequency` 从 DT 读、覆盖默认 `speed`；注释里留了「日后从 DT 读 timeout」的口子（正是 `timeout` 改 per-instance 的动机）。

### probe 末尾：枚举 DT 子节点 + 速度计算用 DT 值

```diff title="drivers/i2c/busses/i2c-pnx.c (i2c_pnx_probe 尾部)"
-	tmp = ((freq / 1000) / I2C_PNX_SPEED_KHZ) / 2 - 2;
+	tmp = (freq / speed) / 2 - 2;        // speed 现在来自 DT 或默认
 ...
+	of_i2c_register_devices(&alg_data->adapter);
```

## Review

- 作者 **Roland Stigge**（`stigge@antcom.de`），彼时 LPC32xx 平台的活跃贡献者；`Signed-off-by: Wolfram Sang`（`w.sang@pengutronix.de`，i2c 子系统维护者背书）。commit 由作者自己提交（AuthorDate = CommitDate）。
- **patch 改了 6 版**：v2/v3 是 8-patch 系列的第 8 个（`[PATCH v2 8/8]` / `[PATCH v3 8/8]`），后抽出成独立 patch 一路改到 v6（`[PATCH v6]`，Message-ID `1334928849-18079-1-git-send-email-stigge@antcom.de`，见 meta 行 patch 链接）。v6 的 raw 与 commit diff 一致（含 `of_node_get(pdev->dev.of_node)`、`nxp,pnx-i2c`、`of_i2c_register_devices`、`i2c_pnx_of_match`、`I2C_PNX_TIMEOUT_DEFAULT` 全部特征行）。
- **合并路径**：经 `Merge tag 'dt' of git://git.kernel.org/.../arm/arm-soc`（`b324c67d4800`，2012-05-22）进 Linus 主线——DT 相关的 i2c patch 当时走 arm-soc 的 DT tag，而非 i2c 树直接进。首见于 v3.5-rc1。

## 问题

### 只学了 get、漏了 put：get-without-put 的 imbalance

b41a216 在 probe 里加了 `adap->dev.of_node = of_node_get(...)`（取一份引用），却**没在任何一处加配对的 `of_node_put`**：

- **probe 错误路径**（`out_clkget`、`out_clock`、`out_irq` 等提前返回点）——b41a216 没补 `of_node_put`，probe 中途失败时 `of_node_get` 拿的引用放不掉。
- **`i2c_pnx_remove`**——b41a216 压根没改 remove，自然没有 `of_node_put`。

也就是说，b41a216 **应用了 9fd049 的取引用模式，却没应用配套的放引用纪律**——取了不还，每次 probe 失败、每次卸载都泄漏一个 `device_node`。这正是 of_node 引用计数系列里反复出现的「半套模式」毛病：qcom-CCI（`02a4a69667a2`）是「漏 get」，本 commit 是「漏 put」，形态不同、根子都在「没把取/放配平」。

### 为什么 14 年没爆

因为 `device_release()` 不放 `of_node`、`i2c_adapter_dev_release()` 只 complete 一个结构体，b41a216 漏掉的 `of_node_put` 没有任何机制兜底——但开机常驻的 DT 节点引用永不归零，泄漏被「节点常驻」掩盖；配合 overlay / 反复 probe-remove 才会真正阻碍节点回收。所以它和 qcom-CCI 的 of_node 泄漏一样，是「非 overlay 不可见」的静默泄漏，拖了 14 年。

## 意义与影响

- **9fd049 模式再落一地**：本 commit 把 `adap->dev.of_node = of_node_get()` 套到 i2c-pnx——9fd049 立的模式从 cpm/ibm_iic/mpc 三驱动，扩到第四个。那行 **14 年后原样还在 i2c-pnx.c:632**，模式生命力惊人。
- **DT 配置化**：`clock-frequency` 从 DT 取、`timeout` 改 per-instance、宏降级为 `*_DEFAULT`——i2c-pnx 从硬编码/mach-include 驱动转成真正的 DT 驱动，搭上了 ARM DT 化的车。
- **通向自动注册**：本 commit 手动调的 `of_i2c_register_devices(&adap)`，后来由 i2c 核心在 `i2c_register_adapter()` 里自动调，驱动这行被移除——和 9fd049 文里讲的「自动注册」落地一致。
- **imbalance 14 年后补齐**：b41a216 漏的 `of_node_put`，直到 2026 年由 commit `05515d1`（`i2c: pnx: fix device_node refcount leak in i2c_pnx_probe()/i2c_pnx_remove()`，Liu Zhenlong）补齐——给所有 probe 错误路径加 `of_node_put`，并在 remove 里用 `node = adap.dev.of_node` → `i2c_del_adapter` → `of_node_put(node)` 的**快照写法**（和 qcom-CCI 的 `8eacce3`、mtd 的 `56570bd` 同一套），commit message 同样指向 `bd4bc3dbded9`（`i2c_del_adapter()` 末尾 `memset` 清零 `of_node`）这个根因。i2c-pnx 走完了 of_node 的完整 bug→fix 弧：b41a216 加 get、05515d1 补 put。

## 参考

- **v6 patch 线程** [lore.kernel.org/all/1334928849-18079-1-git-send-email-stigge@antcom.de](https://lore.kernel.org/all/1334928849-18079-1-git-send-email-stigge@antcom.de/)（`[PATCH v6] i2c: Add device tree support to i2c-pnx.c`）：本 commit 最终应用的 patch 来路（v2→v6 共 6 版）。
- **模式源头** commit `9fd049927ccb`（`of/i2c: Generalize OF support`，Grant Likely，2010）：b41a216 套用的 `adap->dev.of_node = of_node_get()` + `of_i2c_register_devices(adap)` 模式由它确立，详见[通用化 OF I2C 支持](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support)。

## 相关阅读

- **一次性修复 5 个 i2c 总线驱动的 device_node 引用计数泄漏** —— [Linux series-20260815](/vibe-reading/articles/OS/Linux/Contributions/linux-series-20260815-i2c-ofnode-refcount-leak-series)：b41a216 漏的 put 的后续收口。b41a216 给 pnx 加 `of_node_get` 漏了 put，16 年后该系列的 patch 5/5（`05515d1`）补齐，`Fixes` 指回 b41a216。
- **通用化 OF I2C 支持并确立 adap->dev.of_node 的 of_node_get 模式** —— [Linux commit-9fd049](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support)：本 commit 套用模式的源头。9fd049（2010）在 3 个 i2c 驱动里立下 `adap->dev.of_node = of_node_get()` + `of_i2c_register_devices(adap)`；b41a216 把它搬到 i2c-pnx——但只学了 get、漏了 put，建议与本篇对照看模式的完整与残缺。
- **修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏** —— [Linux commit-8eacce](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak)：同思路的后续修复。b41a216 漏的 of_node_put，14 年后由 `05515d1` 补——用的是 8eacce3（qcom-CCI）那套 cache-before-del 快照写法，根因同是 `i2c_del_adapter()` 的 `memset`（`bd4bc3dbded9`）。
- **I2C 子系统** —— [Linux CodeWiki 7.1 · 13-i2c-subsystem](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/13-i2c-subsystem)：Linux i2c 子系统的 CodeWiki 解读，adapter 注册与 OF 枚举在其中，本 commit 的调用链可对照。
- **驱动模型与基础设施** —— [Linux CodeWiki 7.1 · 12-driver-model](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)：platform driver 的 probe/remove + of_match 框架，i2c-pnx 的 DT 化改动正遵循它。
