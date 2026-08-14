---
source:
  type: "源码解读"
  project: "FlameGraph"
  url: "https://github.com/brendangregg/FlameGraph"
title: "flow() 栈合并算法"
date: "2026-08-14T18:07:23+08:00"
category: ["Languages", "C/C++", "Tools", "FlameGraph", "CodeWiki", "1.0"]
tags: ["FlameGraph", "Perl", "Algorithm", "Visualization"]
description: "深度解读 flamegraph.pl 的 flow() 算法：如何用相邻行公共前缀增量合并把折叠栈聚成树，%Tmp/%Node 双 hash 的读写定稿机制，以及字母序排序的前提与代价。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回渲染引擎](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/01-render-engine)

---

## 主题定位

`flow()` 是 `flamegraph.pl` 把"一堆折叠后的栈"转成"一棵可绘制的栈树"的唯一桥梁。折叠器产出的是**扁平的行序列**（每行 `func;func count`，行间无层级关系），而火焰图需要**树形结构**（每个帧知道自己的 depth、父帧、stime/etime）。`flow()` 在不显式构建树对象的情况下，用两个 hash（`%Tmp` 写中、`%Node` 定稿）完成这件事。理解它就理解了 flame graph 的宽度信息从何而来。

---

## 核心原理

![flow() 栈合并与帧布局算法](/vibe-reading/images/articles/flamegraph-1.0/render-algorithm.svg)

算法分四步：①找相邻两行的公共前缀长度 `$len_same` → ②关闭旧栈超出公共前缀的帧（`%Tmp → %Node`，锁定 etime）→ ③开启新栈新增的帧（→ `%Tmp`，记 stime）→ ④全部输入处理完后剪枝+按 widthpertime/color 布局。核心是**增量**——每次 `flow()` 只处理相邻两行的差异部分，不回看历史。

```perl title="flamegraph.pl:596-642（主循环调用 flow）"
foreach (sort @Data) {                       # 字母序——flow 的前提
    my ($stack, $samples) = /^(.*)\s+?(\d+(?:\.\d*)?)$/;
    # 可选第二列（差分）：
    my $delta = defined $samples2 ? $samples2 - $samples : undef;
    $last = flow($last, ['', split(";", $stack)], $time, $delta);
    $time += $samples;                        # etime 累加器
}
flow($last, [], $time, $delta);              # flush 最后一个栈
```

```perl title="flamegraph.pl:529-563（flow 增量合并）"
sub flow {
    my ($last, $this, $v, $d) = @_;
    my $len_same = 0;
    for (my $i = 0; $i <= $#$last; $i++) {     # ① 公共前缀长度
        last if $i > $#$this;
        last if $$last[$i] ne $$this[$i];
        $len_same++;
    }
    for (my $i = $len_same; $i <= $#$last; $i++) {  # ② 关闭旧帧 %Tmp→%Node
        my ($func,$depth,$etime) = ($$last[$i], $i, $v);
        $Node{"$func;$depth;$etime"} = delete $Tmp{"$func;$depth"};
    }
    for (my $i = $len_same; $i <= $#$this; $i++) {  # ③ 开启新帧 →%Tmp
        $Tmp{"$$this[$i];$i"} = { stime => $v, delta => $d };
    }
    return $this;
}
```

**为什么 `$v`（etime）写入 `%Node` 的 key 而非 value**：因为同一函数名+深度可能在栈树不同分支重复出现（如 `malloc` 在多处被调用），`func;depth` 不唯一。把 etime 拼进 key 保证唯一，且 etime 隐含了"这个帧的起始是上一行的结束"——`flow()` 用 `delete $Tmp{...}` 把上一阶段的 stime 连同帧一起原子移入 `%Node`，etime 由当前 `$v` 锁定。

---

## 实现细节

### `$len_same` 的逐字符比较

公共前缀长度由一个简单 for 循环计算（`:537-541`）：从 `i=0` 逐位比较 `$last[$i]` 与 `$this[$i]`，遇到不等或某方越界即停。这要求两个数组都已 `split(";")` 成帧序列。复杂度 O(L)（L=栈深度），但只在相邻行差异段操作，所以总复杂度 O(N×L)。

### `$time` 累加器与 etime/stime 的关系

`$time` 在主循环按每行 sample count 递增（`:636-640`），传给 `flow()` 作为 etime。关键观察：

- 帧 A 的 **stime** = 它被开启时（某次 `flow` 的 ③ 步）传入的 `$v`；
- 帧 A 的 **etime** = 它被关闭时（后续某次 `flow` 的 ② 步）传入的 `$v`；
- 因为输入已排序，同一帧的开启与关闭之间不会有"同 func;depth"的帧插入 `%Tmp`，所以 `delete $Tmp{"$func;$depth"}` 拿到的正是当初存的 stime。

于是 `(etime - stime) × widthpertime` = 帧像素宽度 = 该函数此分支的采样占比。`$time` 不是真实墙钟时间，而是"采样计数的累计坐标"——这是"宽度即占比"的底层编码。

### 剪枝与布局

`flow()` 全部跑完后，`flamegraph.pl:668-678` 遍历 `%Node`：`($etime-$stime) < $minwidth_time` 的帧被 `delete`（`$minwidth_time = $minwidth/$widthpertime`，`:665`），同时 `$depthmax = max($depthmax,$depth)` 算出栈最大深度决定 SVG 高度。绘制时（`:1038-1117`）`x1 = $xpad + $stime*$widthpertime`、`x2 = $xpad + $etime*$widthpertime`、`y1/y2` 由 `$depth*$frameheight` 算出。

---

## 性能与权衡

**O(N×L) 增量合并**：N=折叠行数，L=平均栈深度。`flow()` 每次只比较公共前缀并处理差异段，避免了对全部栈做 O(N²) 的两两比较或显式构建全量树。代价是**必须先 `sort @Data`**（`:596`）——`flow()` 依赖"相邻行共享前缀"，非字母序输入会破坏 `$len_same` 的语义导致合并错误。

**字母序排序的取舍**：字母序使 x 轴排列无时间语义（文件头 `:42-44`："The ordering on the x-axis has no meaning; since the data is samples, time order of events is not known"）。这是 flame graph 的设计哲学——x 轴顺序不重要，**宽度（占比）才是关键信息**。牺牲时间语义换取了 O(N×L) 的增量合并可行性与稳定的视觉布局。

**`%Tmp`/`%Node` 双 hash 的内存**：`%Tmp` 只存"当前未闭合的栈路径"（深度≤L），`%Node` 存全部最终帧（帧数≈去重后函数×深度）。`delete $Tmp{...}` 的原子移动使内存占用可控——`%Tmp` 不会随 N 增长，只随 L 增长。

**minwidth 剪枝的信息损失**：默认 0.1 像素以下的帧被丢弃。对于热点分析无损（极窄帧占比可忽略），但会丢失"长尾小函数"的全貌——若需保留可用 `--minwidth 0`。这是 SVG 文件大小（数万函数可达几十 MB）与信息完整性的权衡。
