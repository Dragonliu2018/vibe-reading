---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "示例与部署"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "GCP", "Terraform", "MDM", "CI", "settings"]
description: "部署示例与基础设施——GCP gateway 反向代理、企业 MDM 托管、settings 权限预设、CI issue 自动化、devcontainer 隔离"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/00-overview)

---

## 模块定位

本模块覆盖插件的部署、企业治理与仓库运维——与插件逻辑正交的基础设施层。四类示例对应不同部署场景：`gateway/gcp`（GCP 反向代理部署）、`mdm`（macOS/Windows 企业托管）、`settings`（权限预设三档）；`scripts/` + `.github/workflows/` 是仓库自身的 issue 管理自动化；`.devcontainer` 提供隔离开发环境。这些资产展示了 Claude Code 如何在生产与企业环境中被部署与治理。

## 模块架构

| 示例/基础设施 | 路径 | 技术栈 | 场景 |
|---------------|------|--------|------|
| gateway/gcp | `examples/gateway/gcp/` | Terraform + Docker + Cloud Run | GCP 反向代理部署 |
| hooks 示例 | `examples/hooks/` | Python | hook 编写范本 |
| MDM 托管 | `examples/mdm/` | mobileconfig + admx/adml + PowerShell | macOS/Windows 企业托管 |
| settings 预设 | `examples/settings/` | JSON | strict/lax/bash-sandbox 权限 |
| CI workflows | `.github/workflows/` | YAML + TS | issue 自动化（12 个 workflow） |
| scripts | `scripts/` | TypeScript + Bash | issue 管理 + 运维 |
| devcontainer | `.devcontainer/` | Dockerfile + shell | 隔离开发 + firewall |

## 调用链路

### GCP gateway 部署拓扑

```
examples/gateway/gcp/
├── Dockerfile              ← COPY 预构建的 Claude Code binary 到镜像（不在镜像内构建）
├── setup.sh                ← 下载 binary + sha256 校验 + 配置 gateway
├── gateway.yaml.example    ← gateway 配置
├── README.md
└── terraform/
    ├── main.tf             ← Cloud Run + IAM + 网络
    ├── variables.tf        ← 入参 + validation
    ├── outputs.tf
    ├── versions.tf
    └── terraform.tfvars.example
```

部署拓扑：Terraform 在 GCP 部署 Cloud Run 服务运行 gateway 镜像，gateway 运行自己的 OIDC 认证，Cloud Run IAM 层控制访问。客户端经 gateway 代理访问 Claude Code。

### MDM 托管机制

| 平台 | 文件 | 管理方式 |
|------|------|----------|
| macOS | `com.anthropic.claudecode.mobileconfig` + `.plist` | mobileconfig 描述文件 + plist 键值 |
| Windows | `ClaudeCode.admx` + `en-US/ClaudeCode.adml` + `Set-ClaudeCodePolicy.ps1` | 组策略模板（admx/adml）+ PowerShell 脚本 |
| 通用 | `managed-settings.json` | 企业强制配置（与用户 settings.json 的关系：企业强制 vs 用户可改） |

`managed-settings.json` 与原生 `settings.json` 的关系：managed settings 优先级最高（见 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) 权限层级），企业可通过 MDM 下发强制策略，用户级和项目级权限被 `allowManagedPermissionRulesOnly` 忽略。

### settings 权限三档预设

| 预设 | 文件 | 策略 |
|------|------|------|
| strict | `settings-strict.json` | `allowManagedPermissionRulesOnly` + `allowManagedHooksOnly` + `strictKnownMarketplaces`（空数组=无 marketplace） |
| lax | `settings-lax.json` | 仅禁 `--dangerously-skip-permissions` + block plugin marketplaces，不限制 hooks/权限 |
| bash-sandbox | `settings-bash-sandbox.json` | `allowManagedPermissionRulesOnly` + `allowUnsandboxedCommands: false` + sandbox 网络隔离与域名白名单 |

### CI issue 自动化

`.github/workflows/` 含 12 个 workflow，核心协作链：

```
issue opened（GitHub 事件，各 workflow 独立触发）
  ├─ claude-issue-triage.yml      Claude 给 issue 打标签（on: issues:[opened]）
  ├─ claude-dedupe-issues.yml     Claude 检测重复 issue（on: issues:[opened]）
  ├─ claude.yml                   Claude 处理 issue/PR
  └─ issue-opened-dispatch.yml    向 TARGET_REPO 发 repository_dispatch（跨仓库转发，非内部分发）
issue lifecycle → issue-lifecycle-comment.yml + sweep.yml + auto-close-duplicates.yml
  └─ 重复 issue 自动评论 + 自动关闭（作者可👎阻止）
PR 改 .github/ → non-write-users-check.yml
  └─ 检查是否新增 allowed_non_write_users，发安全警告
```

`scripts/*.ts`（TypeScript）实现 issue 管理逻辑：`auto-close-duplicates.ts`、`issue-lifecycle.ts`、`sweep.ts`、`lifecycle-comment.ts`、`backfill-duplicate-comments.ts`。

<details>
<summary>CI 安全速查表</summary>

| 机制 | 位置 | 作用 |
|------|------|------|
| `CLAUDE_CODE_SCRIPT_CAPS` | `claude-issue-triage.yml` L34 | 限制 Claude 可执行的 shell 脚本及最大参数数 |
| `gh.sh` | `scripts/gh.sh` | 限制 gh CLI 只允许 4 个只读子命令 |
| `non-write-users-check.yml` | `.github/workflows/` | PR 改 `.github/**` 时检查新增 `allowed_non_write_users` |
| 重复 issue 逃生 | `comment-on-duplicates.sh` L88 | 作者可评论或👎阻止自动关闭 |

</details>

## 核心实现

### gateway 的安全设计

**Binary 双重 sha256 校验**（`setup.sh` L182-216）：下载的 Claude Code binary 先用 release manifest 校验（L182-209），再用可选 `CLAUDE_SHA256` out-of-band pin 校验（L210-216）。manifest 与 binary 同源无法防御 endpoint 被攻陷，`CLAUDE_SHA256` 弥补此缺口。下载过程 `trap 'rm -f "${CLAUDE_BINARY}"' EXIT INT TERM` 确保部分下载不会被后续运行静默使用（校验通过后 `trap - EXIT INT TERM` 清除）。

**拒绝公网 ingress**（`setup.sh` L112-116 + `variables.tf` L159-166）：Claude Code 的 `/login` 只接受 private address 的 gateway hostname，公网 ingress 无法服务客户端。setup.sh 和 terraform variables 都做了 validation 拒绝非 internal ingress。

**Cloud Run invoker IAM 三路径**（`main.tf` L384-399 + `variables.tf` L168-178）：gateway 运行自己的 OIDC，Cloud Run IAM 层必须打开。优先 `invoker_iam_disabled=true`（无 allUsers binding，Domain Restricted Sharing 下可用）；回退 `allow_unauthenticated=true`（allUsers run.invoker，DRS 组织会拒绝）；两条路都走不通则用 GKE track。

**Secret 在 tfstate**（`main.tf` 多处 nosemgrep 注释，如 L132/161/199）：承认 TF state 含 secret 是 inherent 的，通过 README 推荐的 remote GCS backend + 禁止 commit state 缓解。`random_password` 用 `special=false` 确保密码 URL-safe 直接嵌入 connection string。

### CI 的 Claude 驱动 workflow 安全

`CLAUDE_CODE_SCRIPT_CAPS` 环境变量精确限制 Claude 可执行的 shell 脚本及最大参数数（`claude-issue-triage.yml` L34 + `claude-dedupe-issues.yml` L31）：triage 只能调 `edit-issue-labels.sh`（max 2 args），dedupe 只能调 `comment-on-duplicates.sh`（max 1 arg）。`gh.sh` 进一步限制 gh CLI 只允许 4 个只读子命令。这是"最小权限"在 CI 场景的应用——Claude 在 workflow 中只能做被严格限定的事。

`non-write-users-check.yml`：PR 修改 `.github/**` 时检查是否新增 `allowed_non_write_users`，如检测到则发安全警告评论提示 AppSec team 审查。防止非 write 权限用户获得 Claude 触发能力带来的安全风险。

### Issue 重复检测的逃生机制

`comment-on-duplicates.sh` L88-89 + `auto-close-duplicates.ts` L228-241：dup 评论中明确告知作者可"评论或 👎 阻止自动关闭"。`auto-close-duplicates.ts` 检查 issue 作者是否对该评论 thumbs_down，若是则跳过关闭；同时检查 dup 评论后是否有新评论，有则跳过。这确保误判不会导致 issue 被错误关闭。

### DevContainer firewall 双向验证

`init-firewall.sh` L124-137 末尾双向验证——确认 `example.com` 不可达（防火墙生效）+ `api.github.com` 可达（白名单正确）。任一验证失败则 `exit 1`，`devcontainer.json` 的 `waitFor: "postStartCommand"` 确保 firewall 就绪前不连接容器。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 声明式部署 | Terraform `main.tf` | 基础设施即代码，可版本化、可审查 |
| 双重校验 | `setup.sh` sha256 + out-of-band pin | manifest 同源不防 endpoint 攻陷，out-of-band 补 |
| 最小权限 CI | `CLAUDE_CODE_SCRIPT_CAPS` + `gh.sh` | 限制 Claude 在 workflow 中的执行边界 |
| 逃生机制 | dup issue 👎 阻止 | 误判可挽回，避免错误关闭 |
| 双向验证 | `init-firewall.sh` | 确认防火墙生效且白名单正确 |
| 多平台对等 | MDM macOS + Windows | 企业环境统一治理 |

## 模块间交互

`examples/settings` 的权限预设治理所有插件的工具边界（见 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) 权限层级）。`examples/hooks/bash_command_validator_example.py` 是 hook 编写的范本，与 [03-hookify](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/03-hookify) 的 hook 实现呼应。CI workflows 中的 `claude.yml` 让 Claude 自己处理 issue/PR——Claude Code 既是被部署的对象，也是仓库运维的执行者（自指性）。

## 扩展方式

gateway 部署到 AWS：新建 `examples/gateway/aws/`，写 Terraform（Lambda/ECS + ALB 替代 Cloud Run）+ Dockerfile 复用 + setup.sh 适配 AWS binary 下载。保留 sha256 双重校验与拒绝公网 ingress 的安全设计。

加一种 MDM 策略键：macOS 在 `com.anthropic.claudecode.mobileconfig`/`.plist` 加键，Windows 在 `ClaudeCode.admx`/`.adml` 加策略定义，`managed-settings.json` 加对应字段。

新增一个 settings 预设（如 `settings-read-only.json`）：复制 `settings-strict.json`，调整 `permissions.allow/deny` 规则实现只读工作流。

> 仓库无正式 test 目录（见概览「测试体系」），CI workflow 的 YAML 本身与 `scripts/*.ts` 的 issue 管理逻辑是本模块最接近"可执行验证"的部分。
