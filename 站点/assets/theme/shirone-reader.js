// Shirone M3E Reader Interactive Script
(function () {
  const currentTheme = localStorage.getItem("theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", currentTheme === "dark" ? "dark" : "light");

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
      e.stopPropagation();
      setTheme(btn.getAttribute("data-theme-set"));
    });
  });

  const drawerToggleBtn = document.getElementById("drawer-toggle");
  const drawer = document.getElementById("m3-drawer");
  const backdrop = document.getElementById("drawer-backdrop");

  function toggleDrawer() {
    if (window.innerWidth > 860) {
      document.body.classList.toggle("sidebar-collapsed");
      return;
    }
    if (!drawer) return;
    const isOpen = drawer.classList.contains("open");
    drawer.classList.toggle("open", !isOpen);
    if (backdrop) backdrop.classList.toggle("open", !isOpen);
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

  function initSidebarResizer() {
    const resizer = document.getElementById("sidebar-resizer");
    const DEFAULT_SIDEBAR_WIDTH = 320;
    const MIN_SIDEBAR_WIDTH = 240;
    const MAX_SIDEBAR_WIDTH = 580;

    const savedWidth = localStorage.getItem("shirone-sidebar-width");
    if (savedWidth && window.innerWidth > 860) {
      const num = parseInt(savedWidth, 10);
      if (!isNaN(num) && num >= MIN_SIDEBAR_WIDTH && num <= MAX_SIDEBAR_WIDTH) {
        document.documentElement.style.setProperty("--sidebar-width", num + "px");
      }
    }
    if (!resizer) return;
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener("mousedown", (e) => {
      if (window.innerWidth <= 860) return;
      isResizing = true;
      startX = e.clientX;
      startWidth = drawer ? drawer.getBoundingClientRect().width : DEFAULT_SIDEBAR_WIDTH;
      resizer.classList.add("resizing");
      document.body.classList.add("sidebar-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(startWidth + e.clientX - startX)));
      document.documentElement.style.setProperty("--sidebar-width", newWidth + "px");
    });

    window.addEventListener("mouseup", () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove("resizing");
      document.body.classList.remove("sidebar-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (drawer) localStorage.setItem("shirone-sidebar-width", Math.round(drawer.getBoundingClientRect().width));
    });

    resizer.addEventListener("dblclick", () => {
      document.documentElement.style.setProperty("--sidebar-width", DEFAULT_SIDEBAR_WIDTH + "px");
      localStorage.setItem("shirone-sidebar-width", DEFAULT_SIDEBAR_WIDTH);
    });
  }
  initSidebarResizer();

  function initTocResizer() {
    const resizer = document.getElementById("toc-resizer");
    const tocEl = document.querySelector(".m3-toc");
    const DEF = 240, MIN = 180, MAX = 420;
    const saved = localStorage.getItem("shirone-toc-width");
    const num = saved ? parseInt(saved, 10) : NaN;
    if (window.innerWidth > 860 && num >= MIN && num <= MAX) {
      document.documentElement.style.setProperty("--toc-width", num + "px");
    }
    if (!resizer || !tocEl) return;
    let active = false, startX = 0, startW = 0;
    resizer.addEventListener("mousedown", (e) => {
      if (window.innerWidth <= 860) return;
      active = true;
      startX = e.clientX;
      startW = tocEl.getBoundingClientRect().width;
      resizer.classList.add("resizing");
      document.body.classList.add("sidebar-resizing");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!active) return;
      const w = Math.max(MIN, Math.min(MAX, Math.round(startW + startX - e.clientX)));
      document.documentElement.style.setProperty("--toc-width", w + "px");
    });
    window.addEventListener("mouseup", () => {
      if (!active) return;
      active = false;
      resizer.classList.remove("resizing");
      document.body.classList.remove("sidebar-resizing");
      localStorage.setItem("shirone-toc-width", Math.round(tocEl.getBoundingClientRect().width));
    });
    resizer.addEventListener("dblclick", () => {
      document.documentElement.style.setProperty("--toc-width", DEF + "px");
      localStorage.setItem("shirone-toc-width", DEF);
    });
  }
  initTocResizer();

  function initNavGroups() {
    const toggleAllBtn = document.getElementById("toggle-all-groups-btn");
    const toggleAllText = document.getElementById("toggle-all-text");
    const getNavGroups = () => document.querySelectorAll(".drawer-nav-group");

    function updateToggleAllButtonState() {
      if (!toggleAllBtn || !toggleAllText) return;
      const hasExpanded = Array.from(getNavGroups()).some(g => g.classList.contains("expanded"));
      toggleAllText.textContent = hasExpanded ? "全部收起" : "全部展开";
    }

    function toggleGroup(group) {
      if (!group) return;
      if (group.classList.contains("expanded")) {
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
      } else finishExpand();
    }

    if (drawer) {
      drawer.addEventListener("click", (e) => {
        const btn = e.target?.closest(".nav-collapse-btn") || null;
        if (btn) { e.stopPropagation(); toggleGroup(btn.closest(".drawer-nav-group")); return; }
        const header = e.target?.closest(".nav-group-header.nav-header-clickable") || null;
        if (header) { e.stopPropagation(); toggleGroup(header.closest(".drawer-nav-group")); }
      });
    }

    if (toggleAllBtn) {
      toggleAllBtn.addEventListener("click", () => {
        const groups = Array.from(getNavGroups());
        if (groups.some(g => g.classList.contains("expanded"))) {
          groups.forEach(g => { g.classList.remove("expanded"); g.classList.add("collapsed"); });
          updateToggleAllButtonState();
          return;
        }
        const applyExpandAll = () => {
          getNavGroups().forEach(g => { g.classList.remove("collapsed"); g.classList.add("expanded"); });
          updateToggleAllButtonState();
        };
        if (document.querySelector("li[data-nav-lazy='1']") && window.__navStructure?.hydrateAll) {
          window.__navStructure.hydrateAll().then(applyExpandAll);
        } else applyExpandAll();
      });
    }
  }
  initNavGroups();

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
    const btn = e.target?.closest(".copy-btn") || null;
    if (!btn) return;
    const wrap = btn.closest(".code-fence-wrapper");
    const codeBlock = wrap?.querySelector("code");
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

  function initPalette() {
    const DEFAULT_HUE = 248;
    const paletteToggleBtn = document.getElementById("palette-toggle");
    const palettePopover = document.getElementById("palette-popover");
    const hueSlider = document.getElementById("hue-slider");
    const hueBadge = document.getElementById("palette-hue-badge");
    const swatchButtons = document.querySelectorAll(".palette-swatch-item");

    function applyHue(hue, save = true) {
      const val = parseInt(hue, 10);
      document.documentElement.style.setProperty("--hue", val);
      document.documentElement.style.setProperty("--primary-h", val);
      if (hueBadge) hueBadge.textContent = `Hue ${val}°`;
      if (hueSlider) hueSlider.value = val;
      swatchButtons.forEach(btn => {
        btn.classList.toggle("active", parseInt(btn.getAttribute("data-hue"), 10) === val);
      });
      if (save) localStorage.setItem("theme-hue", val);
    }

    const savedHue = localStorage.getItem("theme-hue");
    applyHue(savedHue !== null ? savedHue : DEFAULT_HUE, false);

    const setExpanded = (open) => {
      if (paletteToggleBtn) paletteToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    if (paletteToggleBtn && palettePopover) {
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
      palettePopover.addEventListener("click", (e) => e.stopPropagation());
    }
    return { applyHue, hueSlider, DEFAULT_HUE, swatchButtons, setExpanded };
  }
  const fontSlider = document.getElementById("font-size-slider");
  const fontSizeValue = document.getElementById("font-size-value");
  const fontSample = document.getElementById("font-sample");
  const resetBtn = document.getElementById("palette-reset-btn");
  const { applyHue, hueSlider, DEFAULT_HUE, swatchButtons, setExpanded } = initPalette();
  const paletteToggleBtn = document.getElementById("palette-toggle");
  const palettePopover = document.getElementById("palette-popover");
  function initPaletteEvents() {
    if (paletteToggleBtn && palettePopover) {
      document.addEventListener("click", () => {
        palettePopover.classList.remove("open");
        setExpanded(false);
      });
    }
    if (hueSlider) {
      hueSlider.addEventListener("input", (e) => applyHue(e.target.value, true));
    }
    swatchButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const hue = btn.getAttribute("data-hue");
        if (hue) applyHue(hue, true);
      });
    });
    const randomBtn = document.getElementById("palette-random-btn");
    if (randomBtn) {
      randomBtn.addEventListener("click", () => {
        applyHue(Math.floor(Math.random() * 360), true);
      });
    }
  }
  initPaletteEvents();

  const FONT_KEY = "site-font-size";
  const FONT_DEFAULT = 16;

  function initFontSize() {
    const FONT_MIN = 14;
    const FONT_MAX = 25;
    const syncFontSizeUi = (n) => {
      const pct = ((n - FONT_MIN) / (FONT_MAX - FONT_MIN)) * 100;
      if (fontSizeValue) fontSizeValue.textContent = n + "px";
      if (fontSlider) {
        fontSlider.value = n;
        fontSlider.style.setProperty("--font-pct", pct.toFixed(1) + "%");
      }
      if (fontSample) fontSample.style.fontSize = n + "px";
    };
    return function applyFontSize(px, save = true) {
      const n = Math.max(FONT_MIN, Math.min(FONT_MAX, parseInt(px, 10) || FONT_DEFAULT));
      document.documentElement.style.fontSize = n + "px";
      document.documentElement.style.setProperty("--base-font-size", n + "px");
      syncFontSizeUi(n);
      if (save) { try { localStorage.setItem(FONT_KEY, String(n)); } catch (_e) { /* 隐私模式 */ } }
      if (typeof scheduleInlineMathOverflow === "function") scheduleInlineMathOverflow();
    };
  }
  const applyFontSize = initFontSize();

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
  function initMathOverflow() {
    scheduleInlineMathOverflow();
    if (document.fonts && typeof document.fonts.ready?.then === "function") {
      document.fonts.ready.then(scheduleInlineMathOverflow);
    }
    window.addEventListener("resize", scheduleInlineMathOverflow);
    document.addEventListener("toggle", scheduleInlineMathOverflow, true);
  }
  initMathOverflow();

  function initFontAndReset() {
    const savedFont = localStorage.getItem(FONT_KEY);
    applyFontSize(savedFont !== null ? savedFont : FONT_DEFAULT, false);
    if (fontSlider) {
      fontSlider.addEventListener("input", (e) => applyFontSize(e.target.value, true));
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        localStorage.removeItem("theme-hue");
        applyHue(DEFAULT_HUE, false);
        try { localStorage.removeItem(FONT_KEY); } catch (_e) { /* 隐私模式 */ }
        applyFontSize(FONT_DEFAULT, false);
      });
    }
  }
  initFontAndReset();

  // Table of Contents ScrollSpy
  // SPA 换页钩子（2026-10-17）：tocLinks/headings 换页后要重扫。
  let tocLinks = document.querySelectorAll(".toc-item a");
  let headings = Array.from(document.querySelectorAll(".article-content h2, .article-content h3"))
    .filter((h) => h.id);
  // 透明底黑线配图自动对比度检测与反色呈现
  function parseAlpha(raw) {
    if (raw === undefined) return 1;
    const a = raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
    return Number.isFinite(a) ? a : 1;
  }

  function parseCssColor(str) {
    if (!str || str === "transparent") return null;
    const s = String(str).trim();
    const mRgb = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(s);
    if (mRgb) {
      return { r: Number(mRgb[1]), g: Number(mRgb[2]), b: Number(mRgb[3]), a: parseAlpha(mRgb[4]) };
    }
    const mSrgb = /^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i.exec(s);
    if (mSrgb) {
      return { r: Number(mSrgb[1]) * 255, g: Number(mSrgb[2]) * 255, b: Number(mSrgb[3]) * 255, a: parseAlpha(mSrgb[4]) };
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

  function summarizeSamples(rgba) {
    let transparentCount = 0;
    let inkWeight = 0;
    let fgLumSum = 0;
    let invLumSum = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3] / 255;
      if (a < 0.1) { transparentCount++; continue; }
      inkWeight += a;
      fgLumSum += a * relLuminance(rgba[i], rgba[i + 1], rgba[i + 2]);
      invLumSum += a * relLuminance(255 - rgba[i], 255 - rgba[i + 1], 255 - rgba[i + 2]);
    }
    return { transparentCount, inkWeight, fgLumSum, invLumSum };
  }

  function shouldInvertSamples(rgba, bgRgb) {
    if (!rgba || rgba.length < 4 || !bgRgb) return false;
    const { transparentCount, inkWeight, fgLumSum, invLumSum } = summarizeSamples(rgba);
    if (inkWeight === 0 || transparentCount / (rgba.length / 4) < 0.08) return false;
    const bgLum = relLuminance(bgRgb.r, bgRgb.g, bgRgb.b);
    const curContrast = contrastRatio(fgLumSum / inkWeight, bgLum);
    const invContrast = contrastRatio(invLumSum / inkWeight, bgLum);
    return curContrast < 3.0 && invContrast > curContrast * 1.5;
  }

  let sampleCanvas = null;
  function sampleImageData(img) {
    const w = Math.max(16, Math.min(64, img.naturalWidth));
    const h = Math.max(16, Math.min(64, img.naturalHeight));
    if (!sampleCanvas) sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = w;
    sampleCanvas.height = h;
    const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  function evaluateImageContrast(img) {
    if (!img?.complete || !(img.naturalWidth > 0)) return;
    const bgRgb = resolveBgRgb(img);
    try {
      const data = sampleImageData(img);
      if (data) img.classList.toggle("img-auto-invert", shouldInvertSamples(data, bgRgb));
    } catch (_) {
      const isSvg = /\.svg(?:[?#]|$)/i.test(img.getAttribute("src") || "");
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

  function initThemeObservers() {
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
  }
  initThemeObservers();

  let onScroll = null;

  window.__readerRescan = function () {
    tocLinks = document.querySelectorAll(".toc-item a");
    headings = Array.from(document.querySelectorAll(".article-content h2, .article-content h3"))
      .filter((h) => h.id);
    if (typeof onScroll === "function") onScroll();
    scheduleInlineMathOverflow();
    updateAllImageContrast();
  };
  function initTocScrollSpy() {
    if (tocLinks.length === 0) return;
    onScroll = function () {
      const scrollY = window.scrollY || window.pageYOffset;
      let currentHeadingId = "";
      let currentTop = -Infinity;
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
        item.classList.toggle("active", link.getAttribute("href") === "#" + currentHeadingId);
      });
    };
    window.addEventListener("hashchange", onScroll);
    document.addEventListener("toggle", onScroll, true);
    let scrollQueued = false;
    window.addEventListener("scroll", () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => { scrollQueued = false; onScroll(); });
    }, { passive: true });
    onScroll();
  }
  initTocScrollSpy();

  const ANCHOR_FLASH_MS = 6200;
  let activeFlashEl = null;
  let anchorFlashTimer = null;
  let activeRunController = null;
  let pendingHashFrame = 0;

  function clearAnchorFlash() {
    if (anchorFlashTimer) {
      clearTimeout(anchorFlashTimer);
      anchorFlashTimer = null;
    }
    if (activeFlashEl) {
      activeFlashEl.classList.remove("anchor-flash");
      activeFlashEl = null;
    }
  }

  function startAnchorFlash(el) {
    if (!el || !el.isConnected) return;
    clearAnchorFlash();
    activeFlashEl = el;
    void el.offsetWidth;
    el.classList.add("anchor-flash");
    anchorFlashTimer = setTimeout(() => {
      if (activeFlashEl === el) {
        el.classList.remove("anchor-flash");
        activeFlashEl = null;
      }
      anchorFlashTimer = null;
    }, ANCHOR_FLASH_MS);
  }

  function findTargetByHash(rawHash) {
    const cleaned = String(rawHash || "").replace(/^#/, "").split(":~:")[0];
    if (!cleaned) return null;
    let decoded = cleaned;
    try {
      decoded = decodeURIComponent(cleaned);
    } catch {
      // 保留原始字符串，避免非法 % 序列抛 URIError
    }
    return document.getElementById(decoded) || document.getElementById(cleaned);
  }

  function expandHiddenAncestors(rawEl) {
    let changed = false;
    let cur = rawEl.parentElement;
    while (cur) {
      if (cur.tagName === "DETAILS" && !cur.open) {
        cur.open = true;
        changed = true;
      }
      if (cur.getAttribute("hidden") === "until-found") {
        cur.removeAttribute("hidden");
        changed = true;
      }
      cur = cur.parentElement;
    }
    return changed;
  }

  function hasSize(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function resolveVisualTarget(rawEl) {
    if (hasSize(rawEl)) return rawEl;
    const semantic = rawEl.closest(
      "tr, h1, h2, h3, h4, h5, h6, summary, li, p, dt, dd, blockquote, pre, figure, .m3-disclosure"
    );
    if (semantic && hasSize(semantic)) return semantic;
    let cur = rawEl.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (hasSize(cur)) return cur;
      cur = cur.parentElement;
    }
    return rawEl;
  }

  function getViewportHeight() {
    const vv = window.visualViewport;
    if (vv && vv.scale <= 1.01 && vv.height > 0) return vv.height;
    return window.innerHeight || document.documentElement.clientHeight;
  }

  function getMinTopOffset(el) {
    const smt = parseFloat(getComputedStyle(el).scrollMarginTop);
    if (Number.isFinite(smt) && smt > 0) return smt;
    const headerHeight = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--header-height")
    );
    return (Number.isFinite(headerHeight) ? headerHeight : 0) + 12;
  }

  function computeAlignment(el) {
    const rect = el.getBoundingClientRect();
    const vh = getViewportHeight();
    const minTop = getMinTopOffset(el);
    const usableHeight = Math.max(0, vh - minTop);
    const desiredTop =
      rect.height >= usableHeight
        ? minTop
        : minTop + (usableHeight - rect.height) / 2;
    const delta = rect.top - desiredTop;
    const targetY = Math.max(0, Math.round(window.scrollY + delta));
    return { rect, vh, minTop, desiredTop, delta, targetY };
  }

  function scrollInstantTo(y) {
    try {
      window.scrollTo({ top: y, left: window.scrollX, behavior: "instant" });
    } catch {
      const root = document.documentElement;
      const prev = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      window.scrollTo(window.scrollX, y);
      root.style.scrollBehavior = prev;
    }
  }

  function waitForScrollSettle(signal, { maxWait = 1100, idleMs = 120, startWaitMs = 120 } = {}) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      let doneFlag = false;
      let sawScroll = false;
      let idleTimer = null;
      let startTimer = null;
      let maxTimer = null;

      const finish = (ok) => {
        if (doneFlag) return;
        doneFlag = true;
        clearTimeout(idleTimer);
        clearTimeout(startTimer);
        clearTimeout(maxTimer);
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("scrollend", onScrollEnd);
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };

      const onAbort = () => finish(false);
      const onScrollEnd = () => finish(true);
      const onScroll = () => {
        sawScroll = true;
        clearTimeout(startTimer);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(true), idleMs);
      };

      signal.addEventListener("abort", onAbort, { once: true });
      window.addEventListener("scroll", onScroll, { passive: true });
      if ("onscrollend" in window) {
        window.addEventListener("scrollend", onScrollEnd, { once: true });
      }

      startTimer = setTimeout(() => {
        if (!sawScroll) finish(true);
      }, startWaitMs);
      maxTimer = setTimeout(() => finish(true), maxWait);
    });
  }

  function isElementInView(el) {
    const r = el.getBoundingClientRect();
    const vh = getViewportHeight();
    return r.bottom > 0 && r.top < vh;
  }

  function bindUserAbort(controller, signal) {
    requestAnimationFrame(() => {
      if (signal.aborted) return;
      const onUserIntent = () => controller.abort();
      const abortKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
      const onKey = (e) => { if (abortKeys.has(e.key)) controller.abort(); };
      ["wheel", "touchstart", "pointerdown"].forEach((ev) =>
        window.addEventListener(ev, onUserIntent, { passive: true, once: true, signal })
      );
      window.addEventListener("keydown", onKey, { passive: true, signal });
    });
  }

  async function focusAnchorTarget(rawHash, options = {}) {
    const mode = options.mode === "arrival" ? "arrival" : "inpage";
    const rawEl = findTargetByHash(rawHash);
    if (!rawEl) return;

    activeRunController?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    activeRunController = controller;

    expandHiddenAncestors(rawEl);
    const el = resolveVisualTarget(rawEl);

    const root = document.documentElement;
    const prevOverflowAnchor = root.style.overflowAnchor;
    root.style.overflowAnchor = "none";

    const observers = [];
    let cleanupTimer = null;
    signal.addEventListener("abort", () => {
      clearTimeout(cleanupTimer);
      observers.forEach((o) => o.disconnect());
      observers.length = 0;
      root.style.overflowAnchor = prevOverflowAnchor;
      if (activeRunController === controller) activeRunController = null;
    }, { once: true });

    bindUserAbort(controller, signal);

    let flashed = false;
    const ensureFlash = () => {
      if (flashed || signal.aborted) return;
      if (isElementInView(el)) {
        flashed = true;
        startAnchorFlash(el);
      }
    };

    let programmaticUntil = 0;
    let corrections = 0;
    const alignInstant = () => {
      if (signal.aborted || !el.isConnected || corrections >= 18) return false;
      const a = computeAlignment(el);
      if (Math.abs(a.delta) <= 5) {
        ensureFlash();
        return true;
      }
      const beforeY = window.scrollY;
      programmaticUntil = performance.now() + 80;
      corrections += 1;
      scrollInstantTo(a.targetY);
      const afterY = window.scrollY;
      ensureFlash();
      return Math.abs(afterY - beforeY) >= 1 || Math.abs(a.targetY - afterY) <= 5;
    };

    let alignRaf = 0;
    const scheduleAlign = () => {
      if (signal.aborted || alignRaf) return;
      alignRaf = requestAnimationFrame(() => {
        alignRaf = 0;
        alignInstant();
      });
    };

    const attachStabilizers = (windowMs) => {
      if (signal.aborted) return;
      if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(() => scheduleAlign());
        ro.observe(document.querySelector(".article-content") || document.body);
        ro.observe(el);
        observers.push(ro);
      }
      window.visualViewport?.addEventListener("resize", scheduleAlign, { signal });
      document.fonts?.ready?.then(() => !signal.aborted && scheduleAlign());
      if (document.readyState !== "complete") {
        window.addEventListener("load", () => {
          scheduleAlign();
          clearTimeout(cleanupTimer);
          cleanupTimer = setTimeout(() => controller.abort(), 900);
        }, { once: true, signal });
      }
      cleanupTimer = setTimeout(() => controller.abort(), windowMs);
    };

    const runArrivalMode = () => {
      alignInstant();
      requestAnimationFrame(() => alignInstant());
      const nativeGuardEnd = performance.now() + 500;
      window.addEventListener("scroll", () => {
        if (signal.aborted || performance.now() < programmaticUntil || performance.now() > nativeGuardEnd) return;
        const a = computeAlignment(el);
        if (Math.abs(a.rect.top - a.minTop) <= 20 && Math.abs(a.delta) > 12) scheduleAlign();
      }, { passive: true, signal });
      attachStabilizers(document.readyState === "complete" ? 1200 : 3500);
      setTimeout(() => { if (!flashed && !signal.aborted) { flashed = true; startAnchorFlash(el); } }, 150);
    };

    const runInpageMode = async () => {
      const first = computeAlignment(el);
      if (Math.abs(first.delta) <= 5) {
        startAnchorFlash(el);
        flashed = true;
        attachStabilizers(450);
        return;
      }
      programmaticUntil = performance.now() + 1200;
      window.scrollTo({ top: first.targetY, left: window.scrollX, behavior: "smooth" });
      const ok = await waitForScrollSettle(signal, { maxWait: 1100, idleMs: 120, startWaitMs: 120 });
      if (!ok || signal.aborted) return;
      alignInstant();
      if (!flashed) { flashed = true; startAnchorFlash(el); }
      attachStabilizers(450);
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (mode === "arrival" || reduceMotion) { runArrivalMode(); return; }
    await runInpageMode();
  }

  function isSamePageAnchorLink(link) {
    if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return null;
    try {
      const url = new URL(link.href, window.location.href);
      const sameDoc = ["origin", "pathname", "search"].every((k) => url[k] === window.location[k]);
      return sameDoc && url.hash ? url.hash : null;
    } catch {
      return null;
    }
  }

  function isPlainLeftClick(e) {
    return !e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
  }

  function handleAnchorLinkClick(e) {
    if (!isPlainLeftClick(e)) return;
    const hash = isSamePageAnchorLink(e.target?.closest?.("a[href]"));
    if (!hash || !findTargetByHash(hash)) return;
    e.preventDefault();
    if (window.location.hash !== hash) history.pushState(null, "", hash);
    focusAnchorTarget(hash, { mode: "inpage" });
  }

  function initAnchorFocus() {
    window.__focusAnchorTarget = focusAnchorTarget;
    document.addEventListener("click", handleAnchorLinkClick);

    const scheduleHashFocus = () => {
      if (!window.location?.hash) return;
      if (pendingHashFrame) cancelAnimationFrame(pendingHashFrame);
      pendingHashFrame = requestAnimationFrame(() => {
        pendingHashFrame = 0;
        focusAnchorTarget(window.location.hash, { mode: "inpage" });
      });
    };
    window.addEventListener("hashchange", scheduleHashFocus);
    window.addEventListener("popstate", scheduleHashFocus);

    window.addEventListener("pageshow", (e) => {
      if (e.persisted && window.location?.hash) {
        focusAnchorTarget(window.location.hash, { mode: "arrival" });
      }
    });

    if (window.location?.hash) {
      const boot = () => focusAnchorTarget(window.location.hash, { mode: "arrival" });
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
      } else {
        boot();
      }
    }
  }
  initAnchorFocus();
})();
