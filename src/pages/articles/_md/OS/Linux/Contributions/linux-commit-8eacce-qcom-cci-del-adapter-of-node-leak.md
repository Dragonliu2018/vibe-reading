---
title: "修复 qcom-CCI 中 i2c_del_adapter 清零 of_node 引发的引用泄漏"
source:
  project: "Linux"
  type: "commit"
  id: "8eacce"
  url: "https://lore.kernel.org/linux-i2c/20260815140931.53297-1-dragonliu2018@gmail.com/"
  prType: "fix"
date: "2026-08-16T01:11:22+08:00"
category: ["OS", "Linux", "Contributions"]
tags: ["Linux Kernel", "I2C", "Qualcomm CCI", "Device Tree", "of_node", "引用计数", "Memory Leak", "i2c_del_adapter", "Contributions"]
description: "qcom-CCI 的 cci_probe/cci_remove 把 of_node_put 放在 i2c_del_adapter() 之后，但 i2c_del_adapter 末尾会 memset 清零 adap->dev、连带把 of_node 清成 NULL，使 put 变空操作、引用泄漏。修复是在调 i2c_del_adapter 前快照 of_node 指针，同 i2c-mux / mtd 的做法。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20260815](https://lore.kernel.org/linux-i2c/20260815140931.53297-1-dragonliu2018@gmail.com/) · **commit** [8eacce] · **首发版本** `-` · **变更行数** +6 行 · **合并时间** 2026-08-15

---

## 背景

`drivers/i2c/busses/i2c-qcom-cci.c` 的 Qualcomm CCI I2C 驱动里，`cci_probe()` / `cci_remove()` 会在清理路径上对每个已注册的 master 调用 `i2c_del_adapter()` 摘除 adapter，紧跟一句 `of_node_put()` 归还 device tree 节点引用。这两句原本看着天衣无缝——`of_node_get()` 在探测时取引用、`of_node_put()` 在摘除时还，对称、配平。

问题出在一个**不显眼的副作用**：`i2c_del_adapter()` 在末尾会用 `memset(&adap->dev, 0, sizeof(adap->dev))` 把整个 `adap->dev` 清零（由 commit `bd4bc3dbded9` 引入）。于是紧跟在它后面的 `of_node_put(cci->master[i].adap.dev.of_node)` 读到的是刚被清成 `NULL` 的 `of_node`——`of_node_put(NULL)` 是空操作，**注册时取的那份引用永远放不回去**，每次清理已注册 adapter、每次卸载都泄漏一个 `device_node`。

这一漏洞其实是被 commit `02a4a69667a2`（"i2c: qcom-cci: don't put a device tree node before i2c_add_adapter()"）**带进来的**：那个补丁在同一次改动里加上了 `of_node_get()` 和配对的 `of_node_put()`，却把 put 放在了 `i2c_del_adapter()` 之后，于是自该修复引入起 bug 就在。本 commit（`Fixes: 02a4a69667a2`）把它收口，做法和 mtd 的 `del_mtd_device()`（commit `56570bdad5e3`）、i2c-mux 的 `i2c_mux_del_adapters()` 一致：**在调用会清零结构的函数之前，先把要用的指针快照下来**。

![cci 清理路径调用链：i2c_del_adapter 内部 memset 清零 of_node](/vibe-reading/images/articles/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak/call-chain.svg)

上图把 `error_i2c` / `cci_remove` 的清理调用链拆成四步对照。改动前（红）没有快照，`i2c_del_adapter` 内部的 `memset` 把 `adap->dev.of_node` 清成 `NULL`，随后 `of_node_put(adap->dev.of_node)` 退化成 `put(NULL)` 空操作、引用泄漏；改动后（绿）在调 `i2c_del_adapter` 前先把 `node = adap->dev.of_node` 快照下来，清零再也无法伤到这份快照，`of_node_put(node)` 真正归还引用、配平。

## 前置知识

### `i2c_del_adapter()` 末尾会清零 `adap->dev`

这是整件事的根因。`i2c_del_adapter()`（`drivers/i2c/i2c-core-base.c`）在 `device_unregister()` 之后做了一次整块清零：

```c title="drivers/i2c/i2c-core-base.c (i2c_del_adapter, 尾部)"
 	device_unregister(&adap->dev);
 	...
 	memset(&adap->dev, 0, sizeof(adap->dev));   // 连 adap->dev.of_node 一起清成 NULL
 }
 EXPORT_SYMBOL(i2c_del_adapter);
```

这次 `memset` 由 commit `bd4bc3dbded9`（"i2c: Clear i2c_adapter.dev on adapter removal"，Jean Delvare）加入，目的是摘除后把 `adap->dev` 复位、便于复用同一个 `i2c_adapter` 结构。代价是：**任何在 `i2c_del_adapter()` 返回后再去读 `adap->dev.*` 的代码，读到的都是 0**——`of_node_put(adap->dev.of_node)` 自然读到 `NULL`。

### `of_node_put(NULL)` 是静默空操作

`of_node_put()` 内部对 `NULL` 有保护、直接返回，既不报错也不告警。所以泄漏不会崩、不会叫，只在 device tree 引用计数校验器（销毁 overlay changeset 时比对 refcount）那里被动暴露——和 mtd 那条如出一辙。

### `i2c_add_adapter()` 失败路径不受影响

`cci_probe()` 里 `i2c_add_adapter()` 失败时也有一句 `of_node_put(adap->dev.of_node)`，但它在 `i2c_del_adapter()` 之前（此时还没摘除、`of_node` 没被清），读到的仍是有效指针。`i2c_add_adapter()` / `i2c_register_adapter()` 的失败路径走的是 `device_del()`，**不带那次 `memset`**——`memset` 只存在于 `i2c_del_adapter()`。所以这一处 put 是对的，本 commit 不动它。

## 涉及的函数与调用链

### 函数清单（文件 : 行号）

| 函数 | 位置 | 在本修复里的角色 |
|------|------|------|
| `cci_probe` | `drivers/i2c/busses/i2c-qcom-cci.c:500` | 探测：探测循环里 `of_node_get`（539）取引用；注册循环（602）`i2c_add_adapter`，失败时 put（608）+ 跳 `error_i2c`（615）回退 |
| `cci_remove` | `i2c-qcom-cci.c:633` | 卸载：循环 `i2c_del_adapter` + `of_node_put` + `cci_halt` |
| `i2c_del_adapter` | `drivers/i2c/i2c-core-base.c:1803` | 注销 adapter，末尾 `memset(&adap->dev,0)`（1849）——把 `of_node` 清零的元凶 |
| `i2c_register_adapter` | `i2c-core-base.c` | `i2c_add_adapter` 的实现；失败路径 `device_del`（不 memset），故 add 失败时的 put 安全 |
| `i2c_mux_del_adapters` | `drivers/i2c/i2c-mux.c:416` | 同做法的参照：先快照 `np`，再 `i2c_del_adapter`，再 `of_node_put(np)` |
| `of_node_get` / `of_node_put` | `include/linux/of.h` | `device_node` 引用计数 +1 / −1；`put(NULL)` 空操作 |

### 调用链（改动前 vs 改动后）

改动前，`error_i2c` 回退与 `cci_remove` 卸载走的是同一条会泄漏的链：

```text title="改动前调用链（error_i2c / cci_remove，泄漏）"
cci_probe 失败 → error_i2c（或 cci_remove 卸载）
  └─ for each master[i] (cci 非空)
       ├─ i2c_del_adapter(&master[i].adap)            # i2c-core-base.c:1803
       │    ├─ device_unregister(&adap->dev)           # :1839
       │    └─ memset(&adap->dev, 0, sizeof(adap->dev))# :1849 → adap->dev.of_node = NULL
       └─ of_node_put(master[i].adap.dev.of_node)      # 读到 NULL → 空操作 → 引用泄漏
```

改动后，在 `i2c_del_adapter()` 之前先把指针快照到局部变量，清零就伤不到它：

```text title="改动后调用链（配平）"
cci_probe 失败 → error_i2c（或 cci_remove 卸载）
  └─ for each master[i] (cci 非空)
       ├─ node = master[i].adap.dev.of_node            # 先快照有效指针
       ├─ i2c_del_adapter(&master[i].adap)             # memset 仍清零 adap->dev，但 node 不受影响
       └─ of_node_put(node)                            # 用快照放引用 → refcount 配平
```

对照 i2c-mux 的 `i2c_mux_del_adapters()`（`drivers/i2c/i2c-mux.c:416`），它正是这套写法：

```c title="drivers/i2c/i2c-mux.c (i2c_mux_del_adapters, 同做法参照)"
 		struct device_node *np = adap->dev.of_node;   // 先快照
 		i2c_del_adapter(adap);                          // 再 del（内部 memset 清零 adap->dev）
 		of_node_put(np);                               // 用快照放引用
```

## 实现

改动只有 +6/-2、两个 hunk，分别落在 `error_i2c` 回退和 `cci_remove` 卸载，做法完全对称：在 `i2c_del_adapter()` 之前声明局部变量快照 `of_node`，`of_node_put()` 改用快照。

### `error_i2c` 回退路径（`cci_probe` 内）

```c title="drivers/i2c/busses/i2c-qcom-cci.c (cci_probe · error_i2c 回退)"
 	for (--i ; i >= 0; i--) {
 		if (cci->master[i].cci) {
+			struct device_node *node = cci->master[i].adap.dev.of_node;
+
 			i2c_del_adapter(&cci->master[i].adap);
-			of_node_put(cci->master[i].adap.dev.of_node);
+			of_node_put(node);
 		}
 	}
```

### `cci_remove` 卸载路径

```c title="drivers/i2c/busses/i2c-qcom-cci.c (cci_remove · 卸载)"
 	for (i = 0; i < cci->data->num_masters; i++) {
 		if (cci->master[i].cci) {
+			struct device_node *node = cci->master[i].adap.dev.of_node;
+
 			i2c_del_adapter(&cci->master[i].adap);
-			of_node_put(cci->master[i].adap.dev.of_node);
+			of_node_put(node);
 			cci_halt(cci, i);
 		}
 	}
```

### `i2c_add_adapter()` 失败路径：不动

```c title="drivers/i2c/busses/i2c-qcom-cci.c (cci_probe · 注册失败路径，保留原样)"
 		ret = i2c_add_adapter(&cci->master[i].adap);
 		if (ret < 0) {
 			of_node_put(cci->master[i].adap.dev.of_node);   // 在任何 i2c_del_adapter 之前，of_node 仍有效
 			goto error_i2c;
 		}
```

这一处 `of_node_put` 跑在 `i2c_del_adapter()` 之前——adapter 还没被摘除，`adap->dev` 没被清零，`of_node` 仍有效，put 是真归还。所以本 commit 显式留着不动，commit message 里也专门点了一句「left unchanged」。

## Review

- 本 commit 由本人（Liu Zhenlong）提交，属 `Contributions`。commit message 把来龙去脉写全：指明 `of_node_get()` / 配对 `of_node_put()` 由 `02a4a69667a2` 引入、put 被放在 `i2c_del_adapter()` 之后，而 `i2c_del_adapter()` 末尾的 `memset`（`bd4bc3dbded9`）会把 `of_node` 清零、令 put 失效。
- 修法对标现成的正确写法：i2c-mux 的 `i2c_mux_del_adapters()`、mtd 的 `del_mtd_device()`（`56570bdad5e3`），都是在清零结构之前先快照指针。有同子系统里的成熟范例背书，审查风险低。
- `Fixes: 02a4a69667a2` 指向被修的源头；commit 还显式带 `Cc: stable@vger.kernel.org`，待进上游后由 stable 机器人回溯到 LTS。patch 已提交到 linux-i2c 邮件列表（见 meta 行 `**patch**` 链接）；commit 本身尚未进上游 torvalds/linux，故 `首发版本` 仍填 `-`、合并时间取本地 commit 日期。
- trailer `Assisted-by: Claude:claude-opus-5` 标注本修复在 AI 协助下完成（与本文 `aiModel` 字段一致）。

## 问题

### 为什么 `02a4a69667a2` 没被发现

因为那一句 `of_node_put(cci->master[i].adap.dev.of_node)` 在**字面上**完全正确——取的是 `adap.dev.of_node`、放的是 `adap.dev.of_node`，看着就是对称配平。它没被发现，是因为没人顺着 `i2c_del_adapter()` 往里看一层：`i2c_del_adapter()` 不只是注销设备，它还**顺手把 `adap->dev` 整块抹零**。这个副作用藏在 i2c 核心里、离 qcom-cci 驱动两层的调用之外，review 时很容易只看驱动自己的几行、默认 `i2c_del_adapter()` 是「纯净的摘除」。

把 `of_node_put` 放到 `i2c_del_adapter()` 之后，等于**先让清零发生、再去读被清零的字段**——和 mtd 的 `del_mtd_device()` 先 `memset(&mtd->dev, 0)` 再 `of_node_put(mtd_get_of_node(mtd))` 是同一类「use-after-clear」。

### 触发条件

只要 `error_i2c` 或 `cci_remove` 真的走到「已注册 master 的摘除」分支就会泄漏——即探测中途某个 master 注册成功后、后续步骤失败回退，以及正常卸载。对开机常驻的 device tree 节点多挂一份引用是「软泄漏」（节点本就不释放），但配合 overlay / 反复 probe-remove 的场景会真正阻碍节点回收。`i2c_add_adapter()` 失败那个 put 因为在 `i2c_del_adapter()` 之前、不受 memset 影响，所以那条路径不泄漏。

## 意义与影响

这条改动把 qcom-CCI 的 of_node 引用计数彻底收口，和前两条合起来刚好凑成 of_node 引用计数的三部曲：

- `02a4a69667a2`：**存指针漏 get**——存 `of_node` 没取引用，循环释放后悬空；
- `56570bdad5e3`（mtd）：**放引用打在已清零指针上**——`memset` 在 `of_node_put` 之前把 `of_node` 清成 `NULL`；
- 本 commit：**同一种 use-after-clear，换了个触发者**——清零不是驱动自己的 `memset`，而是 `i2c_del_adapter()` 内部的 `memset`，所以驱动里看着「字面正确」的 put 其实是空操作。

更普适的教训：**当被调函数会清零/释放其参数所在的结构时，调用方要先把自己还需要的字段快照下来，再调用它。** i2c adapter 驱动里这是个具体陷阱——`i2c_del_adapter()` 末尾那次 `memset` 对任何「在摘除后还要读 `adap->dev.*`」的驱动都是地雷。i2c-mux 早就用了快照写法规避，mtd、本 commit 都在补同一课。

## 参考

- **引入 `memset` 的 commit** [`bd4bc3dbded9`](https://github.com/torvalds/linux/commit/bd4bc3dbded9)（"i2c: Clear i2c_adapter.dev on adapter removal"，Jean Delvare）：本 commit 的根因所在，它在 `i2c_del_adapter()` 末尾加了对 `adap->dev` 的清零。
- **同做法参照** `drivers/i2c/i2c-mux.c:416`（`i2c_mux_del_adapters`）：i2c 子系统里「先快照 `np`、再 `i2c_del_adapter`、再 `of_node_put(np)`」的成熟写法，本 commit 的修法即照此。

## 相关阅读

- **一次性修复 5 个 i2c 总线驱动的 device_node 引用计数泄漏** —— [Linux series-20260815](/vibe-reading/articles/OS/Linux/Contributions/linux-series-20260815-i2c-ofnode-refcount-leak-series)：同根因同解法的 5 驱动系列（兄弟 patch）。本篇（8eacce3，qcom-CCI）是更早单独发的 standalone；该系列把 mpc/cpm/ibm_iic/opal/pnx 五个一起收口，根因同是 `i2c_del_adapter` 的 `memset`（`bd4bc3dbded9`）。
- **为 i2c-pnx 添加 device tree 支持并套用 adap->dev.of_node 的 of_node_get 模式** —— [Linux commit-b41a216](/vibe-reading/articles/OS/Linux/PRs/linux-commit-b41a216-of-i2c-pnx-dt-support)：同一 bug→fix 弧的 i2c-pnx 实例。b41a216（2012）加了 of_node_get 却漏了 put；2026 年由 `05515d1` 用本篇（8eacce3）那套 cache-before-del 快照补齐——根因同是 `i2c_del_adapter` 的 `memset`（`bd4bc3dbded9`）。
- **通用化 OF I2C 支持并确立 adap->dev.of_node 的 of_node_get 模式** —— [Linux commit-9fd049](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support)：`adap->dev.of_node = of_node_get()` 模式的源头（2010）。qcom-CCI 一连串 of_node 修复（02a4a6 补 get、本篇修 put 顺序）本质上都是把偏离了 9fd049 模式的代码拉回来。
- **为 Qualcomm CCI 驱动补齐 device tree 节点的引用计数** —— [Linux commit-02a4a6](/vibe-reading/articles/OS/Linux/PRs/linux-commit-02a4a6-qcom-cci-of-node-refcount)：本 commit 的前序（被 `Fixes:` 指向）。那篇给 qcom-CCI 补了 `of_node_get` / `of_node_put`，却把 put 放在 `i2c_del_adapter()` 之后，埋下本篇修复的坑；建议先读它再读本篇。
- **修复 del_mtd_device 清零顺序引发的 of_node 引用泄漏** —— [Linux commit-56570b](/vibe-reading/articles/OS/Linux/PRs/linux-commit-56570b-mtd-del-device-of-node-refcount)：同思路的另一条落地线。mtd 是驱动自己的 `memset` 在 `of_node_put` 前清零 `of_node`，本篇是 `i2c_del_adapter()` 内部的 `memset` 干同样的事——两条对照可见「use-after-clear」在不同子系统的共通形态与同一套解法。
- **驱动模型与基础设施** —— [Linux CodeWiki 7.1 · 12-driver-model](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)：platform driver 的 probe/remove 框架与设备注册/注销模型，`cci_probe` / `cci_remove` 的回退与卸载路径正处其中，可对照理解这些清理步骤的编排。
