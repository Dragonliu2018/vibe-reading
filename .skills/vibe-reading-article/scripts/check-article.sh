#!/usr/bin/env bash
# 文章合规检查
# Usage: bash check-article.sh <file>
# Exit:  0 = 通过，1 = 失败（输出具体错误）

FILE="$1"
ERRORS=()

# ── 基础检查 ──────────────────────────────────────────────────────
[[ -z "$FILE" ]] && { echo "ERROR: 未指定文件" >&2; exit 1; }
[[ ! -f "$FILE" ]] && { echo "ERROR: 文件不存在: $FILE" >&2; exit 1; }

EXT="${FILE##*.}"

# ── Markdown 文章检查 ──────────────────────────────────────────────
if [[ "$EXT" == "md" ]]; then
  BASENAME=$(basename "$FILE")

  # 1. 文件命名：kebab-case，仅小写字母/数字/连字符
  if ! echo "$BASENAME" | grep -qE '^[a-z0-9-]+\.md$'; then
    ERRORS+=("文件命名不符合 kebab-case: $BASENAME")
  fi

  # 2. 必填 frontmatter 字段
  for field in title date category description readingTime aiModel; do
    if ! grep -qE "^${field}:" "$FILE"; then
      ERRORS+=("frontmatter 缺少字段: $field")
    fi
  done

  # 3. source 字段完整性
  if grep -qE '^source:' "$FILE"; then
    for sf in project type id; do
      if ! grep -qE "^  ${sf}:" "$FILE"; then
        ERRORS+=("source 缺少子字段: $sf")
      fi
    done

    # 4. prType 合规（PR/commit 时必填）
    SRC_TYPE=$(grep -E '^\s+type:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
    if [[ "$SRC_TYPE" == "PR" || "$SRC_TYPE" == "commit" ]]; then
      if ! grep -qE '^\s+prType:' "$FILE"; then
        ERRORS+=("PR/commit 文章缺少 source.prType 字段")
      else
        PR_TYPE=$(grep -E '^\s+prType:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
        if ! echo "$PR_TYPE" | grep -qE '^(feat|perf|enhancement|fix|refactor)$'; then
          ERRORS+=("source.prType 值不合法: '$PR_TYPE'（允许: feat|perf|enhancement|fix|refactor）")
        fi
      fi
    fi

    # 5. PR 文章文件命名格式：{project}-{type}-{id}-*.md
    SRC_PROJECT=$(grep -E '^\s+project:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' | tr '[:upper:]' '[:lower:]')
    SRC_ID=$(grep -E '^\s+id:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
    TYPE_LOWER=$(echo "$SRC_TYPE" | tr '[:upper:]' '[:lower:]')
    EXPECTED_PREFIX="${SRC_PROJECT}-${TYPE_LOWER}-${SRC_ID}-"
    if ! echo "$BASENAME" | grep -qi "^${EXPECTED_PREFIX}"; then
      ERRORS+=("文件命名应以 '${EXPECTED_PREFIX}' 开头，当前: $BASENAME")
    fi
  fi

  # 6. 不含 layout: 行
  if grep -qE '^layout:' "$FILE"; then
    ERRORS+=("frontmatter 不应包含 layout: 行")
  fi

# ── HTML 文章检查 ──────────────────────────────────────────────────
elif [[ "$EXT" == "html" ]]; then
  for meta in "article:category" "article:date" "article:readingTime"; do
    if ! grep -q "name=\"${meta}\"" "$FILE"; then
      ERRORS+=("HTML 缺少 meta 标签: $meta")
    fi
  done

  if ! grep -q 'data-pagefind-ignore' "$FILE"; then
    ERRORS+=("HTML <html> 标签缺少 data-pagefind-ignore=\"all\"")
  fi
fi

# ── 结果输出 ──────────────────────────────────────────────────────
if [[ ${#ERRORS[@]} -eq 0 ]]; then
  echo "✓ 检查通过: $FILE"
  exit 0
else
  echo "✗ 检查失败: $FILE"
  for err in "${ERRORS[@]}"; do
    echo "  · $err"
  done
  exit 1
fi
