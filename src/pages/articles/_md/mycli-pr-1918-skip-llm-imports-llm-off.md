---
title: "堵上 LLM 导入漏洞：MYCLI_LLM_OFF 守卫补全"
source:
  project: "MyCLI"
  type: "PR"
  id: "1918"
  url: "https://github.com/dbcli/mycli/pull/1918"
  prType: "perf"
date: "2026-07-04"
category: [Database, 生态, mycli, Contributions]
tags: ["Python Import", "LLM", "启动性能", "MYCLI_LLM_OFF"]
description: "special/__init__.py 无条件导入 LLM 符号，绕过了 llm.py 和 main.py 已有的 MYCLI_LLM_OFF 守卫。本 PR 在 __init__.py 补上同等守卫，并为四个 LLM 符号提供轻量 stub，使禁用 LLM 时真正跳过模块加载。"
readingTime: "6 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1918](https://github.com/dbcli/mycli/pull/1918) · **Issue** `-` · **commit** [c1b31bd](https://github.com/dbcli/mycli/commit/c1b31bd06f0fa1411887dd4806df53b82dc5eb15) · **首发版本** v1.74.0 · **变更行数** +28 行 · **合并时间** 2026-06-06

---

## 背景

mycli 通过环境变量 `MYCLI_LLM_OFF=1` 提供 LLM 功能的全局开关。不需要 AI 辅助的用户可以设置该变量跳过 LLM 相关的重型依赖（`llm` 库及其传递依赖 `openai` 等），从而加快启动。

`llm.py` 和 `main.py` 对此已有完善的条件导入守卫：

```python title="mycli/packages/special/llm.py（已有守卫）"
try:
    if not os.environ.get('MYCLI_LLM_OFF'):
        import llm
        LLM_IMPORTED = True
    else:
        LLM_IMPORTED = False
except ImportError:
    LLM_IMPORTED = False
```

然而 `special/__init__.py` 却无条件地直接导入来自 `llm.py` 的四个符号：

```python title="mycli/packages/special/__init__.py（修复前）"
from mycli.packages.special.llm import (
    FinishIteration,
    handle_llm,
    is_llm_command,
    sql_using_llm,
)
```

这条语句会强制 Python 加载并执行 `mycli.packages.special.llm` 的全部模块级代码，绕过了其他文件精心设置的守卫，使 `MYCLI_LLM_OFF=1` 形同虚设。

---

## 前置知识

### Python 的模块加载机制

`from module import x` 不是"只取 x"——Python 必须先完整加载 `module`：解析源码、编译字节码、执行所有顶层语句（import、函数定义、类定义、赋值……）。这个过程在模块首次被导入时发生，结果缓存于 `sys.modules`。

因此：

```python
# __init__.py 执行这行
from mycli.packages.special.llm import FinishIteration
# ↑ 等价于先完整执行一遍 llm.py，再把 FinishIteration 绑定进当前命名空间
```

即便 `llm.py` 内部的 `import llm`（外部库）受 `MYCLI_LLM_OFF` 保护，`llm.py` 本身仍然被完整初始化：其函数定义、正则编译、缓存字典初始化等顶层代码全部运行。当外部 `llm` 库本身在加载时携带重型依赖（如 `openai`）且守卫失效时，代价更大。

### `MYCLI_LLM_OFF` 的作用范围

`MYCLI_LLM_OFF` 是一个进程级的约定，各模块各自检查：谁导入了外部 `llm` 库谁就守卫。但这要求每个导入点都自觉守卫——只要有一处遗漏，开关就失效。这正是本 PR 发现并修复的问题。

---

## 实现

### `__init__.py` 补上守卫

修复方案与其他文件的守卫模式完全一致：用 `if/else` 替换无条件的 `from` 导入。

```python title="mycli/packages/special/__init__.py（修复后）"
import os

# ... 其他非 LLM 符号的导入（不变）...

if not os.environ.get('MYCLI_LLM_OFF'):
    from mycli.packages.special.llm import (
        FinishIteration,
        handle_llm,
        is_llm_command,
        sql_using_llm,
    )
else:

    class FinishIteration(Exception):  # type: ignore[no-redef]
        def __init__(self, results=None):
            self.results = results

    def is_llm_command(command: str) -> bool:  # type: ignore[no-redef]
        return False

    def handle_llm(*args, **kwargs):  # type: ignore[no-redef, misc]
        raise FinishIteration(results=None)

    def sql_using_llm(*args, **kwargs):  # type: ignore[no-redef, misc]
        raise FinishIteration(results=None)
```

`if not os.environ.get('MYCLI_LLM_OFF')` 路径直接从 `llm.py` 导入真正实现；`else` 路径提供四个轻量 stub，完全不触碰 `llm.py`。

### 为什么需要 stub，而不是直接删除导入？

上游 `repl.py` 通过 `special.*` 使用这四个符号：

```python title="mycli/main_modes/repl.py（调用侧）"
while special.is_llm_command(text):      # 入口判断
    try:
        context, sql, duration = special.handle_llm(...)
        ...
    except special.FinishIteration as e: # 异常捕获
        ...
```

直接删除导入会在模块加载时抛出 `AttributeError`。Stub 保持命名空间完整，让调用侧代码不需要任何修改。

### 四个 stub 的行为设计

| 符号 | 真实实现行为 | Stub 行为 | 设计理由 |
| --- | --- | --- | --- |
| `FinishIteration` | 携带 `results` 的异常类 | 同签名异常类 | 保持 `except special.FinishIteration` 可用 |
| `is_llm_command` | 检测 `\llm`/`/llm`/`\ai`/`/ai` | 永远返回 `False` | 令 `while` 循环从不进入，是最关键的守卫点 |
| `handle_llm` | 调用外部 LLM 生成 SQL | `raise FinishIteration(results=None)` | 防御性：若误进入则安全退出 |
| `sql_using_llm` | 构造 LLM prompt 并调用 | `raise FinishIteration(results=None)` | 同上 |

`is_llm_command` 返回 `False` 是整个方案的核心：

```python title="repl.py 中 LLM 路径的完整控制流（MYCLI_LLM_OFF=1）"
while special.is_llm_command(text):   # stub → False，循环体永远不执行
    ...                                # handle_llm / sql_using_llm 从未被调用
```

`handle_llm` 和 `sql_using_llm` 的 stub 抛出 `FinishIteration` 而非 `NotImplementedError`，是因为 `FinishIteration` 已被调用侧捕获并静默处理，不会产生错误输出。

### `# type: ignore` 注释的含义

```python
class FinishIteration(Exception):  # type: ignore[no-redef]
def is_llm_command(...) -> bool:   # type: ignore[no-redef]
def handle_llm(...):               # type: ignore[no-redef, misc]
def sql_using_llm(...):            # type: ignore[no-redef, misc]
```

- `[no-redef]`：mypy 检测到同一作用域内名称被"重新定义"（实际上是在 `else` 分支中首次定义，但 mypy 的静态分析把 `if/else` 两个分支都当作一个作用域），加此注释告知忽略
- `[misc]`：mypy 不允许在 `if/else` 块内定义函数（非模块顶层），`[misc]` 压制该警告

---

## 意义与影响

这是一个**一致性漏洞**：三个文件（`llm.py`、`main.py`、`__init__.py`）共同守护同一个开关，两个文件已补全而第三个遗漏，导致守卫整体失效。

修复思路同样具有参考价值：**用守卫 + stub 替代删除**。stub 保持公共接口不变，所有调用侧代码无需修改，测试无需适配；而 `is_llm_command → False` 这一单点改动，通过既有的 `while` 循环结构就屏蔽了整条 LLM 路径，改动范围极小，副作用为零。
