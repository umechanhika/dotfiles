"use strict";

/* doc-review — diff-mode calculation for HTML targets (pure; compute only).
 *
 * Markdown's diff (comment.08-diff.js) special-cases exactly two container
 * shapes — "table" and "list" — because marked's TOKEN model only ever
 * nests that deep (a table token's rows, a list token's items); everything
 * else is one flat top-level block. An arbitrary HTML target has no such
 * ceiling — real reports nest <div>/<section> wrappers around further
 * blocks routinely — so this file takes the opposite approach: ONE generic
 * recursive comparison, applied uniformly at every level (document body,
 * a wrapping <div>, a <table>'s rows, a row's cells, a <ul>'s items, a
 * nested <ul> inside one of those items, ...). There is no per-tag special
 * casing for TABLE/UL/OL: a <table>'s direct children are section elements
 * (<thead>/<tbody>) or bare <tr>s, and either way recursing into them one
 * generic level at a time lands on individual <tr>s, then their <td>/<th>
 * cells, on its own — same for a <ul>'s <li> children. The only per-level
 * decision this file makes is "does this element have any block-level
 * child (hasBlockChildren) — if so, recurse; if not (a leaf — a plain
 * paragraph, a heading, a table cell, a list item with no nested list,
 * ...), word-diff its whole flattened text" (isInlineTag/hasBlockChildren
 * below; a leaf still correctly includes inline-formatted text via
 * collectTextRuns, exactly like comment.08-diff.js's wordDiffForBlockPair
 * already does for markdown's inline spans).
 *
 * "Block" here is decided by TAG NAME (isInlineTag's fixed list), not by
 * computed style: the baseline side is parsed via DOMParser into a document
 * that was never attached to a window, so getComputedStyle on it wouldn't
 * reflect the target's real CSS anyway (no cascade applies to a detached
 * document) — a tag-based heuristic gives both sides the same, predictable
 * answer. This misclassifies the rare page that overrides a semantic tag's
 * display (e.g. `li { display: inline }` for a horizontal nav) — a known,
 * documented limitation, not a silent one.
 *
 * Reused from comment.08-diff.js (all pure, none of it DOM/state-specific
 * to markdown): lcsOpcodes, diceCoefficient, greedyPair, mergeAligned,
 * PAIR_DICE_THRESHOLD, collectTextRuns, wordSpans, isWhitespaceWord,
 * analyzeWordDiff, mergeChangedRanges, refSet.
 *
 * DOM writes (wrapping changed words in <del>/<ins>, inserting a cloned
 * deleted element into the live tree) are Phase 4's job — nothing here
 * touches oldRoot, newRoot, or anything under them. wordDiffForElementPair
 * returns *ranges* (offsets into the flattened text), the same shape
 * comment.08-diff.js's wordDiffForLinePair already returns for the same
 * reason.
 *
 * Public surface used by comment.09-diffview.js (Phase 4):
 *   diffHtmlDom(oldHtml, newRoot) -> { ops }
 *     ops: [{op:"equal", oldNode, newNode}
 *          |{op:"insert", newNode}
 *          |{op:"delete", oldNode}
 *          |{op:"replace", oldNode, newNode, mode:"recurse", children:[...ops]}
 *          |{op:"replace", oldNode, newNode, mode:"word"|"whole", reason?,
 *            oldRanges?, newRanges?, refsChanged}]
 */

  // Elements whose own box never carries independent block-level meaning —
  // flowed inline with surrounding text, so their content folds into
  // whatever leaf element's flattened word-diff contains them, instead of
  // being pulled out as a separately comparable sibling. Covers common
  // inline text formatting/embeds; anything else (custom elements included)
  // defaults to block, which just means "gets recursed into on its own"
  // rather than "flattened into its parent's text" — the safer default,
  // since flattening structure INTO a leaf that shouldn't have been one
  // would lose comment-anchor-worthy granularity, not just cosmetic detail.
  var INLINE_TAGS = {
    A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BR: 1, CITE: 1, CODE: 1, DATA: 1,
    DFN: 1, EM: 1, I: 1, KBD: 1, MARK: 1, Q: 1, RP: 1, RT: 1, RUBY: 1, S: 1,
    SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, U: 1,
    VAR: 1, WBR: 1, IMG: 1, BUTTON: 1, LABEL: 1, INPUT: 1, SELECT: 1,
    TEXTAREA: 1
  };
  function isInlineTag(el) { return !!INLINE_TAGS[el.tagName]; }
  function hasBlockChildren(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (!isInlineTag(el.children[i])) return true;
    }
    return false;
  }
  // The comparable sibling list at one recursion level: block-level element
  // children only. Bare/inline content alongside them (an element's own
  // leading text before a nested list, an inline <a> mid-sentence, ...)
  // isn't pulled out as its own op — it stays wherever it already was,
  // covered once recursion bottoms out at a leaf ancestor's flattened text.
  function blockChildren(el) {
    return Array.prototype.filter.call(el.children, function (c) { return !isInlineTag(c); });
  }

  function normText(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  // Equality/typing key for one element: two elements are only ever
  // considered identical (lcsOpcodes' "equal") when this matches exactly —
  // same tag, same attributes, same flattened text all the way down, AND
  // (refSet — comment.08-diff.js:548) the same set of descendant img[src]/
  // a[href] targets. textContent alone misses that last one: an <a> whose
  // visible label is unchanged but whose href now points somewhere else has
  // identical text, so without refSet this fed a false "equal" straight
  // past buildReplaceOp — never reaching the refsChanged check that exists
  // specifically to catch it (found by this file's own Phase 3 console
  // verification: a same-text/changed-href fixture came back "equal").
  function elementKey(el) {
    var attrs = Array.prototype.map.call(el.attributes, function (a) {
      return a.name + "=" + a.value;
    }).sort().join(" ");
    return el.tagName + "|" + attrs + "|" + normText(el.textContent) + "|" + refSet(el);
  }

  // Guards against pathological nesting (not realistic hand-authored/
  // Claude-edited report HTML, but not impossible either) turning into an
  // unbounded recursive scan. Past this depth a container is treated as a
  // leaf instead — same "known, bounded default" category as
  // WORD_PRODUCT_LIMIT/CHANGE_RATIO_LIMIT (comment.08-diff.js) — not a
  // silently swallowed error.
  var MAX_RECURSE_DEPTH = 12;

  // A <tr>'s cells are positional, not reorderable prose — column N means
  // column N regardless of how much its text changed, unlike a paragraph or
  // list item, where "similar enough" pairing (below) is what lets an edit
  // survive being realigned after other insertions/deletions nearby. Cell
  // pairing by similarity actively gets this wrong: a cell rewritten enough
  // to share no bigrams with its old self (comment.08-diff.js's
  // diceCoefficient — completely plausible for a short cell, e.g. "いいい"
  // -> "編集済み") scores 0, missing PAIR_DICE_THRESHOLD entirely — so the
  // generic pairing below would call that a delete-then-insert, not a
  // replace, splicing an extra sibling <td> into the row and desyncing
  // every column after it from its header (this is exactly how markdown's
  // OWN diff treats a row's cells — comment.09-diffview.js's
  // appendChangedRowCells compares "column-by-column", never by score).
  function diffRowCellsPositional(oldRow, newRow, depth) {
    var oldCells = blockChildren(oldRow), newCells = blockChildren(newRow);
    var ops = [], count = Math.max(oldCells.length, newCells.length);
    for (var c = 0; c < count; c++) {
      var oldCell = oldCells[c], newCell = newCells[c];
      if (oldCell && newCell) {
        if (elementKey(oldCell) === elementKey(newCell)) {
          ops.push({ op: "equal", oldNode: oldCell, newNode: newCell });
        } else if (oldCell.tagName === newCell.tagName) {
          ops.push(buildReplaceOp(oldCell, newCell, depth));
        } else {
          // A <th> traded for a <td> (or vice versa) at the same column —
          // unusual, but typeCompatible (used everywhere else in this file)
          // would refuse to pair them too; same delete+insert fallback.
          ops.push({ op: "delete", oldNode: oldCell });
          ops.push({ op: "insert", newNode: newCell });
        }
      } else if (newCell) {
        ops.push({ op: "insert", newNode: newCell });
      } else {
        ops.push({ op: "delete", oldNode: oldCell });
      }
    }
    return ops;
  }

  // ===================================================================
  // generic recursive sibling-list diff (comment.08-diff.js:222's
  // diffTopLevelBlocks, generalised to run at every nesting level instead
  // of only the document root)
  // ===================================================================
  function diffElementChildren(oldParent, newParent, depth) {
    if (oldParent.tagName === "TR") return diffRowCellsPositional(oldParent, newParent, depth);
    var oldKids = blockChildren(oldParent), newKids = blockChildren(newParent);
    var oldKeys = oldKids.map(elementKey), newKeys = newKids.map(elementKey);
    var opcodes = lcsOpcodes(oldKeys, newKeys);

    var ops = [];
    opcodes.forEach(function (oc) {
      if (oc.op === "equal") {
        for (var k = 0; k < oc.a1 - oc.a0; k++) {
          ops.push({ op: "equal", oldNode: oldKids[oc.a0 + k], newNode: newKids[oc.b0 + k] });
        }
      } else if (oc.op === "delete") {
        for (var di = oc.a0; di < oc.a1; di++) ops.push({ op: "delete", oldNode: oldKids[di] });
      } else if (oc.op === "insert") {
        for (var ii = oc.b0; ii < oc.b1; ii++) ops.push({ op: "insert", newNode: newKids[ii] });
      } else {
        var oldSlice = oldKids.slice(oc.a0, oc.a1), newSlice = newKids.slice(oc.b0, oc.b1);
        var pairs = greedyPair(oldSlice.length, newSlice.length, function (a, b) {
          if (oldSlice[a].tagName !== newSlice[b].tagName) return -1;   // typeCompatible, element form
          return diceCoefficient(normText(oldSlice[a].textContent), normText(newSlice[b].textContent));
        }, PAIR_DICE_THRESHOLD);
        mergeAligned(oldSlice.length, newSlice.length, pairs,
          function (oi) { ops.push({ op: "delete", oldNode: oldSlice[oi] }); },
          function (ni) { ops.push({ op: "insert", newNode: newSlice[ni] }); },
          function (oi, ni) { ops.push(buildReplaceOp(oldSlice[oi], newSlice[ni], depth)); });
      }
    });
    return ops;
  }

  // Decides, for one paired (same-tag, similar-enough) element replace,
  // whether to recurse (either side has block children, and we haven't hit
  // MAX_RECURSE_DEPTH) or treat the pair as one word-diff leaf.
  function buildReplaceOp(oldNode, newNode, depth) {
    if (depth < MAX_RECURSE_DEPTH && (hasBlockChildren(oldNode) || hasBlockChildren(newNode))) {
      return {
        op: "replace", mode: "recurse", oldNode: oldNode, newNode: newNode,
        children: diffElementChildren(oldNode, newNode, depth + 1)
      };
    }
    var word = wordDiffForElementPair(oldNode, newNode);
    return {
      op: "replace", mode: word.mode, reason: word.reason,
      oldNode: oldNode, newNode: newNode, refsChanged: word.refsChanged,
      oldRanges: word.oldRanges, newRanges: word.newRanges
    };
  }

  // ===================================================================
  // leaf word diff — same pipeline as comment.08-diff.js's
  // wordDiffForBlockPair, minus the token->detached-DOM render step (we
  // already have real elements) and minus applying the result to the DOM
  // (Phase 4's job; this returns ranges only, like wordDiffForLinePair)
  // ===================================================================
  function wordDiffForElementPair(oldEl, newEl) {
    var refsChanged = refSet(oldEl) !== refSet(newEl);
    var oldRuns = collectTextRuns(oldEl), newRuns = collectTextRuns(newEl);
    var oldWords = wordSpans(oldRuns.text), newWords = wordSpans(newRuns.text);
    var oldTexts = oldWords.map(function (w) { return w.text; });
    var newTexts = newWords.map(function (w) { return w.text; });

    var decision = analyzeWordDiff(oldTexts, newTexts);
    if (decision.mode !== "word") {
      return { mode: "whole", reason: decision.reason, refsChanged: refsChanged };
    }
    var oldChanged = oldTexts.map(function () { return false; });
    var newChanged = newTexts.map(function () { return false; });
    decision.ops.forEach(function (oc) {
      if (oc.op === "equal") return;
      for (var ai = oc.a0; ai < oc.a1; ai++) oldChanged[ai] = true;
      for (var bi = oc.b0; bi < oc.b1; bi++) newChanged[bi] = true;
    });
    function markable(words, changed) {
      return words.map(function (w, i) {
        return { start: w.start, end: w.end, text: w.text, changed: changed[i] && !isWhitespaceWord(w.text) };
      });
    }
    return {
      mode: "word", reason: null, refsChanged: refsChanged,
      oldRanges: mergeChangedRanges(markable(oldWords, oldChanged)),
      newRanges: mergeChangedRanges(markable(newWords, newChanged))
    };
  }

  // ===================================================================
  // entry point
  // ===================================================================
  // oldHtml: the baseline snapshot, as a raw HTML string (state.baseline.
  // content — same field markdown's diff reads, since /baseline is kind-
  // agnostic; see dr_routes_post.py/dr_routes_get.py). Parsed here via
  // DOMParser — a detached document, never attached to any window, so nothing
  // in it ever runs script or fetches a subresource.
  // newRoot: a LIVE element already on screen — the iframe's own
  // doc.body (comment.02-render.js's onFrameLoad) — not a second parsed
  // copy. Every "newNode" this produces is therefore something Phase 4 can
  // annotate directly, with no separate step to resolve it back to what's
  // actually rendered.
  function diffHtmlDom(oldHtml, newRoot) {
    if (!newRoot || newRoot.nodeType !== 1) {
      throw new Error("diffHtmlDom: newRoot must be a live element (e.g. the iframe's <body>)");
    }
    var oldDoc = new DOMParser().parseFromString(oldHtml || "", "text/html");
    var oldRoot = oldDoc.body;
    if (!oldRoot) {
      throw new Error("diffHtmlDom: baseline HTML has no <body> to compare");
    }
    return { ops: diffElementChildren(oldRoot, newRoot, 0) };
  }

  // ===================================================================
  // apply (Phase 4) — paints diffHtmlDom's ops onto the live DOM they
  // already reference. Nothing here recomputes anything; it only reads the
  // op tree and mutates newNode/oldNode's positions and classes.
  // ===================================================================
  // Unlike markdown's diff view (comment.09-diffview.js), which throws away
  // #rd-content and rebuilds it from scratch, HTML mode has nothing to
  // rebuild FROM — the live tree IS the target's own rendering, faithfully
  // shown. So instead of building a parallel colored copy, this overlays
  // directly onto what's already there: an "insert" just gets a color class
  // (the element is already correctly in place); a "delete" clones the old
  // element into the live tree at the position it used to occupy, tinted
  // red and inert (pointer-events:none — frame-overlay.css — since it's a
  // clone of removed content, not a live part of the page: clicking a
  // ghost <a href> would navigate the iframe to a link that, as far as the
  // current document is concerned, doesn't exist anymore).
  function applyDiffOps(ops, liveParent) {
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.op === "equal") continue;
      if (op.op === "insert") { op.newNode.classList.add("rd-diff-add"); continue; }
      if (op.op === "delete") { insertGhost(liveParent, op.oldNode, nextNewNode(ops, i + 1)); continue; }
      // replace
      if (op.mode === "recurse") { applyDiffOps(op.children, op.newNode); continue; }
      // leaf ("word" or "whole"). A <td>/<th> is a special case: siblings
      // within a <tr> are load-bearing (the row's own cell COUNT), so an
      // extra sibling ghost cell the way every other leaf gets one would
      // desync every cell after it from its column — same reason markdown's
      // own diff (comment.09-diffview.js's appendChangedRowCells) stacks a
      // changed cell's old/new content INSIDE that one <td>, not as two
      // cells. Everything else (p, li, h1-h6, ...) has no such constraint,
      // so old (red, cloned) goes immediately before the live new element
      // (green) — the same old-then-new stacking markdown's diff view uses
      // for a changed block or list item.
      if (op.newNode.tagName === "TD" || op.newNode.tagName === "TH") {
        applyCellReplace(op);
        continue;
      }
      var ghost = insertGhost(liveParent, op.oldNode, op.newNode);
      op.newNode.classList.add("rd-diff-add");
      if (op.mode === "word") {
        applyWordSpans(ghost, op.oldRanges, "del");
        applyWordSpans(op.newNode, op.newRanges, "ins");
      }
      // op.mode === "whole": both sides stay plainly colored, no <del>/<ins> —
      // analyzeWordDiff already decided word-highlighting wouldn't be
      // readable here (comment.08-diff.js's WORD_PRODUCT_LIMIT/
      // CHANGE_RATIO_LIMIT), same call a changed markdown block makes.
    }
  }
  // Stacks a changed cell's old (red) content above its new (green) content
  // INSIDE the one live <td>/<th> — mirrors comment.09-diffview.js's
  // .rd-diff-cell-old/.rd-diff-cell-new spans exactly (frame-overlay.css
  // styles them the same way: display:block, so they stack). Moves the
  // live children into the new span (not a clone — this IS the live cell)
  // and the cloned old node's children into the old span; word ranges from
  // wordDiffForElementPair were computed against each side's own original
  // child layout, which this preserves (only the children moved, not their
  // relative order/content), so the offsets stay valid.
  function applyCellReplace(op) {
    var td = op.newNode;
    var doc = td.ownerDocument;
    td.classList.add("rd-diff-cell-changed");
    var newSpan = doc.createElement("span");
    newSpan.className = "rd-diff-cell-new";
    while (td.firstChild) newSpan.appendChild(td.firstChild);
    var oldSpan = doc.createElement("span");
    oldSpan.className = "rd-diff-cell-old";
    var oldClone = doc.importNode(op.oldNode, true);
    while (oldClone.firstChild) oldSpan.appendChild(oldClone.firstChild);
    td.appendChild(oldSpan);
    td.appendChild(newSpan);
    if (op.mode === "word") {
      applyWordSpans(oldSpan, op.oldRanges, "del");
      applyWordSpans(newSpan, op.newRanges, "ins");
    }
  }
  // First op at/after `fromIndex` that has a live newNode — a run of
  // trailing deletes has nothing after it, so `insertGhost` falls back to
  // appendChild in that case (see below).
  function nextNewNode(ops, fromIndex) {
    for (var i = fromIndex; i < ops.length; i++) {
      if (ops[i].newNode) return ops[i].newNode;
    }
    return null;
  }
  // importNode (not appendChild) because oldNode belongs to a different
  // document — diffHtmlDom's detached DOMParser parse for a plain "delete",
  // or (for a "replace") whichever document ITS oldNode's ancestor chain
  // ultimately traces back to, which is the same detached parse either way
  // (recurse never crosses documents — see diffElementChildren).
  function insertGhost(liveParent, oldNode, beforeNode) {
    var ghost = liveParent.ownerDocument.importNode(oldNode, true);
    ghost.classList.add("rd-diff-del");
    ghost.setAttribute("data-rd-diff-ghost", "1");
    if (beforeNode && beforeNode.parentNode === liveParent) liveParent.insertBefore(ghost, beforeNode);
    else liveParent.appendChild(ghost);
    return ghost;
  }

  // Entry point comment.09-diffview.js's toggleDiffMode() calls for HTML
  // targets. Computes the WHOLE diff first — diffHtmlDom throws on bad
  // input rather than returning something empty-looking (its own doc
  // comment) — and only starts touching the live DOM once that succeeds, so
  // a failed compute can never leave a half-annotated preview behind; the
  // caller's try/catch is what keeps state.diffMode itself off in that case.
  // clearMarkers()/clearHover() first: comment markers/hover state from
  // BEFORE the toggle would otherwise still be sitting in the tree — markdown's
  // equivalent gets this for free by wiping #rd-content and rebuilding, which
  // isn't an option here (see applyDiffOps' doc comment).
  function renderHtmlDiff(newRoot) {
    // Idempotency guard: applyDiffOps mutates newRoot in place (ghost
    // elements inserted, color classes added), so a second call against a
    // tree it already painted would double them up rather than redraw
    // cleanly — unlike markdown's renderDiffView, which always starts from
    // a wipe (elContent.innerHTML = ""). Checked on the DOM itself, not
    // state.diffMode, so this holds regardless of what left it painted
    // (only loadFrame() — a real navigation — ever produces a tree without
    // these markers again).
    if (newRoot.querySelector("[data-rd-diff-ghost], .rd-diff-add, .rd-diff-del")) return;
    var oldHtml = (state.baseline && state.baseline.content) || "";
    var result = diffHtmlDom(oldHtml, newRoot);
    clearMarkers();
    clearHover();
    applyDiffOps(result.ops, newRoot);
  }
