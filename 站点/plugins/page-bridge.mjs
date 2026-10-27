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
//   · 页面在本站部署域名（isui.ren / GitHub Pages）——2026-10-19 扩到公网
//
// 最后一条的含义要看清：公网页面里的 `127.0.0.1` 指的是**访问者自己的机器**，
// 不是站长服务器。所以这不是「公网页面偷偷连服务器」，而是「同学在他们自己
// 电脑上跑桥、从公网页面连自己的桥」。没跑桥的访客，请求会失败并看到提示。
//
// ## 可拆卸
//
// 删掉本文件 + build.mjs 里写盘那两行 + loader 里注入那一行 即回退到「手动注入」。

export const PAGE_BRIDGE_JS = String.raw`(() => {
  const BRIDGE = 'http://127.0.0.1:9345';

  // ⭐ 2026-10-19 修 P0-2：源码**在构建期由 loader 注入**，不再靠 arguments.callee。
  //
  // 旧实现：try { window.__mcpBridgeSource = '(' + arguments.callee.toString() + ')();' }
  //   —— 这在**箭头 IIFE** 里，箭头函数没有 arguments（Node 实测 undefined），
  //   异常被 catch 吞掉 → 源码恒为 null → 看门狗 clearInterval 自杀 → 永不重连。
  //
  // 新实现：loader 注入本脚本前先把源码塞进 window.__mcpBridgeSource（见 webmcp-loader.mjs）。
  // 这里的自存兜底改用「document.currentScript 拿不到就跳过」——拿不到也不影响重连，
  // 因为 loader 已经给了。
  if (!window.__mcpBridgeSource) {
    try {
      const cur = document.currentScript;
      if (cur && cur.src) {
        // 退路：从 src 重新拉一次源码（同源、同步缓存，代价可接受）
        window.__mcpBridgeReload = cur.src;
      }
    } catch (e) { /* 无 currentScript */ }
  }
  if (window.__mcpBridge) { try { window.__mcpBridge.es.close(); } catch (e) { /* 旧连接 */ } }

  // token：从构建期常量或 localStorage 取（bridge 启动时写 .bridge-token）
  const TOKEN = (function () {
    try {
      if (window.__bridgeToken) return window.__bridgeToken;
      const t = localStorage.getItem('webmcp_bridge_token');
      return t || '';
    } catch (e) { return ''; }
  })();
  const withToken = (u) => TOKEN ? (u + (u.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN)) : u;

  // 2026-10-19：桥在 SSE 首帧推一个 clientId 过来，此后每次 /result 都带上它——
  // 桥据此知道「这条 hello 来自哪个标签页」，才能正确切换活动页（P1-8 修复）。
  let CLIENT_ID = '';

  const mc = document.modelContext || navigator.modelContext || null;
  if (!mc || typeof mc.getTools !== 'function') {
    console.warn('[bridge] 本页没有 WebMCP（先带 ?webmcp=1 打开）');
    return;
  }

  /**
   * 回传结果给桥（2026-10-19 修 P2-20）。
   *
   * 旧实现：裸 fetch + catch 打印 ⇒ 桥短暂抖动就丢结果，桥那边白等 30s。
   * 现在：8s 超时 + 最多 3 次重试（200/600ms 退避）。
   * **工具执行结果不能丢**——丢了模型就看不到真实数据。
   */
  const post = (payload, attempt) => {
    const n = attempt || 1;
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) { /* 无 */ } }, 8000);
    return fetch(withToken(BRIDGE + '/result'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': TOKEN },
      body: JSON.stringify(CLIENT_ID ? { ...payload, clientId: CLIENT_ID } : payload),
      signal: ctrl ? ctrl.signal : undefined,
    }).then((r) => {
      clearTimeout(timer);
      if (!r.ok && n < 3) throw new Error('HTTP ' + r.status);
      return r;
    }).catch((e) => {
      clearTimeout(timer);
      if (n < 3) {
        const wait = 200 * Math.pow(3, n - 1);
        console.warn('[bridge] 回传失败（第 ' + n + ' 次），' + wait + 'ms 后重试', e && e.message);
        return new Promise((res) => setTimeout(res, wait)).then(() => post(payload, n + 1));
      }
      console.warn('[bridge] 回传失败（已重试 3 次，放弃）', e && e.message);
      return null;
    });
  };

  // —— ② 报到：把工具清单（去掉 window 等不可序列化字段）报给桥 ——
  let handles = [];
  const report = async () => {
    // 2026-10-19 修 P2-20：getTools() 可能是 Promise，rejection 此前无人处理
    //（es.onopen 直接调用 async 函数 → unhandled rejection）。
    let list;
    try {
      list = await mc.getTools();              // 规范形态返回 Promise
    } catch (e) {
      console.warn('[bridge] 取工具清单失败，稍后重试', e && e.message);
      // 1s 后重试一次（注册表可能还没就绪）
      setTimeout(() => { report().catch(() => {}); }, 1000);
      return;
    }
    if (!Array.isArray(list)) { console.warn('[bridge] getTools 返回非数组'); return; }
    handles = list;
    const tools = list.map((t) => ({
      name: t.name,
      title: t.title || '',
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    // 2026-10-19：报到去重——实测同一页会报 4 次（onopen + toolchange + 重试链）。
    //
    // ⚠️ 去重必须**按连接**而不是按页面：桥重启后页面重连，桥那边工具表是空的，
    // 若指纹相同就跳过报到，桥会永远以为没有工具（实测 tools: 0）。
    // 所以每次 EventSource 重新 open 都清掉指纹。
    const fingerprint = tools.map((t) => t.name).join(',') + '|' + location.href;
    if (window.__bridgeLastHello === fingerprint) return;
    window.__bridgeLastHello = fingerprint;
    post({ type: 'hello', protocol: 2, url: location.href, title: document.title, tools });
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
      // 导航判据：URL 或 data-site-path 任一变化即 navigated（SPA 换页两处都会变；
      // 只换锚点不算导航——hash 变化时 path 不变，按 scrolled/targetVisible 判）。
      navigated: before.url.split('#')[0] !== location.href.split('#')[0] || before.path !== ((document.body && document.body.getAttribute('data-site-path')) || ''),
      urlBefore: before.url, urlAfter: location.href,
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
    // 2026-10-24（issue #18 决策 #4）：快照补 url 与 data-site-path——
    // site_navigate 的 to=page 成功跳转（SPA 换页）此前**无法证明**：
    // scrolled 只量滚动，跳完页滚动可能恰好为 0。URL/路径变了就是导航发生了。
    const before = {
      y: Math.round(window.scrollY), h: document.documentElement.scrollHeight, args: msg.args || {},
      url: location.href,
      path: (document.body && document.body.getAttribute('data-site-path')) || '',
    };
    try {
      let value;
      let feedOut = null;
      try {
        // ⚠️ 2026-10-26 修（真机实测：区域截图报 empty_rect、viewport 0×0）：
        // **不要走 mc.executeTool**。
        //
        // 实测对照（同一页面、同一参数、同一时刻）：
        //   · mc.executeTool(handle, {selector:'.article-content'})
        //       → ok:false empty_rect，rect {w:0, h:50457}，viewport {0,0}
        //   · __mcpTools.runTool('site_capture_view', {selector:...})
        //       → ok:true，660×2335，viewport 1280×720，350KB 图
        //
        // 根因：mc.executeTool 执行的是 **polyfill 注册那一刻**的闭包，
        // 里面捕获的 window 已经过期（SPA 换页 / 重载后 defaultView 变了、
        // 或注册时窗口未布局）。而 runTool 每次调用都 buildToolDefs(doc, doc.defaultView)
        // 现建一份，拿到的永远是**当下的** window。
        //
        // 这同时是 issue #18 P0-1 的方向：注册与执行共用 buildToolDefs 这一份实现。
        // runTool 就是那个共用入口，桥不该绕开它自己去摸 handle。
        //
        // 失败时 runTool 恒 resolve {ok:false, error}（不抛），所以下面的 catch
        // 仍然保留给「runTool 本身不可用」这种退化情形。
        const rt = (typeof window !== 'undefined' && window.__mcpTools && window.__mcpTools.runTool)
          ? window.__mcpTools.runTool
          : null;
        if (rt) {
          const r = await rt(msg.name, msg.args || {});
          // runTool 返回 {ok, value, feed}（失败时 {ok:false, error, feed}）。
          // ⭐ 2026-10-26（信封归 MCP 侧）：feed 是工具侧产好的**可回喂文本**
          // （含元数据、自己保证单条长度）。这里必须留下它、传给桥——
          // 否则站点协议栈又要按工具名重新猜一遍形状（那是接口泄漏）。
          // 注意：本文件是模板字符串，注释里写标识符用直角引号，别用反引号。
          if (r && r.ok === false) {
            // 失败也要把 feed 带回去（失败信封里有「建议下一步」）
            feedOut = r.feed || null;
            // ⚠️ 2026-10-27 修（实测「工具执行失败：工具执行失败」）：r 里可能是
            // {ok:false, value:{ok:false,reason:'...'}}（工具自己返回软失败），
            // 此时 r.error 为空，落到兜底文案；再被外层的 catch 包一层就变成
            // 两个「工具执行失败」连读，真实原因（reason）彻底丢失。
            // 这里把 value/reason 一起挖出来。
            var why = r.error
              || (r.value && typeof r.value === 'object' && (r.value.reason || r.value.error))
              || (typeof r.value === 'string' ? r.value.slice(0, 120) : '')
              || '工具返回 ok:false 但没给原因';
            throw new Error(String(why));
          }
          value = r && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r;
          feedOut = (r && typeof r.feed === 'string') ? r.feed : null;
        } else {
          // 退化路径：页面没暴露 __mcpTools（旧版产物）。保留旧行为，但明确记录。
          console.warn('[bridge] 页面未暴露 __mcpTools.runTool，退回 mc.executeTool（可能拿不到当下窗口）');
          value = await mc.executeTool(handle, msg.args || {});
        }
      } catch (inner) {
        // 到这里的失败只剩三种：runTool 不可用（退化路径）、runTool 内部抛、或工具自己报错。
        // runTool 正常时不走这段——它把工具异常收成 {ok:false, error} 返回，我们上面已转抛。
        // 旧版曾在这里再调一次 handle.execute 试图拿真因；现在主路径是 runTool（错误信息
        // 本来就完整），这条兜底只对退化路径有意义，保留但不重复叙述。
        const msg0 = String((inner && inner.message) || inner);
        throw new Error('工具执行失败：' + msg0);
      }
      const effect = measureEffect(before);
      // 2026-10-19 修 P2-14：判据.mjs 的 effect:'hits' 此前**永远不可能命中**——
      // 页面侧从不产出 hits 字段。这里补上：搜索类工具把命中数带进回执。
      try {
        let vv = value;
        if (typeof vv === 'string') { try { vv = JSON.parse(vv); } catch (e) { /* 原文 */ } }
        if (vv && typeof vv === 'object' && typeof vv.total === 'number') {
          effect.hits = vv.total;
          if (Array.isArray(vv.hits)) effect.hitTitles = vv.hits.slice(0, 5).map((x) => x && x.title).filter(Boolean);
        }
      } catch (e) { /* 不改回执 */ }
      (window.__callTraces = window.__callTraces || []).push({ t: Date.now() % 1000000, name: msg.name, ...effect });
      post({ id: msg.id, ok: true, value, effect, feed: feedOut });
    } catch (e) {
      const err = String((e && e.message) || e);
      (window.__callTraces = window.__callTraces || []).push({ t: Date.now() % 1000000, name: msg.name, err });
      post({ id: msg.id, ok: false, error: err, feed: feedOut });
    }
  };

  // —— ① SSE ——
  // 重连看门狗：挂 window 级（不依赖 __mcpBridge 的赋值时序）；每 4s 自检一次，
  // SSE 断开（readyState 2）或 8s 没收到任何事件就重建整个桥。指数退避封顶 16s。
  if (!window.__bridgeReconnect) {
    window.__bridgeReconnect = { fails: 0 };
    window.__bridgeReconnect.tick = setInterval(() => {
      const b = window.__bridgeReconnect;
      // ⭐ 2026-10-27（单标签页）：被别的标签页占着了就永久停——重连只会一遍遍被拒。
      if (window.__bridgeDormant) {
        clearInterval(window.__bridgeReconnect.tick);
        window.__bridgeReconnect = null;
        return;
      }
      const cur = window.__mcpBridge && window.__mcpBridge.es;
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
        // ⭐ P0-2 修法：三条退路，任何一条成功都能重建。
        //   ① 构建期注入的源码（loader 在注入前写好）——主路径
        //   ② 同源重新拉一次脚本源码——主路径失效时
        //   ③ 重新插入 <script> 标签——最朴素但最可靠（浏览器会走缓存）
        const s2 = window.__mcpBridgeSource;
        if (s2) {
          try { (0, eval)(s2); return; } catch (e) { console.warn('[bridge] eval 重建失败', e); }
        }
        if (window.__mcpBridgeReload) {
          fetch(window.__mcpBridgeReload, { cache: 'force-cache' })
            .then((r) => r.text())
            .then((src) => {
              window.__mcpBridgeSource = src;
              try { (0, eval)(src); } catch (e) { console.warn('[bridge] 重新拉取后重建失败', e); }
            })
            .catch(() => reinjectTag());
          return;
        }
        reinjectTag();

        function reinjectTag() {
          try {
            const el = document.createElement('script');
            el.src = window.__mcpBridgeReload || '';
            if (!el.src) { console.warn('[bridge] 无源码可重建'); return; }
            document.head.appendChild(el);
          } catch (e) { console.warn('[bridge] 重新插入失败', e); }
        }
      }, wait);
    }, 4000);
  }

  const es = new EventSource(withToken(BRIDGE + '/events'));
  es.onopen = () => {
    console.log('[bridge] 已连上本地桥');
    // 每次新连接都清指纹——桥可能是刚重启的，它那边工具表为空，必须重报。
    window.__bridgeLastHello = null;
    // 桥会立刻推一帧 hello{clientId}；等 200ms 让那帧先到，再报到。
    setTimeout(() => { report().catch(() => {}); }, 200);
  };
  // ⭐ 2026-10-27 站长定案（单标签页）：另一个标签页已经占着桥时，桥会回 409。
  // EventSource 不暴露状态码，所以这里**探一次**——但必须用 HEAD：
  // GET 会真的建一条 SSE（桥若空闲就被它占住了，等于自己抢自己）。
  // 若探到 409，就标成「休眠」，看门狗看见标志永久停止重连（刷新后才有机会）。
  // 不这么做的话，被拒的页面会每 4s 重连、每 4s 被拒，无限刷屏。
  es.onerror = () => {
    fetch(withToken(BRIDGE + '/events'), { method: 'HEAD', cache: 'no-store' })
      .then((r) => {
        if (r.status === 409) {
          window.__bridgeDormant = true;
          console.warn('[bridge] 已有另一个标签页在用桥（单标签页模式）——本页休眠，关闭另一页后刷新本页');
        } else {
          console.warn('[bridge] SSE 错误（看门狗会处理重连）');
        }
      })
      .catch(() => console.warn('[bridge] SSE 错误（看门狗会处理重连）'));
  };
  es.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg && msg.type === 'hello' && msg.clientId) {
      // 桥发来的连接标识：存下来，后续 /result 都带上
      CLIENT_ID = msg.clientId;
      return;
    }
    if (msg && msg.type === 'call') run(msg);
  };
  // 工具列表变动时重新报到（页面运行期可能注册新工具）
  // 工具列表变动时重新报到。重建时会再进这里一次——先摘旧的，避免监听器累积。
  if (typeof mc.removeEventListener === 'function' && window.__bridgeToolchange) {
    try { mc.removeEventListener('toolchange', window.__bridgeToolchange); } catch (e) { /* 无 */ }
  }
  if (typeof mc.addEventListener === 'function') {
    window.__bridgeToolchange = report;
    mc.addEventListener('toolchange', report);
  }

  window.__mcpBridge = { es, report, get tools() { return handles.map((t) => t.name); } };
  window.__mcpBridge.ping = () => fetch(withToken(BRIDGE + '/health'), { headers: { 'X-Bridge-Token': TOKEN } }).then((r) => r.json());
  console.log('[bridge] 页面桥已装好（window.__mcpBridge 可查状态）');
})();`;
