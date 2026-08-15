---
title: "为 Qualcomm CCI 驱动补齐 device tree 节点的引用计数"
source:
  project: "Linux"
  type: "commit"
  id: "02a4a6"
  url: "https://github.com/torvalds/linux/commit/02a4a69667a2ad32f3b52ca906f19628fbdd8a01"
  prType: "fix"
date: "2026-08-15T17:33:47+08:00"
category: ["OS", "Linux", "PRs"]
tags: ["Linux Kernel", "I2C", "Device Tree", "of_node", "引用计数", "Race Condition", "Qualcomm CCI", "Use-After-Free"]
description: "解读 Linux qcom-cci I2C 驱动的一次 device tree 节点引用计数修复：存储 child 指针时未 of_node_get，循环释放后 adapter 持有悬空指针，修复后在所有拆除路径补齐 get/put 配平引用。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20220203](https://lore.kernel.org/linux-i2c/20220203164703.1712006-1-vladimir.zapolskiy@linaro.org/) · **commit** [02a4a6](https://github.com/torvalds/linux/commit/02a4a69667a2ad32f3b52ca906f19628fbdd8a01) · **首发版本** v5.17-rc5 · **变更行数** +10 行 · **合并时间** 2022-02-20

---

## 背景

`drivers/i2c/busses/i2c-qcom-cci.c` 是高通 SoC 上的 **Qualcomm CCI（Camera Control Interface）I2C 驱动**。CCI 是相机子系统里用来和图像传感器等外设通信的 I2C 控制器，一台 SoC 上最多挂两个 master（`NUM_MASTERS = 2`）。该驱动由 commit `e517526195de`（"i2c: Add Qualcomm CCI I2C driver"）引入，本 commit 正是为它打的一个补丁（`Fixes: e517526195de`）。它以 `[PATCH 4/9]` 提交到 linux-i2c 邮件列表，出自 Vladimir Zapolskiy 的系列「i2c: qcom-cci: fixes and updates」。

驱动的 `cci_probe()` 会遍历 CCI 节点在 device tree 里的子节点（每个子节点描述一条 i2c-bus），为每条总线初始化一个 `i2c_adapter`，并把子节点的 `device_node *` 指针直接存进 adapter 的设备里：

```c title="drivers/i2c/busses/i2c-qcom-cci.c (改动前，探测循环内)"
for_each_available_child_of_node(dev->of_node, child) {
    ...
    cci->master[idx].adap.dev.of_node = child;   // 只存指针，没取引用
    ...
}
```

问题在于：`for_each_available_child_of_node` 这个宏在**迭代期间**才持有 `child` 的引用，循环一结束（或每次前进到下一个子节点时），上一份引用就被 `of_node_put()` 放掉了。而上面这行只把裸指针塞进了 `adap.dev.of_node`，并没有为自己额外取一份引用。于是循环跑完之后，adapter 持有的是一个**它不拥有引用的指针**——一旦这个 device tree 节点的引用计数归零被释放，`i2c_add_adapter()` 及其后续运行期再去访问 `adap.dev.of_node` 就是 use-after-free。

commit message 把它定性为一次小概率竞态：

> There is a minor chance for a race, if a pointer to an i2c-bus subnode is stored and then reused after releasing its reference, and it would be sufficient to get one more reference under a loop over children subnodes.

修复思路正是 message 末尾那句——在遍历子节点的循环里**多取一份引用**（`of_node_get`），再在所有释放路径上配平（`of_node_put`）。改动虽只有 +10/-4 行、单文件，但牵涉的是内核里一条很基础、也最容易写错的规则。

![of_node 引用生命周期：改动前 vs 改动后](/vibe-reading/images/articles/linux-commit-02a4a6-qcom-cci-of-node-refcount/of-node-lifecycle.svg)

上图把一条 i2c-bus 子节点的 `of_node` 引用拆成四个阶段，左右对照改动前后。改动前（红）在「存储」处没有 `of_node_get`，循环一结束指针就悬空，拆除时也只 `i2c_del_adapter` 不 `of_node_put`——既悬空又没配平。改动后（绿）在「存储」处取 +1 自己持有，在 `i2c_add_adapter` 失败、`error_i2c` 回退、`cci_remove` 卸载三条路径上都补了 `of_node_put`，引用完整配平。

## 前置知识

要真正看懂这个修复，得先理清 device tree 节点的引用计数语义——这也是这类 bug 屡见不鲜的根因。

**`struct device_node` 内部带一个 `kref` 引用计数。** `of_node_get()` 让计数 +1，`of_node_put()` 让计数 −1，归零时释放节点。任何「把 `device_node *` 存起来、跨出当前作用域继续用」的代码，都必须确保自己持有一份引用，并在用完时归还。

**`for_each_available_child_of_node` 宏的引用语义是关键。** 它展开后是一个基于 `of_get_next_available_child()` 的 for 循环：

```c title="include/linux/of.h (宏展开)"
#define for_each_available_child_of_node(parent, child) \
	for (child = of_get_next_available_child(parent, NULL); child != NULL; \
	     child = of_get_next_available_child(parent, child))
```

而 `of_get_next_available_child()` 最终落到 `of_get_next_status_child()`，它的实现决定了「循环结束时引用去哪了」：

```c title="drivers/of/base.c (of_get_next_status_child, 简化)"
 	next = prev ? prev->sibling : node->child;
 	for (; next; next = next->sibling) {
 		if (!checker(next))
 			continue;
 		if (of_node_get(next))      // 找到下一个可用子节点：取引用 +1
 			break;
 	}
 	of_node_put(prev);             // 无条件放掉上一份——哪怕没找到下一个（循环到此结束）
 	return next;                   // 没有下一个时返回 NULL
```

注意最后那行 `of_node_put(prev)` 是**无条件执行**的：宏每前进到下一个子节点，都会放掉上一个；当没有下一个子节点、返回 `NULL` 让循环结束时，它也会放掉最后一个 `child`。所以——

> **离开 `for_each_available_child_of_node` 循环后，循环给的那个 `child` 引用已经还回去了。循环体里若把 `child` 存到别处继续用，必须再 `of_node_get()` 取一份自己的，并在不用时 `of_node_put()` 归还。**

这就是内核里 device tree 节点的「借用 vs 持有」铁律。本 commit 修复前的代码恰恰把循环「借用」的指针当成了「持有」的指针存起来。

**i2c 核心并不替你管 `adap->dev.of_node`。** `i2c_add_adapter()` → `i2c_register_adapter()` 一路注册 adapter 设备时，对 `adap->dev.of_node` 只读不持有：它调用 `of_alias_get_id(dev->of_node, "i2c")` 取别名编号、`of_i2c_register_devices(adap)` 枚举总线下的从设备，但全程不 `of_node_get()`、注册完也不 `of_node_put()`。换言之，谁把 `adap.dev.of_node` 赋值的，引用生命周期就归谁管——这里就是 qcom-cci 驱动自己。这也解释了为什么修复必须在驱动里补 `of_node_put`，而不会和 i2c 核心产生 double-free。

## 实现

修复遵循的是一条对称的模式：**存的时候 `of_node_get()` 取一份自己的引用，在每一条释放路径上都 `of_node_put()` 归还。** 改动落在 `cci_probe()` 的三处和 `cci_remove()` 的一处，共四个 hunk。

### 存储时取引用

在探测循环里把裸赋值换成 `of_node_get()`，让 adapter 从「借用」升级为「持有」：

```c title="drivers/i2c/busses/i2c-qcom-cci.c (cci_probe, 探测循环内)"
-		cci->master[idx].adap.dev.of_node = child;
+		cci->master[idx].adap.dev.of_node = of_node_get(child);
```

这一行是整个修复的「源头」：往后 adapter 自己持有一份引用，循环结束时宏放掉的那份就不再影响它。

### 注册失败路径补 put

`i2c_add_adapter()` 失败时，刚拿到引用的这个 master 还没正式登记进 i2c 核心，所以直接 `of_node_put` 归还，再跳到 `error_i2c` 清理**已经成功注册**的那些：

```c title="drivers/i2c/busses/i2c-qcom-cci.c (cci_probe, 注册失败)"
 		ret = i2c_add_adapter(&cci->master[i].adap);
-		if (ret < 0)
+		if (ret < 0) {
+			of_node_put(cci->master[i].adap.dev.of_node);
 			goto error_i2c;
+		}
```

### 回退路径补 put

`error_i2c` 从 `--i`（即失败下标的前一个）往下回退，对每个**已成功注册**的 master 既 `i2c_del_adapter` 摘除 adapter、又 `of_node_put` 归还引用：

```c title="drivers/i2c/busses/i2c-qcom-cci.c (cci_probe, error_i2c 回退)"
 error_i2c:
 	for (--i ; i >= 0; i--) {
-		if (cci->master[i].cci)
+		if (cci->master[i].cci) {
 			i2c_del_adapter(&cci->master[i].adap);
+			of_node_put(cci->master[i].adap.dev.of_node);
+		}
 	}
```

### 卸载路径补 put

正常卸载的 `cci_remove()` 同样对每个有效 master 配齐 `del_adapter` + `of_node_put`：

```c title="drivers/i2c/busses/i2c-qcom-cci.c (cci_remove)"
 	for (i = 0; i < cci->data->num_masters; i++) {
-		if (cci->master[i].cci)
+		if (cci->master[i].cci) {
 			i2c_del_adapter(&cci->master[i].adap);
+			of_node_put(cci->master[i].adap.dev.of_node);
+		}
 		cci_halt(cci, i);
 	}
```

### 完整性核对

探测循环里每为一个有效 master 取一次 `of_node_get`（+1），就必须在某个释放路径上对应还一次（−1）。下表把「取」与「还」对齐：

| 取引用（`of_node_get`，探测循环内） | 对应放引用（`of_node_put`）的路径 | 配平 |
|---|---|---|
| 每个 `cci->master[i].cci` 被置位的 master 各 +1 | `i2c_add_adapter` 失败：**正在注册**的那个立即 put | ✅ |
| | `error_i2c` 回退：**已成功注册**的 0..i−1 各 put | ✅ |
| | `cci_remove` 卸载：**成功探测后**全部 master 各 put | ✅ |

三处 `put` 覆盖了 adapter 的全部生命周期出口：注册失败的那一个、回退已成功的若干、正常卸载的全部。而「取」只发生在探测循环一处、对每个有效 master 各一次，计数上严格对称。`of_node_get` 与 `of_node_put` 的判定都挂在 `cci->master[i].cci` 是否非空上——这正是探测循环里同时被置位的标志位，保证了「取与还」作用在完全相同的 master 集合上。

## Review

这个补丁的评审链路恰好覆盖了三个该有的角色：

- **Reviewed-by: Robert Foss** —— 高通显示/相机子系统贡献者；
- **Reviewed-by: Bjorn Andersson** —— 高通 SoC 平台维护者（`drivers/soc/qcom` 等）；
- **Signed-off-by: Wolfram Sang** —— i2c 子系统维护者，也是本 commit 的提交者（committer）。

i2c 子系统的改动最终都要经 Wolfram Sang 的树收口；原始 CCI 驱动（`e517526195de`）由 Loic Poulain 编写，本次修复由 Vladimir Zapolskiy 提交。两位 Reviewed-by 来自高通侧、一位 Signed-off-by 来自 i2c 侧，对一条「驱动里 device tree 引用计数」的修复来说，审查方阵是齐全的。

值得注意的还有 `Fixes:` 标签。带 `Fixes:` 的 commit 会被稳定版（stable）机器人自动抓取回溯到各 LTS 分支，因此这个 2022 年 2 月进 v5.17-rc5 的小修复，会随 stable 流程出现在 5.10/5.15 等长期支持内核里——这也是内核里这类引用计数修复的典型验证路径：它几乎没有「运行时测试」可写，靠的就是静态审查 + `Fixes` 回溯让尽量多的内核版本受益。

## 问题

### 为什么 commit message 说「a minor chance for a race」

因为绝大多数 qcom-cci 设备的 device tree 节点是**开机时由扁平化设备树（unflattened DT）建立的**，这些节点自带一份基准引用计数、在内核生命周期内不会被释放。即使 adapter 持有的是个「不拥有引用的悬空指针」，由于节点常驻，实际也访问得到——所以日常运行几乎不出事，才叫 "minor chance"。

真正会触发的场景是 **device tree overlay（动态 DT）**：相机模组经 overlay 热插拔时，对应子节点是动态建/拆的，引用计数会真实归零。若此时 adapter 还攥着没有自己引用的指针，overlay 移除节点后即触发 use-after-free。本修复让 adapter 在 overlay 场景下也持有有效引用，堵上的就是这个口子。

### 一处可进一步收紧的地方

严格而言，探测循环里取的 `of_node_get`，在**循环之后、`i2c_add_adapter` 之前**的若干早退路径上没有对应的 `of_node_put`：`devm_platform_get_and_ioremap_resource()` 失败（`return`）、`devm_clk_bulk_get_all()` / `cci_enable_clocks()` 失败（`return`）、`platform_get_irq()` / `devm_request_irq()` / `cci_reset()` 失败（`goto disable_clocks`）都发生在取引用之后、注册 adapter 之前，这些路径上 get 过的 of_node 都没还。

影响范围有限：其一，`NUM_MASTERS = 2`，最多两个节点；其二，对开机常驻的基准 DT 节点，多挂一份引用计数纯属「软泄漏」，节点本就不会被释放、无实际后果；只有 overlay 型 CCI 在「探测中途失败」这个组合下，才会真正阻碍 overlay 节点回收。本 commit 的范围是 adapter 使用期的那条竞态，早退路径的引用配平不在它目标内，至今仍是该驱动一个可收紧的边角。

## 意义与影响

这是一次教科书式的「**存指针先 get、释放路径全 put**」修复，价值不在行数，而在把一个潜伏的悬空引用收口：

- **堵住 use-after-free 的触发面**：对 overlay 型 CCI，adapter 的 `of_node` 指针从此全程有效，不再依赖「节点恰好常驻」这一隐性前提。
- **明确引用归属**：`adap.dev.of_node` 由谁赋值、引用就由谁管。i2c 核心只读不持有，驱动必须自管——这次修复让 qcom-cci 与这条约定对齐。
- **更普适的教训**：`for_each_available_child_of_node` 是内核里「最容易踩坑的遍历宏」之一。只要循环体里把 `child` 存到任何跨作用域的结构里（adapter、私有数据、链表……），都得配上一对 `of_node_get`/`of_node_put`。这条规则同样适用于 `for_each_child_of_node`、`for_each_available_child_of_node_scoped` 等同类宏——`_scoped` 变体用 `__free(device_node)` 自动管理循环内的引用，能从语法上避免这类遗漏，是新代码更推荐的形式。

> **后续**：本 commit 把 `of_node_put` 放在 `i2c_del_adapter()` 之后，而 `i2c_del_adapter()` 末尾会 `memset` 清零 `adap->dev`、令 put 读到 `NULL` 变空操作、泄漏引用。commit `8eacce` 用「先快照指针再 del_adapter」修复了这一顺序问题，详见[修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak)。

## 参考

- **Qualcomm CCI I2C device tree binding**：`Documentation/devicetree/bindings/i2c/qcom,i2c-cci.yaml`，定义了 CCI 节点及其 i2c-bus 子节点的 `reg`、`clock-frequency` 等属性——即本修复中遍历与赋值的对象。
- **原始驱动 commit** [`e517526195de`](https://github.com/torvalds/linux/commit/e517526195de)（"i2c: Add Qualcomm CCI I2C driver"）：被本 commit 的 `Fixes:` 指向的源头，引入了这段未配平的 of_node 赋值逻辑。

## 相关阅读

- **通用化 OF I2C 支持并确立 adap->dev.of_node 的 of_node_get 模式** —— [Linux commit-9fd049](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support)：本篇 of_node_get 模式的源头。2010 年 Grant Likely 在 3 个 i2c 总线驱动里确立 `adap->dev.of_node = of_node_get()`、沿用至今；qcom-CCI 引入时漏了这步，本篇（02a4a6）补回——正是把代码拉回 9fd049 立下的模式。
- **修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏** —— [Linux commit-8eacce](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak)：本 commit 的后续修复。本篇把 `of_node_put` 放在 `i2c_del_adapter()` 之后，而后者末尾 `memset` 会清零 `of_node`、使 put 失效；8eacce 用快照指针修好了。
- **修复 del_mtd_device 清零顺序引发的 of_node 引用泄漏** —— [Linux commit-56570b](/vibe-reading/articles/OS/Linux/PRs/linux-commit-56570b-mtd-del-device-of-node-refcount)：同主题的另一条落地线。本篇是「存指针漏 get」、彼篇是「放引用打在已清零指针上」，两条对照可看清 of_node 引用计数的完整面貌。
- **驱动模型与基础设施** —— [Linux CodeWiki 7.1 · 12-driver-model](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)：同属 Linux 内核专题，讲解 platform driver 的探测/卸载模型，正是 `cci_probe`/`cci_remove` 所遵循的框架，可对照理解本修复里的回退与卸载路径为何这么组织。
- **Linux之父都"不明觉赞"的一个内核优化与修复历程** —— [tencentos-linux-xarray-fix](/vibe-reading/articles/tencentos-official-linux-xarray-page-cache-fix)：同样是内核里的一次 race condition 修复，对照阅读可看到「引用/锁与数据结构一致性」这类问题在内核不同子系统里的共通形态。
