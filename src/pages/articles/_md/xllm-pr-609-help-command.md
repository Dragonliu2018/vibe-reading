---
title: "为 xLLM CLI 添加 --help 命令"
source:
  project: "xLLM"
  type: "PR"
  id: "609"
  url: "https://github.com/jd-opensource/xllm/pull/609"
  prType: "feat"
date: "2026-07-06"
category: [AI, 推理, xLLM, Contributions]
tags: ["CLI", "gflags", "C++", "Developer Experience"]
description: "为 xLLM 实现 --help / -h 标志，通过 gflags 注册表动态生成分类帮助文本，改善命令行开发体验。"
readingTime: "8 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#609](https://github.com/jd-opensource/xllm/pull/609) · **Issue** [#463](https://github.com/jd-opensource/xllm/issues/463) · **commit** [ca3f5ff](https://github.com/jd-opensource/xllm/commit/ca3f5ff) · **首发版本** v0.8.0 · **变更行数** +167 行 · **合并时间** 2025-12-29

---

## 背景

xLLM 是京东开源的高性能 LLM 推理框架，通过 `xllm` 可执行文件启动服务。该二进制拥有数十个 gflag 命令行参数——涵盖模型路径、KV Cache 配置、并行策略、推测解码、Disaggregated PD 等各个维度。

**问题**：在 PR #609 之前，新用户或偶尔使用 xLLM 的工程师只能翻阅源码才能知道有哪些参数可用。运行 `xllm` 不带参数会直接报 gflags 的原始错误，体验极差。

Issue #463 提出了这个痛点：

> 实现 `xllm --help` 命令，展示所有可用标志的信息。

这个需求看似简单，但要做好有几个值得探讨的设计决策：gflags 自带 `--helpfull`，为什么不用？帮助文本如何保持和旗标描述同步？如何避免在 gflags 解析之前就丢失 `--help`？

---

## 前置知识

### gflags 的内置 help

[gflags](https://gflags.github.io/gflags/) 自带 `--help`、`--helpfull`、`--helpmatch` 等参数，但它们的问题是：

1. **平铺无序**：按字母序列出所有注册的 flag，不区分模块
2. **噪声过多**：gflags 会把所有依赖库（folly、glog、torch 等）注册的内部 flag 也一并输出
3. **无法定制格式**：无法加 USAGE 说明或指向文档的链接

xLLM 的 gflags 数量庞大，直接用 `--helpfull` 输出会非常冗长且难以定位。

### google::GetCommandLineFlagInfo

gflags 提供了一个运行时查询接口：

```cpp title="gflags 查询 API"
bool google::GetCommandLineFlagInfo(const char* name,
                                    google::CommandLineFlagInfo* OUTPUT);
```

通过 flag 名称字符串可查到该 flag 的类型、当前值、description 等元数据，无需在帮助文本里手动维护描述——直接从注册表读取，保证和代码同步。

---

## 实现

本 PR 改动了 3 个文件，总计 +167 行：

```
xllm/core/common/help_formatter.h   (+147, 新增)
xllm/xllm.cpp                       (+16)
xllm/core/common/global_flags.cpp   (+4, -1)
```

### HelpFormatter 类

核心实现是新增的 `help_formatter.h`，使用类型别名和匿名命名空间组织分类数据：

```cpp title="xllm/core/common/help_formatter.h（PR #609 初始版本）"
namespace {

using OptionCategory = std::pair<std::string, std::vector<std::string>>;

// 各分类 flag 名称列表
const OptionCategory kCommonOptions = {
    "COMMON OPTIONS",
    {"host", "port", "devices", "device_id",
     "max_tokens_per_batch", "max_seqs_per_batch",
     "enable_prefix_cache", "block_size", "max_memory_utilization", ...}};

const OptionCategory kMoeModelOptions = {
    "MOE MODEL OPTIONS",
    {"dp_size", "ep_size", "enable_mla", ...}};

const OptionCategory kDisaggPDOptions = {
    "DISAGGREGATED PREFILL-DECODE OPTIONS",
    {"enable_disagg_pd", "instance_role", "transfer_listen_port", ...}};

// ... 其余分类

const std::vector<OptionCategory> kOptionCategories = {
    kCommonOptions, kMoeModelOptions, kDisaggPDOptions,
    kMtpOptions, kXllmServiceOptions, kOtherOptions};

}  // anonymous namespace
```

匿名命名空间确保这些常量不会污染 `xllm` 命名空间，也是 reviewer XuZhang99 在 Review 中明确要求的改动（见 commit `350d4d5`）。

`generate_help()` 方法遍历分类列表，对每个 flag 名查询 gflags 注册表：

```cpp title="HelpFormatter::generate_help()"
static std::string generate_help() {
  std::ostringstream oss;

  oss << "USAGE: xllm --model <PATH> [OPTIONS]\n\n";
  oss << "REQUIRED OPTIONS:\n";
  oss << "  --model <PATH>: Path to the model directory. "
         "This is the only required flag.\n\n";
  oss << "HELP OPTIONS:\n";
  oss << "  -h, --help: Display this help message and exit.\n\n";

  for (const OptionCategory& category : kOptionCategories) {
    std::ostringstream category_oss;

    for (const std::string& option_name : category.second) {
      google::CommandLineFlagInfo info;
      if (google::GetCommandLineFlagInfo(option_name.c_str(), &info)) {
        category_oss << "  --" << info.name;
        if (!info.description.empty()) {
          category_oss << ": " << info.description;
        }
        category_oss << "\n";
      }
    }

    std::string content = category_oss.str();
    if (!content.empty()) {       // 跳过空分类（所有 flag 都未注册时）
      oss << category.first << ":\n" << content << "\n";
    }
  }

  oss << "For more information, visit: https://github.com/jd-opensource/xllm\n";
  return oss.str();
}
```

值得注意的设计：**空分类跳过**。`GetCommandLineFlagInfo` 在 flag 未注册时返回 `false`，如果某个分类下所有 flag 都查不到（例如编译时未启用某个特性），该分类标题不会出现在输出中，避免输出空 section。

除 `generate_help()` 外，还提供了三个辅助方法：

| 方法 | 输出目标 | 场景 |
| --- | --- | --- |
| `print_help()` | stdout | 正常 `--help` 请求 |
| `print_usage()` | stdout | 简短用法提示 |
| `print_error(msg)` | stderr | 参数错误时报错并提示用法 |

### main() 中的 pre-parse 拦截

`--help` 必须在 `google::ParseCommandLineFlags()` **之前**处理。原因：gflags 的 `--help` flag 和 xLLM 内部并无冲突，但有两个实际问题：

1. 如果 `--model` 未提供，gflags 解析之后的 `FLAGS_model.empty()` 会报错，用户看到的是错误而非帮助
2. gflags 可能在解析阶段就对某些 flag 执行校验逻辑

解决方法是在 `main()` 最开始做线性扫描：

```cpp title="xllm/xllm.cpp — main() 入口"
int main(int argc, char** argv) {
  // Check for --help flag before parsing other flags
  for (int i = 1; i < argc; ++i) {
    std::string arg(argv[i]);
    if (arg == "--help" || arg == "-h") {
      HelpFormatter::print_help();
      return 0;
    }
  }

  FLAGS_alsologtostderr = true;
  FLAGS_minloglevel = 0;
  google::ParseCommandLineFlags(&argc, &argv, true);
  google::InitGoogleLogging("xllm");
  initialize_configs();

  // Check if model path is provided
  if (::xllm::ModelConfig::get_instance().model().empty()) {
    HelpFormatter::print_error("--model flag is required");
    return 1;
  }

  return run();
}
```

`--model` 校验放在 `initialize_configs()` 之后，是因为只有 gflags 解析完成后 `FLAGS_model`（通过 `ModelConfig::model()`）才有值。这里用 `print_error()` 输出到 stderr，返回码 `1`，符合 POSIX CLI 规范。

### 维护性注释

`global_flags.cpp` 的注释由原来的单行改为两条：

```cpp title="xllm/core/common/global_flags.cpp"
// NOTE:
// 1. related flags should be placed together.
// 2. when adding new flags, plz add the flag name to the appropriate
//    category in help_formatter.h so it appears in the help output.
```

这条注释是 reviewer XuZhang99 在 review 中明确提出的，作为一种**约定性约束**：新增 flag 的开发者必须同步更新 `help_formatter.h` 中的分类列表，否则新 flag 不会出现在帮助文本里。

---

## Review

PR 收到两位 reviewer（XuZhang99、RobbieLeung）的审查，产生了两个有价值的改动：

**匿名命名空间**（XuZhang99，commit `350d4d5`）：

原始实现将 `kCommonOptions` 等常量放在文件作用域。Reviewer 要求移入匿名命名空间，防止链接时符号冲突，也明确表达"这是实现细节"的意图。同时将一个长 vector 拆分为多个命名常量，可读性更好。

**类型别名**（commit `1f3a3ce`）：

用 `using OptionCategory = std::pair<...>` 替代直接写 `std::pair<std::string, std::vector<std::string>>`，让 `kOptionCategories` 的类型声明更简洁。结合拆分后的命名常量，最终的代码结构清晰很多。

---

## 意义与影响

这个 PR 是一个典型的**开发者体验（DX）改进**：功能代码量不大，但对新用户和偶尔使用者的价值明显。

几个值得关注的点：

1. **零重复描述**：flag 的 description 只在 `DEFINE_string/int/bool(...)` 宏里写一次，`HelpFormatter` 通过 `GetCommandLineFlagInfo` 运行时读取，不存在文档与代码不同步的问题。

2. **分类帮助 vs. gflags 原生**：xLLM 有数十个参数，`--helpfull` 会把 folly、torch、glog 等依赖的内部 flag 也全部输出，实际使用中噪声极大。分类帮助只展示 xLLM 自己关心的参数，并按功能分组，可读性更好。

3. **后续演化**：PR #1487（`refactor: refactor help_formatter using config class`）在此基础上进一步重构——将 flag 名称列表分散到各 `XxxConfig` 类的 `static option_category()` 方法中，`HelpFormatter` 只负责聚合和格式化，降低了维护成本（新增 flag 时只需修改对应 Config 类，不必额外改 `help_formatter.h`）。

