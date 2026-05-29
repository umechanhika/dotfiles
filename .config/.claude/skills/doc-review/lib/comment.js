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
 */
var ReviewDoc = (function () {
  "use strict";

  var meta = null;            // {name, ext, kind, content, ...}
  var blockRaws = [];         // markdown: raw source text per top-level block
  var threads = [];           // server-synced: [{id, anchor, status, messages}]
  var pending = [];           // local unsent: {pid, type:'new'|'reply', thread_id?, anchor?, text, block?}
  var lastRev = -1;
  var seq = 0;
  var pollTimer = null;

  // ---- DOM refs ----
  var elContent, elFilename, elStatus, elList, elCount, elSend, elSendNote, elToast;
  var pop, popTarget, popText, popAdd, popCancel;
  var draftAnchor = null;     // anchor being composed in the popover
  var draftBlock = null;

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
    pop = document.getElementById("rd-popover");
    popTarget = document.getElementById("rd-popover-target");
    popText = document.getElementById("rd-popover-text");
    popAdd = document.getElementById("rd-popover-add");
    popCancel = document.getElementById("rd-popover-cancel");

    popAdd.addEventListener("click", onPopoverAdd);
    popCancel.addEventListener("click", closePopover);
    elSend.addEventListener("click", sendAll);

    elContent.addEventListener("mousemove", onHover);
    elContent.addEventListener("mouseleave", clearHover);
    elContent.addEventListener("mouseup", onMouseUp);

    popText.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.metaKey && !e.shiftKey) { e.preventDefault(); onPopoverAdd(); }
    });
    document.addEventListener("keydown", onGlobalKey);

    loadSource(true);
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

  function loadSource(initial) {
    return fetch("/source", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        meta = data;
        elFilename.textContent = data.name;
        render();
        reattachAll();
        renderSidebar();
        if (initial) {
          return refreshThreads(true).then(function () { startPolling(); setStatus("準備完了"); });
        }
      })
      .catch(function (err) { setStatus("読み込み失敗: " + err); });
  }

  // ===================================================================
  // rendering the document
  // ===================================================================
  function render() {
    elContent.innerHTML = "";
    blockRaws = [];
    if (meta.kind === "html") {
      elContent.innerHTML = extractHtmlBody(meta.content);
    } else {
      renderMarkdown(meta.content);
    }
  }

  function extractHtmlBody(html) {
    var m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return m ? m[1] : html;
  }

  function renderMarkdown(md) {
    var tokens = marked.lexer(md);
    var links = tokens.links || {};
    var idx = 0;
    tokens.forEach(function (tok) {
      if (tok.type === "space" || tok.type === "def") return;
      var toks = [tok];
      toks.links = links;
      var html = marked.parser(toks);
      var tmp = document.createElement("div");
      tmp.innerHTML = html;
      var children = Array.prototype.slice.call(tmp.children);
      if (children.length === 0) return;
      children.forEach(function (el) {
        var blockEl = el;
        if (el.tagName === "TABLE") {
          // Wrap tables so the commentable block (= marker host) stays a
          // non-scrolling element, while the inner div provides horizontal
          // scroll. Putting overflow on the marker host would clip the marker.
          var scroller = document.createElement("div");
          scroller.className = "rd-table-scroll";
          scroller.appendChild(el);
          blockEl = document.createElement("div");
          blockEl.className = "rd-table-block";
          blockEl.appendChild(scroller);
        }
        blockEl.dataset.srcblock = String(idx);
        elContent.appendChild(blockEl);
      });
      blockRaws[idx] = tok.raw || "";
      idx++;
    });
    // Catch tables nested inside other blocks (e.g. raw HTML blocks) that the
    // top-level wrap above missed. Marker host is the ancestor block here, so a
    // plain scroll wrapper is enough.
    Array.prototype.forEach.call(elContent.querySelectorAll("table"), function (t) {
      if (t.closest(".rd-table-scroll")) return;
      var scroller = document.createElement("div");
      scroller.className = "rd-table-scroll";
      t.parentNode.insertBefore(scroller, t);
      scroller.appendChild(t);
    });
  }

  // ===================================================================
  // hover highlight
  // ===================================================================
  var hovered = null;
  function onHover(e) {
    var target = blockOf(e.target);
    if (target === hovered) return;
    clearHover();
    if (target && target !== elContent) {
      target.classList.add("rd-hover");
      hovered = target;
    }
  }
  function clearHover() {
    if (hovered) { hovered.classList.remove("rd-hover"); hovered = null; }
  }

  function blockOf(node) {
    if (!node || node === elContent) return null;
    if (meta && meta.kind === "html") {
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
    if (meta.kind === "html") {
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
        block_index: bi, block_raw: bi >= 0 ? blockRaws[bi] : "",
        prefix: "", suffix: "", occurrence: 0
      };
      if (blk) fillContext(anchor, blk, range, selectedText);
    }
    draftAnchor = anchor; draftBlock = blk;
    showPopover(describeAnchor(anchor), rectOf(range));
  }

  function openBlockComment(blk) {
    var anchor;
    if (meta.kind === "html") {
      anchor = {
        type: "element", kind: "html", tag: blk.tagName.toLowerCase(),
        css_path: cssPath(blk), text: excerpt(blk.textContent.trim(), 200),
        outer_html_excerpt: excerpt(blk.outerHTML, 400)
      };
    } else {
      var bi = parseInt(blk.dataset.srcblock, 10);
      anchor = {
        type: "block", kind: "markdown", block_index: bi,
        block_raw: blockRaws[bi] || "", tag: blk.tagName.toLowerCase(),
        text: excerpt(blk.textContent.trim(), 200)
      };
      var h = /^h([1-6])$/.exec(blk.tagName.toLowerCase());
      if (h) { anchor.heading_level = parseInt(h[1], 10); anchor.heading_text = blk.textContent.trim(); }
    }
    draftAnchor = anchor; draftBlock = blk;
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
    pop.hidden = false;
    var top = window.scrollY + (rect ? rect.bottom : 100) + 6;
    var left = window.scrollX + (rect ? rect.left : 100);
    var maxLeft = window.scrollX + document.documentElement.clientWidth - 340 - 16;
    pop.style.top = top + "px";
    pop.style.left = Math.min(left, maxLeft) + "px";
    popText.focus();
  }
  function closePopover() {
    pop.hidden = true;
    draftAnchor = null; draftBlock = null;
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }
  function onPopoverAdd() {
    var text = popText.value.trim();
    if (!text || !draftAnchor) { closePopover(); return; }
    seq += 1;
    pending.push({ pid: "p" + seq, type: "new", anchor: draftAnchor, text: text, block: draftBlock });
    closePopover();
    reattachAll();
    renderSidebar();
  }

  // ===================================================================
  // re-feedback (drafting a reply on an existing thread)
  // ===================================================================
  function addReply(threadId, textarea) {
    var text = (textarea.value || "").trim();
    if (!text) return;
    seq += 1;
    pending.push({ pid: "p" + seq, type: "reply", thread_id: threadId, text: text });
    textarea.value = "";
    renderSidebar();
  }

  // ===================================================================
  // sidebar
  // ===================================================================
  function newDrafts() { return pending.filter(function (p) { return p.type === "new"; }); }
  function repliesFor(tid) { return pending.filter(function (p) { return p.type === "reply" && p.thread_id === tid; }); }

  // Assign display numbers to anchored items (new drafts + non-resolved threads),
  // in document order is hard; use creation order: drafts first, then threads.
  function numbering() {
    var map = {};
    var n = 0;
    newDrafts().forEach(function (d) { n += 1; map["draft:" + d.pid] = n; });
    threads.forEach(function (t) {
      if (t.status === "resolved") return;
      n += 1; map["thread:" + t.id] = n;
    });
    return map;
  }

  function renderSidebar() {
    var nums = numbering();
    var open = threads.filter(function (t) { return t.status !== "resolved"; });
    var resolved = threads.filter(function (t) { return t.status === "resolved"; });
    var activeCount = newDrafts().length + open.length;
    elCount.textContent = String(activeCount);

    elList.innerHTML = "";

    if (activeCount === 0 && resolved.length === 0) {
      var p = document.createElement("p");
      p.className = "rd-empty";
      p.textContent = "コメントはまだありません。本文を選択／クリックして Cmd+Enter で追加。";
      elList.appendChild(p);
    }

    // new drafts
    newDrafts().forEach(function (d) {
      elList.appendChild(draftCard(d, nums["draft:" + d.pid]));
    });
    // open + answered threads
    open.forEach(function (t) {
      elList.appendChild(threadCard(t, nums["thread:" + t.id]));
    });
    // resolved (collapsed)
    if (resolved.length) {
      var details = document.createElement("details");
      details.className = "rd-resolved-group";
      var sum = document.createElement("summary");
      sum.textContent = "解決済み (" + resolved.length + ")";
      details.appendChild(sum);
      resolved.forEach(function (t) { details.appendChild(threadCard(t, null)); });
      elList.appendChild(details);
    }

    var nPending = pending.length;
    elSend.disabled = nPending === 0;
    elSend.textContent = nPending > 0 ? "Claude に送信 (" + nPending + ")" : "Claude に送信";
    elSendNote.textContent = nPending > 0
      ? "Cmd+Shift+Enter で送信"
      : "本文を選択/クリック → Cmd+Enter で追加";
  }

  function header(num, kindLabel, badgeCls) {
    var head = document.createElement("div");
    head.className = "rd-item-head";
    var left = document.createElement("span");
    var numHtml = num != null ? '<span class="rd-item-num ' + (badgeCls || "") + '">' + num + '</span> ' : "";
    left.innerHTML = numHtml + '<span class="rd-item-kind">' + kindLabel + '</span>';
    head.appendChild(left);
    return head;
  }

  function draftCard(d, num) {
    var item = document.createElement("div");
    item.className = "rd-item draft";
    var head = header(num, "下書き · " + anchorKindLabel(d.anchor), "draft");
    var del = document.createElement("button");
    del.className = "rd-item-del"; del.textContent = "削除";
    del.addEventListener("click", function () { removePending(d.pid); });
    head.appendChild(del);
    item.appendChild(head);

    var tgt = document.createElement("div");
    tgt.className = "rd-item-target";
    tgt.textContent = anchorSnippet(d.anchor);
    item.appendChild(tgt);

    item.appendChild(bubble("user", d.text, true));
    return item;
  }

  function threadCard(t, num) {
    var item = document.createElement("div");
    item.className = "rd-item thread status-" + t.status;
    var label = t.status === "answered" ? "返信あり" : (t.status === "resolved" ? "解決済み" : "対応中");
    var head = header(num, label + " · " + anchorKindLabel(t.anchor),
      t.status === "answered" ? "answered" : "");
    if (t.status !== "resolved") {
      var resolveBtn = document.createElement("button");
      resolveBtn.className = "rd-item-resolve";
      resolveBtn.textContent = "解決";
      resolveBtn.addEventListener("click", function () { resolveThread(t.id); });
      head.appendChild(resolveBtn);
    } else {
      var reopenBtn = document.createElement("button");
      reopenBtn.className = "rd-item-resolve";
      reopenBtn.textContent = "再開";
      reopenBtn.addEventListener("click", function () { reopenThread(t.id); });
      head.appendChild(reopenBtn);
    }
    item.appendChild(head);

    var tgt = document.createElement("div");
    tgt.className = "rd-item-target";
    tgt.textContent = anchorSnippet(t.anchor);
    item.appendChild(tgt);

    (t.messages || []).forEach(function (m) {
      item.appendChild(bubble(m.role, m.text, false));
    });

    // pending re-feedback drafts for this thread
    repliesFor(t.id).forEach(function (p) {
      var b = bubble("user", p.text, true);
      var del = document.createElement("button");
      del.className = "rd-bubble-del"; del.textContent = "×";
      del.title = "下書きを削除";
      del.addEventListener("click", function () { removePending(p.pid); });
      b.appendChild(del);
      item.appendChild(b);
    });

    // reply box (not for resolved)
    if (t.status !== "resolved") {
      var box = document.createElement("div");
      box.className = "rd-reply";
      var ta = document.createElement("textarea");
      ta.rows = 2;
      ta.placeholder = t.status === "answered"
        ? "意図と違えば再フィードバック… (Cmd+Enter)"
        : "補足… (Cmd+Enter)";
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.metaKey && !e.shiftKey) { e.preventDefault(); addReply(t.id, ta); }
      });
      var add = document.createElement("button");
      add.className = "rd-btn rd-btn-ghost rd-reply-add";
      add.textContent = "追加";
      add.addEventListener("click", function () { addReply(t.id, ta); });
      box.appendChild(ta);
      box.appendChild(add);
      item.appendChild(box);
    }
    return item;
  }

  function bubble(role, text, isDraft) {
    var b = document.createElement("div");
    b.className = "rd-bubble " + (role === "claude" ? "claude" : "user") + (isDraft ? " draft" : "");
    var who = document.createElement("span");
    who.className = "rd-bubble-who";
    who.textContent = role === "claude" ? "Claude" : (isDraft ? "あなた（送信待ち）" : "あなた");
    var body = document.createElement("div");
    body.className = "rd-bubble-text";
    body.textContent = text;
    b.appendChild(who);
    b.appendChild(body);
    return b;
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
    pending = pending.filter(function (p) { return p.pid !== pid; });
    reattachAll();
    renderSidebar();
  }

  // ===================================================================
  // markers on the document
  // ===================================================================
  function markBlock(block, key, num, cls) {
    if (!block || block === elContent) return;
    block.classList.add("rd-commented");
    if (cls) block.classList.add(cls);
    if (getComputedStyle(block).position === "static") block.style.position = "relative";
    var marker = document.createElement("span");
    marker.className = "rd-marker" + (cls ? " " + cls : "");
    marker.dataset.key = key;
    marker.textContent = num != null ? String(num) : "•";
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

  // Re-place all markers (new drafts + non-resolved threads) after a render.
  function reattachAll() {
    clearMarkers();
    var nums = numbering();
    newDrafts().forEach(function (d) {
      var blk = anchorToBlock(d.anchor) || d.block;
      if (blk && elContent.contains(blk)) markBlock(blk, "draft:" + d.pid, nums["draft:" + d.pid], "draft");
    });
    threads.forEach(function (t) {
      if (t.status === "resolved") return;
      var blk = anchorToBlock(t.anchor);
      var cls = t.status === "answered" ? "answered" : null;
      if (blk) markBlock(blk, "thread:" + t.id, nums["thread:" + t.id], cls);
    });
  }

  // ===================================================================
  // send (submit batch)
  // ===================================================================
  function sendAll() {
    if (pending.length === 0) return;
    elSend.disabled = true;
    elSendNote.textContent = "送信中…";
    var items = pending.map(function (p) {
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
          pending = [];
          threads = res.threads || threads;
          lastRev = res.rev;
          reattachAll();
          renderSidebar();
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
        if (res && res.ok) { lastRev = res.rev; refreshThreads(false); }
      })
      .catch(function () {});
  }

  // ===================================================================
  // polling / live reload
  // ===================================================================
  function refreshThreads(silent) {
    return fetch("/threads", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        threads = d.threads || [];
        lastRev = d.rev;
        reattachAll();
        renderSidebar();
      })
      .catch(function () {});
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(checkRev, 3500);
  }
  function checkRev() {
    fetch("/threads", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (typeof d.rev === "number" && d.rev > lastRev) {
          lastRev = d.rev;
          threads = d.threads || [];
          // Claude may have edited the file: re-fetch source + re-render + re-attach.
          setStatus("更新を検知 — 再読み込み");
          toast("Claude がドキュメントを更新しました");
          loadSource(false);
        }
      })
      .catch(function () {});
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
  var toastTimer = null;
  function toast(msg) {
    elToast.textContent = msg;
    elToast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.hidden = true; }, 3500);
  }

  return { start: start };
})();
