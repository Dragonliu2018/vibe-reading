---
title: "github 使用技巧汇总"
date: "2026-08-23T17:10:29+08:00"
category: [Tools, Git, Notes]
alsoCategories:
  - [Tools, Notes]
tags: ["GitHub", "SSH", "版本控制", "下载加速", "技巧"]
description: "github 使用技巧汇总——新增 SSH 密钥到 GitHub 帐户、git clone 下载加速等实用配置。"
readingTime: "2 min"
aiModel: "Claude Opus 5"
reviewed: false
---

---

## Github 使用技巧

**【方法1】**
```bash
git clone \      
  -c http.postBuffer=524288000 \
  -c http.lowSpeedLimit=1000 \
  -c http.lowSpeedTime=60 \
  https://gh-proxy.com/https://github.com/radixark/miles.git
```

***

**【方法2】**

```bash title="git config 配置 ssh 替代 https"
git config --global url.ssh://git@github.com/.insteadOf https://github.com/
```

git clone 成功，若不成功，则把 `git://` 改成 `https://`。

## 新增 SSH 密钥到 GitHub 帐户

1. 生成 key，一路默认即可：

```bash title="生成 SSH 密钥"
➜  .ssh ssh-keygen
```

2. 复制 `id_rsa.pub` 文件中的内容到 GitHub：

```bash title="查看公钥内容"
➜  .ssh cat id_rsa.pub
```

![GitHub SSH 密钥设置页面](/vibe-reading/images/articles/github-usage-tips-summary/github-ssh-key-settings.png)

3. 测试是否配置成功：

```bash title="测试 GitHub SSH 连接"
➜  .ssh ssh -T git@github.com
Hi Dragonliu2018! You've successfully authenticated, but GitHub does not provide shell access.
```
