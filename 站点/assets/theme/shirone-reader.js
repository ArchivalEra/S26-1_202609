// Shirone M3E Reader Interactive Script
(function () {
  // Theme Toggle
  const themeToggleBtn = document.getElementById("theme-toggle");
  const currentTheme = localStorage.getItem("theme") || 
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  
  if (currentTheme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const active = document.documentElement.getAttribute("data-theme");
      const next = active === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
    });
  }

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

  // Collapsible Navigation Groups (Accordion & Collapse-All)
  const navGroups = document.querySelectorAll(".drawer-nav-group");
  const toggleAllBtn = document.getElementById("toggle-all-groups-btn");
  const toggleAllText = document.getElementById("toggle-all-text");

  function updateToggleAllButtonState() {
    if (!toggleAllBtn || !toggleAllText) return;
    const hasExpanded = Array.from(navGroups).some(g => g.classList.contains("expanded"));
    toggleAllText.textContent = hasExpanded ? "全部收起" : "全部展开";
  }

  navGroups.forEach(group => {
    const collapseBtn = group.querySelector(":scope > .nav-group-header .nav-collapse-btn");
    const clickableHeader = group.querySelector(":scope > .nav-group-header.nav-header-clickable");

    function toggleGroup(e) {
      if (e) e.stopPropagation();
      const isExpanded = group.classList.contains("expanded");
      if (isExpanded) {
        group.classList.remove("expanded");
        group.classList.add("collapsed");
      } else {
        group.classList.remove("collapsed");
        group.classList.add("expanded");
      }
      updateToggleAllButtonState();
    }

    if (collapseBtn) {
      collapseBtn.addEventListener("click", toggleGroup);
    }
    if (clickableHeader) {
      clickableHeader.addEventListener("click", toggleGroup);
    }
  });

  if (toggleAllBtn) {
    toggleAllBtn.addEventListener("click", () => {
      const hasExpanded = Array.from(navGroups).some(g => g.classList.contains("expanded"));
      navGroups.forEach(group => {
        if (hasExpanded) {
          group.classList.remove("expanded");
          group.classList.add("collapsed");
        } else {
          group.classList.remove("collapsed");
          group.classList.add("expanded");
        }
      });
      updateToggleAllButtonState();
    });
  }

  // Copy Code
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const codeBlock = btn.closest(".code-fence-wrapper").querySelector("code");
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
  });

  // Theme Palette (Color Picker & Presets)
  const DEFAULT_HUE = 248;
  const paletteToggleBtn = document.getElementById("palette-toggle");
  const palettePopover = document.getElementById("palette-popover");
  const hueSlider = document.getElementById("hue-slider");
  const hueBadge = document.getElementById("palette-hue-badge");
  const resetBtn = document.getElementById("palette-reset-btn");
  const swatchButtons = document.querySelectorAll(".palette-swatch-item");

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
    paletteToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      palettePopover.classList.toggle("open");
    });

    palettePopover.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    document.addEventListener("click", () => {
      palettePopover.classList.remove("open");
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

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      localStorage.removeItem("theme-hue");
      applyHue(DEFAULT_HUE, false);
    });
  }

  // Table of Contents ScrollSpy
  const tocLinks = document.querySelectorAll(".toc-item a");
  if (tocLinks.length > 0) {
    const headings = Array.from(document.querySelectorAll(".article-content h2, .article-content h3"))
      .filter((h) => h.id);
    
    function onScroll() {
      const scrollY = window.scrollY || window.pageYOffset;
      let currentHeadingId = "";

      for (let i = 0; i < headings.length; i++) {
        const top = headings[i].getBoundingClientRect().top + scrollY - 90;
        if (scrollY >= top) {
          currentHeadingId = headings[i].id;
        } else {
          break;
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

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();

/* ==========================================================================
   全站搜索（Pagefind）
   索引由构建产物生成（npx pagefind --site dist），这里只做前端交互：
   点击放大镜展开 → 输入 → 结果列表 → 方向键选择 → 回车/点击跳转 → ESC 关闭。
   结果链接是站点根为基准的相对路径，需按当前页深度拼前缀。
   ========================================================================== */
(function () {
  const toggleBtn = document.getElementById("search-toggle");
  const panel = document.getElementById("search-panel");
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  const closeBtn = document.getElementById("search-close");
  if (!toggleBtn || !panel || !input || !results) return;

  let pagefind = null;      // 懒加载：首次打开才引入索引模块
  let activeIndex = -1;     // 方向键选中的结果序号
  let currentHits = [];

  // 站点根 URL：从当前页地址逐级上跳 data-depth 层。
  // 例：/repo/S26-1_202609/课程/…/x.html（depth=4）→ /repo/S26-1_202609/
  function siteRootUrl() {
    const depth = parseInt(document.documentElement.dataset.depth || "0", 10);
    let dir = location.pathname.replace(/[^/]*$/, "");   // 当前页所在目录，以 / 结尾
    for (let i = 0; i < depth; i++) {
      dir = dir.replace(/[^/]+\/$/, "");                  // 逐级上跳
    }
    if (!dir.endsWith("/")) dir += "/";
    return location.origin + dir;
  }

  // 把索引里的 url 解析成可用地址。两种形态都要兼容：
  // - 未带部署前缀：/课程/…（需补上当前站点根）
  // - 已带部署前缀：/repo/S26-1_202609/课程/…（直接用）
  // 判据用「站点根路径本身」做前缀比较，而不是只比首段，避免 /repo 这类
  // 首段相同但层级不同的误判。
  function resolveHitUrl(rawUrl) {
    let decoded = rawUrl;
    try { decoded = decodeURIComponent(rawUrl); } catch (_) { /* 保留原样 */ }
    const encoded = decoded.replace(/^\//, "").split("/")
      .map((seg) => encodeURIComponent(seg)).join("/");

    const rootPath = new URL(siteRootUrl()).pathname;   // /repo/S26-1_202609/
    const rootPrefix = rootPath.replace(/^\//, "");      // repo/S26-1_202609/

    // 已含部署前缀：直接拼到 origin
    if (rootPrefix && (encoded + "/").startsWith(rootPrefix)) {
      return location.origin + "/" + encoded;
    }
    return location.origin + rootPath + encoded;
  }

  function openPanel() {
    panel.hidden = false;
    document.body.classList.add("search-open");
    input.focus();
  }

  function closePanel() {
    panel.hidden = true;
    document.body.classList.remove("search-open");
    activeIndex = -1;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderHits(hits, query, opts = {}) {
    currentHits = hits;
    activeIndex = -1;
    if (!hits.length) {
      results.innerHTML = `<p class="search-hint">没有找到「${escapeHtml(query)}」相关内容。</p>`;
      return;
    }
    const list = hits.map((hit, i) => {
      const url = resolveHitUrl(hit.url);
      return `<a class="search-hit" href="${url}" data-index="${i}">
        <span class="search-hit-title">${escapeHtml(hit.meta?.title || hit.url)}</span>
        <span class="search-hit-excerpt">${hit.excerpt}</span>
      </a>`;
    }).join("");
    // 渐进式渲染时，末尾提示还有结果在载入
    const more = opts.partial
      ? '<div class="search-progress search-progress-inline"><div class="search-progress-label">正在载入更多结果…</div><div class="search-progress-track"><div class="search-progress-bar search-progress-bar-indeterminate"></div></div></div>'
      : "";
    results.innerHTML = list + more;
  }

  function setActive(next) {
    const items = results.querySelectorAll(".search-hit");
    if (!items.length) return;
    if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].classList.remove("active");
    activeIndex = (next + items.length) % items.length;
    items[activeIndex].classList.add("active");
    items[activeIndex].scrollIntoView({ block: "nearest" });
  }

  async function loadPagefind() {
    if (pagefind) return pagefind;
    // 动态 import 的相对路径是相对「当前脚本文件」而非页面，
    // 所以要用站点根绝对地址，否则会错误地请求
    // /assets/theme/pagefind/pagefind.js。
    const mod = await import(/* @vite-ignore */ siteRootUrl() + "pagefind/pagefind.js");
    pagefind = mod;
    return pagefind;
  }

  let searchSeq = 0;

  // 加载进度条：阶段文字 + 宽度推进。首次搜索要拉 wasm 与索引分片，
  // 在 EdgeOne 上约需数秒，进度条让等待可见。
  function showProgress(percent, label) {
    results.innerHTML = `<div class="search-progress">
      <div class="search-progress-label">${escapeHtml(label)}</div>
      <div class="search-progress-track"><div class="search-progress-bar" style="width:${percent}%"></div></div>
    </div>`;
  }

  async function runSearch(query) {
    const q = query.trim();
    if (!q) {
      results.innerHTML = '<p class="search-hint">输入关键词开始搜索。支持中文词组与公式外的正文；结果按相关度排序，回车打开第一条。</p>';
      return;
    }
    const seq = ++searchSeq;
    const firstLoad = !pagefind;
    if (firstLoad) showProgress(15, "正在加载搜索索引…");
    let pf;
    try {
      pf = await loadPagefind();
      if (seq === searchSeq && firstLoad) showProgress(55, "正在初始化…");
      await pf.init();
      if (seq === searchSeq && firstLoad) showProgress(80, "正在检索…");
    } catch (err) {
      results.innerHTML = '<p class="search-hint">搜索索引未能加载（本地直接打开文件时不可用，请通过站点地址访问）。</p>';
      return;
    }
    const found = await pf.search(q);
    if (seq !== searchSeq) return;   // 已有更新的查询，丢弃这次结果

    // 渐进式渲染：结果分片是逐个请求的（每片约 6KB，但受网络往返限制，
    // 等齐 10 条要两秒多）。哪条先到就先显示，首条通常几百毫秒内出现。
    const slice = found.results.slice(0, 10);
    if (!slice.length) { renderHits([], q); return; }
    const collected = [];
    let arrived = 0;
    await Promise.all(slice.map(async (r) => {
      let data;
      try { data = await r.data(); } catch (_) { return; }
      if (seq !== searchSeq) return;
      collected.push(data);
      arrived += 1;
      // 首条立即显示；其后每 3 条刷新一次，避免频繁重排
      if (arrived === 1 || arrived % 3 === 0 || arrived === slice.length) {
        renderHits(collected.slice(), q, { partial: arrived < slice.length });
      }
    }));
    if (seq === searchSeq && collected.length) renderHits(collected, q);
  }
  toggleBtn.addEventListener("click", () => {
    if (panel.hidden) openPanel(); else closePanel();
  });
  closeBtn?.addEventListener("click", closePanel);

  let debounceTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input.value), 160);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const items = results.querySelectorAll(".search-hit");
      const target = activeIndex >= 0 ? items[activeIndex] : items[0];
      if (target) { e.preventDefault(); target.click(); }
    } else if (e.key === "ArrowDown") {
      e.preventDefault(); setActive(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); setActive(activeIndex - 1);
    } else if (e.key === "Escape") {
      closePanel();
    }
  });

  // 点击面板外部关闭
  panel.addEventListener("click", (e) => {
    if (e.target === panel) closePanel();
  });

  // 快捷键：/ 或 Ctrl/Cmd+K 打开搜索；ESC 关闭
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      openPanel();
    } else if (e.key === "Escape" && !panel.hidden) {
      closePanel();
    }
  });
})();
