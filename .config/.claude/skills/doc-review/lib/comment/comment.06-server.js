"use strict";


  // ===================================================================
  // send (submit batch)
  // ===================================================================
  function sendAll() {
    if (state.pending.length === 0) return;
    // Don't silently drop an in-progress edit: its keystrokes live only in the
    // textarea DOM until "保存" commits them into state.pending[].text.
    if (state.editingPid) { toast("編集中のコメントを保存してから送信してください"); return; }
    elSend.disabled = true;
    elSendNote.textContent = "送信中…";
    var items = state.pending.map(function (p) {
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
          state.pending = [];
          state.threads = res.threads || state.threads;
          state.lastRev = res.rev;
          refreshView();
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
        if (res && res.ok) { state.lastRev = res.rev; refreshThreads(); }
      })
      .catch(noop);
  }

  // ===================================================================
  // polling / live reload
  // ===================================================================
  function refreshThreads() {
    return fetch("/threads", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.threads = d.threads || [];
        state.lastRev = d.rev;
        refreshView();
      })
      .catch(noop);
  }

  function startPolling() {
    stopPolling();
    if (document.hidden) return;
    state.pollTimer = setInterval(checkRev, 3500);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  // Cheap poll: ask only for the revision number. Pull the heavy payloads
  // (threads + source) only when something actually changed.
  function checkRev() {
    fetch("/rev", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (typeof d.rev === "number" && d.rev > state.lastRev) onRevBumped(d.rev);
      })
      .catch(noop);
  }

  function onRevBumped(rev) {
    state.lastRev = rev;
    Promise.all([
      fetch("/threads", { cache: "no-store" }).then(function (r) { return r.json(); }),
      fetch("/source", { cache: "no-store" }).then(function (r) { return r.json(); })
    ]).then(function (res) {
      var td = res[0], sd = res[1];
      state.threads = td.threads || [];
      // Did the file itself change, or only the thread data (e.g. a reply)?
      var sourceChanged = !state.meta || sd.mtime !== state.meta.mtime || sd.content !== state.meta.content;
      if (sourceChanged) {
        setStatus("更新を反映しました");
        toast("Claude がドキュメントを更新しました");
        announce("Claude がドキュメントを更新しました");
        applySource(sd, true);     // updates state.meta; renders normally for now
        // The body itself changed — this is Claude's edit landing, not just a
        // reply (the else branch below never reaches this point, so a
        // reply-only update can't trigger it). Pull the fresh baseline (this
        // submit's pre-edit snapshot) and switch to diff mode automatically,
        // overriding the normal render applySource just did, regardless of
        // which mode the reader was in before.
        fetchBaseline().then(function () {
          if (!diffAvailable()) return;   // baseline fetch failed or still none — keep the normal render applySource already drew
          state.diffMode = true;
          renderDiffView();
          updateDiffToggleUI();
        });
      } else {
        // Reply / status change only: no body re-parse, just refresh markers + sidebar.
        setStatus("返信が届きました");
        toast("Claude が返信しました");
        announce("Claude が返信しました");
        refreshView();
      }
    }).catch(noop);
  }
