---
source:
  type: "源码解读"
  project: "FlameGraph"
  url: "https://github.com/brendangregg/FlameGraph"
title: "辅助分析工具"
date: "2026-08-14T18:07:23+08:00"
category: ["Languages", "C/C++", "Tools", "FlameGraph", "CodeWiki", "1.0"]
tags: ["FlameGraph", "Perl", "Profiling"]
description: "辅助分析工具对 folded/perf 数据做后处理：difffolded.pl 差分计数、range-perf.pl 时间区间分桶、pkgsplit-perf.pl 包路径拆分、files.pl 文件占用、aix-perf.pl 采集。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/FlameGraph/CodeWiki/1.0/00-overview)

---

## 模块定位

辅助分析工具是一组对 folded/perf 数据做**后处理**的小脚本。它们不改变 folded 格式契约，只变换数据——差分、区间切片、包拆分。模块独立存在是因为这些是**可选的旁路变换**：标准管线 `stackcollapse → flamegraph` 不需要它们，但差分对比、时间维度分析、Java 包级聚合等场景需要。它们体量都小（31–137 行），逻辑独立，共同点是都围绕 folded 格式或 perf 原始输出做行级变换。

---

## 模块架构

```
┌────────────────────────────────────────────────────────────┐
│  辅助工具（各自独立，无共享代码）                          │
│                                                            │
│  difffolded.pl    读两份 folded → 对齐 stack → 三列 count  │
│  range-perf.pl    读 perf 原始 → 按时间区间过滤行          │
│  pkgsplit-perf.pl 读 perf 原始 → 按包路径拆成 folded        │
│  files.pl         遍历文件系统 → folded（path→stack）      │
│  aix-perf.pl      采样 procstack → 原始栈（采集层）        │
└────────────────────────────────────────────────────────────┘
```

无共享库、无继承，每个脚本独立实现自己的行级变换。共同的模式是"folded 行解析正则"与"perf event 行解析正则"在多个脚本中重复出现——这是脚本式风格的取舍（复制优于抽象）。

---

## 调用链路

以最常用的 `difffolded.pl` 为例：

```
输入: folded1, folded2 两文件
  │
  ├─ 读 file1 → %Folded{$stack}{1} += $count, 累加 $total1 (:88-96)
  ├─ 读 file2 → %Folded{$stack}{2} += $count, 累加 $total2 (:98-106)
  ├─ 遍历 %Folded (:108-115)
  │    ├─ 缺失侧补 0
  │    ├─ 若 -n 归一化: $Folded{$stack}{1} = int($c1 * $total2/$total1)
  │    └─ 输出 "stack count1 count2"
  └─ stdout → flamegraph.pl (或 flamegraph.pl --negate)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `difffolded.pl` 主循环 `:88-115` | 双文件对齐差分 | `%Folded{stack}{1}/{2}` 双键自然对齐；`-n` 归一化 |
| `range-perf.pl` `event_regexp` `:107` | 匹配 perf 事件行提取时间戳 | `qr/ +([0-9\.]+): *\S* *(\S+):/` |
| `range-perf.pl` 区间判断 `:131-133` | `$time>=begin` 则输出，`>end` 则 exit | 假设样本按时间序，提前 exit |
| `pkgsplit-perf.pl` 正则 `:50` | 解析 perf 进程行 pname/pid/tid | `^\s+(\S.+?)\s+(\d+)\/*(\d+)*\s.*?:.*:` |
| `pkgsplit-perf.pl` 数字掩码 `:81` | Java 匿名类编号→X | `s/[0-9]/X/g` 合并 `Foo$1`/`Foo$2` |
| `files.pl` `wanted()` `:35` | File::Find 回调 | 路径 `/`→`;`，非白名单字符→`_` |

</details>

---

## 核心实现

### difffolded.pl：差分计数

`difffolded.pl`（115 行）把两份 folded 对齐成双列 count，喂给 `flamegraph.pl` 生成差分火焰图：

```perl title="difffolded.pl:108-115（差分核心）"
foreach my $stack (keys %Folded) {
    $Folded{$stack}{1} = 0 unless defined $Folded{$stack}{1};
    $Folded{$stack}{2} = 0 unless defined $Folded{$stack}{2};
    if ($normalize && $total1 != $total2) {
        $Folded{$stack}{1} = int($Folded{$stack}{1} * $total2 / $total1);
    }
    print "$stack $Folded{$stack}{1} $Folded{$stack}{2}\n";
}
```

用一个 `%Folded` hash 的两个子键 `{1}`/`{2}` 存两份计数，相同 stack 自然对齐；缺失侧补 0；`-n` 归一化把 file1 按 `count1×total2/total1` 缩放，消除采样总量差异。输出三列 `stack count1 count2`，由 `flamegraph.pl:607` 解析第二列算 `$delta`。

**双向差分策略**（`difffolded.pl:14-22` 注释）：一个栈帧若在 after 中消失则宽度为 0、颜色无法展示，解决方案是生成两张互补的 SVG：
- `diff2.svg`：`difffolded before after | flamegraph.pl`——宽度按 after、颜色按实际变化（红=增多、蓝=减少）
- `diff1.svg`：`difffolded after before | flamegraph.pl --negate`——宽度按 before、颜色按将发生的变化，`--negate`（`flamegraph.pl:487`）翻转符号使两图红蓝语义一致

### range-perf.pl：时间区间分桶

```perl title="range-perf.pl:107-136（事件行匹配、三模式时间计算与区间判断）"
my $event_regexp = qr/ +([0-9\.]+): *\S* *(\S+):/;   # 提取时间戳+事件名
# ...
if ($timezerosecs) { $time = $ts - floor($start); }  # 从 0 秒起，保留 perf 偏移
elsif (!$timeraw)   { $time = $ts - $start; }        # 默认：相对起始的秒数
else                { $time = $ts; }                 # --timeraw：原始时间戳
$ok = 1 if $time >= $begin;
exit if $time > $end;                  # 假设样本按时间序，提前终止
print $_ if $ok;
```

`range-perf.pl`（137 行）把 perf script 输出按时间区间切片，输出仍是 perf script 格式（需后续 `stackcollapse-perf.pl`）。`$time` 有三种模式（由 `$timeraw`/`$timezerosecs` 标志控制，`:44-48,123-129`）：默认相对秒数 `($ts-$start)`、`--timeraw` 用原始时间戳、`--timezerosecs` 从 0 秒起但保留 perf 偏移。典型用法 `cat out.perf | range-perf.pl 10 20 | stackcollapse-perf.pl | flamegraph.pl` 看第 10–20 秒发生了什么。**关键假设**（`:132` 注释 `# assume samples are in time order`）：perf script 输出按时间序，因此超出区间可立即 `exit`，无需缓存全部数据——流式处理。这解决"性能随时间变化"的可视化：一个 180 秒的 profile 切成 18 张 10 秒图，能看到"第 30–40 秒延迟突增"这类时间维度问题。

### pkgsplit-perf.pl：包路径拆分

```perl title="pkgsplit-perf.pl:72-85（DSO 剥离与 Java 转换）"
s/^.*?:.*?:\s+//;      # 去掉进程/事件信息
s/ \(.*?\)$//;          # 丢弃末尾 (dso) 括号
# Java 函数名转换：
$func =~ s/^L//;        # 去 Java 类名前导 L
$func =~ s/[0-9]/X/g;   # 数字→X（合并匿名编号类）
$func =~ s:/:;:g;       # / → ; （folded 定界符）
print "$pname;$func 1\n";   # 每采样直接输出 folded，不经 stackcollapse
```

`pkgsplit-perf.pl`（86 行）**直接输出 folded，绕过 stackcollapse**——因为它不采完整调用栈（不用 `perf record -g`），只采样 IP（指令指针），把 Java 类名按 `/` 拆成包层级作"伪栈"（如 `com/google/gson/JsonObject::add` → `com;google;gson;JsonObject::add`）。这不是调用栈折叠而是包路径层级拆分，所以 `stackcollapse-perf.pl` 的逻辑不适用，每采样直接输出 count=1 的 folded 行。**数字掩码**（`:81` `s/[0-9]/X/g`）合并 Java 匿名内部类（`Foo$1`/`Foo$2`→`Foo$X`），避免碎片化——一个逻辑类的采样被分散到十几个窄帧。当前 `:72` 是**丢弃** DSO 信息，若要按 DSO 拆分需改为捕获。

### files.pl 与 aix-perf.pl

`files.pl`（43 行，Apache-2.0 例外）用 `File::Find` 把文件系统大小可视化：

```perl title="files.pl:35-43（路径转 folded）"
sub wanted {
    my ($dev,$ino,$mode,$nlink,$uid,$gid,$rdev,$size) = lstat($_);
    my $path = $File::Find::name;
    $path =~ tr/\//;/;            # / → ; （folded 定界符）
    $path =~ tr/;.a-zA-Z0-9-/_/c; # 非白名单字符 → _（/c 取补集）
    $path =~ s/^;//;
    print "$path $size\n";        # folded: path;path size
}
```

`tr/;.a-zA-Z0-9-/_/c` 的 `/c` 取补集——不在白名单的字符都变 `_`，确保不含空格等破坏 folded 解析的字符。用法 `./files.pl /Users | ./flamegraph.pl --hash --countname=bytes > files.svg` 看存储占用。`aix-perf.pl`（31 行）是 AIX 上的采集脚本，用 `getopt('urt')` 解析三个参数：`-r` 采样轮数、`-t` 轮间睡眠秒数、`-u` 用户过滤。每轮根据 `$opt_u` 决定 PID 来源——有 `-u` 时执行 `/usr/sysv/bin/ps -u $opt_u` 取该用户进程，否则 `opendir('/proc')` 用 `readdir` 取全部数字目录名（PID）。对每个 PID 执行 `/usr/bin/procstack $pid` 打印栈，轮间用 `select(undef,undef,undef,$opt_t)`（四参数 select 做 sub-second sleep）睡眠。它是采集层而非折叠层，无 `use strict`、无函数定义，最简脚本。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 双键对齐 | `difffolded.pl` `%Folded{stack}{1}/{2}` | 一个 hash 两个子键自然对齐相同 stack，无需两两比较 |
| 流式提前终止 | `range-perf.pl:133` `exit if $time > $end` | 假设时间序，无需缓存全部数据 |
| 直接折叠绕过 | `pkgsplit-perf.pl:85` 直接输出 folded | IP 采样无调用栈，包路径是伪栈，stackcollapse 不适用 |
| 字符级转换 | `files.pl:39-41` `tr///c` | 路径转 folded 定界符，取补集清洗非法字符 |

---

## 模块间交互

各工具在管线中的位置：

| 脚本 | 输入 | 输出 | 位置 |
|------|------|------|------|
| `difffolded.pl` | 两份 folded | 三列 folded | stackcollapse 之后、flamegraph 之前 |
| `range-perf.pl` | perf 原始 | perf 原始（过滤） | stackcollapse 之前（perf 预处理） |
| `pkgsplit-perf.pl` | perf 原始(无-g) | folded | 替代 stackcollapse |
| `files.pl` | 文件系统 | folded(path bytes) | 独立，直接喂 flamegraph |
| `aix-perf.pl` | 无（自采集） | raw procstack | 采集层，需后续折叠 |

典型组合：

```bash title="辅助工具的管线组合"
# 差分（difffolded 在 folded 之后）
./difffolded.pl before.folded after.folded | ./flamegraph.pl > diff2.svg
./difffolded.pl after.folded before.folded | ./flamegraph.pl --negate > diff1.svg

# 区间（range-perf 在 perf 原始、stackcollapse 之前）
cat out.perf | ./range-perf.pl 10 20 | ./stackcollapse-perf.pl | ./flamegraph.pl

# 包拆分（pkgsplit 替代 stackcollapse）
perf script | ./pkgsplit-perf.pl | ./flamegraph.pl > out.svg

# 文件占用（files.pl 独立）
./files.pl /Users | ./flamegraph.pl --hash --countname=bytes > files.svg
```

`difffolded.pl` 输出三列格式，`flamegraph.pl` 原生支持（`:607` 解析第二列），配合 `--negate` 翻转红蓝。`pkgsplit-perf.pl`/`files.pl` 输出标准两列 folded 直接被消费。`range-perf.pl` 输出仍是 perf 格式，需经 `stackcollapse-perf.pl`。`aix-perf.pl` 输出 raw procstack，需额外折叠（待核实是否有对应 `stackcollapse-aix.pl`——`stackcollapse-aix.pl:61` 处理 AIX procstack 格式，应是其下游）。

---

## 扩展方式

- **`difffolded.pl` 加百分比输出**：在 `:114` 的 `print` 后追加百分比列。注意会改输出列数，需确认 `flamegraph.pl` 兼容（它只认最后两列作 count，额外列可能被忽略），更安全是单独输出百分比报告文件。
- **`range-perf.pl` 加百分比区间模式**（如前 50%）：需先扫描全部输入获取总时长再算秒数，与当前流式+提前 exit 设计冲突，需改两遍扫描或缓冲模式。复杂度中高。
- **`pkgsplit-perf.pl` 加 DSO 维度**：当前 `:72` `s/ \(.*?\)$//` 丢弃 DSO，改为捕获 `my ($dso) = /(\(([^)]+)\))$/` 并在输出插入 `$pname;$dso;$func 1`。复杂度低——DSO 信息已在输入行中。
