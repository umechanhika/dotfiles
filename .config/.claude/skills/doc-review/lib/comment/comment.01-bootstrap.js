"use strict";


  // ===================================================================
  // bootstrap
  // ===================================================================
  function start() {
    elContent = document.getElementById("rd-content");
    elFrame = document.getElementById("rd-frame");
    elFilename = document.getElementById("rd-filename");
    elStatus = document.getElementById("rd-status");
    elList = document.getElementById("rd-list");
    elCount = document.getElementById("rd-count");
    elSend = document.getElementById("rd-send");
    elSendNote = document.getElementById("rd-send-note");
    elToast = document.getElementById("rd-toast");
    elLive = document.getElementById("rd-live");
    elSidebar = document.getElementById("rd-sidebar");
    elSidebarToggle = document.getElementById("rd-sidebar-toggle");
    pop = document.getElementById("rd-popover");
    popTarget = document.getElementById("rd-popover-target");
    popText = document.getElementById("rd-popover-text");
    popAdd = document.getElementById("rd-popover-add");
    popCancel = document.getElementById("rd-popover-cancel");

    popAdd.addEventListener("click", onPopoverAdd);
    popCancel.addEventListener("click", closePopover);
    elSend.addEventListener("click", sendAll);
    if (elSidebarToggle) elSidebarToggle.addEventListener("click", toggleSidebar);

    elContent.addEventListener("mousemove", onHover);
    elContent.addEventListener("mouseleave", clearHover);
    elContent.addEventListener("mousedown", onMouseDown);
    elContent.addEventListener("mouseup", onMouseUp);
    // A click inside the content pane that lands on nothing commentable
    // already closes an open draft (onMouseUp, comment.03-selection.js). A
    // click that never reaches elContent at all — the sidebar, the topbar,
    // the page margin around #rd-content — doesn't, since nothing is
    // listening for mousedown out there. This is that catch-all: it only
    // acts when the target is neither the popover itself (its own controls
    // handle their own clicks) nor inside the content pane (elContent's
    // listeners above already decided what to do with those).
    document.addEventListener("mousedown", function (e) {
      if (pop.hidden) return;
      if (e.target.closest && e.target.closest("#rd-popover")) return;
      if (elContent.contains(e.target)) return;
      if (e.target === elFrame) return;   // HTML mode: the iframe's own listeners decide
      closePopover();
    });

    initSidebarResize();

    popText.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.metaKey && !e.shiftKey) { e.preventDefault(); onPopoverAdd(); }
    });
    document.addEventListener("keydown", onGlobalKey);

    // Pause polling when the tab is hidden; resume (and check immediately) when
    // it comes back. No point hammering the server while nobody is looking.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { stopPolling(); }
      else { startPolling(); checkRev(); }
    });

    init();
  }

  function init() {
    fetchSource()
      .then(function (data) {
        applySource(data, false);
        return refreshThreads();
      })
      .then(function () { startPolling(); setStatus("準備完了"); })
      .catch(function (err) { setStatus("読み込み失敗: " + err); });
  }

  function onGlobalKey(e) {
    if (e.key === "Escape") { closePopover(); return; }
    if (e.key === "Enter" && e.metaKey && e.shiftKey) {
      e.preventDefault();
      sendAll();
      return;
    }
    if (e.key === "Enter" && e.metaKey && !e.shiftKey && !pop.hidden) {
      e.preventDefault();
      onPopoverAdd();
    }
  }

  function setStatus(text) { elStatus.textContent = text; }
  function announce(text) { if (elLive) elLive.textContent = text; }
