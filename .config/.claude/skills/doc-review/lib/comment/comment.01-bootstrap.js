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
    elContent.addEventListener("mouseup", onMouseUp);

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
