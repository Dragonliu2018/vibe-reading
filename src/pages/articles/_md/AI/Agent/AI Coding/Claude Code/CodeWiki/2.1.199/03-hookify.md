---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "hookify 规则引擎"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "Plugin", "Hooks", "Python", "规则引擎"]
description: "hookify——本仓唯一含实质 Python 代码的插件：Rule/Condition dataclass + RuleEngine + 4 hook 事件，用户写 markdown 规则阻止不想要的行为"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/00-overview)

---

## 模块定位

hookify 是本仓 13 个插件中**唯一含实质 Python 代码**的插件（24 文件、~2,529 行）。它让用户通过 `.claude/hookify.*.local.md` 规则文件轻松创建自定义 hook，阻止不想要的行为——无需写代码，只需编辑 markdown 的 frontmatter（声明匹配条件）+ 消息体（声明提示内容）。

它实现了一个完整的规则引擎：`Condition`/`Rule` dataclass 承载数据，`RuleEngine` 类执行匹配，4 个 hook 入口脚本分别处理 4 类事件，共用 core 层。这是理解 Claude Code hook 运行时契约（见 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture)）的最佳样本——hookify 的 stdin/stdout JSON I/O 就是运行时与 hook 进程的契约实例。

## 模块架构

```
plugins/hookify/
├── .claude-plugin/plugin.json       ← 清单（version 0.1.0）
├── hooks/
│   ├── hooks.json                   ← 4 事件注册（PreToolUse/PostToolUse/Stop/UserPromptSubmit）
│   ├── pretooluse.py                ← 入口：动态推断 event（bash/file）
│   ├── posttooluse.py               ← 入口：结构同上
│   ├── stop.py                      ← 入口：固定 event='stop'
│   └── userpromptsubmit.py          ← 入口：固定 event='prompt'
├── core/
│   ├── config_loader.py             ← Rule/Condition dataclass + frontmatter 解析 + 规则加载
│   └── rule_engine.py               ← RuleEngine + lru_cache 正则 + 6 operators
├── matchers/__init__.py             ← 包标识（预留）
├── commands/                        ← /hookify · /hookify:list · /hookify:configure · /hookify:help
├── agents/conversation-analyzer.md  ← 无参数时分析对话历史
├── skills/writing-rules/SKILL.md    ← 规则语法指导
└── examples/*.local.md              ← 4 个示例规则文件
```

4 个 hook 入口脚本结构几乎完全相同，唯一差异是传入 `load_rules()` 的 event 参数。它们共用 `core/` 层的 `Rule`/`Condition`/`RuleEngine`。

## 调用链路

以 PreToolUse 拦截 `rm -rf /tmp/test` 为例的完整调用链：

```
Claude 准备执行 Bash(rm -rf /tmp/test)
  │
  ├─ [1] 触发 PreToolUse 事件
  │      stdin JSON: {tool_name:"Bash", tool_input:{command:"rm -rf /tmp/test"}, hook_event_name:"PreToolUse"}
  │
  ├─ [2] hooks.json 路由
  │      PreToolUse → python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py (timeout:10)
  │
  ├─ [3] pretooluse.py 执行
  │      ├─ 读 CLAUDE_PLUGIN_ROOT，设 sys.path（L14-23）
  │      ├─ json.load(sys.stdin) 读 input_data（L39）
  │      ├─ 据 tool_name 推断 event："Bash"→"bash", "Edit/Write/MultiEdit"→"file"（L46-49）
  │      ├─ rules = load_rules(event="bash")
  │      └─ result = RuleEngine().evaluate_rules(rules, input_data)
  │           │
  │           ├─ [4] load_rules(): glob .claude/hookify.*.local.md → Rule.from_dict()
  │           │    过滤 event 匹配 + enabled==True
  │           │
  │           ├─ [5] evaluate_rules(): 遍历 Rule → _rule_matches()
  │           │    ├─ _matches_tool(): tool_matcher 匹配（支持 * 和 |）
  │           │    └─ 遍历 conditions → _check_condition() → _extract_field() 取值 → 按 operator 比较
  │           │    匹配的分入 blocking_rules / warning_rules
  │           │
  │           └─ [6] blocking 优先返回 deny，否则 warning 返回 systemMessage，否则 {}
  │
  ├─ [7] print(json.dumps(result)) → stdout
  └─ [8] sys.exit(0)  ← 永远 exit 0
       │
       └─ Claude Code 读 stdout JSON
          ├─ permissionDecision=="deny" → 阻止，展示 systemMessage
          └─ {} → 正常执行工具
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `RuleEngine.evaluate_rules` | `rule_engine.py` L35 | 核心入口，分 blocking/warning 累积匹配 |
| `RuleEngine._rule_matches` | L96 | 检查 tool_matcher + conditions 全 AND 匹配 |
| `RuleEngine._check_condition` | L144 | 按 operator 分发（6 种） |
| `RuleEngine._extract_field` | L182 | 多源字段提取（tool_input/特殊工具/Stop transcript） |
| `Rule.from_dict` | `config_loader.py` L45 | frontmatter dict → Rule，含 legacy pattern 升级 |
| `load_rules` | `config_loader.py` L198 | glob 规则文件 + 逐级 catch 错误 |
| `compile_regex` | `rule_engine.py` L14 | lru_cache(maxsize=128) 缓存编译正则 |

</details>

## 核心实现

### Condition / Rule dataclass

```python title="plugins/hookify/core/config_loader.py"
@dataclass
class Condition:
    field: str       # "command", "new_text", "old_text", "file_path" 等
    operator: str    # regex_match / contains / equals / not_contains / starts_with / ends_with
    pattern: str     # 匹配模式

    @classmethod
    def from_dict(cls, data):
        return cls(field=data.get('field', ''),
                   operator=data.get('operator', 'regex_match'),  # 默认 regex_match
                   pattern=data.get('pattern', ''))

@dataclass
class Rule:
    name: str
    enabled: bool
    event: str                                  # "bash" / "file" / "stop" / "all" / "prompt"
    pattern: Optional[str] = None               # 简单模式（legacy）
    conditions: List[Condition] = field(default_factory=list)
    action: str = "warn"                        # "warn" 或 "block"
    tool_matcher: Optional[str] = None
    message: str = ""                           # markdown 消息体
```

三元组设计（field/operator/pattern）将"取什么数据""怎么比较""比较什么"解耦，使同一引擎能匹配 Bash 命令字符串、文件路径、编辑内容、甚至 transcript 全文。`from_dict` 中 operator 默认 `regex_match`，省略时自动按正则匹配。

`Rule.from_dict` 实现双模式兼容：显式 `conditions` 列表（高级格式）和简单 `pattern` 字段（legacy），后者据 event 自动推断 field（`bash`→`command`、`file`→`new_text`、其他→`content`），降低用户写规则门槛。

### RuleEngine 评估与 blocking 优先

```python title="plugins/hookify/core/rule_engine.py（evaluate_rules 核心逻辑简化）"
class RuleEngine:
    def evaluate_rules(self, rules, input_data) -> Dict:
        blocking_rules, warning_rules = [], []
        for rule in rules:
            if self._rule_matches(rule, input_data):
                (blocking_rules if rule.action == 'block' else warning_rules).append(rule)
        if blocking_rules:                    # blocking 一票否决，忽略 warning
            combined = "\n\n".join(f"**[{r.name}]**\n{r.message}" for r in blocking_rules)
            # 据 hook_event_name 返回不同格式（见下文事件类型分发）
            if hook_event == 'Stop':
                return {"decision": "block", "reason": combined, "systemMessage": combined}
            elif hook_event in ('PreToolUse', 'PostToolUse'):
                return {"hookSpecificOutput": {"hookEventName": hook_event,
                        "permissionDecision": "deny"}, "systemMessage": combined}
        if warning_rules:                     # 仅 warning：合并消息但放行
            return {"systemMessage": "\n\n".join(...)}
        return {}                             # 无匹配，放行
```

**事件类型分发**（L66-84）：同一个 `evaluate_rules` 据 `hook_event_name` 返回不同 JSON 格式——`Stop` 返回 `{decision: "block", reason, systemMessage}`；`PreToolUse`/`PostToolUse` 返回 `{hookSpecificOutput: {hookEventName, permissionDecision: "deny"}, systemMessage}`；其他返回仅 `{systemMessage}`。这种差异化输出精确对应运行时对不同事件的期望格式。

### 6 operators 与多源字段提取

`_check_condition` (L144-180) 按 operator 分发：`regex_match`（调 `compile_regex` 缓存的正则 `.search()`，编译时固定 `re.IGNORECASE` 大小写不敏感）、`contains`、`equals`、`not_contains`、`starts_with`、`ends_with`。`not_contains` 特别用于 Stop 事件的"transcript 中不包含测试命令"场景（见 `examples/require-tests-stop.local.md`）。

`_extract_field` (L182-254) 实现复杂的多源提取：先查 `tool_input` 直接字段，再按 `tool_name` 特殊处理——Bash→`command`、Edit→`new_string`/`old_string`、Write→`content`、MultiEdit→拼接所有 edits 的 `new_string`；Stop 事件读 `transcript_path` 指向的 JSONL 文件；UserPromptSubmit 读 `user_prompt`。

### Fail-safe 错误处理

4 个 hook 入口脚本遵循"永不阻塞"原则：

```python title="plugins/hookify/hooks/pretooluse.py"
try:
    from hookify.core.config_loader import load_rules
    from hookify.core.rule_engine import RuleEngine
except ImportError as e:
    print(json.dumps({"systemMessage": f"Hookify import error: {e}"}))
    sys.exit(0)           # 放行，只显示错误
# ...
finally:
    sys.exit(0)           # 永远 exit 0，永不 block
```

`load_rules()` (L228-239) 对每个规则文件逐级 catch（IOError/ValueError/Exception），单文件损坏不影响其他规则加载。这与 security-guidance 的 `exit 2` 强制拦截哲学相反（见概览「核心实现 > Hook I/O 契约」）——hookify 是用户便利规则，不应因自身 bug 阻塞工作流。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| dataclass + from_dict 工厂 | `config_loader.py` L16-84 | 强类型对象，dict→对象转换，含 legacy 升级 |
| lru_cache 正则缓存 | `rule_engine.py` L14 `compile_regex` | 避免重复 `re.compile`，maxsize=128 远超典型用量 |
| 声明式规则文件 | `.local.md` frontmatter + body | 用户写 markdown 不写代码，`.local.md` 后缀表"本地不提交" |
| blocking 优先策略 | `rule_engine.py` L50-94 | 一票否决，warning 不淹没 blocking 决策 |
| 事件类型分发 | L66-84 | 同引擎据事件返回不同 JSON 格式 |
| Fail-safe 降级 | 4 入口脚本 `finally: exit(0)` | hook 出错不阻塞用户 |

## 模块间交互

hookify 与 Claude Code hook 运行时的契约是**跨进程 stdin/stdout JSON**（见 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) 的 I/O 契约表）。规则文件定位用相对路径 `glob.glob(".claude/hookify.*.local.md")`——依赖 hook 进程的 cwd（用户项目根），而非 `${CLAUDE_PLUGIN_ROOT}`，意味着规则存在用户项目的 `.claude/` 下，与插件代码分离。commands 层（`/hookify` 等命令）要求先加载 `writing-rules` skill，形成"skill 提供语法参考 + command 提供操作流程"的协作。

## 扩展方式

新增一种 operator（如 `not_regex_match`）：改 `rule_engine.py` `_check_condition` if-elif 链加分支 + `skills/writing-rules/SKILL.md` Operators 部分加说明 + `README.md` Operators Reference 表格加条目。`Condition.from_dict` 只原样存储 operator 字符串，无需改 `config_loader.py`。

让规则支持多条件 OR 组合：当前 `_rule_matches` 隐式 AND（全匹配才 True）。改 `Rule` dataclass 加 `logic: str = "and"` 字段 + `Rule.from_dict` 读取 + `_rule_matches` 据 `rule.logic` 切换 AND/OR。嵌套 AND/OR 需将 Condition 升级为树结构，改动量大。

> 注意：hookify 每次工具调用启动新 Python 进程，`lru_cache` 只在单次执行内有效（跨调用不复用）。`maxsize=128` 对单次 `evaluate_rules` 内的重复 pattern 足够，跨调用的进程启动开销（~30-50ms）由 `timeout:10` 容纳。
