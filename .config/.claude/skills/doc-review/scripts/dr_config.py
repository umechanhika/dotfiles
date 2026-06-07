#!/usr/bin/env python3
"""doc-review runtime server config + activity state.

Extracted from serve.py so the route mixins (dr_routes_get / dr_routes_post)
can read the runtime server configuration WITHOUT importing serve.py — which
would create a circular import (serve.py imports the mixins). Module globals
do NOT auto-share across files, so run_server sets these here via
``configure(**kwargs)`` and the mixins read ``dr_config.TARGET_PATH`` etc.

The activity state (``_last_activity``) lives here too, mutated through
``touch()`` and read through ``last_activity()``. The original behavior used a
single module global updated on every request and read by the idle watcher;
that is preserved exactly — only the home of the global has moved.

Python 3.9 compatible (no PEP 604 unions).
"""
from __future__ import annotations

import time

# ---------------------------------------------------------------------------
# Runtime server config (populated by run_server via configure())
# ---------------------------------------------------------------------------

TARGET_PATH = ""          # absolute path of the single file under review
TARGET_NAME = ""          # basename
TARGET_DIR = ""           # directory holding the target (for /raw relative assets)
TARGET_EXT = ""           # "md" | "markdown" | "html" | "htm"
LIB_DIR = ""              # absolute path of the bundled lib/ directory
WORK_DIR = ""             # absolute path of the working dir
INBOX_PATH = ""           # work-dir/inbox.jsonl  (Monitor trigger)

# Activity state: updated on every request, read by the idle watcher.
_last_activity = time.time()


def configure(**kwargs) -> None:
    """Set runtime config globals (called once by run_server)."""
    globals().update(kwargs)


def touch() -> None:
    global _last_activity
    _last_activity = time.time()


def last_activity() -> float:
    return _last_activity
