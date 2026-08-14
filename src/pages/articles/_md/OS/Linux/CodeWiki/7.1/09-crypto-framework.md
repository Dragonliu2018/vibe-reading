---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "加密框架"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "crypto", "加密", "模板", "AEAD"]
description: "Linux 内核加密 API——crypto_alg 注册表、crypto_type 策略 frontend、模板组合（gcm(aes)）、异步 transform 与 larval 自检。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

`crypto/` 目录实现了 Linux 内核的统一加密 API 框架。它之所以作为独立子系统存在，是因为加密算法具有强烈的可替换性需求：同一算法（如 AES）可能有纯软件实现、SIMD 加速实现、硬件加速器实现三种版本，调用方不应关心底层用的是哪一种。`crypto/` 框架的核心价值在于将"算法注册"与"算法使用"彻底解耦——IPsec、fscrypt、TLS offload 等消费方只说"我要一个名叫 `gcm(aes)` 的 AEAD 算法"，框架负责找到最高优先级的可用实现并实例化。

`crypto/` 的核心职责边界：

- **算法注册表**：维护全局算法链表 `crypto_alg_list`，所有加密算法（无论内置还是模块）通过 `crypto_register_alg` 注册到同一张表，支持按名称查找、按优先级排序、按需加载。
- **类型策略层**：通过 `crypto_type` frontend 机制将算法分为 SKCIPHER、AEAD、AHASH、SHASH、AKCIPHER、RNG 等类型，每种类型有独立的初始化策略和操作接口，新增类型无需修改核心查找逻辑。
- **模板组合**：通过 `crypto_template` 机制实现模式与基础算法的正交组合——`gcm(aes)` 不需要单独实现，而是由 GCM 模板在运行时组合 GHASH 和 AES 两个底层算法，将 M×N 种组合降为 M+N 种实现。
- **异步透明**：支持同步和异步两种执行模型，硬件加速器返回 `-EINPROGRESS` 异步完成，软件实现同步返回，调用方通过统一的 `crypto_wait_req` 封装屏蔽差异。

## 模块架构

`crypto/` 框架内部由五个核心概念构成：算法描述符（`crypto_alg`）、transform 实例（`crypto_tfm`）、类型 frontend（`crypto_type`）、模板组合机制（`crypto_template`）、异步请求（`crypto_async_request`）。它们不是平行模块，而是层层包裹的关系——算法描述符描述静态能力，frontend 赋予类型策略，模板在运行时组合出新算法，transform 是算法的使用实例，异步请求是 transform 的执行载体。

```
┌──────────────────────────────────────────────────────────────────────┐
│                    crypto/ 模块内部结构                                 │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ① 算法描述符注册表 (crypto_alg)                                       │
│     crypto_alg_list ── 全局链表 (RWSEM 保护)                           │
│     每个 crypto_alg: cra_name / cra_driver_name / cra_priority /      │
│                      cra_flags / cra_type / cra_u 联合体 / cra_module  │
│     │                                                                 │
│     ▼                                                                 │
│  ② 类型 frontend (crypto_type)                                        │
│     cra_type 指向 crypto_type 策略接口                                 │
│     ├── SKCIPHER  → crypto_skcipher_type  (skcipher_alg 操作集)        │
│     ├── AEAD      → crypto_aead_type      (aead_alg 操作集)            │
│     ├── AHASH     → crypto_ahash_type     (ahash_alg 操作集)           │
│     ├── SHASH     → crypto_shash_type     (shash_alg 操作集)           │
│     ├── AKCIPHER  → crypto_akcipher_type  (akcipher_alg 操作集)        │
│     └── RNG       → crypto_rng_type       (rng_alg 操作集)             │
│     │                                                                 │
│     ▼                                                                 │
│  ③ 模板组合 (crypto_template)                                          │
│     crypto_template_list ── 全局模板链表                                │
│     create 回调: 运行时组合底层算法 → 生成 crypto_alg 实例               │
│     示例: gcm(aes) = GCM模板 + AES算法 + GHASH算法                     │
│     │                                                                 │
│     ▼                                                                 │
│  ④ transform 实例 (crypto_tfm)                                        │
│     crypto_alloc_tfm → crypto_create_tfm → 分配 + frontend->init_tfm  │
│     内存布局: [外层类型结构][crypto_tfm][算法私有上下文]                  │
│     │                                                                 │
│     ▼                                                                 │
│  ⑤ 异步请求 (crypto_async_request)                                    │
│     complete 回调 / data / tfm / flags                                │
│     返回值: 0(同步完成) / -EINPROGRESS(异步提交) / -EBUSY(队列满)      │
│     crypto_queue: 硬件加速器请求队列                                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

第一层 `crypto_alg` 是静态描述符，每个算法注册时填入自己的名称、优先级、flags 和操作函数集。第二层 `crypto_type` 是策略接口——`cra_type` 字段指向一个 `crypto_type` 结构体，其中包含 `ctxsize`（上下文大小）、`init_tfm`（transform 初始化）、`maskclear`/`maskset`（flag 过滤）等回调。查找时框架根据调用方请求的类型 mask 过滤算法，只有 `cra_type` 匹配的算法才会被选中。第三层 `crypto_template` 是组合机制，模板的 `create` 回调在运行时被调用，它会 grab 底层算法、组装出新 `crypto_alg` 实例并注册。第四层 `crypto_tfm` 是调用方实际持有和使用的 transform 对象，第五层 `crypto_async_request` 是每次加密操作的请求载体。

辅助设施包括 `crypto_larval`（蛰伏状态，等待自检完成）、`crypto_spawn`（模板实例对底层算法的引用追踪）、`crypto_chain` notifier（算法注册/注销事件通知）。

## 调用链路

加密框架有两条核心链路：注册查找链（算法如何进入注册表并被找到）和分配链（找到算法后如何创建可用的 transform 实例）。

```
=== 注册查找链 ===

crypto_register_alg(alg)                    [crypto/algapi.c:431]
  │  输入: struct crypto_alg *alg (算法描述符)
  │  产出: alg 挂入 crypto_alg_list, 可被查找
  │
  ├── crypto_check_alg(alg)                 [algapi.c:278]
  │     检查名称合法、优先级非负、回调非空
  │
  ├── down_write(crypto_alg_sem)            [algapi.c:445]
  │     获取全局 RWSEM 写锁
  │
  ├── __crypto_register_alg(alg)            [algapi.c:301]
  │     ├── 加入 crypto_alg_list 链表头
  │     └── 若 CONFIG_CRYPTO_MANAGER_SELFTESTS:
  │         创建 crypto_larval (蛰伏状态)
  │         crypto_schedule_test(larval)    → 异步自检
  │
  └── up_write(crypto_alg_sem)


=== 按需查找链 ===

crypto_find_alg(name, type, mask, node)     [crypto/api.c:589]
  │  输入: const char *name (如 "gcm(aes)")
  │        const struct crypto_type *type (如 &crypto_aead_type)
  │  产出: struct crypto_alg * (已注册且自检通过的算法)
  │
  ▼
crypto_alg_mod_lookup(name, type, mask)     [crypto/api.c:338]
  │
  ├── __crypto_alg_lookup(name)             [crypto/api.c:58]
  │     down_read(crypto_alg_sem)
  │     遍历 crypto_alg_list:
  │       exact match  (cra_driver_name == name) → 直接返回
  │       fuzzy match  (cra_name == name)       → 按 priority 排序, 选最高
  │     up_read(crypto_alg_sem)
  │
  ├── 若未找到 → request_module("crypto-%s", name)
  │     触发内核模块自动加载 (如 crypto-gcm.ko)
  │     加载后再次 __crypto_alg_lookup
  │
  └── 若仍未找到 → crypto_larval_lookup
        创建临时 larval 占位, 等待模块加载后触发


=== 分配链 ===

crypto_alloc_tfm_node(alg, type, mask, node) [crypto/api.c:627]
  │  输入: struct crypto_alg *alg
  │        const struct crypto_type *frontend
  │  产出: struct crypto_tfm * (可用的 transform 实例)
  │
  ├── crypto_find_alg(name, type, mask)     → 找到 crypto_alg
  │
  ├── crypto_create_tfm_node(alg, frontend) [crypto/api.c:589]
  │     ├── crypto_alloc_tfmmem()           → 分配内存
  │     │   布局: [外层类型结构][crypto_tfm][算法上下文]
  │     │   大小: tfmsize + sizeof(crypto_tfm) + extsize
  │     │
  │     ├── frontend->init_tfm(tfm)         → 类型特定初始化
  │     │   (如 skcipher_tfm_init 设置 IV/cb)
  │     │
  │     └── alg->cra_init(tfm)             → 算法特定初始化
  │         (如 AES 设置轮密钥)
  │
  └── 返回外层类型结构指针 (如 crypto_skcipher *)
      (内部包含 crypto_tfm, 通过 __crypto_skcipher_cast 转换)
```

`crypto_find_alg` 是查找链的核心入口。它先在已注册链表中做 exact/fuzzy 两轮匹配——exact match 匹配 `cra_driver_name`（具体实现名，如 `"aes-aesni"`），fuzzy match 匹配 `cra_name`（通用名，如 `"aes"`），多命中时按 `cra_priority` 选最高。如果链表中找不到，`request_module("crypto-%s", name)` 触发模块自动加载——例如请求 `"gcm(aes)"` 会加载 `crypto-gcm.ko` 模块。模块加载后其 `module_init` 会调用 `crypto_register_alg` 将算法注册进链表，此时重试查找即可命中。

`crypto_alloc_tfm_node` 是分配链的核心。它先通过查找链拿到 `crypto_alg`，再调用 `crypto_create_tfm_node` 分配 transform 实例。内存布局是三层叠加：最外层是类型特定结构（如 `crypto_skcipher`），中间是 `crypto_tfm` 通用体，最内层是算法私有上下文。`frontend->init_tfm` 负责类型层初始化（设置 callback、分配 IV buffer 等），`alg->cra_init` 负责算法层初始化（如 AES 扩展轮密钥）。

<details>
<summary>方法速查表</summary>

| 方法名 | 文件:行号 | 一行职责 | 关键设计决策 |
|--------|-----------|---------|-------------|
| `crypto_register_alg` | crypto/algapi.c:431 | 注册单个算法到全局链表 | 注册后创建 larval 异步自检 |
| `crypto_register_instance` | crypto/algapi.c:643 | 注册模板生成的算法实例 | 设 CRYPTO_ALG_INSTANCE 标志，带 spawns 链 |
| `crypto_register_template` | crypto/algapi.c:535 | 注册模板到 template_list | 模板 create 回调延迟到查找时执行 |
| `crypto_find_alg` | crypto/api.c:589 | 按名称+类型查找算法 | 先链表查找，失败触发 request_module |
| `crypto_alg_mod_lookup` | crypto/api.c:338 | 查找+按需加载+larval 占位 | 三级降级：链表 → 模块加载 → larval |
| `__crypto_alg_lookup` | crypto/api.c:58 | 遍历链表做 exact/fuzzy 匹配 | exact match 优先，fuzzy 按 priority |
| `crypto_alloc_tfm_node` | crypto/api.c:627 | 分配 transform 实例 | NUMA aware，指定 node 分配 |
| `crypto_create_tfm_node` | crypto/api.c:589 | 分配内存 + init_tfm + cra_init | 三层内存布局：[类型][tfm][ctx] |
| `crypto_alloc_skcipher` | crypto/skcipher.c:636 | 分配 SKCIPHER 类型 tfm | 类型封装，内部调 crypto_alloc_tfm |
| `crypto_alloc_aead` | crypto/aead.c:201 | 分配 AEAD 类型 tfm | 类型封装 |
| `crypto_destroy_tfm` | crypto/api.c:671 | 销毁 transform 实例 | cra_exit 回调 + kfree |
| `crypto_larval_lookup` | crypto/api.c:290 | 创建临时 larval 等待模块加载 | larval 完成后触发 notifier 通知 |
| `crypto_schedule_test` | crypto/algapi.c | 异步调度算法自检 | 自检通过后 larval → adult |
| `crypto_lookup_template` | crypto/algapi.c:636 | 按名称查找模板 | 用于模板实例的按需创建 |
| `crypto_gcm_create` | crypto/gcm.c:397 | GCM 模板 create 回调 | grab skcipher + ghash，组合 aead_alg |
| `crypto_grab_spawn` | crypto/algapi.c:721 | 模板实例 grab 底层算法引用 | crypto_spawn 追踪依赖，级联清理 |
| `crypto_enqueue_request` | crypto/algapi.c:939 | 请求入队硬件加速器 | crypto_queue 链表，backlog 溢出 |
| `crypto_dequeue_request` | crypto/algapi.c:955 | 从队列取出请求执行 | 按队列优先级调度 |
| `crypto_wait_req` | include/linux/crypto.h:381 | 同步等待异步完成 | wait_for_completion + 预置回调 |
| `crypto_request_complete` | include/crypto/algapi.h:267 | 异步完成回调 | req->complete(req->data, err) |

</details>

## 核心实现

### 核心数据结构

**crypto_alg**（include/linux/crypto.h:332）是算法描述符——每个加密算法在注册时填充此结构体并挂入全局链表：

```c title="include/linux/crypto.h:332 (简化)"
struct crypto_alg {
    struct list_head cra_list;         // 挂入 crypto_alg_list
    char cra_name[CRYPTO_MAX_ALG_NAME];    // 通用名, 如 "aes"
    char cra_driver_name[CRYPTO_MAX_ALG_NAME]; // 具体实现名, 如 "aes-aesni"
    int cra_priority;                   // 优先级, 硬件 > 软件, 高优先级被选中
    u32 cra_flags;                      // CRYPTO_ALG_ASYNC | CRYPTO_ALG_INSTANCE | ...
    const struct crypto_type *cra_type; // 指向 frontend 策略
    union {                             // cra_u: 类型特定操作集联合体
        struct cipher_alg cipher;       //   CIPHER
        struct skcipher_alg skcipher;   //   SKCIPHER
        struct aead_alg aead;           //   AEAD
        struct hash_alg hash;           //   HASH (旧式)
        struct shash_alg shash;         //   SHASH
        struct ahash_alg ahash;         //   AHASH
        struct akcipher_alg akcipher;   //   AKCIPHER
        struct rng_alg rng;             //   RNG
        struct kpp_alg kpp;             //   KPP
        struct sig_alg sig;             //   SIG
    } cra_u;
    struct module *cra_module;          // 所属内核模块, 引用计数管理
    int (*cra_init)(struct crypto_tfm *tfm);  // 算法特定初始化
    void (*cra_exit)(struct crypto_tfm *tfm); // 算法特定清理
};
```

`cra_name` 与 `cra_driver_name` 的分离是关键设计：`cra_name` 是通用算法名（如 `"aes"`），多个实现可以共享同一个 `cra_name`；`cra_driver_name` 是具体实现名（如 `"aes-aesni"`、`"aes-generic"`），全局唯一。查找时 exact match 匹配 `cra_driver_name`，fuzzy match 匹配 `cra_name`，多命中时 `cra_priority` 高者胜出——硬件加速器驱动注册时设置高 priority（如 300），软件实现设置低 priority（如 100），从而自动优先使用硬件。

`cra_u` 联合体让不同类型算法的操作集共享同一块内存空间，由 `cra_type` 指明当前联合体中哪个成员有效。这比 `void *` 更类型安全，也比为每种类型单独定义结构体更节省内存。

**crypto_tfm**（include/linux/crypto.h:411）是 transform 实例——调用方通过 `crypto_alloc_tfm` 获得的对象，包含算法引用和运行时上下文：

```c title="include/linux/crypto.h:411 (简化)"
struct crypto_tfm {
    u32 crt_flags;                      // 运行时标志
    int node;                           // NUMA node
    struct crypto_alg *__crt_alg;       // 指向所属 crypto_alg
    void *__crt_ctx[] __attribute__((__aligned__(__alignof__(max_align_t))));
    // 算法私有上下文, 紧跟在 crypto_tfm 之后
};
```

`crypto_tfm` 的内存布局是三层叠加设计：

```
┌──────────────────────────┐
│  外层类型结构              │  crypto_skcipher / crypto_aead / ...
│  (tfmsize 字节)           │  类型特定字段 (如 IV 长度, blocksize)
├──────────────────────────┤
│  crypto_tfm               │  __crt_alg, crt_flags
├──────────────────────────┤
│  算法私有上下文             │  extsize 字节
│  (cra_ctxsize 决定)       │  如 AES 轮密钥表
└──────────────────────────┘
```

外层类型结构、`crypto_tfm`、上下文三块内存在一次 `kmalloc` 中分配，通过指针偏移相互访问。`crypto_skcipher` 内嵌了 `crypto_tfm`，调用方拿到的是 `crypto_skcipher *`，通过 `crypto_skcipher_tfm(sk)` 取出内嵌的 `crypto_tfm`，再通过 `__crypto_tfm_alg(tfm)` 取到 `crypto_alg`。这种布局减少了内存碎片，对 cache 友好。

**crypto_async_request**（include/linux/crypto.h:188）是异步请求基类，所有类型的加密操作请求都以此开头：

```c title="include/linux/crypto.h:188 (简化)"
struct crypto_async_request {
    struct list_head list;              // 挂入 crypto_queue
    crypto_completion_t complete;       // 完成回调函数指针
    void *data;                         // 调用方私有数据
    struct crypto_tfm *tfm;             // 所属 transform
    u32 flags;                          // 请求标志
};
```

**crypto_larval**（crypto/internal.h:28）是蛰伏状态——算法注册后自检完成前的临时状态：

```c title="crypto/internal.h:28 (简化)"
struct crypto_larval {
    struct crypto_alg alg;              // 伪装成 crypto_alg 挂入链表
    struct crypto_alg *adult;           // 自检通过后指向真正的算法
    struct completion completion;       // 自检完成信号量
};
```

### 算法注册与查找

算法注册表的核心是全局链表 `crypto_alg_list`（crypto/algapi.c:22）和保护它的 RWSEM `crypto_alg_sem`（crypto/algapi.c:21）。读写锁的选择很关键：查找（读）远多于注册/注销（写），RWSEM 允许并发查找，仅在注册新算法时独占。

`crypto_register_alg`（crypto/algapi.c:431）的注册流程：先调用 `crypto_check_alg` 验证算法描述符合法性（名称非空、长度合规、优先级非负），然后获取写锁 `down_write(crypto_alg_sem)`，调用 `__crypto_register_alg` 将算法加入链表。如果内核启用了 `CONFIG_CRYPTO_MANAGER_SELFTESTS`，注册时不会直接暴露算法，而是创建一个 `crypto_larval` 占位——larval 伪装成 `crypto_alg` 挂入链表，同时 `crypto_schedule_test` 异步调度自检。自检通过后 larval 的 `adult` 指针指向真正的算法，之前等待的查找请求被唤醒。

查找链 `crypto_find_alg`（crypto/api.c:589）→ `crypto_alg_mod_lookup`（crypto/api.c:338）实现了三级降级策略：

1. **链表查找**：`__crypto_alg_lookup`（crypto/api.c:58）在 `down_read` 保护下遍历 `crypto_alg_list`，先做 exact match（`cra_driver_name` 精确匹配），再做 fuzzy match（`cra_name` 模糊匹配，多命中选最高 `cra_priority`）。
2. **模块加载**：链表未命中时调用 `request_module("crypto-%s", name)` 触发内核模块自动加载。例如请求 `"gcm(aes)"` 会尝试加载 `crypto-gcm.ko`，该模块的 `module_init` 会注册 GCM 模板，模板的 `create` 回调被触发后生成 `gcm(aes)` 算法实例并注册到链表。
3. **larval 占位**：模块加载后重试查找仍可能遇到自检未完成的情况，此时 `crypto_larval_lookup`（crypto/api.c:290）创建临时 larval，调用方通过 `crypto_probing_notify` 等待模块加载和自检完成后被唤醒。

`cra_priority` 的排序机制让硬件加速对调用者完全透明：AES-NI 实现注册时设置 priority=300，generic 实现设置 priority=100。当两者都注册时，查找 `"aes"` 的 fuzzy match 自动选中 AES-NI；如果 AES-NI 模块被卸载，generic 实现自动接管。

### 算法类型与 frontend

`crypto_type`（crypto/internal.h:36）是算法类型的策略接口——frontend：

```c title="crypto/internal.h:36 (简化)"
struct crypto_type {
    unsigned int (*ctxsize)(struct crypto_alg *alg, u32 type, u32 mask);
    int (*init_tfm)(struct crypto_tfm *tfm);
    void (*show)(struct seq_file *m, struct crypto_alg *alg);
    int (*maskclear)(struct crypto_alg *alg, u32 mask);
    int (*maskset)(struct crypto_alg *alg, u32 type, u32 mask);
    unsigned int type;
    unsigned int tfmsize;
    unsigned int algsize;
};
```

内核定义了多个 `crypto_type` 实例，每个对应一种算法类型：

| 类型常量 | cra_type 实例 | 类型结构 | 操作结构 | 说明 |
|---------|--------------|---------|---------|------|
| 0x01 | NULL（旧式） | cipher_alg | cipher_alg | 原始分组密码 |
| 0x05 | `crypto_skcipher_type` | crypto_skcipher | skcipher_alg | 对称密钥分组密码 |
| 0x04 | `crypto_lskcipher_type` | crypto_lskcipher | lskcipher_alg | 轻量级 skcipher |
| 0x03 | `crypto_aead_type` | crypto_aead | aead_alg | 认证加密 |
| 0x0f | `crypto_ahash_type` | crypto_ahash | ahash_alg | 异步哈希 |
| 0x0e | `crypto_shash_type` | crypto_shash | shash_alg | 同步哈希 |
| 0x06 | `crypto_akcipher_type` | crypto_akcipher | akcipher_alg | 非对称密钥 |
| 0x0c | `crypto_rng_type` | crypto_rng | rng_alg | 随机数生成器 |
| 0x08 | — | crypto_kpp | kpp_alg | 密钥协商 |
| 0x07 | — | crypto_sig | sig_alg | 签名 |

**为什么 frontend 而非 switch-case**：如果 `crypto_create_tfm` 用 switch-case 区分类型，每新增一种类型就要修改 `api.c` 核心代码——违反开闭原则。`crypto_type` 策略接口让新增类型只需定义一个新的 `crypto_type` 实例并让对应算法的 `cra_type` 指向它，核心查找和分配代码完全不需要改动。`frontend->init_tfm` 负责类型特定的 transform 初始化（如 skcipher 分配 IV buffer、aead 设置 authsize），`frontend->ctxsize` 计算类型特定上下文大小，`frontend->maskclear`/`maskset` 根据调用方的 type/mask 过滤不匹配的算法。

### 模板机制

模板是加密框架最精妙的设计——它让加密模式（如 GCM、CTR、CBC）与基础算法（如 AES、ChaCha20）正交组合，无需为每种组合编写独立实现。

`crypto_template`（include/crypto/algapi.h:74）描述一个模板：

```c title="include/crypto/algapi.h:74 (简化)"
struct crypto_template {
    struct list_head list;              // 挂入 crypto_template_list
    struct hlist_head instances;        // 此模板创建的实例链
    struct module *module;
    int (*create)(struct crypto_template *tmpl,
                  struct rtattr **tb);  // 核心: 创建组合算法实例
    char name[CRYPTO_MAX_ALG_NAME];
};
```

模板通过 `crypto_register_template`（crypto/algapi.c:535）注册到全局链表 `crypto_template_list`。当查找链遇到 `"gcm(aes)"` 这种带括号的名称时，会解析出模板名 `"gcm"` 和基础算法名 `"aes"`，调用 `crypto_lookup_template("gcm")` 找到 GCM 模板，再调用模板的 `create` 回调 `crypto_gcm_create`（crypto/gcm.c:397）。

GCM 模板的 `create` 回调做以下事情：

```c title="crypto/gcm.c:397 (crypto_gcm_create 简化)"
static int crypto_gcm_create(struct crypto_template *tmpl,
                             struct rtattr **tb)
{
    // 1. 解析参数: 获取基础算法名 (如 "aes")
    algname = crypto_attr_alg_name(tb[1]);

    // 2. grab 底层 skcipher (AES-CTR)
    crypto_grab_skcipher(&spawn, ...);    // → crypto_spawn 追踪依赖

    // 3. grab GHASH 算法
    crypto_grab_ahash(&ghash_spawn, ...);

    // 4. 组装 aead_alg 实例
    //    设置 cra_name = "gcm(aes)"
    //    设置 cra_driver_name = "gcm_base(ctr(aes-generic),ghash-generic)"
    //    设置 cra_type = &crypto_aead_type
    //    设置操作回调 (encrypt/decrypt/setkey)

    // 5. 注册实例
    aead_register_instance(tmpl, inst);   // → crypto_register_instance
}
```

实例命名由 `__crypto_inst_setname`（crypto/algapi.c:924）完成，格式为 `"gcm(aes)"`——模板名括号包裹基础算法名。模板可以嵌套：`gcm_base(ctr(aes),ghash)` 表示 GCM 基于 CTR 模式和 GHASH 的组合，其中 CTR 本身又是 AES 的模板实例。

**O(M+N) 而非 O(M*N)**：假设有 M 种模式（GCM、CBC、CTR、XTS...）和 N 种基础算法（AES、ChaCha20、Camellia...），不使用模板需要实现 M×N 个算法；使用模板只需实现 M 个模板 + N 个基础算法，共 M+N 个。运行时模板 `create` 回调动态组合出所需的 M×N 种实例，且组合可以嵌套。

**crypto_spawn 依赖追踪**：模板实例通过 `crypto_spawn`（include/crypto/algapi.h:87）引用底层算法。`crypto_grab_spawn`（crypto/algapi.c:721）在创建实例时 grab 底层算法的引用，确保底层算法不会在实例还在使用时被卸载。当底层算法被注销时，`crypto_remove_spawns`（crypto/algapi.c:165）级联清理所有依赖它的 spawn——先标记 spawn 为 dead，再级联清理依赖这些 spawn 的更上层实例。

### 同步与异步

加密框架支持同步和异步两种执行模型。`CRYPTO_ALG_ASYNC`（include/linux/crypto.h:44，值 0x80）标志位标明算法是否支持异步操作。软件实现通常是同步的——调用 `crypto_skcipher_encrypt` 直接计算并返回 0；硬件加速器实现通常是异步的——调用后请求被提交到硬件队列，函数立即返回 `-EINPROGRESS`，硬件完成后通过 `crypto_request_complete` 回调通知调用方。

异步完成的返回值语义：

- **0**：同步完成，结果已就绪（即使算法声明了 ASYNC，也可能对小数据量同步完成）。
- **-EINPROGRESS**：请求已提交到硬件，尚未完成。调用方不能访问输出 buffer，必须等待 complete 回调被调用。
- **-EBUSY**：硬件队列已满，请求被放入 backlog 队列。调用方同样需要等待 complete 回调。

`crypto_request_complete`（include/crypto/algapi.h:267）是完成回调的统一入口：`req->complete(req->data, err)`。硬件中断处理函数在 DMA 完成后调用此函数，`err` 为 0 表示成功，负值表示硬件错误。

**crypto_wait_req 同步封装**（include/linux/crypto.h:381）：对于不想处理异步逻辑的调用方，框架提供了同步等待封装：

```c title="include/linux/crypto.h:381 (简化)"
struct crypto_wait {
    struct completion completion;
    int err;
};

static inline int crypto_wait_req(int err, struct crypto_wait *wait)
{
    if (err == -EINPROGRESS || err == -EBUSY) {
        wait_for_completion(&wait->completion);  // 阻塞等待
        err = wait->err;                         // 取回异步结果
    }
    return err;
}
```

调用方预先用 `crypto_init_wait` 初始化 `crypto_wait`，将 `crypto_req_done`（crypto/api.c:704）设为请求的 complete 回调，`crypto_wait` 的地址设为 data。回调触发时 `crypto_req_done` 设置 `wait->err` 并调用 `complete(&wait->completion)`，唤醒阻塞的调用方。这种封装让同步调用方不需要理解异步机制，同时不阻塞硬件加速器的并行执行能力。

**crypto_queue 硬件队列**（include/crypto/algapi.h:102）：硬件加速器维护的请求队列，`crypto_enqueue_request`（crypto/algapi.c:939）将请求加入队列尾部，`crypto_dequeue_request`（crypto/algapi.c:955）从队列头部取出执行。队列有 `max_qlen` 限制，溢出时返回 `-EBUSY`，请求被放入 backlog 队列在后续处理。这种设计让硬件加速器能批量处理请求，提高 DMA 利用率，同时避免无限制排队导致内存耗尽。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 注册表（Registry） | `crypto_alg_list` + `crypto_alg_sem` RWSEM (algapi.c:21-22) | 所有算法注册到统一链表，查找方通过名称+类型获取，`crypto_mod_get/put` 管理引用计数，解耦算法提供者与消费者 |
| 策略（Strategy） | `crypto_type` frontend (internal.h:36-50) | 算法类型作为策略接口，`cra_type` 指向具体策略实现，新增类型只注册 `crypto_type` 不改核心代码——开闭原则 |
| 装饰器/组合（Decorator/Composite） | `crypto_template` + `crypto_spawn` (algapi.h:74-100) | 模板在运行时组合基础算法生成新实例，`gcm(aes)` 装饰 AES 添加认证加密能力，可嵌套组合 |
| 工厂（Factory） | `crypto_larval_lookup` + `crypto_probing_notify` (api.c:290-336) | 按需创建：查找失败时 `request_module` 加载驱动，larval 占位等待自检，工厂延迟到真正需要时才实例化 |
| 对象池（Object Pool） | `crypto_clone_tfm` (api.c:563-587) | 多个 transform 共享同一 `crypto_alg` 引用，`crypto_mod_get` 增加模块引用计数而非重新查找，减少链表遍历开销 |
| 观察者（Observer） | `crypto_chain` notifier (api.c:31) | 算法注册/注销时通过 `crypto_register_notifier` 通知订阅者，模板实例可监听底层算法变化做级联响应 |

注册表模式是整个框架的基石。`crypto_alg_list` 作为全局注册表，用 RWSEM 而非 spinlock 保护——查找（读路径）可以并发执行，只有注册/注销（写路径）需要独占。`crypto_mod_get`（crypto/api.c:43）在查找命中后增加算法所属模块的引用计数，防止算法在使用中被卸载；`crypto_mod_put`（crypto/api.c:50）在使用完毕后释放引用。这种引用计数设计让内核模块的热插拔成为可能。

策略模式体现在 `crypto_type` frontend 上。传统 switch-case 方式在新增类型时需要修改 `crypto_create_tfm` 核心函数，每加一种类型就多一个 case 分支——这违反开闭原则。`crypto_type` 将类型特定逻辑抽象为策略接口（`init_tfm`、`ctxsize`、`maskclear`、`maskset`），核心代码只调用 `frontend->init_tfm(tfm)` 而不关心具体类型。新增 AKCIPHER 类型时，只需定义 `crypto_akcipher_type` 并让对应算法的 `cra_type` 指向它，`api.c` 核心代码零改动。

装饰器/组合模式体现在模板机制上。GCM 模板"装饰"AES——它不重新实现 AES 的分组加密，而是 grab 一个 AES 的 skcipher spawn，在自己的 encrypt/decrypt 回调中调用底层 AES 的 `crypto_skcipher_encrypt` 完成分组加密，在外层添加 GHASH 认证标签计算。这种模式可以嵌套：`rfc4106(gcm(base(ctr(aes))))` 是四层装饰，每层只添加自己的逻辑。

## 模块间交互

`crypto/` 框架作为内核的安全基础设施，被大量子系统直接调用。这些调用方通过 `crypto_alloc_*` API 获取 transform 实例，使用完毕后 `crypto_free_*` 释放，不关心底层算法实现。

```
调用 crypto/ 的子系统:

  net/  (网络协议栈)
    ├── IPsec (net/ipv4/esp4.c, net/ipv6/esp6.c)
    │     crypto_alloc_aead("gcm(aes)", ...) → ESP 加解密
    │
    ├── TLS offload (net/tls/)
    │     crypto_alloc_skcipher / aead → 内核 TLS 数据面卸载
    │
    └── WireGuard (drivers/net/wireguard/)
          crypto_alloc_skcipher("chacha20poly1305", ...)

  fs/  (文件系统)
    └── fscrypt (fs/crypto/)
          crypto_alloc_skcipher("xts(aes)", ...) → 文件内容加密

  security/  (安全子系统)
    ├── IMA (security/integrity/ima/)
    │     crypto_alloc_shash("sha256", ...) → 度量值计算
    │
    └── EVM (security/integrity/evm/)
          crypto_alloc_shash → 签名验证

  block/  (块设备层)
    └── blk-crypto (block/blk-crypto.c)
          crypto_alloc_skcipher → 内联加密支持

  drivers/  (硬件加速器)
    ├── Intel AES-NI (arch/x86/crypto/aesni-intel*)
    ├── ARM CE (arch/arm/crypto/ + arch/arm64/crypto/)
    ├── Freescale CAAM (drivers/crypto/caam/)
    └── 各厂商 DMA 加速器
          crypto_register_alg / aead / skcipher → 注册硬件实现

  init/  (启动)
    └── crypto_algapi_init (crypto/algapi.c:1098)
          late_initcall → 确保内置算法注册后再触发自检
```

交互方式是函数调用——调用方通过 `crypto_alloc_*` 获取 transform，通过类型特定的操作函数（如 `crypto_aead_encrypt`、`crypto_skcipher_setkey`）执行加密操作。框架对调用方完全屏蔽了算法选择、模块加载、异步完成等内部细节。

硬件加速器驱动的交互方向相反——它们不是 `crypto/` 的消费者，而是提供者。驱动在 `module_init` 或 `probe` 时调用 `crypto_register_alg`/`crypto_register_skcipher`/`crypto_register_aead` 将硬件加速实现注册到框架，设置高 `cra_priority` 使其优先于软件实现被选中。框架的 `request_module` 机制保证硬件驱动可以在运行时按需加载。

`crypto_algapi_init`（crypto/algapi.c:1098）使用 `late_initcall` 级别注册，晚于大多数内置算法的注册时机（通常在 `module_init` 即 `device_initcall` 级别）。这一设计确保所有内置算法注册完毕后再触发自检——否则自检可能在算法尚未注册时就执行，导致误报。

## 扩展方式

**新增加密算法**：如果需要在内核中添加一个新的加密算法（如新国密标准 SM4 的某种实现），按以下步骤操作：

1. 定义算法操作集，填充对应类型的 `*_alg` 结构体：

```c title="drivers/crypto/my_aes.c"
static struct skcipher_alg my_aes_alg = {
    .setkey         = my_aes_setkey,        // 设置密钥
    .encrypt        = my_aes_encrypt,       // 加密
    .decrypt        = my_aes_decrypt,       // 解密
    .init           = my_aes_init_tfm,      // transform 初始化
    .exit           = my_aes_exit_tfm,      // transform 清理
    .min_keysize    = AES_MIN_KEY_SIZE,
    .max_keysize    = AES_MAX_KEY_SIZE,
    .ivsize         = AES_BLOCK_SIZE,
    .base.cra_name          = "aes",        // 通用名, 与现有实现共享
    .base.cra_driver_name   = "aes-my-hardware", // 唯一驱动名
    .base.cra_priority      = 400,          // 高于 aes-generic(100) 和 aesni(300)
    .base.cra_flags         = CRYPTO_ALG_ASYNC,  // 硬件异步
    .base.cra_blocksize     = AES_BLOCK_SIZE,
    .base.cra_module        = THIS_MODULE,
};
```

2. 在模块初始化函数中注册：

```c title="drivers/crypto/my_aes.c"
static int __init my_aes_mod_init(void)
{
    return crypto_register_skcipher(&my_aes_alg);
}

static void __exit my_aes_mod_fini(void)
{
    crypto_unregister_skcipher(&my_aes_alg);
}

module_init(my_aes_mod_init);
module_exit(my_aes_mod_fini);
```

注册后框架自动创建 larval 并异步执行自检（如 `CONFIG_CRYPTO_MANAGER_SELFTESTS` 启用）。自检使用 NIST/CAVP 测试向量验证加解密正确性，通过后 larval 转为 adult，算法对查找链可见。`cra_priority` 设为 400 意味着查找 `"aes"` 时此实现被优先选中（高于 AES-NI 的 300 和 generic 的 100）。如果硬件不可用（如 probe 失败），模块不注册，框架自动回退到次优实现。

**新增模板**：如果需要添加一种新的加密模式（如新的 AEAD 构造），按以下步骤操作：

1. 定义 `crypto_template` 结构体和 `create` 回调：

```c title="crypto/my_mode.c"
static int my_mode_create(struct crypto_template *tmpl,
                          struct rtattr **tb)
{
    // 解析参数, 获取基础算法名
    const char *algname = crypto_attr_alg_name(tb[1]);

    // grab 底层算法
    struct crypto_skcipher_spawn spawn;
    crypto_grab_skcipher(&spawn, tmpl, ...);

    // 组装新的 aead_alg / skcipher_alg 实例
    // 设置 cra_name = "my_mode(algname)"
    // 设置操作回调 (在回调中调用底层 spawn 的 encrypt/decrypt)

    // 注册实例
    aead_register_instance(tmpl, inst);
    return 0;
}

static struct crypto_template my_mode_tmpl = {
    .name   = "my_mode",
    .create = my_mode_create,
    .module = THIS_MODULE,
};
```

2. 注册模板：

```c title="crypto/my_mode.c"
static int __init my_mode_init(void)
{
    return crypto_register_template(&my_mode_tmpl);
}

module_init(my_mode_init);
```

注册后，当有人请求 `"my_mode(aes)"` 时，查找链解析出模板名 `"my_mode"`，调用 `crypto_lookup_template` 找到模板，触发 `my_mode_create` 回调组合出实例。模板实例通过 `crypto_spawn` 持有对底层 AES 算法的引用——如果 AES 模块被卸载，`crypto_remove_spawns` 会级联清理所有依赖它的 `my_mode` 实例。模板可以嵌套：`my_mode(ctr(aes))` 会先创建 `ctr(aes)` 实例，再在其上叠加 `my_mode` 逻辑。
