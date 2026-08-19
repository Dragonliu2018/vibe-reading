---
source:
  type: "源码解读"
  project: "OpenJDK"
  url: "https://github.com/openjdk/jdk"
title: "类加载与字节码"
date: "2026-08-19T23:29:36+08:00"
category: ["Languages", "Java", "Tools", "OpenJDK", "CodeWiki", "28+11"]
tags: ["OpenJDK", "HotSpot", "ClassFileParser", "SystemDictionary", "Verifier", "FieldLayoutBuilder", "双亲委派"]
description: "HotSpot 类加载模块——.class 文件解析、双亲委派、并行加载与循环检测、字节码验证、字段布局与 javaClasses 偏移映射"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Tools/OpenJDK/CodeWiki/28+11/00-overview)

---

## 模块定位

类加载模块（`share/classfile/`，~51k 行）把磁盘上的 `.class` 文件变成 VM 可用的 `InstanceKlass` 元数据。它负责解析字节流、验证类型安全、计算字段布局、协调双亲委派与并行加载，并把 JDK 核心类的字段偏移映射到 VM。它是字节码执行与 JIT 编译的前提——所有模块都需要已加载、已验证的类。其职责边界是"加载与链接"，不含对象分配（`memory`/`oops`）与方法执行（`interpreter`）。

## 模块架构

![类加载流程](/vibe-reading/images/articles/openjdk-hotspot/classfile-flow.svg)

`SystemDictionary`（`AllStatic` 门面）是加载协调中心，路由到 per-`ClassLoaderData` 的 `Dictionary`（`ConcurrentHashTable`）。`ClassLoader` 管理三层 boot classpath（jimage/patch-module/append）。`ClassFileParser` 逐项解析字节流产出 `InstanceKlass`，`Verifier` 用 StackMapTable 验证类型安全，`FieldLayoutBuilder` 计算紧凑布局，`javaClasses` 在加载后 fixup JDK 类字段偏移。并行加载靠 `Placeholders` 三队列与 `LoaderConstraints` 协调，避免全局锁死锁。

## 调用链路

### 类加载完整链

```
ClassLoader.loadClass("Foo")
  → SystemDictionary::resolve_or_null(name, loader)       (systemDictionary.cpp:382)
      → resolve_instance_class_or_null                     (:606)
         ├─ dictionary->find_class()                       # 无锁快路径
         ├─ MutexLocker(SystemDictionary_lock)              # 重检 + placeholder 循环检测
         ├─ PlaceholderTable::find_and_add(LOAD_INSTANCE)
         ├─ load_instance_class → [boot] ClassLoader::load_class → KlassFactory::create_from_stream (klassFactory.cpp:172)
         │     → ClassFileParser::parse_stream             (classFileParser.cpp:6024)
         │         magic → version → constant_pool → access_flags → this/super → interfaces → fields → methods → attributes
         │     → post_process_parsed_stream (:6281): resolve_super → FieldLayoutBuilder.build_layout (:6411)
         │     → create_instance_klass → fill_instance_klass (:5514)
         ├─ [user loader] JavaCalls 调 ClassLoader.loadClass（Java 层双亲委派）
         ├─ check_constraints → LoaderConstraintTable::check_or_update  (loaderConstraints.cpp:399)
         └─ update_dictionary → dictionary->add_klass
```

链接阶段 `InstanceKlass::link_class_impl` → `Verifier::verify`（`verifier.cpp:183`）→ `Method::link_method`（`method.cpp:1313`）设入口 → vtable/itable 初始化。

### 并行加载与循环检测

`Placeholders`（`placeholders.hpp:50`）用三种 action 协调 per-class-per-loader 并发：`LOAD_INSTANCE`（首线程加载，余者 `wait` 复用）、`DEFINE_CLASS`（`_definer` 持 token，`AllowParallelDefine` 允许并行）、`DETECT_CIRCULARITY`（`circularityThreadQ` 追踪递归解析线程，自引用即循环）。三种 action 共享同一 `PlaceholderEntry` 的三个独立 `SeenThread` 队列。循环检测在 `ClassFileParser::post_process_parsed_stream`（`classFileParser.cpp:6311`）调 `resolve_with_circularity_detection`（`systemDictionary.cpp:459`）：若同一线程已在 `circularityThreadQ` 中，抛 `ClassCircularityError`。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `SystemDictionary::resolve_or_null` (`systemDictionary.cpp:382`) | 类解析入口 | 路由到 Dictionary + placeholder |
| `ClassFileParser::parse_stream` (`classFileParser.cpp:6024`) | 解析 .class | 逐项解析常量池/字段/方法/属性 |
| `Verifier::verify` (`verifier.cpp:183`) | 字节码验证 | StackMapTable O(n) 类型检查 |
| `FieldLayoutBuilder::build_layout` (`fieldLayoutBuilder.cpp:336`) | 字段布局 | 紧凑布局 + oopmap 优化 |
| `JavaClasses::compute_offsets` (`javaClasses.cpp:4200`) | JDK 类偏移 | 加载后按名+签名查偏移 |
| `PlaceholderEntry::check_seen_thread` (`placeholders.hpp:137`) | 循环检测 | SeenThread 队列 |

</details>

## 核心实现

### ClassFileParser

`ClassFileParser`（`classFileParser.hpp:118`）持 `_stream`(ClassFileStream)、`_loader_data`、`_cp`、`_methods`、`_temp_field_info`、`_layout_info`。`parse_stream`（`:242`/`:6024`）按 JVM 规范顺序解析：magic(`0xCAFEBABE`) → version → constant_pool → access_flags → this/super_class → interfaces → fields → methods → attributes。`post_process_parsed_stream`（`:6281`）解析超类、计算 transitive interfaces 与 vtable/itable size，调 `FieldLayoutBuilder` 布局，最后 `create_instance_klass`（`:558`）→ `fill_instance_klass`（`:5514`）转移元数据到 `InstanceKlass`。

### 双亲委派与安全性

`SystemDictionary::load_instance_class_impl`（`systemDictionary.cpp:1363`）：boot loader 从 jimage 加载真品（`:1430`），user loader 经 JNI 调 `ClassLoader.loadClass()`（`:1475`），Java 层先 `parent.loadClass()` 再 `findClass()`。核心安全目标是**防止核心 API 被恶意替换**——即使用户 loader 尝试加载 `java.lang.String`，请求先委派到 boot loader 从 jimage 加载真品，恶意代码无法注入伪造核心类。`ClassLoader.loadClass` 是模板方法骨架，`findClass` 是扩展点。

### 并行加载的锁细化

全局锁串行所有加载会性能极差且易死锁。HotSpot 分层：parallelCapable loader 跳过对象锁（`systemDictionary.cpp:287`）；`SystemDictionary_lock` 只保护 placeholder/dictionary 写入；`Placeholder` 按三种 action 协调 per-class-per-loader 并发；`LoaderConstraintTable`（`loaderConstraints.cpp`）记录"不同 loader 对同类名须解析出同一 InstanceKlass"的约束而非锁住所有 loader。锁粒度从全局细化到 per-class-per-loader，避免死锁，仅在约束违反时抛 `LinkageError`。设计依据 OOPSLA'98 *Dynamic Class Loading in the Java VM*。

### Verifier 与 StackMapTable

`Verifier`（`verifier.hpp:44`，`AllStatic`）入口门面，`ClassVerifier`（`:300`，`StackObj`）每类验证实例。验证在链接阶段先于任何字节码执行，原因：**类型安全**（未验证字节码可非法转换/栈下溢）；**JIT 前提**（C1/C2 假设已验证，省略大量运行时检查）；**StackMapTable**（Java 7+ class 含预计算类型状态，`verify_stackmap_table` O(n) 检查帧兼容性，替代旧 `inference_verify` O(n²) 推断，失败可 failover 回退）。

### FieldLayoutBuilder 与 javaClasses

`FieldLayoutBuilder`（`fieldLayoutBuilder.hpp:272`，JEP 8277796）四步布局：`prologue`(继承父类布局)→`regular_field_sorting`(按大小降序减 padding)→layout(在 EMPTY 块填洞)→`epilogue`(生成 oopmap/size)。按父类是否以 oop 结尾决定 oop 字段顺序以合并 oop map 条目，降 GC 扫描成本；支持 `@Contended`(独立 FieldGroup+padding)与 Valhalla inline type 扁平化。`javaClasses`（`javaClasses.cpp:4200`）需 fixup 偏移的原因：JDK 源码字段布局可变（`String.value` JDK 9+ 是 `byte[]`）、VM 注入字段（如 `Thread` 的 jvmti 状态）、bootstrap 顺序（`java.lang.Class` 需先加载才能建 mirror，故延迟到 `fixup_mirror_list`）。CDS 可序列化偏移跳过重算（`serialize_offsets`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双亲委派（模板方法） | `systemDictionary.cpp:1363` | 保核心类不被替换的安全基线 |
| Registry | `SystemDictionary` + per-CLD `Dictionary` | 全局唯一入口按 loader 分片 |
| 并行加载（锁细化+Token） | `Placeholders` 三队列 (`placeholders.hpp:50`) | per-class-per-loader 协调避免死锁 |
| 延迟初始化/Fixup | `javaClasses::compute_offsets` (`javaClasses.cpp:4200`) | 应对 JDK 字段布局可变与 bootstrap 顺序 |
| 工厂 | `KlassFactory::create_from_stream` (`klassFactory.cpp:172`) | 隔离 ClassFileParser 与 SystemDictionary，处理 JVMTI CFLH |

## 模块间交互

`classfile` 依赖 `oops`(InstanceKlass/ConstantPool/Method)、`runtime`(Handle/MutexLocker/JavaCalls)、`memory`(ResourceMark/Metaspace)。被 `interpreter`（`linkResolver` 解析常量池引用）、`compiler`（查类层次，假设已验证）、`runtime`（启动 `vmClasses::resolve_all`）、`prims`（JVMTI CFLH 改 class 字节）依赖。

## 扩展方式

新增一个 class 属性解析：`classFileParser.hpp` 加成员；`classFileParser.cpp:384` `parse_classfile_attributes` 加 `case`；新增 `parse_xxx_attribute` 方法；`fill_instance_klass`(`:5514`) 转移到 InstanceKlass；`instanceKlass.hpp/cpp` 加存储访问方法。新增 VM 注入字段：`javaClasses.hpp` 的 `XXX_INJECTED_FIELDS(macro)` 加条目，`classFileParser.cpp:1559` `parse_fields` 经 `JavaClasses::get_injected` 动态添加参与布局，`javaClasses.cpp:4296` `InjectedField::compute_offset` 查偏移。
