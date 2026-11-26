// Shirone M3E Reader Interactive Script
(function () {
  // Theme Toggle
  // 2026-10-19：明暗切换从顶栏按钮**收进调色盘**（用户定案）。
  // 顶栏位置改成调色盘的手形图标；切换在弹层里做。
  const currentTheme = localStorage.getItem("theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  if (currentTheme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
  }

  /** 把当前主题同步到弹层里的两个按钮（选中态 + aria-pressed）。 */
  function syncThemeButtons() {
    const active = document.documentElement.getAttribute("data-theme") || "light";
    document.querySelectorAll("[data-theme-set]").forEach((btn) => {
      const on = btn.getAttribute("data-theme-set") === active;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setTheme(next) {
    if (next !== "light" && next !== "dark") return;
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    syncThemeButtons();
    if (typeof updateAllImageContrast === "function") updateAllImageContrast();
  }

  syncThemeButtons();
  document.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();   // 别让弹层的「点外部关闭」把这次点击吃掉
      setTheme(btn.getAttribute("data-theme-set"));
    });
  });

  // Drawer Toggle (Mobile slide-out & Desktop sidebar collapse)
  const drawerToggleBtn = document.getElementById("drawer-toggle");
  const drawer = document.getElementById("m3-drawer");
  const backdrop = document.getElementById("drawer-backdrop");

  function toggleDrawer() {
    if (window.innerWidth <= 860) {
      if (!drawer) return;
      const isOpen = drawer.classList.contains("open");
      if (isOpen) {
        drawer.classList.remove("open");
        if (backdrop) backdrop.classList.remove("open");
      } else {
        drawer.classList.add("open");
        if (backdrop) backdrop.classList.add("open");
      }
    } else {
      document.body.classList.toggle("sidebar-collapsed");
    }
  }

  if (drawerToggleBtn) drawerToggleBtn.addEventListener("click", toggleDrawer);
  if (backdrop) backdrop.addEventListener("click", toggleDrawer);

  // Desktop Brand Collapse Button
  const drawerCollapseBtn = document.getElementById("drawer-collapse-btn");
  if (drawerCollapseBtn) {
    drawerCollapseBtn.addEventListener("click", () => {
      document.body.classList.toggle("sidebar-collapsed");
    });
  }

  // Keyboard shortcut: "[" to toggle sidebar
  window.addEventListener("keydown", (e) => {
    if (e.key === "[" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      toggleDrawer();
    }
  });

  // Sidebar Resizer (Desktop drag-to-resize & double-click reset)
  const resizer = document.getElementById("sidebar-resizer");
  const DEFAULT_SIDEBAR_WIDTH = 320;
  const MIN_SIDEBAR_WIDTH = 240;
  const MAX_SIDEBAR_WIDTH = 580;

  // Restore saved width on desktop
  const savedWidth = localStorage.getItem("shirone-sidebar-width");
  if (savedWidth && window.innerWidth > 860) {
    const num = parseInt(savedWidth, 10);
    if (!isNaN(num) && num >= MIN_SIDEBAR_WIDTH && num <= MAX_SIDEBAR_WIDTH) {
      document.documentElement.style.setProperty("--sidebar-width", num + "px");
    }
  }

  if (resizer) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener("mousedown", (e) => {
      if (window.innerWidth <= 860) return;
      isResizing = true;
      startX = e.clientX;
      const currentW = drawer ? drawer.getBoundingClientRect().width : DEFAULT_SIDEBAR_WIDTH;
      startWidth = currentW;
      resizer.classList.add("resizing");
      document.body.classList.add("sidebar-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      let newWidth = Math.round(startWidth + dx);
      if (newWidth < MIN_SIDEBAR_WIDTH) newWidth = MIN_SIDEBAR_WIDTH;
      if (newWidth > MAX_SIDEBAR_WIDTH) newWidth = MAX_SIDEBAR_WIDTH;
      document.documentElement.style.setProperty("--sidebar-width", newWidth + "px");
    });

    window.addEventListener("mouseup", () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove("resizing");
      document.body.classList.remove("sidebar-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (drawer) {
        const finalW = Math.round(drawer.getBoundingClientRect().width);
        localStorage.setItem("shirone-sidebar-width", finalW);
      }
    });

    resizer.addEventListener("dblclick", () => {
      document.documentElement.style.setProperty("--sidebar-width", DEFAULT_SIDEBAR_WIDTH + "px");
      localStorage.setItem("shirone-sidebar-width", DEFAULT_SIDEBAR_WIDTH);
    });
  }

  // Collapsible Navigation Groups (Delegated Accordion, Lazy Hydration & Collapse-All)
  const toggleAllBtn = document.getElementById("toggle-all-groups-btn");
  const toggleAllText = document.getElementById("toggle-all-text");

  function getNavGroups() {
    return document.querySelectorAll(".drawer-nav-group");
  }

  function updateToggleAllButtonState() {
    if (!toggleAllBtn || !toggleAllText) return;
    const hasExpanded = Array.from(getNavGroups()).some(g => g.classList.contains("expanded"));
    toggleAllText.textContent = hasExpanded ? "全部收起" : "全部展开";
  }

  function toggleGroup(group) {
    if (!group) return;
    const isExpanded = group.classList.contains("expanded");
    if (isExpanded) {
      group.classList.remove("expanded");
      group.classList.add("collapsed");
      updateToggleAllButtonState();
      return;
    }
    const finishExpand = () => {
      group.classList.remove("collapsed");
      group.classList.add("expanded");
      updateToggleAllButtonState();
    };
    if (group.hasAttribute("data-nav-lazy") && window.__navStructure?.ensureHydrated) {
      window.__navStructure.ensureHydrated(group).then(finishExpand);
    } else {
      finishExpand();
    }
  }

  if (drawer) {
    drawer.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".nav-collapse-btn") : null;
      if (btn) {
        e.stopPropagation();
        toggleGroup(btn.closest(".drawer-nav-group"));
        return;
      }
      const header = e.target && e.target.closest ? e.target.closest(".nav-group-header.nav-header-clickable") : null;
      if (header) {
        e.stopPropagation();
        toggleGroup(header.closest(".drawer-nav-group"));
      }
    });
  }

  if (toggleAllBtn) {
    toggleAllBtn.addEventListener("click", () => {
      const groups = Array.from(getNavGroups());
      const hasExpanded = groups.some(g => g.classList.contains("expanded"));
      if (hasExpanded) {
        groups.forEach(group => {
          group.classList.remove("expanded");
          group.classList.add("collapsed");
        });
        updateToggleAllButtonState();
        return;
      }
      const applyExpandAll = () => {
        getNavGroups().forEach(group => {
          group.classList.remove("collapsed");
          group.classList.add("expanded");
        });
        updateToggleAllButtonState();
      };
      if (document.querySelector("li[data-nav-lazy='1']") && window.__navStructure?.hydrateAll) {
        window.__navStructure.hydrateAll().then(applyExpandAll);
      } else {
        applyExpandAll();
      }
    });
  }

  // Copy Code —— **事件委托**（2026-10-31 修 issue #17）。
  //
  // 旧实现是启动时 `querySelectorAll(".copy-btn").forEach(绑定)`：只在首屏那一次
  // 生效，而 copy-btn 在 `.article-content` **内**——SPA 换页换掉正文 DOM 之后，
  // 新页的按钮没有监听器，点了没反应（首屏直达正常，站内跳转后失效）。
  // 委托到 document 上就没有「换页要重绑」这回事，与 spa-router 的点击委托同一套手法。
  //
  // ⚠️ 用 closest 而不是 e.target.classList：按钮里可能有子节点，
  // 点到的可能是子节点而不是按钮本身。
  document.addEventListener("click", async (e) => {
    const btn = e.target && e.target.closest ? e.target.closest(".copy-btn") : null;
    if (!btn) return;
    const wrap = btn.closest(".code-fence-wrapper");
    const codeBlock = wrap && wrap.querySelector("code");
    if (!codeBlock) return;
    try {
      await navigator.clipboard.writeText(codeBlock.innerText);
      const originalText = btn.textContent;
      btn.textContent = "已复制";
      btn.style.color = "var(--md-sys-color-primary)";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.color = "";
      }, 1800);
    } catch (err) {
      console.error("复制失败", err);
    }
  });

  // Theme Palette (Color Picker & Presets)
  const DEFAULT_HUE = 248;
  const paletteToggleBtn = document.getElementById("palette-toggle");
  const palettePopover = document.getElementById("palette-popover");
  const hueSlider = document.getElementById("hue-slider");
  const hueBadge = document.getElementById("palette-hue-badge");
  const resetBtn = document.getElementById("palette-reset-btn");
  const swatchButtons = document.querySelectorAll(".palette-swatch-item");
  const fontSlider = document.getElementById("font-size-slider");
  const fontSizeValue = document.getElementById("font-size-value");
  const fontSample = document.getElementById("font-sample");

  function applyHue(hue, save = true) {
    const val = parseInt(hue, 10);
    document.documentElement.style.setProperty("--hue", val);
    document.documentElement.style.setProperty("--primary-h", val);
    if (hueBadge) hueBadge.textContent = `Hue ${val}°`;
    if (hueSlider) hueSlider.value = val;

    swatchButtons.forEach(btn => {
      const btnHue = parseInt(btn.getAttribute("data-hue"), 10);
      if (btnHue === val) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    if (save) {
      localStorage.setItem("theme-hue", val);
    }
  }

  // Load saved hue or default
  const savedHue = localStorage.getItem("theme-hue");
  if (savedHue !== null) {
    applyHue(savedHue, false);
  } else {
    applyHue(DEFAULT_HUE, false);
  }

  if (paletteToggleBtn && palettePopover) {
    // aria-expanded 是顶栏按钮「展开态高亮」的判据（2026-11-01 统一）：
    // 入口按钮都靠这个属性点亮，调色盘不能只切 .open 类。
    const setExpanded = (open) => paletteToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    const closeSearchIfOpen = () => {
      const sp = document.getElementById("search-panel");
      const sb = document.getElementById("search-toggle");
      if (sp && !sp.hidden) sp.hidden = true;
      document.body.classList.remove("search-open");
      if (sb) sb.setAttribute("aria-expanded", "false");
    };
    paletteToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !palettePopover.classList.contains("open");
      if (willOpen) closeSearchIfOpen();
      palettePopover.classList.toggle("open", willOpen);
      setExpanded(willOpen);
    });

    palettePopover.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    document.addEventListener("click", () => {
      palettePopover.classList.remove("open");
      setExpanded(false);
    });
  }

  if (hueSlider) {
    hueSlider.addEventListener("input", (e) => {
      applyHue(e.target.value, true);
    });
  }

  swatchButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const hue = btn.getAttribute("data-hue");
      if (hue) {
        applyHue(hue, true);
      }
    });
  });

  // 字号（2026-10-29）：全站缩放只改一处 —— html 的 font-size。
  // 站内所有尺寸都是 rem，所以正文/侧栏/代码块/公式（MathLive 继承字号）一起变。
  // 范围与默认值照 Octave-UI 的 ThemeManager（12–20px / 16px）。
  const FONT_KEY = "site-font-size";
  const FONT_DEFAULT = 16;
  const FONT_MIN = 12;
  const FONT_MAX = 20;

  function applyFontSize(px, save = true) {
    const n = Math.max(FONT_MIN, Math.min(FONT_MAX, parseInt(px, 10) || FONT_DEFAULT));
    document.documentElement.style.fontSize = n + "px";
    document.documentElement.style.setProperty("--base-font-size", n + "px");
    if (fontSizeValue) fontSizeValue.textContent = n + "px";
    if (fontSlider) fontSlider.value = n;
    if (fontSample) fontSample.style.fontSize = n + "px";
    if (save) {
      try { localStorage.setItem(FONT_KEY, String(n)); } catch (_e) { /* 隐私模式 */ }
    }
    if (typeof scheduleInlineMathOverflow === "function") scheduleInlineMathOverflow();
  }

  // 窄屏超宽行内公式兜底：仅对单块 .base 仍超出所在行宽的 .katex 挂 .katex-inline-scroll，
  // 使其就地横向可滑，避免被 .layout-container 的 overflow-x: clip 裁断，同时不动正常折行的公式。
  let mathOverflowQueued = false;
  function syncInlineMathOverflow() {
    const art = document.querySelector(".article-content");
    if (!art) return;
    const nodes = Array.from(art.querySelectorAll(".katex")).filter(
      (k) => !k.closest(".katex-scroll-container, thead")
    );
    nodes.forEach((k) => {
      k.classList.remove("katex-inline-scroll");
    });
    const artRight = art.getBoundingClientRect().right;
    const toScroll = [];
    for (const k of nodes) {
      const box = k.closest("td, th, blockquote, li, p, h1, h2, h3, h4") || art;
      const cs = getComputedStyle(box);
      const limitRight = Math.min(artRight, box.getBoundingClientRect().right - (parseFloat(cs.paddingRight) || 0));
      const bases = k.querySelectorAll(".base");
      for (const base of bases) {
        if (base.getBoundingClientRect().right > limitRight + 1) {
          toScroll.push(k);
          break;
        }
      }
    }
    for (const k of toScroll) {
      k.classList.add("katex-inline-scroll");
    }
  }
  function scheduleInlineMathOverflow() {
    if (mathOverflowQueued) return;
    mathOverflowQueued = true;
    requestAnimationFrame(() => {
      mathOverflowQueued = false;
      syncInlineMathOverflow();
    });
  }
  scheduleInlineMathOverflow();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleInlineMathOverflow);
  }
  window.addEventListener("resize", scheduleInlineMathOverflow);
  document.addEventListener("toggle", scheduleInlineMathOverflow, true);

  const savedFont = localStorage.getItem(FONT_KEY);
  applyFontSize(savedFont !== null ? savedFont : FONT_DEFAULT, false);

  if (fontSlider) {
    fontSlider.addEventListener("input", (e) => applyFontSize(e.target.value, true));
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      localStorage.removeItem("theme-hue");
      applyHue(DEFAULT_HUE, false);
      // 字号也一并复位——这个按钮的语义是「回到默认」，两样都算默认的一部分。
      try { localStorage.removeItem(FONT_KEY); } catch (_e) { /* 隐私模式 */ }
      applyFontSize(FONT_DEFAULT, false);
    });
  }

  // Table of Contents ScrollSpy
  // SPA 换页钩子（2026-10-17）：tocLinks/headings 换页后要重扫。
  let tocLinks = document.querySelectorAll(".toc-item a");
  let headings = Array.from(document.querySelectorAll(".article-content h2, .article-content h3"))
    .filter((h) => h.id);
  // 透明底黑线配图自动对比度检测与反色呈现
  function parseCssColor(str) {
    if (!str || str === "transparent") return null;
    const s = String(str).trim();
    const mRgb = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(s);
    if (mRgb) {
      let a = 1;
      if (mRgb[4] !== undefined) {
        a = mRgb[4].endsWith("%") ? parseFloat(mRgb[4]) / 100 : parseFloat(mRgb[4]);
      }
      return { r: Number(mRgb[1]), g: Number(mRgb[2]), b: Number(mRgb[3]), a: Number.isFinite(a) ? a : 1 };
    }
    const mSrgb = /^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i.exec(s);
    if (mSrgb) {
      let a = 1;
      if (mSrgb[4] !== undefined) {
        a = mSrgb[4].endsWith("%") ? parseFloat(mSrgb[4]) / 100 : parseFloat(mSrgb[4]);
      }
      return {
        r: Number(mSrgb[1]) * 255,
        g: Number(mSrgb[2]) * 255,
        b: Number(mSrgb[3]) * 255,
        a: Number.isFinite(a) ? a : 1,
      };
    }
    return null;
  }

  function relLuminance(r, g, b) {
    const ch = [r, g, b].map((v) => {
      const c = Math.max(0, Math.min(255, v)) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function resolveBgRgb(el) {
    const layers = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const parsed = parseCssColor(window.getComputedStyle(cur).backgroundColor);
      if (parsed && parsed.a > 0.01) {
        layers.push(parsed);
        if (parsed.a >= 0.99) break;
      }
      cur = cur.parentElement;
    }
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    let acc = isDark ? { r: 18, g: 17, b: 23 } : { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) {
      const top = layers[i];
      const a = Math.max(0, Math.min(1, top.a));
      acc = {
        r: top.r * a + acc.r * (1 - a),
        g: top.g * a + acc.g * (1 - a),
        b: top.b * a + acc.b * (1 - a),
      };
    }
    return acc;
  }

  function shouldInvertSamples(rgba, bgRgb) {
    if (!rgba || rgba.length < 4 || !bgRgb) return false;
    const total = rgba.length / 4;
    let transparentCount = 0;
    let inkWeight = 0;
    let fgLumSum = 0;
    let invLumSum = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3] / 255;
      if (a < 0.1) {
        transparentCount++;
        continue;
      }
      inkWeight += a;
      fgLumSum += a * relLuminance(rgba[i], rgba[i + 1], rgba[i + 2]);
      invLumSum += a * relLuminance(255 - rgba[i], 255 - rgba[i + 1], 255 - rgba[i + 2]);
    }
    if (inkWeight === 0 || transparentCount / total < 0.08) return false;
    const bgLum = relLuminance(bgRgb.r, bgRgb.g, bgRgb.b);
    const curContrast = contrastRatio(fgLumSum / inkWeight, bgLum);
    const invContrast = contrastRatio(invLumSum / inkWeight, bgLum);
    return curContrast < 3.0 && invContrast > curContrast * 1.5;
  }

  let sampleCanvas = null;
  function evaluateImageContrast(img) {
    if (!img || !img.complete || !(img.naturalWidth > 0)) return;
    const bgRgb = resolveBgRgb(img);
    try {
      const w = Math.max(16, Math.min(64, img.naturalWidth));
      const h = Math.max(16, Math.min(64, img.naturalHeight));
      if (!sampleCanvas) sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = w;
      sampleCanvas.height = h;
      const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      img.classList.toggle("img-auto-invert", shouldInvertSamples(data, bgRgb));
    } catch (_) {
      // file:// 预览下 canvas 读取同源 SVG 可能受限：深色底对透明 SVG 回落反色
      const src = img.getAttribute("src") || "";
      const isSvg = /\.svg(?:[?#]|$)/i.test(src);
      const isDarkBg = relLuminance(bgRgb.r, bgRgb.g, bgRgb.b) < 0.25;
      img.classList.toggle("img-auto-invert", isSvg && isDarkBg);
    }
  }

  function updateAllImageContrast() {
    document.querySelectorAll(".article-content img").forEach((img) => {
      if (!img.dataset.contrastBound) {
        img.dataset.contrastBound = "1";
        img.addEventListener("load", () => evaluateImageContrast(img));
      }
      if (img.complete && img.naturalWidth > 0) evaluateImageContrast(img);
    });
  }

  window.__contrastInvert = {
    parseCssColor: parseCssColor,
    relLuminance: relLuminance,
    contrastRatio: contrastRatio,
    shouldInvertSamples: shouldInvertSamples,
    updateAllImageContrast: updateAllImageContrast,
  };

  if (typeof MutationObserver === "function") {
    new MutationObserver(() => {
      updateAllImageContrast();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", () => {
        if (!localStorage.getItem("theme")) {
          document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
          syncThemeButtons();
        }
        updateAllImageContrast();
      });
    }
  }
  updateAllImageContrast();

  let onScroll = null;

  window.__readerRescan = function () {
    tocLinks = document.querySelectorAll(".toc-item a");
    headings = Array.from(document.querySelectorAll(".article-content h2, .article-content h3"))
      .filter((h) => h.id);
    if (typeof onScroll === "function") onScroll();
    scheduleInlineMathOverflow();
    updateAllImageContrast();
  };
  if (tocLinks.length > 0) {

    onScroll = function () {
      const scrollY = window.scrollY || window.pageYOffset;
      let currentHeadingId = "";
      let currentTop = -Infinity;

      // 取「已越过视口顶线、且文档位置最靠下」的那个标题 = 当前所在。
      // 不能像以前那样遇到第一个未越过的就 break：折叠面板（:::collapse）里的标题
      // 是**收起面板中的 h3**，原生 <details> 收起时其内容仍占布局位、位置与展开后
      // 不一致，DOM 顺序与纵向顺序就此错开——一 break 就永远停在错的那一项
      // （2026-10-13 用户报「跟着算一遍相关锚点会漂移」）。
      // 同时跳过收起面板里的标题：它此刻并不可见，不该被高亮。
      for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        const det = h.closest("details");
        if (det && !det.open) continue;
        const top = h.getBoundingClientRect().top + scrollY - 90;
        if (scrollY >= top && top > currentTop) {
          currentTop = top;
          currentHeadingId = h.id;
        }
      }

      tocLinks.forEach((link) => {
        const item = link.closest(".toc-item");
        if (!item) return;
        if (link.getAttribute("href") === "#" + currentHeadingId) {
          item.classList.add("active");
        } else {
          item.classList.remove("active");
        }
      });
    }

    // 高亮除了滚动，还要在**导航发生时**重算：点目录/深链接会让
    // disclosure-anchor.mjs 展开折叠面板并重滚，页面位置由脚本改变，
    // 只靠 scroll 事件可能漏掉（且 hashchange 先于展开后的重滚）。
    window.addEventListener("hashchange", onScroll);
    // 用户手动开合面板同样改变布局，重算一次。
    document.addEventListener("toggle", onScroll, true);
    // 滚动用 rAF 合并（2026-10-19）：onScroll 对每个标题调 getBoundingClientRect，
    // 会强制同步布局。移动端 scroll 事件的密度高于帧率，逐个处理就是白烧主线程——
    // 一帧最多算一次。
    let scrollQueued = false;
    window.addEventListener("scroll", () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => { scrollQueued = false; onScroll(); });
    }, { passive: true });
    onScroll();
  }
})();
