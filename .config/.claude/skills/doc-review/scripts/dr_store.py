#!/usr/bin/env python3
"""doc-review thread store (server-owned, single writer).

Extracted from serve.py. Owns the in-memory thread store, the path to
``threads.json``, and the RLock that serialises all access to the store.

Module globals do NOT auto-share across files, so serve.py must call
``configure(store_path)`` once (from run_server) to set the on-disk path,
then use the accessors below. The lock (``LOCK``) is owned here and imported
by serve.py so the Handler, the inbox writer, and the batch-id counter all
serialise against the same lock instance — preserving the original
single-lock behavior.

Function names and behavior are identical to the originals in serve.py:
  _load_store -> load(), _save_store -> save(),
  _find_thread -> find_thread(), _merge_anchor -> merge_anchor().

Python 3.9 compatible (no PEP 604 unions).
"""
from __future__ import annotations

import json
import os
import threading
import time

# ---------------------------------------------------------------------------
# Module-level state (moved from serve.py). serve.py sets THREADS_PATH via
# configure(); STORE is rebound by load(); LOCK is the shared RLock.
# ---------------------------------------------------------------------------

THREADS_PATH = ""  # work-dir/threads.json (source of truth)

# In-memory thread store; the server is the only writer. Guarded by LOCK.
STORE = {"rev": 0, "next_id": 1, "threads": []}

LOCK = threading.RLock()

# Batch-id counter (moved from serve.py). Serialised against LOCK so the
# inbox writer, the Handler and the counter all share one lock instance.
_batch_seq = 0


def next_batch_id() -> str:
    global _batch_seq
    with LOCK:
        _batch_seq += 1
        seq = _batch_seq
    return time.strftime("%Y%m%d-%H%M%S") + ("-%03d" % seq)


def append_jsonl(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with LOCK:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")


def configure(store_path: str) -> None:
    """Set the on-disk path for threads.json (called once by run_server)."""
    global THREADS_PATH
    THREADS_PATH = store_path


def store() -> dict:
    """Return the current in-memory store dict.

    load() may rebind STORE, so callers must fetch it through this accessor
    rather than caching the reference.
    """
    return STORE


def load() -> None:
    global STORE
    if os.path.isfile(THREADS_PATH):
        try:
            with open(THREADS_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict) and isinstance(data.get("threads"), list):
                STORE = {
                    "rev": int(data.get("rev", 0)),
                    "next_id": int(data.get("next_id", len(data["threads"]) + 1)),
                    "threads": data["threads"],
                }
                return
        except (OSError, ValueError):
            pass
    STORE = {"rev": 0, "next_id": 1, "threads": []}


def save() -> None:
    # Caller holds LOCK. Atomic write via temp + replace.
    tmp = THREADS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(STORE, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, THREADS_PATH)


def find_thread(thread_id: str):
    for t in STORE["threads"]:
        if t.get("id") == thread_id:
            return t
    return None


def merge_anchor(anchor: dict, update: dict) -> None:
    """Apply a Claude-supplied anchor update onto an existing thread anchor.

    The browser re-places each comment marker by matching the anchor's stored
    *content* (``block_raw`` for markdown, ``text`` / ``selected_text`` for
    HTML) against the freshly rendered document — never by a positional index,
    which drifts the instant Claude inserts or removes a block above. So when
    Claude moves or rewrites the commented region it must hand us the new
    content, and when it deletes the region it must mark the anchor ``gone``.
    We touch only the fields Claude sends; supplying any content re-anchors the
    comment (clears ``gone``). The anchor type (block/range/element) is
    irrelevant here — we just overlay whatever was provided.
    """
    if not isinstance(anchor, dict) or not isinstance(update, dict):
        return
    touched = False
    for key in ("block_raw", "text", "selected_text", "block_index"):
        if key in update:
            anchor[key] = update[key]
            touched = True
    if update.get("gone"):
        anchor["gone"] = True
    elif touched:
        anchor["gone"] = False
