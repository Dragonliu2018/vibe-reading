/**
 * Vibe Reading Service Worker
 *
 * 缓存策略：
 * - HTML 页面 (navigation): stale-while-revalidate（访问即缓存，秒开+后台更新）
 * - 同源静态资源 (CSS/JS/图片): cache-first
 * - 文章图片 CDN: cache-first（仅允许本站图片仓库）
 *
 * 显式离线：页面只缓存当前文档及其实际依赖，避免全站缓存耗尽浏览器配额。
 */

const CACHE_VERSION = 'v2-20260926';
const CACHE_RUNTIME = `vr-runtime-${CACHE_VERSION}`;
const CACHE_OFFLINE = `vr-offline-${CACHE_VERSION}`;
const BASE = '/vibe-reading';
const IMAGE_CDN_ORIGIN = 'https://cdn.jsdelivr.net';
const IMAGE_CDN_PREFIX = '/gh/Dragonliu2018/vibe-reading-images@';

// ── install: 跳过等待，立即激活 ──────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// ── activate: 清理旧版本缓存，立即接管 ──────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.endsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ── fetch: 拦截请求，按类型分流 ──────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  const isSameOrigin = url.origin === self.location.origin;
  const isArticleImage = url.origin === IMAGE_CDN_ORIGIN && url.pathname.startsWith(IMAGE_CDN_PREFIX);

  // 只额外接管可信文章图片 CDN；Google Fonts / giscus 等继续由浏览器处理。
  if (!isSameOrigin && !isArticleImage) return;

  // 不拦截 Pagefind 搜索索引（离线搜索意义不大，且会显著增加缓存体积）
  if (isSameOrigin && url.pathname.startsWith(`${BASE}/pagefind/`)) return;

  // 不拦截论文 PDF（体积较大，交给浏览器按需处理）
  if (isSameOrigin && url.pathname.startsWith(`${BASE}/papers/`)) return;

  // HTML 页面导航 → stale-while-revalidate
  if (req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(req, CACHE_RUNTIME));
    return;
  }

  // 同源静态资源 → cache-first
  event.respondWith(cacheFirst(req, CACHE_RUNTIME));
});

// ── 策略 1: stale-while-revalidate（HTML 页面）────────────────────
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await caches.match(req);

  const fetchPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);  // 网络失败时返回缓存（离线核心）

  return cached || fetchPromise;
}

// ── 策略 2: cache-first（静态资源 CSS/JS/图片）────────────────────
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return cached || Response.error();
  }
}

// ── message: 处理页面消息 ────────────────────────────────────────
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'CACHE_PAGE') {
    event.waitUntil(cachePage(event.source, msg));
  } else if (msg.type === 'GET_STATUS') {
    event.waitUntil(reportStatus(event.source, msg.url));
  } else if (msg.type === 'CLEAR_CACHE') {
    event.waitUntil(clearAll(event.source));
  }
});

// ── 当前页缓存：只拉取页面声明的文档、样式、脚本、图片和 iframe ─────
async function cachePage(client, message) {
  try {
    const pageUrl = new URL(message.pageUrl, self.location.origin);
    pageUrl.hash = '';
    const candidates = Array.isArray(message.urls) ? message.urls : [];
    const urls = [...new Set([pageUrl.href, ...candidates])]
      .map((value) => {
        try {
          const url = new URL(value, self.location.origin);
          url.hash = '';
          const allowed = url.origin === self.location.origin ||
            (url.origin === IMAGE_CDN_ORIGIN && url.pathname.startsWith(IMAGE_CDN_PREFIX));
          return allowed ? url.href : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, 250);
    const cache = await caches.open(CACHE_OFFLINE);

    let done = 0;
    let cached = 0;
    const total = urls.length;

    client?.postMessage({ type: 'CACHE_START', total });

    // 小批并发，避免图片较多的文章占满连接池。
    const BATCH = 4;
    for (let i = 0; i < urls.length; i += BATCH) {
      const batch = urls.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (url) => {
          try {
            const r = await fetch(url);
            if (r && r.ok) {
              await cache.put(url, r);
              cached++;
            }
          } catch {
            // 单个失败不阻断整体
          }
          done++;
          // 每 5 个或最后一批报进度
          if (done % 5 === 0 || done === total) {
            client?.postMessage({ type: 'CACHE_PROGRESS', done, total });
          }
        })
      );
    }

    if (!(await cache.match(pageUrl.href))) {
      client?.postMessage({ type: 'CACHE_ERROR', error: '页面本身缓存失败' });
      return;
    }
    client?.postMessage({ type: 'CACHE_DONE', total: cached, failed: total - cached });
  } catch (err) {
    client?.postMessage({ type: 'CACHE_ERROR', error: String(err) });
  }
}

// ── 报告缓存状态 ────────────────────────────────────────────────
async function reportStatus(client, pageUrl) {
  const offline = await caches.open(CACHE_OFFLINE);
  const runtime = await caches.open(CACHE_RUNTIME);
  let normalizedUrl = pageUrl;
  try {
    const url = new URL(pageUrl, self.location.origin);
    url.hash = '';
    normalizedUrl = url.href;
  } catch {}
  const pageCached = normalizedUrl ? Boolean(await offline.match(normalizedUrl)) : false;
  const offlineKeys = await offline.keys();
  const runtimeKeys = await runtime.keys();
  client?.postMessage({
    type: 'STATUS',
    pageCached,
    offlineCount: offlineKeys.length,
    runtimeCount: runtimeKeys.length,
  });
}

// ── 清空所有缓存 ────────────────────────────────────────────────
async function clearAll(client) {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  client?.postMessage({ type: 'CACHE_CLEARED' });
}
