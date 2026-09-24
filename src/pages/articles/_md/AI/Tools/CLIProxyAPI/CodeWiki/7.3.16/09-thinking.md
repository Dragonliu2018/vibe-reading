---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "Thinking 与回放缓存"
date: "2026-09-25T00:12:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "reasoning", "prompt cache", "CAS 乐观并发"]
description: "Thinking 与回放缓存：ThinkingConfig 归一化中间态把 N×M 降为 N+M、Level↔Budget 双向语义转换、签名链/prompt cache/encrypted reasoning 三坑、CAS 乐观并发回放追加、Kimi 模型家族误判 clamp 特例"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`internal/thinking/`（~2.5k 行，含 `provider/` 八个子包）+ `internal/cache/`（回放与签名缓存）+ `internal/signature/`（签名净化）处理协议互通中最容易坏的一环：**thinking/reasoning 跨格式往返**。7 种入口格式 × 7 种出口 provider，每家对"推理预算"的表达都不同（Claude 的 `budget_tokens`、Codex 的 `reasoning.effort`、Gemini 的 thinkingConfig）——如果各翻译器自行处理，逻辑复杂度是 N×M；本模块把它降为 N+M：所有格式先归一化成中间态 `ThinkingConfig`，再由各 provider 的 Applier 写回自己的字段。

同一个模块还要保住多轮对话的**上下文完整性**：Claude 的 thinking 块带上游签名、Codex 的 reasoning 是加密的——第二轮请求把上一轮 assistant 回复发回上游时，这些内容必须**原样字节回传**，否则轻则 400、重则击穿 prompt cache 烧钱。所以回放缓存与签名恢复也在这一篇。

## 模块架构

```
请求（任意源格式）─► applyThinking（apply.go:199）
   ├─ GetProviderApplier(toFormat) 路由（未注册则 passthrough）
   ├─ ParseSuffix 剥 "model(16384)" 后缀 → registry.LookupModelInfo 查能力
   ├─ 配置优先级：后缀 > 源格式 body > 目标格式 body
   ├─ ValidateConfig：按能力转 Budget/Level + clamp + auto→中位数
   └─ applier.Apply 写回 provider 字段
        ├─ Claude：thinking.type/budget_tokens 或 adaptive output_config.effort
        ├─ Codex：reasoning.effort
        └─ …（provider/ 下八家各一包，init() 自注册）

ThinkingConfig（中间态）：Mode(Budget/Level/None/Auto) + Budget + Level(8 级)
   ▲ levelToBudgetMap / ConvertBudgetToLevel（convert.go）双向语义转换

回放缓存（internal/cache）：
   ├─ claudeThinkingReplayEntry（Contents + Generation UUID + 墓碑）
   ├─ 签名缓存 SignatureEntry（TTL 3h，按 model group）
   └─ 五套 replay cache（claude/codex/kimi/xai/antigravity）共用 snapshot+CAS 骨架
signature 模块：StripInvalidClaudeThinkingBlocks 净化 + protobuf 信封校验
```

## 调用链路

两条主链路：

```
applyThinking 归一化链路（apply.go:199）：
applyThinking
├── GetProviderApplier(toFormat)（apply.go:40，未注册则 passthrough）
├── ParseSuffix(model)（suffix.go:23）剥 "model(16384)" 后缀
├── registry.LookupModelInfo 查模型能力（BudgetOnly/LevelOnly/Hybrid，
│   detectModelCapability in convert.go:162）
├── 配置优先级合并（apply.go:256-283，extractSourceThinkingConfig :269）：
│   后缀 > 源格式 body > 目标格式 body；用户自定义模型走 applyUserDefinedModel（:443）
├── ValidateConfig（validate.go:38）：能力转换 + clampBudget/clampLevel
│   + auto → 中位数（convertAutoToMidRange，validate.go:203）
└── applier.Apply 写回 provider 字段
    └── applySummaryConfigForProvider（apply.go:350）恢复 summary 可见性

Claude 回放链路（第二轮自动注入）：
executor 翻译后发上游前：ApplyRequestThinking
（internal/runtime/executor/helps/model_capabilities.go:18，10+ 处 executor 调用）
└── Claude executor 前置（claude_executor_execute.go:49）
    └── prepareClaudeThinkingReplayRequest（claude_thinking_replay.go:69）
        ├── GetClaudeThinkingReplayWithSnapshotRequired（cache :110，内容+generation 快照）
        ├── restoreKimiThinkingReplayContent（kimi_thinking_replay.go:144）
        │   # 按 canonical JSON 相等匹配历史 assistant 轮
        │   # 把含签名的原始 thinking content 整体原样替换回去
        └── 响应完成后 ReplaceClaudeThinkingReplayIfUnchanged（cache :165）
            # CAS 追加本轮（scope key 见下）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `applyThinking` in `internal/thinking/apply.go:199` | 归一化六步管线 | 路由→后缀→能力→配置→校验→应用，provider 只实现最后一步 |
| `ValidateConfig` in `validate.go:38` | 按能力转换 + clamp | 失败返回原 body + err，防御式 |
| `ConvertBudgetToLevel` in `convert.go:77` | Budget→Level 阈值分段 | 与 levelToBudgetMap 双向 |
| `GetProviderApplier` in `apply.go:40` | 路由 provider applier | 未注册 passthrough |
| `RegisterPluginProvider` in `apply.go:65` | 插件注册 applier | 带优先级抢占、禁止覆盖原生名 |
| `GetClaudeThinkingReplayWithSnapshotRequired` in `internal/cache/claude_thinking_replay_cache.go:110` | 读回放 + generation 快照 | CAS 的前置 |
| `ReplaceClaudeThinkingReplayIfUnchanged` in `internal/cache/claude_thinking_replay_cache.go:165` | CAS 追加本轮回放 | 写失败静默放弃不阻塞 |
| `restoreKimiThinkingReplayContent` in `internal/runtime/executor/claude_thinking_replay.go:144` | 历史轮原样替换 | canonical JSON 匹配保 prompt cache |
| `StripInvalidClaudeThinkingBlocks` in `internal/signature/claude.go:15` | 删除签名非法的 thinking 块 | 防 400 兜底 |
| `CacheSignatureBestEffort` in `internal/cache/signature_cache.go:125` | 响应侧回填签名缓存 | best-effort 不影响主流程 |
</details>

## 核心实现

### 归一化中间态：N×M 降为 N+M

`ThinkingConfig`（`types.go:70`）= `Mode`（Budget/Level/None/Auto，`types.go:14`）+ `Budget int` + `Level string`（8 级：minimal/low/medium/high/xhigh/max，`types.go:44-59`）——四种 Mode 只取一个生效字段。Level↔Budget 的双向语义转换是唯一的换算点：`levelToBudgetMap`（`convert.go:11`，如 high→24576、max→128000）正向，`ConvertBudgetToLevel`（`convert.go:77`）阈值分段逆向；`detectModelCapability`（`convert.go:162`）把模型分成 BudgetOnly/LevelOnly/Hybrid 三类，`ValidateConfig`（`validate.go:38`）据此自动转格式并 clamp 到模型范围，`auto` 模式取能力中位数（`convertAutoToMidRange`，`validate.go:203`）。配置来源优先级：**模型名后缀 > 源格式 body > 目标格式 body**（`apply.go:256-283`）——用户写 `claude-sonnet-4-5(16384)` 就该赢过 body 里的任何声明。

### reasoning 往返三坑（本模块存在的全部理由）

**(a) 签名链**：Claude 的 thinking 块签名由上游签发，翻译往返（Claude→Gemini→Claude）必然丢失。三段防御：请求侧 `resolveCacheModeSignatureRequired`（`internal/translator/antigravity/claude/antigravity_claude_request.go:61`）客户端自带签名优先、否则按 thinking 文本查签名缓存（`GetCachedSignatureRequired`，`SignatureEntry` TTL 3h 按 model group 分组，`signature_cache.go:18/25`）；兜底 `StripInvalidClaudeThinkingBlocks`（`internal/signature/claude.go:15`）删除签名空/非法的 thinking 块——宁可丢 thinking 也不能 400；响应侧 `CacheSignatureBestEffort`（`internal/cache/signature_cache.go:125`）按 (model, thinkingText→signature) 回填缓存供下轮用。`signature` 包按 protobuf 结构校验 E/R/CAIS 三种信封（`claude_validation.go:1-111`），保证只有真签名能进缓存。

**(b) prompt cache**：Anthropic 按**请求字节**做 prompt 缓存计费——非原样字节重拼的 thinking 会击穿缓存，多轮对话成本翻倍。所以回放不是"把 thinking 翻译回去"，而是按 canonical JSON 相等匹配到历史 assistant 轮后**整体原样替换**（`restoreKimiThinkingReplayContent`，`kimi_thinking_replay.go:170`）。

**(c) encrypted reasoning**：Codex 的加密 reasoning 根本无法翻译，只能原样回传——meta executor 里 `sanitizeOpenAIResponsesReasoningEncryptedContent`（`meta_executor_execute.go:65`）。

### CAS 乐观并发：不用锁的回放追加

`ReplaceClaudeThinkingReplayIfUnchanged`（`claude_thinking_replay_cache.go:165`）：读时带 generation 快照，写时比对 `entry.Generation != snapshot.generation`（`:200`）——不相等说明另一并发请求已追加，返回 false **静默放弃**（Home KV 路径用 `KVCompareAndCas`，`:194`）。Why 不用互斥锁：并发同 session 的请求若持锁整个回合，长流式请求会被完全串行化；CAS 让冲突方零阻塞地放弃，错误方不覆盖对方。回放条目 `claudeThinkingReplayEntry`（`:44`）= Contents + Timestamp + Generation UUID + Deleted 墓碑。

有界内存（`cache :19-42`）：TTL 1h、10240 entries、每 session 8MiB/64 turns/512 blocks、总量 256MiB，超限按 timestamp 排序**批量驱逐 128 条**（`enforceClaudeThinkingReplayLimitsLocked`，`:438`）——近似 LRU 而不逐条维护。启用条件：仅 API-key 直连 + Claude 兼容模型（`claude_thinking_replay.go:22-34`），scope key = `claude:{sha256(authID)[:8]}:{baseModel}` + sessionKey（`:46`）。

### Kimi clamp 特例：同协议 ≠ 同家族

`kimi_max_clamp_repro_test.go:33` 复现的问题：Kimi 以 Claude `/v1/messages` 协议提供服务但模型家族不是 Claude——`fromFormat==toFormat=="claude"` 会让能力校验误判同家族。`modelFamilyMismatch`（`validate.go:60-77`）额外比对 `modelInfo.Type`：K2.5 的 Levels 不含 max，收到 `effort=max` 时 **clamp 到 high 而非报错**；K2.8（Levels 含 max）则保留。这是"归一化中间态"设计的代价管控：格式相同不代表语义能力相同，必须以模型元数据为准。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 策略 + 注册表 | `nativeProviderAppliers` map（`apply.go:22`）+ 各 provider 包 `init()` 自注册（`provider/claude/apply.go:27`） | 新 provider 只加一个包 |
| 插件抢占注册 | `RegisterPluginProvider`（`apply.go:65`）带 owner/priority | 禁止覆盖原生名（`:73`），RWMutex 保护 |
| 模板方法式 pipeline | `applyThinking` 固定六步 | provider 只实现 Apply 一步 |
| CAS 乐观并发 | `ReplaceClaudeThinkingReplayIfUnchanged`（`cache :165`） | 冲突方静默放弃，不串行化流式请求 |
| 复用（别名） | Claude 回放直接复用 Kimi 的 `KimiThinkingReplaySnapshot`（`cache :52`）与 restore 函数 | 同骨架的第五套实例 |

## 模块间交互

**调用方**：各 format executor（meta/codex/gemini/antigravity/aistudio）在翻译完成后统一调 `helps.ApplyRequestThinking`（`model_capabilities.go:18`）；usage 日志用 `ExtractReasoningEffort`（`apply.go:565`，Codex 还会扫 input 数组里 `configuration_update` 的最新 effort，`:884`）。**cache 与五套回放**：`internal/cache` 内 claude/codex/kimi/xai/antigravity 五套 replay cache 共用同一 snapshot+CAS 骨架。**signature 与翻译矩阵**：thinking 往返是 [05-translator](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/05-translator) 的 N×M 翻译最大暗坑，签名净化挂在翻译器的请求/响应两侧。thinking 配置查询模型能力依赖 [08-registry](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/08-registry) 的 `LookupModelInfo`。

## 扩展方式

**新增 provider thinking 支持**：建 `internal/thinking/provider/<name>/apply.go` 实现 `Apply` 并 `init()` 注册；在 `apply.go:22` map 加占位、`extractThinkingConfig`（`apply.go:535`）加抽取分支、`strip.go:31` 加剥离路径、`validate.go` 的 `isBudgetCapableProvider`/`isSameProviderFamily` 视能力调整。

**调回放缓存策略**（如延长 TTL）：改 `claude_thinking_replay_cache.go:21` 常量即可；改淘汰粒度则动 `enforceClaudeThinkingReplayLimitsLocked`（`:438`）/ `appendClaudeThinkingReplayContent`（`:367`，per-session 截断从头部丢弃最旧轮）。

**调整 Level↔Budget 语义映射**：改 `convert.go:11` 的 `levelToBudgetMap` 与阈值常量（`convert.go:49-58`），全 provider 自动生效——这正是中间态设计的收益。
