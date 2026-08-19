---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "代码生成"
date: "2026-08-19T15:05:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "代码生成", "LLVM", "CodeWiki"]
description: "rustc 的多后端 codegen 抽象、单态化与 MIR→LLVM IR 翻译。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

代码生成把类型安全的 MIR 落到具体平台的机器码。`rustc` 用一个**后端无关的 SSA 抽象层**（`rustc_codegen_ssa`）把 MIR→IR lowering 逻辑写一次，多后端（LLVM/Cranelift/GCC）实现 trait 接入复用。这一层还负责**单态化**（monomorphization）——为每个泛型具体类型生成一份代码，这是 Rust 零成本抽象的代价与基础。涉及 crate：`rustc_codegen_ssa`（抽象层）、`rustc_codegen_llvm`（LLVM 后端），另有 `rustc_codegen_gcc`/`rustc_codegen_cranelift` 替代后端。

## 模块架构

- **`CodegenBackend` trait**（`rustc_codegen_ssa/src/traits/backend.rs:36`）：多后端顶层接口，定义 `codegen_crate`/`join_codegen`/`link` 三个核心生命周期方法，加 `target_config`/`replaced_intrinsics`/`metadata_loader` 等配置方法。`link` 有默认实现调 `link_binary`。
- **`BackendTypes` trait**（`:20`）：后端关联类型 `Function`/`BasicBlock`/`Value`/`Type`/`DIScope` 等——让 SSA 层泛型操作不同后端 IR。
- **`ExtraBackendMethods`**（`:163`）：补充 `codegen_allocator`/`compile_codegen_unit`。
- **`WriteBackendMethods`**（`traits/write.rs:16`）：后端写入/优化能力 `optimize`/`codegen`（IR→object）/`run_thin_lto`/`optimize_and_codegen_fat_lto`。
- **`LlvmCodegenBackend`**（`rustc_codegen_llvm/src/lib.rs:77`）：单元结构体 `pub struct LlvmCodegenBackend(())`，实现 `ExtraBackendMethods`（`Module = ModuleLlvm`）与 `WriteBackendMethods`，`name()` 返回 `"llvm"`。
- **`FunctionCx<'a,'tcx,Bx>`**（`rustc_codegen_ssa/src/mir/mod.rs:52`）：MIR→后端 IR lowering 主上下文，持 `instance`、`mir: &Body`、`llfn: Bx::Function`、`fn_abi: &FnAbi`、`cached_llbbs`（MIR BasicBlock→后端 BasicBlock 惰性映射）、`funclets`（MSVC SEH cleanup）、`landing_pads`。
- **`ModuleCodegen<M>`**（`rustc_codegen_ssa/src/lib.rs:59`）：封装一个编译单元的后端模块，含 `name`/`module_llvm: M`/`kind: ModuleKind`/`thin_lto_buffer`。

## 调用链路

```
CodegenBackend::codegen_crate (base.rs:714)
  ├→ tcx.collect_and_partition_mono_items()  // 单态化收集 → MonoItemPartitions
  ├→ backend.codegen_allocator()
  ├→ start_async_codegen()                   // 启动 LLVM 后台线程调度器 OngoingCodegen
  └→ for each CGU:
       backend.compile_codegen_unit(tcx, cgu_name)   // llvm/base.rs:64
         └→ module_codegen()                          // :83
              ├→ ModuleLlvm::new() + CodegenCx::new()
              ├→ for mono_item: mono_item.predefine()  // 先声明所有符号（前向引用）
              └→ for mono_item: mono_item.define()     // 再填充定义 (mono_item.rs:29)
                    └→ MonoItem::Fn(instance) → base::codegen_instance(cx, instance)  // base.rs:395
                          └→ mir::codegen_mir(cx, instance)  // mir/mod.rs:203
                                ├→ cx.get_fn(instance)
                                ├→ 构建 FunctionCx (cached_llbbs, fn_abi 等)
                                └→ for bb in RPO: fx.codegen_block(bb)  // block.rs:1557
                                      └→ fx.codegen_terminator()  // block.rs:1608
                                            match TerminatorKind:
                                              Goto → br
                                              SwitchInt → switch
                                              Return → ret
                                              Call → codegen_call_terminator
                                              Drop → codegen_drop_terminator
       submit_codegened_module_to_llvm()    // 提交给 OngoingCodegen 调度器

CodegenBackend::join_codegen → 等待所有 CGU 完成 → CompiledModules
CodegenBackend::link → link_binary (back/link.rs:305)
```

关键设计：**两遍遍历**——先 `predefine` 所有 mono item 符号（保证前向引用），再 `define` 填充函数体（`mono_item.rs:112-125`）。`codegen_mir` 按逆后序（RPO）遍历 MIR basic blocks（`mir/mod.rs:291`），惰性创建后端 BasicBlock（`CachedLlbb` 枚举 None/Some/Skip）。

## 核心实现

### 为什么 SSA 层抽象后端

`CodegenBackend` + `BackendTypes` + `BuilderMethods` + `WriteBackendMethods` 构成四层 trait 体系，`FunctionCx` 等核心逻辑全部泛型于 `Bx: BuilderMethods`，实现后端无关的 SSA 层。MIR→IR lowering 逻辑（`FunctionCx`、`codegen_terminator` 等，约数万行）只需写一次，多个后端复用。LLVM/Cranelift/GCC 后端只需实现 trait 方法。代价是 trait 边界多、编译时间增加，换来巨大的可维护性。

### Monomorphization vs 动态分发

Rust 默认对所有泛型做 monomorphization（每个具体类型实例生成一份代码），`collect_and_partition_mono_items` 产出 `MonoItem::Fn(Instance)` 列表。`dyn Trait` 才走 vtable 动态分发（`load_vtable`）。这换来零成本抽象，代价是二进制体积膨胀——`codegen_crate` 的 CGU 大小交错排序策略（`base.rs:777-783`）平衡内存使用。

### 增量编译的元数据设计

`ModuleCodegen` 含 `thin_lto_buffer`（`lib.rs:70`），`CguReuse` 枚举（`base.rs:842-878`）区分 `No`/`PreLto`/`PostLto` 三种复用策略，未改动的 CGU 直接从缓存加载跳过 codegen，通过 `submit_pre_lto_module_to_llvm`/`submit_post_lto_module_to_llvm` 提交。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Strategy/trait 抽象 | `CodegenBackend`+`BackendTypes`+`BuilderMethods`+`WriteBackendMethods` | MIR→IR lowering 写一次多后端复用 |
| 模板方法 | `codegen_crate` (`base.rs:714`) | 固定 collect→predefine→define→submit→link 流程 |
| 两遍定义 | `predefine`/`define` (`mono_item.rs:112-125`) | 确保符号前向引用安全 |
| Builder | `BuilderMethods` trait (`traits/builder.rs:37`) | 封装后端 IR builder 操作 |

## 模块间交互

消费 MIR + Ty：`codegen_mir` 通过 `tcx.instance_mir(instance.def)`（`mir/mod.rs:212`）获取 MIR body，通过 `cx.fn_abi_of_instance` 获取 `FnAbi`（来自 `rustc_target::callconv`），消费 `Instance`（来自 `rustc_middle::ty`，已 monomorphize）。与 `rustc_metadata`：`link_binary` 接收 `EncodedMetadata`（`back/link.rs:310`）把 crate 元数据嵌入 rlib；`CodegenBackend::metadata_loader` 返回 `DefaultMetadataLoader` 加载依赖 rlib 元数据。与 `rustc_target`：`FnAbi`/`PassMode`/`ArgAbi` 定义调用约定。与 `rustc_monomorphize`：`tcx.collect_and_partition_mono_items(())`（`base.rs:737`）是查询入口。与 `trait_selection`：vtable 加载通过 `crate::meth::load_vtable`（`base.rs:48`），动态分发查 `Instance::resolve` 确定具体方法。

## 扩展方式

新增 intrinsic 的 codegen：在 `rustc_codegen_ssa/src/mir/intrinsic.rs` 的 `codegen_intrinsic` match 加分支，在 `rustc_codegen_llvm/src/intrinsic/` 实现 LLVM intrinsic 映射；若后端不原生支持，在 `CodegenBackend::replaced_intrinsics`（`backend.rs:75`）或 `fallback_intrinsics`（`:81`）声明让 SSA 层用 MIR fallback body。新增后端：实现 `CodegenBackend`+`ExtraBackendMethods`+`WriteBackendMethods`+`BackendTypes`+`BuilderMethods`，在 `rustc_interface/src/util.rs::get_codegen_backend` 注册，或通过 `Config.make_codegen_backend` 运行时注入（`cg_clif` 的方式）。修改 `TerminatorKind` 的 codegen：改 `rustc_codegen_ssa/src/mir/block.rs:1608` 的 `codegen_terminator` match 分支，由于泛型于 `Bx`，修改一次所有后端生效。
