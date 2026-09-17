"use strict";

/* doc-review — diff view (rendering + mode toggle).
 *
 * "Diff mode" replaces #rd-content's normal render with a colored comparison
 * of state.baseline.content (the file as of the most recent /threads/submit)
 * against state.meta.content (the current file). All the actual diffing is
 * comment.08-diff.js (pure); this file owns the DOM it produces and the mode
 * switch itself.
 *
 * Deliberately NOT done here (later phases):
 * - entering diff mode automatically when Claude's edit lands (Phase 4 wires
 *   that into comment.06-server.js's onRevBumped, which also has to decide
 *   whether to re-diff against a fresh baseline while already in diff mode)
 * - disabling hover/selection while in diff mode (Phase 4;
 *   comment.03-selection.js) and skipping marker placement (Phase 4;
 *   comment.05-markers.js) — until then hovering diff content simply finds
 *   no [data-srcblock] ancestor and highlights nothing, which is inert, not
 *   broken
 * - row/item-level table and list diffing (Phase 5) — for now a changed
 *   table or list is one whole colored block, same as any other block
 *
 * DOM refs are grabbed at top level (not inside comment.01-bootstrap.js's
 * start()) because #rd-diff-toggle/#rd-diff-note already exist in the parsed
 * HTML by the time this <script> runs (it loads after the topbar markup in
 * viewer.html) — no need to wait for DOMContentLoaded, and no need to touch
 * bootstrap.js for this feature.
 */

  var elDiffToggle = document.getElementById("rd-diff-toggle");
  var elDiffNote = document.getElementById("rd-diff-note");

  function diffAvailable() {
    return !isHtml() && !!(state.baseline && state.baseline.available);
  }

  // ts is dr_util._now()'s "YYYY-MM-DDTHH:MM:SS" — always the server's own
  // local clock (this tool never leaves 127.0.0.1), so no timezone math.
  function formatBaselineTs(ts) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(ts || "");
    return m ? (m[2] + "/" + m[3] + " " + m[4] + ":" + m[5]) : (ts || "");
  }

  function updateDiffToggleUI() {
    if (!elDiffToggle) return;
    if (isHtml()) {
      elDiffToggle.hidden = true;
      if (elDiffNote) elDiffNote.hidden = true;
      return;
    }
    elDiffToggle.hidden = false;
    var available = !!(state.baseline && state.baseline.available);
    elDiffToggle.disabled = !available;
    elDiffToggle.textContent = state.diffMode ? "プレビューに戻る" : "変更点を表示";
    elDiffToggle.title = available ? "" : "まだコメントを送信していません";
    if (elDiffNote) {
      elDiffNote.hidden = !(available && state.diffMode);
      if (available) elDiffNote.textContent = "直近の送信（" + formatBaselineTs(state.baseline.ts) + "）からの変更";
    }
  }

  function fetchBaseline() {
    return fetch("/baseline", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { state.baseline = d; updateDiffToggleUI(); })
      .catch(noop);
  }

  function toggleDiffMode() {
    if (state.diffMode) {
      state.diffMode = false;
      render();
      refreshView();
    } else {
      if (!diffAvailable()) return;
      state.diffMode = true;
      renderDiffView();
    }
    updateDiffToggleUI();
  }

  // ===================================================================
  // rendering
  // ===================================================================
  function renderDiffView() {
    elContent.innerHTML = "";
    var oldMd = (state.baseline && state.baseline.content) || "";
    var newMd = (state.meta && state.meta.content) || "";
    var diff = diffTopLevelBlocks(oldMd, newMd);
    var hasChange = diff.ops.some(function (op) { return op.op !== "equal"; });
    if (!hasChange) {
      elContent.appendChild(h("p", { "class": "rd-diff-empty", text: "直近の送信から変更はありません" }));
      return;
    }
    var scratch = document.createElement("div");
    diff.ops.forEach(function (op) {
      if (op.op === "equal") {
        buildBlockEls(op.newBlock, diff.newLinks, scratch).forEach(function (el) { elContent.appendChild(el); });
      } else if (op.op === "insert") {
        appendWholeDiffBlock(op.newBlock, diff.newLinks, scratch, "add");
      } else if (op.op === "delete") {
        appendWholeDiffBlock(op.oldBlock, diff.oldLinks, scratch, "del");
      } else {
        appendReplaceDiffBlock(op.oldBlock, op.newBlock, diff.oldLinks, diff.newLinks, scratch);
      }
    });
    wrapNestedTables(elContent);
  }

  function appendWholeDiffBlock(tok, links, scratch, kind) {
    var els = buildBlockEls(tok, links, scratch);
    if (els.length === 0) return;
    elContent.appendChild(h("div", { "class": "rd-diff-block rd-diff-" + kind }, els));
  }

  function appendReplaceDiffBlock(oldTok, newTok, oldLinks, newLinks, scratch) {
    var strategy = blockDiffStrategy(oldTok, newTok);
    if (strategy && strategy.mode === "line") {
      appendLineDiffBlock(oldTok.raw, newTok.raw);
      return;
    }
    if (strategy && strategy.mode === "table-rows") {
      if (appendTableRowDiffBlock(oldTok, newTok, oldLinks, newLinks, scratch)) return;
      // tableRawLines() couldn't split the raw text (diffTableRows returned
      // null) — fall through to the generic whole-table replace below rather
      // than mis-key a row.
    }
    if (strategy && strategy.mode === "list-items") {
      appendListItemDiffBlock(oldTok, newTok, oldLinks, newLinks, scratch);
      return;
    }
    appendWordDiffReplaceBlock(oldTok, newTok, oldLinks, newLinks);
  }

  function appendWordDiffReplaceBlock(oldTok, newTok, oldLinks, newLinks) {
    var wd = wordDiffForBlockPair(oldTok, newTok, oldLinks, newLinks);
    var wholeClass = wd.mode === "whole" ? " rd-diff-whole" : "";
    elContent.appendChild(h("div", { "class": "rd-diff-block rd-diff-del" + wholeClass },
      Array.prototype.slice.call(wd.oldEl.childNodes)));
    elContent.appendChild(h("div", { "class": "rd-diff-block rd-diff-add" + wholeClass },
      Array.prototype.slice.call(wd.newEl.childNodes)));
  }

  // Renders one cell's inline content (plain, no diff) via the same
  // synthetic-paragraph + buildBlockEls path buildBlockEls itself never
  // knows about tables — marked.parser wraps it in a throwaway <p>, unwrapped
  // here for the same reason wordDiffForCellPair unwraps its own (a GFM cell
  // can't contain a block-level paragraph).
  function renderCellContent(cell, links, scratch) {
    var tok = { type: "paragraph", raw: "", text: cell.text || "", tokens: cell.tokens || [] };
    var els = buildBlockEls(tok, links, scratch);
    if (els.length === 1 && els[0].tagName === "P") return Array.prototype.slice.call(els[0].childNodes);
    return els;   // shouldn't normally happen for inline-only cell content
  }

  // One <table>, rows aligned by diffTableRows: unchanged rows render plainly,
  // added/removed rows get a whole-row tint, and a "replace" row is compared
  // cell-by-cell — a changed cell shows old (red) stacked over new (green),
  // word-highlighted the same way a changed paragraph is. Returns false when
  // diffTableRows() couldn't align rows at all (malformed raw split), so the
  // caller can fall back to the whole-block replace view instead.
  function appendTableRowDiffBlock(oldTok, newTok, oldLinks, newLinks, scratch) {
    var rowOps = diffTableRows(oldTok, newTok);
    if (!rowOps) return false;

    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var headTr = document.createElement("tr");
    newTok.header.forEach(function (cell) {
      var th = document.createElement("th");
      renderCellContent(cell, newLinks, scratch).forEach(function (n) { th.appendChild(n); });
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    rowOps.forEach(function (rowOp) {
      var tr = document.createElement("tr");
      if (rowOp.op === "equal") {
        appendPlainCells(tr, newTok.rows[rowOp.newIndex], newLinks, scratch);
      } else if (rowOp.op === "insert") {
        tr.className = "rd-diff-row rd-diff-add";
        appendPlainCells(tr, newTok.rows[rowOp.newIndex], newLinks, scratch);
      } else if (rowOp.op === "delete") {
        tr.className = "rd-diff-row rd-diff-del";
        appendPlainCells(tr, oldTok.rows[rowOp.oldIndex], oldLinks, scratch);
      } else {
        tr.className = "rd-diff-row rd-diff-replace";
        appendChangedRowCells(tr, oldTok.rows[rowOp.oldIndex], newTok.rows[rowOp.newIndex], oldLinks, newLinks, scratch);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var scroller = h("div", { "class": "rd-table-scroll" }, [table]);
    elContent.appendChild(h("div", { "class": "rd-table-block" }, [scroller]));
    return true;
  }

  function appendPlainCells(tr, row, links, scratch) {
    row.forEach(function (cell) {
      var td = document.createElement("td");
      renderCellContent(cell, links, scratch).forEach(function (n) { td.appendChild(n); });
      tr.appendChild(td);
    });
  }

  // A "replace" row compared column by column: an unchanged cell renders
  // plainly, a changed cell shows old-over-new with word-level highlighting
  // (wordDiffForCellPair), and a column that only exists on one side is
  // colored as a whole-cell add/delete (uneven column counts are malformed
  // GFM, but tolerated rather than crashing on it).
  function appendChangedRowCells(tr, oldRow, newRow, oldLinks, newLinks, scratch) {
    var colCount = Math.max(oldRow.length, newRow.length);
    for (var c = 0; c < colCount; c++) {
      var td = document.createElement("td");
      var oldCell = oldRow[c], newCell = newRow[c];
      if (oldCell && newCell) {
        if (normRaw(oldCell.text) === normRaw(newCell.text)) {
          renderCellContent(newCell, newLinks, scratch).forEach(function (n) { td.appendChild(n); });
        } else {
          td.classList.add("rd-diff-cell-changed");
          var wd = wordDiffForCellPair(oldCell, newCell, oldLinks, newLinks);
          td.appendChild(h("span", { "class": "rd-diff-cell-old" }, Array.prototype.slice.call(wd.oldEl.childNodes)));
          td.appendChild(h("span", { "class": "rd-diff-cell-new" }, Array.prototype.slice.call(wd.newEl.childNodes)));
        }
      } else if (newCell) {
        td.classList.add("rd-diff-add");
        renderCellContent(newCell, newLinks, scratch).forEach(function (n) { td.appendChild(n); });
      } else if (oldCell) {
        td.classList.add("rd-diff-del");
        renderCellContent(oldCell, oldLinks, scratch).forEach(function (n) { td.appendChild(n); });
      }
      tr.appendChild(td);
    }
  }

  // Renders one list item (with any nested sub-list it carries in its own
  // raw markdown — see diffListItems' doc comment) by handing marked a
  // single-item synthetic list token, the same "reuse the real renderer"
  // trick renderCellContent uses for cells.
  function renderListItemEl(item, ordered, links, scratch) {
    var syntheticList = { type: "list", ordered: !!ordered, start: "", loose: false, items: [item] };
    var els = buildBlockEls(syntheticList, links, scratch);
    var listEl = els[0];
    return (listEl && listEl.querySelector("li")) || document.createElement("li");
  }

  // One <ul>/<ol>, items aligned by diffListItems. A "replace" pair (item
  // similar enough to align, but not identical) renders as its old item
  // (red) immediately followed by its new item (green) — the same
  // old-then-new stacking a changed paragraph gets, at item granularity
  // rather than diffing arbitrary nested block content word-by-word.
  function appendListItemDiffBlock(oldTok, newTok, oldLinks, newLinks, scratch) {
    var itemOps = diffListItems(oldTok, newTok);
    var listEl = document.createElement(newTok.ordered ? "ol" : "ul");
    if (newTok.ordered && newTok.start && newTok.start !== 1) listEl.setAttribute("start", String(newTok.start));
    itemOps.forEach(function (op) {
      if (op.op === "equal") {
        listEl.appendChild(renderListItemEl(op.newItem, newTok.ordered, newLinks, scratch));
      } else if (op.op === "insert") {
        var liAdd = renderListItemEl(op.newItem, newTok.ordered, newLinks, scratch);
        liAdd.classList.add("rd-diff-li", "rd-diff-add");
        listEl.appendChild(liAdd);
      } else if (op.op === "delete") {
        var liDel = renderListItemEl(op.oldItem, oldTok.ordered, oldLinks, scratch);
        liDel.classList.add("rd-diff-li", "rd-diff-del");
        listEl.appendChild(liDel);
      } else {
        var liOld = renderListItemEl(op.oldItem, oldTok.ordered, oldLinks, scratch);
        liOld.classList.add("rd-diff-li", "rd-diff-del");
        listEl.appendChild(liOld);
        var liNew = renderListItemEl(op.newItem, newTok.ordered, newLinks, scratch);
        liNew.classList.add("rd-diff-li", "rd-diff-add");
        listEl.appendChild(liNew);
      }
    });
    elContent.appendChild(h("div", { "class": "rd-diff-block-plain" }, [listEl]));
  }

  // Code blocks and front matter read as literal text, not prose — shown as
  // whole lines colored red/green rather than word-highlighted (matches
  // blockDiffStrategy's reasoning in comment.08-diff.js).
  function appendLineDiffBlock(oldRaw, newRaw) {
    var pre = document.createElement("pre");
    pre.className = "rd-diff-lines";
    diffLines(oldRaw, newRaw).forEach(function (line) {
      if (line.op === "replace") {
        pre.appendChild(buildDiffLineRow(line.oldText, line.newText, "delete"));
        pre.appendChild(buildDiffLineRow(line.newText, line.oldText, "insert"));
        return;
      }
      pre.appendChild(h("div", { "class": "rd-diff-line rd-diff-line-" + line.op, text: line.text.length ? line.text : "\u00a0" }));
    });
    elContent.appendChild(h("div", { "class": "rd-pre-block" }, [pre]));
  }

  // One line of a "replace" pair: `ownText` is this side's own text, `otherText`
  // is the paired line on the other side (needed to compute the word diff --
  // wordDiffForLinePair always takes old-then-new regardless of which side is
  // rendering). Falls back to a plain, unhighlighted line when
  // wordDiffForLinePair declines to word-diff (too different / too long).
  function buildDiffLineRow(ownText, otherText, kind) {
    var oldText = kind === "delete" ? ownText : otherText;
    var newText = kind === "delete" ? otherText : ownText;
    var wd = wordDiffForLinePair(oldText, newText);
    var row = h("div", { "class": "rd-diff-line rd-diff-line-" + kind });
    var ranges = wd ? (kind === "delete" ? wd.oldRanges : wd.newRanges) : [];
    var tag = kind === "delete" ? "del" : "ins";
    appendTextWithRanges(row, ownText.length ? ownText : "\u00a0", ranges, tag);
    return row;
  }

  // Builds `container`'s content as plain text interleaved with `tagName`-
  // wrapped spans over `ranges` (character offsets into `text`) -- the code-
  // line equivalent of applyWordSpans, but starting from a plain string
  // instead of splitting existing text nodes (a source line has no markup to
  // preserve, so there's nothing to split).
  function appendTextWithRanges(container, text, ranges, tagName) {
    var pos = 0;
    ranges.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (r) {
      if (r.start > pos) container.appendChild(document.createTextNode(text.slice(pos, r.start)));
      container.appendChild(h(tagName, { text: text.slice(r.start, r.end) }));
      pos = r.end;
    });
    if (pos < text.length) container.appendChild(document.createTextNode(text.slice(pos)));
  }


  // Same nested-table wrap renderMarkdown does at the end of a normal render
  // (comment.02-render.js) — kept as its own copy here rather than shared,
  // since Phase 5 gives diff-mode tables their own row-level renderer anyway
  // (this whole-table path is temporary).
  function wrapNestedTables(root) {
    Array.prototype.forEach.call(root.querySelectorAll("table"), function (t) {
      if (t.closest(".rd-table-scroll")) return;
      var scroller = h("div", { "class": "rd-table-scroll" });
      t.parentNode.insertBefore(scroller, t);
      scroller.appendChild(t);
    });
  }

  // ===================================================================
  // wiring
  // ===================================================================
  if (elDiffToggle) elDiffToggle.addEventListener("click", toggleDiffMode);
  updateDiffToggleUI();   // reflects "hidden until we know it's markdown" before /source even resolves
  fetchBaseline();
