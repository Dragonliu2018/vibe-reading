---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "I2C 子系统"
date: "2026-08-15T23:50:00+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "I2C", "SMBus", "adapter", "i2c-dev", "mux"]
description: "Linux I2C 子系统核心——adapter/client 设备模型、i2c_algorithm 策略模式、i2c_transfer 传输链、SMBus 协议与回退模拟、i2c-dev 字符设备、mux 多路复用。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

I2C（Inter-Integrated Circuit）是连接 SoC 与外围低速芯片（传感器、EEPROM、PMIC、触摸屏控制器等）的两线串行总线协议。Linux 的 `drivers/i2c/` 子系统是 I2C 协议在内核中的框架实现——它不包含具体硬件控制器的驱动（那些在 `drivers/i2c/busses/` 下，如 `i2c-designware`、`i2c-gpio`、`i2c-qcom-cci`），而是提供 **adapter/client 设备模型、传输算法抽象、SMBus 协议层、`/dev/i2c-N` 字符设备接口、mux 多路复用** 这一整套基础设施。

I2C 子系统是驱动模型（见[驱动模型与基础设施](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)）在 I2C 领域的特化——`i2c_bus_type` 是 `bus_type` 的具体实例，复用 device/bus/driver 匹配与 probe 机制，但增加了 I2C 协议特有的传输锁、SMBus 模拟、地址管理等逻辑。

## 模块架构

I2C 子系统由四个核心组件构成：

- **adapter/client 设备模型**（`i2c-core-base.c`）：`i2c_adapter` 代表一条 I2C 总线（控制器），`i2c_client` 代表总线上的从设备。通过 `i2c_bus_type` 接入设备模型，支持 OF/ACPI/id_table 三级匹配。
- **i2c_algorithm 传输算法**（`include/linux/i2c.h`）：每个 adapter 绑定一个 `i2c_algorithm`，实现硬件特定的 `master_xfer`/`smbus_xfer`。核心代码通过 `algo` 指针多态调用，是策略模式。
- **SMBus 协议层**（`i2c-core-smbus.c`）：在原始 I2C 消息之上封装 SMBus 协议（BYTE_DATA/WORD_DATA/BLOCK_DATA 等），并提供 I2C 消息组合模拟回退（纯 I2C adapter 也能用 SMBus API）。
- **i2c-dev 字符设备**（`i2c-dev.c`）：暴露 `/dev/i2c-N`，用户空间通过 ioctl（`I2C_RDWR`/`I2C_SMBUS`/`I2C_SLAVE`）访问总线。
- **i2c-mux 多路复用**（`i2c-mux.c`）：通过 `select`/`deselect` 回调创建虚拟 adapter，在转发传输到 parent 前切换硬件通道。

`i2c_bus_type`（`i2c-core-base.c:699`）注册到设备模型，`postcore_initcall(i2c_init)`（`:2162`）在内核启动早期初始化——早于大部分驱动 module_init，确保 bus 就绪后驱动才能注册。

## 调用链路

### adapter 注册与 client 探测

```
i2c_add_adapter(adap)                         [i2c-core-base.c:1679]
  → __i2c_add_adapter(adap)                   [:1640]
    → idr_alloc 动态分配 nr（或用显式 nr）
    → device_register(&adap->dev)             注册到设备模型
    → of_i2c_register_devices(adap)           [i2c-core-of.c:84] 从 DT 创建 client
    → i2c_scan_static_board_info(adap)        [:1409] 消费 board info
    → bus_notify(BUS_NOTIFY_ADD_DEVICE)       → i2cdev_attach_adapter 创建 /dev/i2c-N
```

### i2c_transfer 传输链

```
i2c_transfer(adap, msgs, num)                 [include/linux/i2c.h:846]
  → __i2c_lock_bus(adap)                      RT mutex 串行化
  → __i2c_transfer(adap, msgs, num)           [i2c-core-base.c:2247]
    → adap->algo->master_xfer(adap, msgs, num) [:2287] 硬件特定传输
  → i2c_unlock_bus(adap)
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `i2c_add_adapter` | `i2c-core-base.c:1679` | 动态 bus 号注册 adapter |
| `i2c_add_numbered_adapter` | `:1705` | 显式 bus 号注册 |
| `i2c_new_client_device` | `include/linux/i2c.h:458` | 创建 i2c_client |
| `i2c_transfer` | `include/linux/i2c.h:846` | 传输入口（加锁） |
| `__i2c_transfer` | `i2c-core-base.c:2247` | 传输实现（不加锁） |
| `i2c_smbus_xfer` | `i2c-core-smbus.c:555` | SMBus 传输入口 |
| `i2c_smbus_xfer_emulated` | `:323` | SMBus I2C 模拟回退 |
| `i2cdev_ioctl` | `i2c-dev.c:400` | /dev/i2c-N ioctl |
| `i2c_mux_add_adapter` | `i2c-mux.c:267` | 创建 mux 虚拟 adapter |
| `i2c_device_match` | `i2c-core-base.c:140` | OF→ACPI→id_table 匹配 |

</details>

## 核心实现

### 核心数据结构

四大核心结构定义于 `include/linux/i2c.h`：

```c title="include/linux/i2c.h（节选）"
struct i2c_adapter {              // :733 — 一条 I2C 总线（控制器）
    struct module *owner;
    unsigned int class;           // 允许探测的设备类
    const struct i2c_algorithm *algo;  // ← 传输算法（策略指针）
    void *algo_data;
    struct rt_mutex bus_lock;     // 总线锁（RT mutex，优先级继承）
    struct rt_mutex mux_lock;     // mux 通道锁
    int timeout;                  // 传输超时（ms）
    int retries;                  // 重试次数
    int nr;                       // bus 编号 → /dev/i2c-N
    struct list_head userspace_clients;
    struct device dev;            // 内嵌 device（接入设备模型）
};

struct i2c_client {               // :331 — 总线上的从设备
    unsigned short flags;         // I2C_M_TEN（10-bit 地址）等
    unsigned short addr;          // 从设备 7/10-bit 地址
    char name[I2C_NAME_SIZE];
    struct i2c_adapter *adapter;  // ← 所属总线
    struct device dev;            // 内嵌 device
    int irq;                      // 设备中断号
};

struct i2c_driver {               // :270 — 从设备驱动
    int (*probe)(struct i2c_client *);       // 探测回调
    void (*remove)(struct i2c_client *);
    struct device_driver driver;  // 内嵌 driver（接入设备模型）
    const struct i2c_device_id *id_table;    // 传统匹配表
};

struct i2c_algorithm {            // :544 — 传输算法（策略接口）
    int (*master_xfer)(struct i2c_adapter *, struct i2c_msg *, int);  // 原始 I2C
    int (*smbus_xfer)(struct i2c_adapter *, u16, unsigned short, ...); // SMBus
    u32 (*functionality)(struct i2c_adapter *);  // 功能查询
};
```

**关系**：`i2c_adapter` 持有 `i2c_algorithm` 指针（策略绑定）；`i2c_client` 持有 `adapter` 指针（设备归属总线）；`i2c_driver` 通过 `i2c_bus_type` 匹配 `i2c_client`（驱动-设备匹配）。三者都内嵌 `struct device`/`device_driver`，通过 `dev.type`（`i2c_adapter_type`/`i2c_client_type`）区分。

### adapter 注册与 client 探测

adapter 注册流程（`i2c_add_adapter` → `__i2c_add_adapter`，`:1640`）：

1. `idr_alloc` 动态分配 `nr`（或 `i2c_add_numbered_adapter` 用显式 nr）
2. `device_register(&adap->dev)` 注册到设备模型
3. `of_i2c_register_devices(adap)`（`i2c-core-of.c:84`）遍历 Device Tree 子节点，为每个 `reg` 属性创建 `i2c_client`
4. `i2c_scan_static_board_info(adap)`（`:1409`）消费 arch 代码在 `arch_initcall` 注册的静态 board info
5. `bus_notify(BUS_NOTIFY_ADD_DEVICE)` 通知 i2c-dev 自动创建 `/dev/i2c-N`

client 创建用 `i2c_new_client_device`（`include/linux/i2c.h:458`），设置 `addr`/`flags`/`adapter`，`device_register` 注册。注册后触发 `i2c_bus_type` 的 match → probe 链：`i2c_device_match`（`:140`）按 **OF → ACPI → id_table** 三级匹配 driver，匹配后 `i2c_device_probe`（`:145`）调 `driver->probe(client)`。

### i2c_transfer 传输链

`i2c_transfer`（`include/linux/i2c.h:846`）是传输入口，流程：

```c title="i2c-core-base.c:2247（__i2c_transfer）"
int __i2c_transfer(struct i2c_adapter *adap, struct i2c_msg *msgs, int num)
{
    if (WARN_ON(adap->dev.driver_data == -EUSERS))  // 检查 adapter 是否被挂起
        return -EUSERS;
    // ... tracepoint i2c_transfer ...
    ret = adap->algo->master_xfer(adap, msgs, num);  // :2287 硬件特定传输
    // ... 重试逻辑（adap->retries）...
}
```

`i2c_transfer` 在调 `__i2c_transfer` 前先 `__i2c_lock_bus`（RT mutex），保证同一总线上传输串行执行。`master_xfer` 是硬件特定实现——bit-banging GPIO 驱动用软件模拟 SDA/SCL 时序，SoC I2C 控制器驱动操作硬件寄存器。`i2c_msg` 结构（`uapi/linux/i2c.h`）携带 `addr`（目标从设备）、`flags`（读/写方向、10-bit 地址等）、`buf`/`len`（数据缓冲区）。

### SMBus 协议层与回退模拟

SMBus 是 I2C 的子集协议，增加了 `command byte`、`PEC` 校验、`BLOCK_DATA` 等。`i2c_smbus_xfer`（`i2c-core-smbus.c:555`）的流程：

1. 若 adapter 实现了 `algo->smbus_xfer` → 直接调用（硬件 SMBus 支持）
2. 否则回退到 `i2c_smbus_xfer_emulated`（`:323`）——用 I2C 消息组合模拟 SMBus

**模拟示例**（`BYTE_DATA` 读 = write command byte + read 1 byte）：

```c title="i2c-core-smbus.c:323（i2c_smbus_xfer_emulated 节选）"
// SMBus BYTE_DATA 读：先写 command byte，再读 1 byte（带 repeated start）
msg[0].addr = addr; msg[0].flags = 0;          // write
msg[0].buf = &command; msg[0].len = 1;
msg[1].addr = addr; msg[1].flags = I2C_M_RD;   // read
msg[1].buf = &data;  msg[1].len = 1;
i2c_transfer(adapter, msg, 2);
```

`I2C_FUNC_SMBUS_EMUL`（`uapi/linux/i2c.h:124`）定义可模拟的功能集。这让 SMBus API 在纯 I2C adapter 上也能工作——上层调用者无需关心硬件是否支持 SMBus。

### i2c-dev 字符设备

`/dev/i2c-N`（主设备号 89）是用户空间访问 I2C 总线的接口。`i2c-dev.c` 通过 `bus_register_notifier`（`:774`）监听 adapter 增删事件，自动创建/销毁字符设备。

```c title="drivers/i2c/i2c-dev.c:639（file_operations）"
static const struct file_operations i2cdev_fops = {
    .read           = i2cdev_read,       // 简单读（i2c_master_recv）
    .write          = i2cdev_write,      // 简单写（i2c_master_send）
    .unlocked_ioctl = i2cdev_ioctl,      // I2C_RDWR/I2C_SMBUS/I2C_SLAVE...
    .open           = i2cdev_open,
    .release        = i2cdev_release,
};
```

`i2cdev_open`（`:598`）创建一个**匿名 `i2c_client`**（不注册到设备模型），作为访问句柄存入 `file->private_data`。ioctl 是主要接口：

| ioctl | 功能 |
|-------|------|
| `I2C_SLAVE` / `I2C_SLAVE_FORCE` | 设置从设备地址（后者不检查冲突） |
| `I2C_RDWR` | 直接 I2C 传输（最多 42 条 `i2c_msg`，组合消息只有一个 STOP） |
| `I2C_SMBUS` | SMBus 传输（BYTE_DATA/WORD_DATA/BLOCK_DATA 等） |
| `I2C_FUNCS` | 查询 adapter 功能掩码 |
| `I2C_PEC` | 启用/禁用 PEC 校验 |
| `I2C_TENBIT` | 启用/禁用 10-bit 地址 |

### i2c-mux 多路复用

I2C mux（如 PCA954x）是一条物理总线下挂多个通道的硬件开关。`i2c-mux.c` 为每个通道创建一个**虚拟 adapter**，通过 `select`/`deselect` 回调在转发前切换通道：

```c title="drivers/i2c/i2c-mux.c:58（mux 传输转发）"
static int i2c_mux_master_xfer(struct i2c_adapter *adap,
                               struct i2c_msg msgs[], int num)
{
    ret = muxc->select(muxc, priv->chan_id);    // 1. 选择通道（硬件切换）
    if (ret >= 0)
        ret = i2c_transfer(parent, msgs, num);  // 2. 转发到 parent adapter
    if (muxc->deselect)
        muxc->deselect(muxc, priv->chan_id);    // 3. 取消选择
    return ret;
}
```

`i2c_mux_add_adapter`（`:267`）**动态构建** `i2c_algorithm`（根据 parent 支持的 `master_xfer`/`smbus_xfer` 选择转发函数），`functionality` 始终转发到 parent（`:122`）。

**两种锁模式**：
- `mux_locked`：虚拟 adapter 只锁 `mux_lock`，不同通道可并行（各自 `select` 后独立传输）
- 非 `mux_locked`：虚拟 adapter 锁 parent 的 `bus_lock + mux_lock`，完全串行化

`I2C_LOCK_ROOT_ADAPTER`（锁整棵树）vs `I2C_LOCK_SEGMENT`（只锁当前段）提供两级锁粒度。

## 设计模式

| 模式 | 位置 | 说明 |
|------|------|------|
| 总线设备模型特化 | `i2c_bus_type`（`i2c-core-base.c:699`） | `bus_type` 的 I2C 实例，复用 match/probe 机制 |
| 策略模式 | `i2c_algorithm`（`include/linux/i2c.h:544`） | 每个 adapter 绑定自己的 `master_xfer`，核心代码多态调用 |
| 字符设备接口 | `i2cdev_fops`（`i2c-dev.c:639`） | 通过 VFS `file_operations` 暴露 `/dev/i2c-N` |
| 装饰器/代理 | `i2c_mux_priv`（`i2c-mux.c:32`） | 虚拟 adapter 包装 parent，插入 `select`/`deselect` |
| 观察者 | `bus_register_notifier`（`i2c-dev.c:774`） | i2c-dev 监听 adapter 增删事件 |
| 回退模拟 | `i2c_smbus_xfer_emulated`（`i2c-core-smbus.c:323`） | 纯 I2C adapter 用消息组合模拟 SMBus |

## 模块间交互

- **i2c 与 drivers/**：`busses/` 下的驱动（如 `i2c-qcom-cci`、`i2c-designware`、`i2c-gpio`）填充 `i2c_adapter` + `i2c_algorithm`，调 `i2c_add_adapter` 注册，`master_xfer` 实现硬件寄存器操作。
- **i2c 与 fs/**：`i2c-dev.c` 注册字符设备区域 `MKDEV(I2C_MAJOR=89, 0)`（`:765`），通过 `cdev_device_add` 创建 `/dev/i2c-N`。
- **i2c 与 arch/**：arch 代码在 `arch_initcall` 调 `i2c_register_board_info`（`i2c-boardinfo.c:51`）注册静态设备信息；DT 设备由 `of_i2c_register_devices` 创建。
- **i2c 与设备模型**：`bus_register(&i2c_bus_type)`（`:2122`）注册总线，`device_register`/`bus_for_each_drv` 接入匹配机制。
- **initcall**：`postcore_initcall(i2c_init)`（`:2162`），早于 `module_init`（大部分驱动），晚于 `arch_initcall`（board info），确保时序正确。

## 扩展方式

新增一个 I2C 控制器驱动（如 `i2c-qcom-cci`）：

1. 实现 `i2c_algorithm`（`master_xfer` + `functionality`，可选 `smbus_xfer`）
2. probe 中填充 `i2c_adapter` 结构（`algo`/`owner`/`name`/`nr`/`dev.parent`）
3. 调 `devm_i2c_add_adapter` / `i2c_add_adapter` 注册
4. remove 中 adapter 自动注销（devm 或 `i2c_del_adapter`）

**⚠️ of_node 引用计数**：adapter 的 `dev.of_node` 若用 `of_node_get()` 增加引用，必须在 `i2c_del_adapter()` **之前**缓存指针再 `of_node_put()`——因为 `i2c_del_adapter()` 末尾会 `memset(&adap->dev, 0, ...)` 清零 `of_node`，放在之后的 `of_node_put(NULL)` 是 no-op。这正是 [qcom-CCI refcount leak 修复](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-8eacce-qcom-cci-del-adapter-of-node-leak)和 [mtd 同类修复](/vibe-reading/articles/OS/Linux/PRs/linux-commit-56570b-mtd-del-device-of-node-refcount)解决的问题。该 `adap->dev.of_node = of_node_get()` 模式由 [9fd049「通用化 OF I2C 支持」](/vibe-reading/articles/OS/Linux/PRs/linux-commit-9fd049-of-i2c-generalize-of-support) 于 2010 年确立。
