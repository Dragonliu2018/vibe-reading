#!/usr/bin/env bash
# commit-article.sh <slug> — 精确 add 一篇文章的 md + 图 + PDF，子仓库 + 主 repo commit。
#
# 多 session 并发写作方案（替代 worktree）：
#   都在主 repo main 工作区写不同 slug，用此脚本精确 commit 自己的（不用 git add -A）。
#   根因治的是 `git add -A` 误收对方文件——本脚本只 add <slug> 路径。
#   不开分支（无 checkout 切走）、子仓库 commit 落主 .git/modules（不丢）、主 repo dev 4321 共享预览。
#
# Usage: 在主 repo 根执行
#   bash .skills/vibe-reading-article/scripts/commit-article.sh <slug>
#   # push 人工（脚本只到 commit）：
#   #   cd public/images && git push origin HEAD:main   # 图子仓库
#   #   cd public/papers && git push origin HEAD:main   # PDF 子仓库
#   #   git pull --rebase origin main && git push origin main
set -euo pipefail

SLUG="${1:-}"
[[ -z "$SLUG" ]] && { echo "ERROR: 未指定 slug。Usage: bash commit-article.sh <slug>" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

# ── 找文章 md（glob，slug 可能在分类子目录）─────────────
MD=$(find src/pages/articles/_md -name "*${SLUG}*.md" -type f | head -1)
if [[ -z "$MD" ]]; then
  echo "ERROR: 找不到文章 *${SLUG}*.md（确认 slug 拼写）" >&2
  exit 1
fi
echo "▶ 文章: $MD"

# ── 子仓库 commit 图（public/images/articles/<slug>/）────
SUB_IMG=public/images
if [[ -d "$SUB_IMG/articles/$SLUG" ]] && (cd "$SUB_IMG" && git status --porcelain "articles/$SLUG/" | grep -q .); then
  echo "▶ 子仓库 commit 图"
  (cd "$SUB_IMG" && git add "articles/$SLUG/" && git commit -m "add $SLUG figs" 2>&1 | tail -1)
else
  echo "▶ 无图改动，跳过 public/images"
fi

# ── 子仓库 commit PDF（public/papers/<slug>.pdf）─────────
SUB_PDF=public/papers
if [[ -f "$SUB_PDF/$SLUG.pdf" ]] && (cd "$SUB_PDF" && git status --porcelain "$SLUG.pdf" | grep -q .); then
  echo "▶ 子仓库 commit PDF"
  (cd "$SUB_PDF" && git add "$SLUG.pdf" && git commit -m "add $SLUG pdf" 2>&1 | tail -1)
else
  echo "▶ 无 PDF 改动，跳过 public/papers"
fi

# ── 主 repo commit 文章 + 子仓库指针 ───────────────────
echo "▶ 主 repo commit"
git add "$MD" public/images public/papers
git commit -m "blog: $SLUG

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" 2>&1 | tail -2

echo
echo "✓ 完成。本次 commit："
git show --stat HEAD | head -10
echo
echo "后续 push（人工触发，多 session 撞了加 --rebase）："
echo "  cd $SUB_IMG && git push origin HEAD:main   # 图子仓库"
echo "  cd $SUB_PDF && git push origin HEAD:main   # PDF 子仓库（若有）"
echo "  git pull --rebase origin main && git push origin main   # 主 repo"
