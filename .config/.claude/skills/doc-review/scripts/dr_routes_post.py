#!/usr/bin/env python3
"""doc-review POST route mixin (extracted from serve.py).

``PostRoutes`` is mixed into the final ``Handler`` in serve.py. The response
helpers and the body reader (``self._send_json`` / ``self._send_error_json`` /
``self._read_body``) resolve at runtime through the Handler's MRO, so this
module does NOT import serve.py (which would be circular). Runtime config is
read from dr_config; the thread store + inbox writer + batch-id counter from
dr_store; pure helpers from dr_util. Behavior is identical to the originals in
serve.py — same lock semantics (dr_store.LOCK), same JSON shapes, same statuses.

Python 3.9 compatible (no PEP 604 unions).
"""
from __future__ import annotations

import dr_config
import dr_store
from dr_util import _now


class PostRoutes:
    # -- routing -----------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        dr_config.touch()
        path = self.path.split("?", 1)[0]
        if path == "/threads/submit":
            return self._submit()
        if path == "/threads/reply":
            return self._reply()
        if path == "/threads/resolve":
            return self._resolve()
        return self._send_error_json(404, "not found")

    # -- POST handlers -----------------------------------------------------

    def _submit(self) -> None:
        payload = self._read_body()
        if payload is None:
            return self._send_error_json(400, "invalid JSON")
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            return self._send_error_json(400, "no items")

        inbox_items = []
        with dr_store.LOCK:
            store = dr_store.store()
            for it in items:
                text = (it.get("text") or "").strip()
                if not text:
                    continue
                tid = it.get("thread_id")
                if tid:
                    thread = dr_store.find_thread(tid)
                    if thread is None:
                        continue
                    thread["messages"].append({"role": "user", "text": text, "ts": _now()})
                    thread["status"] = "open"
                    anchor = thread.get("anchor")
                    is_new = False
                else:
                    anchor = it.get("anchor")
                    if anchor is None:
                        continue
                    tid = "t%d" % store["next_id"]
                    store["next_id"] += 1
                    thread = {
                        "id": tid,
                        "anchor": anchor,
                        "status": "open",
                        "messages": [{"role": "user", "text": text, "ts": _now()}],
                    }
                    store["threads"].append(thread)
                    is_new = True
                inbox_items.append(
                    {"thread_id": tid, "anchor": anchor, "text": text, "is_new": is_new}
                )

            if not inbox_items:
                return self._send_error_json(400, "no valid items")

            store["rev"] += 1
            dr_store.save()
            rev = store["rev"]
            threads_copy = list(store["threads"])

        batch = {
            "batch_id": dr_store.next_batch_id(),
            "ts": _now(),
            "target": dr_config.TARGET_PATH,
            "work_dir": dr_config.WORK_DIR,
            "items": inbox_items,
        }
        try:
            dr_store.append_jsonl(dr_config.INBOX_PATH, batch)
        except OSError as exc:
            return self._send_error_json(500, "cannot write inbox: %s" % exc)
        self._send_json({"ok": True, "batch_id": batch["batch_id"], "rev": rev, "threads": threads_copy})

    def _reply(self) -> None:
        payload = self._read_body()
        if payload is None:
            return self._send_error_json(400, "invalid JSON")
        tid = payload.get("thread_id")
        text = (payload.get("text") or "").strip()
        if not tid or not text:
            return self._send_error_json(400, "thread_id and text required")
        with dr_store.LOCK:
            store = dr_store.store()
            thread = dr_store.find_thread(tid)
            if thread is None:
                return self._send_error_json(404, "thread not found: %s" % tid)
            thread["messages"].append({"role": "claude", "text": text, "ts": _now()})
            if thread.get("status") != "resolved":
                thread["status"] = "answered"
            # Optional: re-point (or retire) this comment's anchor to match the
            # edit Claude just made, so the browser can place the marker on the
            # new location instead of losing or misplacing it.
            anchor_update = payload.get("anchor_update")
            if isinstance(anchor_update, dict) and isinstance(thread.get("anchor"), dict):
                dr_store.merge_anchor(thread["anchor"], anchor_update)
            store["rev"] += 1
            dr_store.save()
            rev = store["rev"]
        self._send_json({"ok": True, "rev": rev})

    def _resolve(self) -> None:
        payload = self._read_body()
        if payload is None:
            return self._send_error_json(400, "invalid JSON")
        tid = payload.get("thread_id")
        if not tid:
            return self._send_error_json(400, "thread_id required")
        reopen = bool(payload.get("reopen"))
        with dr_store.LOCK:
            store = dr_store.store()
            thread = dr_store.find_thread(tid)
            if thread is None:
                return self._send_error_json(404, "thread not found: %s" % tid)
            thread["status"] = "open" if reopen else "resolved"
            store["rev"] += 1
            dr_store.save()
            rev = store["rev"]
        self._send_json({"ok": True, "rev": rev})
