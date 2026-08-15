---
title: "Linux 内核代码贡献指南"
source:
  project: "Linux"
  type: "101"
date: "2026-08-15T20:46:47+08:00"
category: [OS, Linux, Contributions]
tags: ["Linux", "内核", "开源贡献", "patch", "git send-email", "DCO", "checkpatch"]
description: "从获取源码到 patch 合入主线——基于 Linux kernel README 与 Documentation/process 文档的完整贡献流程，含真实 i2c refcount leak 修复案例。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v7.1 · **协议** GPL-2.0 WITH Linux-syscall-note · **仓库** [torvalds/linux](https://github.com/torvalds/linux) · **在线文档** [kernel.org/doc/html/latest](https://www.kernel.org/doc/html/latest/)

---

## 总览：内核贡献与普通开源项目的区别

Linux 内核的贡献流程与大多数 GitHub 开源项目**根本不同**：

| 维度 | 普通 GitHub 项目 | Linux 内核 |
|------|-----------------|-----------|
| 提交方式 | Pull Request | **邮件**（`git send-email` 发 patch） |
| 代码托管 | GitHub | [git.kernel.org](https://git.kernel.org) + [lore.kernel.org](https://lore.kernel.org) 邮件列表存档 |
| 签署 | 无 / CLA | **DCO**（Developer Certificate of Origin，`Signed-off-by`） |
| 审查 | PR review | 邮件列表 review，`Acked-by`/`Reviewed-by` 标签 |
| 合入 | maintainer merge | 子系统维护者收 → linux-next → pull request 给 Linus |

> 内核**不接受 GitHub PR**——所有 patch 通过邮件列表提交。这是理解整个流程的第一前提。参考 [README](https://github.com/torvalds/linux/blob/master/README) 的 Quick Start 节："Join the community: https://lore.kernel.org/"。

本文基于 Linux kernel 仓库内的 `README` 与 `Documentation/process/` 系列权威文档，结合一个真实的 `i2c: qcom-cci: fix device_node refcount leak` 修复案例（已通过 `git send-email` 提交至 linux-i2c 邮件列表），完整讲解从零到提交的全流程。

---

## 第一步：环境准备与获取源码

### 1.1 构建依赖

参考 `Documentation/process/changes.rst`（"Building requirements"）和 `Documentation/admin-guide/quickly-build-trimmed-linux.rst`。以 Ubuntu/Debian 为例：

```bash title="安装构建依赖"
sudo apt install build-essential libncurses-dev bison flex libssl-dev libelf-dev
```

> `README` 的 Essential Documentation 节明确要求："Building requirements: Documentation/process/changes.rst"。

### 1.2 获取源码

```bash title="clone 内核源码"
# 完整 clone（不要用 --depth 1，否则无法获取 git tag 历史）
git clone https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git
cd linux
```

`Documentation/process/submitting-patches.rst` 第 28-44 行（"Obtain a current source tree"）要求：基于当前主线（mainline）开发，不要基于 release tarball。

### 1.3 git 身份配置（DCO 前置）

内核要求每个 patch 带 `Signed-off-by`（即签署 DCO）。配置 git 自动加签：

```bash title="git 身份配置"
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
```

> 参考 `Documentation/maintainer/configure-git.rst`。`git commit -s` 会据此自动追加 `Signed-off-by: Your Name <your@email.com>`。

---

## 第二步：阅读必读文档

`README` 的 "Who Are You?" 节按角色列出文档入口。作为**New Kernel Developer**，必读：

| 文档 | 路径 | 内容 |
|------|------|------|
| 开发流程指南 | `Documentation/process/development-process.rst` | 从 idea 到合入的完整流程 |
| 提交 patch 指南 | `Documentation/process/submitting-patches.rst` | patch 格式、commit message、DCO、发送方式 |
| 代码风格 | `Documentation/process/coding-style.rst` | 强制风格（`checkpatch.pl` 检查） |
| 构建系统 | `Documentation/kbuild/index.rst` | Kbuild/Makefile/Kconfig |
| 开发工具 | `Documentation/dev-tools/index.rst` | checkpatch/sparse/coccinelle/smatch |
| 内核 Hacking | `Documentation/kernel-hacking/hacking.rst` | 内核编程入门 |
| 核心 API | `Documentation/core-api/index.rst` | 内核核心 API 参考 |

> `README` 第 47-58 行原文："Welcome! Start your kernel development journey here: Getting Started: Documentation/process/development-process.rst, Your First Patch: Documentation/process/submitting-patches.rst ..."。

**AI 辅助贡献者额外必读** `Documentation/process/coding-assistants.rst`（见第七步）。

---

## 第三步：找一个问题来修

### 3.1 新手最佳起点：drivers/staging/

`drivers/staging/` 是"待完善"代码区，质量门槛低，专门接纳新人 patch。`README` 的 Hardware Vendor 角色指向 `Documentation/driver-api/index.rst`。

```bash title="staging 目录找 checkpatch 警告"
scripts/checkpatch.pl --no-tree -f drivers/staging/<某文件>
# 修掉每个警告，每个修复合成一个 patch
```

### 3.2 贡献类型与难度

| 类型 | 入口 | 难度 |
|------|------|------|
| 修复 checkpatch 警告 | `scripts/checkpatch.pl -f` 扫 staging | ⭐ |
| 修复编译警告 | `make W=1` / sparse / smatch | ⭐ |
| 文档改进 | `Documentation/` 下修错别字/补充说明 | ⭐ |
| 修复 bug | bugzilla.kernel.org / 邮件列表报告 | ⭐⭐ |
| 驱动小修 | `drivers/` 下熟悉的硬件驱动 | ⭐⭐ |
| 新功能/子系统 | 需先在邮件列表讨论设计 | ⭐⭐⭐⭐ |

### 3.3 真实案例：定位 i2c-qcom-cci refcount leak

以我们实际定位并提交的一个 bug 为例——通过分析近期 Fixes commit 发现 **refcount leak** 是高频类别：

```bash title="分析近期 Fixes commit 的 bug 类型分布"
git log -2000 --format="%s" | grep -iE "fix|leak|race|null|deref" | \
  sed -E 's/^[a-z]+: //' | sort | uniq -c | sort -rn | head
```

输出显示 `refcount leak`（引用计数泄漏）频繁出现。进一步用 `git log -S`（pickaxe）审查 `drivers/i2c/busses/i2c-qcom-cci.c` 的 of_node 历史，发现 commit `02a4a69667a2`（2022 年的"修复"）虽然加了 `of_node_get()` 和配对的 `of_node_put()`，但把 `of_node_put()` 放在了 `i2c_del_adapter()` **之后**——而 `i2c_del_adapter()` 末尾会 `memset(&adap->dev, 0, ...)`（`i2c-core-base.c:1849`，commit `bd4bc3dbded9` 引入）把 `adap->dev.of_node` 清零，导致 `of_node_put(NULL)` 变成 no-op，引用照漏。这是一个隐藏在"已修复"代码里 4 年未被发现的真实 bug。

> 参考 `Documentation/dev-tools/coccinelle.rst`、`Documentation/dev-tools/sparse.rst`——这些静态分析工具能自动检出此类泄漏模式。本案例通过 `git log -S` pickaxe 审查 + 源码链路追踪定位。

---

## 第四步：改代码与写 commit message

### 4.1 在独立分支上开发

**不要直接在 master 上 commit**——master 跟踪 Linus 的 origin/master，应保持干净：

```bash title="创建特性分支"
git checkout -b fix-<subsystem>-<short-description>
# 例：git checkout -b fix-i2c-qcom-cci-ofnode-leak
```

### 4.2 commit message 规则

`submitting-patches.rst` 第 45-200 行（"Describe your changes"）的核心规则：

| 规则 | 要求 | 参考 |
|------|------|------|
| 祈使语气 | `"make xyzzy do frotz"` 而非 `"this patch makes..."` | submitting-patches.rst:94 |
| 一 patch 一问题 | 逻辑变更分离，bug fix 和性能优化不能混 | submitting-patches.rst:168-200 |
| 描述用户可见影响 | crash/锁死要说明触发条件 | submitting-patches.rst:54 |
| 量化优化 | 性能改进要给数据和 trade-off | submitting-patches.rst:64 |
| 修 bug 引用 commit | `Fixes: <12位SHA> ("oneline summary")` | submitting-patches.rst:146-151 |
| 链接讨论 | 用 `lore.kernel.org` 链接 | submitting-patches.rst:120 |

`Fixes:` 标签的格式（submitting-patches.rst:151）：

```
Fixes: 54a4f0239f2e ("KVM: MMU: make kvm_mmu_zap_page() return the number of pages it actually freed")
```

> **为什么用 Fixes:**：submitting-patches.rst:606 说明 "A Fixes: tag indicates that the patch fixes a bug in a previous commit."，它让 `git bisect` 能追踪，并触发 stable kernel 自动回 port（见 `Documentation/process/stable-kernel-rules.rst`）。

### 4.3 Subject 行格式

submitting-patches.rst:377-393：

```
[PATCH Vx RESEND] sub/sys: Condensed patch summary
```

- `sub/sys:` — 子系统前缀（如 `i2c: qcom-cci:`）
- `[PATCH]` — `git send-email` 自动加
- `V2`/`V3` — 修订版（首次不加）
- `RESEND` — 仅未修改的重发（submitting-patches.rst:380-388 明确：修改后重发**不加** RESEND，改加 V2）

### 4.4 真实案例的 commit

```bash title="i2c-qcom-cci 修复的 commit（-s 加 Signed-off-by）"
git add drivers/i2c/busses/i2c-qcom-cci.c
git commit -s -F commit-msg.txt
```

commit message 内容（实际提交版）：

```text title="commit-msg.txt"
i2c: qcom-cci: fix device_node refcount leak in cci_probe()/cci_remove()

cci_probe() calls of_node_get() to take an extra reference on the
child device_node when assigning it to the adapter device.  The
matching of_node_put() calls exist in both the error cleanup path
and cci_remove(), but they are placed after i2c_del_adapter().

i2c_del_adapter() clears adap->dev with memset() at the end (commit
bd4bc3dbded9 ("i2c: Clear i2c_adapter.dev on adapter removal")), which
zeroes adap->dev.of_node before of_node_put() runs, turning it into a
no-op.  The reference taken by of_node_get() is never released, leaking
the device_node on every cleanup of already-registered adapters and
every adapter removal.

The commit that added of_node_get() and the matching of_node_put()
calls placed the puts after i2c_del_adapter(), so the bug has been
present since the fix was introduced.

Cache the pointer before calling i2c_del_adapter(), the same approach
used in i2c-mux (i2c_mux_del_adapters) and mtd (commit 56570bdad5e3
("mtd: core: Fix refcount error in del_mtd_device()")).

The of_node_put() in the i2c_add_adapter() failure path (before any
i2c_del_adapter() runs) is correct and left unchanged.

Fixes: 02a4a69667a2 ("i2c: qcom-cci: don't put a device tree node before i2c_add_adapter()")
Cc: stable@vger.kernel.org
Assisted-by: Claude:claude-opus-5
Signed-off-by: Liu Zhenlong <dragonliu2018@gmail.com>
```

> **关键点**：
> - `Fixes: 02a4a69667a2` 指向引入 bug 的 commit（2022 年那个"修复"放错了 of_node_put 位置），含 12+ 字符 SHA + 标题——这是 submitting-patches 规范要求的格式。
> - `Cc: stable@vger.kernel.org` 请求回 port 到 stable 内核（`stable-kernel-rules.rst` 规定，带 `Fixes:` 的 bug fix 可通过此标签请求 stable 回 port）。
> - 引用其他 commit 用 `commit <SHA> ("title")` 格式（`bd4bc3dbded9`/`56570bdad5e3`），这是 checkpatch 强制要求的——裸 SHA 会报 ERROR。
> - 参照同模式已有做法（`i2c-mux` 的 `i2c_mux_del_adapters`、`mtd` 的 `56570bdad5e3`），让 reviewer 容易信服。

---

## 第五步：Signed-off-by 与 DCO

`submitting-patches.rst` 第 425-470 行（"Sign your work - the Developer Certificate of Origin"）规定：每个 patch 必须有 `Signed-off-by`，即签署 DCO——声明你对代码拥有合法贡献权。

```
Signed-off-by: Random J Developer <random@developer.example.org>
```

`git commit -s` 自动追加。DCO 的法律含义（submitting-patches.rst:459）：

> "The Signed-off-by: tag indicates that the signer was involved in the development of the patch, and has the right to submit it under the applicable license."

### 多人协作的标签链

submitting-patches.rst:505-536 规定了 `Co-developed-by` + `From:` + `Signed-off-by` 的排序规则：**最后一个 `Signed-off-by` 必须是提交 patch 的人**。

---

## 第六步：风格检查与找对维护者

### 6.1 checkpatch 风格检查

`scripts/checkpatch.pl` 是强制风格检查器。参考 `Documentation/dev-tools/checkpatch.rst`：

```bash title="checkpatch 检查"
# 检查生成的 patch 文件（必须无 ERROR/WARNING）
scripts/checkpatch.pl outgoing/0001-*.patch

# 检查单个源文件
scripts/checkpatch.pl -f --no-tree drivers/i2c/busses/i2c-qcom-cci.c
```

> checkpatch.rst 原文："Checkpatch (scripts/checkpatch.pl) is a perl script which checks for trivial style violations in patches and optionally corrects them."。注意："Checkpatch is not always right. Your judgement takes precedence."——但提交时仍应力求零警告。

**真实案例的 checkpatch 陷阱**：本案例初版 commit message 引用其他 commit 时用了裸 SHA（如 `commit bd4bc3dbded9`），checkpatch 报 3 个 ERROR：

```text title="checkpatch 报错示例"
ERROR: Please use git commit description style 'commit <12+ chars of sha1> ("<title line>")' - ie: 'commit bd4bc3dbded9 ("i2c: Clear i2c_adapter.dev on adapter removal")'
```

修法：把所有裸 SHA 引用补全为 `commit <SHA> ("title")` 格式。修正后 **0 errors, 0 warnings**。

`Documentation/process/submit-checklist.rst` 是提交前的完整核对清单，建议逐条过。

### 6.2 找对维护者（关键！发错人会石沉大海）

```bash title="get_maintainer 找收件人"
scripts/get_maintainer.pl outgoing/0001-*.patch
```

输出（以 i2c-qcom-cci 为例）：

```text title="get_maintainer 输出"
Loic Poulain <loic.poulain@oss.qualcomm.com> (maintainer:QUALCOMM I2C CCI DRIVER)
Robert Foss <rfoss@kernel.org> (maintainer:QUALCOMM I2C CCI DRIVER,blamed_fixes:1/1=100%)
Andi Shyti <andi.shyti@kernel.org> (maintainer:I2C SUBSYSTEM HOST DRIVERS)
Vladimir Zapolskiy <vladimir.zapolskiy@linaro.org> (blamed_fixes:1/1=100%)
Wolfram Sang <wsa@kernel.org> (blamed_fixes:1/1=100%)
Bjorn Andersson <andersson@kernel.org> (blamed_fixes:1/1=100%)
linux-i2c@vger.kernel.org (open list:QUALCOMM I2C CCI DRIVER)
linux-arm-msm@vger.kernel.org (open list:QUALCOMM I2C CCI DRIVER)
linux-kernel@vger.kernel.org (open list)
```

收件人来自 `MAINTAINERS` 文件（`README` 第 167 行："MAINTAINERS file: Lists subsystem maintainers and mailing lists"）。其中 `blamed_fixes` 角色表示被 `Fixes:` 指向的 commit 的作者/签署者，应被 cc 通知。部分子系统有额外规则，见 `Documentation/process/maintainer-handbooks.rst`。

---

## 第七步：AI 辅助贡献的特殊规则

如果你用了 AI 工具（如 Claude）辅助开发，**必须额外遵守** `Documentation/process/coding-assistants.rst`。`README` 第 148-158 行专门为 "AI Coding Assistant" 角色设了一节：

> "CRITICAL: If you are an LLM or AI-powered coding assistant, you MUST read and follow the AI coding assistants documentation before contributing to the Linux kernel."

### 7.1 DCO 红线

coding-assistants.rst 明确：

> **"AI agents MUST NOT add Signed-off-by tags."** Only humans can legally certify the Developer Certificate of Origin (DCO).

即：
- `Signed-off-by` 由**人类**用 `git commit -s` 添加，AI 不得代签
- 人类提交者负责：审查全部 AI 生成代码、确保 GPL-2.0 合规、添加自己的 `Signed-off-by`、**承担全部责任**

### 7.2 Assisted-by 归属标签

AI 贡献需加 `Assisted-by` 标签（coding-assistants.rst:48-56）：

```
Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL1] [TOOL2]
```

- `AGENT_NAME` — AI 工具名（如 `Claude`）
- `MODEL_VERSION` — 具体模型版本（如 `claude-opus-5`）
- `[TOOL1] [TOOL2]` — 可选的专用分析工具（如 `coccinelle sparse`）
- 基础工具（git/gcc/make/编辑器）不列

示例：

```
Assisted-by: Claude:claude-opus-5
```

### 7.3 许可合规

coding-assistants.rst 要求所有代码兼容 GPL-2.0-only，使用 SPDX 标识符，详见 `Documentation/process/license-rules.rst`。

---

## 第八步：生成并发送 patch

### 8.1 生成 patch 文件

```bash title="git format-patch 生成 patch"
git format-patch -o outgoing/ HEAD~1
# 生成 outgoing/0001-i2c-qcom-cci-fix-device_node-refcount-leak-in-cci_pr.patch
```

`git format-patch` 把 commit 转成邮件格式的 `.patch` 文件（含 From/Subject/Date/commit message/diff）。

### 8.2 配置 git send-email

submitting-patches.rst:287-288："the easiest way to do this is with `git send-email`, which is strongly recommended"。交互式教程见 [https://git-send-email.io](https://git-send-email.io)（submitting-patches.rst:289 引用）。

以 Gmail 为例（需先生成 [App Password](https://myaccount.google.com/apppasswords)，不能用账户密码）：

```bash title="配置 SMTP（Gmail）"
git config sendemail.smtpserver smtp.gmail.com
git config sendemail.smtpserverport 587
git config sendemail.smtpencryption tls
git config sendemail.smtpuser your@gmail.com
git config sendemail.smtpauth PLAIN        # ⚠️ 必须大写
git config sendemail.smtppass "你的AppPassword"
git config sendemail.confirm always         # 发送前确认，防误发
```

> **真实陷阱**：`smtpauth` 的值**必须大写**（`PLAIN` / `LOGIN`），小写（`plain` / `login`）会报 `invalid smtp auth` 错误——`git send-email` 的正则校验 `/^(\b[A-Z0-9-_]{1,20}\s*)*$/` 只接受大写。本案例初版用小写 `login` 报错，改为大写 `PLAIN` 后成功。
>
> ⚠️ `smtppass` 明文存在 `.git/config` 里，发送后建议清理：`git config --unset sendemail.smtppass`。

> submitting-patches.rst:291-302 警告：如果不用 `git send-email`，需手动把 patch 作为纯文本邮件内联发送，**不能用富文本/HTML**，且编辑器的 word-wrap 会破坏 patch——这是强烈推荐 `git send-email` 的原因。参考 `Documentation/process/email-clients.rst` 配置邮件客户端。

### 8.3 发送

```bash title="git send-email 发送 patch（i2c-qcom-cci 实际发送命令）"
git send-email outgoing/0001-*.patch \
  --to loic.poulain@oss.qualcomm.com \
  --to rfoss@kernel.org \
  --to andi.shyti@kernel.org \
  --cc vladimir.zapolskiy@linaro.org \
  --cc wsa@kernel.org \
  --cc andersson@kernel.org \
  --cc linux-i2c@vger.kernel.org \
  --cc linux-arm-msm@vger.kernel.org \
  --cc linux-kernel@vger.kernel.org
```

`git send-email` 自动：
- 在 Subject 加 `[PATCH]` 前缀
- 把 patch 内联到邮件正文（不作为附件）
- 生成正确的邮件头（From/Date/Message-ID）
- 从 commit message 的 `Cc:` 标签自动追加 `stable@vger.kernel.org` 到收件人

> **本案例实际发送结果**：SMTP 返回 `250 OK`，Message-ID `<20260815140931.53297-1-dragonliu2018@gmail.com>`，patch 成功投递至 linux-i2c 邮件列表。几分钟后可在 [lore.kernel.org/linux-i2c](https://lore.kernel.org/linux-i2c/) 搜到。
>
> 注意：`git send-email` 会忽略 `Assisted-by` 标签不作为 cc 地址（输出 `Ignoring Assisted-by`），但该标签作为 patch 正文的一部分发送，收件人能看到——这是正常行为。

---

## 第九步：Review 与迭代

### 9.1 等待与礼节

submitting-patches.rst:370-372："Wait for a minimum of one week before resubmitting or pinging reviewers - possibly longer during busy times like merge windows."

### 9.2 Review 标签

| 标签 | 含义 | 参考 |
|------|------|------|
| `Acked-by` | 认可（不如 SoB 正式） | submitting-patches.rst:477 |
| `Reviewed-by` | 审查通过（较正式） | submitting-patches.rst:485 |
| `Tested-by` | 测试过 | submitting-patches.rst:539 |
| `Suggested-by` | 建议者 | submitting-patches.rst:539 |
| `Reported-by` | 报告者 | submitting-patches.rst:539 |

### 9.3 发 V2

如果维护者要求修改，改后发 `[PATCH V2]`，并在 cover letter 说明 V1→V2 改了什么：

```bash title="发 V2"
git commit --amend  # 或新 commit
git format-patch -o outgoing/ -v2 HEAD~1
# 生成 outgoing/v2-0001-*.patch
git send-email outgoing/v2-0001-*.patch --to ... --cc ...
```

> submitting-patches.rst:380-388：**修改后重发加 V2，不加 RESEND**；RESEND 仅用于未修改的重发。

---

## 第十步：合入主线

### 10.1 合入路径

```
你的邮件 patch
  → 维护者 review + Acked-by/Reviewed-by
  → 维护者收进子系统子树
  → 进入 linux-next 测试树（集成测试）
  → 维护者发 pull request 给 Linus
  → Linus 合入主线（merge window 期间）
```

参考 `Documentation/maintainer/pull-requests.rst`（维护者视角的 pull request 格式）和 `Documentation/process/development-process.rst`（完整开发周期）。

### 10.2 时间周期

- merge window：约 2 周（Linus 接受新特性）
- rc 阶段：约 6-7 周（只接受 bug fix）
- 整个周期约 2-3 个月

### 10.3 Stable 回 port

带 `Fixes:` 标签的 bug fix 在合入主线后，可能被自动回 port 到 stable 内核（如 7.1.x）。规则见 `Documentation/process/stable-kernel-rules.rst`。

---

## 完整流程速查

```bash title="从零到发送的完整命令序列"
# 1. 环境准备
git clone https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git
cd linux
git config user.name "Your Name" && git config user.email "your@email.com"

# 2. 开分支
git checkout -b fix-<subsystem>-<desc>

# 3. 改代码
# ... 编辑源码 ...

# 4. commit（-s 加 Signed-off-by）
git add <改动的文件>           # 只 add 目标文件，不要 git add -A
git commit -s -F commit-msg.txt

# 5. 生成 patch
git format-patch -o outgoing/ HEAD~1

# 6. 风格检查（必须 0 errors 0 warnings）
scripts/checkpatch.pl outgoing/0001-*.patch

# 7. 找收件人
scripts/get_maintainer.pl outgoing/0001-*.patch

# 8. 发送
git send-email outgoing/0001-*.patch --to <维护者> --cc <邮件列表>

# 9. 等 review → 改 → 发 V2
git format-patch -o outgoing/ -v2 HEAD~1
git send-email outgoing/v2-0001-*.patch --to ... --cc ...
```

---

## 参考文档索引

以下是本文引用的全部 Linux kernel 仓库内文档（路径相对仓库根，在线版可在 [kernel.org/doc/html/latest](https://www.kernel.org/doc/html/latest/) 浏览）：

| 文档 | 路径 | 用途 |
|------|------|------|
| README | `README` | 角色导航 + Quick Start |
| 开发流程 | `Documentation/process/development-process.rst` | 完整开发周期 |
| 提交指南 | `Documentation/process/submitting-patches.rst` | patch 格式/DCO/发送 |
| 提交清单 | `Documentation/process/submit-checklist.rst` | 提交前核对 |
| 代码风格 | `Documentation/process/coding-style.rst` | 强制风格 |
| 构建要求 | `Documentation/process/changes.rst` | 工具链版本 |
| 行为准则 | `Documentation/process/code-of-conduct.rst` | 社区行为 |
| AI 贡献规则 | `Documentation/process/coding-assistants.rst` | AI 辅助开发合规 |
| 安全 bug | `Documentation/process/security-bugs.rst` | 漏洞报告流程 |
| 许可规则 | `Documentation/process/license-rules.rst` | SPDX 标识 |
| Stable 规则 | `Documentation/process/stable-kernel-rules.rst` | stable 回 port |
| 邮件客户端 | `Documentation/process/email-clients.rst` | 配置邮件工具 |
| 维护者手册 | `Documentation/process/maintainer-handbooks.rst` | 子系统额外规则 |
| 快速构建 | `Documentation/admin-guide/quickly-build-trimmed-linux.rst` | 精简内核构建 |
| 报告 bug | `Documentation/admin-guide/reporting-issues.rst` | bug 报告流程 |
| checkpatch | `Documentation/dev-tools/checkpatch.rst` | 风格检查工具 |
| coccinelle | `Documentation/dev-tools/coccinelle.rst` | 模式匹配分析 |
| sparse | `Documentation/dev-tools/sparse.rst` | 静态分析 |
| Kbuild | `Documentation/kbuild/index.rst` | 构建系统 |
| 开发工具 | `Documentation/dev-tools/index.rst` | 工具总览 |
| Hacking 指南 | `Documentation/kernel-hacking/hacking.rst` | 内核编程入门 |
| 核心 API | `Documentation/core-api/index.rst` | API 参考 |
| 维护者指南 | `Documentation/maintainer/index.rst` | 维护者操作 |
| Pull Request | `Documentation/maintainer/pull-requests.rst` | PR 格式 |
| git 配置 | `Documentation/maintainer/configure-git.rst` | 维护者 git 设置 |
| 驱动 API | `Documentation/driver-api/index.rst` | 驱动开发 |
| 维护者清单 | `MAINTAINERS` | 子系统维护者+邮件列表 |
| 报告问题 | `Documentation/admin-guide/reporting-issues.rst` | 用户报 bug |

外部资源：

- [lore.kernel.org](https://lore.kernel.org/) — 邮件列表存档与搜索
- [git-send-email.io](https://git-send-email.io) — `git send-email` 交互式教程（submitting-patches.rst:289 引用）
- [kernel.org](https://kernel.org) — 最新内核源码
- [bugzilla.kernel.org](https://bugzilla.kernel.org/) — bug 跟踪
- #kernelnewbies @ irc.oftc.net — 新手 IRC（README:165）
