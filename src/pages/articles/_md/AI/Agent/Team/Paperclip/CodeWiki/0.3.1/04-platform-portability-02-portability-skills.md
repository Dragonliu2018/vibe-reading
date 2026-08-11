---
source:
  type: "源码解读"
  project: "paperclip"
  url: "https://github.com/paperclipai/paperclip"
title: "Portability & Skills"
date: "2026-08-11T22:29:06+08:00"
category: [AI, Agent, Team, Paperclip, CodeWiki, "0.3.1"]
tags: ["paperclip", "TypeScript", "AI Agent 编排", "控制平面"]
description: "Paperclip 公司可移植性与技能——secret scrubbing、collision handling、运行时 skill 注入"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/00-overview) · [← 平台扩展与可移植](/vibe-reading/articles/AI/Agent/Team/Paperclip/CodeWiki/0.3.1/04-platform-portability)

---

## 模块定位

本模块属于平台扩展与可移植子系统。Portability & Skills 回答"如何迁移整个组织"——导出/导入公司（agents/skills/projects/routines/issues）含 secret scrubbing 与 collision handling，运行时 skill 注入让 agent 不重训即可学 workflow。`companyPortabilityService()`/`companySkillService()` 是 graphify god node #3/#4（82/77 边）。它独立存在，是因为组织迁移需要统一的序列化/脱敏/冲突处理，而 skill 注入是 agent 运行时学习的基础。

## 模块架构

`companyPortabilityService(db, storage?)`（`company-portability.ts:2992`）返回 4 个入口：`exportBundle`（全量序列化）、`previewExport`（预览不落盘）、`previewImport`（dry-run 产出 plan）、`importBundle`（落库执行）。`companySkillService(db)`（`company-skills.ts:2102`）返回 30+ 方法：清单（list/listFull/getById/getByKey）、安装同步（importFromSource/installFromCatalog/installUpdate/resetSkill）、运行时注入（listRuntimeSkillEntries/materializeRuntimeSkillFiles）、安全（auditSkill）、版本（createVersion/listVersions）。`teamsCatalogService(db)`（`teams-catalog.ts:740`）提供组织模板源。

## 调用链路

导出链（`exportBundle` `:3232`）：
1. 收集 agents/skills/projects/issues/routines（`:3256-3311`）
2. `extractPortableEnvInputs`（`:486-554`）脱敏 env → secret_ref 变 `kind:"secret"`, 空 default；PATH 与绝对路径丢弃
3. 序列化为 `.paperclip.yaml`（schema `paperclip/v1`，`:3762-3782`）+ 每实体 `agents/<slug>/AGENT.md`、`tasks/<slug>/TASK.md`、`skills/<slug>/SKILL.md`
4. `buildManifestFromPackageFiles`（`:3819`）二次解析产出 manifest + `images/org-chart.png` + `README.md`

导入链（`importBundle` `:4276`）：
1. `buildPreview(input, options)`（`:3880`，共享于 previewImport/importBundle，模板方法）
2. `resolveImportMode`（`:140`）→ `board_full`/`agent_safe`；agent_safe 不允许 replace（`:3896`）
3. 计算碰撞 plan：agent（`:4101-4142`）/ project（`:4144-4186`），三策略 create/update/skip/rename
4. `companySkills.importPackageFiles`（`:4488`）skill 落库
5. 串行落 agents → projects+workspaces → issues/routines（`:4503-4970`）；中途 `materializeImportedAssigneeAgentId` 解析跨实体引用
6. 异常回滚：catch 删除已建 secret（`:4984-4988`）

## 核心实现

### Secret scrubbing（导出脱敏）

`extractPortableEnvInputs`（`:486-554`）遍历 env binding 三种形态（secret_ref / plain / string）各自脱敏：`secret_ref` → `kind:"secret"`, 空 default；`isSensitiveEnvKey(key)` 触发对 plain 字符串脱敏。**为什么**：secret 值永不离组织，bundle 可公开分享。

### Collision handling

agent/project plan 在三策略间分派（`:4101-4186`）：`skip` 保留现状，`rename` 走 `uniqueNameBySlug`/`uniqueProjectName`，`replace` 仅 `board_full` 可用。`agent_safe` 模式拒绝 replace/update（`:149-185`/`:4286-4295`）。**为什么**：导入路径分信任等级，避免静默覆盖。

### Portable path

`portable-path.ts` 统一分隔符、消解 `..`。**为什么**：跨平台 bundle 路径不可逃逸 root。

### 运行时 skill 注入

`listRuntimeSkillEntries`（`:4112`）+ `materializeRuntimeSkillFiles`（`:3956`）把 skill 落到 `__runtime__/<runtimeName>` 目录，被 agent adapter 加载。`heartbeat.ts:3393` 构造 `companySkills`，每次 run 前调 `listRuntimeSkillEntries(agent.companyId, {versionSelections})`（`heartbeat.ts:8832`），结果塞入 `runtimeConfig.paperclipRuntimeSkills`（`:8837`）。**为什么**：agent 启动时直接读 SKILL.md 学 workflow，无需 fine-tune/重训。

### Skill audit

`auditSkill`（`:2422`/`:1908-1920`）装好后比对 `installedHash` vs `originHash`，差异即 finding。**为什么**：发现外部 skill 被本地篡改。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Memento | `CompanyPortabilityManifest` | 组织状态外化快照 |
| 策略 | `resolveSkillConflictStrategy`/`resolveImportMode` (`:144`/`:140`) | 冲突策略分派 |
| Visitor-style scrubbing | `extractPortableEnvInputs` (`:486`) | 遍历 env 三形态各自脱敏 |
| Template method | `buildPreview` (`:3880`) | 同时驱动 preview/import |
| Registry | `SKILL_ROOTS_BY_AGENT_TYPE` (`company-skills.ts:329`) | 30+ agent skills 目录登记 |

## 模块间交互

**运行时 skill 注入**：`heartbeatService` 构造 `companySkills`（`heartbeat.ts:3393`），每次 run 前调 `listRuntimeSkillEntries`（`:8832`）塞入 runtimeConfig。**导出时收集**：`companyPortabilityService` 复用 `companySkillService`（`:3000`）做 listFull/readFile。**Catalog 作为模板源**：`teamsCatalogService` 组合 portability + skills（`:741-742`），把 catalog team 文件转成 inline portability source（`:769-812`），再走标准 import pipeline。

## 扩展方式

**新增导出实体类型（如 labels）**：`exportBundle`（`:3232`）收集 labels，在 `.paperclip.yaml`（`:3762-3782`）加 `labels:` 段；`buildManifestFromPackageFiles` 解析时识别；`importBundle`（`:4276`）在 `:4480` 后追加 labels 落库循环；`previewImport` 的 plan 结构加 `labelPlans`。

**新增 collision 策略 "merge"**：`resolveSkillConflictStrategy`（`:144`）加分支；agent/project plan 循环（`:4101-4142`/`:4144-4186`）加 `action:"merge"` 分支；`company-skills.ts` `importPackageFiles`（`:4138`）的 `onConflict` 联合类型加 `"merge"`，落库逻辑（`:4186-4256`）加 merge 分支。
