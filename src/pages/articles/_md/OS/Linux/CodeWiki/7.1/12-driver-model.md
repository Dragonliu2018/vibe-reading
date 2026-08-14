---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "驱动模型与基础设施"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "驱动模型", "device", "bus", "driver", "kobject", "sysfs"]
description: "Linux 设备驱动模型——device/bus/driver 中介者模式、platform bus、probe 自动绑定、kobject 引用计数与 sysfs、lib/ 通用库。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

## 模块定位

`drivers/base/` 和 `lib/` 是 Linux 内核的基础设施层。`drivers/base/` 实现了统一的设备驱动模型——device/bus/driver 三大抽象，所有具体总线（PCI、USB、platform 等）和具体驱动都建立在这层框架之上。`lib/` 则是内核通用的数据结构与算法库，为整个内核提供红黑树、哈希表、位操作、排序等基础设施。

设备驱动模型独立存在的核心原因在于**解耦与复用**：没有统一框架时，每个总线要自己管理设备发现、驱动匹配、电源管理、sysfs 表示，代码大量重复。`drivers/base/` 通过中介者模式将公共逻辑抽取到 `bus_type` 中——设备注册时总线自动遍历已注册驱动寻找匹配，驱动注册时总线自动遍历已注册设备寻找匹配，双向触发自动绑定。新总线只需实现 `bus_type` 的 `match`/`probe`/`remove` 等回调，即可复用整套注册、匹配、探测、引用计数、sysfs 暴露机制。

`lib/` 独立的原因更直接：数据结构和算法是所有子系统的共用工具，不应分散在各处重复实现。集中维护保证了接口一致性、经过充分测试、避免代码膨胀。

## 模块架构

`drivers/base/` 的核心是**三大对象 + kobject/sysfs 基础设施**，`lib/` 是独立的数据结构与算法库。三者协同构成完整的设备驱动基础设施。

### 三大对象

| 对象 | 定义位置 | 核心字段 | 职责 |
|---|---|---|---|
| `bus_type` | `include/linux/device/bus.h:83` | `name`/`match`/`probe`/`remove`/`shutdown`/`suspend`/`resume`/`dma_configure`/`pm` | 总线类型：device 与 driver 的中介者，持有 `klist_devices` + `klist_drivers`，定义匹配规则与探测入口 |
| `device_driver` | `include/linux/device/driver.h:98` | `name`/`bus`/`owner`/`of_match_table`/`acpi_match_table`/`probe`/`remove`/`pm`/`p` | 驱动：包含匹配表（OF/ACPI/id_table）和 probe/remove 回调，`p` 指向 `driver_private`（持有 `klist_devices` + sysfs kobject） |
| `device` | `include/linux/device.h:628` | `kobj`/`parent`/`p`/`init_name`/`bus`/`driver`/`driver_data`/`mutex`/`of_node`/`fwnode`/`devt`/`release` | 设备：内嵌 `kobject`（引用计数 + sysfs），记录当前绑定的 `driver`，`p` 指向 `device_private`（链入 bus 和 driver 的 klist） |

三者通过 `bus_type` 中介者关联：`device` 和 `device_driver` 都持有指向同一 `bus_type` 的指针。`device_private`（`drivers/base/base.h:125`）通过两个 `klist_node` 分别链入总线的 `klist_devices` 和驱动的 `klist_devices`，实现双向关联。`bus_type` 的 `match` 回调判断 device 与 driver 是否匹配，`probe`/`remove` 执行实际绑定与解绑。

### Kobject 与 sysfs 基础设施

`kobject`（`include/linux/kobject.h:64`）是内核对象的统一基类，提供引用计数（`kref`）和 sysfs 目录表示。`device` 结构体第一字段就是 `kobj`，使得每个设备自动获得引用计数管理和 sysfs 目录。`kset`（`:168`）聚合相关 kobject，`devices_kset` 是 `/sys/devices` 的根。

### lib/ 通用库

`lib/` 包含约 212 个 `.c` 文件，覆盖内核通用的数据结构（rbtree、maple_tree、xarray、klist、idr、rhashtable、sbitmap）、字符串处理、位操作、排序搜索、压缩解压、加密算法（`lib/crypto/`）、数学运算（`lib/math/`）和 FDT（Device Tree）解析等。其中 `lib/kobject.c` 和 `lib/kobject_uevent.c` 直接服务于设备驱动模型，`lib/klist.c` 提供 `klist` 带引用计数链表——device 模型的核心链表结构。

## 调用链路

设备驱动模型有两条核心调用链：设备注册链和驱动注册链。两者通过 `bus_type` 中介者交汇，实现双向自动探测绑定。

### 设备注册链

```c
// title="drivers/base/core.c + drivers/base/bus.c + drivers/base/dd.c"
device_register              // core.c:3785
→ device_initialize          // core.c:3157  kobj.kset=devices_kset + kobject_init(&dev->kobj, &device_ktype)
                               //   INIT_LIST_HEAD(dma_pools/devres_head) + mutex_init + device_pm_init
→ device_add                 // core.c:3573
  → device_private_init      // 分配 device_private
  → dev_set_name             // 设置 sysfs 名称
  → get_device_parent        // 查找父 kobject
  → kobject_add              // 创建 sysfs 目录 /sys/devices/...
  → device_create_file       // 创建 uevent 属性文件
  → bus_add_device           // bus.c:545
    → 添加 bus dev_groups 属性
    → sysfs 链接 bus/devices/<name>
    → klist_add_tail(knode_bus, klist_devices)  // :584  加入总线设备链表
  → dpm_sysfs_add + device_pm_add   // 电源管理注册
  → bus_notify(BUS_NOTIFY_ADD_DEVICE)  // 通知链
  → kobject_uevent(KOBJ_ADD)         // 用户空间热插拔通知
  → fw_devlink_link_device           // 建立 fw 依赖链接
  → dev_set_ready_to_probe
  → bus_probe_device           // bus.c:605  触发探测
    → device_initial_probe
      → __device_attach         // dd.c:1071
        → bus_for_each_drv      // 遍历总线上所有驱动
          → __device_attach_driver
            → driver_match_device  // 调 bus->match
            → driver_probe_device  // 匹配成功则探测
```

### 驱动注册链

```c
// title="drivers/base/driver.c + drivers/base/bus.c + drivers/base/dd.c"
driver_register               // driver.c:225
→ 检查 bus 已注册
→ 检查 bus->probe 和 drv->probe 不共存 (warn)
→ driver_find                 // 重名检查
→ bus_add_driver              // bus.c:725
  → 分配 driver_private + klist_devices
  → kobject_init_and_add      // sysfs bus/drivers/<name>
  → klist_add_tail(knode_bus, klist_drivers)  // :754  加入总线驱动链表
  → drivers_autoprobe? driver_attach  // :756  自动探测
    → bus_for_each_dev        // 遍历总线上所有设备
      → __driver_attach       // dd.c:1235
        → driver_match_device // 调 bus->match
        → 不匹配: return 0 继续
        → __device_driver_lock
        → driver_probe_device // 匹配成功则探测
        → 始终 return 0 继续遍历
  → module_add_driver         // 模块关联
  → add_bind_files            // sysfs 手动绑定接口
→ driver_add_groups
→ kobject_uevent(KOBJ_ADD)
```

两条链路最终汇合到 `driver_probe_device` → `really_probe`，这是设备与驱动绑定的统一入口。

### 方法速查表

<details>
<summary>drivers/base 核心方法速查（点击展开）</summary>

| 方法 | 文件:行号 | 功能 |
|---|---|---|
| `device_register` | core.c:3785 | 设备注册入口（initialize + add） |
| `device_initialize` | core.c:3157 | 初始化 kobject/mutex/pm |
| `device_add` | core.c:3573 | 设备加入 sysfs/bus，触发探测 |
| `bus_add_device` | bus.c:545 | 设备加入总线 klist + sysfs 链接 |
| `bus_probe_device` | bus.c:605 | 触发设备探测 |
| `__device_attach` | dd.c:1071 | 遍历总线驱动尝试匹配 |
| `__device_attach_driver` | dd.c | 单个驱动匹配尝试 |
| `driver_register` | driver.c:225 | 驱动注册入口 |
| `bus_add_driver` | bus.c:725 | 驱动加入总线 klist + sysfs |
| `driver_attach` | dd.c:1310 | 遍历总线设备尝试匹配 |
| `__driver_attach` | dd.c:1235 | 单个设备匹配尝试 |
| `driver_match_device` | base.h:185 | 调用 bus->match 判断匹配 |
| `driver_probe_device` | dd.c:895 | 驱动探测入口 |
| `__driver_probe_device` | dd.c:830 | 前置检查（dead/已绑定/ready/-EPROBE_DEFER） |
| `really_probe` | dd.c:655 | 探测核心模板方法 |
| `call_driver_probe` | dd.c:624 | bus->probe 优先，否则 drv->probe |
| `driver_bound` | dd.c:447 | 绑定完成：klist + links + notify + uevent |
| `platform_match` | platform.c:1361 | platform 总线匹配规则 |
| `__platform_driver_register` | platform.c:919 | 注册 platform_driver |
| `platform_bus_init` | platform.c:1538 | 初始化 platform 虚拟总线 |
| `kobject_init` | kobject.c:333 | 初始化 kobject（设 ktype） |
| `kobject_add` | kobject.c:410 | 创建 sysfs 目录 |
| `kobject_add_internal` | kobject.c:210 | kobject_add 实现 |
| `get_device` | core.c:3800 | 增引用计数 |
| `put_device` | core.c:3810 | 减引用计数，归零触发 release |

</details>

## 核心实现

### 三大对象与中介者模式

设备驱动模型的精髓在于 `bus_type` 充当 device 与 driver 之间的**中介者**。`subsys_private`（`drivers/base/base.h:43`）是中介者的内部数据载体，持有两条核心链表：

```c
// title="drivers/base/base.h"
struct subsys_private {           // base.h:43
    struct klist klist_devices;   // 总线上所有设备
    struct klist klist_drivers;   // 总线上所有驱动
    struct kset subsys;            // sysfs 子系统目录
    struct kset *devices_kset;
    struct kset *drivers_kset;
    struct bus_type *bus;          // 反向指向
    // ...
};
```

`bus_type` 通过 `subsys_private` 持有 `klist_devices` 和 `klist_drivers` 两条链表。设备注册时通过 `device_private.knode_bus` 链入 `klist_devices`，驱动注册时通过 `driver_private.knode_bus` 链入 `klist_drivers`。绑定后，设备通过 `device_private.knode_driver` 链入驱动的 `klist_devices`。

`driver_match_device`（`base.h:185`）是匹配的统一入口：

```c
// title="drivers/base/base.h"
static inline int driver_match_device(struct device_driver *drv,
                                      struct device *dev)
{
    return drv->bus->match ? drv->bus->match(dev, drv) : 1;
}
```

每条总线自定义 `match` 回调，实现各自的匹配规则。`bus_type` 的 `probe`/`remove` 是总线层级的绑定回调，与 `device_driver` 的 `probe`/`remove` 形成两级策略（见 Probe 机制）。

中介者模式的核心价值：device 和 driver 不需互相知道对方的存在，只需注册到总线，由总线负责匹配和绑定。这天然支持热插拔——新设备到来时总线自动遍历已注册驱动，新驱动加载时总线自动遍历已注册设备。

### 设备注册与自动探测

设备注册到自动探测的完整流程体现了**双向触发**的设计意图。

**设备触发驱动**：`device_add`（`core.c:3573`）完成 sysfs 创建和总线链表加入后，调用 `bus_probe_device`（`bus.c:605`）触发 `__device_attach`（`dd.c:1071`）。`__device_attach` 通过 `bus_for_each_drv` 遍历总线上所有已注册驱动，对每个驱动调用 `__device_attach_driver` → `driver_match_device` → `driver_probe_device`。一个设备可以尝试多个驱动，直到找到匹配并成功 probe 的那个。

**驱动触发设备**：`driver_register`（`driver.c:225`）→ `bus_add_driver`（`bus.c:725`）完成驱动加入总线链表后，若 `drivers_autoprobe` 为真（默认），调用 `driver_attach`（`dd.c:1310`）。`driver_attach` 通过 `bus_for_each_dev` 遍历总线上所有设备，对每个设备调用 `__driver_attach`（`dd.c:1235`）→ `driver_match_device` → `driver_probe_device`。

`__driver_attach` 的关键设计：无论 `driver_probe_device` 成功或失败，函数**始终返回 0**，确保 `bus_for_each_dev` 继续遍历下一个设备。一个驱动可以尝试匹配多个设备，不会因为单个设备 probe 失败而终止。

这种双向触发机制使得设备和驱动的注册顺序无关——无论谁先注册，绑定都会在另一方就绪时自动发生。

### Probe 机制 really_probe

`really_probe`（`dd.c:655`）是设备与驱动绑定的核心函数，采用**模板方法模式**——固定一系列步骤，各步骤的回调由具体总线和驱动填充。

```c
// title="drivers/base/dd.c"
static int really_probe(struct device *dev, struct device_driver *drv)
{
    // 1. 延迟探测检查
    defer_all_probes_check();                    // :660

    // 2. 供应商依赖检查
    device_links_check_suppliers(dev);           // :671  等待依赖设备就绪

    // 3. 设置驱动
    device_set_driver(dev, drv);                 // :684  dev->driver = drv

    // 4. pinctrl 绑定
    pinctrl_bind_pins(dev);                      // 引脚复用配置

    // 5. DMA 配置
    bus->dma_configure(dev);                     // 总线级 DMA 设置

    // 6. sysfs 驱动链接
    driver_sysfs_add(dev);                       // 创建 sysfs 软链接

    // 7. PM domain 激活
    pm_domain->activate(dev);                    // 电源域

    // 8. 调用 probe
    ret = call_driver_probe(dev, drv);           // :709  bus->probe 优先

    // 9. 属性组添加
    device_add_groups(dev, drv->dev_groups);

    // 10. 绑定完成
    driver_bound(dev);                           // :759
}
```

`call_driver_probe`（`dd.c:624`）的调用优先级是**总线 probe 优先于驱动 probe**：

```c
// title="drivers/base/dd.c"
static int call_driver_probe(struct device *dev, struct device_driver *drv)
{
    if (dev->bus->probe)            // 总线 probe 优先
        return dev->bus->probe(dev);
    else if (drv->probe)            // 否则用驱动 probe
        return drv->probe(dev);
    return 0;
}
```

总线层 `probe` 可做通用准备工作。例如 `platform_probe` 会调用 `of_clk_set_defaults` 和 `dev_pm_domain_attach`，避免每个 platform 驱动重复这些操作。`driver_register` 中如果 `bus->probe` 和 `drv->probe` 同时存在会发出 warning——这是渐进迁移策略，鼓励新总线将公共准备逻辑放到 `bus->probe`。

`driver_bound`（`dd.c:447`）完成绑定后的收尾：通过 `klist_add_tail(knode_driver, klist_devices)` 将设备加入驱动的设备链表 → `device_links_driver_bound` 建立设备链接 → `device_pm_check_callbacks` 检查电源管理回调 → `driver_deferred_probe_del` 移除延迟探测条目 → `driver_deferred_probe_trigger` 触发依赖此设备的延迟探测重试 → `bus_notify(BUS_NOTIFY_BOUND_DRIVER)` 发送绑定通知 → `kobject_uevent(KOBJ_BIND)` 向用户空间发送绑定事件。

**延迟探测（Deferred Probe）**：当 `driver_probe_device`（`dd.c:895`）中 `__driver_probe_device`（`dd.c:830`）检测到设备依赖尚未就绪时返回 `-EPROBE_DEFER`，设备被加入延迟探测列表。当依赖设备绑定驱动时，`driver_deferred_probe_trigger` 会重新触发延迟列表中的探测。这是事件驱动的设计——不需要全局排序 probe 顺序，依赖就绪后自动重试。

Probe 失败路径（`really_probe` 的 `probe_failed` 分支，`:767`）：`driver_sysfs_remove` 移除 sysfs 链接 → `bus_notify(BUS_NOTIFY_NOT_BOUND)` 发送未绑定通知 → `bus->dma_cleanup` 清理 DMA → `device_links_no_driver` 清理设备链接 → `device_unbind_cleanup` 将 `dev->driver` 置空，设备回到未绑定状态，可被其他驱动尝试。

### Platform Bus

Platform bus 是 Linux 为**非枚举型设备**设计的虚拟总线。SoC 上的内存映射 IP 核（UART、I2C、GPIO、SPI 控制器等）没有类似 PCI/USB 的硬件枚举机制——CPU 无法通过硬件协议自动发现这些设备。Platform bus 提供统一的 device/driver 模型入口，让这些设备也能享受自动匹配、sysfs 暴露、电源管理等完整框架。

```c
// title="drivers/base/platform.c"
struct bus_type platform_bus_type = {       // :1502
    .name       = "platform",
    .dev_name   = "platform",
    .match      = platform_match,
    .probe      = platform_probe,
    .remove     = platform_remove,
    .shutdown   = platform_shutdown,
    .dma_configure = platform_dma_configure,
    .pm         = &platform_dev_pm_ops,
};
```

`platform_match`（`platform.c:1361`）定义了多源匹配的优先级链：

```c
// title="drivers/base/platform.c"
static int platform_match(struct device *dev, struct device_driver *drv)
{
    // 1. driver_override（最高优先级，用户强制指定）
    if (pdev->driver_override)
        return strcmp(pdev->driver_override, drv->name) == 0;   // :1368

    // 2. Device Tree (OF) 匹配
    if (of_driver_match_device(dev, drv))                       // :1373
        return 1;

    // 3. ACPI 匹配
    if (acpi_driver_match_device(dev, drv))                     // :1377
        return 1;

    // 4. id_table 匹配
    if (platform_match_id(pdev, drv))                           // :1381
        return 1;

    // 5. name 字符串匹配（最低优先级）
    return strcmp(pdev->name, drv->name) == 0;                  // :1385
}
```

优先级从高到低：`driver_override`（用户通过 sysfs 强制绑定）→ OF 匹配（Device Tree `compatible` 属性）→ ACPI 匹配 → `id_table` 匹配（`platform_match_id` 遍历 `id_table` 做 `strcmp`）→ name 字符串匹配。多源匹配策略使得 platform bus 能同时支持 Device Tree（ARM/嵌入式）、ACPI（x86/服务器）和传统 name 匹配三种设备描述方式。

`platform_device`（`include/linux/platform_device.h:23`）内嵌 `struct device dev`，额外携带 `name`/`id`/`resource`/`num_resources`——设备的内存地址、IRQ 等硬件资源。`platform_driver`（`platform_device.h:270`）内嵌 `struct device_driver driver`，probe/remove 回调参数为 `platform_device*`。

`__platform_driver_register`（`platform.c:919`）将 `drv->driver.bus` 设为 `&platform_bus_type` 后调用 `driver_register`，一个宏即可注册 platform 驱动。`platform_bus_init`（`platform.c:1538`）在内核启动阶段注册虚拟总线设备 `platform_bus` 和 `platform_bus_type`，是 `driver_init`（`drivers/base/init.c:21`）的核心步骤之一。

### Kobject 与 sysfs

`kobject` 是 Linux 内核对象的统一基类，实现了 **RAII 风格的引用计数**和 sysfs 目录表示。

```c
// title="include/linux/kobject.h"
struct kobject {                // :64
    const char      *name;
    struct list_head entry;     // 父 kset 的子 kobject 链表
    struct kobject   *parent;
    struct kset      *kset;
    const struct kobj_type *ktype;
    struct kernfs_node *sd;     // sysfs/kernfs 目录项
    struct kref       kref;     // 引用计数
    unsigned int state_initialized:1;
    unsigned int state_in_sysfs:1;
};

struct kref {                   // :19
    refcount_t refcount;
};
```

**引用计数 RAII**：`get_device`（`core.c:3800`）转发到 `kobject_get` 递增 `kref`，`put_device`（`core.c:3810`）转发到 `kobject_put` 递减 `kref`。当 `kref` 归零时，触发 `ktype->release`——对于 device 就是 `device_release`，调用 `dev->release` 释放设备内存。文档强调：必须通过 `kobject_put` 释放，**不能直接 `kfree`**，否则引用计数不一致会导致 use-after-free 或内存泄漏。`bus_add_device` 持有设备引用，`bus_remove_device` 释放引用，保证设备在总线链表期间不会被释放。

**sysfs 表示**：`kobject_add`（`kobject.c:410`）→ `kobject_add_internal`（`:210`）执行 `kobject_get(parent)` 增加父引用 → 如果有 kset 无 parent 则用 kset 作 parent → `create_dir` 在 kernfs 中创建目录节点 → `state_in_sysfs = 1`。`device` 结构体第一字段就是 `kobj`（`device.h:629`），`device_initialize` 调用 `kobject_init(&dev->kobj, &device_ktype)`，`device_add` 调用 `kobject_add`。sysfs 目录层次自然对应设备树——`/sys/devices/` 是根，设备的 `parent` 链形成目录层次结构。

**kset 聚合**：`kset`（`:168`）既是 kobject 的容器，也是 sysfs 子目录。`devices_kset` 对应 `/sys/devices`，`bus_kset` 对应 `/sys/bus`。kset 的 `uevent_ops` 还提供统一的热插拔事件过滤。

### lib/ 通用库

`lib/` 是内核的通用工具库，约 212 个 `.c` 文件，按功能分类如下：

| 分类 | 代表文件 | 用途 |
|---|---|---|
| 数据结构 | `rbtree.c`/`maple_tree.c`/`xarray.c`/`klist.c`/`idr.c`/`rhashtable.c`/`sbitmap.c` | 红黑树（CFS/VMA）、并发 B-tree（VMA）、radix-tree 替代（page cache）、带引用计数链表（device 模型）、ID 分配器、可扩展哈希表、Scalable bitmap（blk-mq tag） |
| 数据结构（续） | `llist.c`/`plist.c`/`list_sort.c`/`btree.c`/`interval_tree.c`/`timerqueue.c`/`union_find.c` | 无锁链表、优先级链表、链表归并排序、B-tree、区间树、定时器队列、并查集 |
| 字符串 | `string.c`/`vsprintf.c`/`kstrtox.c`/`hexdump.c`/`base64.c`/`uuid.c` | `memcpy`/`memset`/`strcmp`、printk 格式化、字符串转整数、十六进制转储 |
| 位操作 | `bitmap.c`/`find_bit.c`/`hweight.c`/`bitrev.c` | 位图操作、查找位、popcount、位反转 |
| 排序搜索 | `sort.c`/`bsearch.c` | 堆+插入排序、二分搜索 |
| kobject/sysfs | `kobject.c`/`kobject_uevent.c`/`devres.c` | kobject 生命周期、热插拔通知、`devm_*` 自动释放资源 |
| 压缩 | `decompress_inflate.c`/`unlz4.c`/`unlzo.c`/`unxz.c`/`unzstd.c`/`zstd/`/`lz4/` | 内核解压（initramfs、固件加载） |
| 加密 | `lib/crypto/`: `aes.c`/`sha1.c`/`sha256.c`/`sha512.c`/`sha3.c`/`chacha.c`/`curve25519.c`/`blake2b.c` | 加密算法软件实现 |
| CRC | `crc16.c`/`crc32.c`/`crc64.c`/`crc-ccitt.c`/`crc-t10dif.c` | 校验和算法 |
| 数学 | `lib/math/`: `div64.c`/`int_log.c`/`int_sqrt.c`/`gcd.c`/`lcm.c`/`reciprocal_div.c`/`cordic.c` | 64 位除法、对数、整数平方根、最大公约数、乘法代除法优化、三角函数 |
| FDT | `fdt.c`/`fdt_ro.c`/`fdt_rw.c` | Device Tree 二进制格式解析（设备枚举） |
| 调试 | `dynamic_debug.c`/`fault-inject.c`/`genalloc.c` | 动态调试、故障注入、通用内存池 |

其中与设备驱动模型直接相关的是 `lib/kobject.c`（kobject 生命周期与 sysfs）、`lib/kobject_uevent.c`（用户空间热插拔通知）和 `lib/klist.c`（`klist` 带引用计数链表——`bus_type` 的 `klist_devices`/`klist_drivers` 和 `device_private`/`driver_private` 的 `klist_node` 都基于此）。`devres.c` 实现的 `devm_*` 系列函数让驱动申请的资源在设备解绑时自动释放，是 RAII 在驱动层的延伸。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 中介者（Mediator） | `bus_type`（`bus.h:83`）持有 `klist_devices` + `klist_drivers` | device 和 driver 不直接互相引用，通过总线中介完成匹配绑定，解耦双方并支持热插拔自动发现 |
| 策略（Strategy） | `bus->match`（`base.h:185` `driver_match_device`）+ `call_driver_probe`（`dd.c:624`） | 每条总线自定义匹配规则（platform: OF→ACPI→id_table→name；PCI: vendor/device；USB: class），bus->probe 优先于 drv->probe |
| RAII 引用计数 | `kobject` + `kref`（`kobject.h:64`），`get_device`/`put_device`（`core.c:3800/3810`） | kref 归零自动触发 `ktype->release`，统一生命周期管理，防止 use-after-free 和内存泄漏 |
| 观察者（Observer） | `bus_register_notifier`（`bus.c:1045`）+ `kobject_uevent` | 内核内通过 `bus_notify` 通知 ADD_DEVICE/BOUND_DRIVER/NOT_BOUND 事件，用户空间通过 `kobject_uevent` 接收 KOBJ_ADD/KOBJ_BIND 热插拔事件 |
| 模板方法（Template Method） | `really_probe`（`dd.c:655`）固定步骤序列 | 统一 probe 流程（pinctrl→DMA→sysfs→PM→probe→bound），各回调由具体总线和驱动填充，避免每驱动重复公共初始化 |

## 模块间交互

`drivers/base/` 是内核驱动子系统的基石，几乎所有具体驱动都依赖它。

**被所有具体驱动使用**：`drivers/pci/`/`drivers/usb/`/`drivers/gpu/`/`drivers/net/` 等子系统的设备注册、驱动注册、总线注册都调用 `drivers/base/` 提供的 `device_register`/`driver_register`/`bus_register`。具体总线通过定义自己的 `bus_type` 并实现 `match`/`probe`/`remove` 回调接入框架。

**与 fs/sysfs 交互**：`kobject` 通过 `kernfs_node`（`sd` 字段）映射到 sysfs/kernfs 文件系统。`kobject_add_internal` 的 `create_dir` 在 kernfs 中创建目录节点。sysfs 的目录层次完全由 kobject 的 parent 链决定。

**与电源管理交互**：`device_pm_init`（`device_initialize` 中）、`device_pm_add`（`device_add` 中）、`dpm_sysfs_add` 将设备注册到电源管理子系统。`really_probe` 中调用 `pm_runtime_get_suppliers` 和 `pm_domain->activate`，probe 前后设置 runtime PM barrier。设备绑定时 `device_pm_check_callbacks` 检查并注册 PM 回调。

**与 arch（Device Tree/ACPI）交互**：`device` 的 `of_node`/`fwnode` 字段关联固件描述。`platform_match` 优先尝试 OF（`of_driver_match_device`，匹配 Device Tree `compatible` 属性）和 ACPI（`acpi_driver_match_device`）匹配。`fw_devlink_link_device` 在 `device_add` 中基于固件描述建立设备间依赖链接，驱动延迟探测机制据此等待供应商就绪。`lib/fdt.c` 等提供 FDT 二进制解析，用于启动早期从 Device Tree 创建 platform_device。

**与 init/ 交互**：`driver_init`（`drivers/base/init.c:21`）由 `init/main.c` 调用，依次执行 `devices_init`（创建 `/sys/devices` kset）→ `buses_init`（创建 `/sys/bus` kset）→ `classes_init` → `firmware_init` → `platform_bus_init`（注册虚拟总线设备和总线类型）→ `auxiliary_bus_init` → `memory/node/cpu/container_dev_init`，完成设备驱动模型的启动初始化。

## 扩展方式

新增一个设备驱动的标准路径取决于设备所在的总线类型。

**Platform 驱动**（最常见，适用于 SoC IP 核等非枚举设备）：

1. 实现 `platform_driver` 结构体，填充 `probe`/`remove`/`driver.name`/`driver.of_match_table`（或 `id_table`/`acpi_match_table`）。

2. 通过 `module_platform_driver` 宏（内部调用 `__platform_driver_register` → `driver_register`）注册，自动设置 `driver.bus = &platform_bus_type`。

```c
// title="示例：注册 platform 驱动"
static const struct of_device_id my_drv_ids[] = {
    { .compatible = "vendor,my-uart" },
    { }
};
MODULE_DEVICE_TABLE(of, my_drv_ids);

static struct platform_driver my_driver = {
    .probe  = my_probe,
    .remove = my_remove,
    .driver = {
        .name = "my-uart",
        .of_match_table = my_drv_ids,
        .pm   = &my_pm_ops,
    },
};
module_platform_driver(my_driver);
```

**具体总线驱动**（PCI/USB 等）：实现对应总线的 driver 结构体（如 `pci_driver`），调用 `__pci_register_driver`（内部设置 `driver.bus = &pci_bus_type` → `driver_register`）。匹配规则由 `pci_bus_type.match`（比较 vendor/device ID）自动处理。

**新增总线类型**：定义 `bus_type` 结构体，实现 `match`/`probe`/`remove` 等回调，调用 `bus_register` 注册。之后该总线上的设备和驱动即可享受自动匹配、sysfs 暴露、电源管理等完整框架。

整个扩展过程中，`drivers/base/` 的注册流程、匹配引擎、`really_probe` 模板、kobject 引用计数、sysfs 表示等机制均可直接复用，新驱动只需关注自身硬件特有的初始化和数据路径。
