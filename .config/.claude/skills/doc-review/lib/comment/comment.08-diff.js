"use strict";

/* doc-review — diff-mode calculation (pure).
 *
 * Everything in this file is a self-contained function: no reads or writes
 * of the app's shared `state`, no touching `elContent`/`docEnv`, and no
 * `data-srcblock` / `state.blockRaws` bookkeeping (that mapping belongs to
 * the marker system alone — see comment.05-markers.js). Given the same
 * inputs these functions always produce the same outputs.
 *
 * The one nuance: wordDiffForBlockPair() DOES create DOM nodes (it renders
 * each block via marked.parser into a detached <div> so it can diff actual
 * rendered text rather than raw markdown, then wraps the changed spans in
 * <del>/<ins>). That DOM is entirely private to the call — a fresh element
 * the function builds and returns, never anything already attached to the
 * page. Rendering (comment.09-diffview.js) decides what to do with it.
 *
 * Public surface used by comment.09-diffview.js:
 *   diffTopLevelBlocks(oldMd, newMd) -> { ops, oldLinks, newLinks }
 *   blockDiffStrategy(oldTok, newTok) -> {mode:"line"|"table-rows"|"list-items", reason?} | null
 *   wordDiffForBlockPair(oldTok, newTok, oldLinks, newLinks) -> {mode, reason, oldEl, newEl, refsChanged}
 *   wordDiffForCellPair(oldCell, newCell, oldLinks, newLinks) -> same shape, for one table cell
 *   diffTableRows(oldTok, newTok) -> [{op, oldIndex?, newIndex?}, ...] | null
 *   diffListItems(oldTok, newTok) -> [{op, oldItem?, newItem?}, ...]
 *   diffLines(oldRaw, newRaw) -> [{op:"equal"|"delete"|"insert", text} | {op:"replace", oldText, newText}, ...]
 *   wordDiffForLinePair(oldText, newText) -> {oldRanges, newRanges} | null   (word-highlight within one paired line)
 */

  // ===================================================================
  // generic LCS diff (array of comparable items -> equal/delete/insert/replace opcodes)
  // ===================================================================
  // Same shape as Python difflib's get_opcodes(): a list of
  // {op, a0,a1, b0,b1} covering the whole of `a` and `b` in order. Trims the
  // common prefix/suffix first so the O(m*n) table only covers the part that
  // actually differs — a single-paragraph edit in a long document ends up
  // near-linear instead of scanning the whole document.
  function lcsOpcodes(a, b, equalFn) {
    equalFn = equalFn || function (x, y) { return x === y; };
    var aStart = 0, aEnd = a.length, bStart = 0, bEnd = b.length;
    while (aStart < aEnd && bStart < bEnd && equalFn(a[aStart], b[bStart])) { aStart++; bStart++; }
    while (aEnd > aStart && bEnd > bStart && equalFn(a[aEnd - 1], b[bEnd - 1])) { aEnd--; bEnd--; }

    var ops = [];
    if (aStart > 0 || bStart > 0) ops.push({ op: "equal", a0: 0, a1: aStart, b0: 0, b1: bStart });

    var m = aEnd - aStart, n = bEnd - bStart;
    if (m > 0 && n > 0) {
      var stride = n + 1;
      var table = new Int32Array((m + 1) * stride);
      for (var i = m - 1; i >= 0; i--) {
        for (var j = n - 1; j >= 0; j--) {
          table[i * stride + j] = equalFn(a[aStart + i], b[bStart + j])
            ? table[(i + 1) * stride + (j + 1)] + 1
            : Math.max(table[(i + 1) * stride + j], table[i * stride + (j + 1)]);
        }
      }
      // Backtrack into a flat equal/delete/insert tape, then coalesce runs.
      var tape = [];
      var i2 = 0, j2 = 0;
      while (i2 < m && j2 < n) {
        if (equalFn(a[aStart + i2], b[bStart + j2])) { tape.push("equal"); i2++; j2++; }
        else if (table[(i2 + 1) * stride + j2] >= table[i2 * stride + (j2 + 1)]) { tape.push("delete"); i2++; }
        else { tape.push("insert"); j2++; }
      }
      while (i2 < m) { tape.push("delete"); i2++; }
      while (j2 < n) { tape.push("insert"); j2++; }

      var ai = aStart, bi = bStart, k = 0;
      while (k < tape.length) {
        if (tape[k] === "equal") {
          var a0 = ai, b0 = bi;
          while (k < tape.length && tape[k] === "equal") { ai++; bi++; k++; }
          ops.push({ op: "equal", a0: a0, a1: ai, b0: b0, b1: bi });
        } else {
          var da0 = ai, db0 = bi, delCount = 0, insCount = 0;
          while (k < tape.length && tape[k] !== "equal") {
            if (tape[k] === "delete") { ai++; delCount++; } else { bi++; insCount++; }
            k++;
          }
          var op = delCount && insCount ? "replace" : (delCount ? "delete" : "insert");
          ops.push({ op: op, a0: da0, a1: ai, b0: db0, b1: bi });
        }
      }
    } else if (m > 0) {
      ops.push({ op: "delete", a0: aStart, a1: aEnd, b0: bStart, b1: bStart });
    } else if (n > 0) {
      ops.push({ op: "insert", a0: aStart, a1: aStart, b0: bStart, b1: bEnd });
    }

    if (aEnd < a.length || bEnd < b.length) ops.push({ op: "equal", a0: aEnd, a1: a.length, b0: bEnd, b1: b.length });
    return ops;
  }

  // ===================================================================
  // character-bigram Dice coefficient (replace-block pairing score)
  // ===================================================================
  function bigramCounts(s) {
    var counts = Object.create(null);
    for (var i = 0; i < s.length - 1; i++) {
      var g = s.substr(i, 2);
      counts[g] = (counts[g] || 0) + 1;
    }
    return counts;
  }
  function diceCoefficient(s1, s2) {
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;
    if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;
    var b1 = bigramCounts(s1), b2 = bigramCounts(s2);
    var total = 0, match = 0;
    Object.keys(b1).forEach(function (g) { total += b1[g]; });
    Object.keys(b2).forEach(function (g) { total += b2[g]; });
    Object.keys(b1).forEach(function (g) { if (b2[g]) match += Math.min(b1[g], b2[g]); });
    return total === 0 ? 0 : (2 * match) / total;
  }

  // ===================================================================
  // top-level block extraction (mirrors renderMarkdown's block splitting,
  // but produces plain data — no DOM, no state.blockRaws)
  // ===================================================================
  // FRONTMATTER_RE is defined in comment.02-render.js — same regex, so
  // "does this doc have front matter" can never disagree between the normal
  // renderer and the diff view.
  function topLevelBlocks(md) {
    var blocks = [];
    var rest = md || "";
    var fmMatch = FRONTMATTER_RE.exec(rest);
    if (fmMatch) {
      blocks.push({ type: "frontmatter", raw: fmMatch[0] });
      rest = rest.slice(fmMatch[0].length);
    }
    var lexed = marked.lexer(rest);
    var links = lexed.links || {};
    lexed.forEach(function (tok) {
      if (tok.type === "space" || tok.type === "def") return;   // renderMarkdown skips these too
      blocks.push(tok);
    });
    return { blocks: blocks, links: links };
  }

  function isLineModeBlock(tok) {
    // Fenced/indented code and front matter read as a literal block, not
    // prose — word-level diffing them would chop syntax mid-token, so they
    // always get the line-based view (same technique diffLines() gives
    // Phase 5 for table rows / list items).
    return tok.type === "code" || tok.type === "frontmatter";
  }

  // Blocks are compatible for 1:1 pairing inside a replace region only when
  // they're the same kind of thing — a heading rewritten into a table is a
  // deletion + an addition, never a "changed" heading.
  function typeCompatible(a, b) { return a.type === b.type; }

  var PAIR_DICE_THRESHOLD = 0.5;

  // Generic greedy, order-preserving best-score-first pairing over the index
  // ranges [0,n) x [0,m). Shared by every granularity that needs "these got
  // rewritten, not reordered" alignment: top-level blocks (pairReplaceBlocks),
  // table rows and list items (diffTableRows / diffListItems below). scoreFn
  // returning anything below `threshold` (including a negative sentinel, e.g.
  // an incompatible type) excludes that pair from consideration.
  function greedyPair(n, m, scoreFn, threshold) {
    var candidates = [];
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < m; b++) {
        var score = scoreFn(a, b);
        if (score >= threshold) candidates.push({ a: a, b: b, score: score });
      }
    }
    candidates.sort(function (x, y) { return y.score - x.score; });
    var usedA = {}, usedB = {}, pairs = [];
    candidates.forEach(function (c) {
      if (usedA[c.a] || usedB[c.b]) return;
      // Reject pairs that would cross an already-accepted pair (keep both
      // sequences' relative order — this aligns rewrites, not reorders).
      var crosses = pairs.some(function (p) { return (p.a - c.a) * (p.b - c.b) < 0; });
      if (crosses) return;
      usedA[c.a] = true; usedB[c.b] = true;
      pairs.push(c);
    });
    pairs.sort(function (x, y) { return x.a - y.a; });
    return pairs;   // [{a, b, score}], old-index order
  }

  function pairReplaceBlocks(oldBlocks, newBlocks) {
    return greedyPair(oldBlocks.length, newBlocks.length, function (a, b) {
      if (!typeCompatible(oldBlocks[a], newBlocks[b])) return -1;
      return diceCoefficient(normRaw(oldBlocks[a].raw), normRaw(newBlocks[b].raw));
    }, PAIR_DICE_THRESHOLD);
  }

  // Walks [0,oldLen) and [0,newLen) together, using `pairs` (greedyPair's
  // output — order-preserving, sorted by `a`) as anchor points, and calls
  // back in the ONE ordering that matches both sides' real document order.
  //
  // Naively emitting "every unpaired old index, then every unpaired new
  // index" (this function's predecessor) is wrong the moment a replace
  // region has more than one pair candidate: an unpaired new block that
  // actually sits BEFORE a paired block would render AFTER it instead,
  // reading as if content had moved. Emitting old-only and new-only blocks
  // in the gaps between pairs — in the position they actually occupy — is
  // what keeps a diff readable as "this stayed put, this didn't."
  function mergeAligned(oldLen, newLen, pairs, emitDelete, emitInsert, emitReplace) {
    var oi = 0, ni = 0;
    pairs.forEach(function (p) {
      while (oi < p.a) { emitDelete(oi); oi++; }
      while (ni < p.b) { emitInsert(ni); ni++; }
      emitReplace(p.a, p.b);
      oi = p.a + 1; ni = p.b + 1;
    });
    while (oi < oldLen) { emitDelete(oi); oi++; }
    while (ni < newLen) { emitInsert(ni); ni++; }
  }

  // ===================================================================
  // top-level block diff: the whole document, as one ordered list of ops
  // ===================================================================
  // Each item is {op:"equal"|"insert"|"delete"|"replace", oldBlock?, newBlock?}.
  // "replace" already carries its paired old/new block (see pairReplaceBlocks);
  // anything left unpaired inside a replace region comes out as its own
  // plain delete/insert instead.
  function diffTopLevelBlocks(oldMd, newMd) {
    var oldParsed = topLevelBlocks(oldMd);
    var newParsed = topLevelBlocks(newMd);
    var oldRaws = oldParsed.blocks.map(function (b) { return normRaw(b.raw); });
    var newRaws = newParsed.blocks.map(function (b) { return normRaw(b.raw); });
    var opcodes = lcsOpcodes(oldRaws, newRaws);

    var ops = [];
    opcodes.forEach(function (oc) {
      if (oc.op === "equal") {
        for (var k = 0; k < oc.a1 - oc.a0; k++) {
          ops.push({ op: "equal", oldBlock: oldParsed.blocks[oc.a0 + k], newBlock: newParsed.blocks[oc.b0 + k] });
        }
      } else if (oc.op === "delete") {
        for (var di = oc.a0; di < oc.a1; di++) ops.push({ op: "delete", oldBlock: oldParsed.blocks[di] });
      } else if (oc.op === "insert") {
        for (var ii = oc.b0; ii < oc.b1; ii++) ops.push({ op: "insert", newBlock: newParsed.blocks[ii] });
      } else {
        var oldSlice = oldParsed.blocks.slice(oc.a0, oc.a1);
        var newSlice = newParsed.blocks.slice(oc.b0, oc.b1);
        var pairs = pairReplaceBlocks(oldSlice, newSlice);
        mergeAligned(oldSlice.length, newSlice.length, pairs,
          function (oi) { ops.push({ op: "delete", oldBlock: oldSlice[oi] }); },
          function (ni) { ops.push({ op: "insert", newBlock: newSlice[ni] }); },
          function (oi, ni) { ops.push({ op: "replace", oldBlock: oldSlice[oi], newBlock: newSlice[ni] }); });
      }
    });
    return { ops: ops, oldLinks: oldParsed.links, newLinks: newParsed.links };
  }

  // A "replace" pair known to need the line-based view before any DOM work
  // happens (code/frontmatter). Returns null when the pair should go through
  // wordDiffForBlockPair instead (which may itself still fall back to
  // "whole" — see analyzeWordDiff below).
  function blockDiffStrategy(oldTok, newTok) {
    var oldIsLine = isLineModeBlock(oldTok), newIsLine = isLineModeBlock(newTok);
    if (oldIsLine || newIsLine) {
      return { mode: "line", reason: (oldIsLine && newIsLine) ? "code-or-frontmatter" : "type-mismatch" };
    }
    // pairReplaceBlocks only ever pairs same-type tokens (typeCompatible), so
    // reaching here with both "table" or both "list" means the pair really
    // is the same table/list, rewritten — row/item-level diffing applies.
    if (oldTok.type === "table" && newTok.type === "table") return { mode: "table-rows" };
    if (oldTok.type === "list" && newTok.type === "list") return { mode: "list-items" };
    return null;
  }

  // ===================================================================
  // table row diff (Phase 5): rows aligned like top-level blocks, keyed on
  // each row's raw source line (tableRawLines — comment.02-render.js, pure).
  // ===================================================================
  // Returns null when the raw text couldn't be split into exactly
  // "2 + rowCount" lines (same defensive check renderTableBlock uses) — the
  // caller falls back to whole-block replace rather than mis-key a row.
  function diffTableRows(oldTok, newTok) {
    var oldLines = tableRawLines(oldTok.raw, oldTok.rows.length);
    var newLines = tableRawLines(newTok.raw, newTok.rows.length);
    if (!oldLines || !newLines) return null;
    var oldBody = oldLines.slice(2), newBody = newLines.slice(2);
    var opcodes = lcsOpcodes(oldBody.map(normRaw), newBody.map(normRaw));

    var rowOps = [];
    opcodes.forEach(function (oc) {
      if (oc.op === "equal") {
        for (var k = 0; k < oc.a1 - oc.a0; k++) rowOps.push({ op: "equal", oldIndex: oc.a0 + k, newIndex: oc.b0 + k });
      } else if (oc.op === "delete") {
        for (var di = oc.a0; di < oc.a1; di++) rowOps.push({ op: "delete", oldIndex: di });
      } else if (oc.op === "insert") {
        for (var ii = oc.b0; ii < oc.b1; ii++) rowOps.push({ op: "insert", newIndex: ii });
      } else {
        var oldSlice = oldBody.slice(oc.a0, oc.a1), newSlice = newBody.slice(oc.b0, oc.b1);
        var pairs = greedyPair(oldSlice.length, newSlice.length, function (a, b) {
          return diceCoefficient(normRaw(oldSlice[a]), normRaw(newSlice[b]));
        }, PAIR_DICE_THRESHOLD);
        mergeAligned(oldSlice.length, newSlice.length, pairs,
          function (oi) { rowOps.push({ op: "delete", oldIndex: oc.a0 + oi }); },
          function (ni) { rowOps.push({ op: "insert", newIndex: oc.b0 + ni }); },
          function (oi, ni) { rowOps.push({ op: "replace", oldIndex: oc.a0 + oi, newIndex: oc.b0 + ni }); });
      }
    });
    return rowOps;
  }

  // ===================================================================
  // list item diff (Phase 5): top-level items only. A nested sub-list lives
  // entirely inside its parent item's own `raw` (see collectListItemRaws'
  // doc comment in comment.02-render.js), so aligning just tok.items keeps
  // each item's nested content intact without needing a recursive tree diff.
  // ===================================================================
  function diffListItems(oldTok, newTok) {
    var oldItems = oldTok.items || [], newItems = newTok.items || [];
    var oldRaws = oldItems.map(function (it) { return normRaw(it.raw || ""); });
    var newRaws = newItems.map(function (it) { return normRaw(it.raw || ""); });
    var opcodes = lcsOpcodes(oldRaws, newRaws);

    var itemOps = [];
    opcodes.forEach(function (oc) {
      if (oc.op === "equal") {
        for (var k = 0; k < oc.a1 - oc.a0; k++) itemOps.push({ op: "equal", oldItem: oldItems[oc.a0 + k], newItem: newItems[oc.b0 + k] });
      } else if (oc.op === "delete") {
        for (var di = oc.a0; di < oc.a1; di++) itemOps.push({ op: "delete", oldItem: oldItems[di] });
      } else if (oc.op === "insert") {
        for (var ii = oc.b0; ii < oc.b1; ii++) itemOps.push({ op: "insert", newItem: newItems[ii] });
      } else {
        var oldSlice = oldItems.slice(oc.a0, oc.a1), newSlice = newItems.slice(oc.b0, oc.b1);
        var pairs = greedyPair(oldSlice.length, newSlice.length, function (a, b) {
          return diceCoefficient(normRaw(oldSlice[a].raw), normRaw(newSlice[b].raw));
        }, PAIR_DICE_THRESHOLD);
        mergeAligned(oldSlice.length, newSlice.length, pairs,
          function (oi) { itemOps.push({ op: "delete", oldItem: oldSlice[oi] }); },
          function (ni) { itemOps.push({ op: "insert", newItem: newSlice[ni] }); },
          function (oi, ni) { itemOps.push({ op: "replace", oldItem: oldSlice[oi], newItem: newSlice[ni] }); });
      }
    });
    return itemOps;
  }

  // ===================================================================
  // line-level diff (code blocks, front matter; reused by Phase 5 for
  // table rows / list items — same "just line up N strings" shape)
  // ===================================================================
  // A "replace" op carries oldText/newText for a line pair similar enough to
  // treat as "this line was edited" (see wordDiffForLinePair, which the
  // renderer calls to highlight exactly what changed within it); a line with
  // no similar counterpart on the other side stays a plain delete/insert.
  function diffLines(oldRaw, newRaw) {
    var oldLines = (oldRaw || "").replace(/\r\n/g, "\n").split("\n");
    var newLines = (newRaw || "").replace(/\r\n/g, "\n").split("\n");
    var opcodes = lcsOpcodes(oldLines, newLines);
    var out = [];
    opcodes.forEach(function (oc) {
      if (oc.op === "equal") {
        for (var i = oc.a0; i < oc.a1; i++) out.push({ op: "equal", text: oldLines[i] });
      } else if (oc.op === "delete") {
        for (var di = oc.a0; di < oc.a1; di++) out.push({ op: "delete", text: oldLines[di] });
      } else if (oc.op === "insert") {
        for (var ii = oc.b0; ii < oc.b1; ii++) out.push({ op: "insert", text: newLines[ii] });
      } else {
        var oldSlice = oldLines.slice(oc.a0, oc.a1), newSlice = newLines.slice(oc.b0, oc.b1);
        var pairs = greedyPair(oldSlice.length, newSlice.length, function (a, b) {
          return diceCoefficient(normRaw(oldSlice[a]), normRaw(newSlice[b]));
        }, PAIR_DICE_THRESHOLD);
        mergeAligned(oldSlice.length, newSlice.length, pairs,
          function (oi) { out.push({ op: "delete", text: oldSlice[oi] }); },
          function (ni) { out.push({ op: "insert", text: newSlice[ni] }); },
          function (oi, ni) { out.push({ op: "replace", oldText: oldSlice[oi], newText: newSlice[ni] }); });
      }
    });
    return out;
  }

  // Word-diffs a paired "replace" line's plain text (a source line, not
  // markdown — no HTML structure to preserve, so this works directly on the
  // two strings rather than going through wordDiffForBlockPair's detached-
  // render dance). Reuses the exact same word-splitting/LCS/change-ratio
  // machinery as a changed paragraph, just without any DOM. Returns null
  // when analyzeWordDiff decides "whole" (too different, too long, or no
  // significant text) — the caller falls back to plain whole-line color,
  // same decision a changed block makes.
  function wordDiffForLinePair(oldText, newText) {
    var oldWords = wordSpans(oldText), newWords = wordSpans(newText);
    var oldTexts = oldWords.map(function (w) { return w.text; });
    var newTexts = newWords.map(function (w) { return w.text; });
    var decision = analyzeWordDiff(oldTexts, newTexts);
    if (decision.mode !== "word") return null;

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
      oldRanges: mergeChangedRanges(markable(oldWords, oldChanged)),
      newRanges: mergeChangedRanges(markable(newWords, newChanged))
    };
  }

  // ===================================================================
  // word-level diff for one paired (replace) block
  // ===================================================================
  // Word splitting: Latin/digit/identifier runs and katakana runs count as
  // one word each (their internal boundaries are reliable); kanji/hiragana/
  // other characters have no reliable dictionary-free boundary, so each one
  // is its own word (matches how GitHub's diff reads for CJK text — no
  // mis-segmentation is possible because there is no segmentation to get
  // wrong). Whitespace runs are their own tokens so they can participate in
  // alignment without ever being wrapped in <del>/<ins> themselves.
  var WORD_RE = /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*|[ァ-ヺー]+|\s+|[\s\S]/g;
  function isWhitespaceWord(w) { return /^\s+$/.test(w); }
  function wordSpans(text) {
    var spans = [];
    var re = new RegExp(WORD_RE.source, "g");
    var m;
    while ((m = re.exec(text)) !== null) {
      spans.push({ text: m[0], start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;   // guard: WORD_RE can't actually match empty, but stay safe
    }
    return spans;
  }

  var WORD_PRODUCT_LIMIT = 250000;   // above this, word-level LCS is skipped outright (whole-block color instead)
  var CHANGE_RATIO_LIMIT = 0.7;      // above this fraction changed, word highlighting stops being readable

  // Decides word vs. whole BEFORE building DOM (cheap length check) and
  // AFTER running the word LCS (change-ratio check), reusing that LCS result
  // either way so the caller never recomputes it.
  function analyzeWordDiff(oldTexts, newTexts) {
    if (oldTexts.length * newTexts.length > WORD_PRODUCT_LIMIT) {
      return { mode: "whole", reason: "too-many-words", ops: null };
    }
    var oldSignificant = oldTexts.filter(function (w) { return !isWhitespaceWord(w); }).length;
    var newSignificant = newTexts.filter(function (w) { return !isWhitespaceWord(w); }).length;
    if (oldSignificant === 0 && newSignificant === 0) {
      return { mode: "whole", reason: "no-text", ops: null };
    }
    var ops = lcsOpcodes(oldTexts, newTexts);
    var changed = 0, total = 0;
    ops.forEach(function (oc) {
      if (oc.op === "equal") {
        for (var i = oc.a0; i < oc.a1; i++) if (!isWhitespaceWord(oldTexts[i])) total++;
        return;
      }
      for (var ai = oc.a0; ai < oc.a1; ai++) if (!isWhitespaceWord(oldTexts[ai])) { changed++; total++; }
      for (var bi = oc.b0; bi < oc.b1; bi++) if (!isWhitespaceWord(newTexts[bi])) { changed++; total++; }
    });
    if (total === 0) return { mode: "whole", reason: "no-text", ops: ops };
    if (changed / total > CHANGE_RATIO_LIMIT) return { mode: "whole", reason: "change-ratio-too-high", ops: ops };
    return { mode: "word", reason: null, ops: ops };
  }

  // Renders one token into a detached container the same way renderMarkdown
  // does for the live document (single-token marked.parser call), except
  // this element is never attached anywhere — it belongs entirely to the
  // caller of wordDiffForBlockPair.
  function renderTokenToDetached(tok, links) {
    var container = document.createElement("div");
    var toks = [tok];
    toks.links = links || {};
    container.innerHTML = marked.parser(toks);
    return container;
  }

  // Collects text nodes under `root` in document order (skipping anything
  // inside a <pre>, which never reaches here anyway since code/frontmatter
  // blocks are routed to diffLines instead — kept as a defensive boundary
  // in case a block embeds a <pre> some other way, e.g. raw HTML).
  // `root.ownerDocument` (not the bare `document`) so this also works when
  // `root` lives inside the HTML preview's iframe (comment.10-htmldiff.js) —
  // markdown's `root` is always in the parent document, so `|| document`
  // (root with no owner, e.g. a Document node itself) is the only case that
  // ever falls back, and md's own behaviour there is unchanged either way.
  function collectTextRuns(root) {
    var walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return (n.parentElement && n.parentElement.closest("pre"))
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [], text = "", n;
    while ((n = walker.nextNode()) !== null) {
      nodes.push({ node: n, start: text.length, end: text.length + n.nodeValue.length });
      text += n.nodeValue;
    }
    return { nodes: nodes, text: text };
  }

  // Splits `node` twice (end boundary first, then start) and wraps exactly
  // the [localStart, localEnd) slice in a new `tagName` element. Standard
  // "split twice, wrap the middle" — never touches Range/surroundContents,
  // which throws once a range crosses an element boundary.
  function wrapRangeInNode(node, localStart, localEnd, tagName) {
    var target = node;
    if (localEnd < target.nodeValue.length) target.splitText(localEnd);
    if (localStart > 0) target = target.splitText(localStart);
    // target.ownerDocument, not the bare `document` — see collectTextRuns.
    var wrapper = (target.ownerDocument || document).createElement(tagName);
    target.parentNode.insertBefore(wrapper, target);
    wrapper.appendChild(target);
    return wrapper;
  }

  // Re-collects text runs before every range (cheap: these are single
  // rendered blocks, not the whole document) instead of reusing one stale
  // snapshot — wrapping a text node in <del>/<ins> only adds an ancestor
  // element, it never changes the concatenated text or its order, so the
  // absolute offsets `ranges` were computed against stay valid across every
  // wrap. This sidesteps needing to reason about split() shifting later
  // nodes' identities.
  function applyWordSpans(root, ranges, tagName) {
    ranges.slice().sort(function (a, b) { return b.start - a.start; }).forEach(function (range) {
      var collected = collectTextRuns(root);
      collected.nodes.forEach(function (entry) {
        var s = Math.max(range.start, entry.start);
        var e = Math.min(range.end, entry.end);
        if (e <= s) return;
        wrapRangeInNode(entry.node, s - entry.start, e - entry.start, tagName);
      });
    });
  }

  // Merges adjacent changed word-spans into wrap ranges, bridging a single
  // unchanged whitespace-only word between two changed words so "changed
  // phrase" reads as one continuous highlight instead of two with a gap.
  function mergeChangedRanges(items) {
    var ranges = [], i = 0;
    while (i < items.length) {
      if (!items[i].changed) { i++; continue; }
      var j = i, end = items[i].end;
      while (j + 1 < items.length) {
        var next = items[j + 1];
        if (next.changed) { end = next.end; j++; continue; }
        if (isWhitespaceWord(next.text) && j + 2 < items.length && items[j + 2].changed) {
          end = items[j + 2].end; j += 2; continue;
        }
        break;
      }
      ranges.push({ start: items[i].start, end: end });
      i = j + 1;
    }
    return ranges;
  }

  // img[src] / a[href] targets touched by a block — compared separately from
  // word text because "the picture changed" or "the link target changed"
  // can be true even when the visible words are identical.
  function refSet(root) {
    var out = [];
    Array.prototype.forEach.call(root.querySelectorAll("img[src], a[href]"), function (el) {
      var ref = el.tagName === "IMG" ? el.getAttribute("src") : el.getAttribute("href");
      out.push(el.tagName + ":" + (ref || ""));
    });
    return out.sort().join("\n");
  }

  // Orchestrates one replace-pair's word diff end to end. Returns:
  //   {mode:"word", oldEl, newEl, refsChanged}   — oldEl/newEl carry <del>/<ins>
  //   {mode:"whole", reason, oldEl, newEl, refsChanged} — caller colors the whole block instead
  // oldEl/newEl are always returned (even in "whole" mode) so the caller
  // never has to re-render the token itself.
  function wordDiffForBlockPair(oldTok, newTok, oldLinks, newLinks) {
    var oldEl = renderTokenToDetached(oldTok, oldLinks);
    var newEl = renderTokenToDetached(newTok, newLinks);
    var refsChanged = refSet(oldEl) !== refSet(newEl);

    var oldRuns = collectTextRuns(oldEl), newRuns = collectTextRuns(newEl);
    var oldWords = wordSpans(oldRuns.text), newWords = wordSpans(newRuns.text);
    var oldTexts = oldWords.map(function (w) { return w.text; });
    var newTexts = newWords.map(function (w) { return w.text; });

    var decision = analyzeWordDiff(oldTexts, newTexts);
    if (decision.mode !== "word") {
      return { mode: "whole", reason: decision.reason, oldEl: oldEl, newEl: newEl, refsChanged: refsChanged };
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
    applyWordSpans(oldEl, mergeChangedRanges(markable(oldWords, oldChanged)), "del");
    applyWordSpans(newEl, mergeChangedRanges(markable(newWords, newChanged)), "ins");
    return { mode: "word", reason: null, oldEl: oldEl, newEl: newEl, refsChanged: refsChanged };
  }

  // Removes the <p> marked.parser wraps single-token output in and hoists its
  // children up to `container`, in place. A table cell's content is inline
  // (GFM cells can't contain a paragraph of their own), so the <p> a
  // paragraph-shaped token forces on us is packaging, not part of the cell.
  function unwrapParagraph(container) {
    var p = container.querySelector("p");
    if (!p) return container;   // empty cell: nothing to unwrap
    // Insert each child right where <p> currently sits (not via appendChild,
    // which would land them AFTER the trailing "\n" text node marked.parser
    // leaves behind from "<p>...</p>\n" — that stray text node is still a
    // sibling of <p> inside `container` at this point).
    while (p.firstChild) container.insertBefore(p.firstChild, p);
    p.remove();
    // That trailing "\n" is now a bare whitespace-only text node with no
    // element left to explain it — cosmetic in rendered HTML (browsers
    // collapse it) but dropped here so a plain textContent read (e.g. the
    // cell-equality check in comment.09-diffview.js) sees only real content.
    Array.prototype.slice.call(container.childNodes).forEach(function (n) {
      if (n.nodeType === 3 && /^\s*$/.test(n.nodeValue)) container.removeChild(n);
    });
    return container;
  }

  // Compares two table cells' inline content the same way wordDiffForBlockPair
  // compares a block. marked has no public "render just these inline tokens"
  // entry point, so the cell's tokens are wrapped as a throwaway paragraph
  // token to reuse the exact same detached-render + text-node diff pipeline,
  // then unwrapped — see unwrapParagraph above.
  function wordDiffForCellPair(oldCell, newCell, oldLinks, newLinks) {
    var oldTok = { type: "paragraph", raw: "", text: oldCell.text || "", tokens: oldCell.tokens || [] };
    var newTok = { type: "paragraph", raw: "", text: newCell.text || "", tokens: newCell.tokens || [] };
    var result = wordDiffForBlockPair(oldTok, newTok, oldLinks, newLinks);
    result.oldEl = unwrapParagraph(result.oldEl);
    result.newEl = unwrapParagraph(result.newEl);
    return result;
  }
