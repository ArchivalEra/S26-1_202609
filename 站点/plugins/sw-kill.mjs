// sw-kill.mjs —— 一次性清除老用户的 Service Worker（2026-10-23，SW 根除的收尾件）。
//
// ## 背景
//
// SW 已从站点根除（构建不再写 sw.js、页面不再注册）。但**老用户浏览器里
// 已经注册的旧 SW 还活着**——它会继续用旧缓存拦截页面请求（SWR 先出旧缓存），
// 直到它控制的页面载入一个「不再注册它的」新版本才会自然退役（且旧缓存还留着）。
// 这段脚本让每个老访客来一次就清干净：
//   ① 反注册全部 registration
//   ② 删全部 caches
//   ③ localStorage 打标记，之后本脚本 no-op（不反复扫）
//
// ## 退役计划
//
// 跑一两周（老用户基本都来过一次）后：删本文件 + build.mjs 的写盘段与 import +
// 页面模板里的 script 行。三处都带「sw-kill」字样可搜。
//
// ## 不做的事
//
// 不 `clients.claim()` 不重载页面——清完本轮生效即可，用户正在看的页面不动。
// 幂等：重复执行无害（标记只挡重复扫描，不挡清理本身）。

export const SW_KILL_JS = `(function () {
"use strict";
try {
  if (localStorage.getItem("sw_killed") === "1") return;
} catch (e) { /* 无 localStorage（隐私模式）——每次都扫，无害 */ }

// 无 ServiceWorker API 的环境（老浏览器/非安全上下文）只剩 caches 可清
var sweep = [];

if ("serviceWorker" in navigator && navigator.serviceWorker.getRegistrations) {
  sweep.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
    return Promise.all(regs.map(function (r) {
      return r.unregister().catch(function () { /* 单个失败不挡其余 */ });
    }));
  }));
}

if ("caches" in window && window.caches.keys) {
  sweep.push(window.caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      return window.caches.delete(k).catch(function () { /* 同上 */ });
    }));
  }));
}

Promise.all(sweep).then(function () {
  try { localStorage.setItem("sw_killed", "1"); } catch (e) { /* 标记失败就下次再扫 */ }
}).catch(function () { /* 清理失败不打扰页面 */ });
})();`;
