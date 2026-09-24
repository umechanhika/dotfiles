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

  // ---- HTML mode only: keep a commented/hovered <li>'s highlight confined
  // to its own line, not its nested sub-list ----
  // A parent <li>'s box wraps its own text AND its nested <ul>/<ol> (the
  // sub-list is a normal block child sitting inside it), so the outline drawn
  // by .rd-hover/.rd-commented on the <li> itself would visually engulf the
  // children below it too. Markdown mode avoids this by moving the item's own
  // nodes into a dedicated wrapper div at render time (isolateOwnContent,
  // comment.02-render.js) — but that render is doc-review's own output, fully
  // ours to restructure. HTML mode instead renders the target's own original
  // markup as-is (loadFrame/onFrameLoad) so its structure stays exactly what
  // the target authored; inserting a wrapper there would mutate content this
  // tool exists to show faithfully.
  //
  // clip-path was tried first and rejected: it clips the WHOLE box it's set
  // on, content included, not just the outline paint — confining it to the
  // own-content height made the nested list itself invisible while hovered,
  // not just unhighlighted. frame-overlay.css instead draws the confined
  // outline on a `::before` pseudo-element (li:has(> ul, > ol).rd-hover /
  // .rd-commented), sized off the --rd-li-own-h custom property this sets. A
  // pseudo-element is an extra PAINT layer, not a clip — the real children
  // stay fully rendered underneath it, and (unlike an inserted real element)
  // it never appears in the target's own child list, so it can't affect any
  // of the target's own :nth-child/sibling-combinator/flex-item-count CSS.
  function syncLiOwnContentHeight(li) {
    if (!li || li.tagName !== "LI") return;
    var nested = null;
    for (var i = 0; i < li.children.length; i++) {
      var c = li.children[i];
      if (c.tagName === "UL" || c.tagName === "OL") { nested = c; break; }
    }
    if (!nested) { li.style.removeProperty("--rd-li-own-h"); return; }
    var liRect = li.getBoundingClientRect();
    var nestedRect = nested.getBoundingClientRect();
    var ownHeight = nestedRect.top - liRect.top;
    if (ownHeight <= 0 || ownHeight >= liRect.height) { li.style.removeProperty("--rd-li-own-h"); return; }
    li.style.setProperty("--rd-li-own-h", ownHeight + "px");
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
