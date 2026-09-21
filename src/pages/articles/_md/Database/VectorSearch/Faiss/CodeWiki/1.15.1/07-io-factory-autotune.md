---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "序列化与工厂"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "序列化", "DSL", "自动调参"]
description: "Faiss 序列化与工厂解读——fourcc 即版本号的设计哲学、读写 2.6:1 的十年格式债、index_factory 字符串 DSL 解析管线、AutoTune 格偏序剪枝、clone 的指针回接"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

`impl/index_read.cpp`（3,657 行）+ `index_write.cpp`（1,415 行）+ `index_factory.cpp`（47K）+ `AutoTune.cpp`（893 行）+ `clone_index.cpp` 构成 Faiss 的"元层"：索引怎么变成字节、怎么从一行字符串长出来、怎么自动调参。这三件事有一个共同价值——**组合性的出口**：组合索引可以任意嵌套，序列化按树的先根遍历递归写；工厂字符串是组合索引的规范名（可打印、可 diff、可存库）；AutoTune 在组合空间上搜最优超参。

## 模块架构

![fourcc 序列化机制](/vibe-reading/images/articles/faiss-internals/io-fourcc.svg)

## 核心实现

### IO 层：顺序流式，无 seek

`IOReader/IOWriter`（impl/io.h:27/40）只有一个纯虚 `operator()(void*, size_t, size_t)`——模仿 fread/fwrite。**头注释明确设计约束：I/O 永远顺序，不需要 seek（索引可以往管道里读写）**——这是整个格式的第一性约束：没有指针回跳，就没有"先写长度再补数据"，一切流式单向写。实现：`VectorIOReader/Writer`（内存，Python 绑定靠它）、`FileIOReader/Writer`、`BufferedIOReader/Writer`（1MiB 缓冲合并小读，避免 READ1 单字节读直打 fd）、`MappedFileIOReader`（mmap"准读"——直接返回映射区地址）、`ZeroCopyIOReader`（外部内存视图）。

宏层（io_macros.h）：用宏不用函数是**为了 abort 时拿行号**。`READVECTOR`（:71）读 size 前做两重防溢出（默认 1TB 上限 + SIZE_MAX 除法检查）——反 OOM 攻击面的核心。mmap 视图经 `read_vector_base`（index_read.cpp:155）接入：`MaybeOwnedVector` 类型的向量在 MappedFileIOReader 下 `create_view`——这就是 `IO_FLAG_MMAP_IFC` 让 codes 大数组加载后直接指磁盘页的机制。

### fourcc：格式即类内容

`index_write.cpp:28-42` 头注释的哲学："**The I/O format is the content of the class... The fourccs are assigned arbitrarily. When the class changed, the fourcc can be replaced. New code should be able to read the old fourcc and fill in new classes.**"——**没有版本号字段，fourcc 本身就是版本号**：类字段变了就换一个新 4 字符码，读端同时认新旧两个码。这解释了读写长度比 2.6:1——读侧要背所有历史格式的债：

- `IvFl/IvFL`（index_read.cpp:2093）：legacy IVFFlat，ids 与 codes 分开按 list 存，`set_array_invlist`（:1537）负责搬进新版 InvertedLists；
- 同一个 PCAMatrix 有 **PCAm/PcAm/Pcam 三个 fourcc**（:304-335），对应三个历史布局；
- 兼容下限：能读的 `Iv*` 系列对应 Faiss 1.0 之前（2016-2017）——**向后兼容跨度近十年**。

`write_index`（index_write.cpp:475）的巨型 if-链按 dynamic_cast **从最派生到最基类**排序（顺序错了会把派生类写成基类格式），每支：fourcc（如 IndexFlat 按 `metric_type == METRIC_L2 ? "IxFP" : "IxFp"`，index_write.cpp:483）+ `write_index_header`（d → ntotal → 两个 dummy 占位 → is_trained → metric_type）+ 派生字段 + **递归嵌套**（`write_index(ivf->quantizer, f)`，嵌套索引序列化即树的先根遍历）。读端 `read_index_up`（index_read.cpp:1681）入口有 `IndexNestingGuard`（thread_local 深度上限 50，防恶意嵌套炸弹）；`read_index_header` 对 d 做 `FAISS_CHECK_RANGE(idx.d, 0, (1<<20)+1)`（:286，维度上限 1M）；`IO_FLAG_SKIP_IVF_DATA = 8`（index_io.h:56，`IO_FLAG_MMAP = SKIP_IVF_DATA | 0x646f0000`）。v1.15 共 **117 个 fourcc 分支**。`precomputed_table` 不落盘加载时重算（"cheaper to recompute"，:1636 注释）。

### InvertedListsIOHook：存储格式的注册点

内置 fourcc（`ilp2` Panorama / `ilar` Array——按非空 list 占比 >50% 选 `full`/`sprs` 布局，codes 写成单一连续大块 "useful for mmapping"，index_write.cpp:345）之外，兜底走 `InvertedListsIOHook::lookup_classname(typeid(...))`（:346）。第三方 `add_callback(key, classname)` 注册自己的格式（InvertedListsIOHook.h:56）——OnDisk/Block 就是这么注册的。一个特殊 hack：`IO_FLAG_MMAP` 把目标 fourcc 编进 io_flags 高 16 位（`"od"` 的 ASCII），实现"**存 ArrayInvertedLists、加载成 OnDiskInvertedLists**"的格式转换（index_read.cpp:676）。SVS 集成不走 IOHook 而是独立 fourcc 分支 + `ReaderStreambuf`（把 IOReader 适配成 std::streambuf 喂 SVS 自己的反序列化器，svs_io.cpp:59）。

### index_factory：字符串 DSL

![factory 解析管线](/vibe-reading/images/articles/faiss-internals/factory-autotune.svg)

`index_factory_sub`（index_factory.cpp:965）的消解顺序：① IDMap 前后缀均可（:976，注释自嘲 "it turns out it was used both as a prefix and a suffix"）→ ② Refine 包装 → ③ **预处理链**：`while (re_match(description, "([^,]+),(.*)") && (vt = parse_VectorTransform(...)))` 逐段剥 PCA/PCAR/RR/HR/ITQ/OPQ/L2norm（:1032），剥完逆序 prepend → ④ **括号归一化**：`find_matching_parentheses`（手写配对计数器）把 `(嵌套描述)` 递归解析后替换为 Index0/Index1 占位（:1058）——`IVF4096(HNSW32)` 的粗量化器来源 → ⑤ `parse_other_indexes`（Flat/LSH/ZnLattice/SQ/PQ/RQ/LSQ/RaBitQ/EDEN/SVS…）→ ⑥ **IVF 分解**：`parse_coarse_quantizer`（认 `IVF{nlist[kM]}`/`IMI2x{n}`/`IVF...(IndexN)` 括号引用）+ `parse_IndexIVF` 选编码器 + `fix_ivf_fields`。HNSW 的 M 参数缺省取 32（`mres_to_int(sm[1], 32)`）。

全部 `re_match`（std::regex 一行包装，:85）瀑布；**顺序敏感**：先精确后宽泛、fastscan（x4fs）在普通版之前。`factory_tools.cpp` 的 `reverse_index_factory`（:93）做逆变换（索引对象 → 工厂字符串）用于遥测。

### clone_index：拷贝构造 + 指针回接

核心宏 `TRYCLONE(classname, obj)`（clone_index.cpp:71）：dynamic_cast 成功即 `new classname(*obj)`——**默认走拷贝构造**（"Most indexes don't have complicated structs, the default copy constructor often just works"）。但拷贝构造是浅拷贝：`IndexIVF` 的 quantizer/invlists 指针拷后指向同一块内存，`Cloner::clone_Index`（:282）对复合索引手工补深拷贝 + `own_fields = true`；AQ 索引必须 `reset_AdditiveQuantizerIndex`（:184，18 个分支把 `r->aq` 指回自身成员——因为 aq 是指向兄弟成员的内部指针）。

### AutoTune：格偏序 + 支配剪枝

`ParameterSpace::initialize`（AutoTune.cpp:347）用 dynamic_cast 瀑布从索引结构**提取可调参数域**且沿组合关系递归（IVF → 对 quantizer 再建子空间，参数名加 `quantizer_` 前缀）：`nprobe` 2^0..2^12、`efSearch` 2^2..2^9、`ht`（PQ 多义码汉明阈值）。组合号按 mixed-radix 摊开；`combination_ge(c1, c2)`（:304）定义**参数格上的偏序**（每维索引都 ≥）——单调性假设是剪枝根基。`explore()`（:743）：固定跑最慢/最快两端 + 随机序网格，**每步支配剪枝**——用格偏序算该组合的 perf 上界/t 下界，若上界已被现有 Pareto 前沿支配则整组跳过。`OperatingPoints::add`（:112）是手写 Pareto 前沿维护（初始哨兵点 (perf=0, t=0)，"doing nothing gives 0 performance and takes 0 time"）。字符串接口 `set_index_parameters(index, "nprobe=32,efSearch=64")`（:459）递归穿透 IDMap/PreTransform/Shards。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| fourcc 即版本 | index_write.cpp:28 | 无版本号字段的十年兼容策略 |
| 注册表 | InvertedListsIOHook 全局表（InvertedListsIOHook.cpp:33） | 第三方存储格式插拔 |
| 解释器 | index_factory 的 parse 瀑布（index_factory.cpp:965） | 组合索引的规范名 |
| 偏序剪枝 | combination_ge + update_bounds（AutoTune.cpp:304/726） | 网格搜索的指数剪枝 |

## 模块间交互

读写消费全部 [Index 抽象](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/01-index-abstraction)（按 dynamic_cast 分派 + 递归嵌套）与量化器（`write_ProductQuantizer/read_ProductQuantizer` 等成对函数）；工厂产出组合索引树；`MaybeOwnedVector` 的 mmap 视图依赖 IO_FLAG 与 MappedFileIOReader 协作。

## 扩展方式

**新增一个索引类型（5 处注册）**：index_write.cpp 的 if-链加一支（**插在会被 dynamic_cast 抢先的基类之前**）+ 选不冲突的 fourcc → index_read.cpp 加读分支 + 防御校验 → AutoTune.cpp 的 ParameterSpace 加参数域 → index_factory.cpp 加 regex → clone_index.cpp 加 TRYCLONE + 指针回接。新 InvertedLists 实现则写 IOHook 注册或像 SVS 加独立 fourcc 分支。
