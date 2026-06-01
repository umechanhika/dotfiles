/* doc-review — in-browser threaded commenting for a single markdown/HTML file.
 *
 * Fully local: talks only to its own origin (the serve.py instance).
 * - Renders the source (markdown via bundled marked.js, or HTML as-is)
 * - Hover highlights the block/element under the cursor
 * - Click a block, or drag-select text, to draft a comment (Cmd+Enter to add)
 * - Drafts accumulate; Cmd+Shift+Enter sends them all as one batch
 * - Claude edits the file and replies per thread; replies show under the comment
 * - Re-feedback: reply again on a thread whose edit wasn't right
 * - Comments persist (server-side threads.json) until the user resolves them
 *
 * Data flow notes:
 * - The browser polls GET /rev (cheap, rev-only). Only when rev grows does it
 *   pull /threads + /source. The body is re-parsed ONLY when the source content
 *   actually changed (mtime/content), so a Claude reply (which doesn't touch the
 *   file) no longer wipes and re-renders the whole document — scroll position,
 *   selection, and the open popover survive.
 * - Each comment's badge number is its stable server id (thread "t3" -> 3): it
 *   is assigned once and never renumbered, so resolving one comment doesn't
 *   shift the others. The sidebar is laid out in document order for readability,
 *   but the numbers are ids, not positions, so they may run out of sequence.
 * - Markers are re-placed by matching the anchor's captured content against the
 *   re-rendered document (not a positional index), so edits that move a block
 *   don't strand the marker; content that's gone shows no marker at all.
 */
var ReviewDoc = (function () {
  "use strict";

  // ---- mutable data state (single bag; see also DOM refs below) ----
  var state = {
    meta: null,          // {name, ext, kind, content, mtime, ...}
    blockRaws: [],       // markdown: raw source text per top-level block
    threads: [],         // server-synced: [{id, anchor, status, messages}]
    pending: [],         // local unsent: {pid, type:'new'|'reply', thread_id?, anchor?, text, block?}
    lastRev: -1,
    seq: 0,
    pollTimer: null,
    draftAnchor: null,   // anchor being composed in the popover
    draftBlock: null,
    hovered: null,
    toastTimer: null,
    expanded: {}         // message keys the user manually expanded (survives re-render)
  };

  // ---- DOM refs (set once in start) ----
  var elContent, elFrame, elFilename, elStatus, elList, elCount, elSend, elSendNote, elToast, elLive;
  var elSidebar, elSidebarToggle;
  var pop, popTarget, popText, popAdd, popCancel;

  // ---- the "doc root": what document/container the content lives in ----
  // Markdown renders into #rd-content (parent document). HTML renders into the
  // iframe so the target's own <head> CSS applies in isolation — so every
  // function that touches the *content* (hover, selection, markers, css paths)
  // must operate on the iframe's document instead of the parent's. docEnv is the
  // single switch: it's recomputed on each render (null until the iframe loads,
  // which transparently falls back to the parent — harmless, since #rd-content is
  // empty/hidden in HTML mode). The chrome (sidebar, popover, toast) always uses
  // the parent document.
  var docEnv = null;   // { doc, root, frame } | null
  function isHtml()  { return !!(state.meta && state.meta.kind === "html"); }
  function rdDoc()   { return docEnv ? docEnv.doc   : document; }   // owns selection/ranges
  function rdRoot()  { return docEnv ? docEnv.root  : elContent; } // marker host container
  function rdFrame() { return docEnv ? docEnv.frame : null; }

  // Rects measured inside the iframe are relative to the iframe's own viewport;
  // the popover lives in the parent and is positioned in parent coords. Shift by
  // the iframe's offset within the parent (identity in markdown mode).
  function frameOffset() {
    var f = rdFrame();
    if (!f) return { x: 0, y: 0 };
    var r = f.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }
  function toParentRect(r) {
    var o = frameOffset();
    return {
      left: r.left + o.x, right: r.right + o.x,
      top: r.top + o.y, bottom: r.bottom + o.y
    };
  }

  // Marker / hover / flash styles for the HTML iframe. comment.css can't reach
  // inside the iframe document, so we inject an equivalent subset on each load.
  // NOTE: keep visually in sync with the matching rules in comment.css. The
  // marker gutter is *inside* the block's top-left (positive left) because an
  // arbitrary report has no guaranteed left padding to bleed a marker into.
  var FRAME_OVERLAY_CSS = [
    ":root{--rd-hover:#4a90d9;--rd-commented:#e8821a;--rd-draft:#8a8f98;--rd-answered:#2f8a3c;}",
    ".rd-hover{outline:2px solid var(--rd-hover) !important;outline-offset:2px;border-radius:3px;cursor:pointer;}",
    ".rd-commented{outline:2px solid var(--rd-commented) !important;outline-offset:2px;border-radius:3px;position:relative;}",
    ".rd-marker{position:absolute;top:-10px;left:4px;min-width:20px;height:20px;padding:0 5px;" +
      "background:var(--rd-commented);color:#fff;font-size:12px;font-weight:700;line-height:1;border:none;" +
      "-webkit-appearance:none;appearance:none;border-radius:10px;display:flex;align-items:center;" +
      "justify-content:center;cursor:pointer;z-index:2147483646;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Helvetica Neue',sans-serif;}",
    ".rd-marker:hover{transform:scale(1.15);box-shadow:0 1px 5px rgba(0,0,0,.3);}",
    ".rd-marker:focus-visible{outline:2px solid #fff;outline-offset:1px;}",
    ".rd-marker.draft{background:var(--rd-draft);}",
    ".rd-marker.answered{background:var(--rd-answered);}",
    ".rd-stale{outline-color:#b0b0b0 !important;}",
    ".rd-stale .rd-marker{background:#b0b0b0;}",
    "@keyframes rdflash{0%{box-shadow:0 0 0 0 rgba(232,130,26,.55);}100%{box-shadow:0 0 0 8px rgba(232,130,26,0);}}",
    ".rd-flash{animation:rdflash .85s ease-out;}"
  ].join("\n");

  function noop() {}

  // Tiny DOM builder: h("div", {class, text, html, dataset, on:{evt:fn}, ...attrs}, children)
  // Centralises the createElement/className/textContent boilerplate that was
  // repeated across every sidebar component.
  function h(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null) return;
        if (k === "class") { node.className = v; }
        else if (k === "text") { node.textContent = v; }
        else if (k === "html") { node.innerHTML = v; }
        else if (k === "dataset") { Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; }); }
        else if (k === "on") { Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); }); }
        else if (k in node) { try { node[k] = v; } catch (e) { node.setAttribute(k, v); } }
        else { node.setAttribute(k, v); }
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  // Isolated marked instance for comment bodies. We render user/Claude comments
  // as markdown (code fences, inline code, lists, headings) so long answers and
  // file paths read clearly — but we neutralise raw HTML so a stray <div> in a
  // reply can't break the card layout. This is a SEPARATE instance so the global
  // `marked` used for the document body (renderMarkdown) stays untouched.
  // `breaks:true` preserves the user's single newlines (what pre-wrap did before).
  var commentMarked = new marked.Marked({ gfm: true, breaks: true });
  commentMarked.use({ renderer: { html: function (t) {
    var s = typeof t === "string" ? t : (t && t.text) || "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  } } });
  function renderCommentMarkdown(text) {
    try { return commentMarked.parse(text || "", { async: false }); }
    catch (e) { return null; }   // fall back to plain textContent on the caller side
  }

  // ===================================================================
  // bootstrap
  // ===================================================================
  function start() {
    elContent = document.getElementById("rd-content");
    elFrame = document.getElementById("rd-frame");
    elFilename = document.getElementById("rd-filename");
    elStatus = document.getElementById("rd-status");
    elList = document.getElementById("rd-list");
    elCount = document.getElementById("rd-count");
    elSend = document.getElementById("rd-send");
    elSendNote = document.getElementById("rd-send-note");
    elToast = document.getElementById("rd-toast");
    elLive = document.getElementById("rd-live");
    elSidebar = document.getElementById("rd-sidebar");
    elSidebarToggle = document.getElementById("rd-sidebar-toggle");
    pop = document.getElementById("rd-popover");
    popTarget = document.getElementById("rd-popover-target");
    popText = document.getElementById("rd-popover-text");
    popAdd = document.getElementById("rd-popover-add");
    popCancel = document.getElementById("rd-popover-cancel");

    popAdd.addEventListener("click", onPopoverAdd);
    popCancel.addEventListener("click", closePopover);
    elSend.addEventListener("click", sendAll);
    if (elSidebarToggle) elSidebarToggle.addEventListener("click", toggleSidebar);

    elContent.addEventListener("mousemove", onHover);
    elContent.addEventListener("mouseleave", clearHover);
    elContent.addEventListener("mouseup", onMouseUp);

    initSidebarResize();

    popText.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.metaKey && !e.shiftKey) { e.preventDefault(); onPopoverAdd(); }
    });
    document.addEventListener("keydown", onGlobalKey);

    // Pause polling when the tab is hidden; resume (and check immediately) when
    // it comes back. No point hammering the server while nobody is looking.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { stopPolling(); }
      else { startPolling(); checkRev(); }
    });

    init();
  }

  function init() {
    fetchSource()
      .then(function (data) {
        applySource(data, false);
        return refreshThreads();
      })
      .then(function () { startPolling(); setStatus("準備完了"); })
      .catch(function (err) { setStatus("読み込み失敗: " + err); });
  }

  function onGlobalKey(e) {
    if (e.key === "Escape") { closePopover(); return; }
    if (e.key === "Enter" && e.metaKey && e.shiftKey) {
      e.preventDefault();
      sendAll();
      return;
    }
    if (e.key === "Enter" && e.metaKey && !e.shiftKey && !pop.hidden) {
      e.preventDefault();
      onPopoverAdd();
    }
  }

  function setStatus(text) { elStatus.textContent = text; }
  function announce(text) { if (elLive) elLive.textContent = text; }

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

  // ===================================================================
  // hover highlight
  // ===================================================================
  function onHover(e) {
    var target = blockOf(e.target);
    if (target === state.hovered) return;
    clearHover();
    if (target && target !== rdRoot()) {
      target.classList.add("rd-hover");
      state.hovered = target;
    }
  }
  function clearHover() {
    if (state.hovered) { state.hovered.classList.remove("rd-hover"); state.hovered = null; }
  }

  function blockOf(node) {
    var root = rdRoot();
    if (!node || node === root) return null;
    if (isHtml()) {
      var raw = node.nodeType === 3 ? node.parentElement : node;
      if (!raw || !root.contains(raw)) return null;
      // Climb to the nearest block-ish element. Pinning an absolutely-positioned
      // marker on an inline box (<span>/<a>/<em>) is unreliable — inline boxes
      // wrap and `position:relative` on them is weakly defined — so walk up to
      // an element whose computed display isn't inline/inline-*.
      var win = rdDoc().defaultView;
      var el = raw;
      while (el && el !== root) {
        var disp = win ? win.getComputedStyle(el).display : "block";
        if (disp.indexOf("inline") !== 0) break;
        el = el.parentElement;
      }
      if (!el || el === root) el = raw;   // everything up to <body> was inline: use the clicked element
      return el && el !== root && root.contains(el) ? el : null;
    }
    var blk = node.nodeType === 3 ? node.parentElement : node;
    while (blk && blk !== root && !(blk.dataset && blk.dataset.srcblock)) {
      blk = blk.parentElement;
    }
    return blk && blk.dataset && blk.dataset.srcblock !== undefined ? blk : null;
  }

  // ===================================================================
  // selecting / clicking → build anchor → open popover
  // ===================================================================
  function onMouseUp(e) {
    // Clicking a marker badge is "jump to comment", not "comment on this block".
    if (e.target.closest && e.target.closest(".rd-marker")) return;
    setTimeout(function () {
      var sel = rdDoc().getSelection();
      var text = sel && !sel.isCollapsed ? sel.toString() : "";
      if (text && text.trim() && withinContent(sel)) {
        openRangeComment(sel);
      } else {
        var blk = blockOf(e.target);
        if (blk && blk !== rdRoot()) openBlockComment(blk);
      }
    }, 0);
  }

  function withinContent(sel) {
    if (!sel.rangeCount) return false;
    return rdRoot().contains(sel.getRangeAt(0).commonAncestorContainer);
  }

  function openRangeComment(sel) {
    var range = sel.getRangeAt(0);
    var blk = blockOf(range.startContainer);
    var selectedText = sel.toString();
    var anchor;
    if (isHtml()) {
      var host = blk || rdRoot();
      anchor = {
        type: "range", kind: "html", selected_text: selectedText,
        css_path: cssPath(host), outer_html_excerpt: excerpt(host.outerHTML, 400),
        prefix: "", suffix: "", occurrence: 0
      };
      fillContext(anchor, host, range, selectedText);
    } else {
      var bi = blk ? parseInt(blk.dataset.srcblock, 10) : -1;
      anchor = {
        type: "range", kind: "markdown", selected_text: selectedText,
        block_index: bi, block_raw: bi >= 0 ? state.blockRaws[bi] : "",
        prefix: "", suffix: "", occurrence: 0
      };
      if (blk) fillContext(anchor, blk, range, selectedText);
    }
    state.draftAnchor = anchor; state.draftBlock = blk;
    showPopover(describeAnchor(anchor), toParentRect(rectOf(range)));
  }

  function openBlockComment(blk) {
    var anchor;
    if (isHtml()) {
      anchor = {
        type: "element", kind: "html", tag: blk.tagName.toLowerCase(),
        css_path: cssPath(blk), text: excerpt(blk.textContent.trim(), 200),
        outer_html_excerpt: excerpt(blk.outerHTML, 400)
      };
    } else {
      var bi = parseInt(blk.dataset.srcblock, 10);
      anchor = {
        type: "block", kind: "markdown", block_index: bi,
        block_raw: state.blockRaws[bi] || "", tag: blk.tagName.toLowerCase(),
        text: excerpt(blk.textContent.trim(), 200)
      };
      var hd = /^h([1-6])$/.exec(blk.tagName.toLowerCase());
      if (hd) { anchor.heading_level = parseInt(hd[1], 10); anchor.heading_text = blk.textContent.trim(); }
    }
    state.draftAnchor = anchor; state.draftBlock = blk;
    showPopover(describeAnchor(anchor), toParentRect(blk.getBoundingClientRect()));
  }

  function fillContext(anchor, blockEl, range, selectedText) {
    try {
      var pre = rdDoc().createRange();
      pre.setStart(blockEl, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      var startOffset = pre.toString().length;
      var blockText = blockEl.textContent || "";
      anchor.prefix = blockText.slice(Math.max(0, startOffset - 30), startOffset);
      var after = startOffset + selectedText.length;
      anchor.suffix = blockText.slice(after, after + 30);
      anchor.occurrence = countOccurrences(blockText.slice(0, startOffset), selectedText);
    } catch (err) { /* best effort */ }
  }

  function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    var n = 0, i = 0;
    while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
  }

  function describeAnchor(a) {
    if (a.type === "block" || a.type === "element") {
      return "&lt;" + (a.tag || "block") + "&gt; " + escapeHtml(a.text || "");
    }
    return "“" + escapeHtml(a.selected_text || "") + "”";
  }

  // ===================================================================
  // popover (drafting a NEW comment)
  // ===================================================================
  function showPopover(targetHtml, rect) {
    popTarget.innerHTML = targetHtml;
    popText.value = "";
    pop.hidden = false;                       // becomes measurable (CSS keeps it in flow but transparent)
    var pw = pop.offsetWidth || 300;
    var ph = pop.offsetHeight || 160;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var r = rect || { bottom: 100, top: 100, left: 100 };

    // horizontal: clamp within viewport
    var left = window.scrollX + Math.min(r.left, vw - pw - 16);
    left = Math.max(window.scrollX + 8, left);

    // vertical: prefer below; flip above when there isn't room; clamp either way
    var top;
    var spaceBelow = vh - r.bottom;
    if (spaceBelow < ph + 12 && r.top > ph + 12) {
      top = window.scrollY + r.top - ph - 8;            // flip above
    } else {
      top = window.scrollY + r.bottom + 6;
      var maxTop = window.scrollY + vh - ph - 8;
      if (top > maxTop) top = Math.max(window.scrollY + 8, maxTop);
    }
    pop.style.top = top + "px";
    pop.style.left = left + "px";
    popText.focus();
  }
  function closePopover() {
    pop.hidden = true;
    state.draftAnchor = null; state.draftBlock = null;
    var sel = rdDoc().getSelection();
    if (sel) sel.removeAllRanges();
  }
  function onPopoverAdd() {
    var text = popText.value.trim();
    if (!text || !state.draftAnchor) { closePopover(); return; }
    state.seq += 1;
    state.pending.push({ pid: "p" + state.seq, type: "new", anchor: state.draftAnchor, text: text, block: state.draftBlock });
    closePopover();
    refreshView();
  }

  // ===================================================================
  // re-feedback (drafting a reply on an existing thread)
  // ===================================================================
  function addReply(threadId, textarea) {
    var text = (textarea.value || "").trim();
    if (!text) return;
    state.seq += 1;
    state.pending.push({ pid: "p" + state.seq, type: "reply", thread_id: threadId, text: text });
    textarea.value = "";
    refreshView();
  }

  // Grow the reply field with its content (manual resize is off in the chat-style
  // box), capped so a very long draft scrolls instead of overtaking the sidebar.
  function autoGrowReply(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
  }

  // ===================================================================
  // ordering + numbering (document order, computed once per view refresh)
  // ===================================================================
  function newDrafts() { return state.pending.filter(function (p) { return p.type === "new"; }); }
  function repliesFor(tid) { return state.pending.filter(function (p) { return p.type === "reply" && p.thread_id === tid; }); }
  function isResolved(t) { return t.status === "resolved"; }

  // Vertical position of a block within the document (for ordering). Unresolved
  // anchors sort to the end.
  function blockTop(blk) {
    if (blk && rdRoot().contains(blk)) {
      if (isHtml()) {
        // The iframe content scrolls internally; add its own scroll origin so
        // the metric is the block's absolute position in the document order,
        // independent of where the frame is currently scrolled.
        var win = rdFrame() && rdFrame().contentWindow;
        var sy = win ? (win.scrollY || 0) : 0;
        return blk.getBoundingClientRect().top + sy;
      }
      var scroller = document.scrollingElement || document.documentElement;
      return blk.getBoundingClientRect().top + scroller.scrollTop;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function inDoc(blk) { return !!(blk && rdRoot().contains(blk)); }

  // The badge number is the comment's stable id, not its position. The server
  // hands every thread a unique, monotonically-increasing id ("t3") and never
  // reuses or renumbers it, so deriving the number from the id means resolving
  // comment 2 leaves 1 and 3 exactly as they were — no silent renumbering.
  function threadNum(t) { return parseInt(String(t.id).replace(/^\D+/, ""), 10); }

  // Why an anchor couldn't be placed, for the sidebar note (null = placed fine).
  function anchorReason(a) { return a && a.gone ? "deleted" : "missing"; }

  // Build the active list (new drafts + non-resolved threads). Two things are
  // computed here and reused everywhere: the placement (which block each anchor
  // resolves to, or none) and the badge number. Layout is document order so the
  // sidebar mirrors the body top-to-bottom; the number is independent of order.
  function computeOrder() {
    var entries = [];

    // Drafts have no server id yet, so give them a provisional number that
    // continues past the highest existing thread number (resolved included) to
    // avoid colliding badges. On submit the server assigns the real id and the
    // next refresh replaces this — so it needn't match exactly, just not clash.
    var maxThread = 0;
    state.threads.forEach(function (t) {
      var n = threadNum(t);
      if (!isNaN(n) && n > maxThread) maxThread = n;
    });

    var draftSeq = 0;
    newDrafts().forEach(function (d) {
      var blk = anchorToBlock(d.anchor) || d.block;
      if (!inDoc(blk)) blk = null;
      draftSeq += 1;
      entries.push({
        key: "draft:" + d.pid, kind: "draft", ref: d, top: blockTop(blk),
        block: blk, located: !!blk, reason: blk ? null : anchorReason(d.anchor),
        num: maxThread + draftSeq
      });
    });
    state.threads.forEach(function (t) {
      if (isResolved(t)) return;
      var blk = anchorToBlock(t.anchor);
      if (!inDoc(blk)) blk = null;
      entries.push({
        key: "thread:" + t.id, kind: "thread", ref: t, top: blockTop(blk),
        block: blk, located: !!blk, reason: blk ? null : anchorReason(t.anchor),
        num: threadNum(t)
      });
    });

    entries.sort(function (a, b) { return a.top - b.top; });   // layout order only
    var nums = {};
    entries.forEach(function (e) { nums[e.key] = e.num; });
    return { nums: nums, order: entries };
  }

  // Single entry point for "the model changed, redraw the view": compute order
  // once, then place markers and render the sidebar from the same data.
  function refreshView() {
    var o = computeOrder();
    reattachAll(o);
    renderSidebar(o);
  }

  // ===================================================================
  // sidebar
  // ===================================================================
  function renderSidebar(o) {
    o = o || computeOrder();
    var nums = o.nums;
    var resolved = state.threads.filter(isResolved);
    var activeCount = o.order.length;
    elCount.textContent = String(activeCount);

    elList.innerHTML = "";

    if (activeCount === 0 && resolved.length === 0) {
      elList.appendChild(h("p", {
        "class": "rd-empty",
        text: "コメントはまだありません。本文を選択／クリックして Cmd+Enter で追加。"
      }));
    }

    // active items (drafts + open/answered threads) in document order
    o.order.forEach(function (e) {
      if (e.kind === "draft") elList.appendChild(draftCard(e.ref, nums[e.key], e));
      else elList.appendChild(threadCard(e.ref, nums[e.key], e));
    });

    // resolved (collapsed) — keep their stable number so reopening is seamless
    if (resolved.length) {
      var details = h("details", { "class": "rd-resolved-group" },
        [h("summary", { text: "解決済み (" + resolved.length + ")" })]);
      resolved.forEach(function (t) { details.appendChild(threadCard(t, threadNum(t), null)); });
      elList.appendChild(details);
    }

    var nPending = state.pending.length;
    elSend.disabled = nPending === 0;
    elSend.textContent = nPending > 0 ? "Claude に送信 (" + nPending + ")" : "Claude に送信";
    elSendNote.textContent = nPending > 0
      ? "Cmd+Shift+Enter で送信"
      : "本文を選択/クリック → Cmd+Enter で追加";

    // Heights are only knowable once the cards are laid out, so clamp long
    // bubbles in a deferred pass.
    queuePostRender();
  }

  // ===================================================================
  // bubble post-render: long-text clamp (deferred so heights are measurable)
  // ===================================================================
  var CLAMP_MAX = 220;   // px — ~12-14 lines before we collapse
  var postRenderQueued = false;

  function queuePostRender() {
    if (postRenderQueued) return;
    postRenderQueued = true;
    requestAnimationFrame(function () { postRenderQueued = false; applyBubblePostRender(); });
  }

  function applyBubblePostRender() {
    Array.prototype.forEach.call(elList.querySelectorAll(".rd-bubble-text"), function (textEl) {
      var bubbleEl = textEl.parentElement;
      var key = textEl.dataset.mkey || "";
      // clamp long bodies + attach a toggle. scrollHeight here is the full natural
      // height (nothing is clamped yet), so it tells us whether this bubble is long
      // enough to need collapsing — independent of current state.
      if (!bubbleEl.querySelector(".rd-bubble-more") && textEl.scrollHeight > CLAMP_MAX) {
        setupClampToggle(textEl, bubbleEl, key, !!(key && state.expanded[key]));
      }
    });
  }

  // Collapse a tall bubble to CLAMP_MAX with a fade + toggle. Expand/collapse is an
  // instant class flip (animating to/from auto height is fragile, esp. under
  // reduced-motion); the motion polish lives in the reveal + copy feedback. The
  // toggle is (re)built on every render and seeded from state.expanded, so an
  // expanded bubble keeps its "閉じる" affordance across polling re-renders.
  function setupClampToggle(textEl, bubbleEl, key, startExpanded) {
    var lh = parseFloat(getComputedStyle(textEl).lineHeight) || 20;
    var remain = Math.max(1, Math.round((textEl.scrollHeight - CLAMP_MAX) / lh));
    var collapsedLabel = "続きを表示（残り " + remain + " 行）";
    var more = h("button", { "class": "rd-bubble-more", type: "button" });
    function apply(expanded) {
      if (expanded) {
        textEl.classList.remove("clamped");
        if (key) state.expanded[key] = true;
        more.textContent = "閉じる ▴";
      } else {
        textEl.classList.add("clamped");
        if (key) delete state.expanded[key];
        more.textContent = collapsedLabel;
      }
    }
    more.addEventListener("click", function (e) {
      e.stopPropagation();
      var nowCollapsed = textEl.classList.contains("clamped");
      apply(nowCollapsed);                                       // collapsed→expand / expanded→collapse
      if (!nowCollapsed) bubbleEl.scrollIntoView({ block: "nearest" });   // keep top in view when re-collapsing
    });
    apply(startExpanded);
    bubbleEl.appendChild(more);
  }

  function header(num, kindLabel, badgeCls) {
    var kids = [];
    if (num != null && !isNaN(num)) {
      kids.push(h("span", { "class": "rd-item-num " + (badgeCls || ""), text: String(num) }));
      kids.push(" ");
    }
    kids.push(h("span", { "class": "rd-item-kind", text: kindLabel }));
    return h("div", { "class": "rd-item-head" }, [h("span", null, kids)]);
  }

  // When a comment's anchor can't be placed on the document, the body shows no
  // marker (by design — we don't guess a location). Surface a small note in the
  // card so the comment doesn't look orphaned and the user understands why.
  function anchorNote(entry) {
    if (!entry || entry.located) return null;
    var msg = entry.reason === "deleted"
      ? "この箇所は削除されました"
      : "該当箇所が見つかりません（編集で移動した可能性）";
    return h("div", { "class": "rd-item-note", text: msg });
  }

  // Clicking a card (but not a control inside it) jumps to the anchored block.
  function cardJump(key) {
    return function (e) {
      if (e.target.closest("button, textarea, a")) return;
      focusBlock(key);
    };
  }

  function draftCard(d, num, entry) {
    var head = header(num, "下書き · " + anchorKindLabel(d.anchor), "draft");
    head.appendChild(h("button", {
      "class": "rd-item-del", type: "button", text: "削除", "aria-label": "下書きを削除",
      on: { click: function (e) { e.stopPropagation(); removePending(d.pid); } }
    }));
    var item = h("div", { "class": "rd-item draft", dataset: { key: "draft:" + d.pid } }, [
      head,
      h("div", { "class": "rd-item-target", text: anchorSnippet(d.anchor) }),
      anchorNote(entry),
      bubble("user", d.text, true, "draft:" + d.pid)
    ]);
    item.addEventListener("click", cardJump("draft:" + d.pid));
    return item;
  }

  function threadCard(t, num, entry) {
    var label = t.status === "answered" ? "返信あり" : (isResolved(t) ? "解決済み" : "対応中");
    var head = header(num, label + " · " + anchorKindLabel(t.anchor),
      t.status === "answered" ? "answered" : "");
    if (!isResolved(t)) {
      head.appendChild(h("button", {
        "class": "rd-item-resolve", type: "button", text: "解決", "aria-label": "このコメントを解決",
        on: { click: function (e) { e.stopPropagation(); resolveThread(t.id); } }
      }));
    } else {
      head.appendChild(h("button", {
        "class": "rd-item-resolve", type: "button", text: "再開", "aria-label": "このコメントを再開",
        on: { click: function (e) { e.stopPropagation(); reopenThread(t.id); } }
      }));
    }

    var item = h("div", { "class": "rd-item thread status-" + t.status, dataset: { key: "thread:" + t.id } }, [
      head,
      h("div", { "class": "rd-item-target", text: anchorSnippet(t.anchor) }),
      anchorNote(entry)
    ]);

    (t.messages || []).forEach(function (m, i) { item.appendChild(bubble(m.role, m.text, false, t.id + "#" + i)); });

    // pending re-feedback drafts for this thread
    repliesFor(t.id).forEach(function (p) {
      var b = bubble("user", p.text, true, "reply:" + p.pid);
      b.appendChild(h("button", {
        "class": "rd-bubble-del", type: "button", text: "×", title: "下書きを削除", "aria-label": "下書きを削除",
        on: { click: function (e) { e.stopPropagation(); removePending(p.pid); } }
      }));
      item.appendChild(b);
    });

    // reply box (not for resolved). Empty: a single-line field with the small
    // send button parked at its right-centre (Figma-style). On the first
    // keystroke the field becomes input-only and the button drops just below it,
    // right-aligned — toggled via the `has-text` class from the input handler.
    if (!isResolved(t)) {
      var wrap = h("div", { "class": "rd-reply" });
      var ta = h("textarea", {
        "class": "rd-reply-input", rows: 1,
        placeholder: t.status === "answered" ? "再フィードバック…" : "補足…",
        on: {
          keydown: function (e) { if (e.key === "Enter" && e.metaKey && !e.shiftKey) { e.preventDefault(); addReply(t.id, ta); } },
          input: function () {
            var has = ta.value.trim() !== "";
            wrap.classList.toggle("has-text", has);
            add.disabled = !has;
            autoGrowReply(ta);
          }
        }
      });
      var add = h("button", {
        "class": "rd-reply-send", type: "button", text: "↑",
        title: "返信を追加 (⌘Enter)", "aria-label": "返信を追加", disabled: true,
        on: { click: function () { addReply(t.id, ta); } }
      });
      wrap.appendChild(ta);
      wrap.appendChild(add);
      item.appendChild(wrap);
    }

    item.addEventListener("click", cardJump("thread:" + t.id));
    return item;
  }

  function bubble(role, text, isDraft, key) {
    var md = renderCommentMarkdown(text);
    var body = md != null
      ? h("div", { "class": "rd-bubble-text rd-md", html: md })
      : h("div", { "class": "rd-bubble-text", text: text });   // parse failed -> safe plain text
    if (key) body.dataset.mkey = key;
    return h("div", { "class": "rd-bubble " + (role === "claude" ? "claude" : "user") + (isDraft ? " draft" : "") }, [
      h("span", { "class": "rd-bubble-who", text: role === "claude" ? "Claude" : (isDraft ? "あなた（送信待ち）" : "あなた") }),
      body
    ]);
  }

  function anchorKindLabel(a) {
    if (!a) return "";
    if (a.type === "range") return "テキスト選択";
    if (a.type === "block") return "ブロック";
    return "要素";
  }
  function anchorSnippet(a) {
    if (!a) return "";
    if (a.type === "range") return "“" + (a.selected_text || "") + "”";
    return "<" + (a.tag || "block") + "> " + (a.text || "");
  }

  function removePending(pid) {
    state.pending = state.pending.filter(function (p) { return p.pid !== pid; });
    refreshView();
  }

  // ===================================================================
  // markers on the document + jump-to linking (comment <-> body)
  // ===================================================================
  function markBlock(block, key, num, cls) {
    if (!block || block === rdRoot()) return;
    block.classList.add("rd-commented");
    if (cls) block.classList.add(cls);
    // Relative positioning is handled by `.rd-commented { position: relative }`
    // — no getComputedStyle read here, so marker placement doesn't force a
    // synchronous layout on every refresh. Build the marker with the content's
    // own document (rdDoc) so it can live inside the iframe; the click handler
    // is still a parent closure (same-origin) calling the parent sidebar.
    var d = rdDoc();
    var marker = d.createElement("button");
    marker.className = "rd-marker" + (cls ? " " + cls : "");
    marker.type = "button";
    marker.title = "コメント " + (num != null ? num : "");
    marker.setAttribute("aria-label", "コメント " + (num != null ? num : "") + " を表示");
    marker.dataset.key = key;
    marker.textContent = num != null ? String(num) : "•";
    marker.addEventListener("click", function (e) { e.stopPropagation(); focusThreadCard(key); });
    block.appendChild(marker);
  }
  function clearMarkers() {
    var root = rdRoot();
    Array.prototype.forEach.call(root.querySelectorAll(".rd-marker"), function (m) { m.remove(); });
    Array.prototype.forEach.call(root.querySelectorAll(".rd-commented"), function (b) {
      b.classList.remove("rd-commented", "draft", "answered", "stale");
    });
  }

  // Resolve an anchor to its block element by matching the *content* we
  // captured when the comment was made — block_raw for markdown, text /
  // selected_text for HTML — against the freshly rendered document, NOT by a
  // positional index. An index drifts the moment Claude inserts or deletes a
  // block above, which is what used to pin a comment onto the wrong place. If
  // the content can't be found (the region was deleted, or rewritten without
  // Claude telling us the new text via `reply --anchor-block-raw`), we return
  // null and show NO marker — pointing nowhere is better than pointing wrong.
  function anchorToBlock(a) {
    if (!a || a.gone) return null;
    if (a.kind === "markdown") return markdownBlock(a);
    if (a.kind === "html") return htmlElement(a);
    return null;
  }

  function markdownBlock(a) {
    var wanted = normRaw(a.block_raw);
    if (!wanted) return null;
    var matches = [];
    for (var i = 0; i < state.blockRaws.length; i++) {
      if (normRaw(state.blockRaws[i]) === wanted) matches.push(i);
    }
    if (matches.length === 0) return null;   // content gone -> no marker
    var idx = matches[0];
    if (matches.length > 1) {
      // Identical blocks (e.g. several "## 概要") are inherently ambiguous, so
      // here — and only here — fall back to the stored index as a hint and pick
      // the nearest surviving match.
      var hint = typeof a.block_index === "number" ? a.block_index : idx;
      var best = Infinity;
      matches.forEach(function (m) {
        var d = Math.abs(m - hint);
        if (d < best) { best = d; idx = m; }
      });
    }
    return rdRoot().querySelector('[data-srcblock="' + idx + '"]');
  }

  // HTML structure is arbitrary and re-renders can reshape it freely, so there's
  // no clean content key like block_raw. We try the recorded css_path first but
  // verify the element still holds the anchored text (nth-of-type paths drift),
  // then fall back to a text search, preferring the most specific (shortest)
  // match so we don't latch onto an ancestor like <body>. When nothing matches
  // confidently we return null rather than guess.
  function htmlElement(a) {
    var root = rdRoot();
    var wantText = stripEllipsis(a.text || a.selected_text || "");
    if (a.css_path) {
      try {
        var el = root.querySelector(stripRootPath(a.css_path));
        if (el && htmlTextMatches(el, a, wantText)) return el;
      } catch (e) { /* selector invalid after edits: fall through to text search */ }
    }
    if (!wantText) return null;
    var tag = (a.tag || "").toLowerCase();
    var candidates = root.querySelectorAll(tag || "*");
    var best = null, bestLen = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!htmlTextMatches(c, a, wantText)) continue;
      var len = (c.textContent || "").length;
      if (len < bestLen) { bestLen = len; best = c; }
    }
    return best;
  }

  function htmlTextMatches(el, a, wantText) {
    var txt = (el.textContent || "").trim();
    if (a.selected_text) return txt.indexOf(a.selected_text) !== -1;
    if (wantText) return txt.indexOf(wantText) === 0;   // text was an excerpt (may have ended in …)
    return false;
  }

  // Re-place all markers (new drafts + non-resolved threads) after a render,
  // using the precomputed document-order numbering.
  function reattachAll(o) {
    o = o || computeOrder();
    clearMarkers();
    o.order.forEach(function (e) {
      if (!e.located || !e.block) return;   // unplaceable (deleted/moved-away) -> no marker
      var cls = e.kind === "draft" ? "draft" : (e.ref.status === "answered" ? "answered" : null);
      markBlock(e.block, e.key, o.nums[e.key], cls);
    });
  }

  // sidebar card -> body block
  function focusBlock(key) {
    var marker = rdRoot().querySelector('.rd-marker[data-key="' + key + '"]');
    if (!marker) return;
    var blk = marker.parentElement;
    if (blk) { blk.scrollIntoView({ behavior: "smooth", block: "center" }); flash(blk); }
  }
  // body marker -> sidebar card
  function focusThreadCard(key) {
    var card = elList.querySelector('.rd-item[data-key="' + key + '"]');
    if (!card) {
      var grp = elList.querySelector(".rd-resolved-group");
      if (grp) { grp.open = true; card = elList.querySelector('.rd-item[data-key="' + key + '"]'); }
    }
    if (!card) return;
    openSidebarIfCollapsed();
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    flash(card);
  }
  function flash(node) {
    if (!node) return;
    node.classList.remove("rd-flash");
    void node.offsetWidth;            // restart the animation
    node.classList.add("rd-flash");
    setTimeout(function () { node.classList.remove("rd-flash"); }, 850);
  }

  // ===================================================================
  // sidebar drawer (narrow screens)
  // ===================================================================
  function toggleSidebar() {
    var open = elSidebar.classList.toggle("open");
    if (elSidebarToggle) elSidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function openSidebarIfCollapsed() {
    if (window.matchMedia("(max-width: 880px)").matches && !elSidebar.classList.contains("open")) {
      toggleSidebar();
    }
  }

  // ===================================================================
  // send (submit batch)
  // ===================================================================
  function sendAll() {
    if (state.pending.length === 0) return;
    elSend.disabled = true;
    elSendNote.textContent = "送信中…";
    var items = state.pending.map(function (p) {
      return p.type === "reply"
        ? { thread_id: p.thread_id, text: p.text }
        : { anchor: p.anchor, text: p.text };
    });
    fetch("/threads/submit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) {
          state.pending = [];
          state.threads = res.threads || state.threads;
          state.lastRev = res.rev;
          refreshView();
          setStatus("送信しました（Claude の対応待ち）");
          toast("Claude に送信しました（バッチ " + res.batch_id + "）");
        } else {
          elSendNote.textContent = "送信に失敗しました";
          elSend.disabled = false;
        }
      })
      .catch(function (err) {
        elSendNote.textContent = "送信エラー: " + err;
        elSend.disabled = false;
      });
  }

  function resolveThread(tid) {
    postThreadAction("/threads/resolve", { thread_id: tid });
  }
  function reopenThread(tid) {
    postThreadAction("/threads/resolve", { thread_id: tid, reopen: true });
  }
  function postThreadAction(url, body) {
    fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) { state.lastRev = res.rev; refreshThreads(); }
      })
      .catch(noop);
  }

  // ===================================================================
  // polling / live reload
  // ===================================================================
  function refreshThreads() {
    return fetch("/threads", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.threads = d.threads || [];
        state.lastRev = d.rev;
        refreshView();
      })
      .catch(noop);
  }

  function startPolling() {
    stopPolling();
    if (document.hidden) return;
    state.pollTimer = setInterval(checkRev, 3500);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  // Cheap poll: ask only for the revision number. Pull the heavy payloads
  // (threads + source) only when something actually changed.
  function checkRev() {
    fetch("/rev", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (typeof d.rev === "number" && d.rev > state.lastRev) onRevBumped(d.rev);
      })
      .catch(noop);
  }

  function onRevBumped(rev) {
    state.lastRev = rev;
    Promise.all([
      fetch("/threads", { cache: "no-store" }).then(function (r) { return r.json(); }),
      fetch("/source", { cache: "no-store" }).then(function (r) { return r.json(); })
    ]).then(function (res) {
      var td = res[0], sd = res[1];
      state.threads = td.threads || [];
      // Did the file itself change, or only the thread data (e.g. a reply)?
      var sourceChanged = !state.meta || sd.mtime !== state.meta.mtime || sd.content !== state.meta.content;
      if (sourceChanged) {
        setStatus("更新を反映しました");
        toast("Claude がドキュメントを更新しました");
        announce("Claude がドキュメントを更新しました");
        applySource(sd, true);     // re-render body, keep scroll position
      } else {
        // Reply / status change only: no body re-parse, just refresh markers + sidebar.
        setStatus("返信が届きました");
        toast("Claude が返信しました");
        announce("Claude が返信しました");
        refreshView();
      }
    }).catch(noop);
  }

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

  return { start: start };
})();
