---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "FastScan"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "SIMD", "AVX2", "量化"]
description: "Faiss FastScan 深度解读——4-bit 码的 32 向量交织块布局、vpshufb lane 查表数学、uint16 模运算累加、qbs 宏块调度与 AMD Zen4 特判"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

FastScan 是 Faiss 的**性能王牌**：4-bit 量化 + 32 向量交织代码布局 + SIMD 查表累加的批量扫描路径，比普通 PQ 扫描快 3-10 倍。代码三层：索引层（`IndexFastScan.h/.cpp` + `IndexIVFFastScan.cpp` 1,653 行，派生 PQ/AQ/RaBitQ 各 flat+IVF 共 12 个索引类）、打包与循环层（`impl/fast_scan/`）、内核层（`kernels_simd256/512.h` + 每 ISA 一个 TU）。一个先澄清的事实：v1.15.1 **没有** `IndexSQFastScan`（8-bit SQ 不走 FastScan），家族成员是 PQ4 / AQ（RQ/LSQ/PRQ/PLSQ）/ RaBitQ 三系——共同前提是"码宽 ≤ 4 bit"。

## 模块架构

![FastScan 布局对比](/vibe-reading/images/articles/faiss-internals/fastscan-layout.svg)

核心是**布局即算法**：普通行主序下一个向量的 M 个码连续存放（SIMD 一次只碰一个码）；FastScan 把 32 个向量的同位子码交织进一个块——一条 `vpshufb`（`_mm256_shuffle_epi8`）同时为 32 字节代码查 2 个子量化器的 16 项 LUT。

## 核心实现

### 块的精确布局（pq4_pack_codes）

`impl/fast_scan/fast_scan.cpp:48-107` 的三重循环：外层 bbs 向量大块、中层**成对**子量化器（步长 2，故 `M2` = M 上取整到偶数）、内层 32 向量组。每 32 字节：

- 字节 j（0≤j<16）：低 nibble = 向量 `perm0[j]` 在子量化器 sq 的码，高 nibble = 向量 `perm0[j]+16` 的码；
- 字节 j+16：同结构装 sq+1。

其中 `perm0 = {0,8,1,9,2,10,3,11,4,12,5,13,6,14,7,15}`（小端置换，fast_scan.cpp:75；大端机器换成 {8,0,9,1,...}）。配套的 `CodePackerPQ4`（fast_scan.cpp）：`nvec = bbs`、`code_size = (nsq*4+7)/8`、`block_size = ((nsq+1)/2) * bbs`——pack 断言 `bbs % 32 == 0`、`nb % bbs == 0`、`nsq % 2 == 0`。**为什么是这个形状**：vpshufb 的"16 字节 lane 内查表"语义要求索引 ≤15——4-bit 码恰好是 16 字节 lane 的合法索引；一条 256-bit 寄存器 = 2 个 lane = 2 个子量化器各 16 项 LUT。LUT 打包（`pq4_pack_LUT`，fast_scan.cpp:287）把 (查询, sq 对) 的 2×16 字节拼成 32 字节寄存器——**代码布局与 LUT 布局互为转置**，一条 `lut.lookup_2_lanes(clo)` 完成全部查表。

### 累加的 SIMD 数学（pq4_kernel_qbs_256）

`impl/fast_scan/kernels_simd256.h:130` 每迭代处理一个 sq 对：`clo = c & 15`、`chi = (c>>4) & 15`（用 `simd16uint16(c) >> 4` 实现 uint8 无法做的右移）。查表后：

```
accu[0] += simd16uint16(res0)          // lane i 累加 res0[2i] + 256·res0[2i+1]
accu[1] += simd16uint16(res0) >> 8    // lane i 累加 res0[2i+1]
// 末尾解缠（kernels_simd256.h:183）：
accu[0] -= accu[1] << 8;
dis0 = combine2x2(accu[0], accu[1]);   // permute2f128 + blend
```

**数学本质**：uint16 环上模 65536 加法满足 `Σ(e_t + 256·o_t) − 256·Σo_t = Σe_t (mod 2^16)`，而每向量总距离 ≤ (M2/2)·255 < 65536，故减法精确还原——**用 uint8→uint16 包装累加 + 一次减法代替逐子量化器的 16-bit 加法**，这是吞吐关键。`combine2x2` 一次加法同时完成"两子量化器距离求和"（lane 8+v 恰是同向量 v 在 sq+1 的贡献）；`perm0` 的 {0,8,1,9,...} 置换正是让 lane 算术最终输出按块内序排列的 16 个 uint16 距离。

### LUT 量化管线：全程无浮点

`search_implem_12`（IndexFastScan.cpp:436）流程：`compute_float_LUT`（虚函数，各量化器提供 n×M×16 float 表）→ `quantize_lut::round_uint8_per_column` 把每列仿射量化到 uint8，产出 (a,b) 归一化对（`原始值 = 量化值·a + b`）→ `pq4_pack_LUT_qbs` 交织。累加全程 uint16 域，`HeapHandler::end()`（simd_result_handlers.h:533）最后统一 `heap_dis[j]*one_a + b` 还原 float。**为什么**：uint8 LUT + uint16 累加使整条扫描路径无浮点、无分支。IVF 版的残差模式把 coarse centroid 距离压成 uint16 `bias`，扫描时 `d0 += dbias16`（simd_result_handlers.h:274）。

### qbs：寄存器友好的宏块调度

`qbs` 是 16 进制 4 位编码（如 `0x2333` = 3+3+3+2 = 11 个查询分 4 个宏块）。`pq4_preferred_qbs`（fast_scan.cpp:367）给出经验查找表 `map[12] = {0,1,2,3,0x13,0x23,0x33,0x223,0x233,0x333,0x2233,0x2333}`（注释注明来自内部计时实验）；n ≤ 11 直接查表，n ≤ 24 按 3 个一组重排，n > 24 抛异常。**为什么需要它**：内核寄存器压力随每块查询数 NQ 增长（"nq·nb ≤ 4 否则寄存器溢出"，fast_scan.h:14-17）；qbs 是"把任意查询数切成寄存器友好的宏块序列"的调度原语——`accumulate_q_4step_256`（accumulate_loops.h:90）在**编译期**拆 QBS 编码成 Q1..Q4 四段，LUT/codes 双双热在 cache 时一次 pass 服务 1-12 个查询。

### add 慢 search 快：明确的交易

`IndexIVFFastScan::add_with_ids`（IndexIVFFastScan.cpp:119-223）：粗量化 → 编码 → `stable_sort` 按 list 分组 → `pq4_pack_codes_range` 增量打包进交织布局（越界向量填 0 padding，`|=` 写块要求目标区先清零）。**交织布局把"一个向量的码"打散到 nsq 个相距 bbs/2 字节的位置**——任何单向量写都是 nibble 级位操作（`pq4_set_packed_element`，fast_scan.cpp:221）；remove/merge 全走 unpack_1+pack_1 慢速循环。这是明确交易：写入路径 O(code_size) 次位操作，换扫描路径每 32 向量每子量化器对 2 条 vpshufb。生产实践：离线 add、在线只 search。

### IVF 版的 search_implem 与 v1.15 重构

`search_dispatch_implem`（IndexIVFFastScan.cpp:521）按 bbs/k 选实现：**12**（bbs==32）把 (query, probe) 对收集成 `struct QC{qno, list_no, rank}` **按 list_no 排序**后分批——同表最多 qbs2（默认 11）个查询合成一个 LUT 批（`pq4_pack_LUT_qbs_q_map` 用 q_map 重排乱序查询的 LUT），一次 `accumulate_loop_qbs` 扫完；**10/11** 通用路径支持 max_codes/max_lists_num/ensure_topk_full 早停。v1.15 重构：扫描统一走 `FastScanCodeScanner` 虚接口（`fast_scan.h:117`），handler 与内核绑在同一 SIMD TU 编译——热路径无虚调用，只在接口边界一次。

### RaBitQ 如何塞进 PQ4 机器

`IndexRaBitQFastScan` 构造（IndexRaBitQFastScan.cpp:34-58）：`M_fastscan = (d+3)/4`——**把每 4 个维度的 sign bit 打包成一个 4-bit "码"**，ksub=16 的 LUT 含义变为"这 4 个维度上查询量化值与 16 种 sign 组合的 XOR 贡献"（`int_dot = (2^qb−1)·d − 2·xor_dot`，centered 模式）。浮点校正因子放块尾 aux 区（`CodePackerRaBitQ`，块布局相应扩大）；结果期 `RaBitQHeapHandler::handle`（IndexRaBitQFastScan.h:172）在 handler 里边算边维护 float 堆——乘上 DB/查询侧因子才还原真实距离，保持与原始 RaBitQ 数学等价。

### dispatching：每 ISA 一个 TU + Zen4 特判

模式："每 TU 定义 `THE_LEVEL_TO_DISPATCH` 宏 + include dispatching.h + 显式特化"。运行期入口 `make_fast_scan_knn_scanner`（fast_scan.cpp:417）经 `with_simd_level` 选 TU。**AMD Zen4 特判**（dispatching.h:126 检查 `SIMDConfig::avx512_split`）：Zen4 的 512-bit op 拆两条 256-bit 数据通路，512-bit 内核实测 PQ8x4fs 回退 ~14%——路由回 256-bit 内核。"AVX-512 更宽不等于更快"的教科书案例。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 布局即算法 | `pq4_pack_codes`（fast_scan.cpp:48） | 数据形状为指令集定制 |
| 模板零开销注入 | `DummyScaler/NormTableScaler`（LookupTableScaler.h） | AQ 的"最后一对子量化器不同语义"——nscale=0 时普通查表分支不实例化 |
| 编译期宏块展开 | `accumulate_q_4step_256<QBS>`（accumulate_loops.h:90） | 寄存器压力的静态管理 |
| 运行期 context | `FastScanDistancePostProcessing`（FastScanDistancePostProcessing.h:15） | 每量化器特殊后处理从模板参数改为运行期通道 |

## 模块间交互

存储层是 [BlockInvertedLists](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/02-ivf-inverted-lists)（`code_size = (size_t)-1` 哨兵，布局由 CodePacker 解释）；量化侧消费 [4-bit 量化器](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/03-quantizers)；SIMD 类型来自 [simdlib](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/06-simd-distances)（`lookup_2_lanes` 在 AVX2/NEON 各有一份实现，NEON 复用 256-bit 模板）。GPU 侧的对应物是 interleaved 布局（[GPU 后端](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/08-gpu-backend)），同为"为并行单元重排数据"但单位从 SIMD lane 换成 warp。

## 扩展方式

**新增一个 FastScan 量化格式**：继承 IndexFastScan（或 IVF 版）→ 实现四个纯虚（`compute_codes`/`compute_float_LUT` 输出 n×M×16 float 表/`sa_decode`/`fast_scan_code_size`，IndexFastScan.h:236）——**只要量化能表达成"每 4-bit 码一个 8-bit 部分距离"，整套内核零改动**；码字含内嵌元数据则扩展 CodePacker + `postprocess_packed_codes`（RaBitQ 范本）；需结果期校正则自定义 ResultHandler 子类（RaBitQ 三件套范本）；最后在 index_factory.cpp 注册后缀（x4fs）。8-bit 为什么没有 FastScan：vpshufb 的 lane 是 16 字节，索引必须 ≤15——"码宽 ≤4 bit"是布局的硬前提（8-bit 走 `pq_code_distance` 系列专用内核，据内核约束推断，源码无直接注释）。
