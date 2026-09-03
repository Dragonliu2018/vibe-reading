# 私有 Markdown 文章规范

适用于 `visibility: private`、仅本地 `CONTENT_MODE=private` 构建的文章。排版规范仍遵循 `markdown-style.md`，本节只补充差异。

## 前置

```bash
npm run setup:private    # 首次：克隆私有 Markdown 源到 _private/
npm run dev:private      # 预览公开 + 私有文章
```

私有源在独立 git 仓库中版本维护（嵌套 clone 于 `_private/.git`），**不要**在 vibe-reading 主仓库里 `git add` 该目录。

## 文件位置

根目录：`src/pages/articles/_private/articles/`

**目录路径与 `category` 对齐**（规则同公开 `_md/`，但跳过顶层私有命名空间）：

```
articles/{category[1]}/{category[2]}/.../{slug}.md
```

`category` 首段是侧边栏私有根（如 `Corvus`），**不参与文件路径**。含空格的分类段在路径中用 `-` 替换。

示例：

```yaml
category: [Corvus, AI, "01 基础"]
```

→ `articles/AI/01-基础/01-ai-foundations.md`  
→ URL `/vibe-reading/articles/AI/01-基础/01-ai-foundations`

同一子分类下后续文章继续放在同一目录，保持相同 `category` 前缀。

## Frontmatter（额外必填）

```yaml
visibility: private
comments: false    # 推荐；私有文章默认不应启用 Giscus
```

其余字段（`title` / `date` / `category` / `description` / `readingTime` / `aiModel`）同公开 Markdown。

## 合规检查

```bash
bash .skills/vibe-reading-article/scripts/check-article.sh \
  src/pages/articles/_private/articles/AI/01-基础/01-ai-foundations.md
```

## 发布（版本管理）

```bash
npm run commit:corvus -- <slug>    # 只在私有源仓库 commit，不污染 vibe-reading
npm run push:corvus
```

不要用 `commit-article.sh`（那是公开文章 + 主 repo 流程）。

## 构建

```bash
npm run build:private    # 输出 dist-private/，仅本地使用
```

公开 CI / GitHub Pages 始终 `CONTENT_MODE=public`，不会部署私有内容。
