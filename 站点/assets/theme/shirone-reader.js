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
