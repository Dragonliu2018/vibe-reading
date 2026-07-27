# 论文解读工作流

把学术论文（arxiv / 会议 / 期刊）解读成博客 Markdown 文章。**区别于转载**：转载是照搬原文，解读是 AI 蒸馏分析——读全文但只输出结构化产物，不堆原文。

`content-guide.md` 论文节给出 `§1-§8` 骨架；本文档补充**人脑方法论映射、10 问 checklist、图与公式的强制规则**。

---

## 人脑方法论 → AI 流水线

论文阅读的人脑方法论（Keshav 三轮法 / 阅读四阶段 / 10 问 / 批判性+创造性 / 50 字摘要 / idea 三法）逐条固化进 AI 流水线：

| 人脑方法 | AI/blog 执行 |
|---|---|
| Keshav Pass1 鸟瞰 + 50 字摘要（目的+手段+结论） | `§1 论文概览` TL;DR 3 句 + 元信息；frontmatter `description` = 50 字摘要 |
| Pass1 的 5 问（类型/相关/假设/贡献/条理） | type→`category`、related→`§2`、contributions→`§1/§3`、assumptions→`§8 局限` |
| Pass2"讲给别人听" | 能讲给别人 = 能写成博客让读者懂 → 产出 `§2-§7` 转译 |
| Pass3 复现式精读 | AI 不真复现，但做"复现级精读"：`§4 公式逐行注释` + `§5 实验设置` + `§6 结果` + `§7 消融`，识别创新与隐含缺陷 |
| 阅读四阶段（passive→active→critical→creative） | AI 内部多遍读，**只输出 critical+creative 的产物**（§1-§8），不把 passive 原文给读者 |
| 10 个问题 | 发布前 checklist（见下），每问落到对应节 |
| 批判性阅读 | `§8 局限性` + 存疑处 `[^err]` 脚注"原文如此，疑为…"；不只夸、不盲信 |
| 创造性阅读 + idea 三法 | `§8 未来工作`用三法落地：弥补缺陷 / 新型方案 / 减少约束 |
| 选材：综述先 / 高引 / 核心期刊 / 牛人组 / 代码可得 | 博客选题：先做综述（领域入口），再解读高引/核心/有开源代码的单篇 |

**一句话**：人脑靠多遍省力，AI 靠蒸馏省力——读多遍但只给 `§1-§8`。

---

## 文章结构 §1-§8

```markdown
> **PDF** <a href="/vibe-reading/papers/{slug}.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Title](arxiv-url) · **作者** xxx · **发表** Venue, 年-月 · **项目** project-url · **解读** YYYY-MM-DD
（单行引用块；**PDF 预览为首字段**（新窗口打开，不强制下载）+ 原论文链接 + 作者 + 发表 + 项目 + 解读日期。无第二行。）

## 1. 论文概览
TL;DR（3 句话）+ 元信息（作者/发表/任务）。一句话点出 take-home。

**末尾放《摘要》折叠块**（`<details>` 默认收起，不占篇幅）：原文 Abstract + `> **译：**` 中文翻译，中英对照。模板：
```html
<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

<原文 abstract 段落>

> **译：** <中文译文>

</details>
```

## 2. 研究背景
问题定义 + 现有方法不足 + 相关工作与关键人物。点出"为什么需要这篇"。

## 3. 方法详解
核心方法，分步骤说明。**必须含论文的架构/原理图（见下图规则）**。

## 4. 关键公式解读
最重要的 2-3 个数学表达，**用 KaTeX 公式（见下公式规则），不要用代码块**。

## 5. 实验设置
数据集 + 基线 + 评价指标 + 复现信息（代码/数据是否可得）。

## 6. 实验结果
主结果 + 关键发现。**必须含主结果图（scaling 曲线 / 主结果表截图，见下图规则）** + 关键数值表。

## 7. 消融实验
各模块贡献分析。用 markdown 表给具体数值；**消融对比曲线 / 关键发现图 / 反直觉证据图按归属放入**（见下图规则）。

## 8. 总结与展望
贡献总结 + 局限性（批判性）+ 未来方向（创造性，用 idea 三法）。
```

---

## 图（强制本地化，禁直连）

- **展示所有重要图，不止原理图**：论文里支撑核心论点 / 关键发现 / 反直觉结论的 Figure 都要抽图本地化放入对应节，不要只放 §3 一张原理图。
- **§3 必须有原理图**（架构/工作流 Figure）——不要只用 ASCII 文字。AI 默认易偷懒只画 ASCII，必须抽真图。
- **§6 必须有主结果图**（scaling 曲线 / 主结果表 / 关键对比）。
- **其他重要图按归属放入对应节**：RQ 证据图、隐空间可视化、消融对比曲线、推理超参曲线、反直觉发现图等——凡是支撑文中某个论点的图都应展示。
- 不搬全文所有图（装饰性 / 重复 / 次要的略过），但**重要的不能省**——宁多勿少，读者看图比看字快。
- **从 PDF 抽图**（PyMuPDF，已验证可用）。核心原则：**clip 紧贴图本身的 bbox，排除 caption 文本与页面装饰线**，否则会把正文/caption/页眉页脚一起框进去。

  **取图三步法**（每张图都走一遍）：

  ```python
  import fitz
  doc = fitz.open('paper.pdf')
  page = doc[i]  # 先用 page.get_text("blocks") 找 "Figure N:" caption 确定页码

  # 第 1 步：定位 caption 的 y 坐标（图在 caption 上方，caption 行是图的天然下界）
  blocks = sorted(page.get_text("blocks"), key=lambda b: b[1])  # 按 y0 排序
  cap_y = None
  for b in blocks:
      if b[4].startswith("Figure ") or b[4].startswith("Table "):
          cap_y = b[1]  # caption 顶边 y
          break

  # 第 2 步：求图区 bbox（三种来源，按优先级取）
  #   (a) 内嵌位图：page.get_images() + get_image_rects() → 位图 bbox 最干净
  #   (b) 矢量图：page.get_drawings() 求所有 drawing rect 的并集
  #   (c) 纯文本表格：直接用 caption 所在 block 的 bbox
  drawings = page.get_drawings()
  if drawings:
      xs0 = min(d['rect'].x0 for d in drawings)
      ys0 = min(d['rect'].y0 for d in drawings)
      xs1 = max(d['rect'].x1 for d in drawings)
      ys1 = max(d['rect'].y1 for d in drawings)
  # 注意：drawings 并集常包含页面顶部/底部的全宽横线（版式装饰），必须剔除

  # 第 3 步：clip = 图 bbox，不延伸到 caption
  pix = page.get_pixmap(matrix=fitz.Matrix(3, 3), clip=fitz.Rect(xs0, ys0, xs1, ys1))
  pix.save('fig-NN-name.png')
  ```

  **关键坑（实测）**：
  - **drawings 并集含页面装饰线**：论文每页顶部常有一条全宽横线（y≈页顶）、底部有页码横线，`get_drawings()` 会把它们算进并集，导致 clip 顶部跑到 y=39 把标题/作者/摘要全框了进去。**必须排除这些装饰线**——要么按 y 范围过滤 drawing（只取正文区 y∈[80, 720]），要么以 caption `y0` 为下界、以正文区起点为上界手算 clip。
  - **clip 底部不能到 caption**：图和它的 caption 之间有空白，clip 底边取图的 `y1`（drawing/image 的最大 y），**不要取 caption 的 y0**——否则会把 caption 首行正文框进图片底部。留 2-5px 余量即可。
  - **表格是纯文本不是图**：Table 的内容是文本 block（无 image/drawing），直接用 caption block 的 bbox `(x0, y0, x1, y1)` 作为 clip，或用 `page.get_text("blocks")` 找到表格首行/末行的 y 范围。不要对表格跑 `get_drawings()`（会取到表格格线但漏掉内容，或取到整页装饰）。
  - **位图优先 `get_images()`**：若图是单张内嵌 PNG/JPG（很多论文的原理图、结果图都是），`page.get_images(full=True)` + `page.get_image_rects(xref)` 直接拿位图 bbox，比 drawings 并集更准、更干净，不会混入装饰线。

  **矩阵缩放**：`Matrix(3, 3)`（3× zoom）输出清晰；`220/72` 偏小。大图可降到 `Matrix(2, 2)`。

- 存放 `public/images/articles/{slug}/fig-NN-{语义名}.png`，引用加 `/vibe-reading` 前缀，**alt = 图注**（Figure N 原文 caption，可中文）。
- 抽不到图（扫描版/加密）时退化为 ASCII，并在该处注明"原图未能抽取"。

---

## 公式（KaTeX，不用代码块）

博客已启用 KaTeX（`remark-math` + `rehype-katex` + `@astrojs/markdown-remark`，CSS 与字体已打包）。**公式必须用 KaTeX 语法，不要用代码块放公式**。

- **行内**：`$p_\psi(z_0)$`、`$z_1 \sim \mathcal{N}(0,I)$`
- **展示（display）**：必须用**多行** `$$`：
  ````markdown
  $$
  \log p(x) \geq \mathbb{E}_{z_0 \sim q_\phi}\!\left[\log p_\theta(x \mid z_0) + \log p_\psi(z_0) - \log q_\phi(z_0 \mid x)\right]
  $$
  ````
  > ⚠️ **单行 `$$...$$` 会被渲染成 inline**（无 `katex-display` 居中块）。display 公式必须 `$$` 独占一行、内容在中间行。
- **逐行注释**用 `\underbrace{}_{\text{…}}` 把公式分段标注（如 ELBO 分解成"重建/压缩/匹配"三段）。
- 常用宏：`\mathbb{E}` `\mathcal{N}` `\mid` `\,\|` `\sum` `\prod` `\nabla` `\partial` `\top` `\ast` `\approx` `\geq` `\leq` `\cdot` `\quad` `\left[…\right]`。
- 行内符号（如 `z0`、`p(x)`）也要用 `$...$`，不要用反引号 `` `z0` `` 包（与公式风格一致）。

---

## 选材

- **先做综述**（survey）做领域入口，再解读单篇。
- 优先：高引、核心期刊/顶会、领军课题组、**有开源代码/数据**（可复现性是 10 问之一）。
- 不解读：纯增量、无清晰 contribution、数据不可得且无复现价值。

---

## 文件命名与 frontmatter

```yaml
---
title: "论文原标题（照搬，不译）"        # 如 Cola: Continuous Latent Diffusion Language Model
source:
  type: "论文解读"                      # 固定；前缀 [project 论文解读] 由 source 自动拼
  project: "Seed"                      # 论文来源机构（Seed / OpenAI / Google / 高校…）
  url: "https://arxiv.org/abs/XXXX.XXXXX"   # 原论文链接（保留）
  pdf: "/vibe-reading/papers/{slug}.pdf"   # 博客本地 PDF 链接（论文解读必填，见下"PDF 本地化"）
date: "YYYY-MM-DD"
category: [AI, Models, Papers]          # 末级 Papers；域按主题（AI/Math/...）
tags: ["论文主题词"]
description: "目的 + 手段 + 结论（50 字摘要，卡片/SEO 用，标题下方引文）"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
reviewed: false                         # 人工校对后改 true（= 温习）
---
```

- **title 放论文原标题**（照搬不译）；前缀 `[project 论文解读]` 由 `source` 字段自动拼，**不要手写前缀进 title**。take-home 放 `description`（渲染为标题下方引文）。
- **`source.type = "论文解读"`**（无 id）：前缀逻辑自动生成 `[<project> 论文解读]`（如 `[Seed 论文解读]`）。project 取论文来源机构。
- **`source.url`** 保留原论文链接（arxiv 等）；**`source.pdf`** 放博客本地 PDF 链接（见下"PDF 本地化"）。arxiv 链接同时放导言 + §1。
- 文件名 `{kebab-slug}.md`（无 id 段）。
- 正文中文，专有名词（模型名、方法名、术语）保留英文原文。

---

## PDF 本地化（强制）

论文解读必须把原 PDF 落到博客，供读者离线/存档下载。按输入分两种获取方式：

```bash
mkdir -p public/papers

# 方式 A：给定论文链接（arxiv 等）→ curl 下载
#   arxiv 摘要页 https://arxiv.org/abs/<id> 对应 PDF https://arxiv.org/pdf/<id>
curl -sL "https://arxiv.org/pdf/<id>" -o public/papers/{slug}.pdf

# 方式 B：给定本地 PDF 路径 → 直接复制
cp /path/to/paper.pdf public/papers/{slug}.pdf
```

- 存放 `public/papers/{slug}.pdf`（slug 与文章文件名一致），URL `/vibe-reading/papers/{slug}.pdf`。
- frontmatter `source.pdf` 填该 URL（论文解读**必填**，check-article.sh 强制校验）；**导言引用块首字段** `**PDF** <a href target="_blank" rel="noopener">预览</a>` 展示预览链接（新窗口打开、浏览器渲染 PDF，**不强制下载**；不在文章 header meta 行）。
- `source.url`（原 arxiv 链接）**保留不动**——本地 PDF 是补充，不替代原链接。
- **保持原文件，不压缩、不抽页**——即使 PDF 很大也原样存放，保证与原文一致。

---

## 发布前 10 问 checklist

写完逐问核对，每问应落到对应节，答不出则补：

1. 讲什么问题？（input/output）→ §2
2. 问题性质？新问题？重要性？→ §2
3. 证明什么假设？→ §2/§3
4. 相关研究与关键人物？→ §2
5. 核心贡献？→ §1/§3
6. 实验如何设计？→ §5
7. 数据集是什么？代码/数据可得？→ §5
8. 结果是否支撑假设？→ §6
9. 贡献总结？→ §1/§8
10. 下一步能做什么？→ §8（创造性，idea 三法）

---

## 合规检查

```bash
bash .skills/vibe-reading-article/scripts/check-article.sh <file>
```

`category` 末级 `Papers`、无 `source` 字段均不触发必填校验，可正常通过。
