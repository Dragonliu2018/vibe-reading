# PR / Commit 文章规范

适用于 `source.type` 为 `PR` / `commit` / `Issue` 的 Markdown 文章。

---

## category 选择

- **自己写的 PR / commit** → category 末级用 `Contributions`
- **解读他人的 PR / commit** → category 末级用 `Internals`

两种情况使用相同的 `source` 字段结构和 10 节文章模板，区别仅在 category。

---

## 文件命名

格式：`{project}-{type}-{id}-{slug}.md`

示例：`doris-pr-26133-status-fmt-formatter.md`

`{project}`、`{type}` 均小写；`{slug}` 简短英文描述，用 `-` 分隔。

---

## Frontmatter

```yaml
---
title: "文章标题（不要重复 source 信息）"
source:
  project: "Doris"          # 项目名
  type: "PR"                # PR / Issue / commit / RFC / arxiv
  id: "26133"               # 编号
  url: "https://..."        # 原始链接（可选）
  prType: "feat"            # feat / perf / enhancement / fix / refactor（仅 PR/commit）
date: "YYYY-MM-DD"
category: [Domain, Project, Contributions]
tags: ["Tag1", "Tag2"]
description: "一句话描述"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
---
```

**title 规则**：UI 自动拼接为 `[Doris PR-26133] feat: title`，因此 title 字段**不要**写 project 名或 PR 编号前缀。

---

## 导言元信息

```markdown
> **PR** [#26133](url) · **Issue** [#25974](url) · **commit** [67f1ae8](url) · **首发版本** 2.0.4 · **变更行数** +24 行 · **合并时间** 2023-11-01
```

**所有字段必须出现**，取不到值时用 `-` 占位。

| 字段 | 来源 |
|---|---|
| `PR` | PR 编号 + URL |
| `Issue` | PR body 中的 `Closes #XXXXX` / `Fix #XXXXX`；找不到填 `-` |
| `commit` | PR 页面底部 "merged commit `xxxxxxx` into `owner:master`" 的 hash；找不到填 `-` |
| `首发版本` | Labels 中 `dev/x.x.x-merged` 去掉前缀；多个时 `小版本 / 大版本`；找不到跑 `git tag --contains <hash> \| sort -V \| head -1`；仍无则填 `-` |
| `变更行数` | commit `--stat` 最后一行的 `+N`；找不到填 `-` |
| `合并时间` | PR merge 时间，格式 `YYYY-MM-DD`；找不到填 `-` |

---

## 关联文章（跨文章交叉引用）

**后序文章**（如 bug fix）在导言元信息后、`---` 前插入：

```markdown
> 📎 本文是 [前序文章标题](/vibe-reading/articles/{slug}) 的后续修复，建议先阅读原文。
```

**前序文章**反向关联：
- 有 `## TODO` 且该条目正是后续 PR 所解决 → 在对应 TODO 条目正下方加
- 无 TODO / 一般性跟进 → 在 `## 意义与影响` 末尾加

```markdown
> **后续**：... [PR #XXXXX](url) 修复了这一场景，详见[文章标题](/vibe-reading/articles/{slug})。
```

**锚点规则**：引用整篇文章不加锚点；明确指向某节（如 TODO）加 `#todo`。

---

## 文章模板（10 节）

| # | 章节 | 必填 | 说明 |
|---|------|------|------|
| 1 | 背景 | ✅ | 问题定性描述；引用 Issue；**不放** benchmark 数字 |
| 2 | 前置知识 | 可选 | 不了解会看不懂时才写，宁缺毋滥 |
| 3 | 设计参考 | 可选 | 竞品 / RFC / 设计文档 |
| 4 | 实现 | ✅ | 核心原理 + 调用链路 + 重点难点 |
| 5 | 测试 | 可选 | 按类型分子节：`### 单元测试` / `### 回归测试` / `### 性能测试` |
| 6 | Review | 可选 | 有实质价值的 review；跳过 LGTM / 格式检查 |
| 7 | 问题 | 可选 | 实现卡点与解法 |
| 8 | 意义与影响 | ✅ | 价值 + 影响范围（结论性描述，不重复测试数字）|
| 9 | TODO | 可选 | checklist 格式；已解决条目保留历史，在条目下方加后续文章链接 |
| 10 | 参考 | 可选 | RFC / 论文 / 规范；**不放** Issue / PR 链接（元信息已有）|

### 骨架

```markdown
> **PR** [#XXXXX](url) · **Issue** [#XXXXX](url) · **commit** [xxxxxxx](url) · **首发版本** x.x.x · **变更行数** +N 行 · **合并时间** YYYY-MM-DD

---

## 背景
## 前置知识
## 设计参考
## 实现
## 测试
### 单元测试
### 回归测试
### 性能测试
## Review
## 问题
## 意义与影响
## TODO
## 参考
```
