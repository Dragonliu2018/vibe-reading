---
title: "修复 del_mtd_device 清零顺序引发的 of_node 引用泄漏"
source:
  project: "Linux"
  type: "commit"
  id: "56570b"
  url: "https://github.com/torvalds/linux/commit/56570bdad5e31c5c538cd6efff5c4510256e1bb4"
  prType: "fix"
date: "2026-08-15T18:09:07+08:00"
category: ["OS", "Linux", "PRs"]
tags: ["Linux Kernel", "MTD", "Device Tree", "of_node", "引用计数", "Memory Leak", "Use-After-Clear", "DT Overlay", "configfs"]
description: "解读 Linux MTD 核心的一次 of_node 引用泄漏修复：del_mtd_device 先 memset 清零 mtd->dev，再 of_node_put(mtd_get_of_node(mtd))，读到的是 NULL 空指针，put 变空操作导致引用泄漏。修复是在清零前快照指针。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20221119](https://lore.kernel.org/linux-mtd/20221119063915.11108-1-shangxiaojing@huawei.com/) · **commit** [56570b](https://github.com/torvalds/linux/commit/56570bdad5e31c5c538cd6efff5c4510256e1bb4) · **首发版本** v6.2-rc1 · **变更行数** +3 行 · **合并时间** 2022-12-13

---

## 背景

`drivers/mtd/mtdcore.c` 是 Linux MTD（Memory Technology Devices）子系统的核心，`del_mtd_device()` 负责从 MTD 设备表中摘除一个设备。它的清理流程里有这么两行紧挨着的操作：

```c title="drivers/mtd/mtdcore.c (改动前，del_mtd_device 的 else 分支)"
 		memset(&mtd->dev, 0, sizeof(mtd->dev));   // 把 mtd->dev 整个清零
 		idr_remove(&mtd_idr, mtd->index);
 		of_node_put(mtd_get_of_node(mtd));          // 放掉 device tree 节点引用
```

问题在于顺序：`memset` 把 `mtd->dev` 整块清成 0，**包括 `mtd->dev.of_node`**；紧接着的 `of_node_put(mtd_get_of_node(mtd))` 去读 `mtd_get_of_node(mtd)`，而它返回的正是刚被清零的 `mtd->dev.of_node`——也就是 `NULL`。`of_node_put(NULL)` 是个空操作，于是注册时为这个 of_node 取的那份引用**永远放不回去**，造成引用计数泄漏。

commit message 正是按这条执行流定位「放不掉」的：

```text title="del_mtd_device 执行流（改动前）"
del_mtd_device()
    memset(&mtd->dev, 0, sizeof(mtd->dev))   # 把 mtd->dev 整块清零（含 of_node）
    of_node_put()
        mtd_get_of_node(mtd)                 # 读 mtd->dev.of_node，已被清成 NULL
                                             # of_node_put(NULL) 是空操作，引用放不掉
```

这个泄漏并非靠崩溃暴露，而是被 device tree 的引用计数校验器在**销毁 overlay 时**抓到——commit message 里附了现场报错：

```text title="内核 OF 引用计数校验器的报错"
OF: ERROR: memory leak, expected refcount 1 instead of 2,
of_node_get()/of_node_put() unbalanced - destroy cset entry: attach
overlay node /spi/spi-sram@0
...
    cfs_overlay_release+0x30/0x90
    configfs_rmdir+0x3bd/0x540
    vfs_rmdir+0x198/0x330
```

也就是说：用户态 `rmdir` 一个 configfs 上的 device tree overlay（这里是一个挂在 `/spi` 下的 `spi-sram@0` overlay 节点）时，OF 核心发现该节点的引用计数是 2、本该是 1——多出来的那一份，正是 `del_mtd_device()` 里放不掉的引用。

`Fixes: 00596576a051`（"mtd: core: clear out unregistered devices a bit more"，作者 Zev Weiss）正是引入这个 `memset` 的 commit：它为了「让 mtd 之后能安全地重新注册」而在 `device_unregister()` 和 `of_node_put()` 之间插入了清零，却不慎把后者的读取目标也一起清掉了。本 commit 修的就是这个顺序错配。

![del_mtd_device() 的 of_node：清零顺序 bug 与快照修复](/vibe-reading/images/articles/linux-commit-56570b-mtd-del-device-of-node-refcount/del-mtd-device-ordering.svg)

上图把改动前后的执行流左右对照：改动前（红）先 `memset` 清零 `mtd->dev`（连 `of_node` 一起抹），再 `of_node_put(mtd_get_of_node(mtd))` 读到的已是 `NULL`，放引用变空操作、引用泄漏；改动后（绿）一进 else 分支就快照 `mtd_of_node`，清零之后 `of_node_put(mtd_of_node)` 用的仍是有效快照，引用配平。关键差别全在「清零之前有没有把指针存下来」。

## 前置知识

要看懂这个 bug，得先弄清 `mtd_get_of_node()` 到底返回什么、以及 `of_node_put(NULL)` 为什么「静默」。

**`mtd_get_of_node()` 读的就是 `mtd->dev.of_node`。** 它是个 inline 包装：

```c title="include/linux/mtd/mtd.h (mtd_get_of_node)"
 static inline struct device_node *mtd_get_of_node(struct mtd_info *mtd)
 {
 	return dev_of_node(&mtd->dev);
 }
```

而 `dev_of_node()` 直接返回 `dev->of_node`：

```c title="include/linux/device.h (dev_of_node)"
 static inline struct device_node *dev_of_node(struct device *dev)
 {
 	return dev->of_node;
 }
```

所以 `mtd_get_of_node(mtd)` ≡ `mtd->dev.of_node`。一旦 `memset(&mtd->dev, 0, ...)` 跑过，这个值就是 `NULL`。

**`of_node_put(NULL)` 是空操作。** `of_node_put()` 内部对 `NULL` 有保护，直接返回、不做任何事——既不报错也不告警。这正是这个 bug「静默」的根源：放引用那行代码照常执行、没崩没报错，只是悄悄什么都没放。要等 device tree 的引用计数校验器在销毁 overlay changeset 时比对「期望 refcount vs 实际 refcount」才会打印出背景里那段 `expected refcount 1 instead of 2`。

**`memset` 的本意是清场，但它清得「不分青红皂白」。** `00596576a051` 加这行清零，是为了让摘除后的 `mtd` 之后能被重新注册（清掉残留状态）；但它把 `mtd->dev` 整块抹零，连后面 `of_node_put` 还要读的 `of_node` 一起抹了。这是典型的「use-after-clear」——不是 use-after-free（内存还在），而是「先把字段清零、再用它」的顺序错配。

## 实现

修复只有 3 行新增、1 行改动，思路一句话：**在清零之前把指针快照下来，放引用时用快照。**

### 声明一个局部变量存快照

```c title="drivers/mtd/mtdcore.c (del_mtd_device, 声明)"
 int del_mtd_device(struct mtd_info *mtd)
 {
 	int ret;
 	struct mtd_notifier *not;
+	struct device_node *mtd_of_node;
```

### 一进 else 分支就快照

在 `else`（设备确实要被摘除）的入口、**所有清理动作之前**就把 `of_node` 指针取出来存好：

```c title="drivers/mtd/mtdcore.c (del_mtd_device, else 块入口快照)"
 	} else {
+		mtd_of_node = mtd_get_of_node(mtd);
 		debugfs_remove_recursive(mtd->dbg.dfs_dir);
 
 		/* Try to remove the NVMEM provider */
```

注意快照取在 `debugfs_remove`、`nvmem_unregister`、`device_unregister` 和 `memset` **之前**——这些都是 else 分支里紧跟其后的步骤。把快照放在最前面，意味着后面无论哪个步骤动了 `mtd->dev`，都不影响手里这份缓存指针。

### 清零之后用快照放引用

```c title="drivers/mtd/mtdcore.c (del_mtd_device, memset 之后用快照)"
 		memset(&mtd->dev, 0, sizeof(mtd->dev));
 
 		idr_remove(&mtd_idr, mtd->index);
-		of_node_put(mtd_get_of_node(mtd));
+		of_node_put(mtd_of_node);
```

`of_node_put` 现在拿到的是清零之前快照下来的真实 `device_node *`，引用计数 −1 正常归还，配平完成。`memset` 依旧会清掉 `mtd->dev.of_node`，但这已经无关紧要——再没人去读它了。

修复的精妙在于它没有去改 `memset` 的行为（清零本身的初衷是合理的），只是把「要放的那个指针」提前一份取出来，绕开了顺序陷阱。

## Review

- **作者 Shang XiaoJing（华为）**：发现问题并提交修复，commit message 里直接附了内核报错与调用链，定位清晰。
- **提交者 Miquel Raynal（Bootlin）**：MTD 子系统维护者。commit log 里有一行 `[<miquel.raynal@bootlin.com>: Light reword of the commit log]`，说明 Miquel 在收编时对日志做了轻度润色再以自己的 `Signed-off-by` 收口——这是子系统维护者收 patch 的常见做法。
- **`Fixes: 00596576a051`**：指向引入 `memset` 的那个 commit，会被 stable 机器人自动抓取回溯到各 LTS 内核。
- **Link**：`lore.kernel.org/linux-mtd/20221119063915.11108-1-shangxiaojing@huawei.com`，即内核邮件列表上的原始 patch 线程。

和大多数内核引用计数修复一样，这条改动没有「运行时测试」可言——它的验证靠的是静态审查 + 报错现场的可复现性 + `Fixes` 回溯。

## 问题

### 为什么只在 overlay 场景才暴露

绝大多数 MTD 设备的 `of_node` 来自开机时扁平化的设备树，这些节点常驻、引用计数永不归零，多挂一份引用也「看不出来」。真正触发报错的，是**动态 device tree overlay**：当 overlay 创建的 MTD 设备被摘除、overlay 又被 `rmdir` 销毁时，OF 核心要回收 overlay 节点，却发现它的引用计数比期望多 1（`expected refcount 1 instead of 2`），于是校验器打印 `of_node_get()/of_node_put() unbalanced` 并拒绝正常回收。

commit message 里那个 `/spi/spi-sram@0` overlay 节点正是一例：它经 configfs overlay 加到 `/spi` 下，对应一个 MTD 设备；`del_mtd_device()` 摘设备时漏放的那份引用，在 `cfs_overlay_release`（configfs `rmdir` 触发的 overlay 释放路径）里被校验器逮个正着。

### 为什么这个 bug 难以察觉

因为 `of_node_put(NULL)` **静默成功**了。代码这行照常执行、没崩没告警，`del_mtd_device()` 也正常返回 0——只有在 overlay 销毁这条特定路径上，device tree 的引用计数校验器才会比对出「期望 1、实际 2」并打印报错。开机常驻型 MTD 设备则连这条校验都触发不了，泄漏被节点常驻的事实彻底掩盖。所以这是一个「非 overlay 不可见」的静默泄漏。

## 意义与影响

这是一次典型的**顺序性引用泄漏**修复，价值在于点出一条容易被忽视的纪律：

- **清零之前先快照要复用的字段。** `memset(结构, 0)` 是无条件抹零整块内存，它不区分「该清的状态」和「后面还要用的指针」。任何在清零之后才去读该结构字段取指针的代码，都会踩进同一个坑。正确做法是像本修复这样，在清零前把需要的指针快照到局部变量。
- **`of_node_put(NULL)` 的静默是双刃剑。** 它让驱动代码不必处处判空，但也让「放错对象」这类 bug 不崩、不报，只能靠 device tree 引用计数校验器在 overlay 销毁时被动抓取。开发动态 overlay 相关驱动时，开启该校验器、主动 `rmdir` overlay 做回归，是发现这类泄漏的有效手段。
- **与 qcom-cci 修复互为镜像。** 同样是 of_node 引用计数，qcom-cci 是「存指针时漏 `of_node_get`」（指针悬空），本篇是「放引用时读的是已清零指针」（put 打空）。一个缺取、一个漏放，都只在 overlay 场景暴露、都靠 OF 校验器抓出——两条合在一起，正好勾出 of_node 引用计数「取在存时、放在拆时、且别让中间步骤毁掉指针」的完整纪律。

## 参考

- **内核邮件列表原始 patch 线程**：[lore.kernel.org/linux-mtd/20221119063915.11108-1-shangxiaojing@huawei.com](https://lore.kernel.org/linux-mtd/20221119063915.11108-1-shangxiaojing@huawei.com)，即本 commit 的来路，含作者原始描述与报错现场。
- **引入 bug 的 commit** [`00596576a051`](https://github.com/torvalds/linux/commit/00596576a051)（"mtd: core: clear out unregistered devices a bit more"，Zev Weiss）：被本 commit 的 `Fixes:` 指向的源头，它在 `of_node_put` 前插入了那行清零，埋下了顺序陷阱。

## 相关阅读

- **修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏** —— [Linux commit-169515](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-169515-qcom-cci-del-adapter-of-node-leak)：同思路的后续落地。本篇是 mtd 自己的 `memset` 在 put 前清零 `of_node`，169515 是 `i2c_del_adapter()` 内部的 `memset` 干同样的事、用同一套快照写法修复——三条合起来是 of_node 引用计数的三部曲。
- **为 Qualcomm CCI 驱动补齐 device tree 节点的引用计数** —— [Linux commit-02a4a6](/vibe-reading/articles/OS/Linux/PRs/linux-commit-02a4a6-qcom-cci-of-node-refcount)：同主题的另一条落地线。qcom-cci 是「存指针漏 get」、本篇是「放引用打在已清零指针上」，两条对照可看清 of_node 引用计数的完整面貌。
- **驱动模型与基础设施** —— [Linux CodeWiki 7.1 · 12-driver-model](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)：讲解 platform/driver 的注册与卸载模型，`del_mtd_device` 这类设备摘除路径正处在该框架内，可对照理解清理步骤的编排。
- **Linux之父都"不明觉赞"的一个内核优化与修复历程** —— [tencentos-linux-xarray-fix](/vibe-reading/articles/tencentos-official-linux-xarray-page-cache-fix)：另一则内核 race/一致性修复，对照可见「引用计数与数据结构一致性」问题在内核各子系统的共通形态。
