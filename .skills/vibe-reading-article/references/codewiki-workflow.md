# CodeWiki 解读工作流

把代码库 internals 解读成博客 Markdown 文章。与论文解读类似——论文有 `paper-workflow.md` 的 10 步流水线，本文档为代码库解读建立对应的 7 步端到端流程。

`content-guide.md` 代码库节给出 §1-§12 骨架；本文档补充**端到端处理流程、模块识别标准、Agent 并行分析模板、数据流追踪方法、SVG 图表生成、发布前 checklist**。

参考 [deepwiki-rs](https://github.com/sopaco/deepwiki-rs)（四阶段流水线 + 专用研究维度）和 [CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（分层分解 + 多模态产出）的方法论，用 Claude 原生 Agent 工具实现核心模块的并行分析。

---

## 端到端处理流程（代码仓库 URL 或本地路径）

下面把"拿到一个代码仓库 → 产出可发布的博客 Markdown 文章"固化为可复现的流水线。Step 1-2 顺序执行（需要全局信息才能决定并行策略），Step 3 并行（spawn Agent），Step 4-5 顺序（综合 + 写作），Step 5.5 并行（验证），Step 6 顺序（发布）。

```
Step 0  元信息与 slug          ── 顺序
Step 1  结构扫描               ── 顺序（Bash: tree/find/grep/wc）
Step 2  核心模块识别            ── 顺序（三信号筛选）
Step 3  并行模块分析            ── 并行（spawn Agent，每模块一个 + 数据流追踪一个）
Step 4  架构综合 + SVG 生成     ── 顺序（从 Agent 结果汇总，生成架构图/数据流图 SVG）
Step 5  撰写文章               ── 顺序（§1-§12 Markdown，引用 SVG 图片）
Step 5.5 验证循环（闭卷考试）   ── 并行（每模块出题+答题，信息隔离，1 轮 + 条件追加）
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
2. 排除纯数据/工具/配置/常量目录（如 `utils/`、`constants/`、`types/`、`models/`、`dto/`、`entities/`）——它们被频繁 import 但通常不包含业务逻辑
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

1. **核心 class/struct 定义**：列出主要类及其关键属性和方法签名（代码块）。
   跳过纯数据类（DTO/VO/Config/Model/Entity 等），只分析包含业务逻辑的类。
2. **关键方法调用流程**：从该模块的入口方法出发，沿调用链追踪 2-3 层关联方法的
   签名和职责（用缩进列表或 ASCII 流程图）。不仅看当前方法，也要理解它在调用链中的角色。
3. **设计模式**：识别该模块使用的设计模式（工厂、观察者、策略、中间件等），
   每个模式附带代码位置（文件名 + 方法名或行号范围）。
4. **模块间交互**：该模块 import 了哪些其他模块？被哪些模块 import？
   交互方式是什么（函数调用/事件/接口）？
5. **重要设计决策**：该模块有哪些值得在博客中讲解的设计决策？为什么这样设计？
   每条决策应附带代码位置（文件名 + 方法名），让读者可以追溯到源码。
6. **典型修改场景**：列出 2-3 个该模块的典型扩展/修改场景（如"新增一种 X"、"修改 Y 行为"），
   每个场景指明需修改的文件和关键函数。供概览的"典型修改场景"章汇总。

**反偷懒规则**（硬性约束，违反的结果作废重跑）：
1. 必须读每个关键文件的全部内容，不只扫"main"或"index"文件
2. 必须引用具体函数名和文件路径（`函数名 in 路径`），不许说"有一个函数…"、"某处会…"
3. 必须解释设计决策的 why，不只描述代码做什么——"为什么这样设计"比"做了什么"重要
4. 不确定时明确标注"待核实"，不要用模糊措辞掩盖（"似乎"、"可能"不算标注）

产出格式：
- 用中文描述，专有名词保留英文
- 代码块标注文件路径
- 不要读整个模块所有文件，只读关键文件
- 每条设计决策和设计模式都标注代码位置，不写无依据的断言
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

**4.1 分层架构图（SVG）**：根据模块职责和依赖关系，将模块归入 3-5 层，生成 SVG 图片存入 `public/images/articles/{slug}/architecture.svg`。用于概览「分层设计」子节——展示纵向分层。

**4.2 模块关系图（SVG）**：从各 Agent 的"模块间交互"信息汇总，画出模块间的依赖关系，生成 `module-dependencies.svg`。用于概览「模块地图」章——展示横向组件间的 import/调用关系。与 4.1 分层架构图视角不同：4.1 讲纵向分层，4.2 讲横向依赖。

**4.3 全局数据流路径（SVG）**：从数据流追踪 Agent 的结果整理出端到端数据流路径图，生成 `data-flow.svg`。

**SVG 通用设计要求**（所有 SVG 共用）：

1. **美观**
   - 深色背景（`#0b0d14`），与博客主题一致
   - 用不同强调色区分类型/层级（蓝 `#6c8ef5`、青 `#4ecdc4`、黄 `#f9ca24`、粉 `#ff6b9d`）
   - 节点用圆角矩形，统一尺寸（同类节点同尺寸），留白充足，不拥挤
   - 连线用统一描边粗细（1.5px），箭头清晰，避免交叉
   - 字体用无衬线（`system-ui`），字号统一（14-16px 标题、12px 标签）
   - 宽度 800px，高度按内容自适应
   - **背景 rect 高度必须等于 SVG 高度**——`<rect>` 的 `height` 与 `<svg>` 的 `height` 和 `viewBox` 高度三者一致，不允许底部留白（最大内容 y 值 + 20-30px padding 即为 SVG 高度）

2. **直观简洁**
   - **不要包含大片文字**——图里只放节点名、层名、箭头标签（1-3 个词）
   - 详细的职责说明、设计决策、数据类型等放在图片后边的正文解读中
   - 图的作用是"一眼看懂结构/关系/流向"，文字解读负责"为什么、怎么做"
   - 如果一个节点需要超过一句话才能说清，说明它该在正文里讲，不在图里

3. **准确**
   - 节点名、模块名、文件路径必须与源码一致，不编造
   - 依赖箭头方向必须与实际 import/调用关系一致
   - 层次归属必须与代码目录映射表一致
   - 数据流方向必须与实际调用链一致

4. **无底部留白**
   - SVG 高度 = 最大内容 y 值 + 20-30px padding
   - 背景 rect 的 height 必须等于 SVG 的 height
   - viewBox 的 height 必须等于 SVG 的 height
   - 三者不一致会导致渲染时底部出现大片黑色留白

5. **文字不遮挡**
   - 文字必须在所属节点矩形内部，四周至少留 8px padding
   - 节点内文字用 `text-anchor="middle"` 居中，y 坐标对齐节点垂直中线偏上
   - 多行文字行间距 ≥ 16px，避免行间重叠
   - 节点宽度不够容纳文字时，加大节点宽度或缩短文字，不允许文字超出节点边界
   - 箭头标签不与箭头线重叠——标签放在箭头中点上方或下方偏移 8px

6. **箭头指向准确**
   - 箭头起点在源节点底边或右边边缘，终点在目标节点顶边或左边边缘，不指向节点中心
   - 箭头不穿过其他节点——如果路径会穿过节点，用折线路径（`L` 拐弯）绕开
   - 分支箭头（一对多）从同一点发散，汇聚箭头（多对一）到同一点收敛
   - 箭头终点与目标节点边缘的距离 ≤ 2px，不悬空也不重叠

7. **风格一致性**
   - 所有 SVG 统一用 `system-ui, sans-serif` 字体，不混用 monospace 等其他字体
   - 节点填充色统一用 `#13162a`，不混用 `#1a1d2a` 等其他色值
   - 装饰性箭头（loop back、cross-layer、feeder）opacity ≥ 0.6，不能用 0.3-0.5 导致在深色背景上几乎不可见
   - 文字标签不旋转（不用 `transform="rotate"`），水平放置保证可读性

8. **hover 交互**
   - 所有 SVG 的 `<style>` 块中必须包含 `path:hover { stroke: #6c8ef5 !important; stroke-width: 3 !important; cursor: pointer; }`
   - 鼠标悬停在箭头上时高亮（加粗变蓝），移开恢复

**4.4 设计模式汇总**：从各 Agent 的"设计模式"信息汇总去重，列出 3-5 个核心设计模式（用 Markdown 表格，不需要 SVG）。

**4.5 核心概念汇总**：从各 Agent 的"核心 class/struct 定义"信息汇总，提取项目最重要的 5-8 个对象和核心抽象，整理为：
- 对象表（核心对象 | 含义 | 生命周期 | 主要关系）——具体领域模型/核心数据结构
- 核心抽象表（接口/抽象类 | 定义位置 | 实现类 | 注册方式）——基础接口/抽象类及其实现关系，这些是扩展点的契约
- 对象关系图（ASCII 即可，复杂关系才生成 SVG）——展示对象间的包含/依赖/继承关系，含抽象与实现的层次

**4.6 典型修改场景汇总**：从各 Agent 的"典型修改场景"信息汇总，挑选 3 个最具代表性的场景（覆盖不同模块），每个场景列出需修改的文件和关键函数——供概览"典型修改场景"章使用。

**SVG 生成方法**：用 Python 脚本或手写 SVG XML 生成，存入 `public/images/articles/{slug}/` 目录。所有 SVG 遵循上述「SVG 通用设计要求」（美观 + 直观简洁 + 准确）。图片引用路径 `/vibe-reading/images/articles/{slug}/{filename}.svg`，由 `rehype-jsdelivr-images` 插件自动改写为 CDN。

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

**每个文件的 Frontmatter** 和 **概览/模块文件的章节结构模板**：见 [`codewiki-template.md`](./codewiki-template.md)（包含 frontmatter 格式、概览模板、模块模板、写作规范、反偷懒规则）。撰写时参照该文件。

---

### Step 5.5 · 验证循环（闭卷考试）

借鉴 [deep-code-reader](https://github.com/CiferaTeam/deep-code-reader) 的 ABC 验证循环，用信息隔离的闭卷考试检验文档是否真正全面，而非浅层摘要。**默认 1 轮，仅在通过率 < 80% 时追加第 2 轮**，在质量和成本间取平衡。

**为什么需要**：Step 3 的 Agent 分析和 Step 5 的撰写都可能"脑补"——写出听起来合理但与源码不符的断言，或遗漏关键细节。合规检查（Step 6）只查格式，不查内容准确性。验证循环补上这个缺口。

**三角色信息隔离**（隔离是验证可信的前提）：

| 角色 | 可读 | 不可读 | 职责 |
|------|------|--------|------|
| 出题 Agent（B） | 模块源码 | 生成的 wiki 文件 | 从源码找文档没覆盖的点，出题 |
| 答题 Agent（C） | 生成的 wiki 文件 | 模块源码 | 只靠文档闭卷答题 |
| 评分 | B 的题目 + C 的答案 | — | 客观检查 required_facts 覆盖率 |

**执行流程**（对每个模块文件并行）：

1. **出题**：spawn Agent B（用 haiku 弱模型——越弱越能暴露文档真实缺口），读该模块源码，生成 5-8 道验证题。每题包含：
   - `question`：针对该模块一个具体行为/设计的问题
   - `required_facts`：2-5 个可验证事实点，格式 `<函数名> in <文件路径>` 或 `<类型名>.<字段>`
2. **答题**：spawn Agent C（主模型），只读生成的模块 wiki 文件闭卷答题。prompt 明确写入："MUST NOT read any source code files, MUST ONLY read files in the generated wiki directory"，cwd 设为输出目录。
3. **评分**：检查 C 的答案是否覆盖每题的全部 required_facts。覆盖 = PASS，缺任一 = FAIL。
4. **修订**：FAIL 的题目反馈给撰写，修订该模块文件补充缺失内容。

**追加轮条件**：第 1 轮通过率 < 80% 时追加第 2 轮。第 2 轮出题 Agent 追加 3-5 道覆盖未测区域的新题（不只重问失败的题——防止"应试教学"，只补已知漏洞而留盲区）。最多 2 轮，仍未通过的题目在文件中标注"⚠️ 待核实"并告知用户。

**出题 Agent prompt 模板**：

```
你是代码库验证专家。阅读以下模块的源码，为它生成验证题。

仓库路径：{repo_path}
模块路径：{module_path}

请阅读该模块源码，生成 5-8 道验证题，用于检验一份代码解读文档是否全面覆盖了该模块的关键行为。
每题针对一个具体的行为或设计决策（不要出泛泛的"这个模块做什么"类问题）。

每题格式（JSON）：
{
  "question": "具体问题",
  "required_facts": ["<函数名> in <文件路径>", "<类型名>.<字段>"]
}

required_facts 是客观可验证的事实点（如 "calls handleError() in src/hooks/error.ts"），
不是主观判断。答案必须覆盖全部 required_facts 才算通过。

只读源码，不要读任何 *wiki* 或 *codewiki* 目录下的文件。
```

**答题 Agent prompt 模板**：

```
你是闭卷答题者。只阅读以下目录中的 wiki 文件回答问题，不许读源码。

wiki 目录：{output_dir}

问题：
{questions_json}

请基于 wiki 文件内容回答。答案必须引用 wiki 中描述的函数名和文件路径。
如果 wiki 没有覆盖某题的内容，明确回答"文档未覆盖"，不要猜测。

MUST NOT read any source code files. MUST ONLY read files in {output_dir}.
```

**成本控制**：
- 出题 Agent 用 haiku（弱模型，成本低，且"弱模型能发现的缺口就是真缺口"）
- 答题 Agent 用主模型（需要理解文档语义）
- 默认 1 轮；第 2 轮仅在通过率 < 80% 时触发
- 每个模块并行验证，不串行

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

- **Step 3 并行点**：模块分析互不依赖，天然可并行
- **Step 5.5 并行点**：每个模块的验证（出题+答题）互不依赖，可并行
- Step 1-2 必须顺序：需要全局扫描结果才能决定 spawn 几个 Agent、分析哪些模块
- Step 4-6 必须顺序：需要所有 Agent 结果才能综合

### Agent 数量控制

- Step 3：核心模块 3-5 个 + 数据流追踪 1 个 = **4-6 个 Agent**
- Step 5.5：每模块 2 个（出题 B + 答题 C）= **6-10 个 Agent**（并行）
- 如果模块 > 5 个，合并相近模块，控制在 5 个以内
- 单条消息内 spawn 所有 Agent，不要分批

### Agent 结果质量保障

- 每个 Agent 的 prompt 中明确"只读关键文件，不超过 3 个，每个 ≤ 500 行"——避免 Agent 读太多导致返回结果过长
- Agent 返回结构化摘要（6 个固定维度），主会话不需要再读源码
- 如果 Agent 返回的结果不够详细，可以 SendMessage 追问具体细节

### 上下文管理

- Agent 的独立上下文天然解决了大型代码库"读完前面忘后面"的问题
- 主会话只接收各 Agent 的摘要（每个 ~500-1000 字），总增量可控
- Step 5 撰写文章时，所有素材已在上下文中，不需要再读文件

---

## 发布前 checklist

写完逐项核对：

1. 项目定位是否准确？项目边界是否说明（负责什么、不负责什么）？→ 总览 > 项目简介
2. 技术栈是否覆盖语言/框架/核心依赖及用途？→ 总览 > 技术栈
3. 快速上手是否只列最简步骤 + 一个端到端验证？（非完整安装手册）→ 快速上手
4. 代码目录是否只解释一级目录/关键二级/入口/特殊目录，未逐文件注释？→ 代码目录
5. 架构设计解析是否含系统架构（先讲思想 + SVG + 文字描述 + 目录→层映射表）+ 设计模式 + 核心概念（如有）？→ 架构设计解析
6. 运行时行为是否含启动流程（含配置加载与对象装配）+ 核心运行流程（3+ 条主链路 + 介绍段落 + 业务↔代码↔数据流映射）+ 状态流（如有）？→ 运行时行为
7. 每个模块文件是否有模块定位 + 模块架构 + 调用链路（含数据类型标注）+ 核心实现 + 设计模式 + 模块间交互 + 扩展方式？→ 模块文件
8. 模块地图是否有"为什么独立"列 + 依赖关系图？→ 模块地图
9. 典型修改场景是否列出 3 个场景及需改文件？→ 典型修改场景
10. 测试体系是否讲清目录结构 + 分层对应关系？→ 测试体系
11. 阅读源码推荐路线是否规划了 3-4 遍路径？→ 阅读源码推荐路线
12. 附录是否有实质内容（术语表/参考资料/工具推荐）？→ 附录
13. 设计模式是否引用了真实代码位置？→ 架构设计解析 > 设计模式
14. 所有代码块是否标注了文件路径？→ 全文
15. 是否有编造的 API 或函数名？→ 全文（与源码交叉验证，Step 5.5 验证循环已覆盖）
16. SVG 图片是否正常渲染？→ 构建验证
17. frontmatter 字段是否完整？（`title`、`date`、`category`、`description`、`readingTime`、`aiModel`）→ 文件头
18. 验证循环是否执行？未通过的题目是否已修订或标注"待核实"？→ Step 5.5

---

## 合规检查

```bash
bash .skills/vibe-reading-article/scripts/check-article.sh src/pages/articles/_md/<slug>.md
```

Markdown 文章校验项：文件名 kebab-case、frontmatter 必填字段（`title`/`date`/`category`/`description`/`readingTime`/`aiModel`）、不含 `layout:` 行。
