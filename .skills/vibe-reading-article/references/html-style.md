# HTML 文章样式系统

## 目录
1. [设计令牌（CSS 变量）](#设计令牌)
2. [页面骨架](#页面骨架)
3. [组件库](#组件库)
4. [文章结构约定](#文章结构约定)

---

## 设计令牌

强制使用以下变量，**不要硬编码颜色值**（深色/浅色都用这套）：

```css
:root {
  /* 背景层级 */
  --bg:        #0b0d14;    /* 主背景 */
  --surface:   #13162a;    /* 侧边栏/卡片背景 */
  --surface2:  #1d2138;    /* 次级表面 */
  --surface3:  #252840;    /* 第三级表面 */

  /* 边框 */
  --border:    #2a2e50;
  --border2:   #363b62;

  /* 文字 */
  --text:      #e2e8f0;    /* 主文字 */
  --text-muted:#7a85a3;    /* 次要文字 */

  /* 强调色 */
  --accent:    #6c8ef5;    /* 蓝色主强调 */
  --accent2:   #4ecdc4;    /* 青色 */
  --accent3:   #f9ca24;    /* 黄色 */
  --accent4:   #ff6b9d;    /* 粉色 */

  /* 代码 */
  --code-bg:   #090c14;

  /* 语义色 */
  --green:     #64ffda;
  --orange:    #f0a500;
  --red:       #ff6b6b;
  --purple:    #c792ea;

  /* 阴影 */
  --shadow-sm: 0 2px 8px rgba(0,0,0,0.4);
  --shadow-md: 0 4px 20px rgba(0,0,0,0.5);

  /* 几何 */
  --nav-w: 260px;           /* 左侧导航宽度 */
  --mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace;
  --sans: 'Noto Sans SC', -apple-system, sans-serif;
}
```

---

## 页面骨架

每篇 HTML 文章的必要结构：

```html
<!DOCTYPE html>
<html lang="zh-CN" data-pagefind-ignore="all">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>文章标题</title>
<!-- ─── 博客元信息（articles.ts 自动读取，必填）─── -->
<meta name="description" content="一句话描述">
<meta name="article:date" content="YYYY-MM-DD">
<meta name="article:category" content="code">
<meta name="article:tags" content="Tag1,Tag2,Tag3">
<meta name="article:readingTime" content="N min">
<meta name="article:aiModel" content="Claude Opus 4.8">
  <!-- Google Fonts（可选，如无网络环境去掉） -->
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Noto+Sans+SC:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    /* === 完整 CSS 粘贴到这里 === */
    /* 从 assets/html-base.html 复制 <style> 块内容 */
  </style>
</head>
<body>

<!-- ════════════ SIDEBAR/NAV ════════════ -->
<nav>
  <div class="nav-logo">
    <div class="nav-logo-title">
      <div class="nav-logo-icon">图标emoji</div>
      <div>
        <h2>文章标题（短）</h2>
        <p>版本 · 语言</p>
      </div>
    </div>
  </div>
  <ul>
    <div class="nav-section">核心</div>
    <li><a href="#overview">§1 项目简介</a></li>
    <!-- 每个 section 一个 li -->
  </ul>
</nav>

<!-- ════════════ MAIN ════════════ -->
<main>

<!-- ─── HERO ─── -->
<div class="hero">
  <h1>文章标题（完整）</h1>
  <p class="subtitle">一句话描述</p>
  <div class="meta">
    <div class="meta-item">版本 <span class="val">v1.0.0</span></div>
    <div class="meta-item">协议 <span class="val">MIT</span></div>
    <div class="meta-item">语言 <span class="val">Python ≥ 3.10</span></div>
    <div class="meta-item">代码量 <span class="val">~10,000 行</span></div>
  </div>
</div>

<!-- §1 第一节 -->
<section id="overview">
  <h2><span class="icon">🧭</span>项目简介</h2>
  <!-- 内容 -->
</section>

<!-- §N 更多节... -->

</main>

<!-- ─── FOOTER ─── -->
<footer style="...">
  <p>文章标题 · 解读文档</p>
  <p>基于 <a href="https://github.com/...">源仓库</a> · AI 生成初稿 · 人工 Review</p>
</footer>

<!-- ─── SCRIPTS ─── -->
<script>
  // 进度条
  window.addEventListener('scroll', () => {
    const pct = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
    document.getElementById('progress-bar').style.width = (pct * 100) + '%';
  });
  // 导航高亮
  const navLinks = document.querySelectorAll('nav a');
  const sections = document.querySelectorAll('section[id]');
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        navLinks.forEach(a => a.classList.remove('active'));
        const active = document.querySelector(`nav a[href="#${e.target.id}"]`);
        if (active) active.classList.add('active');
      }
    });
  }, { rootMargin: '-20% 0px -60% 0px' });
  sections.forEach(s => obs.observe(s));
</script>
</body>
</html>
```

---

## 组件库

### card-grid（特性卡片组）

```html
<div class="card-grid">
  <div class="card">
    <div class="card-title">功能名</div>
    <div class="card-desc">功能描述，简洁直接</div>
    <span class="badge badge-blue">核心文件.py</span>
  </div>
  <!-- badge 颜色：badge-blue | badge-teal | badge-yellow | badge-pink | badge-green | badge-purple -->
</div>
```

**适用**：项目简介、核心功能列举（5-8 个）

---

### code-block（代码展示）

```html
<div class="code-block">
  <div class="code-header">
    <div class="code-dots">
      <span class="dot-red"></span>
      <span class="dot-yellow"></span>
      <span class="dot-green"></span>
    </div>
    <span class="code-lang">Python · 文件路径.py</span>
  </div>
  <pre><code>class SQLExecute:
    conn: pymysql.Connection
    dbname: str
    # ... 真实代码</code></pre>
</div>
```

**注意**：`<code>` 内容不做 HTML 转义处理，`<`、`>` 需要用 `&lt;` `&gt;`

---

### tree（目录树）

```html
<div class="tree">
<span class="dir">mycli/</span>          <span class="comment"># 主包</span>
  <span class="file">main.py</span>      <span class="comment"># CLI 入口</span>
  <span class="file">config.py</span>    <span class="comment"># 配置解析</span>
  <span class="dir">packages/</span>     <span class="comment"># 工具子包</span>
</div>
```

---

### table（数据表格）

```html
<table>
  <thead>
    <tr><th>方法</th><th>查询目标</th><th>用途</th></tr>
  </thead>
  <tbody>
    <tr><td><code>tables()</code></td><td>INFORMATION_SCHEMA.TABLES</td><td>表名补全</td></tr>
    <!-- 第一列用 td:first-child 会自动加粗 -->
  </tbody>
</table>
```

---

### layer-stack（分层架构图）

```html
<div class="layer-stack">
  <div class="layer" style="background: rgba(108,142,245,0.06)">
    <div class="layer-num" style="background:#6c8ef5; color:#fff">5</div>
    <div class="layer-name" style="color:#8aabff">UI 交互层</div>
    <div class="layer-desc"><code>prompt_toolkit</code> · 语法高亮 · 快捷键</div>
  </div>
  <!-- 从上到下：层号从大到小（5→1），颜色由蓝到绿 -->
</div>
```

**颜色参考**（从上层到底层）：
- 层5：`#6c8ef5`（蓝）
- 层4：`#4ecdc4`（青）
- 层3：`#f9ca24`（黄）
- 层2：`#ff6b9d`（粉）
- 层1：`#64ffda`（绿）

---

### callout（提示/警告框）

```html
<div class="callout tip">
  <div class="callout-icon">💡</div>
  <div class="callout-body">
    <strong>设计原则</strong>
    这里是重要说明，用于强调关键设计决策或注意事项。
  </div>
</div>
<!-- type: tip | warn | info -->
```

---

### two-col（两列布局）

```html
<div class="two-col">
  <div>
    <h3>左侧标题</h3>
    <!-- 左侧内容 -->
  </div>
  <div>
    <h3>右侧标题</h3>
    <!-- 右侧内容 -->
  </div>
</div>
```

---

### flow-step（流程步骤）

```html
<div class="flow-step">
  <div class="step-num">1</div>
  <div class="step-content">
    <strong>步骤名</strong> — 步骤描述
  </div>
</div>
```

---

### stat-grid（数据统计）

```html
<div class="stat-grid">
  <div class="stat">
    <div class="stat-val">18,000</div>
    <div class="stat-label">代码行数</div>
  </div>
  <div class="stat">
    <div class="stat-val">v1.73.0</div>
    <div class="stat-label">当前版本</div>
  </div>
</div>
```

---

## 文章结构约定

### section 标记格式

```html
<!-- ══════════════════════════════════════════
     §3  分层架构
══════════════════════════════════════════ -->
<section id="layers">
  <h2><span class="icon">🏗️</span>分层架构</h2>
  <!-- 内容 -->
</section>
```

### 导航 section 分组

```html
<div class="nav-section">核心</div>
<li><a href="#overview">§1 项目简介</a></li>
<li><a href="#structure">§2 目录结构</a></li>
<div class="nav-section">架构</div>
<li><a href="#layers">§3 分层架构</a></li>
```

### 进度条（必须有）

在 `<body>` 开头添加：
```html
<div id="progress-bar" style="position:fixed;top:0;left:0;height:3px;width:0%;background:linear-gradient(90deg,var(--accent),var(--accent2));z-index:999;transition:width 0.1s;"></div>
```
