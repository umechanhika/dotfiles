"use strict";


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
