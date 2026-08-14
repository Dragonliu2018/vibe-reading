---
source:
  type: "源码解读"
  project: "fish-shell"
  url: "https://github.com/fish-shell/fish-shell"
title: "执行与进程"
date: "2026-08-14T11:44:53+08:00"
category: ["Tools", "fish-shell", "CodeWiki", "4.8.1"]
tags: ["fish-shell", "Rust", "Execution", "JobControl", "Fork"]
description: "fish 的执行与进程模块：AST → Job/Process 翻译、5 阶段展开、fork/exec/posix_spawn、作业控制与 generation-count 进程回收。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/fish-shell/CodeWiki/4.8.1/00-overview)

---

## 模块定位

解析引擎产出 AST，但 AST 只是静态结构——真正"让命令跑起来"的是本模块。它把 AST 翻译成 `Job`/`Process`，处理变量/通配展开、I/O 重定向、fork/exec 外部进程、作业控制。这是 fish 中最贴近操作系统的子系统。god node 密集：`Job`（77 度）、`Process`（68 度）、`IoStreams`（196 度）、`OperationContext`（73 度）。

覆盖 `src/parse_execution.rs`、`src/exec.rs`、`src/proc.rs`、`src/expand.rs`、`src/io.rs`、`src/redirection.rs`、`src/fork_exec/`、`src/job_group.rs`、`src/wait_handle.rs`、`src/operation_context.rs`，约 9,900 行。

## 模块架构

```
   ParsedSourceRef (AST)  ←  解析引擎
          │
          ▼
   ExecutionContext           parse_execution.rs
   { pstree, block_io, cancel_signal }
          │  eval_node 遍历 AST
          ▼
   ┌──────────────────────────────────┐
   │  Job 翻译                          │
   │  populate_job_from_job_node        │  parse_execution.rs:1796
   │  → Process[] (管道每个 statement)  │
   │  → process_type_for_command        │  (Function>Builtin>External)
   └─────────────┬────────────────────┘
                 │
        ┌────────┴───────┐
        ▼                ▼
   expand.rs         exec.rs
   5 阶段展开         exec_job 分派
   (变量/通配/         ├─ External → fork_exec
    命令替换/tilde)     ├─ Builtin  → builtin_run
                       └─ Function → 递归 eval
                 │
                 ▼
   ProcStatus → $status (proc.rs)
```

`ExecutionContext` 是 AST 到执行的桥接（`parse_execution.rs:76`），持有 `pstree`、`cancel_signal`、`block_io`。`OperationContext`（`operation_context.rs:34`）是"属性包"，封装变量环境、展开上限、取消检查器——解耦"需要什么"与"从哪获取"，让展开/补全/高亮在没有完整 Parser 时也能工作。

## 调用链路

```
ExecutionContext::eval_node()              in parse_execution.rs:137
 └─ eval_job_list → run_job_list          in parse_execution.rs:1768
     └─ run_job_conjunction → run_1_job   in parse_execution.rs:1520
         ├─ job_is_simple_block 优化?      (无重定向简单 block 直接 run_block_statement，
         │                                  跳过 Job/Process 构建，省一次管道装配)
         ├─ populate_job_from_job_node    in parse_execution.rs:1796
         │   └─ populate_job_process      in parse_execution.rs:657
         │       └─ populate_plain_process in parse_execution.rs:711
         │           ├─ expand_command     (expand.rs 展开 $var/*/(cmd)~)
         │           ├─ process_type_for_command  in parse_execution.rs:573
         │           └─ determine_redirections    (重定向 spec)
         ├─ setup_group                    in parse_execution.rs:1871 (JobGroup)
         └─ exec_job(parser, &job, block_io) in exec.rs:87
             └─ exec_process_in_job        in exec.rs:1247
                 match p.typ {
                   External → exec_external_command  in exec.rs:870
                     (posix_spawn 或 fork_child_for_process)
                   Builtin  → exec_builtin_process   in exec.rs:1212
                     (get_performer_for_builtin → builtin_run)
                   Function/BlockNode → exec_block_or_func_process in exec.rs:1078
                     (get_performer_for_function → parser.eval_node 递归)
                 }
```

数据类型流转：`ParsedSourceRef` → `ExecutionContext` → `Job`（含 `Box<[Process]>`）→ 每个Process 展开 `cmd: WString, argv: Vec<WString>` → `exec_job` 建 pipe → 分派 → `ProcStatus`（`from_waitpid`/`from builtin`）→ `EvalRes { status, ... }` → `$status`。

## 核心实现

### ProcessType 与派发优先级

`ProcessType` 枚举（`proc.rs:54`）区分 `External`/`Builtin`/`Function`/`BlockNode`/`Exec`。`process_type_for_command`（`parse_execution.rs:573`）按 statement 装饰决定：

```rust title="parse_execution.rs:573"
match statement.decoration() {
    StatementDecoration::Command => ProcessType::External,  // command 前缀强制外部
    StatementDecoration::Builtin => ProcessType::Builtin,   // builtin 前缀强制内建
    StatementDecoration::Exec    => ProcessType::Exec,
    StatementDecoration::None => {
        if function::exists(cmd, parser) { ProcessType::Function }   // 函数优先
        else if builtin_exists(cmd)       { ProcessType::Builtin }
        else                                { ProcessType::External }
    }
}
```

**函数优先于内建**意味着用户可用 `function` 覆盖同名内建命令的行为（如包装 `cd`）。`command` 装饰符跳过函数和内建直连外部，`builtin` 跳过函数直连内建。

### Job 与 Process 的关系

一条管道是一个 `Job`，含多个 `Process`。`populate_job_from_job_node`（`parse_execution.rs:1796`）遍历 AST 的 `JobPipeline` + 续行，为每个 statement 创建一个 `Process`，进程间用 `pipe_write_fd` 与 `pipes.read` 连接。`Job` 封装共享状态：进程组、统一 I/O 管理、一起等待完成。`JobGroup`（`job_group.rs:61`）承载进程组级共享状态（tmodes、job_control、pgid、job_id），`create_with_job_control`（`job_group.rs:246`）决定是否启用作业控制。

### process_net_io_chain 构建顺序

`exec_process_in_job`（`exec.rs:1289`）为每个进程构建 `process_net_io_chain`，顺序为：继承的 `block_io` → 管道写入端 `pipe.write` → 重定向 specs（`<`/`>`/`>>`）→ 管道读取端 `pipe.read` → 延迟管道关闭。读取管道放最后追加，是因为 `dup2_list_resolve_chain`（`exec.rs:882`）按链顺序生成 dup2 序列，后追加的 fd 操作覆盖同 fd 的前序设置——确保进程从上游管道读、向自身重定向写，顺序正确避免覆盖。`exec_job`（`exec.rs:148`）的管道循环最多让 3 个 pipe 同时在飞，每对进程用 `make_autoclose_pipes`（`exec.rs:156`）建管道。

### 5 阶段展开流水线

`Expander::expand_string`（`expand.rs:1194`）定义 5 个阶段按序执行：

1. `stage_cmdsubst` → `expand_cmdsubst` 命令替换 `echo (date)`
2. `stage_variables` → `expand_variables` 变量展开 `$HOME`/`$arr[1..3]`
3. `stage_braces` → `expand_braces` 花括号 `a{b,c}d`
4. `stage_home_and_self` → `expand_home_directory` tilde `~user`
5. `stage_wildcards` → `expand_wildcard` 通配符 `*.txt`

每阶段对上一阶段的所有输出逐条处理，支持 `ctx.check_cancel()` 取消检查与 `expansion_limit` 上限保护（前台 512k，后台 512）。

### fork_exec 为何独立成模块

`fork_exec/` 的注释说明：处理 posix_spawn 与 **fork 后到 exec 前的 async-signal-safe 代码**。分离原因：fork 后、exec 前的代码处于 async-signal-unsafe 上下文——不能分配内存、不能加锁、不能用 std 库大部分功能。`flog_safe.rs`（整文件）提供只用 `libc::write` 的日志替代（`flog_safe!` 宏）。`postfork.rs` 含所有 fork 后操作：`execute_fork`（重试 5 次）、`execute_setpgid`（处理 WSL EPERM bug）、`child_setup_process`（dup2/close/tcsetpgrp/sigprocmask）。终端控制权在**子进程内**设置（`postfork.rs:162`），注释说避免父子进程 tcsetpgrp 的经典竞争。

### 内部进程与 performer 闭包

builtin/function/block 用线程而非 fork 实现（`InternalProc` in `proc.rs:243`）。`get_performer_for_builtin`/`_for_function`/`_for_block_node`（`exec.rs:1018-1209`）构造 `ProcPerformer` 闭包——注释（`exec.rs:1013`）明说 "factored out in this funny way in preparation for concurrent execution"。输出经 `IoBufferfill`（`io.rs:303`）通过 `fd_monitor` 后台线程异步读入 `SeparatedBuffer`。延迟进程模式（`get_deferred_process` in `exec.rs:1394`）把管道中"最后一个内部进程"延后启动，避免管道缓冲区阻塞。

### generation-count 进程回收

每个 `Process` 保存 `GenerationsList`（`proc.rs:384`），记录三个 Topic 的 generation：`SigChld`/`SigHupIntTerm`/`InternalExit`。`process_mark_finished_children`（`proc.rs:1202`）通过 `topic_monitor_principal().check()` 比较 generation，仅当有变化才调 `waitpid`——避免无谓系统调用。这是 `topic_monitor` 提供的事件驱动 reaping。

`ProcStatus`（`proc.rs`）区分三种终止方式，`status_value()`（`proc.rs`）将其转为 `$status`（i32）：正常退出返回退出码、被信号杀死返回 `128 + 信号号`（标准 shell 约定）、停止（SIGSTOP）不产生终端 `$status`。构造器 `ProcStatus::from_exit_code`/`from_signal`/`from_waitpid`（`proc.rs`）分别从原始码构造，`is_success()` 判断是否成功（exit code 0）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 状态机 | Process `completed`/`stopped` 字段 `proc.rs:396` | 隐式三态（运行/完成/停止），`handle_child_status` 转移 |
| 策略 | `exec_process_in_job` match ProcessType `exec.rs:1356` | External/Builtin/Function 统一接口不同实现 |
| 命令 | `ProcPerformer` 闭包 `exec.rs:1014` | 分离"执行什么"与"如何处理输出"，为并发执行铺路 |
| 延迟初始化 | `get_deferred_process` `exec.rs:1394` | 延后管道末尾内部进程，避免缓冲阻塞 |

## 模块间交互

上游：被 `Parser::eval_node`（`parser.rs`）驱动，命令替换 `expand_cmdsubst` 反向调 `exec_subshell_for_expand`（`exec.rs:293`）。下游：依赖 `ast`（遍历 AST）、`env`（`OperationContext::vars` + `export_array` 构 envp）、`builtins`（`builtin_run`）、`function`（`function::exists`/`get_props`）、`reader`（`reader_schedule_prompt_repaint` 触发重绘）、`threads`（`exec_thread_pool` 后台写入）、`fd_monitor`（`IoBufferfill`）、`signal`/`topic_monitor`（reaping）、`wutil`（文件操作）。`fork_exec` 是唯一接触 `unsafe` 系统调用的地方。

## 扩展方式

- **新增进程类型**：`proc.rs` `ProcessType` 加变体 → `parse_execution.rs:573` `process_type_for_command` 加识别 → `exec.rs:1356` match 加分支实现 `exec_xxx_process`
- **修改展开规则**：`expand.rs:1174` `Expander::expand_string` 的 stages 数组加阶段，或改 `expand_variables`（`expand.rs:522`）
- **修改作业控制**：`fork_exec/mod.rs:14` `blocked_signals_for_job` + `job_group.rs:206` `create_with_job_control` + `parse_execution.rs:1900` `use_job_control`
