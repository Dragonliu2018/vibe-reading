---
source:
  type: "源码解读"
  project: "FlameGraph"
  url: "https://github.com/brendangregg/FlameGraph"
title: "渲染引擎"
date: "2026-08-14T18:07:23+08:00"
category: ["Languages", "C/C++", "Tools", "FlameGraph", "CodeWiki", "1.0"]
tags: ["FlameGraph", "Perl", "Profiling", "Visualization", "SVG"]
description: "flamegraph.pl 是 FlameGraph 的渲染引擎核心。本文解读 package SVG 命名空间、flow() 前缀合并建树、宽度比例分配、color() 14 调色板、嵌入 JS 交互与 hotcoldgraph 变体。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/00-overview)

---

## 模块定位

`flamegraph.pl`（1125 行）是整条管线的终点——它消费 folded stacks 文本，产出可交互的 SVG 火焰图。模块边界明确：**只做渲染，不做采集、不做折叠**。所有 profiler 差异已被上游 `stackcollapse-*` 收敛为统一的 `func;func count`，`flamegraph.pl` 不关心数据来自 perf 还是 DTrace。它独立存在是因为"渲染逻辑稳定"与"profiler 格式多变"是正交问题——把稳定部分单成一篇，才能让 13 种折叠器各自演进而不影响渲染。

`dev/hotcoldgraph.pl`（267 行）是渲染引擎的实验性变体，复用并精简了 `flamegraph.pl` 的 `package SVG`/`flow()`/`color()`，但把输入分隔符从 `;` 改为 `,`、着色逻辑改为 on-CPU 红 / off-CPU 蓝的离散二分。

---

## 模块架构

`flamegraph.pl` 内部由一个自实现的 SVG 绘图层（`package SVG`）和一组主程序函数协作：

```
┌─────────────────────────────────────────────────────────────┐
│  flamegraph.pl 主程序                                       │
│                                                              │
│  输入解析   sort @Data ──→ flow() ──→ %Tmp ──→ %Node        │
│               (字母序)    (前缀合并)   (暂存)    (定稿帧)    │
│                                                              │
│  布局着色   widthpertime   color()/color_scale()            │
│             (count→像素)   (14 palette + hash + differential)│
│                                                              │
│  交互嵌入   $inc (defs + style + <script> JS)               │
│             zoom()/search()/s()/c()  ← Perl 变量插值进 JS     │
└──────────────────────┬──────────────────────────────────────┘
                       │ 调用
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  { package SVG; ... }  ← 花括号块限定的独立命名空间          │
│  new() header() include() colorAllocate()                   │
│  group_start() group_end() filledRectangle() stringTTF()   │
│  svg()  —— 全部是字符串拼接，零 CPAN 依赖                   │
└─────────────────────────────────────────────────────────────┘
```

`package SVG` 是一个仿 `GD` 图形库 API 的轻量绘图层，用花括号块 `{ package SVG; ... }`（`flamegraph.pl:230-314`）限定作用域，使 SVG 生成方法不与主程序函数（`color`/`flow`/`namehash`）命名冲突。它的存在让"画什么"（数据处理）与"怎么画"（SVG 语法生成）分离，且不依赖任何外部 `SVG.pm`/`GD` 模块——任何装了 Perl 的系统都能跑。

---

## 调用链路

![flow() 栈合并与帧布局算法](/vibe-reading/images/articles/flamegraph-1.0/render-algorithm.svg)

从 `GetOptions` 后（`flamegraph.pl:182`）到 `print $im->svg`（`:1119`）的主路径：输入行经 `sort` 字母序排列后逐行进 `flow()`，`flow()` 比较相邻行公共前缀长度 `$len_same`，把旧帧从 `%Tmp` 定稿到 `%Node`（锁定 etime）、新帧存入 `%Tmp`（记 stime）；最后用 `$widthpertime` 把 sample count 映射为像素宽度，`color()` 选色，嵌入 JS 输出 SVG。`$time`（sample 累加值）作为 etime 写入 `%Node` 的 key，前一行 etime 即下一行 stime——这是"宽度按占比"的底层机制。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `flow($last,$this,$v,$d)` `flamegraph.pl:529` | 相邻栈按公共前缀增量合并 | 依赖字母序相邻，O(N×L) 增量建树 |
| `color($type,$hash,$name)` `:337` | 按调色板选色 | 默认 rand 随机，`--hash` 用 `namehash` 跨图一致 |
| `color_scale($value,$max)` `:483` | 差分模式按 delta 渐变 | 正→红、负→蓝，以 `$maxdelta` 归一化 |
| `namehash($name)` `:316` | 函数名→[0,1) 哈希 | 早期字符权重高（×0.70 衰减），取前约 12 字符 |
| `color_map($colors,$func)` `:495` | `--cp` 缓存查询 | 命中 `%palette_map` 则复用，否则调 `color()` 存缓存 |
| `read_palette`/`write_palette` `:505`/`:518` | `palette.map` 持久化 | `--cp` 跨运行颜色一致 |
| `SVG::group_start($attr)` `:263` | 输出 `<g>`+`<title>`+`<a>` | nameattr 属性覆盖 class/onclick/href |
| `SVG::filledRectangle` `:294` | 输出 `<rect>` | 传 `rx="2" ry="2"` 圆角 |
| `SVG::stringTTF` `:300` | 输出 `<text>` | 按像素宽度截断函数名 + `..` |

</details>

---

## 核心实现

### package SVG：零依赖绘图层

`package SVG`（`flamegraph.pl:230-314`）定义了 `new`/`header`/`include`/`colorAllocate`/`group_start`/`group_end`/`filledRectangle`/`stringTTF`/`svg` 等方法，全部是字符串拼接：

```perl title="flamegraph.pl:230-314（package SVG 节选）"
{ package SVG;
    sub new { bless {}, shift }
    sub header { my ($self,$w,$h) = @_;
        $self->{svg} = <<EOF; ... <?xml ... <svg width="$w" height="$h" ...> ... }
    sub group_start { my ($self,$attr) = @_;
        # 输出 <g ...> + 可选 <title> + 可选 <a href> }
    sub filledRectangle { my ($self,$x1,$y1,$x2,$y2,$fill,$extra) = ... }
    sub svg { my $self = shift; return $self->{svg} . "</svg>\n" }
}
```

这个设计是 FlameGraph **零外部依赖**的关键——它不 `use SVG;` 也不 `use GD;`，自实现一个极简绘图库。用花括号块限定作用域达到命名空间隔离，API 仿 `GD`（`colorAllocate` 返回 `"rgb(r,g,b)"`、`stringTTF` 输出文字），理论上可替换为真实模块而只改 package 内部。`hotcoldgraph.pl:74-123` 复制了同一 `package SVG`，但删了 `group_start`/`group_end`（事件直接写在 `filledRectangle` 的 `$extra` 参数里），且 `header` 去掉了 `xmlns:xlink` 声明。

### flow() 前缀合并建树

`flow()`（`flamegraph.pl:529-563`）是把折叠行聚成栈树的核心：

```perl title="flamegraph.pl:529-563（flow 核心逻辑）"
sub flow {
    my ($last, $this, $v, $d) = @_;
    my $len_same = 0;                     # 共同前缀长度
    for (my $i = 0; $i <= $#$last; $i++) {
        last if $i > $#$this;
        if ($$last[$i] eq $$this[$i]) { $len_same++; } else { last; }
    }
    # 关闭 $last 中超出共同前缀的帧：从 %Tmp 移入 %Node，锁定 etime
    for (my $i = $len_same; $i <= $#$last; $i++) {
        my $func = $$last[$i]; my $depth = $i; my $etime = $v;
        $Node{"$func;$depth;$etime"} = delete $Tmp{"$func;$depth"};
    }
    # 开启 $this 中新增的帧：存入 %Tmp，记录 stime 与可选 delta
    for (my $i = $len_same; $i <= $#$this; $i++) {
        my $func = $$this[$i]; my $depth = $i;
        $Tmp{"$func;$depth"} = { stime => $v, delta => $d };
    }
}
```

`%Node` 的 key 是 `"func;depth;etime"`（三段分号），value 是 `{stime, delta}`。`etime`/`stime` 不是真实时间，而是 `flow()` 调用方传入的 `$time`——主循环（`:636-640`）按每行 sample count 递增 `$time += $samples`。前一行的 etime（存在 key 里）就是后一行的 stime。`%Tmp` 的 key 只有 `"func;depth"`（无 etime，因为帧尚未结束），`flow()` 用 `delete $Tmp{...}` 把完成的帧原子地移入 `%Node` 并锁定 etime。这套增量合并依赖输入按字母序排列（`sort @Data`，`:596`）——只有相邻行共享前缀，`$len_same` 的逐字符比较才有效。

> 这个算法的深度解读见 [flow() 栈合并与帧布局算法](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/01-render-engine-flow-algorithm)。

### 宽度分配与 minwidth 剪枝

frame 像素宽度按其 sample count 占总 sample 的比例线性分配：

```perl title="flamegraph.pl:664-665, 1045-1046（宽度计算）"
$widthpertime = ($imagewidth - 2 * $xpad) / $timemax;   # 每单位 sample 的像素
$minwidth_time = $minwidth / $widthpertime;               # 像素阈值转 sample 阈值
# 绘制时：
$x1 = $xpad + $stime * $widthpertime;
$x2 = $xpad + $etime * $widthpertime;
```

frame 宽度 = `(etime - stime) × widthpertime`。`$timemax` 默认是所有输入行 count 之和（`:662`），可被 `--total` 覆盖（用于多图宽度对齐）。`$minwidth` 默认 0.1 像素（`:106`），`flamegraph.pl:668-678` 的循环把所有 `(etime-stime) < $minwidth_time` 的帧从 `%Node` 直接 `delete`——小于 0.1 像素的帧不可见、文字截断逻辑（`:1106` 要求 ≥3 字符）无法显示，且会显著膨胀 SVG 文件（数万函数的 profile 过滤前可达几十 MB）。这是信息完整性与可用性的合理取舍。

### color()：14 调色板与哈希着色

`color($type,$hash,$name)`（`flamegraph.pl:337-481`）按调色板生成颜色：

| 类别 | palette | 逻辑 |
|------|---------|------|
| 直接 | `hot`(默认) | R=205+50×v3, G=230×v1, B=55×v2 → 红橙黄 (`:351-356`) |
| 直接 | `mem` | 蓝绿色系 (`:357-362`) |
| 直接 | `io` | 紫蓝色系 (`:363-368`) |
| 多级 | `java` | 按注解/名称重定向：`_[j]`→green、`::`→yellow(C++)、`_[k]`→orange、else→red (`:371-389`) |
| 多级 | `perl`/`js` | 类似 java，按语言特征分流 (`:391-428`) |
| 多级 | `wakeup`/`chain` | `_[w]`→aqua、else→blue (`:429-440`) |
| 基础 | red/green/blue/... | 各单色变体 (`:443-478`) |

```perl title="flamegraph.pl:341-348（随机 vs 哈希种子）"
if ($hash) {
    my ($h, $h2) = (namehash($name), namehash(scalar reverse $name));
    my $v3 = $h;  ...
} else {
    my ($v1, $v2, $v3) = (rand(1), rand(1), rand(1));   # 默认每次运行颜色不同
}
```

默认 `--hash` 关闭时用 `rand(1)`，每次运行颜色不同；`--hash` 开启时调 `namehash()`（`:316`，对函数名逐字符加权哈希，早期字符权重 ×0.70 衰减），使同一函数跨图颜色一致。`namehash()` 在哈希前先做 `$name =~ s/.(.*?)`//`（`:323`，注释 "if module name present, trunc to 1st char"）——若函数名带模块限定前缀（如 perf 的 `module`func`` 反引号格式），先截到首字符，避免模块路径稀释哈希区分度。**设计取舍**：flame graph 的核心信息是 frame 宽度（占比），颜色只用于视觉区分相邻帧、不编码语义，所以默认选随机（单图场景不需可复现）。多级调色板用 **fall-through**——先按函数名模式把 `$type` 重定向到基础色名，再继续执行到基础色分支（`:389` 注释 `# fall-through to color palettes`）。差分模式用 `color_scale($delta,$maxdelta)`（`:483`）：正 delta→红、负 delta→蓝、以 `$maxdelta` 归一化连续渐变，`--negate`（`:487`）翻转符号。背景色按 palette 在 `:222-227` 选 yellow/blue/gray 渐变。

### 嵌入式 JavaScript：客户端交互

JS 通过 `$inc` 变量（`flamegraph.pl:685-1012`）嵌入 SVG 的 `<script type="text/ecmascript">`，用 `<![CDATA[...]]>` 包裹。Perl 变量通过字符串插值进入 JS（如 `$fontsize`、`$searchcolor`、`$inverted`）：

| JS 函数 | 位置 | 作用 |
|---------|------|------|
| `init(evt)` | `:698` | onload 初始化 DOM 引用 |
| `s(node)`/`c()` | `:707`/`:712` | mouseover/out 显示/清除函数详情 |
| `zoom(node)` | `:825` | 点击帧缩放：算 ratio=可用宽/帧宽；用 `upstack`（比较 y 坐标）区分祖先与子帧，祖先调 `zoom_parent()`（占满宽度+opacity 0.5）、路径内子帧调 `zoom_child(e,x,ratio)` 按 ratio 放大 x/width、非路径帧 `display:none` |
| `unzoom()` | `:877` | 恢复所有帧原始 x/width（用 `zoom_reset`+`_orig_` 前缀保存的值） |
| `search(term)` | `:913` | 遍历 `.func_g` 匹配函数名正则，改 fill 为 `$searchcolor`；算匹配百分比——按 x 排序后用 `maxwidth`/`lastx`/`lastw`+`fudge` 排除垂直重叠帧（树性质：子帧总比父帧窄），每个 x 位置只计最宽的匹配 |

```javascript title="flamegraph.pl:716-721（Ctrl-F/F3 触发搜索）"
window.addEventListener("keydown",function (e) {
    if (e.keyCode === 114 || (e.ctrlKey && e.keyCode === 70)) {
        e.preventDefault(); search_prompt();
    }
})
```

`keyCode 114`=F3、`70`='F'，即 Ctrl-F 或 F3 触发搜索。**为什么嵌入 JS 而非服务端**：`flamegraph.pl` 输出的是静态 SVG 文件（`> graph.svg` 重定向到文件，浏览器打开），全程无 Web 服务器，因此交互必须在客户端完成。这让火焰图可离线、可邮件分享、可嵌入 HTML `<object>`（`group_start` 中 `target="_top"` 的注释 `:279` 说明考虑了嵌入场景）。

> 注：`%Events`（`flamegraph.pl:191`）声明后全程未使用，是历史遗留 dead code；`flamegraph.pl:928` 的 `find_child(r,"rect")` 中 `r` 疑为 `rect` 笔误（nameattr href 模式下搜索可能出错）——待核实。

### hotcoldgraph.pl：on/off-CPU 变体

`dev/hotcoldgraph.pl` 与 `flamegraph.pl` 的关键差异：

| 方面 | flamegraph.pl | hotcoldgraph.pl |
|------|---------------|-----------------|
| 输入分隔 | `;` 分隔，2 列 `stack count` | `,` 分隔，3 列 `stack cpu count` |
| `flow()` 签名 | `($last,$this,$v,$d)` | `($a,$b,$ca,$cb,$v)` 多两 cpu 参数 |
| 帧ID格式 | `func;depth;etime` | `func-depth-etime-cpu`（`-` 分隔） |
| 公共前缀 | 只比函数名 | `$ca != $cb` 则强制 `$len_same=0`（`:161`） |
| 着色 | 14 palette + hash + differential | `color($cpu ? "hot" : "cold")`（`:255`）二分红蓝 |
| JS | 完整 zoom+search | 仅 mouseover |
| 选项 | 20+ GetOptions | 无，全部硬编码 |

`dev/hotcoldgraph.pl:255` 的 `$color = $cpu ? "hot" : "cold"` 是红蓝区分的核心：cpu 非零（on-CPU）→ `color("hot")` 红色系、cpu 为零（off-CPU/阻塞）→ `color("cold")` 蓝色系。`flow()` 在 CPU 状态不同时强制截断公共前缀（`:161`），确保 on/off 栈不合并。这与差分模式的连续渐变不同——hot/cold 是离散二分。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 命名空间隔离 | `{ package SVG; }` `:230` | SVG 生成方法与主程序函数隔离，零 CPAN 依赖自实现绘图库 |
| 增量合并 | `flow()` `:529` | 依赖字母序相邻，O(N×L) 把折叠行聚成树，避免全量排序树构建 |
| 策略模式 | `color($type,...)` `:337` 的 if 链 | 14 调色板可插拔，多级 palette 用 fall-through 重定向 |
| 读写分离 | `%Tmp`(写中) → `%Node`(定稿) | `delete $Tmp{...}` 原子地把完成帧移入 `%Node` 锁定 etime |
| 属性注入 | `--nameattr` → `%nameattr` → `group_start` | 零代码扩展超链接/tooltip，属性文件覆盖 class/href/title |

---

## 模块间交互

```
上游 folded 数据 (stackcollapse-* / difffolded / pkgsplit / files)
        │ stdin 或文件参数 (<> 钻石操作符)
        ▼
   flamegraph.pl  ──→  out.svg (静态文件)
        ▲
        │ --nameattr 属性文件 (可选，零代码扩展)
        │ --total 多图宽度对齐 (可选)
```

`flamegraph.pl` 的输入是上游全部折叠器/工具的统一产物（folded 契约），通过 Perl `<>` 钻石操作符同时支持 stdin 管道与文件参数。输出是静态 SVG 文件。它不 `import` 任何本仓库模块——`package SVG` 是内联的，`hotcoldgraph.pl` 也是复制而非 `use flamegraph.pl`。`hotcoldgraph.pl` 配合 `hcstackcollapse.pl`（注释 `:7` 提及）使用，两者仅靠输入格式约定（`stack,cpu,count`）耦合，无代码级依赖。

---

## 扩展方式

- **新增调色板**：在 `color()`（`:337-481`）加 `if ($type eq "mytheme")` 分支用 `v1/v2/v3` 算 `rgb`，多级可仿 java fall-through；同步在 `:222-227` 加背景渐变分支。用 `--colors mytheme` 启用。
- **零代码加超链接/tooltip**：用 `--nameattr` 文件（`funcname\ttitle=...\thref=...`），`group_start()`（`:263`）自动渲染 `<title>`/`<a>`，无需改代码。
- **修改搜索高亮**：改 `$searchcolor`（`:125` 默认紫色）或加 `--searchcolor` 选项；多词搜索改 JS `search()`（`:913`）把 `new RegExp(term)` 改为 `term.split(/\s+/).join("|")`。
- **新增栈注解着色**：在 `stackcollapse-perf.pl:327-333` 加标注（如 `_[u]` userspace .so），同步在 `flamegraph.pl` 的 `color()` 加对应分支——两端需同步。
