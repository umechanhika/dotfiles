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
    // isHtml() only knows the answer once state.meta is set — the diff
    // toggle is markdown-only, so its visibility depends on this.
    if (typeof updateDiffToggleUI === "function") updateDiffToggleUI();
    elFilename.textContent = data.name;
    // Baseline tab title = filename, so it's never blank. renderMarkdown()
    // (first heading) or onFrameLoad() (doc.title) overrides this below when
    // the document has one; a load failure leaves this baseline visible
    // instead of hiding the problem behind a stale title.
    document.title = data.name;
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
    setDocTitle(doc.title);
    var root = doc.body || doc.documentElement;
    docEnv = { doc: doc, root: root, frame: elFrame };
    injectFrameOverlay(doc);
    // Interaction listeners live on the freshly-loaded document. A new document
    // each load means old listeners are discarded with it — no leak.
    root.addEventListener("mousemove", onHover);
    root.addEventListener("mouseleave", clearHover);
    doc.addEventListener("mousedown", onMouseDown);
    doc.addEventListener("mouseup", onMouseUp);
    // Keyboard events don't cross the iframe boundary, so when focus sits inside
    // the frame the global shortcuts (Esc, ⌘⇧Enter send) would be missed. These
    // are parent closures; attaching them to the frame doc keeps them working.
    doc.addEventListener("keydown", onGlobalKey);
    // #rd-frame is fluid-width (01-base.css), so both a real window resize
    // and dragging the sidebar handle (comment.07-utils.js) reflow the
    // target content — a live sidebar drag fires this continuously, hence
    // the debounce. refreshView() re-places every marker, which recomputes
    // any commented <li>'s own-content height (syncLiOwnContentHeight,
    // comment.07-utils.js) against the new layout instead of leaving it
    // pointing at a stale height.
    if (elFrame.contentWindow) {
      var resizeTimer = null;
      elFrame.contentWindow.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(refreshView, 120);
      });
    }
    state.hovered = null;
    refreshView();   // place markers for the current threads/drafts inside the frame
    if (elFrame.contentWindow) {
      try { elFrame.contentWindow.scrollTo(0, state.pendingScrollY || 0); } catch (e) { /* best effort */ }
    }
    state.pendingScrollY = 0;
    // No-op unless an edit landed while this reload was in flight
    // (state.autoDiffPending — comment.06-server.js's onRevBumped); see
    // maybeAutoEnterDiff's own doc comment (comment.09-diffview.js) for why
    // this and the baseline fetch both call it rather than either alone.
    maybeAutoEnterDiff();
  }

  // Every onFrameLoad() runs against a brand-new document (a fresh iframe
  // navigation, never one we've touched before — see the note at the top of
  // onFrameLoad), so there's never a stale link left over to reuse or replace.
  // A real <link> (not an injected <style> string) lets the browser fetch and
  // cache frame-overlay.css itself; onerror surfaces a failed load instead of
  // silently leaving the target unstyled with no indication why.
  function injectFrameOverlay(doc) {
    var head = doc.head || doc.documentElement;
    if (!head) return;
    var link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = "/lib/comment/frame-overlay.css";
    link.id = "rd-overlay-style";
    link.onerror = function () {
      setStatus("オーバーレイCSSの読み込みに失敗しました");
      toast("プレビューの枠線/マーカー表示が崩れる可能性があります");
    };
    head.appendChild(link);
  }

  // Front matter must open on the very first line; anything else is body
  // text. Matching only at position 0 means an ordinary "---" horizontal
  // rule or a legitimate Setext heading further down the document is never
  // touched by this.
  var FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

  // Browser tab title: a no-op on an empty/whitespace value so a missing
  // heading (or empty <title>) never blanks out the filename baseline set in
  // applySource(). excerpt() truncates long headings; long tab labels just
  // get clipped by the OS anyway, this keeps hover tooltips reasonable too.
  function setDocTitle(text) {
    text = (text || "").trim();
    if (!text) return;
    document.title = excerpt(text, 60);
  }

  // Renders one non-list/non-table token into an array of DOM elements, with
  // NO side effects: no data-srcblock, no append to any live document, no
  // state.blockRaws write. That bookkeeping is the marker system's contract
  // (comment.05-markers.js) and belongs solely to the caller. Shared by the
  // normal renderer below (which adds the bookkeeping right after calling
  // this) and the diff view (comment.09-diffview.js), which deliberately
  // never wants it — a diff-mode block is not a commentable target.
  function buildBlockEls(tok, links, scratch) {
    var toks = [tok];
    toks.links = links;
    scratch.innerHTML = marked.parser(toks);
    return Array.prototype.slice.call(scratch.children).map(function (el) {
      if (el.tagName !== "PRE") return el;
      // A fenced code block's own overflow-x: auto (01-base.css) makes it a
      // clipping box, same as any other `overflow != visible` element — the
      // marker badge (position: absolute, negative top/left — see
      // 02-markers.css) is a CHILD of the marker host, so if the host is the
      // clipping box itself, the badge gets clipped away invisibly rather
      // than bleeding into the gutter. A plain wrapper (no overflow of its
      // own) becomes the marker host instead, exactly the same fix as the
      // table's .rd-table-block/.rd-table-scroll split.
      return h("div", { "class": "rd-pre-block" }, [el]);
    });
  }

  // Render markdown block-by-block. We intentionally parse each top-level token
  // on its own: it is what lets us map every rendered block back to its exact
  // raw markdown (`block_raw`) and a stable `data-srcblock` index. That mapping
  // is the contract the anchoring rules (anchoring.md) rely on, so we keep it —
  // but we reuse a single scratch element instead of allocating one per block.
  function renderMarkdown(md) {
    var idx = 0;
    // marked's lexer has no concept of front matter: it sees the opening
    // "---" as a thematic break and the closing "---" as a Setext heading
    // underline for whatever follows, so the metadata block renders as a
    // giant <h2>. Carve it out ourselves before handing the rest to the
    // lexer, and render it as inert preformatted text (block 0).
    var fmMatch = FRONTMATTER_RE.exec(md);
    if (fmMatch) {
      var fmRaw = fmMatch[0].replace(/\s+$/, "");
      state.blockRaws[0] = fmMatch[0];
      var fmEl = h("pre", { "class": "rd-frontmatter", dataset: { srcblock: "0" } }, [fmRaw]);
      elContent.appendChild(fmEl);
      idx = 1;
      md = md.slice(fmMatch[0].length);
    }
    var tokens = marked.lexer(md);
    var links = tokens.links || {};
    var scratch = document.createElement("div");
    var titled = false;   // only the first heading sets the tab title
    tokens.forEach(function (tok) {
      if (!titled && tok.type === "heading") { setDocTitle(tok.text); titled = true; }
      if (tok.type === "space" || tok.type === "def") return;
      if (tok.type === "list") {
        idx += renderListBlock(tok, idx, links, scratch);
        return;
      }
      if (tok.type === "table") {
        idx += renderTableBlock(tok, idx, links, scratch);
        return;
      }
      var children = buildBlockEls(tok, links, scratch);
      if (children.length === 0) return;
      children.forEach(function (blockEl) {
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

  // Depth-first list item raws, in the same order marked renders <li>
  // elements: a nested sub-list lives inside its parent <li>, so its items
  // appear right after their parent item's own text in the DOM too — verified
  // against marked's actual token/HTML output (see anchoring.md). An item's
  // own raw already includes any nested list beneath it (marked's own block
  // semantics: the sub-list is part of that item's content), so it and its
  // children's raws are never identical strings — no ambiguity when matching.
  function collectListItemRaws(listTok, out) {
    (listTok.items || []).forEach(function (item) {
      out.push(item.raw || "");
      walkNestedLists(item.tokens, out);
    });
  }
  function walkNestedLists(toks, out) {
    (toks || []).forEach(function (t) {
      if (t.type === "list") collectListItemRaws(t, out);
      else if (t.tokens) walkNestedLists(t.tokens, out);
    });
  }

  // Render one top-level "list" token. The whole <ul>/<ol> stays block `idx`
  // (unchanged from before per-item comments existed — old saved anchors
  // pointing at the whole list still resolve, and the list's own margin stays
  // a valid click target). On top of that, tag each rendered <li> with its
  // own srcblock + raw markdown so clicking inside an item's own text targets
  // just that item. If the item count collected from the token tree doesn't
  // match the <li> count marked actually rendered, we don't guess which is
  // which: skip per-item tagging for this list (whole-list block only) and
  // surface it instead of silently mis-anchoring a comment.
  // Returns how many srcblock indices this list consumed, so the caller can
  // advance `idx` past them without colliding with the next top-level block.
  function renderListBlock(tok, idx, links, scratch) {
    var toks = [tok];
    toks.links = links;
    scratch.innerHTML = marked.parser(toks);
    var children = Array.prototype.slice.call(scratch.children);
    if (children.length === 0) return 0;
    var listEl = children[0];
    listEl.dataset.srcblock = String(idx);
    elContent.appendChild(listEl);
    state.blockRaws[idx] = tok.raw || "";

    var itemRaws = [];
    collectListItemRaws(tok, itemRaws);
    var liEls = listEl.querySelectorAll("li");
    if (liEls.length !== itemRaws.length) {
      console.error(
        "doc-review: list item count mismatch (rendered " + liEls.length +
        ", collected " + itemRaws.length + ") — commenting on individual items " +
        "is unavailable for this list; the whole list is still commentable.",
        tok.raw
      );
      toast("箇条書きの項目分割に失敗しました（リスト全体へのコメントのみ利用できます）");
      return 1;
    }
    var base = idx + 1;
    Array.prototype.forEach.call(liEls, function (li, i) {
      var target = isolateOwnContent(li);
      target.dataset.srcblock = String(base + i);
      state.blockRaws[base + i] = itemRaws[i];
    });
    return 1 + itemRaws.length;
  }

  // A parent item's <li> box wraps its own text AND its nested sub-list (the
  // sub-list is a normal block child sitting inside it) — so outlining the
  // <li> itself for hover/comment would visually engulf the children below it
  // too. Move everything before the first nested <ul>/<ol> into its own inner
  // box and tag THAT instead, so hovering/commenting on a parent item's own
  // line never highlights its children (dragging a text selection across
  // parent + children still works via the range-anchor path, untouched here).
  // Leaf items (no nested list) are returned as-is: nothing to isolate.
  function isolateOwnContent(li) {
    var firstNested = null;
    for (var i = 0; i < li.children.length; i++) {
      var c = li.children[i];
      if (c.tagName === "UL" || c.tagName === "OL") { firstNested = c; break; }
    }
    if (!firstNested) return li;
    var own = document.createElement("div");
    own.className = "rd-li-own";
    while (li.firstChild !== firstNested) own.appendChild(li.firstChild);
    li.insertBefore(own, firstNested);
    return own;
  }

  // Render one top-level "table" token. The whole table stays block `idx` —
  // exactly the same wrapping as before per-cell comments existed — so old
  // saved anchors pointing at the whole table still resolve, and the padded
  // band above the table (rd-table-block, see 01-base.css) stays a valid
  // click target for "comment on the whole table". On top of that, tag each
  // rendered <th>/<td> with its own srcblock, row/col/section, so clicking a
  // cell targets just that cell (blockOf() already prefers the innermost
  // tagged ancestor — same mechanism as per-item list comments).
  //
  // A table cell has no `raw` of its own (unlike a list item) — marked's
  // table tokenizer only keeps `{text, tokens}` per cell — so instead of
  // reconstructing a single cell's markdown we key each cell to the raw
  // source line of the row it lives in (header row for <th>, its own line
  // for <td>). That's what makes it possible to reconstruct a cell's real
  // `raw` on paper.
  //
  // Returns how many srcblock indices this table consumed, mirroring
  // renderListBlock so the caller can advance `idx` past them.
  function renderTableBlock(tok, idx, links, scratch) {
    var toks = [tok];
    toks.links = links;
    scratch.innerHTML = marked.parser(toks);
    var tableEl = scratch.firstElementChild;
    if (!tableEl) return 0;
    var scroller = h("div", { "class": "rd-table-scroll" }, [tableEl]);
    var blockEl = h("div", { "class": "rd-table-block" }, [scroller]);
    blockEl.dataset.srcblock = String(idx);
    elContent.appendChild(blockEl);
    state.blockRaws[idx] = tok.raw || "";

    var lines = tableRawLines(tok.raw, tok.rows.length);
    var theadRow = tableEl.querySelector("thead tr");
    var bodyRows = tableEl.querySelectorAll("tbody tr");
    var ok = lines && theadRow && theadRow.children.length === tok.header.length &&
      bodyRows.length === tok.rows.length;
    if (ok) {
      for (var r = 0; r < bodyRows.length; r++) {
        if (bodyRows[r].children.length !== tok.rows[r].length) { ok = false; break; }
      }
    }
    if (!ok) {
      console.error(
        "doc-review: table cell count mismatch — commenting on individual " +
        "cells is unavailable for this table; the whole table is still commentable.",
        tok.raw
      );
      toast("表のセル分割に失敗しました（表全体へのコメントのみ利用できます）");
      return 1;
    }

    var headerLine = lines[0];
    var dataLines = lines.slice(2);
    var base = idx + 1, n = 0;
    Array.prototype.forEach.call(theadRow.children, function (cell, col) {
      tagCell(cell, base + n, -1, col, "header", headerLine);
      n++;
    });
    Array.prototype.forEach.call(bodyRows, function (rowEl, r) {
      Array.prototype.forEach.call(rowEl.children, function (cell, col) {
        tagCell(cell, base + n, r, col, "body", dataLines[r]);
        n++;
      });
    });
    return 1 + n;
  }

  function tagCell(cell, srcblock, row, col, section, rawLine) {
    cell.dataset.srcblock = String(srcblock);
    cell.dataset.rdrow = String(row);
    cell.dataset.rdcol = String(col);
    cell.dataset.rdsection = section;
    state.blockRaws[srcblock] = rawLine;
  }

  // Split a table's raw markdown into its source lines (header / delimiter /
  // one per data row) so each cell can be keyed to the line it came from.
  // GFM table rows are always exactly one physical line each — a cell can't
  // contain a literal newline — so this is a plain split, not a parse. If the
  // line count doesn't match the row count marked collected, something about
  // this table isn't a plain GFM table (or trailing whitespace confused the
  // split): return null and let the caller fall back to whole-table-only
  // rather than mis-key a cell to the wrong line.
  function tableRawLines(raw, rowCount) {
    var lines = (raw || "").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length === 2 + rowCount ? lines : null;
  }
