#!/usr/bin/env bash
# 把 .skills/ 下的 skill 安装到 ~/.claude/skills/
# 用法：bash .skills/install.sh

set -e
SKILLS_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.claude/skills"

mkdir -p "$TARGET"

for skill_src in "$SKILLS_DIR"/*/; do
  name="$(basename "$skill_src")"
  dest="$TARGET/$name"
  echo "Installing: $name → $dest"
  rm -rf "$dest"
  cp -r "$skill_src" "$dest"
done

echo "Done. Installed skills:"
ls "$TARGET"
