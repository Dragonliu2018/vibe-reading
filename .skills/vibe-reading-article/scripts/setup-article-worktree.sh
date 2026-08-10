#!/usr/bin/env bash
# 为一篇博客文章建独立 git worktree（多 session 并发写作隔离）。
# 解决：单工作区多 session 开分支会互相切走 checkout（git 工作区单实例）。
# worktree 物理隔离——独立工作区 + 独立分支，连 git add -A 都不会误收对方文件。
#
# Usage: 在 vibe-reading repo 根执行
#   bash .skills/vibe-reading-article/scripts/setup-article-worktree.sh <slug>
# 产出: ../vibe-reading-<slug>（article/<slug> 分支 + symlink node_modules + init submodule）
# 进入后开始写：cd ../vibe-reading-<slug>
set -euo pipefail

SLUG="${1:-}"
[[ -z "$SLUG" ]] && { echo "ERROR: 未指定 slug。Usage: bash setup-article-worktree.sh <slug>" >&2; exit 1; }

# 检测 cwd 是 vibe-reading repo 根
if [[ ! -f "astro.config.mjs" || ! -d ".git" ]]; then
  echo "ERROR: 请在 vibe-reading repo 根执行（cwd 需有 astro.config.mjs + .git）" >&2
  exit 1
fi

REPO="$(pwd)"
WT="$REPO/../vibe-reading-$SLUG"
BRANCH="article/$SLUG"

# 幂等：已存在则提示
if [[ -d "$WT" ]]; then
  echo "worktree 已存在: $WT"
  echo "进入: cd \"$WT\""
  exit 0
fi

echo "▶ 建 worktree: $WT (分支 $BRANCH)"
git worktree add "$WT" -b "$BRANCH"

echo "▶ symlink node_modules（共享主 repo，不重装 210M）"
ln -s "$REPO/node_modules" "$WT/node_modules"

echo "▶ init public/images submodule（--reference 复用主 repo 对象，不重下）"
(cd "$WT" && git submodule update --init --reference "$REPO/public/images" public/images)

echo ""
echo "✓ worktree 就绪。进入开始写："
echo "  cd \"$WT\""
echo ""
echo "写完后收尾（在主 repo 根执行）："
echo "  bash .skills/vibe-reading-article/scripts/finish-article-worktree.sh $SLUG"
