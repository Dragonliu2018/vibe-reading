---
title: "docker 使用技巧汇总"
date: "2026-08-23T17:06:27+08:00"
category: [OS, Virtualization, Docker, Notes]
alsoCategories:
  - [Tools, Notes]
tags: ["docker", "容器", "镜像", "命令速查", "技巧"]
description: "docker 日常开发高频操作速查——Mac 安装、镜像加速、镜像导出导入等实用技巧汇总。"
readingTime: "2 min"
aiModel: "Claude Opus 5"
reviewed: false
---

## 安装

### mac

ref: [https://www.runoob.com/docker/macos-docker-install.html](https://www.runoob.com/docker/macos-docker-install.html)

【方法1】使用 Homebrew 安装

```bash title="Homebrew 安装 Docker"
brew install --cask --appdir=/Applications docker
```

---

【方法2】手动下载安装

- [https://docs.docker.com/docker-for-mac/install/](https://docs.docker.com/docker-for-mac/install/)

## 镜像加速

- [https://www.runoob.com/docker/macos-docker-install.html](https://www.runoob.com/docker/macos-docker-install.html)

## 导出导入镜像

```bash title="导出与导入镜像"
# 导出镜像
docker save -o doris.tar apache/doris:build-env-ldb-toolchain-latest

# 导入镜像
docker load -i doris.tar
```
