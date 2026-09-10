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
