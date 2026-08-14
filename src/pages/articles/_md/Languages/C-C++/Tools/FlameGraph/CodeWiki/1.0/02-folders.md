---
source:
  type: "源码解读"
  project: "FlameGraph"
  url: "https://github.com/brendangregg/FlameGraph"
title: "折叠器族"
date: "2026-08-14T18:07:23+08:00"
category: ["Languages", "C/C++", "Tools", "FlameGraph", "CodeWiki", "1.0"]
tags: ["FlameGraph", "Perl", "awk", "Profiling"]
description: "stackcollapse-* 折叠器族把 13+ 种 profiler 输出折叠为统一的 folded 格式。本文解读 folded 契约、stackcollapse-perf.pl 状态机、PID/comm/event 处理、函数名清理注解及各折叠器差异。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/00-overview)

---

## 模块定位

`stackcollapse-*` 折叠器族是管线的第二段——把各种 profiler 的原始多行栈输出折叠成统一的 folded 格式。模块独立存在是因为"profiler 格式适配"是整个系统中**唯一多变的部分**：perf、DTrace、jstack、pprof、VTune 各有各的输出格式，但下游 `flamegraph.pl` 只认一种格式。把多变收敛到这一层，渲染层才能保持稳定。这一族共 13 个 Perl 脚本 + 3 个 awk 脚本，其中 `stackcollapse-perf.pl`（345 行）最复杂，`stackcollapse.pl`（109 行，DTrace）最简。

---

## 模块架构

所有折叠器共享同一个三段式骨架，只是 parse 段因 profiler 格式而异：

```
┌──────────────────────────────────────────────────────────┐
│  stackcollapse-<profiler>.pl/awk                         │
│                                                          │
│  ① parse (逐行状态机)  ── 各 profiler 格式各异            │
│      │ 区分行类型(注释/header/stack/空行)                │
│      │ 构建 @stack (unshift 使 leaf 在右, root 在左)     │
│      ▼                                                  │
│  ② fold (Hash 累加去重)  ── 完全统一                      │
│      │ remember_stack(join(";",@stack), $count)         │
│      │ $collapsed{$stack} += $count                     │
│      ▼                                                  │
│  ③ output (排序输出)  ── 完全统一                         │
│      foreach (sort keys %collapsed) { print "$k $v\n" } │
└──────────────────────────────────────────────────────────┘
```

②③ 两段在所有折叠器中**逐字相同**（`stackcollapse-perf.pl:343-345`、`stackcollapse.pl:107-109`、`stackcollapse-jstack.pl:172-174` 等都有同一行 `foreach (sort ...) print`）。只有 ① parse 段不同——这是"函数式适配器"模式：每个脚本独立实现 parse，output 完全统一。

---

## 调用链路

以最复杂的 `stackcollapse-perf.pl` 为例，主循环（`:163-341`）是一个**隐式状态机**（无显式 state 变量，靠正则 `if/elsif/else` 分支切换）。状态流转图见概览「运行时行为 > 状态流」。这里的关键调用路径：

```
while (defined($_ = <>))            # :163 逐行读取
  │
  ├─ /^#/                  → 注释态：提取 cmdline 中 target_pname (:167-176)
  ├─ m/^$/                 → 空行态：remember_stack(join(";",@stack),1) (:183-198)
  ├─ /^(\S.+?)\s+(\d+)\/?(\d+)*\s+/  → header 态：解析 comm/pid/tid/event (:203-248)
  ├─ /^\s*(\w+)\s*(.+) \((\S*)\)/     → stack 态：清理函数名+注解 (:253-337)
  │     ├─ strip +0x offset (:262)
  │     ├─ --inline: addr2line 展开 (:264-267)
  │     ├─ split /->/ 拆 inlined 链 (:272)
  │     ├─ tidy_generic / tidy_java (:290-315)
  │     └─ 注解 _[k]/_[j]/_[i] (:327-333) → unshift @stack
  └─ else → warn "Unrecognized line" (:338-339)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `remember_stack($stack,$count)` `:71` | 把栈串加入 `%collapsed` 累加 | 每次调用 count=1，相同栈累加 |
| `inline($pc,$mod)` `:123` | `--inline` 时调 addr2line 展开内联 | 可选，依赖系统 addr2line |
| `tidy_generic($func)` `:290` | 去函数参数/分号/引号 | 通用清理 |
| `tidy_java($func)` `:305` | 简化 Java 签名 | 去参数类型、`$`→`.` |
| 主循环 `:163-341` | 隐式状态机解析 perf script | 无 state 变量，正则分支切换 |

</details>

---

## 核心实现

### folded 格式契约

folded 格式是整条管线的协议，精确定义：

```
func_root;func_mid;func_leaf 31
```

- 分号 `;` 分隔调用栈帧，**根在最左、叶子（实际执行的函数）在最右**。
- 行尾空格 + count（整数或浮点，如 vtune 输出毫秒、perf-sched 输出微秒）。
- `flamegraph.pl:600` 用正则 `/^(.*)\s+?(\d+(?:.\d*)?)$/` 解析。
- 差分扩展：`func;func count1 count2`（`difffolded.pl` 产出，`flamegraph.pl:607` 解析第二列）。
- 注解后缀：`_[k]`(kernel)/`_[i]`(inlined)/`_[j]`(jit)/`_[w]`(waker)，`flamegraph.pl` 据此着色。

**所有折叠器的 ③ output 段都对齐到这个契约**——只要输出符合，就能被 `flamegraph.pl` 消费。这是解耦的关键：新增数据源只需写新折叠器，不改渲染层。输出按字典序 `sort`，目的是让 `flamegraph.pl` 的 `sort @Data` 能高效合并相同前缀的栈。

### stackcollapse-perf.pl 状态机解析

`perf script` 输出每个 sample 是一块：header 行（`comm pid/tid [cpu] timestamp: event:`）+ N 个 stack 行（`pc func (module)`）+ 空行。`stackcollapse-perf.pl` 逐行用正则匹配切换状态：

```perl title="stackcollapse-perf.pl:203-211（header 行的 6 种变体）"
# perf script 的 header 格式有多种变体，正则需同时匹配
/^(\S.+?)\s+(\d+)\/*(\d+)*\s+(?:(\d+)?\s+)?\[(\d+)\]\s+([0-9\.]+):\s*(\S+):/
#        comm   pid  tid?     cpu?      timestamp   event
```

header 行提取 `comm`/`pid`/`tid` 与 `event` 类型。`perf script` 默认输出 TID 不输出 PID（`:205`），所以无 TID 时 `$tid=$pid; $pid="?"`（`:213-216`），需 `perf script -F comm,pid,tid` 才完整。`--pid`/`--tid` 由内部 `$include_pid`/`$include_tid` 标志控制（`:79-80,241-247`）是否把 PID/TID 拼进 `$pname`。stack 行（`:253`）解析 PC 地址、函数名、模块名，做一系列清理后 `unshift @stack`（栈从叶到根构建）。空行触发 `remember_stack`。

### PID/comm 重命名与 event 过滤

```perl title="stackcollapse-perf.pl:221-237（event 默认过滤）"
if ($event_filter eq "") {
    # By default only show events of the first encountered event type.
    # Merging together different types, such as instructions and cycles,
    # produces misleading results.
    $event_filter = $event;
    $event_defaulted = 1;
}
```

`perf record` 可同时采集多种 event（cycles + instructions 等），混合折叠会误导——不同 event 的采样数不能简单相加。默认取第一个 event 类型并过滤其余，用 `$event_warning` 标记保证警告只打印一次（`:228-233`），用 `--event-filter=EVENT` 可显式指定。**comm 重命名**：perf 的线程名可能运行中被改名（如 Java 线程从 `java` 变 `VM Thread`），`pname` 取当前 sample 的 comm 行，且 `$pname =~ tr/ /_/`（`:248`）——空格是 folded 中 stack 与 count 的分隔符，必须替换。不处理则同进程不同 sample 因 comm 变化生成不同 stack 前缀，无法正确去重。

### 函数名清理与注解

stack 行的函数名要经多步清理才能进 folded：

```perl title="stackcollapse-perf.pl:262-315（清理节选）"
$rawfunc =~ s/\+0x[\da-f]+$//;          # 剥离 Linux 4.8+ 的地址偏移
# ... split /->/ 拆 inlined 链 ...
if ($tidy_java and $pname eq "java") {
    $func =~ s/^L// if $func =~ m:/;        # 去 Java JNI 类名前导 L (:314)
}
# tidy_generic($func) 去参数/分号/引号 (:290); tidy_java 简化签名 (:305)
```

```perl title="stackcollapse-perf.pl:327-333（注解：inlined 优先，kernel/jit 需 --all 启用）"
if (scalar(@inline) > 0) {
    $func .= "_[i]";   # inlined（--inline 展开后 @inline 非空）
} elsif ($annotate_kernel == 1 && $mod =~ m/(^\[|vmlinux$)/ && $mod !~ /unknown/) {
    $func .= "_[k]";   # kernel（模块名以 [ 开头或 vmlinux 结尾，且非 unknown）
} elsif ($annotate_jit == 1 && $mod =~ m:/tmp/perf-\d+\.map:) {
    $func .= "_[j]";   # jitted（perf-map-agent 生成的 Java 符号映射）
}
push @inline, $func;
unshift @stack, @inline;               # 栈从叶到根构建
```

**注解顺序与开关**：inlined 优先检测（无 `$annotate_*` 守卫，只要 `@inline` 非空），kernel/jit 则受 `$annotate_kernel`/`$annotate_jit` 控制（由 `--kernel`/`--jit` 设置，`--all` 在 `:119` 同时置二者为 1）。**注意 kernel 检测正则是 `m/(^\[|vmlinux$)/`**——匹配以 `[` 开头（如 `[kernel.kallsyms]`）或以 `vmlinux` 结尾的模块名，并排除 `unknown`；而非匹配字面量 `[kernel.kallsyms]`。

**为什么默认剥离 `+0x` 偏移**：`perf script` 在 Linux 4.8+ 默认输出符号偏移（如 `cpu_startup_entry+0x800047c022ec`），偏移每次采样不同，导致相同函数被当不同栈，无法去重。`stackcollapse.pl:85` 也有 `$frame =~ s/\+[^+]*$//`（但 `$includeoffset` 无命令行选项暴露）。注解 `_[k]`/`_[j]`/`_[i]` 让 `flamegraph.pl` 的 `color()` 能区分内核/JIT/内联着色——这是 `--all` 选项启用全部注解的目的。

### 各折叠器差异速览

| 程序 | 输入来源 | 行数 | 关键差异点 |
|------|---------|------|-----------|
| `stackcollapse-perf.pl` | Linux perf script | 345 | 最复杂；comm/pid/tid、event 过滤、kernel/jit 注解、inline 展开、Java 签名清理、地址偏移剥离 |
| `stackcollapse-perf-sched.awk` | perf sched 调度事件 | 228 | awk；关联 sched_switch/sched_stat_sleep/sched_stat_blocked，输出 off-cpu 累计微秒 |
| `stackcollapse-sample.awk` | macOS `/usr/bin/sample` | 231 | awk；按缩进深度解析 call graph 树，减去子节点时间避免重复计数 |
| `stackcollapse-jstack.pl` | Java jstack(1) | 174 | 过滤非 RUNNABLE；CompilerThread/Signal Dispatcher 排除；epollWait/socketRead0 重标 WAITING/NETWORK |
| `stackcollapse-go.pl` | Go pprof raw | 150 | 分段式（Samples→Locations→Mappings），先存 %stacks，再用 format_statck()（源码原拼法）查 %frames 做 ID→name 映射组装栈 |
| `stackcollapse-vsprof.pl` | VS Profiler CSV | 98 | 按 Level 字段维护栈数组，回退时 splice 截断，1000 帧溢出保护 |
| `stackcollapse-vtune.pl` | Intel VTune CSV | 78 | 按缩进深度构建，selfTime 转毫秒，直接 print 不去重 |
| `stackcollapse-stap.pl` | SystemTap | 84 | `0x... : func+0x.. [kernel]` 格式，`s/.* : //` 提取函数名 |
| `stackcollapse-pmc.pl` | FreeBSD hwpmc | 74 | 按缩进树形，无 hash 去重，`@stack[$indent]` 按缩进索引 |
| `stackcollapse-elfutils.pl` | eu-stack | 98 | 支持 --pid/--tid，PID/TID 前缀加入栈 |
| `stackcollapse-gdb.pl` | GDB bt | 72 | 无 GetOptions 最简，Thread 行作栈分隔 |
| `stackcollapse-aix.pl` | AIX procstack | 61 | 带进程名前缀，tid 行作分隔 |
| `stackcollapse-instruments.pl` | Xcode Instruments | 26 | 最短，按缩进深度每行直出 |
| `stackcollapse-ljp.awk` | Lightweight Java Profiler | 74 | awk，`NF==3` 新栈、`NF==1` 追加帧 |
| `stackcollapse-recursive.pl` | 已 folded 的栈（后处理） | 60 | 非 profiler 适配器，合并直接递归调用 |

**为什么 perf 比其他复杂得多**：(1) perf script 的 header 一行包含 comm/pid/tid/cpu/time/event 六种信息，需正则同时匹配 6 种变体；(2) event 过滤需求（混合 event 误导）；(3) comm 切换问题；(4) 函数名清理量大（地址偏移、Java 签名、Go 方法、inlined 展开）；(5) 模块来源多样（kernel/jit/userspace .so）需分别注解。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 状态机逐行解析 | `stackcollapse-perf.pl:163-341` 的 if/elsif 链 | profiler 输出是多行块结构，状态机是自然表达；jstack/go 用显式 `$state` 变量 |
| Hash 累加去重 | `remember_stack()` `:71` `$collapsed{$stack}+=$count` | 把 N 个采样压缩为栈→计数映射，相同栈折叠到一行 |
| 函数式适配器 | 每脚本独立 parse + 统一 output | 格式适配多变与输出统一正交，无 OO 接口开销，契合脚本风格 |
| awk 互补 | ljp/sample/perf-sched 用 awk | Unix 标配无需装 Perl；perf-sched 的事件关联用 awk pattern-action 范式更自然 |

---

## 模块间交互

```
外部 profiler 输出 (perf script / DTrace / jstack / pprof ...)
        │ stdin 或文件 (<>)
        ▼
   stackcollapse-*.pl/awk  ──→  folded (func;func count)
        │
        │ stdout
        ▼
   flamegraph.pl (主消费者) / difffolded.pl (差分) / grep (行级过滤)
```

折叠器族是纯粹的"格式转换器"：输入是某 profiler 的原始多行输出（通过 `<>` 支持 stdin 或文件参数），输出是 folded 文本到 stdout。下游消费者有 `flamegraph.pl`（主）、`difffolded.pl`（读两份 folded 做差分）、`stackcollapse-recursive.pl`（读已 folded 的栈做递归合并后处理）。awk 实现与 perl 实现功能不等价——ljp/sample/perf-sched 各对应无 perl 版本的 profiler，是补充而非替代。

---

## 扩展方式

新增支持一种 profiler 格式，参考最简的 `stackcollapse-gdb.pl`（72 行）模板：

1. 新建 `stackcollapse-<profiler>.pl`，从任一现有实现复制 `%collapsed` 与 `remember_stack()`
2. 写 `while (<>)` 主循环，用正则区分该 profiler 的行格式（状态机或简单分支）
3. 构建 `@stack` 数组（`unshift` 使 leaf 在右）
4. 在 sample 边界调用 `remember_stack(join(";", @stack), $count)`
5. 结尾加标准输出循环 `foreach (sort keys %collapsed){ print "$k $collapsed{$k}\n" }`

只要 ③ output 段对齐 folded 契约，即可被 `flamegraph.pl` 消费，无需改渲染层。修改栈深度截断则需在 `remember_stack` 调用前 `splice(@stack, -$maxdepth)`（目前所有折叠器都不做截断，深度限制来自上游 perf 采集阶段）。
