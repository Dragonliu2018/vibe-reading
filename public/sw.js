/**
 * Vibe Reading Service Worker
 *
 * 缓存策略：
 * - HTML 页面 (navigation): stale-while-revalidate（访问即缓存，秒开+后台更新）
 * - 同源静态资源 (CSS/JS/图片): cache-first（命中即返回，后台静默更新）
 * - 跨域资源 (字体/giscus): 不拦截（离线时优雅降级）
 *
 * 全站缓存：页面发 {type:'CACHE_ALL'} 消息触发，SW 遍历 manifest 逐个缓存并回报进度。
 */

const CACHE_VERSION = 'v1-20260727';
const CACHE_RUNTIME = `vr-runtime-${CACHE_VERSION}`;
const CACHE_PRECACHE = `vr-precache-${CACHE_VERSION}`;
const BASE = '/vibe-reading';

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

  // 跨域资源不拦截（Google Fonts / giscus / GitHub avatars）
  if (url.origin !== self.location.origin) return;

  // 不拦截 pagefind 搜索索引（离线搜索意义不大，且 1.6M）
  if (url.pathname.startsWith(`${BASE}/pagefind/`)) return;

  // 不拦截 papers PDF（72M 太大，按需缓存即可）
  if (url.pathname.startsWith(`${BASE}/papers/`)) return;

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
  const cached = await cache.match(req);

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
  const cached = await cache.match(req);
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

  if (msg.type === 'CACHE_ALL') {
    event.waitUntil(cacheAll(event.source));
  } else if (msg.type === 'GET_STATUS') {
    reportStatus(event.source);
  } else if (msg.type === 'CLEAR_CACHE') {
    event.waitUntil(clearAll(event.source));
  }
});

// ── 全站缓存：拉 manifest，逐个缓存，回报进度 ────────────────────
async function cacheAll(client) {
  try {
    // 拉取站点清单
    const res = await fetch(`${BASE}/site-manifest.json`, { cache: 'no-store' });
    if (!res.ok) {
      client?.postMessage({ type: 'CACHE_ERROR', error: '无法加载站点清单' });
      return;
    }
    const manifest = await res.json();
    const urls = manifest.urls || [];
    const cache = await caches.open(CACHE_PRECACHE);

    let done = 0;
    const total = urls.length;

    client?.postMessage({ type: 'CACHE_START', total });

    // 分批并发（每批 8 个，避免浏览器连接数饱和）
    const BATCH = 8;
    for (let i = 0; i < urls.length; i += BATCH) {
      const batch = urls.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (url) => {
          try {
            const r = await fetch(url);
            if (r && r.ok) {
              await cache.put(url, r);
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

    client?.postMessage({ type: 'CACHE_DONE', total: done });
  } catch (err) {
    client?.postMessage({ type: 'CACHE_ERROR', error: String(err) });
  }
}

// ── 报告缓存状态 ────────────────────────────────────────────────
async function reportStatus(client) {
  const precache = await caches.open(CACHE_PRECACHE);
  const runtime = await caches.open(CACHE_RUNTIME);
  const precacheKeys = await precache.keys();
  const runtimeKeys = await runtime.keys();
  client?.postMessage({
    type: 'STATUS',
    precacheCount: precacheKeys.length,
    runtimeCount: runtimeKeys.length,
  });
}

// ── 清空所有缓存 ────────────────────────────────────────────────
async function clearAll(client) {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  client?.postMessage({ type: 'CACHE_CLEARED' });
}
