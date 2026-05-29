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
 * - Comment numbering follows document order (vertical position), so the marker
 *   numbers in the body match the sidebar order.
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
    toastTimer: null
  };

  // ---- DOM refs (set once in start) ----
  var elContent, elFilename, elStatus, elList, elCount, elSend, elSendNote, elToast, elLive;
  var elSidebar, elSidebarToggle;
  var pop, popTarget, popText, popAdd, popCancel;

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

  // ===================================================================
  // bootstrap
  // ===================================================================
  function start() {
    elContent = document.getElementById("rd-content");
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
  function applySource(data, preserveScroll) {
    var scroller = document.scrollingElement || document.documentElement;
    var y = preserveScroll ? scroller.scrollTop : 0;
    state.meta = data;
    elFilename.textContent = data.name;
    render();
    refreshView();
    if (preserveScroll) scroller.scrollTop = y;
  }

  // ===================================================================
  // rendering the document
  // ===================================================================
  function render() {
    elContent.innerHTML = "";
    state.blockRaws = [];
    if (state.meta.kind === "html") {
      elContent.innerHTML = extractHtmlBody(state.meta.content);
    } else {
      renderMarkdown(state.meta.content);
    }
  }

  function extractHtmlBody(html) {
    var m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return m ? m[1] : html;
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
    if (target && target !== elContent) {
      target.classList.add("rd-hover");
      state.hovered = target;
    }
  }
  function clearHover() {
    if (state.hovered) { state.hovered.classList.remove("rd-hover"); state.hovered = null; }
  }

  function blockOf(node) {
    if (!node || node === elContent) return null;
    if (state.meta && state.meta.kind === "html") {
      var el = node.nodeType === 3 ? node.parentElement : node;
      if (!elContent.contains(el)) return null;
      return el === elContent ? null : el;
    }
    var blk = node.nodeType === 3 ? node.parentElement : node;
    while (blk && blk !== elContent && !(blk.dataset && blk.dataset.srcblock)) {
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
      var sel = window.getSelection();
      var text = sel && !sel.isCollapsed ? sel.toString() : "";
      if (text && text.trim() && withinContent(sel)) {
        openRangeComment(sel);
      } else {
        var blk = blockOf(e.target);
        if (blk && blk !== elContent) openBlockComment(blk);
      }
    }, 0);
  }

  function withinContent(sel) {
    if (!sel.rangeCount) return false;
    return elContent.contains(sel.getRangeAt(0).commonAncestorContainer);
  }

  function openRangeComment(sel) {
    var range = sel.getRangeAt(0);
    var blk = blockOf(range.startContainer);
    var selectedText = sel.toString();
    var anchor;
    if (state.meta.kind === "html") {
      var host = blk || elContent;
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
    showPopover(describeAnchor(anchor), rectOf(range));
  }

  function openBlockComment(blk) {
    var anchor;
    if (state.meta.kind === "html") {
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
    showPopover(describeAnchor(anchor), blk.getBoundingClientRect());
  }

  function fillContext(anchor, blockEl, range, selectedText) {
    try {
      var pre = document.createRange();
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
    var sel = window.getSelection();
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

  // ===================================================================
  // ordering + numbering (document order, computed once per view refresh)
  // ===================================================================
  function newDrafts() { return state.pending.filter(function (p) { return p.type === "new"; }); }
  function repliesFor(tid) { return state.pending.filter(function (p) { return p.type === "reply" && p.thread_id === tid; }); }
  function isResolved(t) { return t.status === "resolved"; }

  // Vertical position of a block within the document (for ordering). Unresolved
  // anchors sort to the end.
  function blockTop(blk) {
    if (blk && elContent.contains(blk)) {
      var scroller = document.scrollingElement || document.documentElement;
      return blk.getBoundingClientRect().top + scroller.scrollTop;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  // Build the ordered list of active items (new drafts + non-resolved threads),
  // sorted by their position in the document, and assign 1..N accordingly so the
  // body markers and the sidebar share one consistent numbering.
  function computeOrder() {
    var entries = [];
    newDrafts().forEach(function (d) {
      var blk = anchorToBlock(d.anchor) || d.block;
      entries.push({ key: "draft:" + d.pid, kind: "draft", ref: d, top: blockTop(blk) });
    });
    state.threads.forEach(function (t) {
      if (isResolved(t)) return;
      var blk = anchorToBlock(t.anchor);
      entries.push({ key: "thread:" + t.id, kind: "thread", ref: t, top: blockTop(blk) });
    });
    entries.sort(function (a, b) { return a.top - b.top; });
    var nums = {};
    entries.forEach(function (e, i) { nums[e.key] = i + 1; });
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
      if (e.kind === "draft") elList.appendChild(draftCard(e.ref, nums[e.key]));
      else elList.appendChild(threadCard(e.ref, nums[e.key]));
    });

    // resolved (collapsed)
    if (resolved.length) {
      var details = h("details", { "class": "rd-resolved-group" },
        [h("summary", { text: "解決済み (" + resolved.length + ")" })]);
      resolved.forEach(function (t) { details.appendChild(threadCard(t, null)); });
      elList.appendChild(details);
    }

    var nPending = state.pending.length;
    elSend.disabled = nPending === 0;
    elSend.textContent = nPending > 0 ? "Claude に送信 (" + nPending + ")" : "Claude に送信";
    elSendNote.textContent = nPending > 0
      ? "Cmd+Shift+Enter で送信"
      : "本文を選択/クリック → Cmd+Enter で追加";
  }

  function header(num, kindLabel, badgeCls) {
    var kids = [];
    if (num != null) {
      kids.push(h("span", { "class": "rd-item-num " + (badgeCls || ""), text: String(num) }));
      kids.push(" ");
    }
    kids.push(h("span", { "class": "rd-item-kind", text: kindLabel }));
    return h("div", { "class": "rd-item-head" }, [h("span", null, kids)]);
  }

  // Clicking a card (but not a control inside it) jumps to the anchored block.
  function cardJump(key) {
    return function (e) {
      if (e.target.closest("button, textarea, a")) return;
      focusBlock(key);
    };
  }

  function draftCard(d, num) {
    var head = header(num, "下書き · " + anchorKindLabel(d.anchor), "draft");
    head.appendChild(h("button", {
      "class": "rd-item-del", type: "button", text: "削除", "aria-label": "下書きを削除",
      on: { click: function (e) { e.stopPropagation(); removePending(d.pid); } }
    }));
    var item = h("div", { "class": "rd-item draft", dataset: { key: "draft:" + d.pid } }, [
      head,
      h("div", { "class": "rd-item-target", text: anchorSnippet(d.anchor) }),
      bubble("user", d.text, true)
    ]);
    item.addEventListener("click", cardJump("draft:" + d.pid));
    return item;
  }

  function threadCard(t, num) {
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
      h("div", { "class": "rd-item-target", text: anchorSnippet(t.anchor) })
    ]);

    (t.messages || []).forEach(function (m) { item.appendChild(bubble(m.role, m.text, false)); });

    // pending re-feedback drafts for this thread
    repliesFor(t.id).forEach(function (p) {
      var b = bubble("user", p.text, true);
      b.appendChild(h("button", {
        "class": "rd-bubble-del", type: "button", text: "×", title: "下書きを削除", "aria-label": "下書きを削除",
        on: { click: function (e) { e.stopPropagation(); removePending(p.pid); } }
      }));
      item.appendChild(b);
    });

    // reply box (not for resolved)
    if (!isResolved(t)) {
      var ta = h("textarea", {
        rows: 2,
        placeholder: t.status === "answered" ? "意図と違えば再フィードバック… (Cmd+Enter)" : "補足… (Cmd+Enter)",
        on: { keydown: function (e) { if (e.key === "Enter" && e.metaKey && !e.shiftKey) { e.preventDefault(); addReply(t.id, ta); } } }
      });
      var add = h("button", {
        "class": "rd-btn rd-btn-ghost rd-reply-add", type: "button", text: "追加",
        on: { click: function () { addReply(t.id, ta); } }
      });
      item.appendChild(h("div", { "class": "rd-reply" }, [ta, add]));
    }

    item.addEventListener("click", cardJump("thread:" + t.id));
    return item;
  }

  function bubble(role, text, isDraft) {
    return h("div", { "class": "rd-bubble " + (role === "claude" ? "claude" : "user") + (isDraft ? " draft" : "") }, [
      h("span", { "class": "rd-bubble-who", text: role === "claude" ? "Claude" : (isDraft ? "あなた（送信待ち）" : "あなた") }),
      h("div", { "class": "rd-bubble-text", text: text })
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
    if (!block || block === elContent) return;
    block.classList.add("rd-commented");
    if (cls) block.classList.add(cls);
    // Relative positioning is handled by `.rd-commented { position: relative }`
    // in CSS — no getComputedStyle read here, so marker placement doesn't force
    // a synchronous layout on every refresh.
    var marker = h("button", {
      "class": "rd-marker" + (cls ? " " + cls : ""),
      type: "button",
      title: "コメント " + (num != null ? num : ""),
      "aria-label": "コメント " + (num != null ? num : "") + " を表示",
      dataset: { key: key },
      text: num != null ? String(num) : "•",
      on: { click: function (e) { e.stopPropagation(); focusThreadCard(key); } }
    });
    block.appendChild(marker);
  }
  function clearMarkers() {
    Array.prototype.forEach.call(elContent.querySelectorAll(".rd-marker"), function (m) { m.remove(); });
    Array.prototype.forEach.call(elContent.querySelectorAll(".rd-commented"), function (b) {
      b.classList.remove("rd-commented", "draft", "answered", "stale");
    });
  }

  function anchorToBlock(a) {
    if (!a) return null;
    if (a.kind === "markdown" && typeof a.block_index === "number" && a.block_index >= 0) {
      return elContent.querySelector('[data-srcblock="' + a.block_index + '"]');
    }
    if (a.kind === "html" && a.css_path) {
      try { return elContent.querySelector(stripRootPath(a.css_path)); } catch (e) { return null; }
    }
    return null;
  }

  // Re-place all markers (new drafts + non-resolved threads) after a render,
  // using the precomputed document-order numbering.
  function reattachAll(o) {
    o = o || computeOrder();
    clearMarkers();
    o.order.forEach(function (e) {
      var blk = e.kind === "draft" ? (anchorToBlock(e.ref.anchor) || e.ref.block) : anchorToBlock(e.ref.anchor);
      if (!blk || !elContent.contains(blk)) return;
      var cls = e.kind === "draft" ? "draft" : (e.ref.status === "answered" ? "answered" : null);
      markBlock(blk, e.key, o.nums[e.key], cls);
    });
  }

  // sidebar card -> body block
  function focusBlock(key) {
    var marker = elContent.querySelector('.rd-marker[data-key="' + key + '"]');
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
  function cssPath(el) {
    if (!el || el === elContent) return "#rd-content";
    var parts = [];
    var node = el;
    while (node && node !== elContent && node.nodeType === 1) {
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
    return "#rd-content > " + parts.join(" > ");
  }
  function stripRootPath(path) { return path.replace(/^#rd-content\s*>\s*/, ""); }
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

  return { start: start };
})();
