---
source:
  type: "源码解读"
  project: "ohmyzsh"
  url: "https://github.com/ohmyzsh/ohmyzsh"
title: "Overview"
date: "2026-08-13T20:12:36+08:00"
category: [Tools, "Shell", Oh-My-Zsh, CodeWiki, "master"]
tags: ["ohmyzsh", "Shell", "zsh", "插件系统", "启动加载"]
description: "Oh My Zsh 是最流行的 zsh 配置框架。本文从引导引擎、核心库、插件系统、主题系统到生命周期工具，全面解读其 master 分支的 Shell 内部实现。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** master (b54a7197) · **协议** MIT · **语言** Zsh · **代码量** ~5,300 行（核心）+ 359 插件 + 143 主题 · **仓库** [GitHub](https://github.com/ohmyzsh/ohmyzsh)

---

## 总览

### 项目简介

Oh My Zsh 是一个开源、社区驱动的 zsh 配置管理框架，由 Robby Russell 于 2009 年创建。它解决的核心问题是：zsh 本身功能极其强大但配置门槛高——用户想要好用的补全、美观的 prompt、顺手的别名，需要手写大量 `.zshrc`。Oh My Zsh 把这些打包成一个开箱即用的框架：一行 `source $ZSH/oh-my-zsh.sh` 即可获得预配置的 completion 系统、键绑定、git 集成，以及通过 `plugins=(...)` 数组即可启用的 359 个内置插件和 143 个主题。

它的核心价值是**约定优于配置**——插件文件名即注册、主题文件名即启用、custom 目录同名即覆盖。用户无需学习任何注册 API，把文件放对位置就完成扩展。

项目当前边界：负责 zsh 交互式 shell 的启动加载、配置管理和生态分发；**不负责**非交互式脚本环境（zsh 本身的能力），也不内置复杂工具链版本管理（由各插件按需集成）。它是一个配置框架与生态聚合层，不是 zsh 的替代或封装。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| 引导加载 | `oh-my-zsh.sh` | zsh 启动时按序加载 lib、插件、主题 |
| Completion 系统 | `oh-my-zsh.sh` + `lib/compfix.zsh` + `lib/completion.zsh` | compinit 缓存 + 安全检查 + 行为配置 |
| `omz` 管理 CLI | `lib/cli.zsh` | update/theme/plugin/changelog/pr 子命令 |
| Git prompt 集成 | `lib/git.zsh` + `lib/prompt_info_functions.zsh` | git 状态显示函数，供主题调用 |
| 异步 prompt | `lib/async_prompt.zsh` | 后台渲染耗时 prompt 段（如 git 状态） |
| 插件生态 | `plugins/` (359 个) | 别名、函数、completion、键绑定 |
| 主题生态 | `themes/` (143 个) | PROMPT/RPROMPT 定义 |
| 跨平台剪贴板 | `lib/clipboard.zsh` | 检测 pbcopy/xclip/wl-copy 等 11 种工具 |
| 终端标题跟踪 | `lib/termsupport.zsh` | precmd/preexec 更新标题与 cwd |
| 安装与升级 | `tools/install.sh`、`tools/upgrade.sh` | curl\|sh 安装 + 后台升级检查 |
| Custom 覆盖 | `oh-my-zsh.sh` `_omz_source` | `$ZSH_CUSTOM` 优先于 `$ZSH` 的覆盖链 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| zsh | 核心 | 唯一运行时依赖，框架全部用 zsh 脚本实现 |
| git | 核心 | 安装（clone）、升级（pull）、版本检测（is-at-least） |
| curl/wget/fetch | 可选 | 升级检查时访问 GitHub API 比对 HEAD |
| compinit/compaudit | 核心（zsh 内置） | completion 系统初始化与安全审计 |

## 快速上手

最快看到 Oh My Zsh 跑起来的方式是安装并启动一个新 zsh 会话：

```bash title="安装（POSIX sh，不依赖 zsh 已装）"
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

安装脚本会 clone 仓库到 `~/.oh-my-zsh`、从 `templates/zshrc.zsh-template` 生成 `~/.zshrc`（备份旧文件为 `.zshrc.pre-oh-my-zsh`）、通过 `chsh` 切换默认 shell 到 zsh。完成后开一个新终端：

```bash title="验证：prompt 已变为 robbyrussell 风格"
➜  ~ echo $ZSH
/Users/ace/.oh-my-zsh
➜  ~ omz version  # 框架自管理 CLI 可用即证明加载成功
```

看到绿色 `➜` prompt 和 `omz` 命令可用，即说明引导引擎已成功 source `lib/`、加载默认主题并注册了 `omz` CLI。要启用插件只需编辑 `~/.zshrc` 的 `plugins=(git docker)` 数组后重启 shell。

## 架构设计解析

### 系统架构

Oh My Zsh 的架构思想是**分层 + 约定驱动 + 覆盖链**。它不像传统应用那样有运行时服务，而是一个**启动时装配的静态加载框架**——所有工作在 zsh 启动那几百毫秒内完成，把函数、别名、completion、prompt 变量注入到当前 shell 进程，之后框架本身基本不再介入（除异步 prompt 和升级检查）。

分层从上到下是：用户配置驱动引导引擎，引导引擎调用核心库函数并加载插件/主题扩展，生命周期工具横切管理框架自身的安装与升级。依赖方向严格自上而下——插件和主题依赖核心库（调 `git_prompt_info` 等），核心库不反向依赖插件。

![Oh My Zsh 分层架构](/vibe-reading/images/articles/ohmyzsh-master/architecture.svg)

各层职责与目录映射：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 用户配置层 | `~/.zshrc`、`custom/` | 声明 `$ZSH`/`$plugins`/`$ZSH_THEME`，提供零侵入覆盖入口 |
| 引导引擎层 | `oh-my-zsh.sh` | 固定加载顺序、compinit 初始化、`_omz_source` 覆盖机制 |
| 核心库层 | `lib/*.zsh` (21 文件) | 内置基础能力：omz CLI、git 函数、completion、键绑定、终端标题 |
| 插件系统 | `plugins/` (359) | 约定式扩展：别名/函数/completion/hook 的生态聚合 |
| 主题系统 | `themes/` (143) | prompt 外观定义，通过 `$ZSH_THEME_GIT_PROMPT_*` 契约与核心库协作 |
| 生命周期工具层 | `tools/*.sh` (7) | 安装、升级、卸载、changelog——框架自身的运维 |

引导引擎是唯一控制流程的层，它通过 `_omz_source` 函数实现"custom 优先于 stock"的覆盖链贯穿 lib、plugins、themes 三层。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 约定优于配置 | `is_plugin` in `oh-my-zsh.sh:81-86`、`is_theme` in `oh-my-zsh.sh:217-221` | 文件名即注册，免去 manifest 和注册 API，降低生态贡献门槛 |
| 优先级覆盖链 | `_omz_source` in `oh-my-zsh.sh:176-180` | custom→stock，用户升级不丢自定义，零配置覆盖 |
| 模板方法 | `oh-my-zsh.sh` 加载顺序（行 50-236） | 固定骨架（路径→compinit→lib→插件→主题），子步骤可被环境变量/custom 替换 |
| 内容指纹缓存 | zcompdump metadata in `oh-my-zsh.sh:114-122` | revision+fpath 指纹决定缓存失效，避免每次启动重跑 compinit |
| 契约式扩展 | `$ZSH_THEME_GIT_PROMPT_*` in `lib/theme-and-appearance.zsh:8-11` + `_omz_git_prompt_info` in `lib/git.zsh:14-40` | 主题设变量、lib 函数消费，解耦"取数据"与"显样式" |
| Dummy 兜底 | `prompt_info_functions.zsh:13-26` | 插件未加载时 `*_prompt_info` 返回 1，主题无条件调用不报错 |
| 异步解耦 | `_omz_async_request`/`_omz_async_callback` in `lib/async_prompt.zsh:46-142` | git 状态查询 fork 到子进程，回调重绘，不阻塞 prompt |
| 优雅降级 | `oh-my-zsh.sh:96`（插件未找到 echo warning）+ `clipboard.zsh:51-101`（11 种工具探测） | 单个插件失败不崩 shell；跨平台能力按可用工具降级 |

### 核心概念

#### 核心对象

Oh My Zsh 是配置框架而非领域应用，没有 Task/Pipeline 这类领域模型。它的"核心对象"是驱动行为的**全局变量契约**：

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `$ZSH` | 框架根目录 | zshrc 设置或 `oh-my-zsh.sh:51` 推导 | 所有模块的查找基准 |
| `$plugins` | 启用插件名数组 | zshrc 设置 | 驱动 fpath 装配 + 插件 sourcing |
| `$ZSH_THEME` | 主题名 | zshrc 设置 | 驱动 `.zsh-theme` 文件加载 |
| `$ZSH_CUSTOM` | 覆盖目录 | `oh-my-zsh.sh:55` 默认 `$ZSH/custom` | 贯穿 lib/plugins/themes 覆盖链 |
| `$ZSH_COMPDUMP` | completion 缓存文件 | `oh-my-zsh.sh:109-111` | compinit 读写、zrecompile 编译 |
| `$ZSH_THEME_GIT_PROMPT_*` | git prompt 显示配置 | 主题文件覆盖 `lib/theme-and-appearance.zsh` 默认值 | 被 `_omz_git_prompt_info` 消费 |

#### 核心抽象

框架的扩展点契约是**文件名约定 + 加载函数**，而非接口/抽象类：

| 约定 | 定义位置 | 实现方式 | 注册方式 |
| --- | --- | --- | --- |
| 插件入口 | `is_plugin` in `oh-my-zsh.sh:81-86` | `{name}/{name}.plugin.zsh` | `$plugins` 数组声明 |
| 主题入口 | `is_theme` in `oh-my-zsh.sh:217-221` | `{name}.zsh-theme` | `$ZSH_THEME` 变量声明 |
| prompt 信息函数 | `lib/prompt_info_functions.zsh:13-26` | dummy 实现 + 插件覆盖 | 插件 source 时同名函数覆盖 |
| omz CLI 子命令 | `omz` in `lib/cli.zsh:3-21` | `_omz::{command}` 函数 | 定义函数即自动分发 |
| 异步 handler | `_omz_register_handler` in `lib/async_prompt.zsh:28-43` | handler 函数 + stub | `_omz_register_handler` 调用 |

## 代码目录

```
ohmyzsh/
├── oh-my-zsh.sh          # 引导引擎入口（236 行），zsh 启动时被 .zshrc source
├── lib/                  # 核心库（21 个 .zsh，3054 行）
│   ├── cli.zsh           #   omz CLI 命令体系（944 行，最大）
│   ├── git.zsh           #   git prompt 底层函数（376 行）
│   ├── async_prompt.zsh  #   异步 prompt 渲染引擎
│   ├── termsupport.zsh   #   终端标题与 cwd 跟踪
│   ├── completion.zsh    #   completion 行为配置
│   ├── key-bindings.zsh  #   键绑定（历史子串搜索等）
│   ├── clipboard.zsh     #   跨平台剪贴板（11 种工具探测）
│   └── ...               #   history/diagnostics/spectrum 等 14 个
├── plugins/              # 插件生态（359 个，每个一个目录）
│   └── {name}/
│       ├── {name}.plugin.zsh  # 入口（约定优于配置）
│       ├── _{name}            # completion 文件（可选）
│       └── README.md
├── themes/               # 主题生态（143 个 .zsh-theme 文件）
│   ├── robbyrussell.zsh-theme  # 默认主题（7 行）
│   └── agnoster.zsh-theme      # Powerline 风格（378 行）
├── tools/                # 生命周期工具（7 个脚本，2070 行）
│   ├── install.sh        #   安装（curl|sh → 生成 .zshrc）
│   ├── check_for_upgrade.sh  # 启动时后台升级检查
│   ├── upgrade.sh        #   实际升级逻辑
│   ├── changelog.sh      #   Conventional Commits changelog 生成
│   └── ...
├── custom/               # 用户覆盖目录（custom 优先于 stock）
│   ├── plugins/          #   覆盖/新增插件
│   ├── themes/           #   覆盖/新增主题
│   └── *.zsh             #   用户自定义配置（直接 source）
├── templates/            # .zshrc 模板
│   └── zshrc.zsh-template
└── cache/ log/           # 运行时缓存与日志（.zsh-update、update.lock）
```

## 模块地图

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 引导引擎 | zsh 启动时按序装配路径、compinit、lib、插件、主题 | `oh-my-zsh.sh` | 它是唯一控制加载顺序与覆盖机制的层，独立出来核心库才能保持纯函数化 | [引导引擎](/vibe-reading/articles/Tools/Shell/Oh-My-Zsh/CodeWiki/master/01-bootstrap) |
| 核心库 | 内置基础函数：omz CLI、git prompt、completion、键绑定 | `lib/*.zsh` | 这些函数被所有插件和主题依赖，是框架的"标准库"，独立成层保证可被 custom 覆盖 | [核心库](/vibe-reading/articles/Tools/Shell/Oh-My-Zsh/CodeWiki/master/02-core-lib) |
| 插件系统 | 约定式扩展机制，359 个生态插件 | `plugins/` + `is_plugin` | 插件是框架的核心价值载体，独立于 lib 保证可按需加载、可被 custom 覆盖 | [插件系统](/vibe-reading/articles/Tools/Shell/Oh-My-Zsh/CodeWiki/master/03-plugins) |
| 主题系统 | prompt 外观定义，143 个主题 + 异步渲染 | `themes/` + `lib/async_prompt.zsh` | 主题通过变量契约与 lib 协作，独立于插件因为 prompt 渲染是独立关注点 | [主题系统](/vibe-reading/articles/Tools/Shell/Oh-My-Zsh/CodeWiki/master/04-themes) |
| 生命周期工具 | 框架自身的安装、升级、卸载、changelog | `tools/*.sh` | 这些脚本在 zsh 运行时之外执行（安装前/升级时），与运行时加载逻辑正交 | [生命周期工具](/vibe-reading/articles/Tools/Shell/Oh-My-Zsh/CodeWiki/master/05-lifecycle) |

![模块依赖关系](/vibe-reading/images/articles/ohmyzsh-master/module-dependencies.svg)

模块间依赖方向：引导引擎 source 核心库和生命周期工具（`check_for_upgrade.sh`）；插件和主题依赖核心库（调用 `git_prompt_info` 等 prompt 函数）；`lib/cli.zsh` 的 `omz update` 调用 `tools/upgrade.sh`。`custom/` 目录对 lib、plugins、themes 提供同级覆盖，是贯穿三层的横切机制。所有跨模块数据通过全局变量（`$ZSH`、`$plugins`、`$ZSH_THEME`）和 source 副作用传递，无函数参数传递。

## 运行时行为

### 启动流程

Oh My Zsh 没有"进程启动"概念——它在 zsh 进程启动时被 `.zshrc` source，所有工作在当前 shell 进程内完成。启动调用链：

```
~/.zshrc
  └─ source $ZSH/oh-my-zsh.sh
     ├─ [1] 环境保护        oh-my-zsh.sh:11-46    ZSH_VERSION + emulate 检查
     ├─ [2] 路径推导        oh-my-zsh.sh:50-64    $ZSH → $ZSH_CUSTOM → $ZSH_CACHE_DIR
     ├─ [3] 升级检查        oh-my-zsh.sh:71       source check_for_upgrade.sh（后台 &|）
     ├─ [4] fpath 装配      oh-my-zsh.sh:76-98    functions + 插件目录注入（compinit 前）
     ├─ [5] compinit        oh-my-zsh.sh:124-154  compfix 安全检查 + zcompdump 缓存 + zrecompile
     ├─ [6] lib 加载        oh-my-zsh.sh:199-202  _omz_source "lib/*.zsh"（21 个）
     ├─ [7] 插件加载        oh-my-zsh.sh:205-208  _omz_source "plugins/$plugin/$plugin.plugin.zsh"
     ├─ [8] custom 加载     oh-my-zsh.sh:211-214  source "$ZSH_CUSTOM"/*.zsh
     ├─ [9] 主题加载        oh-my-zsh.sh:223-233  is_theme 三级查找 + source
     └─ [10] completion 颜色 oh-my-zsh.sh:236     zstyle list-colors
```

**对象装配**：Oh My Zsh 不用 DI 容器，对象装配就是 source 副作用——每个 lib/插件文件 source 时直接在当前 shell 定义函数、别名、setopt、zstyle。装配顺序严格固定：lib 先于插件（插件可调 lib 函数）、插件先于主题（主题调 lib 的 prompt 函数）。配置覆盖优先级：`$ZSH_CUSTOM` 同名文件 > `$ZSH` stock 文件，贯穿全程。

### 核心运行流程

启动后框架基本完成使命，进入交互态。以下三条链路覆盖了框架的核心运行模式。

#### 启动装配：一次性的 shell 状态注入

业务流程：zshrc 设置变量 → 引导引擎推导路径 → 后台升级检查 → completion 初始化 → 逐层 source 注入函数/别名/主题 → prompt 就绪。

![Shell 启动数据流](/vibe-reading/images/articles/ohmyzsh-master/data-flow.svg)

文字描述：从 `source ~/.zshrc` 起，`$ZSH`/`$plugins`/`$ZSH_THEME` 三大变量驱动全程。引导引擎先做环境保护和路径推导，再 `source check_for_upgrade.sh`（默认后台 `&|` 非阻塞，通过 GitHub API 比对 HEAD）。fpath 装配必须在 compinit 前——插件的 `_{name}` completion 文件需先在 fpath 就位。compinit 用 revision+fpath 指纹检测 zcompdump 缓存是否有效，有效则跳过扫描，再 `zrecompile` 编译 `.zwc` 字节码。随后按序 source 21 个 lib、各插件、custom 配置、主题，每步通过 source 副作用注入状态。整个链路是纯同步顺序执行，唯一并发是升级检查的后台分支。

#### Prompt 渲染：每次回车的重绘循环

业务流程：用户按回车 → precmd hook 触发 → 同步渲染 prompt（含 `$(git_prompt_info)`）→ 若启异步则 fork 子进程查 git → 回调比较输出 → 变化则 `zle .reset-prompt` 重绘。

文字描述：zsh 的 `prompt_subst` 选项使 `$PROMPT` 中的 `$(...)` 在每次渲染时执行。`git_prompt_info` 默认异步——`_defer_async_git_register` in `lib/git.zsh:172-188` 首次 precmd 时检测 `$PROMPT` 是否引用 `git_prompt_info`，是则 `_omz_register_handler` 注册。每次 precmd，`_omz_async_request` fork 子进程执行真正 git 命令，通过 fd pipe 回传，`_omz_async_callback` 比较新旧输出，仅在变化时 `zle .reset-prompt`。关键设计是**条件注册**——prompt 不引用就不 fork，避免无谓进程；**变化检测重绘**——输出相同不刷新，最小化开销。

#### 框架自更新：后台升级链路

业务流程：启动时 check_for_upgrade 读 `.zsh-update` 时间戳 → 超 13 天且 GitHub API 显示有更新 → 按 mode（prompt/auto/reminder/background）处理 → `upgrade.sh` 执行 `git pull --rebase` → 存 `lastVersion` → `changelog.sh` 生成 changelog。

文字描述：`check_for_upgrade.sh` 每次 shell 启动被 source，但先读 `$ZSH_CACHE_DIR/.zsh-update` 的 `LAST_EPOCH` 判断是否到检查频率（默认 13 天，`zstyle ':omz:update' frequency`）。未到则 return，无网络请求。到则 `is_update_available` 调 GitHub API（2 秒超时）比对远程与本地 HEAD commit hash。有更新时按 `zstyle ':omz:update' mode` 分发：`background-alpha` 用 `&|` 后台子 shell 执行 `handle_update` + `precmd` hook 查结果；`prompt` 同步询问用户。实际升级调用 `upgrade.sh`（`zsh -f` 无配置启动避免干扰），`git pull --quiet --rebase`，成功后存 `git config oh-my-zsh.lastVersion` 供 changelog 用。`has_typed_input()` 检测用户正在输入时降级为 reminder，不打断操作。

### 状态流

Oh My Zsh 没有显式状态机，但有两个隐式生命周期状态值得注意：

**zcompdump 缓存状态**：`有效`（revision+fpath 匹配，compinit 直接复用）→ `失效`（升级改了 revision 或增删插件改了 fpath，删除 dump 重建）→ `编译`（zrecompile 生成 `.zwc`）。状态转换由 `oh-my-zsh.sh:118-122` 的指纹检测驱动，是启动性能的关键——缓存有效时跳过最耗时的 fpath 扫描。

**异步 prompt handler 状态**：`未注册` → `已注册`（`_omz_register_handler`）→ `请求中`（fork 子进程，fd 监听）→ `完成`（回调读取，比较输出，重绘或不重绘）→ 回到 `已注册` 等下次 precmd。若上一次请求未完成又触发新请求，`_omz_async_request` 会先 kill 旧进程（`async_prompt.zsh:60-77`）。

## 典型修改场景

#### 场景 1：新增一个内置插件

创建 `plugins/mytool/mytool.plugin.zsh`（入口）和可选 `plugins/mytool/_mytool`（completion）。用户在 `.zshrc` 加 `plugins=(... mytool)` 即可。**无需修改 `oh-my-zsh.sh`**——`is_plugin` in `oh-my-zsh.sh:81-86` 自动发现，fpath 自动注入，`_omz_source` 自动 source。这是约定优于配置的直接体现。

#### 场景 2：用 custom 覆盖内置插件或 lib

在 `$ZSH_CUSTOM/plugins/git/git.plugin.zsh` 放同名文件，内置 git 插件被完全替换（`oh-my-zsh.sh:91-92` custom 优先）。同理 `$ZSH_CUSTOM/lib/git.zsh` 覆盖 stock lib 文件。若只想增强不替换，custom 文件内先 `source "$ZSH/plugins/git/git.plugin.zsh"` 再追加逻辑。`_omz_source` in `oh-my-zsh.sh:176-180` 是覆盖链的核心。

#### 场景 3：自定义主题并启用异步

在 `$ZSH_CUSTOM/themes/mytheme.zsh-theme` 创建文件（设 `$PROMPT` + `$ZSH_THEME_GIT_PROMPT_*` 变量），`.zshrc` 设 `ZSH_THEME=mytheme`。zsh ≥ 5.0.6 默认启用异步 git prompt（`lib/git.zsh:156-157` 的 `zstyle -T` 逻辑）。显式控制：`zstyle ':omz:alpha:lib:git' async-prompt yes|no|force`。主题只需调 `$(git_prompt_info)`，异步细节由 lib 透明处理——这是契约式扩展的好处。

## 阅读源码推荐路线

- **第一遍：理解启动主流程**
  `oh-my-zsh.sh` 全文（仅 236 行）→ 重点看 `_omz_source` in `oh-my-zsh.sh:156-195`（覆盖机制）和 compinit 舞蹈 in `oh-my-zsh.sh:109-154`（缓存设计）。这是整个框架的骨架。
- **第二遍：理解核心库的标准库角色**
  `lib/cli.zsh` 的 `omz` 函数 in 行 3-21（命名空间分发）→ `lib/git.zsh` 的 `_omz_git_prompt_info` in 行 14-40（prompt 契约）→ `lib/prompt_info_functions.zsh`（dummy 兜底模式）。
- **第三遍：理解扩展机制**
  `plugins/git/git.plugin.zsh`（最复杂内置插件，看别名+函数+compdef+版本检测）→ `themes/robbyrussell.zsh-theme`（7 行最简主题）→ `themes/agnoster.zsh-theme` 的 `build_prompt`/`prompt_segment`（函数式主题对比）。
- **第四遍：理解运行时性能与生命周期**
  `lib/async_prompt.zsh`（异步渲染引擎）→ `tools/check_for_upgrade.sh` 的 `handle_update` + `is_update_available`（后台非阻塞设计）→ `tools/install.sh` 的 `setup_ohmyzsh`/`setup_zshrc`（安装幂等性）。

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| stock | 框架内置的原始文件（`$ZSH/` 下），对应 custom 覆盖 |
| custom | `$ZSH_CUSTOM/` 目录，用户放覆盖/扩展文件，优先于 stock |
| fpath | zsh 的 function path，存放 autoload 函数和 completion 定义（`_*` 文件） |
| compinit | zsh completion 系统初始化命令，扫描 fpath 构建 completion 映射 |
| zcompdump | compinit 的缓存文件，避免每次启动重扫 fpath |
| `.zwc` | zsh word code，脚本编译后的字节码，加载快于文本解析 |
| zstyle | zsh 的层级配置机制，Oh My Zsh 用 `:omz:update:*`、`:omz:lib:*` 命名空间 |
| `&\|` | zsh 后台执行语法，等价于 `&` + `disown`，进程脱离父 shell |
| precmd/preexec | zsh 钩子，分别在显示 prompt 前、执行命令前触发 |

### 参考资料

- [Oh My Zsh 官方 wiki](https://github.com/ohmyzsh/ohmyzsh/wiki) — Customization、Plugins、Themes 指南
- [zsh 手册](https://zsh.sourceforge.io/Doc/) — prompt expansion、completion system、zle
- [CVE-2021-45444](https://www.openwall.com/lists/oss-security/2021/12/14/1) — `lib/vcs_info.zsh` 修补的 vcs_info 命令注入漏洞
- [Conventional Commits](https://www.conventionalcommits.org/) — `tools/changelog.sh` 解析的提交规范
