# Markdown 文章规范

## Frontmatter（必填）

```yaml
---
title: "文章标题（双引号包裹）"
date: "YYYY-MM-DD"
category: code
tags: ["Tag1", "Tag2", "Tag3"]
description: "一句话描述，出现在文章卡片和 SEO meta 中"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
---
```

**所有字段必须填写。不要加 `layout:` 行（由 `[slug].astro` 统一处理）。**

`category` 取值：`code`（代码解读）| `paper`（论文解读）| `system`（系统设计）

这些字段会被 `articles.ts` 自动读取，**无需手动注册**。

## 导言段落（frontmatter 之后立即写）

```markdown
> **版本** v1.73.0 · **协议** BSD-3-Clause · **Python** ≥ 3.10 · **代码量** ~18,000 行

第一段：1-2 句话概括这篇文章的内容和目标读者。不需要标题。
```

## 标题层级

| 级别 | 用途 | 示例 |
|---|---|---|
| `##` | 主节（对应 HTML 的 `<section>`） | `## 项目简介` |
| `###` | 子节 | `### 核心属性` |
| `####` | 小节（谨慎使用） | `#### 三种批量变体` |

**不要在文章里用 `#`（h1 由 ArticleLayout 的 title 渲染）**

## 段落和强调

```markdown
mycli 属于 **dbcli** 家族——一组基于 `prompt_toolkit` 构建的工具。

> **核心设计原则** 各层职责边界清晰，跨层通信通过接口进行。
```

- `**加粗**`：模块名、概念名、关键术语首次出现
- `` `行内代码` ``：文件名、函数名、类名、命令
- `>` 引用块：重要原则、警告、架构原则

## 代码块

````markdown
```python
# sqlexecute.py
class SQLExecute:
    conn: pymysql.Connection
    dbname: str
```
````

- 语言标识必须标注（`python` / `bash` / `typescript` / `go` / `text` / `ini` 等）
- 若代码来自特定文件，首行加 `# 文件路径.py` 注释

## 表格

```markdown
| 方法 | 查询目标 | 用途 |
| --- | --- | --- |
| `tables()` | information_schema.TABLES | 表名补全 |
| `databases()` | SHOW DATABASES | 库名补全 |
```

第一列加粗（由 ArticleLayout prose 样式自动处理）。

## 列表

```markdown
- **智能 SQL 补全** (`sqlcompleter.py`): 描述功能
- **多协议连接** (`sqlexecute.py`): 描述功能

1. 读取文件开头 4 字节（magic）
2. 读取 20 字节 login_key
3. XOR 生成 AES 密钥
```

- 功能列表：`**名称** (文件)`: 描述
- 步骤列表：有序编号

## 目录树（用 text 代码块）

````markdown
```
mycli/
  __init__.py    # 版本元数据
  main.py        # CLI 入口（~1400 行）
  packages/
    special/     # 特殊命令子系统
```
````

## 分割线

每个主要节之间（`##` 之前）可以加 `---`，但不强制要求。

## Markdown vs HTML 选择原则

**选 Markdown 当：**
- 内容以文字解释、代码块、表格为主
- 不需要复杂视觉组件（卡片组、分层图、双列布局）
- 快速发布，不需要精细视觉设计

**选 HTML 当：**
- 需要 card-grid 展示多个功能卡片
- 需要 layer-stack 展示分层架构
- 需要自定义导航、进度条、复杂布局
- 内容视觉丰富度很重要（产品介绍、大型代码库解读）

## 文章长度估算

| 节数 | 估计生成长度 |
|---|---|
| 6-8 节 | ~3,000-5,000 字 |
| 10-12 节 | ~6,000-10,000 字 |
| 14+ 节 | 建议拆分为多篇 |
