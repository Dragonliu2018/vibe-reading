# Skills

存储 Vibe Reading 项目配套的 Claude Code skills。

## 安装（新机器 / 首次设置）

```bash
bash .skills/install.sh
```

将 `.skills/` 下所有 skill 复制到 `~/.claude/skills/`，Claude Code 立即可用。

## 更新 skill 的工作流

**先改 repo，后同步到本地**（有 git 记录）：

```bash
# 1. 编辑 repo 中的 skill 文件
vim .skills/vibe-reading-article/SKILL.md
vim .skills/vibe-reading-article/references/content-guide.md
# ...

# 2. 同步到本地 Claude（使 skill 立即生效）
bash .skills/install.sh

# 3. 提交
git add .skills/
git commit -m "update skill: ..."
git push
```

## Skill 列表

| Skill | 触发场景 |
|---|---|
| `vibe-reading-article` | 基于代码库/论文/文档写技术文章，发布到博客 |
