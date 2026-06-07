"use strict";

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
