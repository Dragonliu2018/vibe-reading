---
title: "git 使用技巧汇总"
date: "2026-08-23T16:14:54+08:00"
category: [Tools, Git, Notes]
alsoCategories:
  - [Tools, Notes]
tags: ["git", "版本控制", "命令速查", "分支管理", "技巧"]
description: "git 日常开发高频操作命令速查——修改提交、撤销、分支管理、patch、tag、远程仓库等实用技巧汇总。"
readingTime: "3 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **Git** 分布式版本控制系统 · **内容** 日常开发高频操作命令速查 · **整理** 个人 AI 生成笔记

---

## 将当前修改压到 HEAD commit

```bash title="amend 最近一次提交"
git commit --amend
```

## 取消某个文件的更改

```bash title="丢弃工作区修改"
git checkout -- <file_name>
```

参考：https://blog.csdn.net/qq_32907195/article/details/115333898

## 删除某个文件(夹)

```bash title="git rm 删除文件"
# 推荐
git rm <file_name>

# 相当于
rm <file_name>
git add <file_name>
```

## ignore 已经 push 到远端的文件

**【问题】** .vscode 文件夹已经 push 到远程，如何 ignore？

**【解决】** 
1. 从 Git 索引中移除 .vscode 目录（不会删除本地文件夹，只是让 git 不再跟踪它）：

```bash title="从索引移除已跟踪目录"
➜  SG-DQA git:(main) git rm -r --cached .vscode
rm '.vscode/launch.json'
rm '.vscode/settings.json'
```

2. 添加 .gitignore 文件

```text title=".gitignore"
.vscode/
```

3. git add & git commit & git push

将上述改动提交并推送到远程，完成忽略已跟踪文件的流程。

## 合并多个 commit

![git rebase -i 交互式编辑器界面](/vibe-reading/images/articles/git-usage-tips-summary/rebase-interactive.png)

```bash title="交互式 rebase 合并提交"
# method-1
git rebase -i origin/main
# method-2
git rebase -i ce75153a87
# method-3: 与要合并的commit数量一致
git rebase -i HEAD~8
```

## patch

```bash title="生成与应用 patch"
git diff > xx.patch
git apply x.patch
```

## 本地分支 & 远程分支

```bash title="本地与远程分支关联"
# 查看本地分支关联（跟踪）的远程分支之间的对应关系
git branch -vv

# 推送当前分支到远程（没有对应分支）
git push -f --set-upstream origin dragonliu/dictionary_mysql_opt

# 设置本地分支与远程分支的关联
git branch --set-upstream-to=origin/<远程分支名>
```

## 修改分支名

```bash title="修改分支名"
# 修改本地分支名称
git branch -m oldBranchName newBranchName

# 将本地分支的远程分支删除
git push --delete origin oldBranchName

# 将改名后的本地分支推送到远程，并将本地分支与之关联
git push --set-upstream origin newBranchName
```

## 删除分支

```bash title="删除分支"
# 删除本地分支
git branch -D fix/authentication

# 删除远程分支
 git push origin --delete fix/authentication
```

## 撤销 commit

```bash title="撤销 commit"
# 撤销本地 commit
git reset --soft HEAD^

# 撤销远程 commit
git reset HEAD^
git push -f
```

## 修改远程仓库链接

```bash title="修改远程仓库地址"
git remote set-url origin git@github.com:Dragonliu2018/doris.git
```

## 切换 tag

```bash title="切换到 tag"
# 查看对应 tag 的代码，这时候 git 可能会提示你当前处于一个“detached HEAD” 状态。
# 因为 tag 相当于是一个快照，是不能更改它的代码的。
git checkout tag_name

# 基于 tag commit 进行修改
# 如果要在 tag 代码的基础上做修改，你需要一个分支
git checkout -b branch_name tag_name
```

## 计算两个 commit 的距离

```bash title="计算两个 commit 的距离"
git rev-list 2.1.8-rc01..2.1.11-rc01 --count
```

## 提取某个区间的 commit 信息

```bash title="提取区间 commit 信息"
# mac
git log old_commit_id..HEAD --pretty=format:"%h %an %s" | tail -r > output.txt

# linux
git log old_commit_id..HEAD --pretty=format:"%h %an %s" | tac > output.txt
```

## 从其他仓库拉取代码

```bash title="从其他仓库拉取代码"
git remote add apache https://github.com/apache/doris.git
git fetch apache
git checkout -b master-211 2.1.1-rc01
```
