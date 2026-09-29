---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "内存与公共设施"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "内存管理", "lookaside"]
description: "sqlite3_mem_methods 方法表注入、lookaside 双尺寸快速池、mem5 buddy 分配器的 Robson 碎片保证、自实现 printf 与 benign malloc"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

全库最高扇入的地基（graphify 实测 `sqlite3_free` 321 edges、`sqlite3DbFree` 174）。本模块包括：分配器族（`malloc.c` 核心 + `mem1/2/3/5.c` 四种实现）、`mutex*.c`、`util.c`/`hash.c`/`bitvec.c`/`rowset.c`/`printf.c`/`utf.c`/`random.c`/`status.c`/`fault.c`。设计哲学是**一切可注入、一切可裁剪**：内存/互斥/页缓存三张方法表运行时替换，宿主可以把整个堆分配器换成自己的。

## 模块架构

```text title="分配路径全景"
sqlite3DbMallocRaw(db, n)              malloc.c:636
└─ sqlite3DbMallocRawNN (:643)
   ├─ n > lookaside.sz → dbMallocRawFinish（SQLITE_NOINLINE 慢路径隔离）
   ├─ n ≤ 128 → 弹 pSmallFree → 弹 pSmallInit      # 小池
   ├─ n ≤ 1200 → 弹 pFree → 弹 pInit                # 大池
   └─ 池空 → sqlite3Malloc
        ├─ bMemstat 开: mem0.mutex + mallocWithAlarm（软限告警→release_memory 让 PCache 吐页，硬限受控 OOM）
        └─ bMemstat 关: 裸调 m.xMalloc               # 无锁无统计
```

三张同构方法表全部存 `sqlite3Config` 单例（global.c:232），经 `sqlite3_config()` 在 `sqlite3_initialize()` 前注入：`sqlite3_mem_methods`（sqlite.h.in:1814，8 个成员）、`sqlite3_mutex_methods`、`sqlite3_pcache_methods2`。头注释规定线程模型：`xInit/xShutdown` 由调用方持锁保护，其余方法在 MEMSTATUS 开启时被 STATIC_MEM 自动串行化——**把线程安全责任上移，让自研分配器可以写成单线程代码**。

## 核心实现

### Lookaside：双尺寸 per-db 快速池

`Lookaside`（sqliteInt.h:1624-1645）的三个设计点各配一个 why：

- **双尺寸池**（2019-12-12 增强，:1612-1622）：`pSmallInit/pSmallFree`（128B 槽）+ `pInit/pFree`（默认 1200B 槽），`pMiddle` 为分界。多数 lookaside 分配 <128 字节（Expr、Token），统一 1200 字节槽浪费严重——global.c:215 注释给出对比：默认从 1200,100 改为 1200,40，48KB 拿到等效果。
- **禁用即折叠**：禁用 lookaside 不是加分支，而是把 `sz` 置 0，让 `n>db->lookaside.sz` 一次比较自然失败（:1600 注释）——控制流折叠进数据的热路径技巧。
- **双链语义**：分配先取 `pFree`（用过已回收）再回退 `pInit`——`nSlot - len(pInit)` 即历史高水位，零成本统计。

热路径上**只有两次指针弹栈和一次计数自增，无锁无原子**——db mutex 已由调用方持有。`sqlite3DbFree`（malloc.c:419）用**地址区间比较**判断归属压回池；DEBUG 版先 `memset(p,0xaa,…)` 涂毒抓 use-after-free。

**OOM 后立刻禁用 lookaside 并置 isInterrupted**（`sqlite3OomFault`，malloc.c:827）：lookaside 命中会掩盖 OOM 状态，必须让后续分配一致地失败——:617-634 注释解释了不变量"调用方普遍假设后一个分配成功 ⇒ 前一个也成功"。

### mem5：buddy allocator 与 Robson 保证

`Mem5Global`（mem5.c:92-132）：31 条按 log2 分级的空闲链 `aiFreelist[LOGMAX+1]`，每 atom 一字节元数据（低 5 位块尺寸 log2 + CTRL_FREE 位）。分配取整到 2 的幂后**循环二分**大块；释放按 buddy 地址（`(iBlock>>iLogsize)&1` 判前后半）逐级上浮合并。

头注释（:35-49）引用 Robson 1974 论文：只要 `N ≥ M*(1+log₂(n)/2)-n+1`（N=池大小，M=峰值在途内存，n=最大/最小分配比），该算法**永不因碎片而失败**——且 `sqlite3_status` 恰好跟踪 n 和 M，应用可在线验证约束。这是嵌入式选 mem5 而非裸 malloc 的核心论据（malloc 无碎片下界保证）。`memsys5Roundup`（:421）大于 szAtom\*2 的请求按 **4 倍**取整——减少大尺寸内碎片同时压缩链表级数一半。

### 四种（实为六种）内存子系统

| 文件 | 宏 | 机制 | 适用 |
| --- | --- | --- | --- |
| mem1.c | SQLITE_SYSTEM_MALLOC（默认） | libc wrapper；Apple 用独立 malloc zone（与宿主 App 泄漏工具隔离） | 一切常规场景 |
| mem2.c | SQLITE_MEMDEBUG | 前后哨兵 + 全局链表 → shutdown 时 leak 检测 + 尺寸直方图 | 开发/测试构建 |
| mem3.c | SQLITE_ENABLE_MEMSYS3 | 独占内存池（应用交出固定块） | 老式嵌入式 |
| mem5.c | SQLITE_ENABLE_MEMSYS5 | buddy + Robson 保证 | 现代嵌入式首选 |
| mem0.c | SQLITE_ZERO_MALLOC | 全部返回 0 的占位 | 特殊构建 |
| — | SQLITE_CONFIG_PAGECACHE | 页缓存专用旁路内存 | 页缓存不与堆竞争 |

注意 mem3/mem5 **编译进库 ≠ 启用**：`SQLITE_CONFIG_HEAP` 传入非空堆时才换上（main.c:597-634）。

### 自实现 printf

`printf.c` 从 1980 年代公有领域代码演化而来，不依赖 libc。要点：格式符经**手排的 25 槽哈希表**查 `et_info`；自带 libc 没有的转换符——`%q`/`%Q`（SQL 单引号转义）、`%z`（接管 malloc 所有权）、`%J`（JSON 字面量）——**错误消息与 SQL 文本拼接必须防注入**；`sqlite3_snprintf`（:1559）刻意忽略 locale（:1532 注释：某些 locale 用 `,` 做小数点会破坏 SQL）。全部经 `sqlite3_str_vappendf`（:203）+ StrAccum 的"栈上小缓冲起步→按需扩到堆/lookaside"三级策略。

### 其他公共设施

`random.c` 用 **ChaCha20** 做 PRNG（:41-52，旧版 RC4 已换）；`bitvec.c` 定长 512 字节位图在"位直接存/散列存/级联子 Bitvec"三形态自适应（DROP 大表的稀疏场景）；`hash.c` 开链但**所有元素挂一条全局双向链**、桶只指向链中位置——小表 htsize=0 直接线性扫不建哈希，且 rehash 失败是良性的（fault.c 的 benign malloc 典型案例）；`status.c` 只有两行数组，统计内嵌在持锁分配路径里不另设锁。

**fault.c 双机制**：`sqlite3FaultSim()`（util.c:51，全库 35 处撒点，回调由测试驱动安装）做故障注入；`sqlite3BeginBenignMalloc`（fault.c:74）让"哈希扩容失败"这类可恢复失败被测试框架区别对待。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 方法表注入 | 三张 methods 表 + sqlite3_config | 嵌入式整体替换分配器/锁 |
| noop 假指针 | mutex_noop.c alloc 返回 `(sqlite3_mutex*)8` | 单线程构建编译不消失但运行零成本 |
| SQLITE_NOINLINE 慢路径隔离 | malloc.c:604 | icache 优化，全库通用手法 |
| 预分配打破鸡蛋循环 | mutex.c:99 静态互斥量数组 | malloc 初始化需要 mutex、mutex 初始化可能要 malloc |

## 模块间交互

- **被一切模块消费**：`sqlite3ErrorMsg`（util.c:249）→ printf.c 格式化；hash.c 的 HashElem 分配；StrAccum 扩容。
- **printf ↔ malloc 闭环**：`sqlite3OomFault` 用 `sqlite3ErrorMsg` 报 OOM，而后者又用 StrAccum 分配——所以 StrAccum 必须有 `mxAlloc=0` 纯栈模式避免 OOM 递归。
- **status ↔ malloc**：软/硬堆限完全建立在 `SQLITE_STATUS_MEMORY_USED` 之上，MEMSTATUS=0 时告警逻辑整体旁路。

## 扩展方式

嵌入式设备切到自管理内存的步骤：`-DSQLITE_ENABLE_MEMSYS5` 编译 → 按 Robson 公式用 `sqlite3_status` 在原型机量 M 与 n 定池大小 → `sqlite3_initialize()` 前调 `sqlite3_config(SQLITE_CONFIG_HEAP, pBuf, nByte, mnReq)`（原子完成方法表替换，main.c:630）→ 可选 `SQLITE_CONFIG_MEMSTATUS, 0` 关统计省锁（此后 mem5 自行加锁）→ 可选 `SQLITE_CONFIG_PAGECACHE`/`CONFIG_LOOKASIDE` 独立预算 → 用 `sqlite3_memory_highwater()` + `sqlite3Memsys5Dump` 验证碎片。

两个易踩的契约：一切 `sqlite3_config` 必须在 initialize 之前；**`xRoundup` 的返回值将原样成为后续 `xRealloc` 的 nByte 参数**（sqlite.h.in:1777）——自定义分配器最容易忽略的隐式协议。如需完全自定义分配器（TLSF 等），跳过 mem3/mem5 直接实现 8 函数方法表经 `SQLITE_CONFIG_MALLOC` 注入。
