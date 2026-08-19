---
title: "rtrs 移除全部 likely/unlikely 注解，benchmark 证明无性能差异"
source:
  project: "Linux"
  type: "commit"
  id: "4693d6"
  url: "https://github.com/torvalds/linux/commit/4693d6b767d6cab05fe1f650cea3ebc7e1060e4b"
  prType: "refactor"
date: "2026-08-16T19:30:48+08:00"
category: ["OS", "Linux", "PRs"]
tags: ["Linux Kernel", "RDMA", "RTRS", "likely", "unlikely", "Branch Prediction", "Benchmark", "Gioh Kim", "v5.15", "IONOS"]
description: "Gioh Kim 用 fio benchmark 测试发现 RTRS 驱动里散布的 likely()/unlikely() 编译器分支预测提示对性能毫无帮助（IOPS=829k 不变），遂全部移除。涉及 rtrs-clt.c/rtrs-srv.c/rtrs-clt-stats.c 三文件、~30 处 if 语句，包括 __rtrs_get_permit() 的 unlikely(bit >= max_depth)——该函数后来由 c733a5 优化时也**没有再加回 unlikely**（保持一致）。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20210806](https://lore.kernel.org/all/20210806112112.124313-5-haris.iqbal@ionos.com/) · **commit** [4693d6](https://github.com/torvalds/linux/commit/4693d6b767d6cab05fe1f650cea3ebc7e1060e4b) · **首发版本** v5.15-rc1 · **变更行数** +99 行 · **合并时间** 2021-09-02

---

## 背景

`drivers/infiniband/ulp/rtrs/` 的 RTRS（RDMA Transport for RNBD）驱动里散布着大量 `likely()` / `unlikely()` 编译器分支预测提示——几乎每个 `if` 语句都裹了一层。这些提示告诉编译器「这条分支大概率走/不走」，让编译器在生成机器码时把大概率分支排到流水线的前端（fall-through 位置），减少分支预测失败的开销。

问题是：这些提示**真的有用吗**？Gioh Kim（IONOS，RTRS 的开发者之一）写了个 fio benchmark 来验证——结果发现**完全没有区别**：

![rtrs likely/unlikely 移除 benchmark：IOPS 无变化](/vibe-reading/images/articles/linux-commit-4693d6-rtrs-remove-likely-unlikely/benchmark.svg)

三根柱子（改动前有 likely/unlikely → 交换 → 全删）的 IOPS 都是 **829k**（BW 3239 → 3238 → 3238 MiB/s，在测量噪声范围内）。既然加不加都一样，那就**全删**——去掉 ~100 处宏包装，代码更干净、也不留 cargo-cult。

> 这条 commit 动的 `__rtrs_get_permit()`（`rtrs-clt.c:75`，permit 无锁位图分配）正是后来 [c733a5](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-c733a5-rtrs-clt-find-next-zero-bit) 优化的同一函数——而 c733a5 优化同一函数时也**没有再加回 `unlikely()`**——与 4693d6b 的「全删」决策保持一致。见「意义与影响」。

## 前置知识

### `likely()` / `unlikely()` 是什么

它们是 `include/linux/compiler.h` 里的宏，展开为 GCC 的 `__builtin_expect(!!(x), expected_value)`。编译器据此调整机器码布局：`likely(x)` 让编译器把 `x` 为真的分支放在 fall-through（顺序执行、不跳转）位置；`unlikely(x)` 反过来。如果 CPU 的分支预测器猜对了，fall-through 的代码已经在流水线里、不用冲刷；猜错了才跳转、付代价。所以 `likely`/`unlikely` 的本质是**静态地告诉编译器 + CPU「哪条路更可能走」**，让机器码布局顺应概率。

### 为什么可能没用

现代 CPU（尤其是 Xeon Gold 这类服务器 CPU）的分支预测器**非常强**——它们用历史模式动态预测，对一个反复执行的 `if`（比如 RTRS 数据路径里那些），几万次之后就猜得很准了。编译器静态放的 `likely`/`unlikely` 提示，在动态预测器面前几乎被覆盖（branch predictor 先看历史，不看编译器布局）。而且如果提示放错了（实际概率和标注相反），反而可能帮倒忙。RTRS 的 benchmark 正好证明了这一点：数据路径的分支被 CPU 动态预测得很好，静态提示无贡献。

## 涉及的函数与调用链

本 commit 跨 `rtrs-clt.c` / `rtrs-srv.c` / `rtrs-clt-stats.c` 三文件、~30 处 `if` 语句移除 `likely`/`unlikely`。按数据路径分组：

### 客户端（rtrs-clt.c）关键函数

| 函数 | 位置 | 原标注 | 场景 |
|------|------|--------|------|
| `__rtrs_get_permit` | rtrs-clt.c:75 | `unlikely(bit >= max_depth)` / `unlikely(test_and_set_bit_lock(...))` | permit 无锁分配（★c733a5 后续优化同一函数，也没加回 unlikely） |
| `rtrs_clt_get_permit` | rtrs-clt.c:115 | `likely(permit)` / `likely(permit)` | 公开 permit API：拿到 permit 是大概率 |
| `rtrs_permit_to_clt_con` | rtrs-clt.c:175 | `likely(permit->con_type == RTRS_IO_CON)` | permit → 连接：IO 连接是大概率 |
| `rtrs_clt_fast_reg_done` / `rtrs_clt_inv_rkey_done` | rtrs-clt.c:329 / :349 | `unlikely(wc->status != IB_WC_SUCCESS)` | RDMA 完成回调：WC 失败是 unlikely |
| `complete_rdma_req` | rtrs-clt.c:390 | `unlikely(...)` / `likely(can_wait)` ×2 | 请求完成 + invalidation |
| `rtrs_clt_rdma_done` | rtrs-clt.c:605 | `unlikely(wc->status != IB_WC_SUCCESS)` / `likely(imm_type == ...)` | RDMA 完成：成功是大路径 |
| `rtrs_clt_write_req` / `rtrs_clt_read_req` | rtrs-clt.c:1087 / :1180 | `unlikely(tsize > chunk_size)` / `unlikely(!count)` / `unlikely(ret)` | 请求构建：错误是 unlikely |
| `get_next_path_min_inflight` / `get_next_path_min_latency` | rtrs-clt.c:820 / :871 | `unlikely(READ_ONCE(state) != CONNECTED)` / `unlikely(!list_empty(...))` | 多路径选择：非连接是 unlikely |

### 服务端 + 统计

| 文件 | 改动 |
|------|------|
| `rtrs-srv.c` | 74 行：服务端 RDMA 完成、请求处理等处的 `likely`/`unlikely` 全删 |
| `rtrs-clt-stats.c` | 1 处：`unlikely(con->cpu != cpu)` → `con->cpu != cpu`（CPU 迁移统计） |

### 调用链（代表性：permit 分配 + RDMA 完成）

```text title="RTRS 数据路径关键链路（标注被移除的位置）"
IO 提交
  └─ rtrs_clt_get_permit           # likely(permit) → 删
       └─ __rtrs_get_permit        # unlikely(bit>=max_depth), unlikely(test_and_set...) → 删 ★
  └─ rtrs_clt_write_req / read_req # unlikely(tsize>chunk), unlikely(!count), unlikely(ret) → 删
       └─ rtrs_post_send_rdma     # unlikely(!sg_size) → 删
IO 完成
  └─ rtrs_clt_rdma_done           # unlikely(wc->status!=SUCCESS), likely(imm_type==...) → 删
       └─ complete_rdma_req       # unlikely(...), likely(can_wait) ×2 → 删
```

## 实现

改动模式统一：去掉 `unlikely(` / `likely(` 包装、保留条件表达式，有些地方顺势补花括号对齐：

### 代表：`__rtrs_get_permit`（★c733a5 后续优化的同一函数）

```diff title="drivers/infiniband/ulp/rtrs/rtrs-clt.c (__rtrs_get_permit)"
 	do {
 		bit = find_first_zero_bit(clt->permits_map, max_depth);
-		if (unlikely(bit >= max_depth))
+		if (bit >= max_depth)
 			return NULL;
-	} while (unlikely(test_and_set_bit_lock(bit, clt->permits_map)));
+	} while (test_and_set_bit_lock(bit, clt->permits_map));
```

### 代表：`rtrs_clt_rdma_done`（RDMA 完成回调）

```diff title="drivers/infiniband/ulp/rtrs/rtrs-clt.c (rtrs_clt_rdma_done)"
-	if (unlikely(wc->status != IB_WC_SUCCESS)) {
+	if (wc->status != IB_WC_SUCCESS)) {
```

```diff title="rtrs_clt_rdma_done（imm_type 检查）"
-		if (likely(imm_type == RTRS_IO_RSP_IMM ||
-			   imm_type == RTRS_IO_RSP_W_INV_IMM)) {
+		if (imm_type == RTRS_IO_RSP_IMM ||
+		    imm_type == RTRS_IO_RSP_W_INV_IMM) {
```

每处都是「去包装、留条件」——没有逻辑变化，只改编译器提示。

## Review

- 作者 **Gioh Kim**（`gi-oh.kim@ionos.com`，IONOS）—— RTRS/RNBD 的核心开发者之一。`Signed-off-by: Jack Wang` / `Md Haris Iqbal`（同为 IONOS，RTRS 作者），`Reviewed-by: Leon Romanovsky`（`leonro@nvidia.com`，RDMA 子系统维护者），由 **Jason Gunthorpe**（`jgg@nvidia.com`，RDMA 维护者）`Signed-off-by` 收口。
- commit message 附了完整 benchmark 数据（fio random read, 32 RNBD devices, 64 processes, Xeon Gold 6130 @ 2.10GHz, 376G memory, kernel 5.4.86, gcc 8.3.0, ConnectX-5 Infiniband），三组对比（改动前/交换/全删）的 IOPS + BW——这在内核 commit 里少见，给了移除注解的硬数据背书。
- `Link: https://lore.kernel.org/r/20210806112112.124313-5-haris.iqbal@ionos.com`，经 `Merge tag 'for-linus' of git://.../rdma/rdma`（2021-09-02）进 Linus 主线，首见于 v5.15-rc1。

## 问题

### 为什么 `likely`/`unlikely` 在 RTRS 上没用

三个原因叠加：
1. **CPU 动态分支预测器太强**：Xeon Gold 的分支预测器用历史模式动态预测，对数据路径里反复执行的 `if`，几万次后就猜得极准——静态 `likely`/`unlikely` 的机器码布局优势被动态预测覆盖。
2. **RTRS 的分支概率本来就分明**：WC 成功是大路径、失败是少路径——这种「非黑即白」的分支，CPU 动态预测器很快就能学会，不需要编译器静态提示。
3. **提示可能放错**：`unlikely` 标注的分支如果实际概率没那么低，反而让编译器把热路径放到跳转位置、多一次跳转。删掉后编译器自己用 profile/启发式布局，可能更好。

benchmark（829k → 829k → 829k）是铁证：对这个驱动 + 这套硬件 + 这套工作负载，`likely`/`unlikely` 是 zero-benefit。

## 意义与影响

- **代码简化**：~100 处宏包装去掉，`if` 语句更短更直白，阅读时不用再想「这个 unlikely 标对了吗」。
- **去 cargo-cult**：RTRS 的 `likely`/`unlikely` 大概率是写时按直觉放的（WC 失败→unlikely、拿到 permit→likely 等），没有数据支撑。benchmark 给了「该删」的依据，也开了内核社区「用数据验证 hint」的好先例。
- **`__rtrs_get_permit` 的 unlikely 没有被加回来**：4693d6b 删了 `__rtrs_get_permit` 里的 `unlikely(bit >= max_depth)`（benchmark 证明无益）；2026 年 [c733a5](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-c733a5-rtrs-clt-find-next-zero-bit) 优化同一函数、加了 wrap-around fallback 路径时，**也没有加回 `unlikely()`**——虽然 wrap-around 确实是冷路径，但既然数据已证明 unlikely 对 RTRS 无益，就不再加。与「全删」决策保持一致。

## 参考

- **patch 线程** [lore.kernel.org/all/20210806112112.124313-5-haris.iqbal@ionos.com](https://lore.kernel.org/all/20210806112112.124313-5-haris.iqbal@ionos.com/)（Gioh Kim, 2021-08-06）：本 commit 的来路，commit message 含完整 benchmark。
- **`likely`/`unlikely` 宏定义** `include/linux/compiler.h`（展开为 `__builtin_expect`）；GCC 文档「Built-in Function: `long __builtin_expect (long exp, long c)`」。

## 相关阅读

- **rtrs permit 分配改用 find_next_zero_bit 避免竞态后重扫** —— [Linux commit-c733a5](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-c733a5-rtrs-clt-find-next-zero-bit)：同一函数 `__rtrs_get_permit` 的后续优化。c733a5 加了 wrap-around fallback 但**没有加回 `unlikely()`**——与 4693d6b 的「全删 likely/unlikely」保持一致。
- **移除 null_blk 的 bio I/O 路径只留 blk-mq，删掉 get_tag/put_tag 位图分配** —— [Linux commit-8b631f9](/vibe-reading/articles/OS/Linux/PRs/linux-commit-8b631f9-null-blk-remove-bio-path)：RTRS `__rtrs_get_permit` 借鉴的 null_blk `get_tag()` 的后续命运。8b631f9（2024）把 null_blk 整条 bio 路径 + `get_tag`/`put_tag` 删了——和本 commit 一样，都是在清理 RTRS/null_blk 的「遗留代码」。
- **Block I/O 子系统** —— [Linux CodeWiki 7.1 · 05-block-io](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/05-block-io)：block 层（blk-mq、RDMA/block 传输）的 CodeWiki 解读，RTRS/RNBD 的数据路径正处其中。
