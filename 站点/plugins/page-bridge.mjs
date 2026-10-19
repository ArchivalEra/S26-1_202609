// 页面侧桥接脚本（2026-10-19 植入站点）：把页面的 WebMCP 工具接到本地桥上。
//
// 它做三件事：
//   ① SSE 连 http://127.0.0.1:9345/events（桥 → 页面：调用请求）
//   ② 报到时把 document.modelContext.getTools() 的清单 POST 给桥（桥据此生成提示词）
//   ③ 收到调用 → mc.executeTool(handle, args) → POST /result 回传
//
// ## 2026-10-19：从「手动注入」改为「站点自带」
//
// 用户原话：「是时候把 MCP 桥完全植入网站中了，每次搭桥太傻逼」。
// 以前每次实验都要在浏览器控制台 evaluate 一遍源码，刷新即丢。
// 现在由 webmcp-loader.js 在工具注册完成后**自动注入**——打开页面就连桥，零手工。
//
// ## 只在需要时连
//
// 不是所有读者都跑本机桥。默认**不连**；只有满足任一条件才注入：
//   · URL 带 `?bridge=1`
//   · localStorage 有 `webmcp_bridge=on`
//   · 页面在 127.0.0.1/localhost（本机开发/实验环境，默认开）
//
// 这条守卫保证线上站点（edgeone/GitHub Pages）的访客一个请求都不会打到 127.0.0.1。
//
// ## 可拆卸
//
// 删掉本文件 + build.mjs 里写盘那两行 + loader 里注入那一行 即回退到「手动注入」。

export const PAGE_BRIDGE_JS = String.raw`(() => {
  const BRIDGE = 'http://127.0.0.1:9345';
  // 把自身源码存好（自动重连重建用）——由外层注入方（playwright evaluate 传 src）写入更可靠，
  // 但自存兜底：用 Function.prototype.toString 拿到本 IIFE 的源码
  try { if (!window.__mcpBridgeSource) window.__mcpBridgeSource = '(' + arguments.callee.toString() + ')();'; } catch (e) { /* 严格模式无 callee，靠注入方 */ }
  if (window.__mcpBridge) { try { window.__mcpBridge.es.close(); } catch (e) { /* 旧连接 */ } }

  const mc = document.modelContext || navigator.modelContext || null;
  if (!mc || typeof mc.getTools !== 'function') {
    console.warn('[bridge] 本页没有 WebMCP（先带 ?webmcp=1 打开）');
    return;
  }

  const post = (payload) => fetch(BRIDGE + '/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((e) => console.warn('[bridge] 回传失败', e));

  // —— ② 报到：把工具清单（去掉 window 等不可序列化字段）报给桥 ——
  let handles = [];
  const report = async () => {
    const list = await mc.getTools();          // 规范形态返回 Promise
    handles = list;
    const tools = list.map((t) => ({
      name: t.name,
      title: t.title || '',
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    post({ type: 'hello', url: location.href, title: document.title, tools });
    console.log('[bridge] 已报到，工具：', tools.map((t) => t.name).join(', '));
  };

  // —— ③ 执行被点名的工具 ——
  // 效果回执（2026-10-19 架构评审候选 2）：工具自己的返回是**自述**（openSection
  // 无论视口动没动都回 ok:true），yBefore/yAfter 是页面侧量出的**证据**。
  // 回执随结果一起 POST 给桥，桥透传给调用方——判「跳转成功」看 effect.scrolled / targetVisible。
  function measureEffect(before) {
    const yAfter = Math.round(window.scrollY);
    const hAfter = document.documentElement.scrollHeight;
    const eff = {
      yBefore: before.y, yAfter, dy: yAfter - before.y,
      hBefore: before.h, hAfter,
      scrolled: Math.abs(yAfter - before.y) >= 5,   // 5px 阈值内视为没动（亚像素/回弹）
    };
    // 目标落位检查：参数里带 title/anchor 时，看目标元素现在在不在视口顶部——
    // 不靠工具自述，靠 getBoundingClientRect 量。
    // ⚠️ 只认**标题元素**与 **id 命中**：不能用 textContent 匹配任意元素——
    //    搜索面板等容器的 textContent 会包含命中词，实测把 target 认成 search-panel。
    const needle = String((before.args && (before.args.title || before.args.anchor)) || '').trim();
    if (needle) {
      const eff2 = { ...eff };
      try {
        const heads = Array.prototype.slice.call(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter((el) => (el.textContent || '').indexOf(needle) >= 0);
        const byId = document.getElementById(needle);
        const el = heads[0] || byId || null;
        if (el) {
          const rect = el.getBoundingClientRect();
          eff2.target = el.id || needle;
          eff2.targetTop = Math.round(rect.top);
          // 目标在视口顶 200px 带内 = 真的滚到位了（scroll-margin-top 约 72px）
          eff2.targetVisible = rect.top > -80 && rect.top < 200;
        }
      } catch (e) { /* 量不到就只报滚动 */ }
      return eff2;
    }
    return eff;
  }

  const run = async (msg) => {
    const handle = handles.find((t) => t.name === msg.name);
    if (!handle) return post({ id: msg.id, ok: false, error: '页面没有工具 ' + msg.name });
    const before = { y: Math.round(window.scrollY), h: document.documentElement.scrollHeight, args: msg.args || {} };
    try {
      let value;
      try {
        value = await mc.executeTool(handle, msg.args || {});
      } catch (inner) {
        // ⚠️ 2026-10-19：polyfill 的 executeTool 把所有异常统一成 "Tool execution failed"，
        // 排查时完全看不到真因。这里**直接调工具实现**再跑一次，把真异常带回桥。
        // （工具实现挂在 handle.execute 上；polyfill 包装层没暴露，只能从注册表拿。）
        let detail = '';
        try {
          const impl = handle.execute || (handle.tool && handle.tool.execute);
          if (typeof impl === 'function') {
            await impl(msg.args || {});
            detail = '（直调成功——polyfill 包装层自身出错）';
          } else {
            detail = '（拿不到工具实现：keys=' + Object.keys(handle).join(',') + '）';
          }
        } catch (e2) {
          detail = String((e2 && (e2.stack || e2.message)) || e2).slice(0, 900);
        }
        throw new Error('executeTool 失败：' + String((inner && inner.message) || inner) + ' ｜ 真因：' + detail);
      }
      const effect = measureEffect(before);
      (window.__callTraces = window.__callTraces || []).push({ t: Date.now() % 1000000, name: msg.name, ...effect });
      post({ id: msg.id, ok: true, value, effect });
    } catch (e) {
      const err = String((e && e.message) || e);
      (window.__callTraces = window.__callTraces || []).push({ t: Date.now() % 1000000, name: msg.name, err });
      post({ id: msg.id, ok: false, error: err });
    }
  };

  // —— ① SSE ——
  // 重连看门狗：挂 window 级（不依赖 __mcpBridge 的赋值时序）；每 4s 自检一次，
  // SSE 断开（readyState 2）或 8s 没收到任何事件就重建整个桥。指数退避封顶 16s。
  if (!window.__bridgeReconnect) {
    window.__bridgeReconnect = { fails: 0 };
    window.__bridgeReconnect.tick = setInterval(() => {
      const b = window.__bridgeReconnect;
      const cur = window.__mcpBridge && window.__mcpBridge.es;
      const dead = !cur || cur.readyState === 2;
      // 连接活着（readyState 1）就算好
      if (cur && cur.readyState === 1) { b.fails = 0; return; }
      b.fails++;
      if (b.fails < 2) return;  // 等一轮（4s）再动手
      try { cur && cur.close(); } catch (e) { /* 已断 */ }
      const wait = Math.min(16000, 4000 * (b.fails - 1));
      console.warn('[bridge] 连接失效，' + wait + 'ms 后重建');
      clearInterval(window.__bridgeReconnect.tick);
      setTimeout(() => {
        window.__bridgeReconnect = null;
        const s2 = window.__mcpBridgeSource;
        if (s2) { try { (0, eval)(s2); } catch (e) { console.warn('[bridge] 重建失败', e); } }
      }, wait);
    }, 4000);
  }

  const es = new EventSource(BRIDGE + '/events');
  es.onopen = () => { console.log('[bridge] 已连上本地桥'); report(); };
  es.onerror = () => console.warn('[bridge] SSE 错误（看门狗会处理重连）');
  es.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg && msg.type === 'call') run(msg);
  };
  // 工具列表变动时重新报到（页面运行期可能注册新工具）
  if (typeof mc.addEventListener === 'function') mc.addEventListener('toolchange', report);

  window.__mcpBridge = { es, report, get tools() { return handles.map((t) => t.name); } };
  window.__mcpBridgeSource = window.__mcpBridgeSource || null;
  window.__mcpBridge.ping = () => fetch(BRIDGE + '/health').then((r) => r.json());
  console.log('[bridge] 页面桥已装好（window.__mcpBridge 可查状态）');
})();`;
