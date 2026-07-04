# Vibe Reading Article Skill — 验收用例

每条用例标注：输入 → 预期行为 → 验收方式。
新增功能路径时，先在此补用例，再写实现。

---

## Path A：PR / commit 文章（Markdown）

### A-1 基础生成
**输入**：GitHub PR 链接（如 `https://github.com/apache/doris/pull/26133`）  
**预期**：
- 格式选 Markdown
- 加载 `markdown-pr.md` + `markdown-style.md`
- 生成文件名格式 `doris-pr-26133-xxx.md`
- frontmatter 含 `source.prType`（值为 feat/fix/perf/enhancement/refactor 之一）
- 导言含完整 6 字段元信息行，缺失字段填 `-`
- 文章结构符合 10 节模板（必填节存在）

**验收**：`bash scripts/check-article.sh <生成文件>` → exit 0

### A-2 prType 识别
**输入**：修复 bug 的 PR  
**预期**：`source.prType: "fix"`

**输入**：新增功能的 PR  
**预期**：`source.prType: "feat"`

### A-3 关联文章交叉引用
**输入**：已有前序文章的后续 bug fix PR  
**预期**：
- 后续文章导言加 `📎` 提示块，链接到前序文章
- 前序文章在对应 TODO 条目下方加 `> **后续**` 反向链接

---

## Path B：代码库解读（HTML）

### B-1 基础生成
**输入**：GitHub 仓库链接（如 `https://github.com/dbcli/mycli`）  
**预期**：
- 格式选 HTML
- 加载 `content-guide.md`（代码库节）+ `html-style.md`
- 生成文件名 `{name}-architecture.html` 或类似 kebab-case
- HTML 含 `article:category` meta 标签，类别末级为 `Internals`
- 含 `data-pagefind-ignore="all"`
- 文章结构符合代码库推荐节（§1-§12）

**验收**：`bash scripts/check-article.sh <生成文件>` → exit 0

---

## Path C：论文解读（Markdown）

### C-1 基础生成
**输入**：arXiv 论文链接或 PDF  
**预期**：
- 格式选 Markdown
- 加载 `content-guide.md`（论文节）+ `markdown-style.md`
- category 末级为 `Papers`
- 文章结构符合论文推荐节（§1-§8）

**验收**：`bash scripts/check-article.sh <生成文件>` → exit 0

---

## Path D：产品 / 文档介绍（HTML）

### D-1 基础生成
**输入**：产品官网或文档链接  
**预期**：
- 格式选 HTML
- 文章结构符合产品推荐节（§1-§8）
- 含 Hero 区（产品名 + 一句话描述 + 元信息标签）

**验收**：`bash scripts/check-article.sh <生成文件>` → exit 0

---

## check-article.sh 自测

```bash
# A-1：合规文章应通过
bash scripts/check-article.sh ../../src/pages/articles/_md/doris-pr-26133-status-fmt-formatter.md
# 预期：exit 0

# 错误：缺少 prType
bash scripts/check-article.sh /tmp/test-missing-prtype.md
# 预期：exit 1，输出 "PR/commit 文章缺少 source.prType 字段"

# 错误：非法 prType 值
bash scripts/check-article.sh /tmp/test-bad-prtype.md
# 预期：exit 1，输出 "source.prType 值不合法"
```
