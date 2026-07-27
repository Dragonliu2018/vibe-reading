# 技术文章转载规范

适用于给定外部技术文章链接（个人博客 / 知乎 / 公众号 / 掘金 / 网站），**完整转载**到博客 Markdown。

与 PR 解读、论文解读不同——转载是**照搬原文**，不解读、不改写、不摘要。

---

## 触发条件

用户提供一个文章 URL，要求"转载 / 搬运 / 迁移到博客"。

---

## 核心原则

- **完全照搬原文**：标题层级、段落、代码块、列表、引用、表格结构保持原样，不改写、不二次创作、不摘要、不补充。
- **作者署名**：frontmatter 记录原作者 + 原文链接 + 来源平台，尊重来源。

### 例外（可处理，不算改造）

| 类型 | 处理 |
|---|---|
| 广告、页脚导航、"推荐阅读"、版权声明、二维码、"关注公众号"、打赏码等与正文无关的噪声 | **删除** |
| 明显的事实性错误（笔误/错字/拼错的 API 名） | **保留原文**，在该处加 `[^err]` 脚注标注 `[^err]: 原文如此，疑为 XXX`，不直接删改原文 |
| 原文已失效的内链 / 锚点 | 保留文本，链接可去除或指向原文 |
| 代码块语言未标注 | 补 `title=` 与语言标识（这是排版，非内容改造） |

> 判定边界：只动"与文章主体无关的噪声"和"标注错误"，不动作者的观点、论证、代码逻辑。拿不准是否该删时，**保留**。

---

## 抓取源材料

按站点类型选工具：

| 来源 | 工具 | 说明 |
|---|---|---|
| 普通博客 / 文档站 / 网站 | `WebFetch` | 多数静态博客可直接抓正文 |
| 知乎专栏 / 公众号 / 掘金 / 需 JS 渲染或反爬站点 | `agent-browser` | 公众号见下；**知乎见「知乎反爬」小节，必须注入 stealth** |

抓取目标：**正文 DOM**（剔除导航/侧栏/评论/广告），保留：标题层级、代码块（含语言）、有序/无序列表、引用块、表格、图片 URL、alt 文本。

### 公众号

`agent-browser open <url> --headed`（或 curl 带 UA 直接抓 HTML），正文在 `<div id="js_content">`，图片真实 URL 在 `data-src`。常需滚动加载。

### 知乎反爬（必须注入 stealth init script）

知乎检测 `navigator.webdriver`，未注入时返回 40362「请求异常」风控页——`curl` / `WebFetch` / 知乎 `/api/articles/` 直连均被拦（即使带登录 cookie）。必须用 agent-browser `--init-script` 注入 stealth script（移除 webdriver 标记）+ 登录态：

```bash
# 1. 写 stealth.js（移除 navigator.webdriver 等自动化标记）
cat > /tmp/stealth.js << 'JS'
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
JS

# 2. 首次需登录（扫码，cookie 持久化到 ~/.agent-browser/default/，以后免登）
agent-browser open "https://www.zhihu.com/signin" --headed   # 用户在窗口扫码

# 3. 带 stealth + 登录态抓文章（--init-script 在页面加载前注入，绕过 zse-ck 检测）
agent-browser --init-script /tmp/stealth.js open "https://zhuanlan.zhihu.com/p/ID" --headed
agent-browser eval "document.querySelector('.Post-RichText')?.innerHTML"   # 正文 HTML
```

stealth 方案参考 [handsomestWei/zhihu-fetch-skill](https://github.com/handsomestWei/zhihu-fetch-skill)。知乎正文里的「知识卡片」链接（`zhida.zhihu.com/search?...`）是知乎自动加的噪声，按「例外」规则去链接保留文本。

---

## 图片（强制本地化）

照 `markdown-style.md` 的图片规范执行，**禁直连远程 URL**：

```bash
mkdir -p public/images/articles/{slug}
curl -sL "{原文图片 URL}" -o public/images/articles/{slug}/{语义名}.png
```

> `public/images` 是 submodule（`vibe-reading-images`）。下图后需子仓库 commit+push + 主 repo 记指针——**推荐用 `npm run add-image -- {slug} {url1} [url2 ...]` 脚本自动化**（反爬站点手动下后用 `--commit-only`），详见 `markdown-style.md` 图片节。

- 原文所有图片（含图床/CDN/GitHub assets/知乎图片）一律下载到 `public/images/articles/{slug}/`。
- 文件名用语义名（`arch.png`、`flow-1.png`、`result-table.png`），不用哈希乱码名。
- **图注作为 alt，不单独成段**：原文图片下方的图注文字（如「图 1-1 rowset 版本」）作为该图片 `alt`，渲染时自动显示为图注并居中（见 `markdown-style.md` 图注与居中）；**不要**在 markdown 里再单独写一行图注，否则重复。原文本有 alt 则保留，无则用原图注文字补；装饰性图片（头图等）用空 alt。
- 引用加 `/vibe-reading` base 前缀：
  ```markdown
  ![架构图](/vibe-reading/images/articles/{slug}/arch.png)
  ```

---

## Frontmatter

```yaml
---
title: "原文标题（照搬，不重写）"
source:
  type: "article"            # 固定 article，表示转载
  project: "项目名"          # 如 Doris / StarRocks；用于标题前缀 [project 来源] 和文件名
  url: "https://原文链接"
  author: "原作者名 / 账号"
  site: "来源平台（知乎 / 公众号 / 个人博客名 / 掘金）"
date: "YYYY-MM-DD"            # 转载日期
category: [Domain, Topic, Official]   # 官方转载用 Official，非官方博客用 Informal
tags: ["原文标签或主题词"]
description: "一句话概括，可引用原文导言首句"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
reviewed: false
---
```

- `source.type = "article"`：转载类，不需要 `prType`（区别于 PR/commit）。
- `category` 末级按来源：官方文章用 `Official`，非官方技术博客用 `Informal`；前两层反映原文主题域（如 `[Database, Apache Doris, Official]`）。转载标记由 `source.type=article` 负责，末级只反映来源。
- **标题前缀**：转载文章标题自动渲染为 `[project 来源]` 前缀（如 `[Doris Official]`）——project 取 `source.project`，来源取 category 末级。与 PR 文章的 `[project type-id]` 前缀对应。
- `reviewed: false`：转载初稿同样默认未 review，人工校对后改 `true`。

---

## 导言

转载文章必须标注来源（区别于原创），在 frontmatter 后、第一节前：

```markdown
> **原文** [标题](url) · **作者** xxx · **来源** 知乎/公众号 · **转载** 2026-07-24

---

## 原文第一节
```

---

## 文件命名

`{project}-{来源}-{slug}.md` 格式：project 取 `source.project`，来源取 category 末级小写（`official` / `informal`）。article 无编号，故无 id 段。

示例：`source.project = Doris`、category 末级 `Official` → `doris-official-compaction-mechanism.md`。

---

## 合规检查

```bash
bash .skills/vibe-reading-article/scripts/check-article.sh <file>
```

`source.type=article` 不触发 `prType` 必填校验（check-article 仅对 PR/commit 要求 prType），可正常通过。

---

## 长度

照搬原文，长度不限。原文超长（如万字教程）优先单篇完整；确需分篇时按原文章节边界切，每篇独立 slug + 互相在导言链接。

---

## 英文文章转载（中英对照）

原文为英文时，默认采用**中英对照**：保留原文段落，紧跟中文译文，读者可对照。既忠实原文（不替换、不删原文），又对中文读者友好。

### 标题

- `frontmatter.title` 用**原文英文标题**（照搬，不翻译；与 `source.url` 原文一致）。**不要把副标题塞进 title**。
- 若原文带副标题（如 Substack 的 subtitle 字段），放入 `description` 字段——ArticleLayout 会把 `description` 渲染为标题下方的 `.article-desc` 引文段，作为副标题展示。注意取页面当前**可见**副标题，而非可能滞后的 SEO meta description。
- 正文 `##` / `###` / `####` 标题用**原文英文**（照搬，不翻译；TOC 显示英文）。
- 导言标注原文标题（见下）；正文各节直接用原文标题，不另起中文译名。

### 段落对照格式

每段原文后紧跟译文段，译文用引用块 + `**译：**` 前缀区分：

```markdown
Original English paragraph here.

> **译：** 中文译文段落。

Next original paragraph.

> **译：** 下一段译文。
```

### 代码块 / 图片 / 表格

- **只出现一次**，在原文位置，**不翻译、不重复**。代码块、图片、表格前后若有原文段，各自配译文段；代码/图本身保持原样。
- 图片照常本地化（见上文"图片"节），alt 保留原文 caption（图注即原文，不翻译）。
- 代码块保留原文注释；如需译代码注释，在注释行内用 `// 译：…` 行尾补，不改原文注释。

### 列表 / 引用块

原文为列表或引用块时，整体保留原文结构，紧跟译文（同样用 `> **译：**` 前缀，列表译文保持同结构）。

### 导言

```markdown
> **原文** [Original Title](url) · **作者** xxx · **来源** 官方文档/博客 · **中英对照·AI 译** 2026-07-25
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

## Original English Section Heading (First Section)
```

### Frontmatter

与普通转载一致，`source.type=article`；`title` 用原文英文标题（照搬不译，不含副标题）；`description` 优先放原文副标题（渲染为标题下方引文），无副标题时用中文概括。`reviewed: false`——翻译更需人工校，校对通过后改 `true`。

### 翻译原则

- **忠实原文**：不意译、不增删、不二次创作；术语统一（首次出现可 `中文（English）` 标注）。
- **代码/命令/路径/配置项不翻译**，保留英文。
- **明显错误**照"核心原则·例外"处理（原文保留 + `[^err]` 脚注），译文照译并在脚注同步说明。

### 长度

中英对照篇幅约为原文 2 倍，可接受。原文超长时分篇切，每篇独立 slug + 导言互链。

