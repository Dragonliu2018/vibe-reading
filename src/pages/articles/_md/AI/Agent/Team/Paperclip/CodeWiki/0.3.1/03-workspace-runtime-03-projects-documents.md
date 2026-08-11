---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Projects & Documents"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 项目与文档——project-goal-issue 三级 ancestry、文档 revision 版本化、annotation anchor 快照"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 工作区与运行时](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/03-workspace-runtime)

---

## 模块定位

本模块属于工作区与运行时子系统。Projects & Documents 提供"为什么做"与"做什么"的上下文——project-goal-issue 三级 ancestry 让 agent 知道战略意图，文档 revision 版本化与 annotation anchor 快照让协作不丢上下文。`projectService()` 是 graphify god node（24 边）。它独立存在，是因为项目结构与文档版本化是 agent 理解工作背景的基础。

## 模块架构

三个核心服务：`projectService(db)`（`projects.ts:543`，project + workspace + membership 管理）、`documentService(db)`（`documents.ts:111`，文档 + revision）、`documentAnnotationService(db)`（`document-annotations.ts:114`，annotation thread + anchor）。

## 调用链路

创建 project 关联 goal/workspace：

```
projectService.create(companyId, data)             projects.ts:544
  ├─ resolveGoalIds                                  :404 sync project_goals join
  ├─ resolveProjectNameForUniqueShortname           去重短名
  ├─ insert(projects) + 写 legacy goalId 列         :561
  ├─ syncGoalLinks (删旧+插新 project_goals)       :404
  ├─ attachGoals                                     批量 IN 查询
  └─ attachWorkspaces                                批量 IN 查询
```

文档 revision 流转（`documents.ts:197` `upsertIssueDocument`）：normalizeKey → 查 existing → 四分支：(a) locked + create_new_document 策略 → `nextAvailableDocumentKey` 生成新 key（`:253`）；(b) locked + 其他策略 → conflict；(c) existing 未锁 → 校验 `baseRevisionId===latestRevisionId`（`:355` 乐观并发）→ insert `document_revisions`(revisionNumber+1) + update `documents.latestRevisionId`；(d) 新建 → insert document + revision#1。外层 `for` 循环 + `isUniqueViolation` 重试（`:501`）处理 key 冲突。

## 核心实现

### project-goal-issue 三级 ancestry

`resolveIssueProjectAndGoal`（`routes/issues.ts:2843`）：issue 有 `goalId` 直取；否则取 `project.goalIds[0]`；再否则取公司默认 goal。`syncGoalLinks`（`projects.ts:404`）维护 project↔goal 多对多 join，同时保留 legacy 单 `goalId` 列（`:561`）向后兼容。**为什么**：让 agent 知道 issue 之上的 "why"，goal 提供战略意图。

### 文档 revision 版本化

`upsertIssueDocument` 用 `baseRevisionId` 做乐观锁（`:355`），不匹配即 `conflict("Document was updated by someone else")`；每次更新插入新 `document_revisions` 行而非原地改。`restoreIssueDocumentRevision`（`:515`）也非回滚而是新建 revision（changeSummary "Restored from revision N"），保留完整审计链。lock 机制（`:616`/`:668`）冻结快照，agent 可用 `create_new_document` 策略重定向到新 key（`:253`）。**为什么**：防丢失更新 + 支持恢复 + 允许冻结快照同时允许新内容。

### annotation anchor 快照

`createThread`（`document-annotations.ts:309`）强制 `baseRevisionId === latestRevisionId`（`:325`），并 `verifyDocumentAnchorSelector` 验证 selector 对齐当前 latestBody；落库存 `originalRevisionId`+`currentRevisionId`+完整文本快照（selectedText/prefix/suffix/normalized/markdown 偏移）。文档变更后 `remapOpenThreadsForDocument`（`:691`）用 `remapDocumentAnchor` 重定位所有 open thread，写 `document_annotation_anchor_snapshots` 历史表，记录 `anchorState`/`anchorConfidence`（exact/shifted/lost）。**为什么**：文档演化时标注不丢，confidence 让 UI 决定是否提示人工复核。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 闭包工厂 | 三个 service | db 注入 |
| Batch-load 防 N+1 | `attachGoals`/`attachWorkspaces` (`:82`/`:234`) | 一次性 IN 查询后内存合并 |
| Row mapper | `toWorkspace`/`mapIssueDocumentRow` (`:152`/`:42`) | 隔离 DB 行与领域对象 |
| 事务包裹 | 所有写操作均 `db.transaction` | workspace 主切用 `ensureSinglePrimaryWorkspace` 做约束恢复 |

## 模块间交互

`projectService` 被 `routes/issues.ts:1094` 实例化，`resolveIssueProjectAndGoal`（`:2843`）查 issue→project→goal 三级 ancestry 给 agent 上下文；被 `plugin-host-services.ts:1431` 调 `resolveManagedProject`；被 `company-skills.ts:2104`/`company-portability.ts:2998` 调用。`documentService` 被 `routes/issues.ts:4078` upsert、`:3394` getIssueDocumentPayload；被 `issue-continuation-summary.ts:272` upsert 续写摘要。`documentAnnotationService` 被 `routes/issues.ts:4101` 在文档 upsert 成功后调 `remapOpenThreadsForDocument` 重定位。

## 扩展方式

**新增 project 成员角色**：当前 `projects.ts` 只有 workspace + goal，无 membership 表（`project_members` 表已存在于 schema）。若要加方法：`projectService` 返回对象新增 `listMembers`/`addMember`/`removeMember`，仿 `syncGoalLinks`（`:404`）写 `syncMembershipLinks`，在 `createProject`/`update` 串联调用。

**修改文档 revision 并发策略**：核心改 `documents.ts:197` `upsertIssueDocument`：`:350-358` 的 `baseRevisionId` 校验逻辑、`:361` 的 `nextRevisionNumber` 计算；若引入新策略字段，还需调 `routes/issues.ts:4078` 的 `lockedDocumentStrategy` 传参（`:4090`）。
