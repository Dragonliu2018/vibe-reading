---
title: "Jeandle 类型系统解析"
source:
  type: "article"
  project: "Jeandle-JDK"
  url: "https://zhuanlan.zhihu.com/p/2070567774863234907"
  author: "刘陶峰"
  site: "知乎"
date: "2026-08-11T20:31:20+08:00"
category: ["Languages", "Java", "Tools", "Jeandle-JDK", "Blogs"]
tags: ["JVM", "JIT", "类型系统", "LLVM IR", "编译优化", "Devirtualization", "Type Check Elimination"]
description: "类型系统作为编译优化的重要基石，它决定了 Devirtualization、Constant Field Folding、Type Check Elimination 等重要优化的效果，甚至会进一步影响其他大量优化。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Jeandle 类型系统解析](https://zhuanlan.zhihu.com/p/2070567774863234907) · **作者** 刘陶峰 · **来源** 知乎 · **原文发布** 2026-08-11 · **转载** 2026-08-11

---

类型系统作为编译优化的重要基石，它决定了 Devirtualization、Constant Field Folding、Type Check Elimination 等重要优化的效果，甚至会进一步影响其他大量优化。

与此同时，Java 里几乎到处都是类型检查：`instanceof`、`checkcast`、虚调用解析、数组存入检查……每一次 `instanceof` 在运行时也是一笔不小的开销——它要加载对象的 class，沿着主超类链（或接口的 secondary supers 缓存）做一次子类型判断。

[Jeandle](https://github.com/jeandle) 作为 JVM 的 JIT 编译器，类型系统必然是不可跨过的一道关。

这篇文章会介绍：Jeandle 类型分析接口的基本原理是什么；以及，通过两个**真实 dump 出来的 IR**，来看看它能做到哪些 C2 做不到的。

### 1. 类型信息在 IR 里的编码

Jeandle 把类型信息编码在 LLVM IR 的 attribute 和 metadata 里。主要的来源有这么几类：

>  klass 为 Java 类（class）在 JVM 内部的表示

| 来源 | IR 上的载体 | 说明 |
| --- | --- | --- |
| 方法参数 | 参数 attribute java-klass（可选 java-klass-exact） | 由方法签名决定，稳定存活 |
| 调用返回值 | 返回值 attribute java-klass | 同上，挂在 call/invoke 上 |
| 字段加载 | load 指令的 metadata !java-klass（可选 !java-klass-exact） | 最常见也最“脆弱”，容易被优化删除 |

表中的“java-klass-exact” attribute 和 metadata 表示值的类型只能是这个 klass，而不是这个 klass 的子类。

类型检查本身，在 IR 里是一个 LLVM function 调用：

```text title="instanceof 在 IR 里的编码"
%r = call i1 @jeandle.check_instanceof(ptr %super_klass, ptr nonnull %obj)
```

它接收一个目标 klass 和一个对象，返回这个对象是否是目标 klass 及其子类的实例。

### 2. 一个绕不开的麻烦：metadata 会被优化丢掉

上表里“字段加载”那一行是最常被消费的类型来源，但它有一个脆弱性：前端给字段 load 指令挂上了 `!java-klass`，可 LLVM 自带的标准优化（EarlyCSE、InstCombine 的 load CSE）**只会保留 LLVM 内置那几种 metadata**，遇到 `!java-klass` 这种自定义种类，会直接剥掉。例如两个被 CSE 合并的等价 load，合并后往往就丢了 Java 类型。

如果不补救，经过一些标准优化后，大量字段 load 就对类型分析“不可见”了。Jeandle 的做法是再加一个 pass——`RecoverTypeInfo`，专门把这些丢掉的类型找回来。

`RecoverTypeInfo` 的思路很直接：一个字段 load 的地址可以写成 `(base + offset)` 的形式，那么这个字段的声明类型就可以用 `GetFieldType(base_klass, offset)` 重新算出来。base 的 klass 又可以来自：参数/返回值上扛过了 CSE 的 `java-klass` attribute、另一条还幸存的 `!java-klass`、常量 oop，或者**另一个被找回类型的字段 load**。

### 3. JavaType：三要素与运算

类型分析的产物是一个很小的结构体 `JavaType`：

```java title="JavaType 结构体定义"
struct JavaType {
  uintptr_t Klass = 0;                         // 正类型:已知是哪个 klass(0 = 未知)
  bool Exact = false;                          // 是否精确(恰好是这个类,不是子类)
  SmallDenseSet<uintptr_t, 2> ExcludedKlasses; // 负约束:已知"不是"哪些类
};
```

三个字段，对应三类知识：

- **正类型（`Klass`）**：这个值“是”某个类（或其子类）。
- **精确性（`Exact`）**：是不是恰好这个类。精确类型很有用——`new Cat()` 是精确的 `Cat`，那 `instanceof Dog` 就一定 false（`Cat` 不是 `Dog`）。
- **负约束（`ExcludedKlasses`）**：这个值“不是”某些类。

当一个值可能来自多处（PHI、select），需要合并类型，用的是 `Union`：**正类型取最近公共祖先（LCA，变宽）、负约束取交集（两边都排除才保留）**。当一个值同时受多个约束（比如“基础类型”和“支配分支推导出的类型”），需要收紧，用的是 `Intersect`：**正类型取更窄的子类型、负约束取并集**。这两条对偶的运算贯穿了所有合并与锐化场景。

### 4. 上下文敏感查询与条件追踪

类型分析的入口只有一个函数：

```text title="getJavaType 查询接口"
JavaType getJavaType(Value *V, DominatorTree *DT = nullptr,
                     Instruction *Context = nullptr);
```

它分两种形式。当 `Context` 为空时，是**上下文不敏感**的基础查询：只看 `V` 自身的属性、元数据，以及它的 PHI/select 各分支（走 `Union` 合并）。

当传入 `Context`（通常是某个使用点，比如 `check_instanceof` 的调用）时，会额外做一层**上下文敏感的锐化**：沿着支配树向上走，找到所有支配这个使用点的分支，把“这些分支蕴含的类型约束”叠加上来。返回的是“在程序执行到这个点时，这个值被额外约束成了什么类型”。

上下文敏感的锐化能穿透 `zext`/`sext`/`trunc` 这类整型 cast、识别 `icmp` 与常量的比较、拆解 `and`/`or` 等各类逻辑运算，以及 PHI/select 的合并语义，并且在分析过程中维护这个被查询的值“可能是什么类型”以及“不可能是什么类型”。

### 5. 实例对比 Jeandle 与 C2 的类型系统

下面两个例子都来自 Jeandle 的 jtreg 测试 `TestTypeCheckElimination.java`，类型层级很简单：`Animal` 是基类，`Dog extends Animal implements Barkable`、`Cat extends Animal`、`Poodle extends Dog`。分别 dump 了 Jeandle 和 C2 的 IR。

>  下面的 Jeandle IR 为了可读性做了简化：去掉了 null 检查脚手架、重命名了变量，并用 `@klass.Animal` 这样的符号替换了 IR 里实际的 klass 指针常量。控制结构和“是否折叠”这两个关键点忠实于真实 dump。

### 5.1 负约束

```java title="testDeniedByFailedCheck"
static boolean testDeniedByFailedCheck(Object obj) {
    if (!(obj instanceof Animal)) {
        return obj instanceof Dog;   // 逻辑上必然 false:不是 Animal 就更不可能是 Dog
    }
    return true;
}
```

先看 Jeandle。**优化前**的 IR 里有两个检查——先是 `Animal`（作为守卫），失败后走到 `bci_7`，那里有第二个检查 `Dog`：

```llvm title="Jeandle IR（优化前）"
bci_0:                                       ; —— obj instanceof Animal ——
  %is_animal = call i1 @jeandle.check_instanceof(ptr @klass.Animal, ptr nonnull %obj)
  %ext = zext i1 %is_animal to i32
  %not_animal = icmp eq i32 %ext, 0
  br i1 %not_animal, label %bci_7, label %bci_12   ; 不是 Animal → bci_7

bci_7:                                       ; —— !(obj instanceof Animal) 的分支 ——
  %is_dog = call i1 @jeandle.check_instanceof(ptr @klass.Dog, ptr nonnull %obj)  ; ← 待消除
  %ext2 = zext i1 %is_dog to i32
  ret i32 %ext2

bci_12:
  ret i32 1
```

**优化后**，`bci_7` 里的 `Dog` 检查整个消失了，直接被折叠成常量 `false`：

```llvm title="Jeandle IR（优化后）"
bci_7:                                       ; !(obj instanceof Animal) 的分支
  %ext2 = zext i1 false to i32               ; ← call 没了,直接是 false
  ret i32 %ext2
```

Jeandle 是怎么做到的？条件追踪在 `bci_0` 的分支上发现：走到 `bci_7` 意味着 `Animal` 检查失败了，于是给 `%obj` 记一条负约束 `ExcludedKlasses = {Animal}`。等到查询 `bci_7` 里那个 `Dog` 检查时，它发现 `Dog` 是 `Animal` 的子类型——排除 `Animal` 就排除了 `Animal` 的所有子类型，因此 `instanceof Dog` 必然为假，折叠成 `false`。**这就是负约束这一维能力的直接兑现。**

再看同一个方法 C2 生成的机器码（`PrintOptoAssembly`）：

```text title="C2 PrintOptoAssembly"
B2:  movl  RAX, #1                       ; 预置返回值 true
     movq  R11, ...$Animal               ; 加载 Animal klass
     cmpq  R10, R11                      ; obj 的 klass == Animal ?
     jne,us B4                           ; 不是 Animal → B4
B3:  ...                                 ; 是 Animal → 返回 true
B4:  movq  R11, ...$Dog                  ; 加载 Dog klass   ← 检查还在!
     cmpq  R10, R11                      ; obj 的 klass == Dog ?
     ...
```

在 `B4`（也就是“不是 Animal”的分支），C2 **仍然发出了一条真实存在的 `cmpq` 去比对 Dog klass**。也就是说，运行时如果一个对象不是 Animal，C2 的代码还是会跑一遍 Dog 的子类型判断。C2 的类型传播没有“从失败的检查里提炼出排除类型”这一维能力。

### 5.2 跨 PHI 的 LCA 正向锐化

```java title="testPhiLCAPositiveSharpening"
static boolean testPhiLCAPositiveSharpening(Object obj, boolean flag) {
    boolean check;
    if (flag) {
        check = obj instanceof Dog;
    } else {
        check = obj instanceof Cat;
    }
    if (check) {
        return obj instanceof Animal;   // 逻辑上必然 true:通过 Dog 或 Cat 检查,就一定是 Animal
    }
    return false;
}
```

这里的关键在于 `check` 是**两个 `instanceof` 结果的 PHI**——要么通过了 Dog 检查，要么通过了 Cat 检查。

Jeandle **优化前**的 IR：

```llvm title="Jeandle IR（优化前）"
bci_4:   %is_dog = call i1 @jeandle.check_instanceof(ptr @klass.Dog, ptr nonnull %obj)   ; flag==true
bci_12:  %is_cat = call i1 @jeandle.check_instanceof(ptr @klass.Cat, ptr nonnull %obj)   ; flag==false
bci_17:  %check = phi i32 [%is_cat_ext, %is_dog_ext]     ; check = 合并两个检查结果
         %check_false = icmp eq i32 %check, 0
         br i1 %check_false, label %bci_26, label %bci_21   ; check 为真 → bci_21
bci_21:  %is_animal = call i1 @jeandle.check_instanceof(ptr @klass.Animal, ptr nonnull %obj)  ; ← 待消除
```

**优化后**，`bci_21` 里的 `Animal` 检查被折叠成常量 `true`：

```llvm title="Jeandle IR（优化后）"
bci_21:                                      ; check 为真的分支
  %ext = zext i1 true to i32                 ; ← call 没了,直接是 true
```

这里的推导是：条件追踪处理 `%check` 这个 PHI 时，发现它的两个 incoming 分别是 Dog 检查和 Cat 检查。在 `check` 为真的分支上，意味着“二者之中有一个成立了”。既然 Dog 和 Cat 的最近公共祖先是 `Animal`，那么对象至少是 `Animal`——于是 `instanceof Animal` 必然为真，折叠成 `true`。**这是“跨多个类型检查做 LCA 合并、并用于正向锐化”的能力。**

同一个方法 C2 的机器码：

```text title="C2 PrintOptoAssembly"
B3:  movq  R11, ...$Dog;  cmpq R10,R11;  jne B8      ; instanceof Dog
B11: cmpl  R11, ...$Cat;  jne B14                     ; instanceof Cat
B5:  testl R11,R11;  je B13                           ; 合并后的 check
B6:  movq  R11, ...$Animal; cmpq R10,R11; jne B9      ; ← Animal 检查还在!
```

在合并了 Dog/Cat 两个检查之后，C2 在 `B6` **仍然发出了一条对 Animal klass 的真实比对**。它没有把“两个独立类型检查的析取”在合并点推导成 LCA、再去消掉下游的 `instanceof Animal`。

### 6. 小结

Jeandle 当前的类型系统可以推导出相对准确的类型，为所有类型相关优化奠定了良好的基础。但是当前的实现是一个“即用即查”形式，会带来一定的时间损耗，目前正在实现类型信息的缓存。另外，Jeandle 目前尚不具备基于 profile 的 type speculation，这也是下一步会加强的方向。
