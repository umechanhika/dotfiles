#!/usr/bin/env python3
"""doc-review pure helpers (no module-level mutable state).

These functions are extracted from serve.py. They depend only on their
arguments and the standard library, so they can live in their own module
without any shared-state coordination. Behavior is identical to the
originals in serve.py.

Python 3.9 compatible (no PEP 604 unions).
"""
from __future__ import annotations

import hashlib
import os
import time


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _kind_for_ext(ext: str) -> str:
    return "html" if ext in ("html", "htm") else "markdown"


def default_work_dir(target_abs: str) -> str:
    """Per-target working dir OUTSIDE any repo, persistent across sessions."""
    name = os.path.basename(target_abs)
    safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in name)
    digest = hashlib.sha1(target_abs.encode("utf-8")).hexdigest()[:16]
    base = os.path.expanduser("~/.claude/doc-review")
    return os.path.join(base, "%s-%s" % (safe, digest))


def _content_type_for(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".html") or lower.endswith(".htm"):
        return "text/html; charset=utf-8"
    if lower.endswith(".js"):
        return "text/javascript; charset=utf-8"
    if lower.endswith(".css"):
        return "text/css; charset=utf-8"
    if lower.endswith(".json"):
        return "application/json; charset=utf-8"
    if lower.endswith(".svg"):
        return "image/svg+xml"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".gif"):
        return "image/gif"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".ico"):
        return "image/x-icon"
    if lower.endswith(".woff2"):
        return "font/woff2"
    if lower.endswith(".woff"):
        return "font/woff"
    if lower.endswith(".ttf"):
        return "font/ttf"
    if lower.endswith(".otf"):
        return "font/otf"
    return "application/octet-stream"
