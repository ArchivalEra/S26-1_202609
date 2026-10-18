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
    // 清掉旧版本缓存。⚠️ pages 例外（2026-10-17 移动端强调泡消失的教训）：
    // 页面缓存必须与 SW 版本**同生命周期**——旧版 pages 里存的旧页（无 data-path）
    // 混上新 SPA 代码 = active 全无匹配 = 强调栏消失。所以本版 activate 时
    // **连本版已有的 pages 也清空重建**，杜绝任何跨版本组合；
    // assets 保留本版（带 hash 的静态件按版本走，无错配问题）。
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => !k.endsWith(VERSION) || k.startsWith('pages-'))
      .map((k) => caches.delete(k)));
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

  // 页面 HTML：stale-while-revalidate + 导航 404 兜底（2026-10-18）
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
      // 未命中：等网络。老缓存页（SWR 秒开的那版）里可能还是修复前的**相对错位链接**
      // ——从新 location 解析出的双拼路径（/课程/A/课程/A/…）。剥部署前缀解决不了它
      // （双拼在中段），要做的是**把重复段折叠回去**：定位路径里第二次出现的顶层段
      // 起点（/课程/），截取其后部分再拼回 scope，即得正确 URL。重试一次，命中就回正确页。
      const fresh = await refresh;
      if (fresh && fresh.status === 404 && req.mode === 'navigate' && /\.html$/.test(url.pathname)) {
        // ⚠️ url.pathname 是 percent-encoded 形态（中文变成 %E8%AF%BE…），
        // '/课程/' 的 indexOf 必须在 **decode 之后**做；拼回 URL 再交给 fetch 编码。
        const scope = new URL(self.registration.scope);
        const scopePath = decodeURIComponent(scope.pathname).replace(/\/+$/, '') + '/';
        // 统一为「以 / 开头的仓库相对路径」再找双拼，根部署与子路径部署同一算法：
        // 根部署 tail='课程/A/课程/A/X'；子路径部署 tail 同为 '课程/A/…'（scope 已剥）。
        const decoded = decodeURIComponent(url.pathname);
        const tail = decoded.startsWith(scopePath) ? '/' + decoded.slice(scopePath.length) : decoded;
        // 双拼折叠：tail 里第二次出现 '/课程/' ⇒ 从那里截断（/课程/A/课程/A/X → 课程/A/X）。
        // 返回 **308 重定向**到正确 URL——不能直接回 retry 的 HTML：地址栏会停在错位
        // URL，页面里的相对资源（../assets/…）从错位位置解析照样 404，整页 JS 全挂。
        // 重定向让浏览器把地址栏换成正确 URL，资源解析全部归位。
        const dupe = tail.indexOf('/课程/', 1);
        if (dupe > 0) {
          const folded = tail.slice(dupe + 1);  // 无开头 /，挂在 scope 尾部
          if (/\.html$/.test(folded)) {
            const fixed = scope.origin + scope.pathname.replace(/\/+$/, '') + '/' + folded.split('/').map(encodeURIComponent).join('/');
            if (fixed !== url.href) {
              console.warn('[sw] 导航 404 兜底（双拼折叠重定向）:', decoded, '→', fixed);
              return Response.redirect(fixed, 308);
            }
          }
        }
      }
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
