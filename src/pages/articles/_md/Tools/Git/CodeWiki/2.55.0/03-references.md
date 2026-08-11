---
source:
  type: "源码解读"
  project: "git"
  url: "https://github.com/git/git"
title: "引用管理"
date: "2026-08-11T20:38:04+08:00"
category: [Tools, Git, CodeWiki, "2.55.0"]
tags: ["git", "C", "refs", "reftable", "事务"]
description: "解读 Git 引用管理——files/packed/reftable 三后端策略、ref_transaction 原子事务、ref 迭代器组合、命名空间抽象。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/00-overview)

---

## 模块定位

引用（refs）是对象数据库之上唯一的可变层——分支、标签、HEAD 本质上都是"某个 commit 对象的 SHA 指针"。本模块负责这些指针的存储、读写、原子事务与迭代。它独立成模块是因为引用的存储格式有多种合法选择（经典 loose 文件、packed-refs 单文件、reftable 二进制），且"批量原子更新多个 ref"是 git 操作一致性的关键保证。核心职责边界：负责"哪个名字指向哪个对象"，不负责对象内容本身（那是对象数据库的事）。

## 模块架构

```
struct repository
   └─ refs_private: struct ref_store *        (refs/refs-internal.h:612)
        ├─ be: const struct ref_storage_be *  vtable (refs/refs-internal.h:567)
        │      ┌─ refs_be_files      files-backend.c:4081   经典 loose + packed
        │      ├─ refs_be_packed     packed-backend.c:2149  packed-refs 单文件
        │      └─ refs_be_reftable   reftable-backend.c:2868 reftable 二进制
        ├─ repo: struct repository *
        └─ gitdir
```

`struct ref_storage_be` 是引用后端的完整 vtable，定义 20+ 个函数指针（`init`/`transaction_prepare`/`transaction_finish`/`transaction_abort`/`iterator_begin`/`read_raw_ref`/`optimize`/`fsck` 等）。三后端在 `refs_backends[]` 数组（`refs.c:38`）按 `enum ref_storage_format` 索引注册。`files` 后端内部又组合 `packed` 作为子后端（`files_ref_store_init` at `files-backend.c:179` 内嵌 `packed_ref_store_init`）——packed 只支持读，不支持 symref/reflog/rename。

## 调用链路

**Ref 读取链路**：

```
get_main_ref_store()              refs.c:2360   懒初始化（取 repo->ref_storage_format → be->init）
→ refs_resolve_ref_unsafe()       refs.c:2114   循环最多 SYMREF_MAXDEPTH(5) 次解 symref
  → refs_read_raw_ref()           refs.c:2095
    → be->read_raw_ref()          后端实现
      files: files_read_raw_ref() 先查 loose 缓存，未命中查 packed_ref_store
```

**Ref 事务写链路**（详见概览的状态流图）：

```
ref_store_transaction_begin()  refs.c:1221   分配 transaction，state=OPEN
→ ref_transaction_update()     refs.c:1399   验证 refname + parse_object 验证 + 追加 update
→ ref_transaction_commit()     refs.c:2760
  → ref_transaction_prepare()  refs.c:2682   排序去重 + hook(preparing) + be->transaction_prepare (加锁)
  → be->transaction_finish()   落盘 + hook(committed)
  [失败] → ref_transaction_abort()  refs.c:2733  be->transaction_abort 释放锁 + hook(aborted)
```

![ref 事务状态机](/vibe-reading/images/articles/git-2.55.0/state-flow.svg)

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `get_main_ref_store()` in `refs.c:2360` | 懒初始化主 ref store | 从 repo 取 format → 查 vtable → be->init |
| `refs_resolve_ref_unsafe()` in `refs.c:2114` | 解析 ref 到 oid | 循环解 symref，最多 5 层 |
| `ref_transaction_begin()` in `refs.c:1221` | 开事务 | OPEN 态，支持批量 |
| `ref_transaction_update()` in `refs.c:1399` | 追加 ref 更新 | `parse_object` 验证对象存在 |
| `ref_transaction_prepare()` in `refs.c:2682` | 预备阶段 | 排序去重 + 加锁 + hook |
| `ref_transaction_commit()` in `refs.c:2760` | 提交事务 | prepare→finish，失败 abort |
| `refs_for_each_ref()` in `refs.c:1968` | 遍历所有 ref | 走 iterator vtable |
| `reftable_stack_add()` in `reftable/stack.c` | reftable 追加写 | 栈式多表，auto_compact 合并 |

</details>

## 核心实现

### 三后端策略与 reftable

`struct ref_storage_be` (`refs/refs-internal.h:567`) 是后端契约，三个实现各自实例化：`refs_be_files`、`refs_be_packed`、`refs_be_reftable`。**files 后端**是经典实现：每个 ref 一个 loose 文件（`refs/heads/main` → 一个文件），大型仓库产生数万散碎文件，I/O 开销大、目录遍历慢、原子性差（需逐个 lockfile）。**reftable** 用二进制格式把所有 ref 打包到栈式表文件中解决这些问题：每次写追加一个 `.ref` 表文件（`reftable_stack_add()`），读通过 `reftable_merged_table` 合并所有表的视图，`reftable_stack_auto_compact()` 按几何级数合并旧表保证摊还 O(1) 写开销。Git 3.0（`WITH_BREAKING_CHANGES`）计划默认切 reftable（`repository.h:26`），`repo_migrate_ref_storage_format()` (`refs.c:3345`) 提供迁移路径。

### ref_transaction 原子事务

`struct ref_transaction` (`refs/refs-internal.h:232`) 把多个 ref 更新打包成一次原子操作，三态状态机 `OPEN→PREPARED→CLOSED` (`refs/refs-internal.h:209`)。`ref_transaction_prepare()` (`refs.c:2682`) 先加所有锁、校验所有 old value，再在 `transaction_finish` 中统一落盘——保证 `git update-ref` 一次更新多个 ref 不会出现半成功状态。`reference-transaction` hook 在 preparing/prepared/committed/aborted 四阶段均可介入（`refs.c:2664`），让外部脚本能观测/拦截 ref 变更。`struct ref_update` (`refs/refs-internal.h:88`) 描述单条更新：`new_oid`/`old_oid` + `REF_HAVE_NEW/OLD` flags + reflog 消息 + `parent_update`（symref 拆分时指向父更新）。`REF_TRANSACTION_ALLOW_FAILURE` (`refs.h:785`) 还支持部分失败，让 `git push` 等场景个别 ref 失败不整体回滚。

### ref 迭代器组合

`struct ref_iterator` + `struct ref_iterator_vtable` (`refs/refs-internal.h:266/382`) 用组合模式实现迭代：`merge_ref_iterator_begin()` 合并两个有序迭代器、`overlay_ref_iterator_begin()` (`refs/iterator.c:294`) 让 loose 覆盖 packed（同名 ref loose 优先）、`prefix_ref_iterator_begin()` 前缀过滤+trim。`refs_for_each_ref()` (`refs.c:1968`) → `refs_ref_iterator_begin()` (`refs.c:1833`) 调 `be->iterator_begin()`，`do_for_each_ref_iterator()` (`refs/iterator.c:425`) 循环 `ref_iterator_advance()` 驱动 vtable。files 后端用 overlay 组合 loose 与 packed 迭代器。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 后端策略模式 | `struct ref_storage_be` in `refs/refs-internal.h:567`，`refs_backends[]` in `refs.c:38` | files/packed/reftable 可切换，Git 3.0 默认切 reftable |
| 事务模式 | `ref_transaction` in `refs/refs-internal.h:232` | 批量原子提交，保证 ref 一致性 |
| 迭代器模式 | `struct ref_iterator` + vtable in `refs/refs-internal.h:266` | loose/packed 合并、前缀过滤可组合 |
| 命名空间抽象 | `ref_namespace[]` in `refs.c:91`，`update_ref_namespace()` in `refs.c:165` | HEAD/branches/tags/remote 等可被 config/env 覆盖 |

## 模块间交互

引用管理被 commit（写 HEAD）、branch/tag/checkout 命令、revision walking（读 ref tips）等广泛调用。它依赖对象数据库：事务写时 `parse_object()` (`refs.c:1436`) 验证目标对象存在、`odb_has_object()` (`refs.c:429`) 校验 ref 有效性。依赖 config 读 `core.logallrefupdates`/`core.prefersymlinkrefs`（`files-backend.c:129`）。注册机制：`get_main_ref_store()` (`refs.c:2360`) 从 `repo->ref_storage_format` 取后端枚举 → `find_ref_storage_backend()` (`refs.c:43`) 查 vtable → `be->init()` 创建实例存入 `repo->refs_private`。

## 扩展方式

**新增 ref 后端**：`repository.h:19` `enum ref_storage_format` 加枚举值 → 实现完整 `struct ref_storage_be` vtable → `refs.c:38` `refs_backends[]` 注册 → 实现 `init` 调 `base_ref_store_init()`。

**新增迭代器组合方式**：参照 `merge_ref_iterator`/`overlay_ref_iterator`/`prefix_ref_iterator` 在 `refs/iterator.c` 定义新 struct + vtable + `_begin()` 构造函数。

**修改 ref 事务语义**：改 `ref_transaction_prepare/commit/abort` (`refs.c:2682/2760/2733`) 的状态机，或改后端 `transaction_prepare_fn`/`transaction_finish_fn` (`refs/refs-internal.h:435/439`)。对应测试 `t1400-update-ref.sh`、`t3210-ref-includes.sh`。
