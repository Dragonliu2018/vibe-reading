---
source:
  type: "源码解读"
  project: "FlameGraph"
  url: "https://github.com/brendangregg/FlameGraph"
title: "Overview"
date: "2026-08-14T18:07:23+08:00"
category: ["Languages", "C/C++", "Tools", "FlameGraph", "CodeWiki", "1.0"]
tags: ["FlameGraph", "Perl", "Profiling", "Visualization", "SVG"]
description: "FlameGraph 是 Brendan Gregg 的火焰图可视化工具集。本文从三阶段流水线、folded 格式契约、stackcollapse 折叠器族、flamegraph.pl 渲染引擎到差分/hot-cold 变体，全面解读 v1.0 的 Perl 实现。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.0 · **协议** CDDL-1.0（`files.pl` 为 Apache-2.0 例外）· **语言** Perl ≥ 5.10 + awk + sh · **代码量** ~5,000 行 · **仓库** [GitHub](https://github.com/brendangregg/FlameGraph)

---

## 总览

### 项目简介

**FlameGraph** 是性能分析领域事实标准的火焰图（Flame Graph）可视化工具集，由 Brendan Gregg 维护。它解决的核心问题是：**profiler 采样的调用栈数据很难直接阅读**——一次 60 秒的 CPU 采样可能产生数万条多行调用栈，肉眼无法从中定位热点。FlameGraph 把这些栈折叠、去重、按占比绘制成一张可交互的 SVG：x 轴宽度代表函数的采样占比（越宽越热），y 轴高度代表调用栈深度，点击可缩放、Ctrl-F 可搜索高亮。

核心价值是把"哪段代码占用了 CPU/内存/IO"这件事**可视化**并**量化**，让性能瓶颈一眼可见。核心使用场景是 CPU profiling（配合 Linux perf、DTrace、SystemTap）、Java profiling（jstack、perf-map-agent）、off-CPU/wakeup 分析，以及差分对比（before/after 两个 profile 的差异）。

**项目边界**：FlameGraph **只负责折叠与渲染**，不负责"采集栈"——采集依赖外部 profiler（perf、DTrace、jstack 等）。它是一组独立的命令行脚本，通过 Unix 管道组合，零外部 CPAN 依赖，任何装了 Perl 的系统都能跑。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| 火焰图渲染 | `flamegraph.pl` | folded 数据 → 交互式 SVG，1125 行核心引擎 |
| hot/cold 图 | `dev/hotcoldgraph.pl` | on-CPU(红)/off-CPU(蓝) 合并展示 |
| perf 折叠 | `stackcollapse-perf.pl` | Linux `perf script` → folded，最复杂的折叠器 |
| 通用折叠 | `stackcollapse.pl` | DTrace 栈 → folded，最简实现 |
| 多 profiler 折叠 | `stackcollapse-*.pl/awk` | jstack/go/gdb/vtune/vsprof/stap/pmc/aix/instruments/elfutils/ljp |
| 差分图 | `difffolded.pl` | 两份 folded → 双列 count，配合 `--negate` |
| 时间区间 | `range-perf.pl` | 按 perf 时间区间切片，看性能随时间变化 |
| 包拆分 | `pkgsplit-perf.pl` | 按 Java 包路径拆分栈（IP 采样，非调用栈） |
| 文件占用 | `files.pl` | 文件系统大小 → folded，存储可视化 |
| Java 符号 | `jmaps` | 为 java 进程生成 `/tmp/perf-PID.map` 符号映射 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Perl | 核心 | 全部 `.pl` 脚本（`flamegraph.pl`、`stackcollapse-*.pl`、`difffolded.pl` 等），仅需核心模块 `Getopt::Long`/`Getopt::Std`/`POSIX`/`File::Find` |
| awk | 核心 | `stackcollapse-ljp.awk`、`stackcollapse-sample.awk`、`stackcollapse-perf-sched.awk`——Unix 标配，无需装 Perl |
| sh | 核心 | `jmaps`、`record-test.sh`、`test.sh` 辅助脚本 |
| 外部 profiler | 可选 | perf / DTrace / jstack / pprof 等（采集阶段，非本仓库） |
| `addr2line` | 可选 | `stackcollapse-perf.pl --inline` 展开内联函数 |
| CPAN 模块 | 无 | **零外部依赖**——`package SVG` 自实现 SVG 生成，不依赖 `SVG.pm` 或 `GD` |

### 版本历史

FlameGraph 是一个长期演进的工具集，无严格的语义化版本。`v1.0` 是仓库首个 git tag（commit `a8d807a`，"fix #125"），标记了 API 稳定节点——此时 `flamegraph.pl` 的 `--colors`/`--hash`/`--cp`/`--nameattr`/`--negate` 选项族与 `package SVG` 架构已成型，`stackcollapse-perf.pl` 已支持 `--pid`/`--tid`/`--kernel`/`--jit`/`--all`/`--addrs` 注解体系。`dev/hotcoldgraph.pl` 作为实验性 off-CPU 可视化存在于 `dev/` 目录。

---

## 快速上手

仓库自带示例数据，最快看到"跑起来"的方式是用自带的 perf 样本生成一张火焰图：

```bash title="快速上手：用自带样本生成火焰图"
# 在仓库根目录执行
gunzip -c example-perf-stacks.txt.gz | ./stackcollapse-perf.pl --all | \
  ./flamegraph.pl --color=java --hash > example.svg
```

**预期输出**：生成 `example.svg` 文件，用浏览器打开（`file://.../example.svg`）即可看到一张可交互的火焰图——点击任意方框缩放该栈帧，Ctrl-F 搜索函数名高亮，鼠标悬停显示采样数与占比。这条命令覆盖了完整的 **采集输出 → 折叠 → 渲染** 三阶段管线。

- `stackcollapse-perf.pl --all`：`--all` 启用全部注解（`_[k]` 内核、`_[j]` JIT、`_[i]` 内联），让 `flamegraph.pl` 能用不同颜色区分内核/用户态。
- `flamegraph.pl --color=java --hash`：`--color=java` 选 Java 调色板（绿色=Java、黄色=C++、红色=用户态 native、橙色=内核），`--hash` 使同一函数名跨图颜色一致。

> 这是 README 推荐的典型工作流：在目标机器上 gzip 压缩 profile，拷贝到笔记本分析。仓库 `demos/` 目录有更多现成 SVG 示例（需 `git clone` 后本地打开，GitHub 不直接渲染 SVG）。

---

## 架构设计解析

### 系统架构

FlameGraph 的架构思想是 **Unix 管道流水线 + 极简文本契约**。它没有传统分层应用的服务器/数据库/业务层，而是一条数据处理管线：**采集 → 折叠 → （可选处理）→ 渲染**。这样设计是为了让每个环节可独立调试、可自由组合——profiler 格式千变万化（多变的"采集"），但 SVG 渲染逻辑稳定（稳定的"渲染"），中间用一种极简的文本格式（folded）解耦。

![FlameGraph 三阶段流水线架构](/vibe-reading/images/articles/flamegraph-1.0/architecture.svg)

纵向四段：采集层（外部 profiler + 采集脚本）→ 折叠层（`stackcollapse-*` 系列适配各种格式）→ 处理层（可选的差分/区间/拆分）→ 渲染层（`flamegraph.pl` 生成 SVG）。`folded: func;func count` 是折叠层与渲染层之间的契约——只要产出这种文本，渲染层不关心数据来自哪个 profiler。处理层是旁路可选的，folded 数据可直接进渲染层，也可先经 `difffolded.pl` 做差分。

| 架构层 | 包含目录/文件 | 层职责（为什么这层存在） |
|--------|-------------|-------------------------|
| 采集层 | 外部 profiler + `aix-perf.pl`、`jmaps`、`files.pl` | 隔离 profiler 差异，产出原始多行栈文本；本仓库只提供少量采集辅助，主力采集由外部工具完成 |
| 折叠层 | `stackcollapse-*.pl`、`stackcollapse-*.awk` | 适配各种 profiler 输出，折叠去重为统一的 folded 格式（多变格式的收敛点） |
| 处理层 | `difffolded.pl`、`range-perf.pl`、`pkgsplit-perf.pl`、`stackcollapse-recursive.pl` | 对 folded/perf 数据做后处理（差分/区间/拆分/递归合并），不改变契约只变换数据 |
| 渲染层 | `flamegraph.pl`、`dev/hotcoldgraph.pl` | 消费 folded 数据，构建栈树、分配宽度、着色、嵌入交互 JS，输出 SVG |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| **函数式适配器** | `stackcollapse-*.pl` 各自独立 | 每个 profiler 格式一个脚本，parse 逻辑各异但 output 统一（`sort + print "$k $v"`），无 OO 继承/接口开销，契合 Perl 脚本风格 |
| **Hash 累加去重** | `remember_stack()` in `stackcollapse-perf.pl:71` | `%collapsed{$stack} += $count`，相同栈折叠到一行，把多行采样压缩为栈→计数映射 |
| **命名空间隔离** | `{ package SVG; ... }` in `flamegraph.pl:230` | 花括号块限定 SVG 生成方法作用域，不与主程序函数冲突，且零 CPAN 依赖自实现绘图库 |
| **增量前缀合并** | `flow()` in `flamegraph.pl:529` | 依赖字母序相邻，只比较公共前缀长度即可合并，O(N×L) 把折叠行聚成树 |
| **面向行的文档模型** | folded 格式 + grep 管道 | 每行一完整栈记录，行间无依赖，使 `grep funcA | flamegraph.pl` 这类 Unix 组合天然可行 |

### 核心概念

#### 核心对象

FlameGraph 运行时的核心数据结构都在 `flamegraph.pl` 中：

| 核心对象 | 定义位置 | 含义 | 生命周期 | 主要关系 |
|---------|---------|------|---------|---------|
| `%collapsed` | `stackcollapse-perf.pl:69` | stack 字符串 → 累计 count | 单次折叠运行 | 由 `remember_stack()` 填充，序列化为 folded 输出 |
| `%Node` | `flamegraph.pl:525` | 最终帧数据，key=`func;depth;etime`，value=`{stime,delta}` | 渲染运行 | 由 `flow()` 从 `%Tmp` 定稿，绘制时遍历 |
| `%Tmp` | `flamegraph.pl:526` | 正在构建的帧暂存，key=`func;depth` | 单次 `flow()` 调用间 | `flow()` 把完成的帧移入 `%Node` |
| `%Folded` | `difffolded.pl:54` | stack → `{1=>c1, 2=>c2}` 双列计数 | 差分运行 | 读两份 folded 对齐后输出三列 |
| `%palette_map` | `flamegraph.pl:117` | 函数 → 颜色串缓存 | `--cp` 跨运行持久化到 `palette.map` | `color_map()` 查询命中则复用 |

#### 核心抽象

FlameGraph 没有传统的接口/抽象类继承体系（它是过程式 Perl 脚本），但有一个隐含的"契约"作为扩展点：

| 契约 | 定义位置 | 实现者 | 注册方式 |
|------|---------|--------|---------|
| **folded 格式** | `func;func count`，被 `flamegraph.pl:600` 的正则 `/^(.*)\s+?(\d+(?:.\d*)?)$/` 解析 | 所有 `stackcollapse-*` 与 `difffolded`、`pkgsplit`、`files` | stdout 输出即"注册"，管道喂给 `flamegraph.pl` |
| **调色板** | `color()` in `flamegraph.pl:337` 的 `if ($type eq "...")` 分支 | 内置 14 种（hot/mem/io/java/perl/js/wakeup/chain/...） | `--colors` 选项选择；新增即在 `color()` 加分支 |
| **nameattr 属性** | `flamegraph.pl:202` 解析 `funcname\tkey=val` | 用户提供 `--nameattr` 文件 | 属性文件加载到 `%nameattr`，零代码扩展超链接/tooltip |

对象关系（`flamegraph.pl` 内部数据流）：

```
stdin/文件 folded 行
   │ foreach (sort @Data)        ← 字母序，使相邻行共享前缀
   ▼
flow()  ──→  %Tmp (开启新帧)  ──→  %Node (定稿旧帧，锁定 etime)
   │                                    │
   │ $time += $samples                  │ 剪枝 (< minwidth_time 删除)
   ▼                                    ▼
$widthpertime = (width-2xpad)/timemax   遍历 %Node 绘制
   │                                    │
   ▼                                    ▼
x = stime×widthpertime      color()/color_scale() → SVG <g> 帧
```

---

## 代码目录

```
FlameGraph/
├── flamegraph.pl              # 渲染引擎核心（1125 行）
├── stackcollapse-perf.pl       # perf 折叠器（345 行，最复杂）
├── stackcollapse.pl            # DTrace 通用折叠器（109 行，最简）
├── stackcollapse-*.pl/awk      # 各 profiler 折叠器族（13 个）
├── difffolded.pl               # 差分折叠（115 行）
├── range-perf.pl               # perf 时间区间分桶（137 行）
├── pkgsplit-perf.pl           # 包路径拆分（86 行）
├── files.pl / aix-perf.pl     # 文件占用 / AIX 采集辅助
├── jmaps                       # Java perf 符号映射生成（sh）
├── dev/                        # 实验性：hot/cold 图 + 采集 D 脚本
│   ├── hotcoldgraph.pl         # on/off-CPU 红蓝图（267 行）
│   ├── hcstackcollapse.pl      # hot/cold 数据折叠器
│   └── gather*-kern.d          # DTrace 采集脚本
├── docs/                       # CDDL 许可证全文
├── demos/                      # USENIX/LISA 2013 演讲示例 SVG
├── test/                       # perf 样本输入 + results/ 参考折叠输出
└── example-*.txt(.gz)/.svg     # 自带 perf/dtrace 示例与成品
```

- **根目录**是全部可执行脚本（扁平结构，无 `src/`），符合 Unix 工具"一个脚本一个命令"的风格。
- **`dev/`** 是实验性代码，`dev/README` 标注 "may not work properly"，含 hot/cold 图及其专用折叠器/采集脚本。
- **`test/`** 见「测试体系」章。
- **`demos/`** 是成品 SVG，需本地打开（GitHub 不渲染 SVG）。

---

## 模块地图

![模块依赖与 folded 契约](/vibe-reading/images/articles/flamegraph-1.0/module-dependencies.svg)

三个模块都围绕中心的 **folded 格式契约** 耦合：折叠器族产出它，渲染引擎消费它，辅助工具在它之上做变换。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 渲染引擎 | folded 数据 → 交互式 SVG（建树/布局/着色/JS） | `flamegraph.pl` `GetOptions`→`flow()` | 渲染逻辑稳定且与 profiler 无关，独成一心智模型 | [渲染引擎](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/01-render-engine) |
| 折叠器族 | 适配 13+ 种 profiler 格式 → 统一 folded | `stackcollapse-perf.pl` `while(<>)` 状态机 | 格式适配是多变的"面"，与稳定的渲染正交 | [折叠器族](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/02-folders) |
| 辅助分析工具 | folded/perf 数据的差分/区间/拆分 | `difffolded.pl`/`range-perf.pl`/`pkgsplit-perf.pl` | 是可选的旁路变换，不改变契约只变换数据 | [辅助工具](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/03-auxiliary-tools) |

---

## 运行时行为

### 启动流程

FlameGraph 的每个脚本都是独立的 Perl 程序，无守护进程、无 DI 容器。启动流程极简——`GetOptions` 解析参数后直接进入主循环。以 `flamegraph.pl` 为例：

```
flamegraph.pl 启动
  │
  ├─ GetOptions (flamegraph.pl:158)   ← 解析 20+ 选项到 $imagewidth/$colors/$hash 等
  ├─ 加载 --nameattr 文件 → %nameattr (line 202)   ← 可选，对象来自属性文件
  ├─ 设置 internals: $ypad/$xpad/$framepad (line 183-190)   ← 布局常量
  └─ 进入主循环：读输入 → flow() 合并 → 绘制 SVG (line 575+)
```

**对象装配**：FlameGraph 几乎没有"对象装配"——`%Node`/`%Tmp`/`%collapsed` 都是文件级 `my` 声明的 hash，由主循环直接填充。唯一的"工厂"是 `SVG->new()`（`flamegraph.pl:232`），bless 一个空 hashref 作为 SVG 画布。配置来自命令行参数（`GetOptions`），无配置文件、无环境变量优先级链——参数即配置。

### 核心运行流程

下面三条链路覆盖了 FlameGraph 的主要运行模式：标准 CPU 采样、差分对比、hot/cold 合并。

#### 标准 CPU profiling：perf 全链路

业务流程：perf 采样 CPU 栈 → 折叠去重 → 渲染火焰图。

![perf CPU profiling 端到端数据流](/vibe-reading/images/articles/flamegraph-1.0/data-flow.svg)

文字描述：`perf record -F 99 -a -g -- sleep 60` 采样后 `perf script > out.perf` 产出多行文本（每个 sample 一块：header 行 + N 个 stack 行 + 空行）。`stackcollapse-perf.pl` 用隐式状态机逐行解析：注释行提取 cmdline、header 行解析 comm/pid/tid 并过滤 event 类型、stack 行清理函数名并加 `_[k]`/`_[j]`/`_[i]` 注解、空行触发 `remember_stack()` 把 `join(";",@stack)` 存入 `%collapsed` 累加。输出 `out.folded`（`func;func count`，每行独立）。`flamegraph.pl` 对输入 `sort` 后逐行调用 `flow()`：比较相邻行公共前缀长度 `$len_same`，把旧帧从 `%Tmp` 定稿到 `%Node`（锁定 etime）、新帧存入 `%Tmp`（记录 stime）；最后用 `$widthpertime = (width-2×xpad)/timemax` 把 sample count 映射为像素宽度，`color()` 选色，嵌入 JS（zoom/search）输出 SVG。**关键设计决策**：folded 是纯文本中间格式，可 `grep cpuid out.folded | flamegraph.pl` 行级过滤——因为每行是独立原子记录，行间无依赖。

#### 差分对比：difffolded + --negate

业务流程：两份 profile（before/after）各自折叠 → 对齐 stack → 双列 count → 渲染红蓝差分图。

文字描述：`stackcollapse-perf.pl before.perf > before.folded`、`stackcollapse-perf.pl after.perf > after.folded`，然后 `difffolded.pl before.folded after.folded | flamegraph.pl > diff2.svg`。`difffolded.pl` 用 `%Folded{$stack}{1}/{2}` 双键存两份计数，缺失侧补 0，`-n` 可按采样总量归一化（`count1×total2/total1`），输出三列 `stack count1 count2`。`flamegraph.pl:607` 解析第二列算 `$delta = c2 - c1`，`color_scale($delta,$maxdelta)` 着色：正 delta（增多）→ 红、负 delta（减少）→ 蓝。**关键设计决策**：一个栈帧若在 after 中消失则宽度为 0，颜色无法展示——解决方案是生成两张图：`diff2.svg`（宽度按 after、颜色按实际变化）和 `diff1.svg`（`difffolded after before | flamegraph.pl --negate`，宽度按 before、颜色按将发生的变化），`--negate`（`flamegraph.pl:487`）翻转符号使两图红蓝语义一致。

#### hot/cold 合并：dev/hotcoldgraph.pl

业务流程：DTrace 同时采 on-CPU 与 off-CPU 栈 → 折叠为三列（stack,cpu,count）→ 渲染红蓝合并图。

文字描述：`dev/gatherhc-kern.d` 与 `dev/gatherthc-kern.d` 采集 on/off-CPU 栈，`hcstackcollapse.pl` 折叠为 `stack,cpu,count` 格式（逗号分隔、多一列 cpu 布尔）。`hotcoldgraph.pl` 的 `flow($a,$b,$ca,$cb,$v)` 比普通 `flow()` 多两个 cpu 参数——若 `$ca != $cb`（CPU 状态不同）强制 `$len_same = 0`（`dev/hotcoldgraph.pl:161`），确保不同 CPU 状态的栈不合并。着色由 `$cpu ? "hot" : "cold"`（line 255）二分：on-CPU → `color("hot")` 红色系、off-CPU → `color("cold")` 蓝色系。这与差分模式的连续渐变（`color_scale`）不同，是离散红蓝二分。`hotcoldgraph.pl` 无 zoom/search JS，仅 mouseover。

### 状态流

`stackcollapse-perf.pl` 的解析是一个隐式状态机（无显式 state 变量，靠正则分支切换）。这是折叠器族最核心的运行时行为：

```
                ┌──────────────────────────────────────┐
                ▼                                       │
  ┌───────────────────┐  /^#/ 注释行      ┌─────────────┴──────┐
  │  初始 (无 pname)   │─────────────────→│  注释态             │
  └───────────────────┘                  │ 提取 cmdline/pname │
                │                         └────────────────────┘
                │ /^(\S.+?)\s+(\d+)\/?(\d+)*\s+/  ← header 行
                ▼
  ┌───────────────────┐  /^\s*(\w+)\s*(.+) \((\S*)\)/  ← stack 行
  │  header 态        │────────────────────────────────────┐
  │ 解析 comm/pid/tid │                                     │
  │ 过滤 event type   │                                     ▼
  │ 设 $pname          │                          ┌─────────────────┐
  └───────────────────┘                          │  stack 态        │
                │ ▲                              │ 清理函数名       │
                │ │                              │ 加 _[k]/_[j]/_[i] │
                │ │ m/^$/ 空行                   │ unshift @stack   │
                │ │                              └─────────────────┘
                │ │                                       │
                ▼ │ m/^$/                                  │
  ┌───────────────────┐ remember_stack()                    │
  │  空行态(边界)     │←────────────────────────────────────┘
  │ join(";",@stack)  │
  │ → %collapsed +=1  │
  └───────────────────┘
```

状态枚举由行格式隐式定义（注释/header/stack/空行），转换由当前行的正则匹配触发。`remember_stack()` 在空行（sample 边界）调用，是 stack→folded 的关键转换点（`stackcollapse-perf.pl:71`）。相关代码：状态切换在 `stackcollapse-perf.pl:163-341` 的主循环 `if/elsif/else` 链，`remember_stack()` 在 `:71-74`。

---

## 典型修改场景

### 场景 1：新增支持一种 profiler 格式

参考最简的 `stackcollapse-gdb.pl`（72 行）模板：新建 `stackcollapse-<profiler>.pl`，定义 `%collapsed` 与 `remember_stack()`，写 `while (<>)` 主循环用正则区分该 profiler 的行格式，构建 `@stack`（`unshift` 使 leaf 在右），在 sample 边界调用 `remember_stack(join(";",@stack),1)`，结尾加标准输出循环 `foreach (sort keys %collapsed){ print "$k $collapsed{$k}\n" }`。只要输出符合 folded 契约即可被 `flamegraph.pl` 消费，无需改渲染层。

### 场景 2：新增一种调色板

在 `color()` 函数（`flamegraph.pl:337-481`）加 `if ($type eq "mytheme")` 分支，用 `v1/v2/v3` 计算 `rgb(r,g,b)`。多级调色板可仿 `java`/`js` 的 fall-through 模式：先按函数名正则重定向到基础色名，再继续执行到基础色分支。同步在 `flamegraph.pl:222-227` 的背景色判断中加对应渐变（yellow/blue/gray 三选一）。对应测试：`test.sh` 目前只测 `stackcollapse-perf.pl`，调色板改动需手动 `flamegraph.pl test/results/x | diff` 验证。

### 场景 3：为零代码添加超链接/tooltip

用 `--nameattr` 属性文件（`flamegraph.pl:202` 解析），格式 `funcname\tkey=val`。`group_start()`（`flamegraph.pl:263`）已把 `$attr->{title}` 渲染为 `<title>`、`$attr->{href}` 触发 `<a>` 标签。在文件中写 `malloc\ttitle=分配器入口\thref=https://...` 即可给 `malloc` 帧加 tooltip 与超链接，**无需改任何代码**。对应测试：手动 `flamegraph.pl --nameattr attr.txt folded > out.svg` 后浏览器验证。

---

## 测试体系

```
test/
├── perf-cycles-instructions-01.txt     # perf script 输入样本（7 个 .txt）
├── perf-dd-stacks-01.txt
├── perf-funcab-cmd-01.txt
├── perf-funcab-pid-01.txt
├── perf-iperf-stacks-pidtid-01.txt
├── perf-java-faults-01.txt
├── perf-java-stacks-01.txt
└── results/                            # 参考折叠输出（golden files）
    └── <name>-collapsed-<opt>.txt      # 每输入×每选项一个
```

| 代码层 | 测试类型 |
|--------|----------|
| `stackcollapse-perf.pl` | 回归测试（`test.sh`：6 选项 × 7 输入 = 42 组，`diff -u` 比对 `results/`） |
| `flamegraph.pl` | 冒烟测试（`test.sh` 末尾 `perl flamegraph.pl "$outfile" > /dev/null`，只验不崩） |

`test.sh` 对 `stackcollapse-perf.pl` 的 6 个选项（`pid`/`tid`/`kernel`/`jit`/`all`/`addrs`）逐一跑全部 `test/*.txt`，`diff` 比对 `test/results/` 下的 golden 文件——这是**回归测试**，检测折叠逻辑改动是否改变了输出。`flamegraph.pl` 只做冒烟（输出到 `/dev/null` 验证不报错）。`record-test.sh` 用于在有意改动后刷新 golden 文件。理解 `stackcollapse-perf.pl` 行为时，优先读 `test/results/` 下的参考输出——它们是可执行的"预期文档"。

---

## 阅读源码推荐路线

- **第一遍：理解主流程与契约**
  `README.md`（三步管线）→ `stackcollapse.pl:57-109`（最简折叠器，看清 `%collapsed`+`remember_stack`+输出循环）→ `flamegraph.pl:596-642`（主循环 sort+flow）→ `flamegraph.pl:600` 的 folded 正则（契约定义）
- **第二遍：理解渲染引擎内部**
  `flamegraph.pl:529-563` 的 `flow()`（前缀合并建树）→ `flamegraph.pl:664-665` 的 `widthpertime`/`minwidth_time`（宽度分配）→ `flamegraph.pl:337-481` 的 `color()`（14 调色板）→ `flamegraph.pl:825-999` 的 JS `zoom()`/`search()`（嵌入交互）
- **第三遍：理解最复杂的折叠器**
  `stackcollapse-perf.pl:163-341` 的状态机主循环 → `:203-248` 的 header 解析与 event 过滤 → `:253-333` 的函数名清理与 `_[k]`/`_[j]`/`_[i]` 注解 → `difffolded.pl:88-115` 的双列差分（理解差分契约）
- **第四遍：选择重点子模块深入阅读**
  [渲染引擎 flow() 算法深度解读](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/01-render-engine-flow-algorithm) → `dev/hotcoldgraph.pl`（对比 `flamegraph.pl` 看 on/off-CPU 变体的取舍）→ [折叠器族](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/02-folders) 各 profiler 适配差异

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| **folded stacks** | 折叠后的栈格式 `func;func count`，一行一个完整调用栈+计数，是 FlameGraph 的核心契约 |
| **flame graph** | 火焰图，x 轴宽度=采样占比、y 轴高度=栈深度的可视化 |
| **icicle graph** | 倒置火焰图（`--inverted`），根在底部，自下而上生长 |
| **on-CPU / off-CPU** | 在 CPU 上执行 / 阻塞等待（off-CPU 时间反映锁、IO 等待） |
| **`_[k]`/`_[j]`/`_[i]`/`_[w]`** | 栈帧注解后缀：kernel / JIT / inlined / waker，`flamegraph.pl` 据此着色 |
| **palette.map** | `--cp` 模式持久化的函数→颜色映射文件，使跨图颜色一致 |
| **perf-map-agent** | 为 Java 进程生成 `/tmp/perf-PID.map` 符号映射的工具（`jmaps` 封装它） |

### 参考资料

- [Flame Graphs 主站](http://www.brendangregg.com/flamegraphs.html) — Brendan Gregg 的 flame graph 资源与更新
- [The Flame Graph 文章 (CACM)](http://cacm.acm.org/magazines/2016/6/202665-the-flame-graph/abstract) — flame graph 的学术论述
- [CPU profiling using perf\_events](http://www.brendangregg.com/FlameGraphs/cpuflamegraphs.html) — perf + FlameGraph 工作流
- [Differential Flame Graphs](http://www.brendangregg.com/blog/2014-11-09/differential-flame-graphs.html) — 差分火焰图原理
