"use strict";


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
