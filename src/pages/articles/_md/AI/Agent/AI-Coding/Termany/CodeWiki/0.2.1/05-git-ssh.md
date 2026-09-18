---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "Git 与 SSH"
date: "2026-09-18T15:49:56+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "Git", "SSH"]
description: "Git 集成全程 execFile 只读 porcelain 子命令（numstat 配对、未跟踪文件手工合成 diff、linked worktree 默认 vs-main）；SSH 是跑在 node-pty 里的本地 ssh 进程，端口转发复用 pane 连接本身的 ControlMaster，argv 全程防注入。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

三个文件适配两套外部世界：`git.ts`（592 行）为 diff 视图、worktree 总览和跨 worktree 会话历史提供数据；`ssh.ts`（221 行）管理 per-pane 远程主机的 profile 与连接；`sshPortForwarding.ts`（260 行）把远程 pane 监听的端口一键转发到本地 loopback。它们共同的姿态是**不引库、全程子进程 + argv**——git 是环境里唯一真源，库只会包装它并引入版本漂移；ssh 则是交互式进程直接跑在 PTY 里（package.json 无 ssh2 依赖）。

## 模块架构

```text title="Git 与 SSH 的数据流"
git.ts
├─ gitOverview(cwd, scope)     面板数据源：refs + rows + worktrees 徽章
├─ worktreeOverview(cwd)       轻量版（不算徽章，scope picker 用）
└─ gitDiffs(opts)              批量 diff（每 section 仅 2 次 git 调用）

ssh.ts                        profile CRUD / test / argv 拼装
└─ sshArgsForConnection() ──→ index.ts spawn("ssh", args, pty)
                                   │（ControlMaster=yes，pane 的 ssh 即 master）
                                   └─→ sshPortForwarding.ts
                                        ├─ listRemotePorts()   ssh -S ctl -O …远端 lsof
                                        └─ forward()/cancel()  ssh -O forward -L …
```

## 调用链路

**SSH pane 的完整链路**（index.ts:1795-1984）：`?ssh=<target>` query 取出目标 → `sshArgsForConnection()`（ssh.ts:67-72 分发器：`profile:` 前缀查 profile，否则当 OpenSSH alias）→ `sshPortForwarding.prepare()` 插入 `-o ControlMaster=yes -o ControlPersist=no -S <controlPath>` → `spawn("ssh", args, {cwd, env: ptyEnvironment()})`——**远程 pane 就是本地 ssh 客户端进程跑在 node-pty 里**，密码认证之所以可行正因为交互式 ssh 直连这个 PTY。spawn 后 `register()` 登记；`pty.onExit` 或 `killSession()` 时 `remove()`。

**端口转发的触发**：前端菜单数据来自 `GET /api/session-ports`（index.ts:1392-1423）——本地 pane 走 `sessionListeningPorts()`（lsof + 父链上行），SSH pane 走 `listRemotePorts()`；点击转发按钮 → `POST /api/ssh-port-forward` `{session, remotePort}` → `forward()` → `availableLocalPort()` 先绑**优先本地=远端同号端口**（`node:net` createServer 试绑 127.0.0.1，占用则绑 0 让内核选）→ `runForward(..., "forward", "-L 127.0.0.1:<local>:localhost:<remote>")` → 远端 URL 就能在本地浏览器打开。

## 核心实现

### git.ts：三个核心函数

执行器 `git()`（git.ts:80-90）：`execFile("git", ["-c", "core.quotepath=false", ...args], {cwd, timeout: 10s, maxBuffer: 16 MiB})`。`core.quotepath=false` 让非 ASCII 路径在 diff header 保持 UTF-8 而非八进制转义。安全边界：`DIFF_CAP` 512KB 单文件截断、`MAX_ROWS` 500、`MAX_WORKTREES` 12（每个 worktree 徽章要 3 次 git 调用）、`MAX_DIFF_FILES` 200。

**`gitOverview()`**（:390-442）：`resolveScope()` 先 `repoRoot()`（`git rev-parse --show-toplevel`）→ `listWorktrees()`——**参数里的 worktree 只有出现在 git 自己的列表里才被采用**（这同时是防目录逃逸）。基线决策（`defaultBase()`，:187-191）：仅 **linked worktree** 才默认走 base 比较（merge-base → working tree），repo 主 checkout 保持传统 staged/unstaged/untracked 视图——"那是你 commit 的地方，悄悄换成分支比较会改变面板的含义"；候选顺序是 `[mainBranch, ...FALLBACK_BASES]`，`FALLBACK_BASES = ["main", "master", "dev", "develop"]`，取第一个存在且 ≠ 自身分支的。多 worktree 时并行算徽章 `changedCount()`（:199-229）——`Promise.all` 并行 `git status --porcelain` 与（有 base 时）merge-base diff，注释解释为什么不用顺序 await：第一个 rejection 会跳过第二个 await，留下 unhandled rejection 直接打崩整个 server（场景：worktree 目录被删后 spawn git ENOENT）；有 base 分支时 porcelain 记录里的 rename/copy 旧行（状态码含 R 或 C）**跳过其旧路径 token**（`"RC".includes(record[0]) || "RC".includes(record[1])` 时 i++ 跳两格），避免同一文件被旧路径重复计数。

**`gitDiffs()`**（:532-592）：批量 diff **每个 section 只发 2 次 git 调用**（`git diff --no-color ... -- <paths>` + `git diff --numstat -z`），配对方式是靠 numstat 输出顺序与 `diff --git` chunk 顺序一致来映射路径，**而非解析 header**（含空格文件名会有歧义）；两数不等（树在两次调用间被移动）则整体放弃而非错配。`splitDiff()` 用锚定正则 `/^diff --git /m` 切分——内容行必带 `+/-/空格` 前缀，不会被文件自身文本里的标记欺骗。rename 的 oldPath 也放进 pathspec，否则 git 只报"整个新文件"。

**未跟踪文件的 diff 不调 git**（`untrackedDiff()`，:472-499）：直接 `fs.promises.open` 读头部 ≤512KB，头部 8000 字节含 NUL 判 binary，然后**手工合成** `--- /dev/null / +++ b/<path> / @@ -0,0 +1,N @@` 的全 `+` hunk。:466-470 注释解释 why：`git diff --no-index /dev/null <file>` 也能做但退出码非零且 null 设备跨平台不一致，自己拼既简单又可移植。

### "同一仓库"的识别

`listWorktrees()`（:149-172）：`git worktree list --porcelain` 按 `\n\n` 分块，**含 `bare` 行的条目被丢弃**（bare repo 没有文件可 diff）。repo 身份 = `repoRoot()` + `listWorktrees()` 的并集：前端把当前 repo 的每个 worktree 根作为重复 `root` query 传给 `/api/agent-sessions`，`agentSessions.ts` 用 `underRoot()`（纯路径段前缀匹配）过滤会话；对每个返回 session 再 `fs.stat` 检查 cwd 是否存在，不存在标 `cwdMissing`——前端据此归入 "Deleted worktrees" 并从主 checkout resume（"A deleted worktree can't be cd'd into"）。

### ssh.ts：argv 化与防注入

`sshArgsForTarget()`（:132-159）把 picker 接受的 destination 语法切分成 argv。关键决策（:125-131 注释）：**ssh 不认识 `host:port` 拼写，所以把便捷写法转成 `-p port host`；全程 argv、不 invoke shell**——杜绝命令注入。支持 bracketed IPv6 `[::1]:2222` 与单个尾冒号 port（裸 IPv6 无方括号不动——多冒号地址不匹配 `host:port` 形态正则）；拒绝 `-` 开头、控制字符（`/[\x00-\x20\x7f]/`）、>512 字符。`saveSshProfiles` 校验同样拒绝 host/user 的 `-` 开头、控制字符与 `@`；**authMethod 归一化**——只接受 `"password"` 与 `"identity"` 两个显式值，其余一律落 `"default"`；identity 方式缺 identityFile 直接抛 "identity file path is required"。`testSshProfile()`（:94-123）用 `BatchMode=yes` 探测（禁交互），按 stderr 正则归类 timeout/hostKey/passwordRequired/failed——password 模式的"需要密码"是从错误形态推断的，真实密码输入发生在 pane 的 PTY 里。

### sshPortForwarding.ts：ControlMaster 复用

`SshPortForwarding` 类**不管理任何后台 ssh 进程**——它依赖 pane 的交互式 ssh 本身以 master 身份启动（`prepare()` 在 spawn 前插入 ControlMaster 选项）。之后所有转发/探测都是一次性 `execFile("ssh", ["-S", controlPath, "-O", forward|cancel, "-L", ...])` 控制请求，复用那条已认证的连接。`controlPathFor()`（:90-94）：`/tmp/termany-ssh-<uid>-<pid>/<sha256(sessionId\0target).slice(0,20)>`，目录 0700。`ControlPersist=no` → master（pane 的 ssh）退出 socket 即消失，**转发清理零代码**——`remove()` 只删 Map 条目，本地 listener 属于 master 进程，随它死。

`listRemotePorts()`（:159-167）经 control socket 执行远端命令：`lsof -nP -a -u "$(id -un)" -iTCP -sTCP:LISTEN` → 回退 `ss -ltnHp` → 回退 `netstat`（优先能按用户过滤的工具，免得端口菜单灌满 sshd 和系统数据库）；探测有 3s TTL 缓存。`forward()` 幂等 + 并发去重（pending 中的 Promise 复用，防双击）；`createForward()`（:189-212）里若可用性检查与 ssh bind 之间输了微小竞态，**换内核随机端口重试一次**。转发目标端写死 `localhost`——仅 loopback 本地转发。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 子进程 + argv 直传 | `git()`、`sshArgsForTarget` | 无 shell 拼接 = 无注入面；git 版本由环境真源决定 |
| `-z` NUL 分隔输出解析 | `parseNumstat`/`parseNameStatus`/`splitDiff` | 机器解析不吃转义与空格的亏 |
| 贵/便宜两档视图 | `worktreeOverview` vs `gitOverview` | scope picker 不为数秒的徽章 git 买单 |
| 复用既有连接 | ControlMaster + `-O` 控制请求 | 免存密码免重认证，master 死则转发随之消失 |
| 全 try/catch 吞错返回空 | `repo: false` 空态 | 空状态不是失败，面板显示空态而非 500 |

## 模块间交互

`index.ts` 的 5 个 git 路由（worktrees/overview/diffs）与 6 个 ssh 路由（connections/profiles/from-target/test/forward/cancel）消费本模块；`/api/session-ports` 是本地（sessionPorts.ts）与远程（本模块 `listRemotePorts`）的汇合点，`isRemote()` 是分派开关。`agentSessions.ts` 不直接 import git.ts——worktree roots 由前端经 query 传入。前端消费方：`GitDiffView.tsx`（overview + 批量 diffs + viewCache）、`SshConnections.tsx`/`SshManagerDialog.tsx`（profile CRUD 与 test 状态）。

## 扩展方式

**新增一种 git 视图数据源（如 stash 列表）**：`git.ts` 加解析函数 + 导出（模式照抄 `worktreeOverview` 的判别联合 + 全吞错）；index.ts 加路由；进面板行则扩展 `GitRow`/`Section` 并同步 `gitDiffs` 的分派。对应测试 `git.test.ts`。

**新增一种 SSH 认证方式（如 agent forwarding / FIDO2）**：`SshProfile.authMethod` 联合扩值 → `saveSshProfiles` 校验分支 → `sshArgsForProfile` 加对应 `-o` 选项组 → `testSshProfile` 的 stderr 归类可能要加 status。`sshPortForwarding.ts` 无需动——它只消费 argv 产物。

**转发支持远端非 loopback 目标**：`sshForwardControlArgs` 把写死的 `127.0.0.1:${local}:localhost:${remote}` 第三段参数化（本地绑定侧保留 127.0.0.1 以免暴露局域网），路由与新字段透传。
