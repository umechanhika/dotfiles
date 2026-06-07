"use strict";


  // ===================================================================
  // utils
  // ===================================================================
  // CSS path rooted at the real document root (the iframe's <body> for HTML),
  // so the path actually describes the user's source HTML structure. css_path is
  // supplementary anchoring info (outer_html_excerpt is the primary key); the
  // root prefix is stripped by stripRootPath before querying within rdRoot().
  function cssPath(el) {
    var root = rdRoot();
    var rootName = isHtml() ? "body" : "#rd-content";
    if (!el || el === root) return rootName;
    var parts = [];
    var node = el;
    while (node && node !== root && node.nodeType === 1) {
      var sel = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = parent;
    }
    return rootName + " > " + parts.join(" > ");
  }
  function stripRootPath(path) { return path.replace(/^(?:#rd-content|body)\s*>\s*/, ""); }
  // Normalise a block's raw markdown for content comparison: marked's tok.raw
  // can carry trailing newlines that the text Claude reads back from the file
  // won't, so compare on a trimmed, \n-normalised form.
  function normRaw(s) { return (s || "").replace(/\r\n/g, "\n").trim(); }
  function stripEllipsis(s) { return (s || "").replace(/…$/, ""); }
  function excerpt(s, n) { s = s || ""; return s.length > n ? s.slice(0, n) + "…" : s; }
  function escapeHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function rectOf(range) {
    var rects = range.getClientRects();
    return rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  }
  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add("show");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { elToast.classList.remove("show"); }, 3500);
  }

  // ===================================================================
  // sidebar resize (drag the left edge; width persists in localStorage)
  // ===================================================================
  // The whole layout keys off the --rd-sidebar-w custom property (the sidebar
  // width AND #rd-main's right margin), so resizing is just rewriting that one
  // variable. The marker gutter uses a separate var, so markers are unaffected.
  var SIDEBAR_W_KEY = "docReview.sidebarW";
  function clampSidebarWidth(w) {
    var max = Math.min(820, Math.round(window.innerWidth * 0.6));
    var min = 300;
    if (max < min) max = min;
    return Math.max(min, Math.min(max, w));
  }
  function setSidebarWidth(w) {
    document.documentElement.style.setProperty("--rd-sidebar-w", clampSidebarWidth(w) + "px");
  }
  function currentSidebarWidth() {
    return elSidebar ? Math.round(elSidebar.getBoundingClientRect().width) : 340;
  }
  function initSidebarResize() {
    var handle = document.getElementById("rd-resize-handle");
    if (!handle) return;

    // restore a saved width, re-clamped to the current viewport
    var saved = parseInt(localStorage.getItem(SIDEBAR_W_KEY) || "", 10);
    if (saved) setSidebarWidth(saved);

    var startX = 0, startW = 0, pending = 0, raf = 0;
    function onMove(e) {
      pending = clampSidebarWidth(startW - (e.clientX - startX));
      if (raf) return;   // throttle: at most one DOM write per frame (margin reflow is heavy)
      raf = requestAnimationFrame(function () {
        raf = 0;
        document.documentElement.style.setProperty("--rd-sidebar-w", pending + "px");
      });
    }
    function onUp() {
      document.body.classList.remove("rd-resizing");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      document.documentElement.style.setProperty("--rd-sidebar-w", pending + "px");
      try { localStorage.setItem(SIDEBAR_W_KEY, String(pending)); } catch (e) { /* private mode */ }
    }
    handle.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      startX = e.clientX;
      startW = currentSidebarWidth();
      pending = startW;
      document.body.classList.add("rd-resizing");
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });

    // a saved-wide sidebar must not overflow after the window shrinks
    window.addEventListener("resize", function () { setSidebarWidth(currentSidebarWidth()); });
  }


var ReviewDoc = { start: start };
