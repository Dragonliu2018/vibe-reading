---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "主题与组件"
date: "2026-09-18T15:58:57+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "主题", "i18n"]
description: "全窗 token 化的主题系统（9 色 + 3 圆角 + 8 chrome + vars 逃生舱注入 ~22 个 CSS 变量），win98 用专属样式表做 3D bevels；CodexThemes 磁盘真源导入；21 语言无 Context 轻量 i18n；FileTree/SystemMonitor/GitDiffView 等配套组件的预算化渲染。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

这一层回答"Termany 长什么样、说哪国话、终端旁边还有什么工具"。主题系统的野心写在 README："A theme restyles the whole window, not only the terminal palette: the sidebar, the tab strip, the gap and corner radius of each pane, and the shadow under it all come from the theme"——Windows 98 主题能把 bevels 和 navy 标题栏找回来。实现的关键是**扁平、可序列化的 token schema**（`themes/types.ts` 文件头注释）：每个字段要么映射 CSS 变量、要么进 xterm palette，因此手写主题、AI 从 prompt 生成、第三方 Codex 包导入三者走**同一条注册管道**。

配套组件层（`components/` 里的 FileTree/SystemMonitor/GitDiffView/WebBrowserPane/OfficePreview/SearchPalette 等）是围绕终端的工具 pane 家族。

## 模块架构

```text title="主题注册管道"
Theme 对象（手写 ts / AI 生成 / Codex 包导入）
└─ registerTheme()（themes/index.ts，isTheme() 廉价形状校验，同 id 原位替换）
     └─ applyThemeObject(theme)
          ├─ ~22 个 CSS 变量 setProperty 到 :root（先清 lastCustomVarKeys 防上一主题 vars 泄漏）
          ├─ borderRule()：transparent 塌缩为 0 solid（1px 透明边仍占像素显 hairline）
          ├─ root.dataset.theme = theme.id（激活 html[data-theme="win98"] 专属样式表）
          └─ applyTermTheme(theme.term)（对所有 live session 重刷 xterm palette）

CodexThemes 三件套
├─ codex-listings.ts   GET /api/codex-themes → server 扫 ~/.codexthemes/themes/*/theme.json
├─ codex-import.ts     manifest palette 语义映射 → Termany Theme（canvas→bg2、surface→bg3…）
└─ codex-packs.ts      registerCodexListing()（仅内存注册，磁盘是真源）
     └─ 启动：main.tsx 先读 storedThemeId（在 applyTheme 之前！否则回落默认会覆盖想恢复的 id）
          → hydrCodexTheme() 异步重注册 → setTheme
```

## 调用链路

一次主题切换的链路：用户在 Settings Appearance 点选 → store 的 `setTheme(id)` → `applyTheme(id)` = `applyThemeObject` + localStorage 持久化 → CSS 变量即时生效 → `applyTermTheme` 重刷全部 xterm palette。⌥⌘./, 循环走 `nextTheme`/`prevTheme`。启动时 `main.tsx:27` 在首次 render **之前** `applyTheme(loadThemeId())`（无闪烁）。

## 核心实现

### Theme token 结构

约 **9 colors + 3 radius + 8 chrome + sidebar 2 + vars + background + term**：colors 是一条刻意的 elevation ramp（`bg` 终端区 / `bg2` 侧栏标签条抬升面 / `bg3` hover 菜单徽章 / `border` / `fg` / `fgDim` / `accent` / `accentSoft` 半透明选区）；radius 三档（控件 → 行/标签 → 弹层）；chrome 8 个 token 里 `paneGap` 允许四边不同（CSS padding 简写）、`paneShadow` 是完整 CSS 值（`"none"` 得扁平外观）、`topBar` 支持渐变字符串；`vars` 是逃生舱（任意 CSS 自定义属性，`applyThemeObject` 最后应用所以必然胜出）；`background: {image, opacity}` 让背景图从 chrome 面透出来而实心气泡保留对比度；`term` 直接复用 xterm 的 `ITheme`。

`applyThemeObject` 的工程细节：`lastCustomVarKeys` 先清再注（否则 Codex 主题设过的 `--pane-focus-ring` 透明会泄漏到下一主题）；`withAlpha()` 只对已知 `#rgb/#rrggbb` 格式转 rgba，其他格式原样返回（"safer than mis-blending a format we don't understand"）——带背景图时经 `blend()` 应用到 `--pane-area-bg`（bg2）、`--agent-surface-bg`（bg）等 chrome 面，让图从这些面透出来；`--split-gutter-line` 仅在 flush 布局（`paneGap === 0`）时画 hairline，有 gap 时 pane 自身边框已分隔、再画会双重线；`--pane-shadow` 默认刻意收紧——大 blur 会跨 split gutter 洇到邻 pane。

### win98：token 装不下的放专属样式表

Windows 98 主题是双轨制的范本：Theme 对象负责平面部分（灰 `#c0c0c0`、navy `#000080`、全 0 圆角、`paneGap: "3px"` 让 pane 读作 MDI 子窗口、完整 CGA 16 色 MS-DOS 调色板）；3D chrome（斜面按钮、navy 标题栏、sunken 输入框）**全部放 `win98.css`，每条规则 scoped 到 `html[data-theme="win98"]`**——其他主题下整个文件惰性。bevel 用 inset box-shadow 两层（highlight→light 在上/左，dark→shadow 在下/右，sunken 控件反转）——"exactly as the OS drew them"。`types.ts` 注释把这定为范式："A theme whose look needs more than the flat tokens ships its own stylesheet scoped to html[data-theme='<id>']"。

### CodexThemes：磁盘是真源

设计（`codex-packs.ts` 文件头注释）：**磁盘 `~/.codexthemes/themes` 是唯一真源，localStorage 只记"选了哪个"**——不复制进 localStorage，避免内置列表与文件夹列表漂移出重复项。注意不是从 codexthemes.ai 拉清单（那只是 Settings 里的外链按钮）：包由用户自行下载放入该目录。`fromCodexTheme()` 的关键判断（codex-import.ts 文件头）：Codex 的 CSS 层针对它自己的 DOM 无法复用，但 manifest palette 是**语义 token 集，可干净映射**（`canvas→bg2`、`surface→bg3`、`raised→bg`、`text→fg`、`muted→fgDim`）；chrome 照抄 Codex 桌面 app 的 flush 布局；导入的主题 id 固定前缀 `custom-codex-${manifest.id}`——重复导入原位更新；有 artwork 时 `background.opacity: 0.55` + `vars: {"pane-bg": alpha(terminalBackground, 0.55)}` + `term.background: alpha(..., 0)`——终端变成半透明面纱（配合 manager 的 `allowTransparency`），文字仍有 tinted backdrop 保对比度；无 artwork 时则不设 background、vars 也不含 pane-bg，终端背景照常不透明。

### generateTheme：AI 生成（server 侧）

`apps/server/src/theme.ts` 的 `generateTheme(prompt)` 读 `loadConfig().defaultModel`，**API key 留在 server 侧**。Anthropic 路径用 `output_config.format.json_schema` + 与前端 Theme 子集严格对应的 JSON Schema（`additionalProperties: false`）；OpenAI 兼容路径用 `json_object` + 文本约定。SYSTEM prompt 内嵌设计规则（bg→bg2→bg3 必须构成 elevation ramp、fg 需 WCAG AA）。注意：当前 web 前端**没有**调用 `/api/theme` 的代码——pre-6.0 移除了应用内主题编辑器，server 端点与生成逻辑保留待用。

### i18n：无 Context 的轻量 hook

`useI18n()` 是 hook 不是 Context——无 Provider，66 个组件直接调用。实现：`useState(getLanguage)` + 监听两个事件（自定义 `"termany:language-changed"` 同窗同步 + 原生 `"storage"` 跨窗同步）。`t` 用 `useCallback` 以 `[language]` memo 化——注释记录血泪教训：调用方把 `t` 放进依赖表，不稳定 identity 会静默变成"每次渲染都跑"，曾让 ⌘P palette 每次击键重置选中项。locale 文件是 **flat dot-namespaced key**；en 是 source（`TranslationKey = keyof typeof en`），其他语言 `Partial`——**允许落后，缺失 key 回落英文**；占位符 `{name}` 而非拼接（翻译可重排语序）；`LANGUAGES` 用各语言 **endonym**（落错语言的用户也得能找到回家的路）；`matchLanguage()` 中文按 **script 而非 region** 特判（`hant|-tw|-hk|-mo → zh-TW`，否则 zh-CN），`pt-PT` 目前也落到 pt-BR（"closer than falling through to English"，加 pt-PT 字典后需改为按 region 区分——注释已预告）。持久化 `localStorage["termany.language"]`；主题侧的持久化键是 `"termany.theme"`，`loadThemeId()` 校验 id 仍在注册表内，不解析时回落 `DEFAULT_THEME_ID = "codex"`；`loadAiThemes()` 是一次性清理——删除 pre-6.0 应用内主题编辑器遗留的 `"termany.aiThemes"` localStorage store（被移除功能的痕迹），存了但解析不到的 id 一律回落默认。

### 配套组件的共性范式

- **FileTree.tsx**（1073 行）：数据源是按需 REST（`GET /api/fs/list`，根目录经 `session=` 参数解析 PTY 实时 shell cwd），**无文件系统 watch**；模块级 `stateCache: Map<sessionId, FileTreeState>` 抵御 maximize 导致的 remount；卸载时若真正切走则 `sendCommand(sessionId, 'cd …')` 把终端带进树所在目录——树与终端双向同步。
- **SystemMonitor.tsx**（597 行）：2s 轮询 `/api/system-stats`，连续 2 次失败才置 null（不闪断）；搜索框匹配 pid/端口时**过滤 group 的 children 并重算聚合**（否则 "node ×69" 会把 69 个进程的内存全钉在持端口那个 pid 上）；底栏 Sparkline 画 server 侧 sample ring 的整机史（pane 关了再开曲线还在）。
- **GitDiffView.tsx**（594 行）：性能三招——**行数预算的自动展开**（`AUTO_EXPAND_LINES = 800`，防 15 个 4000 行文件铺 25 万 DOM 节点）、`parseDiff` 惰性行遍历（不用 `split("\n")` 免得 maxLines 之前先分配整个尾巴）、`DIFF_RENDER_CHUNK = 300` 视口分片追加渲染；`viewCache` 让 remount（zen、拖去别的 tab）存活含 scrollTop；窗口 focus 重拉（"面板的意义就是读 agent 刚改了什么"）。
- **SearchPalette.tsx**（361 行）：⌘K（不是 ⌘P）搜所有 workspace 的 pages/tabs/panes 标题 + 可绑定 action；自实现简化打分（精确 100/前缀 60/包含 30，**只对 item 自己的 title 打分**——否则默认名 "tab 1" 借父页面名泛滥）；结果渲染为过滤后的真实树而非 flat 列表，侧栏层级本身做同名消歧。action 在 pane 而非终端里做 `/` 命令的理由（注释）：pane 里跑的是 agent CLI，`/` 键归它自己的 slash 命令。
- **WebBrowserPane.tsx**：Tauri 下是**原生子 Webview**（`new Webview(...)`，画在 DOM 之上无视 z-index，所以有一套 `canReveal()`/occluder 协调 DOM 弹窗时 `webview.hide()`）；浏览器 demo 退化普通实现。
- **OfficePreview.tsx**：docx/xlsx/pptx 三件**全动态 import**（mammoth/SheetJS/pptx-preview 都不小，不打开 Office 文件就不进主 bundle）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 数据驱动的注册管道 | `registerTheme` → `applyThemeObject` | 手写/AI/第三方三种来源一条路 |
| 双层逃生舱 | `vars` + `html[data-theme]` 专属样式表 | token 覆盖不到的效果不污染 schema |
| 磁盘真源 + 内存注册 | codex-packs | Appearance 面板永远诚实，代价是启动异步水合 |
| en 为 source、Partial 回落 | i18n/index.ts | 21 语言不可能同步维护，允许 lag 而非阻塞发版 |
| 模块级 cache 抵御 remount | FileTree `stateCache`、GitDiffView `viewCache` | maximize/split 强制 remount，React state 活不了 |
| 预算化渲染 | GitDiffView 三招、SearchPalette 只搜标题 | 兆级行的 diff 与文件，DOM 是第一瓶颈 |

## 模块间交互

上游：`store` 的 `setTheme`/`nextTheme`；`main.tsx` 的启动上色与 Codex 水合。下游：`terminal/manager` 的 `applyTermTheme`（palette 重刷）与 `allowTransparency`；server 的 `/api/codex-themes`、`/api/fs/*`、`/api/system-stats`、`/api/git/*`、`generateTheme`。`paneViewCycle` 与 rail-config 联动决定哪些工具视图参与 ⌘E 循环。

## 扩展方式

**新增一个内置主题**：新建 `themes/mytheme.ts` 导出 `Theme`（最小只需 colors/radius/term）→ `themes/index.ts` append 进 `THEMES`——注释明言 "Nothing else needs to change"：picker、持久化、apply 全泛型。需要 3D 效果就仿 win98 配专属 CSS。

**新增一个 locale**：`locales/xx.ts` flat dot-key 对象（`Partial`，可只翻译子集）→ `Language` union + `LANGUAGES`（endonym）+ `dictionaries` 注册；注意 `matchLanguage()` 现有 `pt` 特判的注释——加 pt-PT 后需改按 region 区分。

**新增一个配套工具 pane**：新组件遵循范式（轮询 fetch + `useI18n()` + 模块级 viewCache + 原生 webview遮挡处理）→ server 加路由 → store 的 view 类型注册 → keybindings 加 action（自动进 palette 与 Settings）→ en.ts 加 key（其余语言自动回落英文）。
