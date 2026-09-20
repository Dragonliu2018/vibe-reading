---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "容器与内存管理"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "向量化", "内存池", "列式存储"]
description: "MatrixOne 容器模块解读：自研 Vector/Batch（非 Arrow）、Varlena 24B 定宽槽、mpool 全局内存记账与 offHeap GC 压力规避。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/container/`（约 2.6 万行：vector / batch / types / nulls 等）+ `pkg/common/mpool/` + `pkg/vectorize/`（向量化内核）+ `pkg/common/reuse/`（对象池）是全库共享的数据结构地基：`Vector` 是唯一列向量形态（FLAT/CONSTANT/DIST 三态、null 位图、Varlena 变长布局），`Batch` 是行批，`Type` 是类型系统，`mpool` 是统一内存记账。它独立成文的原因：这些结构的契约被 colexec、tae、disttae 三方共同消费，是理解任何执行路径的前置知识——数据怎么在内存里长什么样，决定了向量化的一切。

## 模块架构

![Vector / Batch / mpool](/vibe-reading/images/articles/matrixone-internals/container-vectorize.svg)

```go title="pkg/container/vector/vector.go:55 — 全库唯一列向量"
type Vector struct {
    class  vecType      // FLAT / CONSTANT / DIST（vector.go:37）
    typ    types.Type
    data   []byte       // 定长数据，或 Varlena 24B 槽数组
    area   []byte       // 变长堆：>23B 内容按 offset 引用
    length int
    nsp, gsp nulls.Nulls  // null / grouping 位图
    sorted bool
}
```

`Batch`（`pkg/container/batch/types.go:45`）：`Attrs []string + Vecs []*Vector + rowCount`。`types.Type`（types.go:113）：`Oid T`（uint8 枚举 T_int8…T_array_float64）+ Size/Width/Scale；`Varlena [24]byte`（types.go:212）；Decimal64/128/256 为纯 uint 定宽整数（types/decimal.go:196-210，运算 `Add128/Scale/CompareDecimal128WithScale` 全手写）。`mpool.MPool`（mpool.go:257）：`id/tag/cap/stats + ptrs map[unsafe.Pointer]memHdr`。

## 调用链路

以一次向量化表达式求值为例（`FunctionExpressionExecutor.Eval`，`pkg/sql/colexec/evalExpression.go:580`）：

1. 递归 Eval 子表达式得 `parameterResults []*vector.Vector`
2. `expr.resultVector.PreExtendAndReset(rowCount)`——`FunctionResult[T]`（vector/functionTools.go:573）持结果 Vector 与 mp，`PreExtend` 经 `mp.Alloc` 扩容（记账点）
3. `evalFn(params, result, proc, length, selectList)`——kernel 如 `integerDivSigned`（`pkg/sql/plan/function/arithmetic.go:546`）：`MustFixedColNoTypeCheck[int64](rsVec)`（tools.go:50）unsafe 取出 `[]int64`，逐行读输入写 `rss[i]`、`rsNull.Add(i)`
4. 算子层如 dedup join 用 `vector.GetUnionAllFunction(typ, proc.Mp())` 把子批拼进 buf（`colexec/dedupjoin/join.go:373`），null bitmap 由 `unionNsp` 合并；批结束 `bat.Clean(mp)` 归还

**所有分配/释放都过 `proc.Mp()`，构成 CN 内存记账主干。**

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `ToSlice[T]`（vector.go:71） | 零拷贝取列 | `unsafe.Slice` 泛型 |
| `GetUnionAllFunction`（vector.go:1350） | 逐类型批拼接闭包 | 按 Oid 生成的 ~800 行 switch |
| `AppendFixed[T]/AppendBytes`（vector.go:3458+） | 追加写入 | `appendOneFixed` 统一入口 |
| `Vector.Free`（vector.go:673） | 归还内存 | data/area 双次 `mp.Free` |
| `Batch.Shrink/Shuffle`（batch.go:366/382） | 行裁剪/重排 | `FixedLengthShuffle` 统一路径 |
| `MPool.Alloc/Free`（mpool.go:506/526→578） | 记账分配 | 全局 cap → pool cap → ptrs map |
</details>

## 核心实现

### Varlena：24 字节定宽槽 + area 兜底

`v[0]=len` 且 ≤23 字节（`VarlenaInlineSize`，`IsSmall` 判定 `(*v)[0] <= 23`）直接 inline 在 24 字节槽内（types/bytes.go:48 `ByteSlice`）；超长时 `SetOffsetLen` 写 `VarlenaBigHdr=0xffffffff` 魔数（bytes.go:74），offset/len 存槽内后续的 U32 位置、内容按 offset 引用 area。收益：varchar 列也是"定长数组"，`Capacity=cap(data)/TypeSize()`（vector.go:174）、Shrink/Shuffle 走统一 `FixedLengthShuffle`（vectorize/shuffle/shuffle.go:19），无需 per-row 间接寻址。

### 自研 Vector 而非 Arrow

代码内无直接说明（待核实），从实现可推断需求集合：CONSTANT 广播态、area 分离的 Varlena 布局、gsp grouping 位图（ROLLUP）、`unsafe.Slice` 零拷贝、mpool 强绑定记账——Arrow 难以同时满足；且仅在 CN-DN RPC 与 S3 读写处做转换。这是"通用格式 vs 深度定制"的经典取舍：MatrixOne 选了为执行内核全权定制的路线。

### mpool 全局记账

Go 的 `make/free` 不可观测，mpool 提供三层价值：per-query cap（OOM 保护，mpool.go:534 `NewOOMNoCtx`）、HighWaterMark 高水位统计、`ptrs` map + memHdr（poolId/guard）检测 double-free 与跨池 free。`Alloc`（mpool.go:506）为每次分配——包括 on-heap 的 `make([]byte)` 路径——记录 16 字节 memHdr，`SetGuard` 写入 **`0xDE 0xAD 0xBF` 三字节魔术值**（mpool.go:181-184）；`freePtr`（mpool.go:578）里 `removePtrHdr` 未命中即 **panic "invalid ptr, double free"**（:585）；`hdr.poolId != mp.id` 时经 `globalPools.Load(hdr.poolId)` **委托原池的 `freePtrInternal` 释放**（跨池 free 不报错、记账归原池）。offHeap 大对象（`NewOffHeap*`）走 `simpleCAllocator`（malloc.SimpleCAllocator，sizeclasses.go 为 Go runtime 风格 size class 表）绕开 Go GC——大 batch 的扫描压力直接消除。`ptrs` map 有锁开销，故提供 `NoLock` pool 与全局分片 `gRecordPtr`（mpool.go:473）。

### CONST 向量与常量折叠

`class=CONSTANT` 时 data 只存 1 个元素、`length` 表示广播行数（`IsConst/appendMultiFixed`），配合 `doFold`（evalExpression.go:582）的常量折叠。三态使"标量与列"在算子接口里统一。`ToSlice[T]`/`ToSliceNoTypeCheck`（vector.go:79-89）对 CONST 向量**用长度 1 重铸 data**（`toSliceOfLengthNoTypeCheck[T](vec, 1)`），FLAT 才用 `vec.length`——下游 kernel 无需感知常量折叠，拿到的永远是物理切片。DIST 态服务字典编码列。

### 批生命周期：哨兵批与 Free 的重置语义

`Batch.Clean`（batch.go:509）对三种**哨兵批**（`EmptyBatch`/`CteEndBatch`/`EmptyForConstFoldBatch`）直接 return——它们是全局单例，仍被其他执行流引用，释放即野指针。正常批逐列 `SetVector(i, nil)` 再 `vec.Free(m)`。`Vector.Free`（vector.go:673）由 `cantFreeData/cantFreeArea` 两标志守卫（borrowed 数据不释放），随后重置：**class=FLAT、data/area=nil、length=0、nsp/gsp Reset、sorted=false**——Free 之后回到可复用的干净状态。与 `FreeColumns` 的区别：Clean 清空整个 Batch（Attrs/Vecs/ExtraBuf 全 nil、rowCount=0），FreeColumns 只逐列释放不重置 Batch 结构。

### GetUnionAllFunction 的常量展开与位图合并

`GetUnionAllFunction`（vector.go:1350）为每个 Oid 生成一个闭包（~800 行 switch）。源向量 `w` 是常量 NULL 时调 `appendMultiFixed(v, 0, true, w.length, mp)` 广播 null；是常量时取 `ws[0]` 同样 `appendMultiFixed` 展开 w.length 份（vector.go:1374-1383）。普通 FLAT 合并时定长数据用**纯 `copy(v.data[v.length*sz:], w.data[:w.length*sz])`**（vector.go:1397）memcpy；null bitmap 经 `unionNsp` 闭包（:1352）合并——循环**从 `u64Length-1` 倒序遍历到 1 再单独处理下标 0**（`for i := u64Length - 1; i != 0; i--` + `Contains(0)` 分支），避开 uint 下溢的惯用写法。

### 复用池的克制

`common/reuse`（factory.go:78 `CreatePool[T]`，env `mo_reuse_spi` 可切 sync-pool/mpool 两种 SPI）；Vector 自身建了 reuse pool 但 `NewVecFromReuse` 当前实际 `new(Vector)`（vector/reuse.go:42，代码注释显示复用被禁用——待核实原因）；另有 `pSpool`（batch 缓冲复用）与 `FunctionResult.convenientParam` 减少参数 wrapper 分配。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| inline + 兜底双布局 | types/bytes.go:30 | 变长数据享受定长路径 |
| 位图 | `nulls.Nulls`（nulls.go:30，`common/bitmap.Bitmap` 封装） | null/grouping 集合运算 O(1)/字 |
| 泛型 + 显式类型检查 | `checkType[T]`（vector.go:104）与 race 模式 `checkTypeIfRaceDetectorEnabled` | 编译期类型安全，race 下才付检查成本 |
| 版本化序列化 | `vector/versions.go` MarshalBinaryWithBufferV1/V2 | nulls bitmap 格式演进兼容 |

## 模块间交互

消费方覆盖 `pkg/sql/colexec/*`（全部算子）、`pkg/sql/plan/function/*`（百级内置函数 kernel）、`pkg/vm/engine/tae/containers`（存储层直接调 `vector.AppendBytes` 用自己的 allocator）、`disttae`（merge.go 等）。mpool 经 `process.Process` 注入到每条 pipeline；`Free(mp)` 语义是"谁创建谁归还"——Vector 是无主内存，生命周期由创建者（算子/表达式）显式管理。

## 扩展方式

- **新增数据类型**：`types/types.go` 加 T 枚举 + `ToType/TypeSize` → 新 `types/xxx.go` → `vector.go` 的 `GetUnionAllFunction`/`AppendAny`/`RowToString` 三处巨型 switch（1374/3384/3241）→ `versions.go` 序列化 → plan/function 注册。
- **新增标量函数 kernel**：写 `pkg/vectorize/<name>/`（纯数值函数，参考 `momath/math.go` 的 `Sqrt(v float64)(float64,error)` 模式）→ `pkg/sql/plan/function/func_<name>.go` 用 `GenerateFunctionFixedTypeParameter` + `MustFunctionResult[T]` 包装成 evalFn 签名。
- **新增算子批拼接逻辑**：改 `vector.go` 的 `unionT/UnionBatch`（2615/2748）与 `batch.go` 的 `Shuffle/Shrink`。

行数核对：vector.go 5316 行、batch.go 755 行、mpool.go 889 行、decimal.go 2732 行、nulls.go 489 行。
