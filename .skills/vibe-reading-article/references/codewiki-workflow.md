# CodeWiki 解读工作流

把代码库 internals 解读成博客 Markdown 文章。与论文解读类似——论文有 `paper-workflow.md` 的 10 步流水线，本文档为代码库解读建立对应的 7 步端到端流程。

`content-guide.md` 代码库节给出 §1-§12 骨架；本文档补充**端到端处理流程、模块识别标准、Agent 并行分析模板、数据流追踪方法、SVG 图表生成、发布前 checklist**。

参考 [deepwiki-rs](https://github.com/sopaco/deepwiki-rs)（四阶段流水线 + 专用研究维度）和 [CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（分层分解 + 多模态产出）的方法论，用 Claude 原生 Agent 工具实现核心模块的并行分析。

---

## 端到端处理流程（代码仓库 URL 或本地路径）

下面把"拿到一个代码仓库 → 产出可发布的博客 Markdown 文章"固化为可复现的 7 步流水线。Step 1-2 顺序执行（需要全局信息才能决定并行策略），Step 3 并行（spawn Agent），Step 4-6 顺序（综合 + 写作 + 发布）。

```
Step 0  元信息与 slug          ── 顺序
Step 1  结构扫描               ── 顺序（Bash: tree/find/grep/wc）
Step 2  核心模块识别            ── 顺序（三信号筛选）
Step 3  并行模块分析            ── 并行（spawn Agent，每模块一个 + 数据流追踪一个）
Step 4  架构综合 + SVG 生成     ── 顺序（从 Agent 结果汇总，生成架构图/数据流图 SVG）
Step 5  撰写文章               ── 顺序（§1-§12 Markdown，引用 SVG 图片）
Step 6  合规检查 + 构建 + 发布   ── 顺序
```

---

### Step 0 · 元信息与 slug

获取仓库并提取项目元信息。

**获取仓库代码**：

```bash
# 方式 A：GitHub 仓库 URL → clone（完整历史，用于 Step 0 取 tag）
git clone <repo-url> /tmp/<project-name>

# 方式 B：本地路径 → 直接使用
REPO_PATH=/path/to/project
```

> ⚠️ 不要用 `--depth 1`，否则无法获取 git tag。如果仓库过大，clone 后立即 checkout 到目标 tag 再分析。

**确定解读版本**：

```bash
# 如果用户指定了版本号（如 v1.2.0），checkout 到该 tag
cd /tmp/<project-name>
git checkout <version-tag>

# 如果用户未指定版本号，取最新 tag 作为解读目标
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null)
if [ -n "$LATEST_TAG" ]; then
  git checkout "$LATEST_TAG"
  echo "解读版本：$LATEST_TAG（最新 tag）"
else
  echo "无 tag，使用默认分支 HEAD"
fi
```

提取元信息：

```bash
# README
cat README.md | head -80

# 包管理文件（按语言选一）
cat package.json | head -30        # Node.js
cat pyproject.toml | head -40      # Python
cat go.mod | head -20              # Go
cat Cargo.toml | head -30          # Rust

# 代码量统计
find . -name "*.py" -not -path "*/node_modules/*" -not -path "*/.git/*" | xargs wc -l | tail -1
# 或用 cloc（如已安装）
cloc --exclude-dir=node_modules,.git,dist,build .
```

定 `slug = {project-name}-internals`（如 `mycli-internals`）。

元信息产出格式（记入上下文，Step 5 写 frontmatter 和导言用）：

```
项目名：xxx
一句话定位：xxx（从 README 首段提取）
版本：v1.0.0
协议：MIT
语言：Python ≥ 3.10
代码量：~18,000 行
维护者：xxx
仓库 URL：xxx
```

---

### Step 1 · 结构扫描（Preprocessing）

系统性扫描代码库结构，产出全局视图。这是后续模块识别和 Agent 分工的基础。

**1.1 目录树（2 层）**

```bash
tree -L 2 --dirsfirst -I "node_modules|.git|__pycache__|dist|build|*.egg-info" 2>/dev/null \
  || find . -maxdepth 2 -type d -not -path "*/node_modules/*" -not -path "*/.git/*" | sort
```

**1.2 各目录代码量统计（识别"重目录"）**

```bash
# 统计每个一级子目录的源码文件数和总行数
for dir in src/*/ lib/*/ app/*/ cmd/*/ internal/*/; do
  [ -d "$dir" ] || continue
  count=$(find "$dir" -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.cpp" -o -name "*.c" 2>/dev/null | wc -l)
  lines=$(find "$dir" -type f \( -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) -exec cat {} + 2>/dev/null | wc -l)
  echo "$dir  files=$count  lines=$lines"
done | sort -t= -k3 -rn
```

**1.3 入口文件识别**

```bash
# 常见入口文件名
find . -maxdepth 3 \( -name "main.*" -o -name "index.*" -o -name "__main__.*" -o -name "app.*" -o -name "cli.*" -o -name "server.*" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/test*"

# Python: __main__.py / setup.py entry_points
grep -r "entry_points\|console_scripts\|__main__" pyproject.toml setup.py setup.cfg 2>/dev/null | head -10

# Node.js: package.json main/bin
grep -E '"main"|"bin"' package.json 2>/dev/null

# Go: main package
grep -rl "package main" --include="*.go" . | head -5
```

**1.4 依赖关系提取（识别"高扇入"模块）**

```bash
# Python: 提取 import 语句，统计被 import 最多的内部模块
grep -rn "^from \|^import " --include="*.py" . \
  | grep -v "node_modules\|\.git" \
  | sed 's/.*from //;s/.*import //' \
  | sort | uniq -c | sort -rn | head -20

# Node.js: require/import 统计
grep -rn "require(\|from ['\"]" --include="*.ts" --include="*.js" . \
  | grep -v "node_modules" \
  | sed "s/.*require(['\"]//;s/.*from ['\"]//;s/['\"]).*//" \
  | sort | uniq -c | sort -rn | head -20

# Go: import 统计
grep -rn '"\./\|"github.com/' --include="*.go" . \
  | sed 's/.*"\(.*\)".*/\1/' \
  | sort | uniq -c | sort -rn | head -20
```

产出格式（记入上下文）：

```
目录树：
  src/
    core/       12 files  3,200 lines
    engine/     8 files   2,800 lines
    api/        6 files   1,500 lines
    utils/      4 files     800 lines

入口文件：src/main.py

高扇入模块（被 import top 5）：
  1. core/config (47 次)
  2. engine/parser (38 次)
  3. core/types (35 次)
  ...
```

---

### Step 2 · 核心模块识别

基于 Step 1 的扫描结果，用**三信号法**筛选 3-5 个核心模块：

| 信号 | 含义 | 来源 |
|------|------|------|
| **重目录** | 代码量 top 5 的子目录 | Step 1.2 统计 |
| **高扇入** | 被 import 次数 top 5 的模块 | Step 1.4 统计 |
| **入口可达** | 从入口文件沿调用链可达的模块 | Step 1.3 入口 + 调用链 |

筛选规则：
1. 取三个信号的**并集**，优先选同时满足两个以上信号的模块
2. 排除纯工具/配置/常量目录（如 `utils/`、`constants/`、`types/`）——它们被频繁 import 但通常不是核心逻辑
3. 排除测试目录（`test*/`、`*_test.*`、`spec/`）
4. 目标：3-5 个核心模块，每个模块有明确的职责边界

产出格式：

| 模块 | 路径 | 代码量 | 信号 | 职责（一句话） | 关键文件 |
|------|------|--------|------|----------------|----------|
| 核心引擎 | `src/engine/` | 2,800 行 | 重目录 + 入口可达 | 解析与执行用户请求 | `parser.py`, `executor.py` |
| 配置管理 | `src/core/config/` | 1,200 行 | 高扇入 | 加载和管理配置 | `loader.py`, `schema.py` |
| ... | ... | ... | ... | ... | ... |

---

### Step 3 · 并行模块分析

对 Step 2 识别的每个核心模块 spawn 一个 Agent，**同一条消息**里发起多个 Agent 调用实现并行。额外 spawn 1 个 Agent 做入口数据流追踪。

**并行 Agent 数量**：核心模块数 + 1（数据流追踪）。通常 4-6 个 Agent。

**Agent prompt 模板（模块分析）**：

```
你是代码库分析专家。分析以下模块，产出结构化摘要。

仓库路径：{repo_path}
模块路径：{module_path}
模块职责（初步判断）：{one_line_responsibility}
关键文件：{key_files_list}

请阅读该模块的关键文件（不超过 3 个，每个 ≤ 500 行），提取以下信息：

1. **核心 class/struct 定义**：列出主要类及其关键属性和方法签名（代码块）
2. **关键方法调用流程**：从该模块的入口方法出发，追踪 2-3 层调用链（用缩进列表或 ASCII 流程图）
3. **设计模式**：识别该模块使用的设计模式（工厂、观察者、策略、中间件等），给出具体代码位置
4. **模块间交互**：该模块 import 了哪些其他模块？被哪些模块 import？交互方式是什么（函数调用/事件/接口）？
5. **重要设计决策**：该模块有哪些值得在博客中讲解的设计决策？为什么这样设计？

产出格式：
- 用中文描述，专有名词保留英文
- 代码块标注文件路径
- 不要读整个模块所有文件，只读关键文件
```

**Agent prompt 模板（数据流追踪）**：

```
你是代码库分析专家。追踪以下仓库的一次完整请求数据流。

仓库路径：{repo_path}
入口文件：{entry_file}
入口函数：{entry_function}

请从入口函数出发，沿调用链追踪一次完整请求的数据流，直到输出/返回。提取：

1. **调用链**：entry_function → func_a → func_b → ... → output（用缩进列表）
2. **每步的输入/输出数据类型**：函数签名和返回值
3. **跨模块边界**：调用链在哪里跨越了模块边界？数据如何传递（参数/共享状态/事件）？
4. **异步/并发**：是否有 async/await、goroutine、线程？在哪些环节？
5. **错误处理**：异常如何传播？有哪些全局错误处理？

产出格式：
- 用中文描述，专有名词保留英文
- 调用链用 ASCII 流程图或缩进列表
- 标注每步的文件路径和行号范围
```

**Agent 结果收集**：每个 Agent 返回一份结构化摘要。这些摘要就是 Step 4 架构综合和 Step 5 文章撰写的全部素材——主会话不需要再读模块源码。

---

### Step 4 · 架构综合 + SVG 生成

从 Step 3 各 Agent 的分析结果中综合产出全局视图，并生成 SVG 图片。这一步不读代码，只整理 Agent 返回的摘要。

**4.1 分层架构图（SVG）**：根据模块职责和依赖关系，将模块归入 3-5 层，生成 SVG 图片存入 `public/images/articles/{slug}/architecture.svg`。

SVG 风格要求：
- 深色背景（`#0b0d14`），与博客主题一致
- 每层用不同强调色区分（蓝 `#6c8ef5`、青 `#4ecdc4`、黄 `#f9ca24`、粉 `#ff6b9d`）
- 层内标注模块名和职责
- 宽度 800px，高度按层数自适应

**4.2 模块关系图（SVG）**：从各 Agent 的"模块间交互"信息汇总，画出模块间的依赖关系，生成 `module-dependencies.svg`。

**4.3 全局数据流路径（SVG）**：从数据流追踪 Agent 的结果整理出端到端数据流路径图，生成 `data-flow.svg`。

**4.4 设计模式汇总**：从各 Agent 的"设计模式"信息汇总去重，列出 3-5 个核心设计模式（用 Markdown 表格，不需要 SVG）。

**SVG 生成方法**：用 Python 脚本或手写 SVG XML 生成，存入 `public/images/articles/{slug}/` 目录。图片引用路径 `/vibe-reading/images/articles/{slug}/{filename}.svg`，由 `rehype-jsdelivr-images` 插件自动改写为 CDN。

---

### Step 5 · 撰写文章（多文件输出）

基于 Step 1-4 的全部产出，按**概览 + 模块**多文件结构撰写 Markdown 文章。输出目录与 frontmatter `category` 对齐，每个文件是首页一张独立卡片。

**输出目录**：`src/pages/articles/_md/{category_path}/`，其中 `{category_path}` = category 数组用 `/` 拼接。文件直接放在 category 末级目录下，不再多一层 slug。

例如 `category: [Python, MyCLI, CodeWiki, "1.2.0"]` → 目录 `_md/Python/MyCLI/CodeWiki/1.2.0/`

**文件结构**（文件名前缀 `00-`/`01-`/`02-`... 保证排序：概览在前，模块按序）：

```
src/pages/articles/_md/{category_path}/
├── 00-overview.md          # 概览（title: "Overview"，排在分类最前）
├── 01-{module-a}.md        # 核心模块 A（独立成文）
├── 02-{module-b}.md        # 核心模块 B
├── 03-{module-c}.md        # 核心模块 C
└── 04-{module-d}.md        # 核心模块 D（如有）
```

> 目录路径中的版本号引号在文件系统中不需要——`"1.2.0"` 作为目录名就是 `1.2.0`。
>
> 概览文件 title 固定为 `"Overview"`，使其在分类树中排在最前面（字母序 O 在数字前更靠前，且分类树按 label 字母序排列时 00-overview 的 slug 已保证文件排序）。

**每个文件的 Frontmatter**：

```yaml
---
source:
  type: "源码解读"
  project: "{project-name}"
  url: "{repo-url}"
title: "Overview"                        # 概览固定为 "Overview"；模块文件改为 "{模块名} 详解"（不加项目前缀，由 source 自动生成）
date: "YYYY-MM-DDTHH:MM:SS+08:00"
category: [Domain, Project, CodeWiki, "{version}"]
tags: ["项目名", "语言", "核心标签"]
description: "一句话描述"
readingTime: "N min"
aiModel: "Claude Opus 5"
reviewed: false
---
```

> `source.type = "源码解读"`，前缀自动生成 `[project 源码解读]`（如 `[mycli 源码解读]`）。所有文件共享同一 source 和 category。

> `category` 末级用 `CodeWiki` + 版本号（引号包裹，如 `"1.2.0"`）。所有文件共享同一 category。徽章显示 `CodeWiki`（而非版本号），与 `Docs` 同理。版本号取 Step 0 的 tag（如 `v1.2.0` → `"1.2.0"`，去掉 `v` 前缀）。

**概览文件（`00-overview.md`）内容**：

```markdown
> **版本** v1.0.0 · **协议** MIT · **语言** Python ≥ 3.10 · **代码量** ~18,000 行 · **仓库** [GitHub](repo-url)

---

## 项目简介
...（Step 0 元信息）

## 目录结构
...（Step 1.1 目录树）

## 分层架构
...（Step 4.1 SVG 架构图）

## 入口与启动流程
...（Step 1.3 + 数据流 Agent）

## 核心设计模式
...（Step 4.4 设计模式汇总表格）

## 依赖总览
...（Step 0 包管理文件表格）

## 全局数据流
...（Step 4.3 SVG 数据流图）

## 子文档导航

| 文档 | 内容 |
|------|------|
| [核心引擎详解](/vibe-reading/articles/{category_path}/01-engine) | 解析与执行引擎的内部原理 |
| [配置管理详解](/vibe-reading/articles/{category_path}/02-config) | 配置加载与管理机制 |
| ... | ... |
```

**模块文件（`01-{module}.md`、`02-{module}.md`...）内容**：

每个模块文件包含该模块的完整解读：
- 核心类/struct 定义（代码块）
- 关键方法调用流程（ASCII 流程图或缩进列表）
- 设计模式与设计决策
- 模块间交互说明

**概览中的子文档链接**：概览文件末尾放一个导航表格，链接到各模块文档。链接路径为 `/vibe-reading/articles/{slug}/{NN-module}`（不含 `.md` 扩展名）。

**写作规范**：
- 正文中文，专有名词（框架名、函数名、路径）保留英文原文
- 引用源码中真实的路径和函数名，不编造 API
- 代码块必须标注语言和 `title="文件路径"`
- 每个 `##` 节有实质内容（代码 / 表格 / 图片），不写空泛段落
- SVG 图片用 `![alt](/vibe-reading/images/articles/{slug}/{filename}.svg)` 引用，alt 即图注
- 不含 `layout:` 行（由路由统一处理）

---

### Step 6 · 合规检查 + 构建 + 发布

```bash
# 合规检查（逐文件检查）
for f in src/pages/articles/_md/<slug>/*.md; do
  bash .skills/vibe-reading-article/scripts/check-article.sh "$f"
done

# 构建验证
npm run build
```

exit 0 = 通过；exit 1 = 按提示修正后重跑。

**图片提交**：SVG 文件在 `public/images` 子仓库，需先在子仓库 commit + push，再在主 repo 暂存指针（同论文图片流程）：

```bash
cd public/images && git add -A && git commit -m "add {slug} svg" && git push && cd ../..
git add public/images
```

用户确认满意后完成发布。

---

## 方法论映射

| 人脑代码阅读方法 | AI 流水线执行 |
|---|---|
| 自顶向下：先看目录结构再深入 | Step 1 结构扫描 → Step 2 模块识别 → Step 3 逐模块深入 |
| 找入口、追数据流 | Step 1.3 入口识别 + Step 3 数据流追踪 Agent |
| 识别核心模块（凭经验） | Step 2 三信号法（重目录 + 高扇入 + 入口可达），程式化替代直觉 |
| 逐模块精读 | Step 3 并行 Agent，每模块独立上下文，避免"读完前面忘后面" |
| 综合理解架构 | Step 4 架构综合，从 Agent 摘要汇总分层图 + 关系图 + 数据流 |
| 画架构图 | Step 4 生成 SVG 图片，替代 HTML 组件 |
| 写文档 | Step 5 撰写 Markdown 文章，每节有 Step 1-4 的产出作为素材依据 |

**与 deepwiki-rs / CodeWiki 的对应关系**：

| deepwiki-rs / CodeWiki 概念 | 本流水线对应 |
|---|---|
| Phase 1: Preprocessing | Step 0 + Step 1 |
| Phase 2: Intelligent Research（专用研究 Agent） | Step 2 + Step 3（并行 Agent） |
| Phase 3: Documentation Generation | Step 4 + Step 5 |
| Phase 4: Verification | Step 6 |
| Hierarchical Decomposition | Step 1 结构扫描 + Step 2 三信号模块识别 |
| Memory（跨 Agent 共享） | Claude 单会话上下文（Agent 结果返回主会话） |
| Multi-Modal Synthesis | Step 4 架构综合 + SVG 生成（分层图 + 关系图 + 数据流图） |

---

## Agent 并行最佳实践

### 何时 spawn Agent

- **Step 3 是唯一的并行点**：模块分析互不依赖，天然可并行
- Step 1-2 必须顺序：需要全局扫描结果才能决定 spawn 几个 Agent、分析哪些模块
- Step 4-6 必须顺序：需要所有 Agent 结果才能综合

### Agent 数量控制

- 核心模块 3-5 个 + 数据流追踪 1 个 = **4-6 个 Agent**
- 如果模块 > 5 个，合并相近模块，控制在 5 个以内
- 单条消息内 spawn 所有 Agent，不要分批

### Agent 结果质量保障

- 每个 Agent 的 prompt 中明确"只读关键文件，不超过 3 个，每个 ≤ 500 行"——避免 Agent 读太多导致返回结果过长
- Agent 返回结构化摘要（5 个固定维度），主会话不需要再读源码
- 如果 Agent 返回的结果不够详细，可以 SendMessage 追问具体细节

### 上下文管理

- Agent 的独立上下文天然解决了大型代码库"读完前面忘后面"的问题
- 主会话只接收各 Agent 的摘要（每个 ~500-1000 字），总增量可控
- Step 5 撰写文章时，所有素材已在上下文中，不需要再读文件

---

## 发布前 checklist

写完逐项核对：

1. 项目定位是否准确？（一句话能说清是做什么的）→ §1
2. 目录树是否完整覆盖核心目录？→ §2
3. 分层架构是否有依据？（不是凭空画，而是基于模块依赖关系）→ §3
4. 入口流程是否追踪到完整调用链？→ §4
5. 每个核心模块是否有核心类定义 + 调用流程 + 设计决策？→ §5-§8
6. 设计模式是否引用了真实代码位置？→ §10
7. 数据流是否端到端完整？（从入口到输出）→ §12
8. 所有代码块是否标注了文件路径？→ 全文
9. 是否有编造的 API 或函数名？→ 全文（与源码交叉验证）
10. SVG 图片是否正常渲染？→ 构建验证
11. frontmatter 字段是否完整？（`title`、`date`、`category`、`description`、`readingTime`、`aiModel`）→ 文件头

---

## 合规检查

```bash
bash .skills/vibe-reading-article/scripts/check-article.sh src/pages/articles/_md/<slug>.md
```

Markdown 文章校验项：文件名 kebab-case、frontmatter 必填字段（`title`/`date`/`category`/`description`/`readingTime`/`aiModel`）、不含 `layout:` 行。
