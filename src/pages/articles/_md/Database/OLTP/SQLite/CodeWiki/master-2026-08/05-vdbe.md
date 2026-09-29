---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "VDBE 虚拟机"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "虚拟机", "字节码"]
description: "~200 opcode 的寄存器机：Vdbe 即 sqlite3_stmt、Mem flags 类型系统、OP_Column 增量解码缓存、jump 两趟 label 解析与『代码排版即 ABI』"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

VDBE（Virtual Database Engine）是 SQLite 的执行核心：每条 SQL 在 prepare 阶段被编译为 opcode 字节码流，step 阶段由 `sqlite3VdbeExec()` 解释执行。**公开 API 的 `sqlite3_stmt*` 实际就是 `Vdbe*`**（vdbeInt.h:455 注释明言）——虚拟机本体就是 prepared statement。vdbe.c 内有 191 个 distinct `case OP_*`，共 ~24.7k 行。

## 模块架构

```text title="VDBE 文件族"
vdbe.c      # 主解释器：sqlite3VdbeExec 的 8500 行巨型 switch（:902-9574）
vdbeaux.c   # 程序构建：sqlite3VdbeAddOp* / MakeReady / resolveP2Values
vdbeapi.c   # C API 面：sqlite3_step/column_*（mutex 壳在此）
vdbemem.c   # Mem 值操作：类型转换/字符串化
vdbesort.c  # 多线程外部归并排序（PMA，服务 CREATE INDEX 与无索引 ORDER BY）
vdbeblob.c  # 增量 BLOB I/O
vdbetrace.c # EXPLAIN 格式化
```

## 调用链路

```text title="sqlite3_step 的完整通路"
sqlite3_step (vdbeapi.c:980)
└─ 持 db mutex → sqlite3Step (vdbeapi.c:839)
   ├─ 状态机推进: READY→RUN（pc=0）或 HALT→自动 reset
   ├─ SQLITE_SCHEMA 时 sqlite3Reprepare + reset 重试（上限 50 次）
   └─ sqlite3VdbeExec (vdbe.c:902)
      循环: pOp = &aOp[pc]; switch(pOp->opcode)
      ├─ 取指靠指针自增; 跳转 = pOp = &aOp[p2-1]; pOp++
      ├─ OP_Transaction (:4245) → BtreeBeginTrans（BUSY 时存 pc 续跑）
      ├─ OP_SeekGE (:4967) → sqlite3BtreeTableMoveto 二分
      ├─ OP_Column (:3035) → 解码记录进寄存器
      ├─ OP_Function (:9028) → pCtx->pFunc->xSFunc
      └─ OP_ResultRow (:1806) → pResultRow 锚定 → rc=SQLITE_ROW
          → goto vdbe_return（:9519 唯一出口）→ 下次 step 从保存的 pc 续跑
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `sqlite3VdbeExec` in vdbe.c:902 | 主解释循环 | 热点变量提升局部；错误统一 goto `abort_due_to_error`（:9480），无 setjmp |
| `sqlite3VdbeMakeReady` in vdbeaux.c:2657 | prepare 收尾装配 | 寄存器堆复用 aOp 尾部 slack 空间，减少 malloc |
| `resolveP2Values` in vdbeaux.c:875 | 反填跳转目标 | **倒序扫**到 OP_Init；jump opcode 编号 < SQLITE_MX_JUMP_OPCODE 让跳过判断一次整数比较 |
| `sqlite3VdbeAddOp3` in vdbeaux.c:270 | emit 指令 | 全库最高频调用之一（431 次 AddOp2） |
| `sqlite3VdbeHalt` | 语句终止收尾 | autoCommit 下自动 commit/rollback |

</details>

## 核心实现

### Mem：flags 即类型系统

`Mem`（= `sqlite3_value`，vdbeInt.h:232-256）是寄存器堆的细胞：

```c title="vdbeInt.h:232 —— 动态类型值单元"
struct sqlite3_value {
  union MemValue { double r; i64 i; int nZero; ... } u;
  char *z; int n; u16 flags; u8 enc; u8 eSubtype;
  sqlite3 *db; int szMalloc; char *zMalloc; void (*xDel)(void*);
};
```

**flags 位编码一切**（vdbeInt.h:309-334）：亲和位 `MEM_Null/Str/Int/Real/Blob/IntReal` + 修饰位（`MEM_Zero` 用 `u.nZero` 计数表示 zeroblob 尾巴，不实际存零）+ **存储所有权三态** `MEM_Dyn/Static/Ephem`（决定 `z` 指向谁、释放时做什么）。`MEM_IntReal` 是专门的混合类型：REAL 亲和列里的整数值按整数存储/比较（快且无损）但按 REAL 语义字符串化——彻底避免 CAST 往返。`MEMCELLSIZE`（:262）划出浅拷贝边界。

### OP_Column：增量解码 + 世代计数器缓存

record 格式（OP_MakeRecord 注释，vdbe.c:3593-3607）：`| hdr-size(varint) | type0..typeN-1(varint) | data0..dataN-1 |`，serial type 表：0=NULL、1-6=变长整数（1/2/3/4/6/8 字节）、7=float、8/9=常量 0/1、≥12 偶=BLOB 奇=TEXT。

OP_Column（:3035-3389）的两级优化：

1. **行缓存**：`pC->cacheStatus != p->cacheCtr` 才需要重新取行。`OP_ResultRow`、`OP_Next` 等改变 `cacheCtr`/置 `CACHE_STALE` 后，**同一行的后续列读全部命中缓存**——O(1) 世代失效而非逐项清除。
2. **增量解析 header**（:3160-3216）：`do{ aType[i]=varint; … }while(i<=p2)` 只解析到第 p2 列为止，`nHdrParsed` 记录进度，后续列复用。

内容在页内时用内联版 `sqlite3VdbeSerialGet`（整数 ONE/TWO/THREE_BYTE_INT 宏直接组装），跨溢出页才物化。

### jump 两趟 label 解析

代码生成是单向流式 emit，向前跳转时目标还不存在：P2 先填负数（label 编号反码，`ADDR()` 宏），`Parse.aLabel` 在 label 定义点回填，`sqlite3VdbeMakeReady` 调 `resolveP2Values()`（vdbeaux.c:875）**从最后一条指令倒序扫到 OP_Init** 完成替换。性能关键：mkopcodeh.tcl 保证所有 jump opcode 编号 < `SQLITE_MX_JUMP_OPCODE`（vdbeaux.c:887 注释）——倒序扫描时一个整数比较即可跳过无关 opcode。顺带完成三件事：推导语句 readOnly/bIsReader、统计 vtab 最大参数、释放 label 数组。

**opcode 编号与 parse token 复用**（mkopcodeh.tcl 头注释）：`OP_Add == TK_ADD`——表达式代码生成时 TK→OP 零转换成本。

### 单出口纪律 + pc 保存的错误模型

无 setjmp/longjmp：所有错误 `goto abort_due_to_error`（:9480）→ `sqlite3VdbeHalt` → 单一出口 `vdbe_return`（:9519）。BUSY 与 SQLITE_ROW 都走 `vdbe_return`，且 `p->pc` 总是指向"下次该执行的指令"——**天然支持 step 续跑、BUSY 重试和中断恢复，不需要任何栈展开**。中断检查不打断热路径：只在 `check_for_interrupt`（:1147）和 jump 边界做。

### 触发器帧 VdbeFrame

`OP_Program` 执行触发器时保存父帧的 pc/aMem/apCsr 到 `VdbeFrame`。帧的内存**由父帧一个 Mem cell 拥有**、释放走 `pDelFrame` 延迟链——避免触发器级联时递归 Mem 释放爆栈（vdbeInt.h:182-189 注释）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 寄存器机抽象 | aOp[] + aMem[] | prepare 一次 step 多次；指令可全局重排/合并 |
| 超类包装 + 柔性数组 | VdbeCursor 四种游标 union；aType[FLEXARRAY] | 一次分配按列数精确大小 |
| 世代计数器缓存失效 | cacheCtr/cacheStatus | O(1) 失效整行缓存 |
| 惰性求值 | deferredMoveto、溢出页假读 | 只在真正需要数据时付出代价 |
| goto 标签式异常 | vdbe_return 唯一出口 | C89 无异常机制的最优替代 |

**为什么用虚拟机而非 AST 直接遍历**（why 集中论述）：(a) AST 解释器每步都要虚分发，扁平 Op 数组只是指针自增 + 一个 switch；(b) **指令流可全局重排**——代码生成器能跨语句做窥孔优化、把公共子表达式物化成 coroutine（`OP_InitCoroutine/OP_Yield`）、把 IN 右侧物化为可复用子程序（`SubrtnSig`，vdbe.h:41）；(c) **加优化 = 加 opcode**，不改执行器骨架——bloom filter 就是证据：`OP_FilterAdd`（:9134）/`OP_Filter`（:9170）两个新 opcode 即完成 JOIN 优化；(d) 可观测：EXPLAIN、bytecode vtab、per-opcode 计数、中断检查只需插在 jump 边界；(e) 平坦指令流是 JIT 友好的下层 IR。

## 模块间交互

- **→ btree.c**：`OP_SeekLT/LE/GE/GT`（:4967）调 `sqlite3BtreeTableMoveto/IndexMoveto`；OP_Column 走 PayloadFetch；OP_Insert 走 sqlite3BtreeInsert。全库约 741 处 sqlite3Btree 调用，vdbe 是最大消费方。
- **→ pager.c**：`OP_Transaction`（:4245）调 `sqlite3BtreeBeginTrans`；写事务还需 statement journal（:4296）。
- **→ func.c**：`OP_Function/OP_PureFunc`（:9028-9079）持有编译期构造好的 P4_FUNCCTX，执行时调 `pCtx->pFunc->xSFunc`。
- **→ vdbesort.c**：`OP_SorterOpen/SorterInsert/SorterSort/SorterNext`——多线程 PMA 外部归并。

## 扩展方式

新增一个 opcode 的完整动作：

1. **`src/vdbe.c`**：写 `/* Opcode: NewName P1 P2 P3 P4 P5 ... ** Synopsis: r[P2]=... */` 文档注释块 + `case OP_NewName`。**注释是生成器输入，格式不可偏离**（:12-19 头部警告"本文件被多个脚本扫描生成派生物，格式即契约"）；case 行尾的 `/* in1, in2, out3, jump, ncycle */` 关键字生成 opcodeProperty[]。
2. opcode 枚举**不用手写**：`tool/mkopcodeh.tcl` 扫 case 行生成 opcodes.h（jump 类自动编到低号段）；`tool/mkopcodec.tcl` 生成 opcodes.c（EXPLAIN 反查名）。
3. `src/vdbeaux.c`：影响语句只读性则同步 `resolveP2Values()` **和 mkopcodeh.tcl**（:894 NOTE 明确要求）；带 P4 则加 `sqlite3VdbeDisplayP4` 分支。
4. 代码生成侧用 `sqlite3VdbeAddOp3()` emit；label 用 `sqlite3VdbeMakeLabel/ResolveLabel`。
5. 测试配套：`VdbeBranchTaken`/`testcase()` 约定（:153-189）保证分支覆盖率可被 VDBE coverage 工具校验。

一句话总结：VDBE 是"编译到寄存器机字节码、由单个巨型 switch 解释、以 flags 编码的 Mem 值单元为数据格式、以世代计数器管理行缓存"的执行引擎——**其所有派生物（EXPLAIN、文档、opcode 枚举）都直接从 vdbe.c 的源码格式生成，代码的排版本身就是 ABI**。
