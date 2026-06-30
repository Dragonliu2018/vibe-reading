/**
 * code-block.ts — 代码块交互增强
 * 包含：macOS 标题栏、语言切换（highlight.js）、折叠、折行、复制
 */

(function enhanceCodeBlocks() {
  const COLLAPSED_H = 0;     // 折叠后完全隐藏代码内容

  const SVG_COPY = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none">
    <!-- 剪贴板主体 -->
    <rect x="3" y="5" width="12" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/>
    <!-- 顶部夹子 -->
    <path d="M7 5V4a3 3 0 0 1 6 0v1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <!-- 内容行 -->
    <line x1="7" y1="10" x2="13" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="7" y1="13" x2="11" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
  const SVG_CHECK = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none">
    <path d="M3 10l5 5 9-9" stroke="#3fb950" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  // ── highlight.js 懒加载（全局共享，仅首次切换语言时下载）──
  let _hljsPromise: Promise<any> | null = null;
  function loadHljs(): Promise<any> {
    if (_hljsPromise) return _hljsPromise;
    _hljsPromise = new Promise<any>((resolve, reject) => {
      // 加载与 Shiki github-dark-dimmed 视觉接近的主题
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
      document.head.appendChild(link);
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
      s.onload = () => resolve((window as any).hljs);
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return _hljsPromise;
  }

  document.querySelectorAll<HTMLElement>('.prose pre').forEach(pre => {
    const code = pre.querySelector('code');
    const lang = pre.getAttribute('data-language')
      ?? [...(code?.classList ?? [])].find(c => c.startsWith('language-'))?.slice(9)
      ?? '';
    // 保存 Shiki 原始渲染和纯文本，供语言切换时使用
    const rawCode      = code?.innerText  ?? '';
    const originalHTML = code?.innerHTML  ?? '';
    const originalLang = lang || 'plaintext';

    // 解析 meta 字符串中的 title（如 title="status_fmt.h"）
    const meta       = pre.getAttribute('data-meta') ?? '';
    const titleMatch = meta.match(/title=["']([^"']+)["']/);
    const codeTitle  = titleMatch?.[1] ?? '代码块';

    // ── 常用语言列表（id 用于高亮，label 显示在下拉菜单，short 显示在按钮）──
    const LANGS: { id: string; label: string; short: string }[] = [
      { id: 'plaintext',  label: 'Plain Text',  short: 'text' },
      { id: 'bash',       label: 'Shell',        short: 'sh'   },
      { id: 'c',          label: 'C',            short: 'C'    },
      { id: 'cpp',        label: 'C++',          short: 'C++'  },
      { id: 'css',        label: 'CSS',          short: 'css'  },
      { id: 'diff',       label: 'Diff',         short: 'diff' },
      { id: 'go',         label: 'Go',           short: 'Go'   },
      { id: 'html',       label: 'HTML',         short: 'html' },
      { id: 'java',       label: 'Java',         short: 'java' },
      { id: 'javascript', label: 'JavaScript',   short: 'JS'   },
      { id: 'json',       label: 'JSON',         short: 'json' },
      { id: 'markdown',   label: 'Markdown',     short: 'md'   },
      { id: 'python',     label: 'Python',       short: 'py'   },
      { id: 'rust',       label: 'Rust',         short: 'rs'   },
      { id: 'sql',        label: 'SQL',          short: 'sql'  },
      { id: 'typescript', label: 'TypeScript',   short: 'TS'   },
      { id: 'xml',        label: 'XML',          short: 'xml'  },
      { id: 'yaml',       label: 'YAML',         short: 'yaml' },
    ];
    let currentLang = lang || 'plaintext';

    // ── DOM 结构 ──
    const wrapper = document.createElement('div');
    wrapper.className = 'prose-code-block';

    // 标题栏
    const header = document.createElement('div');
    header.className = 'code-header';

    // ① 左侧：▼ 代码块
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'code-toggle';
    toggleBtn.title     = '折叠代码';
    toggleBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 11 11" fill="none">
      <path d="M2 4l3.5 3 3.5-3" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>${codeTitle}`;

    // 弹性占位
    const spacer = document.createElement('span');
    spacer.className = 'code-spacer';

    // ② 右侧：语言选择器 lang ▼
    const langWrap = document.createElement('div');
    langWrap.className = 'code-lang';

    const langBtn = document.createElement('button');
    langBtn.className = 'code-lang-btn';
    langBtn.title     = '选择语言';

    const langMenu = document.createElement('div');
    langMenu.className = 'code-lang-menu';

    const getLangMeta = (id: string) =>
      LANGS.find(l => l.id === id) ?? { id, label: id, short: id };

    const updateLangBtn = (id: string) => {
      const { short } = getLangMeta(id);
      langBtn.innerHTML = `${short}<svg width="11" height="11" viewBox="0 0 9 9" fill="none">
        <path d="M1.5 3.5l3 2.5 3-2.5" stroke="currentColor" stroke-width="1.3"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    };
    updateLangBtn(currentLang);

    // ── 重新高亮函数 ──
    const reHighlight = async (langName: string) => {
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;
      // 切回原始语言：恢复 Shiki 渲染
      if (langName === originalLang) {
        codeEl.innerHTML = originalHTML;
        codeEl.className = `language-${originalLang}`;
        return;
      }
      // plaintext：纯文本
      if (langName === 'plaintext') {
        codeEl.textContent = rawCode;
        codeEl.className   = 'language-plaintext';
        return;
      }
      // 其他语言：用 highlight.js
      try {
        const hljs   = await loadHljs();
        const result = hljs.highlight(rawCode, { language: langName, ignoreIllegals: true });
        codeEl.innerHTML = result.value;
        codeEl.className = `hljs language-${langName}`;
      } catch {
        codeEl.textContent = rawCode;
      }
    };

    // 下拉菜单（每项存 data-id 方便查找）
    LANGS.forEach(({ id, label }) => {
      const opt = document.createElement('button');
      opt.className = `code-lang-option${id === currentLang ? ' current' : ''}`;
      opt.dataset.id  = id;
      opt.textContent = label;
      opt.addEventListener('click', () => {
        currentLang = id;
        updateLangBtn(id);
        langMenu.classList.remove('open');
        langMenu.querySelectorAll<HTMLElement>('.code-lang-option').forEach(o =>
          o.classList.toggle('current', o.dataset.id === id));
        reHighlight(id);
      });
      langMenu.appendChild(opt);
    });

    langBtn.addEventListener('click', e => {
      e.stopPropagation();
      langMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => langMenu.classList.remove('open'));

    langWrap.append(langBtn, langMenu);

    // ③ 右侧：折行按钮 + 复制按钮
    const actions = document.createElement('div');
    actions.className = 'code-actions';

    // 折行
    const wrapBtn = document.createElement('button');
    wrapBtn.className = 'code-btn';
    wrapBtn.title     = '自动折行';
    wrapBtn.innerHTML = `<svg width="16" height="14" viewBox="0 0 14 12" fill="none">
      <path d="M1 2h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M1 6h8.5a2 2 0 0 1 0 4H8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M6 8l2 2-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    // 复制
    const cpBtn = document.createElement('button');
    cpBtn.className = 'code-btn';
    cpBtn.title     = '复制代码';
    cpBtn.innerHTML = SVG_COPY;

    actions.append(wrapBtn, cpBtn);
    header.append(toggleBtn, spacer, langWrap, actions);

    // 代码体
    const body = document.createElement('div');
    body.className = 'code-body';

    pre.parentNode!.insertBefore(wrapper, pre);
    body.appendChild(pre);
    wrapper.append(header, body);
    pre.style.background = 'transparent';

    // ── 箭头按钮：点击切换折叠/展开 ──
    let collapsed = false;

    toggleBtn.addEventListener('click', () => {
      if (!collapsed) {
        // 折叠
        collapsed = true;
        wrapper.classList.add('is-collapsed');
        toggleBtn.title = '展开代码';
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(() => { body.style.maxHeight = COLLAPSED_H + 'px'; });
      } else {
        // 展开
        collapsed = false;
        wrapper.classList.remove('is-collapsed');
        toggleBtn.title = '折叠代码';
        body.style.maxHeight = body.scrollHeight + 'px';
        body.addEventListener('transitionend', () => {
          if (!collapsed) body.style.maxHeight = '';
        }, { once: true });
      }
    });

    // ── 折行 ──
    let wrapped = false;
    wrapBtn.addEventListener('click', () => {
      wrapped = !wrapped;
      pre.style.whiteSpace = wrapped ? 'pre-wrap' : '';
      pre.style.overflowX  = wrapped ? 'hidden'   : '';
      wrapBtn.classList.toggle('wrap-active', wrapped);
      wrapBtn.title = wrapped ? '取消折行' : '自动折行';
    });

    // ── 复制 ──
    cpBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        cpBtn.innerHTML = SVG_CHECK;
        cpBtn.style.color = '#3fb950';
        setTimeout(() => { cpBtn.innerHTML = SVG_COPY; cpBtn.style.color = ''; }, 1800);
      } catch { cpBtn.title = '复制失败'; }
    });
  });
})();
