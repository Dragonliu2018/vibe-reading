---
title: "Hexo 使用教程"
date: "2026-08-23T17:19:21+08:00"
category: [Tools, Hexo, Notes]
tags: ["Hexo", "静态博客", "GitHub Pages", "部署", "教程"]
description: "Hexo 静态博客搭建教程——环境准备、本地运行、pure 主题配置与 GitHub Pages 部署全流程。"
readingTime: "4 min"
aiModel: "Claude Opus 5"
reviewed: false
---

---

## 环境准备

```bash title="环境与安装"
➜  nvm --version
0.39.1
➜  node -v
v24.8.0
➜  npm -v
11.6.0

# 安装 Hexo
npm install -g hexo-cli
```

## 本地运行 Hexo

1. **初始化 hexo，生成 hexo-blog 目录**

```bash title="hexo init"
hexo init hexo-blog
```

2. **进入 hexo-blog 目录，下载 pure 主题和 source 文章**

```bash title="下载主题与文章源"
cd hexo-blog

git clone https://github.com/Dragonliu2018/hexo-theme-pure.git themes/pure

# 删除默认生成的 _posts 目录
rm -rf source/_posts
git clone https://github.com/Dragonliu2018/hexo-source.git source
```

3. **配置 pure，ref link**

```bash title="安装 pure 主题依赖"
npm install hexo-wordcount --save
npm install hexo-generator-json-content --save
npm install hexo-generator-feed --save
npm install hexo-generator-sitemap --save
npm install hexo-generator-baidu-sitemap --save
npm install hexo-neat --save
npm install hexo-translate-title --save
npm un hexo-renderer-marked --save
npm i hexo-renderer-markdown-it-plus --save
npm install hexo-deployer-git --save
```

4. **修改 _config.yml**

```diff title="_config.yml 配置修改"
# 页面中分类等导航词的语言
- language: en
+ language: zh-CN

# 搜索界面的分类部分拼接 url
- url: http://example.com
+ url: https://dragonliu2018.github.io

# 设置主题
- theme: landscape
+ theme: pure

# 设置部署
deploy:
  type: git
  repo: https://github.com/dragonliu2018/dragonliu2018.github.io.git
  branch: master
```

5. **运行 hexo**

```bash title="生成并本地预览"
hexo g
hexo s
```

## 部署 Github

参考：[Hexo One-Command Deployment](https://hexo.io/docs/one-command-deployment)

1. 安装 hexo-deployer-git

```bash title="安装部署插件"
npm install hexo-deployer-git --save
```

2. 修改项目根目录 blog 下的 _config.yml

```yaml title="_config.yml 部署配置"
deploy:
  type: git
  repo: https://github.com/dragonliu2018/dragonliu2018.github.io.git
  branch: master
```

3. 部署

```bash title="部署到 GitHub Pages"
hexo g
```

## 常用命令

```bash title="Hexo 常用命令"
hexo clean
hexo g
hexo s
hexo d
```
