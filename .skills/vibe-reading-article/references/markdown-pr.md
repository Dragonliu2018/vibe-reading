# PR / Commit 文章规范

适用于 `source.type` 为 `PR` / `commit` / `Issue` 的 Markdown 文章。

---

## category 选择

- **自己写的 PR / commit** → category 末级用 `Contributions`
- **解读他人的 PR / commit** → category 末级用 `PRs`

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
date: "YYYY-MM-DDTHH:MM:SS+08:00"      # 取博客编写时的当前时间（TZ=Asia/Shanghai date '+%Y-%m-%dT%H:%M:%S+08:00'，勿手填近似）；ISO 8601 带时区（北京时间）；同日多篇按完整值排序，展示截前 10 字符
category: [Domain, Project, Contributions]
tags: ["Tag1", "Tag2"]
description: "一句话描述"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
reviewed: false
---
```

**title 规则**：UI 自动拼接为 `[Doris PR-26133] feat: title`，因此 title 字段**不要**写 project 名或 PR 编号前缀。

`reviewed`：是否经人工 review。AI 生成初稿时一律写 `false`；人工 review 通过后改为 `true`，提交重新构建后首页/文章页徽章由 `Draft`（灰黄）切为 `Reviewed`（绿）。省略时等同 `false`。

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

**核心原则：交叉引用默认双向。** 导言元信息行里已经带了本篇 PR 链接，所以文章正文一旦引用了另一篇 PR（后续修复、前序改造、同思路的另一分支落地等），就**一般都要在两篇文章各加一个反向链接**，形成双向交叉引用，而不是只在一篇里单方向提一句。读者从任一篇进入都能跳到另一篇。

判断「是否需要交叉引用」：只要 A 文章正文出现了 B 文章对应的 PR 编号 / 标题 / 链接，就视为两篇有关联 → 双向补链接。

### 后序文章（A 是 B 的后续，如 bug fix / 摘取 / 同思路再落地）

A 在导言元信息后、`---` 前插入前向链接：

```markdown
> 📎 本文是 [前序文章标题](/vibe-reading/articles/{slug}) 的后续修复，建议先阅读原文。
```

### 前序文章反向关联（B 回指 A）

- 有 `## TODO` 且该条目正是后续 PR 所解决 → 在对应 TODO 条目正下方加
- 无 TODO / 一般性跟进 → 在 `## 意义与影响` 末尾加

```markdown
> **后续**：... [PR #XXXXX](url) 修复了这一场景，详见[文章标题](/vibe-reading/articles/{slug})。
```

### 同侧关联（非严格先后，如同一设计两个分支的落地）

两篇互为同侧关联，无明显前后序时，各自在导言元信息后加一句 `📎` 引用对方，措辞用「同思路 / 同设计的另一落地线」而非「后续修复」：

```markdown
> 📎 本文与 [另一篇文章标题](/vibe-reading/articles/{slug}) 是同一思路的两条落地线，建议对照阅读。
```

**锚点规则**：引用整篇文章不加锚点；明确指向某节（如 TODO）加 `#todo`。

> 落地提醒：写完一篇 PR 文章后，回看正文引用过的其它 PR，凡已写过对应文章的，逐篇补双向链接。新文章先加好指向旧文章的链接；旧文章若此前只在 TODO 列了 PR 编号而未指向文章，此时一并补上「详见[文章标题]」的反向链接。

**`## 相关阅读` 与交叉引用的区别**。正文交叉引用（上文 `📎` / TODO 反向链接 / 意义与影响末尾）是**点对点、双向**的——针对有明确前后序或同侧关系的 PR 文章对。`## 相关阅读`（末尾章节）是**汇总清单**——把正文已提的 + 没提但相关的（同模型其他 PR、对应论文、同设计落地线）收拢成一个带关系标签的列表，方便读者一览。两者互补：交叉引用讲"这两篇什么关系"，相关阅读讲"这篇还和哪些有关"。格式与关系标签词表见 `content-guide.md`「通用写作要点·相关阅读」。

**`参考` 节的定位**。`## 参考` 只放正文**未展开**的外部参考资料——RFC / 论文 / 规范 / 官方文档，以及正文未细讲但读者可能需要顺藤摸瓜的关联源码。三条硬约束：

1. **不承载交叉引用**：文章间双向链接只在正文做（导言 `📎` / TODO 条目 / 意义与影响末尾），`参考` 不放 PR / Issue 链接（元信息已有）。
2. **不重复正文源码**：PR 的核心源码（改动文件、关键类/函数）必须在「实现」节用代码块讲清楚；这些路径正文已出现，`参考` 不得再列一遍——否则纯冗余。
3. **无外部参考则省略**：`参考` 是可选节。没有 RFC / 论文 / 规范 / 官方文档、也没有正文外的关联源码可引时，**整节省略**，不要为凑节数拿正文已述的源码路径填充。

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
| 10 | 参考 | 可选 | RFC / 论文 / 规范 / 官方文档等**外部**参考资料；PR 的核心源码在「实现」节讲解，不放回本节；**不放** Issue / PR 链接（元信息已有）。无外部参考时**整节省略**，不要拿正文已述的源码路径填充 |
| 11 | 相关阅读 | ✅ | 关联博客内其他相关文章（同模型其他 PR / 对应论文 / 同设计落地线），每条带关系标签 + 一句话说明；格式见 `content-guide.md`「通用写作要点·相关阅读」 |

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
## 相关阅读
```

---

## SVG 图表（架构图 + 改动对比）

PR/commit 文章在改动有架构/调用链/数据流可画时，加 SVG 让读者快速理解（参考 codewiki 的 SVG 设计）。纯 bugfix 几行则省略。

### 图类型

| 图 | 何时画 | 位置 | 内容 |
|---|---|---|---|
| **架构图 + 改动位置** | 必选（改动有架构上下文） | 背景段 | 整体架构/流程，用高亮色标注 PR 改动位置，让读者一眼看到改在哪 |
| **改动前/后对比** | 可选（改动有调用链/数据流） | 各改动段 | 改动前 vs 改动后（左右对比），红标浪费/绿标优化 |

数量：小 PR 1 张架构图；改动多的 2-3 张（架构 + 各改动对比）。别超过 3 张。

### 图后说明（必选）

**每张图后必须紧跟一段说明文字**，解读图在说什么（改动在哪/前后差异/为什么），让读者不看代码就能快速理解。图是「一眼看懂结构」，说明是「为什么这么改」。

格式：图引用后紧跟一段（2-4 句）说明，例如：

    ![架构与改动位置](/vibe-reading/images/articles/<slug>/architecture.svg)

    上图标注了 PR 的两处改动：累积阶段（黄）跳过 ColumnConst 物化，归并阶段（绿）缓存列指针。两处都不改变排序语义，只消除冗余开销。

> 图 + 说明成对出现：图后没有解读说明，等于让读者自己猜图，失去加图的意义。

### SVG 设计

遵循 [`svg-design.md`](./svg-design.md) 的「SVG 通用设计要求」。PR/commit 文章的额外约定：改动位置用黄/绿高亮、浪费/问题用红/粉。手写 SVG XML，存 `public/images/articles/<slug>/`，正文引用 `/vibe-reading/images/articles/<slug>/<file>.svg`。

### commit

用 `commit-article.sh <slug>`（子仓库 commit 图 + 主 repo commit 文章+指针）。

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

## 获取 PR 信息的方法

`WebFetch` 对 `github.com` 常被网络策略拦截，不要依赖它。**首选 `gh` CLI**（已安装，命令简洁、自动处理分页和认证）；**`gh` 不可用时用 `curl` + GitHub REST API**（对公开仓库无需 token）。

> 用 `<owner>/<repo>` 表示仓库（如 `apache/doris`），`<number>` 表示 PR 编号。

### 0. 前置检查

```bash
gh auth status          # 确认已登录（未登录对公开仓库也能用，但会触发匿名速率限制）
gh repo view <owner>/<repo> --json name  # 确认能访问目标仓库
```

> 未登录时先跑 `! gh auth login`（交互式，在终端完成）。

### 1. PR 元信息（标题 / body / 状态 / merge 信息 / Labels / 行数）

**gh（首选）**：

```bash
gh pr view <number> --repo <owner>/<repo> --json \
  title,body,state,mergedAt,mergeCommit,labels,additions,deletions,changedFiles,baseRefName,author
```

`--json` 支持的字段名与 PR 对象略有差异：`mergedAt`（非 `merged_at`）、`mergeCommit.oid`（非 `merge_commit_sha`）、`additions`/`deletions`/`changedFiles`（非 snake_case）。

**curl（fallback）**：

```bash
curl -sL "https://api.github.com/repos/<owner>/<repo>/pulls/<number>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({k:d[k] for k in ['title','body','state','merged_at','merge_commit_sha','additions','deletions','changed_files','labels','base','head','user']}, indent=2, default=str))"
```

关键字段对照（用于导言元信息行）：

| 元信息字段 | 来源 |
|---|---|
| `PR` | `number` + `html_url` |
| `Issue` | body 中的 `Closes #XXXXX` / `Fix #XXXXX`（正则提取）；找不到填 `-` |
| `commit` | `merge_commit_sha` / `mergeCommit.oid`（取前 7 位） |
| `首发版本` | `labels` 中 `dev/x.x.x-merged` 去前缀；仍无则 `git tag --contains <merge_commit_sha> \| sort -V \| head -1` |
| `变更行数` | `additions`（导言行写 `+N 行`，`deletions` 可参考但不强制写） |
| `合并时间` | `merged_at` / `mergedAt`（ISO → `YYYY-MM-DD`）；未合并填 `-` |
| `prType` | 从 title 前缀推断：`[feat]`/`[perf]`/`[fix]`/`[refactor]`/`[enhance]` → `feat`/`perf`/`fix`/`refactor`/`enhancement` |

### 2. 变更文件列表

**gh（首选）**：

```bash
gh pr view <number> --repo <owner>/<repo> --json files \
  --jq '.files[] | "\(.status[:10]) +\(.additions) -\(.deletions)  \(.path)"'
```

`--jq` 用 jq 语法直接过滤，无需 python。

**curl（fallback）**：

```bash
curl -sL "https://api.github.com/repos/<owner>/<repo>/pulls/<number>/files?per_page=100" \
  | python3 -c "import json,sys; [print(f'{f[\"status\"]:10} +{f[\"additions\"]:5} -{f[\"deletions\"]:5}  {f[\"filename\"]}') for f in json.load(sys.stdin)]"
```

> 超过 100 文件：`gh` 自动分页；curl 需 `&page=2` 手动翻页。

### 3. Review 评论（按文件 / 行）

**gh（首选）**：

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate \
  --jq '.[] | "--- \(.user.login) on \(.path // \"?\") ---\n\(.body[:500])\n"'
```

`gh api` 可调用任意 GitHub REST 端点，`--paginate` 自动处理分页。

**curl（fallback）**：

```bash
curl -sL "https://api.github.com/repos/<owner>/<repo>/pulls/<number>/comments?per_page=100" \
  | python3 -c "import json,sys; [print(f'--- {c[\"user\"][\"login\"]} on {c.get(\"path\",\"?\")} ---\n{c[\"body\"][:500]}\n') for c in json.load(sys.stdin)]"
```

### 4. 完整 diff

```bash
# gh 和 curl 都能拿到，落盘后切片阅读
gh pr diff <number> --repo <owner>/<repo> > /tmp/pr_<number>.diff
# 或
curl -sL "https://github.com/<owner>/<repo>/pull/<number>.diff" -o /tmp/pr_<number>.diff
```

diff 通常较大（数千行），落盘后按文件名切片阅读：

```bash
python3 -c "
content = open('/tmp/pr_<number>.diff').read()
for block in content.split('diff --git '):
    if '<keyword>.java' in block.split(chr(10))[0]:
        print('diff --git ' + block)
"
```

### 5. Issue / commit 单独获取（需要时）

```bash
# Issue（gh）
gh issue view <number> --repo <owner>/<repo> --json title,body,state,labels
# commit（gh，含 stat）
gh api repos/<owner>/<repo>/commits/<sha> --jq '{sha,message,stats}'

# Issue（curl）
curl -sL "https://api.github.com/repos/<owner>/<repo>/issues/<number>"
# commit（curl，含 stat）
curl -sL "https://api.github.com/repos/<owner>/<repo>/commits/<sha>"
```

### 与本地源码配合

PR 的 diff 反映**改动前后**，但理解完整调用链还需读**本地仓库的当前代码**（改动已合并后的版本）。流程：

1. 用上面的命令拿到 PR 元信息 + diff + review
2. `git log --oneline -5` 确认本地仓库已包含 merge commit
3. 用 Read 读 diff 中提到的关键文件的**完整当前内容**（不只看 diff 片段），确认调用链和上下文
4. 写文章时，代码片段取自 diff（展示改动），文字描述参考完整源码（解释逻辑）

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

---

## Linux kernel commit 文章

Linux 内核走邮件列表提交流程，commit 没有 GitHub PR/Issue 编号。kernel commit 文章用**默认 commit 方案**：`source.type: "commit"`、`source.id` = commit hash 前 6 位，前缀 `[Linux commit-<6位>]`。

```yaml title="frontmatter"
source:
  project: "Linux"
  type: "commit"
  id: "02a4a6"          # commit hash 前 6 位
  url: "https://github.com/torvalds/linux/commit/<完整 hash>"
  prType: "fix"
```

```markdown title="导言元信息（删掉 PR/Issue）"
> **patch** [20220203](lore-url) · **commit** [02a4a6](github-commit-url) · **首发版本** v5.17-rc5 · **变更行数** +10 行 · **合并时间** 2022-02-20
```

commit 永远没有 PR/Issue 编号，meta 行**删掉 `**PR** \`-\` · **Issue** \`-\` · `**，保留 `**patch** [时间戳](lore-url)` 在前、`**commit** [hash](github-url)` 在后——前缀仍用 commit-hash（`[Linux commit-<6位>]`，由 `source.type=commit` + `source.id=<6位hash>` 决定），meta 的 patch 字段只标注 patch 来路、不影响排序（排序仍按 `source.id` 的 hash）。

**patch 字段从哪取**：`git format-patch` 的 Message-ID 形如 `<YYYYMMDDHHMMSS>.<pid>-<n>-<author@domain>`，开头 14 位是提交时间戳（UTC，= AuthorDate 换 UTC）。来源：① commit message 的 `Link:` trailer（`Link: https://lore.kernel.org/<list>/<完整 Message-ID>`）→ 直接取时间戳前 8 位 + lore URL；② 无 `Link:`（早于 lore Link 惯例）→ 上 lore 搜，注意 `lore.kernel.org` 现用 Anubis 反爬（`WebFetch` 被拦、`curl` 403），用 agent-browser（真 Chrome，`/Applications/Dumbo.app/Contents/Resources/bin/agent-browser`）`open '?q=...&r'` + `sleep 3` + `eval` 提取 Message-ID 链接。

> **排序权衡（已接受）**：`source.id` 用 commit hash，`categories.ts` 的 `sortSlugs` 会 `parseInt(hash)`——hash 是随机十六进制，parseInt 出垃圾值或 `NaN`（a–f 开头直接 `NaN`），**分类内不保证时间序**。曾考虑改用 patch 的 Message-ID 时间戳当 id 来排序（`[Linux patch-YYYYMMDD]`），但放弃了，回到 hash 前缀、接受不按时间排。若日后要时间序，需解耦：id 仍用 hash（前缀），`sortSlugs` 对 commit 类型改按 `source.mergedAt` 排序（改 `categories.ts` + 加字段）。

> **首发版本 / 合并时间取值**（GitHub Labels 不适用于 kernel）：`首发版本` = `git tag --contains <hash> | sort -V` 里最早包含的 tag（通常是 `-rcN`，如 `v5.17-rc5`；注意 `sort -V` 可能把 stable 排到 rc 前，按时间取最早的 rc）；`合并时间` = 主线 merge commit 日期（`git log --ancestry-path --merges` 找 `Merge tag '.../<subsystem>/for-...'`）。
