---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Skills"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "Skills", "SKILL.md", "Security"]
description: "DeerFlow 技能系统解析：SKILL.md frontmatter 声明式元数据、SkillStorage 多用户隔离、SkillScan 双层安全扫描与 skill-reviewer。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 能力扩展与沙箱](/vibe-reading/articles/AI/Agent/Harness Engineering/DeerFlow/CodeWiki/2.0.0/03-capabilities-sandbox)

---

## 模块定位

本模块属于 **能力扩展与沙箱** 子系统。DeerFlow 2.0 的核心卖点是"powered by extensible skills"——技能是可安装的声明式能力包（一个 `SKILL.md` 定义 workflow/best practices/资源引用）。本模块管技能全生命周期：发现（`_iter_skill_files`）→解析（`parse_skill_file`）→校验（`_validate_skill_frontmatter`）→安全扫描（SkillScan + LLM）→安装（`ainstall_skill_from_archive`）→存储（`SkillStorage` 多用户隔离）→激活（`SkillActivationMiddleware`）。技能可执行代码，是 prompt injection/权限提升/数据外泄载体，因此有双层安全审计。

## 核心实现

### Skill 实体（frozen dataclass）

```python title=backend/packages/harness/deerflow/skills/types.py
class SkillCategory(StrEnum):
    PUBLIC = "public"; CUSTOM = "custom"; INTEGRATION = "integrations"; LEGACY = "legacy"

@dataclass(frozen=True)
class Skill:
    name: str; description: str; license: str | None
    skill_dir: Path; skill_file: Path; relative_path: Path
    category: SkillCategory
    allowed_tools: tuple[str, ...] | None = None   # 工具白名单，None=不限制
    enabled: bool = False                          # 实际启用由 ExtensionsConfig 决定
    required_secrets: tuple[SecretRequirement, ...] = ()
    secrets_autonomous: bool = True
    # get_container_path() → /mnt/skills/{category}/{skill_path}/SKILL.md
```

frozen 保证元数据运行期不被意外修改。`allowed-tools` 是最小权限契约——slash 激活后过滤 agent 工具集。

### SkillStorage（Template Method + Strategy）

```python title=backend/packages/harness/deerflow/skills/storage/skill_storage.py
class SkillStorage(ABC):
    @abstractmethod
    def get_skills_root_path(self) -> Path: ...
    @abstractmethod
    def _iter_skill_files(self) -> Iterable[tuple[SkillCategory, Path, Path]]: ...
    @abstractmethod
    async def ainstall_skill_from_archive(self, archive_path) -> dict: ...
    # Template Method: load_skills() 骨架 = 发现→合并 enabled→排序
    def load_skills(self, *, enabled_only=False) -> list[Skill]: ...
class LocalSkillStorage(SkillStorage):  # 全局: <root>/{public,custom}/<name>/SKILL.md
class UserScopedSkillStorage(LocalSkillStorage):  # 多用户: users/{uid}/skills/custom/...
```

`get_or_new_skill_storage` 用 `resolve_class(skills_config.use, SkillStorage)` 反射实例化，LRU 缓存 per-user 实例（上限 64）。

### Frontmatter schema

```python title=backend/packages/harness/deerflow/skills/frontmatter.py
ALLOWED_FRONTMATTER_PROPERTIES = {
    "name", "description", "license", "allowed-tools", "required-secrets",
    "secrets-autonomous", "metadata", "compatibility", "version", "author",
}
```

`ALLOWED_FRONTMATTER_PROPERTIES` 是 schema 单一事实来源，runtime parser、install validator、review core 三处引用。

### analyze_skill_package

```python title=backend/packages/harness/deerflow/skills/review/analyzer.py
def analyze_skill_package(snapshot: dict, *, profile="deerflow") -> dict:
    # 产出 review-facts.v1: subject/completeness/summary/findings/resources/evals/reader_errors
    # _analyze_skill_md + build_resource_graph + analyze_eval_manifests + _scan_with_skillscan
```

## 调用链路

```
[发现] LocalSkillStorage._iter_skill_files (os.walk public/custom/integrations)
[解析] SkillStorage.load_skills (Template Method) → parse_skill_file:
       frontmatter.split_skill_markdown → YAML metadata + body
       parse_allowed_tools / parse_required_secrets → Skill dataclass
       合并 ExtensionsConfig.is_skill_enabled → enabled 状态
[校验] validation._validate_skill_frontmatter (拒绝未知字段 + 格式校验)
       review/analyzer.analyze_skill_package (结构 + 资源图 + eval + 安全)
[安全扫描] installer._scan_skill_archive_contents_or_raise:
       _scan_static (skillscan orchestrator 30+ RuleSpec, CRITICAL 阻断)
       scan_skill_content (LLM 动态审查, fail-closed 默认 block)
[安装] ainstall_skill_from_archive:
       scan_archive_preflight → safe_extract (拒绝对对路径/穿越/symlink/可执行/zlib bomb)
       → _validate_skill_frontmatter → _scan → _commit (原子移动 + 权限 0555/0444)
[激活] SkillActivationMiddleware: /skill-name → slash.resolve → 读 SKILL.md 全文
       → 注入 HumanMessage (一次性) → 绑定 required_secrets → SkillToolPolicyMiddleware 过滤工具
[运行时发现] catalog.SkillCatalog.search (select:/+前缀/自由文本 regex, 延迟发现)
       describe_skill 工具按需返回元数据（不预载系统提示）
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| Template Method | `SkillStorage.load_skills` | 基类定义发现→合并→排序骨架，子类实现原子操作 |
| 策略 | `LocalSkillStorage` vs `UserScopedSkillStorage` | 全局 vs 多用户隔离两种存储后端 |
| 工厂（反射） | `get_or_new_skill_storage` | `resolve_class(config.use)` 动态实例化 |
| LRU Cache | `_user_scoped_storages` OrderedDict | per-user 实例缓存，上限 64 |
| 仓库 | `SkillStorage` 整体 | skill 聚合根的仓库抽象 |
| Visitor | `analyze_skill_package` | 遍历 PackageSnapshot 生成 findings |
| Fail-Closed | `security_scanner._resolve_fail_closed` | LLM 不可用时默认 block |
| Specification | `skillscan._SPECS` 30+ RuleSpec | 声明式安全规则，CRITICAL 阻断 |

## 模块间交互

- **依赖**：`config`（AppConfig/SkillsConfig/ExtensionsConfig/paths）、`models`（create_chat_model 用于安全审查 LLM）、`reflection`（resolve_class）、`runtime`（user_context/secret_context）、`tracing`、`constants`。
- **被调用**：`SkillActivationMiddleware`（激活）、`SkillToolPolicyMiddleware`（工具过滤）、`gateway/routers/skills.py`（REST API）、`tools/skill_manage_tool.py`（agent 自主管理）、`review/cli.py`（上架前 review）、`subagents/executor.py`（子代理继承 skill 上下文）。
- **多用户隔离**：`UserScopedSkillStorage` 重写 `get_custom_skill_dir` 为 `users/{uid}/skills/custom/`；per-user `_skill_states.json` 存 CUSTOM/LEGACY enabled 状态（PUBLIC 仍全局由 `extensions_config.json` 管）；legacy 回退（用户首次创建自定义技能前，全局 `skills/custom/` 以 LEGACY 只读可见，shadow-mount 语义）。

## 核心实现（续）

### 为什么 frontmatter 声明式元数据

技能是可安装能力包，需机器可读元数据供发现/加载/校验/review/激活多环节消费。声明式 frontmatter 让这些环节无需解析 Markdown 正文。`ALLOWED_FRONTMATTER_PROPERTIES` 是 schema 单一事实来源。

### 为什么双层安全扫描

技能含可执行代码，是 prompt injection/权限提升/数据外泄载体。**确定性层（SkillScan）**：30+ RuleSpec 覆盖 path traversal/private key/dynamic exec/reverse shell/sensitive read+network exfil，CRITICAL 阻断，不依赖 LLM。**LLM 动态层（security_scanner）**：处理确定性规则无法覆盖的语义级威胁，fail-closed（默认 block）。安装时 `_scan_skill_archive_contents_or_raise` 对 SKILL.md 非可执行扫描，对 scripts/ 下代码严格扫描。

### 为什么 storage 分 local/user-scoped

多用户平台不隔离则用户 A 的技能出现在 B 列表、A 删除影响 B。`UserScopedSkillStorage` 路径重定向到 per-user 目录实现隔离，保留 PUBLIC 全局只读共享，legacy 回退确保单→多用户迁移不丢可见性。

### 为什么 analyze_skill_package（上架前 review）

技能包上架市场前需确定性质量审查：结构（有且仅有一个根 SKILL.md、不嵌套）、安全（symlink/嵌套归档/敏感文件 warning）、frontmatter 校验、SkillScan、资源依赖图、eval 清单。支持 `deerflow` 和 `agentskills` 两个 profile（后者跨客户端可移植性更严）。

### tool_policy 最小权限

`allowed_tool_names_for_skills` 返回激活技能 allowed-tools 并集；`filter_tools_by_skill_allowed_tools` 过滤工具；`ALWAYS_AVAILABLE_BUILTIN_TOOL_NAMES` 保留 `describe_skill`/`read_file`/`review_skill_package`/`tool_search` 四个框架工具始终可用。`SkillToolPolicyMiddleware` 确保仅启用不足以激活 policy——必须 slash 激活或 `skill_context` 加载才生效。

## 扩展方式

### 新增内置 skill

在 `<skills_root>/public/<name>/` 放 `SKILL.md`（frontmatter 含 name + description），辅助文件放 `references/scripts/templates/assets`。`LocalSkillStorage._iter_skill_files` 自动发现，无需改代码。需默认启用则在 `extensions_config.json` 加条目；需限制工具集则加 `allowed-tools`。

### 改 frontmatter 字段（如加 `priority`）

`frontmatter.py` 的 `ALLOWED_FRONTMATTER_PROPERTIES` 加 `"priority"`；`parser.py` 加 `parse_priority` + 在 `parse_skill_file` 调用；`types.py` 的 `Skill` 加字段；`validation.py` 加校验；`review/analyzer.py` 加 review 逻辑。

### 换 storage 后端（如 DB-backed）

新建 `storage/db_skill_storage.py` 继承 `SkillStorage` 实现全部 abstract method；`SkillsConfig.use` 设新类全限定名（`get_or_new_skill_storage` 反射加载）；`reset_skill_storage` 支持热重载清缓存。

对应测试：`backend/tests/skills/` + `backend/tests/skillscan/`。
