#!/usr/bin/env bash
# 文章合规检查
# Usage: bash check-article.sh <file>
# Exit:  0 = 通过，1 = 失败（输出具体错误）

FILE="$1"
ERRORS=()
WARNS=()

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

  # 2. YAML frontmatter 解析校验（防止引号/缩进等语法错误导致 astro build 失败）
  #    check-article 的 grep 字段检查不验证 YAML 语法，需真正解析才能捕获
  #    如标题内部含 ASCII " 会被当成字符串结束符，grep 查得到字段但 build 会炸
  PROJECT_ROOT="$(cd "$(dirname "$FILE")" && pwd)"
  while [[ "$PROJECT_ROOT" != "/" && ! -d "$PROJECT_ROOT/node_modules/js-yaml" ]]; do
    PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"
  done
  if [[ -d "$PROJECT_ROOT/node_modules/js-yaml" ]]; then
    # 提取 frontmatter 块（第一个 --- 到第二个 --- 之间，含中文弯引号也安全）
    FM_CONTENT=$(awk 'BEGIN{c=0} /^---[[:space:]]*$/{c++; if(c==2) exit; next} c==1' "$FILE")
    if [[ -n "$FM_CONTENT" ]]; then
      YAML_ERR=$(JSYAML="$PROJECT_ROOT/node_modules/js-yaml" node -e '
const yaml = require(process.env.JSYAML);
let d = ""; process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  let fm;
  try { fm = yaml.load(d); }
  catch(e) { console.error(e.message); process.exit(1); }
  // alsoCategories 默认不加；仅当显式指定时才校验须为 string[][]（分类路径数组的列表，主分类决定文件位置、副分类仅做树引用）
  if (fm && fm.alsoCategories !== undefined && fm.alsoCategories !== null) {
    const ac = fm.alsoCategories;
    if (!Array.isArray(ac) || ac.some(g => !Array.isArray(g) || g.length === 0 || g.some(s => typeof s !== "string" || s === "")))
      console.error("alsoCategories 须为分类路径数组的列表（string[][]），每项是非空字符串数组");
  }
});' <<< "$FM_CONTENT" 2>&1)
      if [[ -n "$YAML_ERR" ]]; then
        ERRORS+=("frontmatter 校验失败: $YAML_ERR")
      fi
    fi
  fi

  # 3. 必填 frontmatter 字段
  for field in title date category description readingTime aiModel; do
    if ! grep -qE "^${field}:" "$FILE"; then
      ERRORS+=("frontmatter 缺少字段: $field")
    fi
  done

  # 3b. 私有文章额外约束
  if [[ "$FILE" == *"/_private/"* ]]; then
    if ! grep -qE '^visibility:[[:space:]]*private[[:space:]]*$' "$FILE"; then
      ERRORS+=("私有文章必须声明 visibility: private")
    fi
  fi

  # 3. source 字段完整性
  if grep -qE '^source:' "$FILE"; then
    # 先提取 source.type，据此决定哪些子字段必填
    SRC_TYPE=$(grep -E '^\s+type:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')

    # type 子字段对所有 source 类型必填
    if [[ -z "$SRC_TYPE" ]]; then
      ERRORS+=("source 缺少子字段: type")
    fi

    # 4. PR/commit 类型：project / id / prType 必填，且文件命名须含 {project}-{type}-{id}- 前缀
    if [[ "$SRC_TYPE" == "PR" || "$SRC_TYPE" == "commit" ]]; then
      for sf in project id; do
        if ! grep -qE "^  ${sf}:" "$FILE"; then
          ERRORS+=("source 缺少子字段: $sf（$SRC_TYPE 类型必填）")
        fi
      done

      if ! grep -qE '^\s+prType:' "$FILE"; then
        ERRORS+=("PR/commit 文章缺少 source.prType 字段")
      else
        PR_TYPE=$(grep -E '^\s+prType:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
        if ! echo "$PR_TYPE" | grep -qE '^(feat|perf|enhancement|fix|refactor)$'; then
          ERRORS+=("source.prType 值不合法: '$PR_TYPE'（允许: feat|perf|enhancement|fix|refactor）")
        fi
      fi

      # 5. PR/commit 文件命名格式：{project}-{type}-{id}-*.md
      SRC_PROJECT=$(grep -E '^\s+project:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' | tr '[:upper:]' '[:lower:]')
      SRC_ID=$(grep -E '^\s+id:' "$FILE" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
      TYPE_LOWER=$(echo "$SRC_TYPE" | tr '[:upper:]' '[:lower:]')
      EXPECTED_PREFIX="${SRC_PROJECT}-${TYPE_LOWER}-${SRC_ID}-"
      if ! echo "$BASENAME" | grep -qi "^${EXPECTED_PREFIX}"; then
        ERRORS+=("文件命名应以 '${EXPECTED_PREFIX}' 开头，当前: $BASENAME")
      fi
    fi
    # 论文解读类型：pdf 必填（博客本地 PDF 链接，见 references/paper-workflow.md）
    if [[ "$SRC_TYPE" == "论文解读" ]]; then
      if ! grep -qE '^\s+pdf:' "$FILE"; then
        ERRORS+=("source 缺少子字段: pdf（论文解读类型必填，博客本地 PDF 链接）")
      fi
    fi
    # article 类型（转载）：仅要求 type，不要求 project/id/prType，文件名 kebab-case 自由命名（见 references/markdown-repost.md）
  fi

  # 6. 不含 layout: 行
  if grep -qE '^layout:' "$FILE"; then
    ERRORS+=("frontmatter 不应包含 layout: 行")
  fi

  # 7. 目录路径与 category 对齐（仅检查 _md/ 下的子目录文件，不检查 flat 文件）
  #    规则：文件所在目录路径应以 category 用 / 拼接为前缀
  #    单文件：_md/{category_path}/{slug}.md        → 目录 = category_path
  #    多文件：_md/{category_path}/{slug}/00-xx.md   → 目录 = category_path/{slug}（多一层 slug）
  MD_ROOT="$(cd "$(dirname "$FILE")" && pwd)"
  # 找到 _md 根目录的相对路径
  REL_PATH="${MD_ROOT#*/_md/}"
  if [[ "$REL_PATH" != "$MD_ROOT" ]]; then
    # 文件在 _md/ 的子目录中，检查路径是否以 category 开头
    CATEGORY_LINE=$(grep -E '^category:' "$FILE" | head -1)
    # 提取 category 数组，去掉方括号和引号，用 / 拼接
    # 注意：元素可能含空格（如 "AI Coding"），只去引号和逗号后空格，保留元素内部空格
    CATEGORY_PATH=$(echo "$CATEGORY_LINE" \
      | sed 's/^category: *\[//' \
      | sed 's/\] *$//' \
      | sed 's/"//g' \
      | sed 's:/:-:g' \
      | sed 's/, */\//g' \
      | tr ' ' '-')
    if [[ -n "$CATEGORY_PATH" ]]; then
      # 目录路径应等于 category_path 或 category_path/{slug}（多一层）
      if [[ "$REL_PATH" != "$CATEGORY_PATH" ]] && [[ "$REL_PATH" != "$CATEGORY_PATH"/* ]]; then
        ERRORS+=("目录路径 '$REL_PATH' 不以 category '$CATEGORY_PATH' 为前缀（目录应 = category 用 / 拼接，可多一层 slug）")
      fi
    fi
  fi

  # 8. 相关阅读章节软校验（warn 不 fail）
  #    论文解读/PR/commit/article 类型文章末尾应有「## 相关阅读」章节
  if [[ -n "$SRC_TYPE" ]]; then
    case "$SRC_TYPE" in
      论文解读|PR|commit|article)
        if ! grep -qE '^##[[:space:]]+相关阅读' "$FILE"; then
          WARNS+=("$SRC_TYPE 类型文章建议在末尾加「## 相关阅读」章节（关联博客内其他相关文章，见 content-guide.md）")
        fi
        ;;
    esac
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
  for w in "${WARNS[@]}"; do
    echo "  ⚠ $w"
  done
  exit 0
else
  echo "✗ 检查失败: $FILE"
  for err in "${ERRORS[@]}"; do
    echo "  · $err"
  done
  for w in "${WARNS[@]}"; do
    echo "  ⚠ $w"
  done
  exit 1
fi
