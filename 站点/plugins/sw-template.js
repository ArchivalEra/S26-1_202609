// Service Worker —— 本地磁盘缓存（2026-10-17 大重构方案 §4.3）。
//
// 策略（用户拍板）：
//   静态资产（assets/，带 hash 版本号）→ cache-first（命中即返回，永不回源直到版本变）
//   页面 HTML → stale-while-revalidate（先出缓存秒开，后台静默更新下一次生效）
//   其它（跨域、非 GET）→ 不碰
//
// 生命周期：版本号 bump 触发 activate 清旧缓存。
// 双域名：缓存名带 scope 相对路径作键，不写死域名；注册用相对路径（./sw.js）。
//
// 生成：构建期把本文件拷到 dist 根（sw.js），页面里注册。

const VERSION = 'v1';

self.addEventListener('install', (ev) => {
  // 预缓存：本版静态资产清单由构建期注入到 SW_ASSETS
  ev.waitUntil((async () => {
    const cache = await caches.open(ASSET_CACHE);
    await cache.addAll(SW_ASSETS).catch(() => {/* 单个失败不阻塞安装 */});
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    // 清掉旧版本缓存
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const ASSET_CACHE = 'assets-' + VERSION;
const PAGE_CACHE = 'pages-' + VERSION;

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 静态资产：cache-first（文件名带 hash，版本即身份）
  if (url.pathname.includes('/assets/')) {
    ev.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })());
    return;
  }

  // 页面 HTML：stale-while-revalidate
  if (/(\/|\.html)$/.test(url.pathname)) {
    ev.respondWith((async () => {
      const cache = await caches.open(PAGE_CACHE);
      const hit = await cache.match(req);
      // 后台更新（无论命中与否）
      const refresh = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) return hit;          // 秒开旧版，后台刷新下次生效
      const fresh = await refresh;  // 未命中：等网络
      return fresh || new Response('离线且无缓存', { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }

  // 其余（图片等）：网络优先、失败回缓存（配图不大且懒加载，不抢 SW 预算）
  ev.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && /\.(png|jpe?g|webp|gif|svg|jxl)$/i.test(url.pathname)) {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw e;
    }
  })());
});
