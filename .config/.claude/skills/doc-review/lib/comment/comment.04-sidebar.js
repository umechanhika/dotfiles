"use strict";


  // ===================================================================
  // ordering + numbering (document order, computed once per view refresh)
  // ===================================================================
  function newDrafts() { return state.pending.filter(function (p) { return p.type === "new"; }); }
  function repliesFor(tid) { return state.pending.filter(function (p) { return p.type === "reply" && p.thread_id === tid; }); }
  function isResolved(t) { return t.status === "resolved"; }

  // Vertical position of a block within the document (for ordering). Unresolved
  // anchors sort to the end.
  function blockTop(blk) {
    if (blk && rdRoot().contains(blk)) {
      if (isHtml()) {
        // The iframe content scrolls internally; add its own scroll origin so
        // the metric is the block's absolute position in the document order,
        // independent of where the frame is currently scrolled.
        var win = rdFrame() && rdFrame().contentWindow;
        var sy = win ? (win.scrollY || 0) : 0;
        return blk.getBoundingClientRect().top + sy;
      }
      var scroller = document.scrollingElement || document.documentElement;
      return blk.getBoundingClientRect().top + scroller.scrollTop;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function inDoc(blk) { return !!(blk && rdRoot().contains(blk)); }

  // The badge number is the comment's stable id, not its position. The server
  // hands every thread a unique, monotonically-increasing id ("t3") and never
  // reuses or renumbers it, so deriving the number from the id means resolving
  // comment 2 leaves 1 and 3 exactly as they were — no silent renumbering.
  function threadNum(t) { return parseInt(String(t.id).replace(/^\D+/, ""), 10); }

  // Why an anchor couldn't be placed, for the sidebar note (null = placed fine).
  function anchorReason(a) { return a && a.gone ? "deleted" : "missing"; }

  // Build the active list (new drafts + non-resolved threads). Two things are
  // computed here and reused everywhere: the placement (which block each anchor
  // resolves to, or none) and the badge number. Layout is document order so the
  // sidebar mirrors the body top-to-bottom; the number is independent of order.
  function computeOrder() {
    var entries = [];

    // Drafts have no server id yet, so give them a provisional number that
    // continues past the highest existing thread number (resolved included) to
    // avoid colliding badges. On submit the server assigns the real id and the
    // next refresh replaces this — so it needn't match exactly, just not clash.
    var maxThread = 0;
    state.threads.forEach(function (t) {
      var n = threadNum(t);
      if (!isNaN(n) && n > maxThread) maxThread = n;
    });

    var draftSeq = 0;
    newDrafts().forEach(function (d) {
      var blk = anchorToBlock(d.anchor) || d.block;
      if (!inDoc(blk)) blk = null;
      draftSeq += 1;
      entries.push({
        key: "draft:" + d.pid, kind: "draft", ref: d, top: blockTop(blk),
        block: blk, located: !!blk, reason: blk ? null : anchorReason(d.anchor),
        num: maxThread + draftSeq
      });
    });
    state.threads.forEach(function (t) {
      if (isResolved(t)) return;
      var blk = anchorToBlock(t.anchor);
      if (!inDoc(blk)) blk = null;
      entries.push({
        key: "thread:" + t.id, kind: "thread", ref: t, top: blockTop(blk),
        block: blk, located: !!blk, reason: blk ? null : anchorReason(t.anchor),
        num: threadNum(t)
      });
    });

    entries.sort(function (a, b) { return a.top - b.top; });   // layout order only
    var nums = {};
    entries.forEach(function (e) { nums[e.key] = e.num; });
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
      if (e.kind === "draft") elList.appendChild(draftCard(e.ref, nums[e.key], e));
      else elList.appendChild(threadCard(e.ref, nums[e.key], e));
    });

    // resolved (collapsed) — keep their stable number so reopening is seamless
    if (resolved.length) {
      var details = h("details", { "class": "rd-resolved-group" },
        [h("summary", { text: "解決済み (" + resolved.length + ")" })]);
      resolved.forEach(function (t) { details.appendChild(threadCard(t, threadNum(t), null)); });
      elList.appendChild(details);
    }

    var nPending = state.pending.length;
    elSend.disabled = nPending === 0;
    elSend.textContent = nPending > 0 ? "Claude に送信 (" + nPending + ")" : "Claude に送信";
    elSendNote.textContent = nPending > 0
      ? "Cmd+Shift+Enter で送信"
      : "本文を選択/クリック → Cmd+Enter で追加";

    // Heights are only knowable once the cards are laid out, so clamp long
    // bubbles in a deferred pass.
    queuePostRender();
  }

  // ===================================================================
  // bubble post-render: long-text clamp (deferred so heights are measurable)
  // ===================================================================
  var CLAMP_MAX = 220;   // px — ~12-14 lines before we collapse
  var postRenderQueued = false;

  function queuePostRender() {
    if (postRenderQueued) return;
    postRenderQueued = true;
    requestAnimationFrame(function () { postRenderQueued = false; applyBubblePostRender(); });
  }

  function applyBubblePostRender() {
    Array.prototype.forEach.call(elList.querySelectorAll(".rd-bubble-text"), function (textEl) {
      var bubbleEl = textEl.parentElement;
      var key = textEl.dataset.mkey || "";
      // clamp long bodies + attach a toggle. scrollHeight here is the full natural
      // height (nothing is clamped yet), so it tells us whether this bubble is long
      // enough to need collapsing — independent of current state.
      if (!bubbleEl.querySelector(".rd-bubble-more") && textEl.scrollHeight > CLAMP_MAX) {
        setupClampToggle(textEl, bubbleEl, key, !!(key && state.expanded[key]));
      }
    });
  }

  // Collapse a tall bubble to CLAMP_MAX with a fade + toggle. Expand/collapse is an
  // instant class flip (animating to/from auto height is fragile, esp. under
  // reduced-motion); the motion polish lives in the reveal + copy feedback. The
  // toggle is (re)built on every render and seeded from state.expanded, so an
  // expanded bubble keeps its "閉じる" affordance across polling re-renders.
  function setupClampToggle(textEl, bubbleEl, key, startExpanded) {
    var lh = parseFloat(getComputedStyle(textEl).lineHeight) || 20;
    var remain = Math.max(1, Math.round((textEl.scrollHeight - CLAMP_MAX) / lh));
    var collapsedLabel = "続きを表示（残り " + remain + " 行）";
    var more = h("button", { "class": "rd-bubble-more", type: "button" });
    function apply(expanded) {
      if (expanded) {
        textEl.classList.remove("clamped");
        if (key) state.expanded[key] = true;
        more.textContent = "閉じる ▴";
      } else {
        textEl.classList.add("clamped");
        if (key) delete state.expanded[key];
        more.textContent = collapsedLabel;
      }
    }
    more.addEventListener("click", function (e) {
      e.stopPropagation();
      var nowCollapsed = textEl.classList.contains("clamped");
      apply(nowCollapsed);                                       // collapsed→expand / expanded→collapse
      if (!nowCollapsed) bubbleEl.scrollIntoView({ block: "nearest" });   // keep top in view when re-collapsing
    });
    apply(startExpanded);
    bubbleEl.appendChild(more);
  }

  function header(num, kindLabel, badgeCls) {
    var kids = [];
    if (num != null && !isNaN(num)) {
      kids.push(h("span", { "class": "rd-item-num " + (badgeCls || ""), text: String(num) }));
      kids.push(" ");
    }
    kids.push(h("span", { "class": "rd-item-kind", text: kindLabel }));
    return h("div", { "class": "rd-item-head" }, [h("span", null, kids)]);
  }

  // When a comment's anchor can't be placed on the document, the body shows no
  // marker (by design — we don't guess a location). Surface a small note in the
  // card so the comment doesn't look orphaned and the user understands why.
  function anchorNote(entry) {
    if (!entry || entry.located) return null;
    var msg = entry.reason === "deleted"
      ? "この箇所は削除されました"
      : "該当箇所が見つかりません（編集で移動した可能性）";
    return h("div", { "class": "rd-item-note", text: msg });
  }

  // Clicking a card (but not a control inside it) jumps to the anchored block.
  function cardJump(key) {
    return function (e) {
      if (e.target.closest("button, textarea, a")) return;
      focusBlock(key);
    };
  }

  function draftCard(d, num, entry) {
    var head = header(num, "下書き · " + anchorKindLabel(d.anchor), "draft");
    head.appendChild(h("button", {
      "class": "rd-item-del", type: "button", text: "削除", "aria-label": "下書きを削除",
      on: { click: function (e) { e.stopPropagation(); removePending(d.pid); } }
    }));
    var item = h("div", { "class": "rd-item draft", dataset: { key: "draft:" + d.pid } }, [
      head,
      h("div", { "class": "rd-item-target", text: anchorSnippet(d.anchor) }),
      anchorNote(entry),
      bubble("user", d.text, true, "draft:" + d.pid)
    ]);
    item.addEventListener("click", cardJump("draft:" + d.pid));
    return item;
  }

  function threadCard(t, num, entry) {
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
      h("div", { "class": "rd-item-target", text: anchorSnippet(t.anchor) }),
      anchorNote(entry)
    ]);

    (t.messages || []).forEach(function (m, i) { item.appendChild(bubble(m.role, m.text, false, t.id + "#" + i)); });

    // pending re-feedback drafts for this thread
    repliesFor(t.id).forEach(function (p) {
      var b = bubble("user", p.text, true, "reply:" + p.pid);
      b.appendChild(h("button", {
        "class": "rd-bubble-del", type: "button", text: "×", title: "下書きを削除", "aria-label": "下書きを削除",
        on: { click: function (e) { e.stopPropagation(); removePending(p.pid); } }
      }));
      item.appendChild(b);
    });

    // reply box (not for resolved). Empty: a single-line field with the small
    // send button parked at its right-centre (Figma-style). On the first
    // keystroke the field becomes input-only and the button drops just below it,
    // right-aligned — toggled via the `has-text` class from the input handler.
    if (!isResolved(t)) {
      var wrap = h("div", { "class": "rd-reply" });
      var ta = h("textarea", {
        "class": "rd-reply-input", rows: 1,
        placeholder: t.status === "answered" ? "再フィードバック…" : "補足…",
        on: {
          keydown: function (e) { if (e.key === "Enter" && e.metaKey && !e.shiftKey) { e.preventDefault(); addReply(t.id, ta); } },
          input: function () {
            var has = ta.value.trim() !== "";
            wrap.classList.toggle("has-text", has);
            add.disabled = !has;
            autoGrowReply(ta);
          }
        }
      });
      var add = h("button", {
        "class": "rd-reply-send", type: "button", text: "↑",
        title: "返信を追加 (⌘Enter)", "aria-label": "返信を追加", disabled: true,
        on: { click: function () { addReply(t.id, ta); } }
      });
      wrap.appendChild(ta);
      wrap.appendChild(add);
      item.appendChild(wrap);
    }

    item.addEventListener("click", cardJump("thread:" + t.id));
    return item;
  }

  function bubble(role, text, isDraft, key) {
    var md = renderCommentMarkdown(text);
    var body = md != null
      ? h("div", { "class": "rd-bubble-text rd-md", html: md })
      : h("div", { "class": "rd-bubble-text", text: text });   // parse failed -> safe plain text
    if (key) body.dataset.mkey = key;
    return h("div", { "class": "rd-bubble " + (role === "claude" ? "claude" : "user") + (isDraft ? " draft" : "") }, [
      h("span", { "class": "rd-bubble-who", text: role === "claude" ? "Claude" : (isDraft ? "あなた（送信待ち）" : "あなた") }),
      body
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
