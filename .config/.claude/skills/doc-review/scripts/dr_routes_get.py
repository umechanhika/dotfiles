#!/usr/bin/env python3
"""doc-review GET route mixin (extracted from serve.py).

``GetRoutes`` is mixed into the final ``Handler`` in serve.py. The response
helpers it calls (``self._send_json`` / ``self._send_bytes`` /
``self._send_error_json``) and ``self.path`` / ``self.wfile`` resolve at
runtime through the Handler's MRO, so this module does NOT import serve.py
(which would be circular). Runtime config is read from dr_config; the thread
store from dr_store; pure helpers from dr_util. Behavior is identical to the
originals in serve.py.

Python 3.9 compatible (no PEP 604 unions).
"""
from __future__ import annotations

import os
import urllib.parse

import dr_config
import dr_store
from dr_util import _content_type_for, _kind_for_ext


class GetRoutes:
    # -- routing -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        dr_config.touch()
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            return self._serve_lib_file("viewer.html")
        if path.startswith("/lib/"):
            return self._serve_lib_file(path[len("/lib/"):])
        if path == "/raw" or path.startswith("/raw/"):
            return self._serve_raw(path)
        if path == "/source":
            return self._serve_source()
        if path == "/threads":
            return self._serve_threads()
        if path == "/rev":
            return self._serve_rev()
        if path == "/favicon.ico":
            return self._send_bytes(b"", "image/x-icon", status=204)
        return self._send_error_json(404, "not found")

    # -- GET handlers ------------------------------------------------------

    def _serve_lib_file(self, rel: str) -> None:
        safe = os.path.normpath(rel).lstrip("/")
        full = os.path.realpath(os.path.join(dr_config.LIB_DIR, safe))
        lib_root = os.path.realpath(dr_config.LIB_DIR)
        if not (full == lib_root or full.startswith(lib_root + os.sep)):
            return self._send_error_json(403, "forbidden")
        if not os.path.isfile(full):
            return self._send_error_json(404, "not found")
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            return self._send_error_json(404, "not found")
        self._send_bytes(data, _content_type_for(full))

    def _serve_raw(self, path: str) -> None:
        # Serves the target file (and assets sitting next to it) so an iframe can
        # render the HTML as its own document — head <style>/<link> intact and no
        # cascade from the viewer chrome. The iframe loads "/raw/" (trailing
        # slash) so the document's base URL is /raw/ and its relative href/src
        # resolve to "/raw/<rel>", handled here.
        rel = path[len("/raw"):]  # "" | "/" | "/sub/asset.css"
        if rel in ("", "/"):
            # The document itself.
            try:
                with open(dr_config.TARGET_PATH, "rb") as fh:
                    data = fh.read()
            except OSError as exc:
                return self._send_error_json(500, "cannot read source: %s" % exc)
            return self._send_bytes(data, _content_type_for(dr_config.TARGET_PATH))

        # A sibling asset, resolved relative to the target's directory. Guard
        # against path traversal the same way _serve_lib_file does: the resolved
        # realpath must stay inside TARGET_DIR.
        safe = os.path.normpath(urllib.parse.unquote(rel.lstrip("/")))
        full = os.path.realpath(os.path.join(dr_config.TARGET_DIR, safe))
        root = os.path.realpath(dr_config.TARGET_DIR)
        if not (full == root or full.startswith(root + os.sep)):
            return self._send_error_json(403, "forbidden")
        if not os.path.isfile(full):
            return self._send_error_json(404, "not found")
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            return self._send_error_json(404, "not found")
        self._send_bytes(data, _content_type_for(full))

    def _serve_source(self) -> None:
        try:
            with open(dr_config.TARGET_PATH, "r", encoding="utf-8") as fh:
                content = fh.read()
            mtime = os.path.getmtime(dr_config.TARGET_PATH)
        except OSError as exc:
            return self._send_error_json(500, "cannot read source: %s" % exc)
        self._send_json(
            {
                "name": dr_config.TARGET_NAME,
                "path": dr_config.TARGET_PATH,
                "ext": dr_config.TARGET_EXT,
                "kind": _kind_for_ext(dr_config.TARGET_EXT),
                "mtime": mtime,
                "content": content,
            }
        )

    def _serve_threads(self) -> None:
        with dr_store.LOCK:
            store = dr_store.store()
            self._send_json({"rev": store["rev"], "threads": store["threads"]})

    def _serve_rev(self) -> None:
        # Lightweight poll target: returns only the revision counter so the
        # browser can cheaply detect changes without transferring every thread
        # (and its full message history) every few seconds.
        with dr_store.LOCK:
            self._send_json({"rev": dr_store.store()["rev"]})
