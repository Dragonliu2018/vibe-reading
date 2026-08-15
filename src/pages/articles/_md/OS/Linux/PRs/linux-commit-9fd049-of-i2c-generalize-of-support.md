---
title: "通用化 OF I2C 支持并确立 adap->dev.of_node 的 of_node_get 模式"
source:
  project: "Linux"
  type: "commit"
  id: "9fd049"
  url: "https://github.com/torvalds/linux/commit/9fd049927ccba1c1d0343239b82f28c4e07fb95d"
  prType: "feat"
date: "2026-08-16T01:38:39+08:00"
category: ["OS", "Linux", "PRs"]
tags: ["Linux Kernel", "I2C", "Device Tree", "OF", "of_node", "引用计数", "of_i2c", "Grant Likely", "v2.6.36"]
description: "2010 年 Grant Likely 的 of/i2c: Generalize OF support：把 OF_I2C 从 PPC/MICROBLAZE 专用通用化到所有 OF 架构、把 of_register_i2c_devices 改名 of_i2c_register_devices(adap) 读 adap->dev.of_node，并让 3 个 i2c 总线驱动以 adap->dev.of_node = of_node_get(...) 取引用——这套引用计数模式沿用至今，是后来 qcom-CCI of_node 修复的源头。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20100624](https://lore.kernel.org/all/20100624201149.10527.36614.stgit@angua/) · **commit** [9fd049](https://github.com/torvalds/linux/commit/9fd049927ccba1c1d0343239b82f28c4e07fb95d) · **首发版本** v2.6.36-rc1 · **变更行数** +46 行 · **合并时间** 2010-08-05

---

## 背景

2010 年前后，OpenFirmware / device tree（OF）在内核里还是 **PowerPC 和 Microblaze 的专属**：`CONFIG_OF_I2C` 的依赖写死了 `depends on (PPC_OF || MICROBLAZE) && I2C`。但 ARM 等架构正开始全面拥抱 device tree，OF_I2C 这套「从设备树解析 i2c 从设备」的能力需要被通用化、对所有 OF 架构开放。

本 commit（Grant Likely，`of/i2c: Generalize OF support`）一次做三件事：

1. **通用化 Kconfig**：`OF_I2C` 依赖从 `(PPC_OF || MICROBLAZE)` 改成 `OF && !SPARC`——任何使能 OF 的架构都能用（SPARC 例外，它有自己一套 OF 实现）。
2. **改名 + 改签名**：`of_register_i2c_devices(adap, adap_node)` → `of_i2c_register_devices(adap)`，不再由调用方传 `device_node`，而是从 `adap->dev.of_node` 里读。
3. **让 3 个 PowerPC i2c 总线驱动设 `adap->dev.of_node`**：cpm / ibm_iic / mpc 的 probe 里加上 `adap->dev.of_node = of_node_get(...)`，再调新的 `of_i2c_register_devices(adap)`。

第 3 点是这条 commit 最有生命力的部分——它确立了 **`adap->dev.of_node = of_node_get(...)`** 这套 i2c adapter 引用计数模式，至今（2026）仍原样留在同 3 个驱动里，也是后来 qcom-CCI 一连串 of_node 修复的源头。

![of/i2c OF 支持通用化后的注册调用链](/vibe-reading/images/articles/linux-commit-9fd049-of-i2c-generalize-of-support/call-chain.svg)

上图是这套模式跑起来的调用链：总线 probe 从 platform 设备拿到自己的 `device_node` 后，**① 先 `of_node_get` 取引用存进 `adap->dev.of_node`**（绿，本 commit 建立的纪律），② 注册 adapter，③ `of_i2c_register_devices(adap)` 从 `adap->dev.of_node` 读节点、遍历子节点，④ 每个子节点再 `of_node_get` 取引用、交给 `i2c_new_device` 注册成 `i2c_client`。两处绿点都是「存指针前先 get」，是本 commit 立的规矩。

## 前置知识

### OF（OpenFirmware / device tree）与 of_node

OF 是设备树机制：每个节点是一个 `struct device_node`，带 `kref` 引用计数。`of_node_get()` +1、`of_node_put()` −1、归零释放。i2c 控制器节点下面挂的子节点就是总线上的从设备（传感器、eeprom 等）。

### i2c adapter 的注册流程

i2c 总线驱动 probe 时：初始化 `struct i2c_adapter` → `i2c_add_adapter(&adap)` 把 adapter 注册进 i2c 核心 → 然后枚举总线上的从设备、用 `i2c_new_device(adap, &info)` 逐个注册成 `i2c_client`。在 OF 世界里，「枚举从设备」= 遍历 adapter 节点的子节点、解析每个的 `reg`/`compatible`/中断，这正是 `of_i2c_register_devices()` 干的活。

### `adap->dev.of_node` 的归属

`adap` 是个 `struct i2c_adapter`，内嵌一个 `struct device dev`，`dev.of_node` 指向 adapter 对应的 device tree 节点。本 commit 之前，OF_I2C 注册函数 `of_register_i2c_devices(adap, adap_node)` 要调用方**额外把节点指针传进来**；本 commit 改成由 adapter 自己持有（`adap->dev.of_node`），注册函数直接读它——这解耦了 API，也为日后「i2c 核心自动注册 OF 从设备」铺了路（adapter 带着节点，核心就能自己找到子设备）。

## 涉及的函数与调用链

### 函数清单（2010 年时位置 / 当前位置）

| 函数 | 2010 位置 | 当前（2026）位置 | 角色 |
|------|-----------|------|------|
| `of_register_i2c_devices` → `of_i2c_register_devices` | `drivers/of/of_i2c.c`（约 :17） | `drivers/i2c/i2c-core-of.c:84` | 核心：读 `adap->dev.of_node`、遍历子节点、注册 `i2c_client`（改名 + 改签名 + 搬家，函数仍在） |
| `cpm_i2c_probe` | `drivers/i2c/busses/i2c-cpm.c:655` | `i2c-cpm.c:650` | cpm 总线 probe：加 `adap.dev.of_node = of_node_get(...)` + 调新 API |
| `iic_probe` | `i2c-ibm_iic.c:748` | `i2c-ibm_iic.c:732` | IBM IIC probe：同上 |
| `fsl_i2c_probe` | `i2c-mpc.c:603` | `i2c-mpc.c:864` | MPC（Freescale）probe：同上 |
| `i2c_new_device` | i2c 核心 | i2c 核心 | 把一条 `i2c_board_info` 注册成 `i2c_client` |
| `of_modalias_node` / `of_get_property` / `irq_of_parse_and_map` | OF 核心 | OF 核心 | 解析子节点 `compatible`/`reg`/中断 |

> 三行驱动里 `adap->dev.of_node = of_node_get(...)` 那一句，**2010 年加的，至今还在同一批驱动里**（cpm:650、ibm_iic:732、mpc:864）——这套引用计数模式活了 16 年。

### 调用链

```text title="of_i2c_register_devices(adap) 注册从设备的调用链（改动后）"
bus probe (cpm_i2c_probe / iic_probe / fsl_i2c_probe)
  ├─ adap->dev.of_node = of_node_get(node)          # ① adapter 取自己的 of_node 引用
  ├─ i2c_add_adapter(adap)                           # ② 注册 adapter
  └─ of_i2c_register_devices(adap)                   # ③ 读 adap->dev.of_node 遍历子节点
       └─ for_each_child_of_node(adap->dev.of_node, node)
            ├─ of_modalias_node(node, info.type)     #   解析 compatible → 驱动名
            ├─ of_get_property(node, "reg", ...)     #   解析 i2c 地址
            ├─ irq_of_parse_and_map(node, 0)         #   解析中断
            ├─ info.of_node = of_node_get(node)      # ④ 子节点取引用，赋给 i2c_board_info
            └─ i2c_new_device(adap, &info)           #   注册成 i2c_client
```

两处 `of_node_get`：① 是 adapter 自己的节点（驱动 probe 里），④ 是每个从设备子节点（注册函数里）。① 这处就是本 commit 立、沿用至今的模式。

## 实现

### Kconfig：通用化到所有 OF 架构

```diff title="drivers/of/Kconfig (OF_I2C 依赖)"
 config OF_I2C
 	def_tristate I2C
-	depends on (PPC_OF || MICROBLAZE) && I2C
+	depends on OF && !SPARC && I2C
```

把白名单（PPC/MICROBLAZE）换成「有 OF 即可（SPARC 例外）」——ARM 等架构从此能用 OF_I2C。

### of_i2c.c：改名 + 改签名 + 读 adap->dev.of_node

```diff title="drivers/of/of_i2c.c (of_register_i2c_devices → of_i2c_register_devices)"
-void of_register_i2c_devices(struct i2c_adapter *adap,
-			     struct device_node *adap_node)
+void of_i2c_register_devices(struct i2c_adapter *adap)
 {
 	void *result;
 	struct device_node *node;
 
-	for_each_child_of_node(adap_node, node) {
+	/* Only register child devices if the adapter has a node pointer set */
+	if (!adap->dev.of_node)
+		return;
+
+	dev_dbg(&adap->dev, "of_i2c: walking child nodes\n");
+
+	for_each_child_of_node(adap->dev.of_node, node) {
```

三个要点：签名去掉 `adap_node` 参数、改读 `adap->dev.of_node`；加 `if (!adap->dev.of_node) return;` 守卫（adapter 没节点就跳过）；`printk` 换成 `dev_dbg/dev_err`（带 `&adap->dev` 上下文，定位更准）。

### of_i2c.c：子节点取引用 + 失败配平

```diff title="drivers/of/of_i2c.c (子节点注册)"
-		info.of_node = node;
+		info.of_node = of_node_get(node);
 		info.archdata = &dev_ad;
 
 		request_module("%s", info.type);
 
 		result = i2c_new_device(adap, &info);
 		if (result == NULL) {
-			printk(KERN_ERR
-			       "of-i2c: Failed to load driver for %s\n",
-			       info.type);
+			dev_err(&adap->dev, "of_i2c: Failure registering %s\n",
+			        node->full_name);
+			of_node_put(node);
 			irq_dispose_mapping(info.irq);
 			continue;
 		}
-
-		/*
-		 * Get the node to not lose the dev_archdata->of_node.
-		 * Currently there is no way to put it back, as well as no
-		 * of_unregister_i2c_devices() call.
-		 */
-		of_node_get(node);
 	}
 }
-EXPORT_SYMBOL(of_register_i2c_devices);
+EXPORT_SYMBOL(of_i2c_register_devices);
```

旧代码里 `info.of_node = node`（裸指针）+ 末尾一句孤零零的 `of_node_get(node)`（带注释自认「没法 put 回去」）；新代码改成 `info.of_node = of_node_get(node)`（存时即取引用），并在 `i2c_new_device` 失败时 `of_node_put(node)` 配平。从「先存裸指针、后补 get」改成「存时即 get、失败即 put」，引用计数干净了。

### 3 个总线驱动：设 adap->dev.of_node + 调新 API

以 MPC（Freescale）为例，另两个（cpm、ibm_iic）改法对称：

```diff title="drivers/i2c/busses/i2c-mpc.c (fsl_i2c_probe)"
 	i2c->adap.dev.parent = &op->dev;
+	i2c->adap.dev.of_node = of_node_get(op->dev.of_node);
 
 	result = i2c_add_adapter(&i2c->adap);
 	if (result < 0) {
 		dev_err(i2c->dev, "failed to add adapter\n");
 		goto fail_add;
 	}
-	of_register_i2c_devices(&i2c->adap, op->dev.of_node);
+	of_i2c_register_devices(&i2c->adap);
```

cpm、ibm_iic 同样：`adap->dev.of_node = of_node_get(<各自节点>)` + `of_i2c_register_devices(adap)`。这三行 `of_node_get` 就是沿用至今的模式源头。

### of_i2c.h：CONFIG 关守 + 空实现回退

```diff title="include/linux/of_i2c.h"
+#if defined(CONFIG_OF_I2C) || defined(CONFIG_OF_I2C_MODULE)
 #include <linux/i2c.h>
 
-void of_register_i2c_devices(struct i2c_adapter *adap,
-			     struct device_node *adap_node);
+extern void of_i2c_register_devices(struct i2c_adapter *adap);
 
-struct i2c_client *of_find_i2c_device_by_node(struct device_node *node);
+extern struct i2c_client *of_find_i2c_device_by_node(struct device_node *node);
+
+#else
+static inline void of_i2c_register_devices(struct i2c_adapter *adap)
+{
+	return;
+}
+#endif /* CONFIG_OF_I2C */
```

没使能 `CONFIG_OF_I2C` 时，`of_i2c_register_devices(adap)` 退化成空 inline——调用方无需 `#ifdef` 包裹，编译干净通过。

## Review

- 作者 **Grant Likely**（`grant.likely@secretlab.ca`）——彼时 OF / devicetree 子系统维护者，devicetree 规范的核心推动者；由他来通用化 OF_I2C 顺理成章。本 commit 由他自己提交并合并（`Signed-off-by` 即 `Commit`）。
- **patch 经过修订**：v1（2010-06-10）是 `[PATCH 0/2] Rework OF i2c support code`；v2（2010-06-24）扩成 `[PATCH 0/3] Automatically register i2c devices from the device tree`。最终应用的是 v2 的 `[PATCH 1/3]`（Message-ID `20100624201149.10527.36614.stgit@angua`，见 meta 行 patch 链接）。v2 系列标题「Automatically register i2c devices from the device tree」点出了终极目标——让 i2c 核心**自动**注册 OF 从设备。
- 合并路径：经 `Merge branch 'next-devicetree' of git://git.secretlab.ca/git/linux-2.6`（`03c0c29aff7e`，2010-08-05）进 Linus 主线，首见于 v2.6.36-rc1。

## 问题

### 为什么要从「调用方传 node」改成「adapter 自己持有 node」

旧 API `of_register_i2c_devices(adap, adap_node)` 要每个驱动自己把节点指针递进来——驱动得记着「节点从哪来、传给谁」。改成 `adap->dev.of_node` 自己持有后：注册函数只要一个 `adap` 参数、从 adapter 本身就能找到节点；而且因为 adapter 带着节点，**i2c 核心日后可以代劳**注册 OF 从设备（驱动连 `of_i2c_register_devices` 都不用调了）。v2 系列标题「Automatically register i2c devices from the device tree」正是在为这一步铺路——后来 i2c 核心的 `i2c_register_adapter()` 确实自动调了 OF 注册，`of_i2c.c` / `of_i2c.h` 也随之移除、逻辑并入 `drivers/i2c/i2c-core-of.c`。

### 为什么存 of_node 要 `of_node_get`

`adap->dev.of_node` 是个跨作用域持有的指针——probe 里赋值，之后注册函数、运行期都会读。按 device tree 引用计数纪律，存进结构里继续用的指针必须先 `of_node_get` 取自己的引用，否则节点被别人放掉就成了悬空。这套规矩在本 commit 里被确立给 i2c adapter 驱动，是后来一切 qcom-CCI of_node 修复的基准线。

## 意义与影响

这条 2010 年的 commit 影响深远：

- **确立 `adap->dev.of_node = of_node_get(...)` 模式**：3 个 PowerPC i2c 驱动当年加的那行，**16 年后（2026）原样还在**（cpm:650、ibm_iic:732、mpc:864）。它成了 i2c adapter 驱动持有 OF 节点的标准写法。
- **`of_i2c_register_devices(adap)` API 沿用**：函数存活至今，只是从 `drivers/of/of_i2c.c` 搬到了 `drivers/i2c/i2c-core-of.c:84`，仍读 `adap->dev.of_node`——本 commit 的设计被完整保留。
- **通向自动注册**：v2 系列标题「Automatically register i2c devices from the device tree」的目标，后来由 i2c 核心在 `i2c_register_adapter()` 里自动调 OF 注册实现——驱动不再需要手动调 `of_i2c_register_devices`。本 commit 是这条路上的关键一步：先让 adapter 持有节点，核心才有可能代劳。
- **后续 of_node 修复的源头**：这套 `adap->dev.of_node = of_node_get()` 模式立下后，新加的 i2c adapter 驱动理应照做。Qualcomm CCI 驱动（`i2c-qcom-cci.c`，2019 年由 `e517526195de` 引入）却**没照做**——probe 里存的是裸 `child` 指针、漏了 `of_node_get`。`02a4a69667a2`（2022）补上 `of_node_get` 把它拉回本 commit 的模式；`8eacce3`（2026）再修同一处的 `of_node_put` 顺序（放在 `i2c_del_adapter()` 之后会因后者的 `memset` 失效）。三条 qcom-CCI 修复，本质上都是把偏离了本 commit 模式的代码拉回来。

## 参考

- **v2 系列 cover letter** [lore.kernel.org/all/20100624200509.10527.513.stgit@angua](https://lore.kernel.org/all/20100624200509.10527.513.stgit@angua/)（`[PATCH 0/3] Automatically register i2c devices from the device tree`）：本 commit 所属 patch 系列的来路，标题点出「自动注册」的终极目标。
- **当前归宿** `drivers/i2c/i2c-core-of.c`（`of_i2c_register_devices`，:84）：本 commit 的函数后来从 `drivers/of/of_i2c.c` 搬到此处、并入 i2c 核心，是「自动注册」落地的证据。

## 相关阅读

- **为 i2c-pnx 添加 device tree 支持并套用 adap->dev.of_node 的 of_node_get 模式** —— [Linux commit-b41a216](/vibe-reading/articles/OS/Linux/PRs/linux-commit-b41a216-of-i2c-pnx-dt-support)：本 commit 模式的早期采用者（2012）。b41a216 把 9fd049 的 `of_node_get` 套到 i2c-pnx，但只学了 get、漏了配对的 put，14 年后由 `05515d1` 补——对照可见模式的完整与残缺。
- **为 Qualcomm CCI 驱动补齐 device tree 节点的引用计数** —— [Linux commit-02a4a6](/vibe-reading/articles/OS/Linux/PRs/linux-commit-02a4a6-qcom-cci-of-node-refcount)：本 commit 模式的后续应用。qcom-CCI 驱动 2019 年引入时漏了 `of_node_get`，2022 年由 02a4a6 补回——正是把代码拉回本 commit 立下的 `adap->dev.of_node = of_node_get()` 模式，建议与本篇对照阅读。
- **修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏** —— [Linux commit-8eacce](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak)：同一 qcom-CCI of_node 链路的后续修复。02a4a6 补了 `of_node_get`，但 `of_node_put` 放在 `i2c_del_adapter()` 之后、被其内部 `memset` 清零而失效；8eacce 用快照指针修好。
- **I2C 子系统** —— [Linux CodeWiki 7.1 · 13-i2c-subsystem](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/13-i2c-subsystem)：Linux i2c 子系统的 CodeWiki 解读，覆盖 adapter 注册、OF 从设备枚举等，本 commit 的调用链正处其中。
- **驱动模型与基础设施** —— [Linux CodeWiki 7.1 · 12-driver-model](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)：platform driver 的 probe/remove 框架，3 个总线驱动的 probe 改动正遵循它。
