"use strict";


  // ===================================================================
  // source: fetch vs apply (split so we can skip re-render when unchanged)
  // ===================================================================
  function fetchSource() {
    return fetch("/source", { cache: "no-store" }).then(function (r) { return r.json(); });
  }

  // Render the body + (re)attach markers + (re)render sidebar. When
  // preserveScroll is set (a live update) we keep the reader where they were.
  //
  // Markdown is synchronous (parse into #rd-content, attach markers now). HTML
  // loads the iframe, which is async: marker attachment + scroll restore happen
  // in the iframe's load handler (onFrameLoad), not here.
  function applySource(data, preserveScroll) {
    state.meta = data;
    elFilename.textContent = data.name;
    if (isHtml()) {
      var prevY = 0;
      if (preserveScroll && elFrame && elFrame.contentWindow) {
        try { prevY = elFrame.contentWindow.scrollY || 0; } catch (e) { /* not loaded yet */ }
      }
      state.pendingScrollY = prevY;
      showFrame(true);
      loadFrame();
    } else {
      showFrame(false);
      var scroller = document.scrollingElement || document.documentElement;
      var y = preserveScroll ? scroller.scrollTop : 0;
      render();
      refreshView();
      if (preserveScroll) scroller.scrollTop = y;
    }
  }

  function showFrame(on) {
    if (!elFrame) return;
    elFrame.hidden = !on;
    elContent.hidden = on;
  }

  // ===================================================================
  // rendering the document
  // ===================================================================
  // Markdown only — HTML goes through the iframe (loadFrame/onFrameLoad).
  function render() {
    docEnv = { doc: document, root: elContent, frame: null };
    elContent.innerHTML = "";
    state.blockRaws = [];
    renderMarkdown(state.meta.content);
  }

  // Load the target HTML into the iframe. We point at "/raw/" (trailing slash)
  // so the document's base URL is /raw/ and its relative href/src resolve to
  // "/raw/<rel>" (served from the target's own directory). The cache-buster
  // guarantees Claude's edits are re-read even if the engine caches the frame.
  function loadFrame() {
    docEnv = null;   // fall back to the parent until the new document is ready
    state.frameSeq = (state.frameSeq || 0) + 1;
    elFrame.onload = onFrameLoad;
    elFrame.src = "/raw/?n=" + state.frameSeq;
  }

  function onFrameLoad() {
    var doc;
    try { doc = elFrame.contentDocument; } catch (e) { doc = null; }
    if (!doc) { setStatus("プレビューを読み込めませんでした"); return; }
    var root = doc.body || doc.documentElement;
    docEnv = { doc: doc, root: root, frame: elFrame };
    injectFrameOverlay(doc);
    // Interaction listeners live on the freshly-loaded document. A new document
    // each load means old listeners are discarded with it — no leak.
    root.addEventListener("mousemove", onHover);
    root.addEventListener("mouseleave", clearHover);
    doc.addEventListener("mouseup", onMouseUp);
    // Keyboard events don't cross the iframe boundary, so when focus sits inside
    // the frame the global shortcuts (Esc, ⌘⇧Enter send) would be missed. These
    // are parent closures; attaching them to the frame doc keeps them working.
    doc.addEventListener("keydown", onGlobalKey);
    state.hovered = null;
    refreshView();   // place markers for the current threads/drafts inside the frame
    if (elFrame.contentWindow) {
      try { elFrame.contentWindow.scrollTo(0, state.pendingScrollY || 0); } catch (e) { /* best effort */ }
    }
    state.pendingScrollY = 0;
  }

  function injectFrameOverlay(doc) {
    var head = doc.head || doc.documentElement;
    if (!head) return;
    var style = doc.getElementById("rd-overlay-style");
    if (!style) {
      style = doc.createElement("style");
      style.id = "rd-overlay-style";
      head.appendChild(style);
    }
    style.textContent = FRAME_OVERLAY_CSS;
  }

  // Render markdown block-by-block. We intentionally parse each top-level token
  // on its own: it is what lets us map every rendered block back to its exact
  // raw markdown (`block_raw`) and a stable `data-srcblock` index. That mapping
  // is the contract the anchoring rules (anchoring.md) rely on, so we keep it —
  // but we reuse a single scratch element instead of allocating one per block.
  function renderMarkdown(md) {
    var tokens = marked.lexer(md);
    var links = tokens.links || {};
    var scratch = document.createElement("div");
    var idx = 0;
    tokens.forEach(function (tok) {
      if (tok.type === "space" || tok.type === "def") return;
      var toks = [tok];
      toks.links = links;
      scratch.innerHTML = marked.parser(toks);
      var children = Array.prototype.slice.call(scratch.children);
      if (children.length === 0) return;
      children.forEach(function (el) {
        var blockEl = el;
        if (el.tagName === "TABLE") {
          // Wrap tables so the commentable block (= marker host) stays a
          // non-scrolling element, while the inner div provides horizontal
          // scroll. Putting overflow on the marker host would clip the marker.
          var scroller = h("div", { "class": "rd-table-scroll" }, [el]);
          blockEl = h("div", { "class": "rd-table-block" }, [scroller]);
        }
        blockEl.dataset.srcblock = String(idx);
        elContent.appendChild(blockEl);
      });
      state.blockRaws[idx] = tok.raw || "";
      idx++;
    });
    // Catch tables nested inside other blocks (e.g. raw HTML blocks) that the
    // top-level wrap above missed. Marker host is the ancestor block here, so a
    // plain scroll wrapper is enough.
    Array.prototype.forEach.call(elContent.querySelectorAll("table"), function (t) {
      if (t.closest(".rd-table-scroll")) return;
      var scroller = h("div", { "class": "rd-table-scroll" });
      t.parentNode.insertBefore(scroller, t);
      scroller.appendChild(t);
    });
  }
