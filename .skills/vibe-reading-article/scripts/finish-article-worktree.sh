#!/usr/bin/env bash
# 准备一篇博客文章 worktree 的收尾：暂存改动 + 显示状态 + 打印 commit/push/clean 指引。
# 不自动 commit / push / clean——这些写操作由人工确认执行。
#   （主 repo 和子 repo 都不在脚本里 push；commit 需人工确认。）
#
# Usage: 在 vibe-reading repo 根执行
#   bash .skills/vibe-reading-article/scripts/finish-article-worktree.sh <slug>
set -euo pipefail

SLUG="${1:-}"
[[ -z "$SLUG" ]] && { echo "ERROR: 未指定 slug。Usage: bash finish-article-worktree.sh <slug>" >&2; exit 1; }

if [[ ! -f "astro.config.mjs" || ! -d ".git" ]]; then
  echo "ERROR: 请在 vibe-reading repo 根执行（cwd 需有 astro.config.mjs + .git）" >&2
  exit 1
fi

REPO="$(pwd)"
WT="$REPO/../vibe-reading-$SLUG"
BRANCH="article/$SLUG"
SUB_DIR="$WT/public/images"

[[ ! -d "$WT" ]] && { echo "ERROR: worktree 不存在: $WT" >&2; exit 1; }

# ── 1. 暂存 submodule（只 add，不 commit）─────────────────
echo "▶ 1. 暂存 submodule（public/images/articles/$SLUG/）"
if (cd "$SUB_DIR" && git status --porcelain "articles/$SLUG/" | grep -q .); then
  (cd "$SUB_DIR" && git add "articles/$SLUG/")
  echo "  已暂存。改动："
  (cd "$SUB_DIR" && git status --short "articles/$SLUG/" | sed 's/^/    /')
else
  echo "  无 SVG 改动，跳过"
fi

# ── 2. 暂存主 repo（文章 + submodule 指针，只 add）─────────
echo "▶ 2. 暂存主 repo（src/pages/articles/_md/ + public/images 指针）"
(cd "$WT" && git add src/pages/articles/_md/ public/images)
echo "  已暂存。改动："
(cd "$WT" && git status --short | sed 's/^/    /')

# ── 3. 打印人工执行指引 ───────────────────────────────────
cat <<EOF

──────── 收尾指引（人工确认后执行，不 push）────────

# A. submodule commit（本地，不 push）
cd "$SUB_DIR"
git diff --cached --stat
git commit -m "add $SLUG svg"

# B. 主 repo commit + merge 到本地 main（不 push）
cd "$WT"
git diff --cached --stat
git commit -m "blog: $SLUG"
cd "$REPO"
git checkout main                 # 约定主 repo 在 main，no-op
git merge "$BRANCH"               # ff 或 3-way，不同 slug 文件无冲突

# C. 清理（merge 后 commit 在 main 可达，安全删）
git worktree remove --force "$WT"
git branch -d "$BRANCH"           # 小写 -d：未 merge 拒删，防丢 commit

# 后续人工 push（发布时）：submodule 先 push，再主 repo push
#   cd "$SUB_DIR" && git push origin HEAD:main
#   cd "$REPO"    && git push origin main

────────
EOF

echo "注：A 在 B 前（submodule 先 commit，主 repo 指针才指向新 submodule commit）；"
echo "    C 用小写 -d，未 merge 会拒删，防丢 commit。"
echo "    后续 push 人工触发，顺序自定（主 repo 指针指向本地 submodule commit，本地一致即可）。"
