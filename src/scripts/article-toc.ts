/**
 * article-toc.ts — 文章目录交互
 * 包含：阅读进度条、桌面端回到顶部、桌面端 TOC 折叠/拖拽、
 *       移动端 TOC 抽屉、IntersectionObserver 当前章节高亮
 */

const bar    = document.getElementById('progress-bar')!;
const scroll = document.querySelector<HTMLElement>('.main-scroll');

// ── 阅读进度条 + 桌面端回到顶部 ─────────────────────────────
const backToTop = document.getElementById('back-to-top') as HTMLElement | null;
if (scroll) {
  scroll.addEventListener('scroll', () => {
    const top = scroll.scrollTop;
    bar.style.width = (top / (scroll.scrollHeight - scroll.clientHeight) * 100) + '%';
    if (isDesktop()) backToTop?.classList.toggle('visible', top > 300);
  });
}
backToTop?.addEventListener('click', () => {
  scroll?.scrollTo({ top: 0, behavior: 'smooth' });
});

// ── TOC：点击平滑滚动（TOC 在 main-scroll 外，需手动处理）──
const tocLinks   = document.querySelectorAll<HTMLAnchorElement>('.toc-link');
const headingEls = document.querySelectorAll<HTMLElement>('article h2[id], article h3[id]');

tocLinks.forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const id = link.getAttribute('href')?.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (!target || !scroll) return;
    const containerTop = scroll.getBoundingClientRect().top;
    const targetTop    = target.getBoundingClientRect().top;
    scroll.scrollBy({ top: targetTop - containerTop - 68, behavior: 'smooth' });
  });
});

// ── TOC：折叠 / 展开 ───────────────────────────────────────
const tocPanel  = document.getElementById('g-toc-panel') as HTMLElement | null;
const tocToggle = document.getElementById('g-toc-toggle') as HTMLButtonElement | null;
const isDesktop = () => window.matchMedia('(min-width: 960px)').matches;

const tocHandle = document.getElementById('g-toc-handle') as HTMLElement | null;

if (tocPanel && tocHandle && tocToggle && isDesktop()) {
  // 还原折叠状态
  if (localStorage.getItem('toc-collapsed') === 'true') {
    tocPanel.classList.add('collapsed');
    tocToggle.title = '展开目录';
    tocToggle.setAttribute('aria-label', '展开目录');
  }
  // 还原宽度
  const savedW = localStorage.getItem('toc-width');
  if (savedW && !tocPanel.classList.contains('collapsed')) {
    tocPanel.style.width = savedW;
  }

  // 折叠 / 展开按钮
  tocToggle.addEventListener('click', e => {
    e.stopPropagation();
    const nowCollapsed = tocPanel.classList.toggle('collapsed');
    tocToggle.title = nowCollapsed ? '展开目录' : '折叠目录';
    tocToggle.setAttribute('aria-label', nowCollapsed ? '展开目录' : '折叠目录');
    localStorage.setItem('toc-collapsed', String(nowCollapsed));
    if (!nowCollapsed) {
      tocPanel.style.width = localStorage.getItem('toc-width') ?? '160px';
    }
  });

  // 拖拽 resize
  let dragging = false, startX = 0, startW = 0;
  tocHandle.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.toc-toggle')) return;
    // 折叠时拖拽先展开
    if (tocPanel.classList.contains('collapsed')) {
      tocPanel.classList.remove('collapsed');
      localStorage.setItem('toc-collapsed', 'false');
    }
    dragging = true; startX = e.clientX; startW = tocPanel.offsetWidth;
    tocHandle.classList.add('dragging');
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';
    tocPanel.style.transition = 'none';   // 拖拽时关闭动画
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    const w = Math.min(320, Math.max(80, startW + e.clientX - startX));
    tocPanel.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    tocHandle.classList.remove('dragging');
    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
    tocPanel.style.transition = '';       // 恢复动画
    localStorage.setItem('toc-width', tocPanel.style.width);
  });
}

// ── 移动端目录：右下角 tab + 左侧滑入面板 ──────────────────
const mobTab      = document.getElementById('mob-toc-tab')      as HTMLElement | null;
const mobBackdrop = document.getElementById('mob-toc-backdrop') as HTMLElement | null;
const mobPanel    = document.getElementById('mob-toc-panel')    as HTMLElement | null;
const mobClose    = document.getElementById('mob-toc-close')    as HTMLElement | null;
const mobLinks    = document.querySelectorAll<HTMLAnchorElement>('.mob-toc-link');

function openMobToc() {
  mobBackdrop?.classList.add('open');
  mobPanel?.classList.add('open');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    mobPanel?.querySelector<HTMLElement>('.mob-toc-link.active')
      ?.scrollIntoView({ block: 'nearest' });
  });
}
function closeMobToc() {
  mobBackdrop?.classList.remove('open');
  mobPanel?.classList.remove('open');
  document.body.style.overflow = '';
}

// 滚动阈值：3 个屏幕高度，手动滑动代价大时才切为「回顶」
const TOC_THRESHOLD = window.innerHeight * 3;
window.addEventListener('scroll', () => {
  if (isDesktop() || !mobTab) return;
  const scrolled = window.scrollY > TOC_THRESHOLD;
  mobTab.dataset.state  = scrolled ? 'top' : 'toc';
  mobTab.ariaLabel      = scrolled ? '回到顶部' : '查看目录';
}, { passive: true });

mobTab?.addEventListener('click', () => {
  if (mobTab.dataset.state === 'top') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    openMobToc();
  }
});
mobClose?.addEventListener('click', closeMobToc);
mobBackdrop?.addEventListener('click', closeMobToc);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMobToc(); });

mobLinks.forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const id = link.dataset.id;
    closeMobToc();
    const target = id ? document.getElementById(id) : null;
    if (target) {
      setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
  });
});

// ── TOC：高亮当前章节（桌面 + 移动共用）────────────────────
if (headingEls.length) {
  const setActive = (id: string) => {
    tocLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
    mobLinks.forEach(a => a.classList.toggle('active', a.dataset.id === id));
  };

  // 桌面端：root = .main-scroll；移动端：root = null（视口）
  const obsRoot   = isDesktop() ? scroll : null;
  const obsMargin = '-52px 0px -55% 0px';

  const obs = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) setActive(e.target.getAttribute('id') ?? '');
    }
  }, { root: obsRoot, rootMargin: obsMargin });

  headingEls.forEach(h => obs.observe(h));
}
