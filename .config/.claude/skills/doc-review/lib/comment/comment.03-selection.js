"use strict";


  // ===================================================================
  // hover highlight
  // ===================================================================
  function onHover(e) {
    if (state.diffMode) return;   // diff-mode content isn't a commentable target
    var target = blockOf(e.target, e);
    if (target === state.hovered) return;
    clearHover();
    if (target && target !== rdRoot()) {
      target.classList.add("rd-hover");
      syncLiOwnContentHeight(target);
      state.hovered = target;
    }
  }
  function clearHover() {
    if (state.hovered) {
      state.hovered.classList.remove("rd-hover");
      state.hovered = null;
    }
  }

  // A code block has no separate DOM node for "the scrollbar" the way a table
  // does (blockOf()'s .rd-table-scroll check below) — the <pre> IS both the
  // commentable target and the scrolling box, with no element boundary to
  // tell "over the scrollbar" from "over the code" apart by structure alone.
  // Geometry is the only signal available: a reserved (non-overlay) scrollbar
  // occupies exactly `offsetHeight - clientHeight` px along the bottom edge.
  // On a system with zero-footprint overlay scrollbars this comes out to 0,
  // so the check is simply never true there — it falls back to the old
  // (whole-block) behaviour instead of guessing at a boundary it can't see.
  function isOverElementScrollbar(el, clientY) {
    if (!el || el.scrollWidth <= el.clientWidth) return false;
    var reserved = el.offsetHeight - el.clientHeight;
    if (reserved <= 0) return false;
    return clientY >= el.getBoundingClientRect().top + el.clientHeight;
  }

  function blockOf(node, e) {
    var root = rdRoot();
    if (!node || node === root) return null;
    if (isHtml()) {
      var raw = node.nodeType === 3 ? node.parentElement : node;
      if (!raw || !root.contains(raw)) return null;
      // An arbitrary target can put `overflow-x: auto` on anything, not just
      // the two structural cases md knows about below (.rd-table-scroll,
      // <pre>) — so every ancestor between the click and root is checked
      // geometrically instead, same isOverElementScrollbar() reasoning as
      // those. `e` is absent for the range-comment call site (no click point
      // to test), which this simply skips, same as the <pre> check below.
      if (e) {
        for (var sb = raw; sb && sb !== root; sb = sb.parentElement) {
          if (isOverElementScrollbar(sb, e.clientY)) return null;
        }
      }
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
      // .rd-table-scroll is a layout-only wrapper we inject purely to carry
      // overflow-x (renderTableBlock in comment.02-render.js) — it never
      // carries a data-srcblock itself, so the climb above would otherwise
      // sail past it up to the surrounding .rd-table-block and treat the hit
      // as "hovering/clicking the whole table". But the *only* real content
      // under this wrapper is the <table> and its cells, which — when hit —
      // resolve to their own data-srcblock before the climb ever reaches
      // here. So landing on this wrapper itself means the cursor is over
      // space with no cell under it: the table's own horizontal scrollbar, or
      // the empty margin beside a table narrower than the viewport. Neither
      // is a click target — "comment on the whole table" now has a single,
      // dedicated target instead (the band above the table; see 01-base.css).
      if (blk.classList && blk.classList.contains("rd-table-scroll")) return null;
      // The <pre> itself is the scrolling box (its data-srcblock now lives on
      // the non-clipping .rd-pre-block wrapper around it — see
      // comment.02-render.js), so this has to be caught here, on the way past
      // <pre>, using the same geometry check as the hover path.
      if (blk.tagName === "PRE" && e && isOverElementScrollbar(blk, e.clientY)) return null;
      blk = blk.parentElement;
    }
    return blk && blk.dataset && blk.dataset.srcblock !== undefined ? blk : null;
  }

  // ===================================================================
  // selecting / clicking → build anchor → open popover
  // ===================================================================
  // A horizontal scrollbar (table/code block) fires no `mousedown` on the DOM
  // (the browser's own scrollbar chrome eats it) but DOES deliver a `mouseup`
  // to the scrolled element once the drag ends. That mouseup used to be
  // indistinguishable from "clicked this block" — no text gets selected by a
  // scrollbar drag, so `sel.isCollapsed` was true either way, and a comment
  // popover opened on every scroll. Recording the mousedown point lets us tell
  // the two apart: a real click always has a matching mousedown right before
  // it, at (near) the same point.
  var mouseDownPoint = null;
  var DRAG_THRESHOLD_PX = 4;

  function onMouseDown(e) {
    mouseDownPoint = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  }

  function onMouseUp(e) {
    if (state.diffMode) return;   // no drafting a comment against diff-mode content
    // Clicking a marker badge is "jump to comment", not "comment on this block".
    if (e.target.closest && e.target.closest(".rd-marker")) return;
    var down = mouseDownPoint;
    mouseDownPoint = null;
    setTimeout(function () {
      var sel = rdDoc().getSelection();
      var text = sel && !sel.isCollapsed ? sel.toString() : "";
      if (text && text.trim() && withinContent(sel)) {
        openRangeComment(sel);
        return;
      }
      // No text selection: only treat this as "clicked this block" when it was
      // actually a click — i.e. a mousedown we saw ourselves, close to where the
      // mouse came up. A scrollbar drag (no mousedown reaches the DOM) or a
      // large drag that ended up not selecting text (e.g. released outside the
      // content) is ignored instead of guessed at.
      var blk = null;
      if (down) {
        var dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (dx * dx + dy * dy <= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) blk = blockOf(e.target, e);
      }
      if (blk && blk !== rdRoot()) {
        openBlockComment(blk);
      } else if (!pop.hidden) {
        // Landed somewhere that isn't a commentable target (a scrollbar, the
        // gutter beside a table, anywhere blockOf() refuses) while a draft
        // popover was open. Leaving that popover sitting there — still aimed
        // at wherever it was opened for — reads as if the click did nothing;
        // closing it instead makes "nowhere to comment here" unambiguous.
        closePopover();
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
    } else if (blk && blk.dataset.rdcol !== undefined) {
      var cellA = cellAnchor(blk);
      anchor = {
        type: "range", kind: "markdown", selected_text: selectedText,
        block_index: cellA.block_index, block_raw: cellA.block_raw,
        table_raw: cellA.table_raw, row: cellA.row, col: cellA.col,
        section: cellA.section, header_text: cellA.header_text,
        prefix: "", suffix: "", occurrence: 0
      };
      fillContext(anchor, blk, range, selectedText);
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
    } else if (blk.dataset.rdcol !== undefined) {
      anchor = cellAnchor(blk);
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

  // A table cell has no `raw` of its own (marked's table tokenizer only keeps
  // {text, tokens} per cell — see comment.02-render.js's renderTableBlock), so
  // instead of a per-cell snippet the content-match key (block_raw) is the raw
  // source line the cell's row came from. row/col/section pin down WHICH cell
  // on that line once anchorToBlock re-resolves it (comment.05-markers.js);
  // table_raw + header_text are context for Claude, not part of the match.
  function cellAnchor(cell) {
    var bi = parseInt(cell.dataset.srcblock, 10);
    var tableBlock = cell.closest(".rd-table-block");
    var tableIdx = tableBlock ? parseInt(tableBlock.dataset.srcblock, 10) : -1;
    var headerText = cell.textContent;
    if (cell.dataset.rdsection === "body") {
      var theadRow = cell.closest("table").querySelector("thead tr");
      var headerCell = theadRow ? theadRow.children[parseInt(cell.dataset.rdcol, 10)] : null;
      headerText = headerCell ? headerCell.textContent : "";
    }
    return {
      type: "cell", kind: "markdown",
      block_index: bi, block_raw: state.blockRaws[bi] || "",
      table_raw: tableIdx >= 0 ? (state.blockRaws[tableIdx] || "") : "",
      row: parseInt(cell.dataset.rdrow, 10), col: parseInt(cell.dataset.rdcol, 10),
      section: cell.dataset.rdsection, header_text: headerText.trim(),
      tag: cell.tagName.toLowerCase(), text: excerpt(cell.textContent.trim(), 200)
    };
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
    if (a.type === "cell") {
      var col = a.header_text || ("列" + (a.col + 1));
      var loc = a.section === "header" ? col : (col + " / " + (a.row + 1) + "行目");
      return "&lt;" + (a.tag || "cell") + "&gt; " + escapeHtml(loc) + "：" + escapeHtml(a.text || "");
    }
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
