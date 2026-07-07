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

### 多 PR 合集

当一篇文章整合多个 PR 时，`source` 字段仍按单 PR 结构填写，编号相关的处理如下：

| 字段 | 填法 |
|---|---|
| `id` | 首尾编号范围，如 `"1041-1103"`。编号不连续也取首尾，中间跳号在文章内列全 |
| `url` | 第一个 PR 的链接，作为入口 |
| `prType` | 取合集的主类型（如 6 个全是 `perf` 填 `perf`；混合时按多数或主旨） |

**文件命名**：`xllm-pr-{id}-{slug}.md`，`id` 中的连字符不与文件名分隔符冲突。例：`xllm-pr-1041-1103-vector-optimization.md`。

**title 不要加数量**：title 字段只写主题，**不要**在末尾加"（六则）""（三篇）"等数量标注。PR 数量由导言元信息行的链接列表体现，读者点进文章即可看到。

**导言元信息**：合集的导言行用 `·` 分隔列出**所有** PR 链接，首发版本取其中最早的，变更行数为各 PR 之和，合并时间取时间跨度：

```markdown
> **系列 PR** [#1041](url) · [#1048](url) · [#1088](url) · **首发版本** v0.9.0 · **变更行数** +170 行 · **时间跨度** 2026-03-12 ~ 2026-03-31
```

> 单 PR 文章的 `Issue` / `commit` 字段在合集中省略（各 PR 各自有，列出来太冗长）。

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

---

## PR / Issue 配图收集

**在阅读 PR 和 Issue 时**（Step 2），同步识别并下载有意义的图片到博客本地，写作时直接引用。

### 哪些图片值得保留

| 值得保留 | 跳过 |
|---------|------|
| 架构图 / 流程图（说明设计思路）| 普通代码截图（用代码块代替）|
| 性能 benchmark 对比图（有数字）| GitHub UI 截图（注释、审查界面）|
| 问题复现 / 修复前后的对比图 | Bot 自动评论、CI 结果截图 |
| Issue 中说明问题场景的截图 | 随意的个人测试截图（无说明）|

### 下载与存放

按 `markdown-style.md` 的图片规范执行：

```bash
# 路径格式
public/images/articles/{article-slug}/{descriptive-name}.png

# 下载
mkdir -p public/images/articles/{slug}
curl -sL "{pr-or-issue-image-url}" -o public/images/articles/{slug}/{name}.png
```

### 在文章中引用

配图**不能作为唯一内容独立出现**，图前需有引导句，图后需有关键步骤的文字拆解。

**原则：图是辅助，文字是主体。** 读者看完文字就能理解，图只是加速理解的工具。

#### 架构图 / 流程图

先用文字交代背景和全貌，放图，再按流程的**重要节点**逐步说明——至少覆盖「为什么这么设计」的关键决策点：

```markdown
新旧架构对比如下，核心变化是将内存高峰从 Leader 转移到 Follower：

![旧版与新版架构对比](/vibe-reading/images/articles/{slug}/{name}.png)

1. **CheckpointController（Leader 侧）** 只做调度：检测 journal 增量、
   选择内存最低的 FE、触发 worker 执行并等待回调。
2. **CheckpointWorker（所有 FE）** 只做执行：接收任务后独立完成
   加载 image → 回放 journal → 写 image 的全过程，完成后通知 Leader。
3. **image 下发**：若执行节点不是 Leader，Leader 从该节点下载 image
   再广播到其他 FE——Leader 本身不再承担内存密集型的构建工作。
```

#### 性能对比图

先说明测试场景和关注指标，放图，再点出关键数字和结论：

```markdown
在 10 万行数据、3 副本的测试场景下，优化前后延迟对比如下：

![批量查询 vs 逐条查询性能对比](/vibe-reading/images/articles/{slug}/{name}.png)

批量查询（`WHERE key IN (...)`）将 P99 延迟从 **320ms 降至 18ms**，
降幅 94%，主要收益来自网络往返次数从 N 次压缩为 1 次。
```

---

## 源码核验

文章写完后，**重新获取 PR/commit 的实际 diff**，逐项核对以下内容，发现错误立即修正。

### 元信息核对

- [ ] commit hash 与 PR 页面一致
- [ ] 变更行数（`+N 行`）与 `git diff --stat` 或 PR Files changed 统计一致
- [ ] 首发版本取值正确（Labels `dev/x.x.x-merged` 或 `git tag --contains`）
- [ ] 合并时间正确

### 实现内容核对

- [ ] 所有提到的**文件路径**存在于 diff 中
- [ ] 所有提到的**函数名 / 类名 / 方法名**拼写正确，与源码一致
- [ ] 文章中的**代码片段**与实际 diff 一致（关注增删行，不要用旧版本代码）
- [ ] 对实现逻辑的**文字描述**与代码实际行为一致（重点：条件分支、执行顺序、返回值）
- [ ] **调用链**描述与代码中的实际调用关系一致

### 测试内容核对

- [ ] 测试文件路径正确
- [ ] 测试用例名（函数名）正确
- [ ] 测试覆盖的场景描述与实际断言一致

### Review 内容核对

- [ ] Review 意见的引用与 PR 评论原文一致（不要改变语义）
- [ ] 对 Review 的处理结果描述（接受 / 拒绝 / 修改）与实际一致
