---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "配置体系与委托"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "Config", "Rules", "Template", "Delegate"]
description: "OpenCodeReview 配置体系与委托——模板引擎（embed prompt）、四层规则匹配（system/project/global/custom）、allowlist 语言白名单、委托模式规则分组渲染。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/config/`（约 1,070 行）+ `internal/delegate/`（约 90 行）是「确定性工程」的规则与模板根基。它定义审查的 prompt 模板、规则匹配、可审查文件白名单、工具配置，以及委托模式下把规则分组渲染给外部 agent 的逻辑。README 强调「模板引擎规则匹配比纯语言驱动更稳定」——这里的确定性设计是那条主张的落地：同一文件路径永远解析到同一规则文本，消除 LLM 语言识别的不确定性。`delegate` 则是委托模式的边界：OCR 管文件选择 + 规则解析（确定性部分），外部 agent 管审查执行（LLM 调用部分）。

## 模块架构

```
internal/config/
├── template/template.go        # Template/ScanTemplate 引擎（embed prompt 文件）
├── rules/system_rules.go      # 规则体系（四层 + composedResolver + FileFilter）
├── allowlist/allowed_ext.go    # 语言/扩展名白名单 + 默认排除模式
├── toolsconfig/toolsconfig.go # 工具配置（plan_task/main_task phase）
└── testconnection/testconnection.go # LLM 连通性测试模板

internal/delegate/
├── rulegroup.go                # GroupRules 按 source|pattern|text 分组
└── format.go                   # RuleGroupsMarkdown 渲染
```

核心抽象：`Template`（prompt 模板引擎）、`rules.Resolver`/`DetailResolver`（规则解析接口）、`Allowlist`（白名单函数）、`ToolConfigEntry`（工具 phase 配置）、`RuleGroup`（委托分组）。它们都大量用 `go:embed` 自包含资源。

## 调用链路

配置加载链（`cmd/shared.go:loadCommonContext`）+ 委托链（`delegate_cmd.go`）：

```
# 配置加载（loadCommonContext, shared.go:72）
template.LoadDefault()                    # template.go:123
  ├─ 解析 task_template.json manifest
  └─ resolveConversation 从 embed.FS 读 prompts/*.md 填入 ChatMessage

rules.NewResolver(repoDir, rulePath)     # system_rules.go:270
  ├─ system(embedded system_rules.json + rule_docs/*)
  ├─ project(<repo>/.opencodereview/rule.json)
  ├─ global(~/.opencodereview/rule.json)
  └─ custom(--rule flag) → composedResolver + FileFilter

loadLLMRuntime 中 toolsconfig.Load(path) → []ToolConfigEntry
  └─ agent.BuildToolDefs 按 phase 分发

# 运行时（agent）
resolver.Resolve(path) → 规则文本注入 LLM 对话

# 委托模式（delegate_cmd.go:234 executeDelegateRule）
loadDelegateContext → loadCommonContext（复用）
delegate.GroupRules(resolver, paths)      # rulegroup.go:27 按 source|pattern|text 分组
delegate.RuleGroupsMarkdown(groups)        # format.go:12 渲染 markdown → stdout
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `template.LoadDefault` (`template.go:123`) | 加载模板骨架 | manifest + prompts 分离，prompt 可独立演化 |
| `composedResolver.Resolve` (`system_rules.go:390`) | 按优先级解析规则 | custom>project>global>system，first match wins |
| `IsAllowedExt`/`IsExcludedPath` (`allowed_ext.go`) | 白名单过滤 | 扩展名白名单 + 路径 glob 排除，`sync.Once` 懒初始化 |
| `ToolConfigEntry.ToolDefsByPhase` (`toolsconfig.go`) | 按 phase 取工具定义 | `plan_task`/`main_task` 标志 |
| `GroupRules` (`rulegroup.go:27`) | 委托分组 | 相同规则文本但来源/pattern 不同则分属不同组 |
| `CanonicalConfig` (`system_rules.go:409`) | 产出有序字段 | 供 manifest 计算 `rule_config_sha256`，配置可复现 |
</details>

## 核心实现

### Template 引擎的确定性设计

模板引擎**不做变量替换**——prompt 内容直接从 embed.FS 读取原始文本填入 `ChatMessage.Content`。所谓「模板引擎规则匹配比纯语言驱动更稳定」的核心在于：prompt 是固定的嵌入式文件（`main_task_system.md` 等），**规则文本由 `composedResolver.Resolve(path)` 按 glob pattern 确定性匹配后注入**，而非让 LLM 自行猜测文件语言。同一文件路径永远解析到同一规则文本。`ApplyLanguage`（`template.go:184`）仅追加 "Always respond in X" 指令到 system role 消息末尾，是纯追加非条件分支。`Template` struct 含 `MainTask`/`PlanTask`/`MemoryCompressionTask`/`ReLocationTask`/`ReviewFilterTask` 等 `LlmConversation`；`ScanTemplate` 是 scan 管线的独立模板（含 `BatchSize`/`DedupTask`/`MaxFileSizeBytes`），与 `Template` 物理隔离独立演化。

### Allowlist 决定可审查范围

`supported_file_types.json` 列出约 97 种扩展名（`.java`/`.go`/`.py`/`.rs`…），`IsAllowedExt` 大小写不敏感查 map；`IsExcludedPath` 用 `default_exclude_patterns.json` 的 glob 模式排除测试文件（`**/*_test.go`）、生成文件等。这两层在 diff preview 阶段过滤，`FileFilter`（`system_rules.go:211`）叠加用户在 `rule.json` 中配置的 include/exclude，三层过滤确定最终可审查文件集。

### Rules 的四层匹配

系统规则 embedded 在 `system_rules.json` + `rule_docs/*.md`（如 `go.md`/`rust.md`/`default.md`），`path_rule_map` 用有序 JSON object（`UnmarshalJSON` `system_rules.go:36` 用 streaming decoder 保序）。用户规则来自三个外部源：custom（`--rule`）> project（`<repo>/.opencodereview/rule.json`）> global（`~/.opencodereview/rule.json`）。`resolveRuleEntries`（`system_rules.go:520`）支持规则值是**文件路径引用**（`.md`/`.txt`/`.markdown`，512KB 上限，`tryReadRuleFile` 防目录穿越）或内联文本（`looksLikeFilePath` heuristic 判定）。`MergeSystemRule` 标志允许用户规则与系统规则合并（`mergeWithSystemRule` 拼接 "System-Specific Rules" + "User-Specific Rules"）。`CanonicalConfig` 产出有序字段列表供 run manifest 计算 `rule_config_sha256`，保证配置可复现。

### TestConnection 与 ToolConfig

`testconnection.go` 的 `LoadDefault` 解析 embedded `task.json` 返回 `LlmConversation`（含 `Timeout` 字段），用于启动前验证 LLM endpoint 可达。`toolsconfig/toolsconfig.go` 的 `ToolConfigEntry` 用 `plan_task`/`main_task` bool 区分工具的 phase 归属，`ToolDefsByPhase(planOnly)` 返回对应 phase 的工具定义。

### Delegate 委托模式的边界

`GroupRules`（`rulegroup.go:27`）按 `source|pattern|text` 三元组分组——**相同规则文本但来源/pattern 不同则分属不同组**，保证元数据精确。`RuleGroupsMarkdown`（`format.go:12`）渲染为 `### Rule Group N: source / pattern` + 文件列表 + 规则内容。**委托模式与默认模式的数据流差异**：默认模式下 OCR 内部调用 LLM 执行审查（template → agent → llm client → comments）；委托模式下 OCR **不调用 LLM**，仅产出 "spec"（`delegate preview` 输出文件列表 + `delegate rule` 输出分组规则 markdown），交给外部 coding agent 执行。OCR 管文件选择 + 规则解析（确定性部分），外部 agent 管审查执行（LLM 调用部分）。`loadDelegateContext`（`delegate_cmd.go:95`）复用 `loadCommonContext`，说明委托模式共享配置加载逻辑但止步于 LLM 调用之前。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模板方法 | `template.LoadDefault` (`template.go:123`) | manifest 骨架 + prompts 分离 |
| 分层策略 | `composedResolver.Resolve` (`system_rules.go:390`) | 四优先级，first match wins |
| 白名单过滤 | `allowed_ext.go` | 扩展名 + 路径 glob 双重过滤 |
| 注册表（embed.FS） | `rulesFS`/`templateFS` | 规则/模板自包含 |
| Bridge/扩展接口 | `DetailResolver` (`system_rules.go:122`) | 扩展 `Resolver` 加元数据 |

## 模块间交互

config 依赖 `doublestar/v4`（glob 匹配）、`embed`（自包含资源），无外部业务模块依赖，是基础层叶子。被 `cmd/shared.go` 的 `loadCommonContext`（template+rules+FileFilter）和 `loadLLMRuntime`（toolsconfig）调用；`delegate_cmd.go` 的 `loadDelegateContext` 复用 `loadCommonContext`。delegate 依赖 `config/rules`（Resolver/DetailResolver 接口），被 `delegate_cmd.go` 调用。

## 扩展方式

- **新增语言支持**（如 `.zig`）：改三处——`allowlist/supported_file_types.json` 加扩展名；`rules/system_rules.json` 的 `path_rule_map` 加 `"**/*.zig": "zig.md"`；新增 `rules/rule_docs/zig.md` 规则文件。无需改 Go 源码，`LoadDefault` 自动从 embed.FS 加载。
- **新增项目级审查规则**：在仓库根目录创建 `.opencodereview/rule.json`，加 `{"rules":[{"path":"**/*.go","rule":"禁止 panic","merge_system_rule":true}]}`。无需改源码，`loadProjectRule`（`system_rules.go:370`）自动加载。
- **改 prompt 模板**：编辑 `internal/config/template/prompts/main_task_system.md`（embedded 文件）重新编译即可；调 token 预算改 `task_template.json` 的 `MAX_TOKENS`。
