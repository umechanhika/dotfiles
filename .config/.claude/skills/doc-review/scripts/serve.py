#!/usr/bin/env python3
"""doc-review local server (v2: threaded comments).

Serves a single markdown / HTML file for in-browser commenting (Figma-like).
Comments are organised as *threads* (an anchor + a list of messages + a status).
``threads.json`` is the single source of truth and is owned EXCLUSIVELY by the
running server process — the browser and Claude mutate it only over HTTP, never
by writing the file directly.

Flow:
  - Browser drafts comments locally, then submits a batch -> POST /threads/submit
    -> server creates/updates threads + appends one line to inbox.jsonl (the
    trigger Claude's Monitor watches).
  - Claude edits the target file, then replies per thread via the ``reply``
    subcommand, which HTTP-POSTs to this server (POST /threads/reply).
  - Browser polls GET /threads; when ``rev`` grows it re-fetches /source and
    re-renders, showing Claude's replies.
  - User resolves a thread -> POST /threads/resolve (kept, collapsed).

Everything is local: binds 127.0.0.1 ONLY, no external requests.
Python 3.9 compatible (no PEP 604 unions).

Modes
-----
1. (default)  run the HTTP server
2. reply      append a Claude reply to a thread (thin HTTP client to the server)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

import dr_config
import dr_store
from dr_routes_get import GetRoutes
from dr_routes_post import PostRoutes
from dr_util import default_work_dir

# The runtime server config + activity state live in dr_config; the thread
# store (STORE, threads.json path) + inbox writer + batch-id counter live in
# dr_store. serve.py coordinates with them through their configure()/accessor
# functions. The RLock is owned by dr_store and reused by every module so the
# Handler, the inbox writer and the batch-id counter all serialise against the
# same lock instance.

# ---------------------------------------------------------------------------
# HTTP handler
#
# Route logic is split into mixins: GetRoutes (do_GET + GET handlers) and
# PostRoutes (do_POST + POST handlers). MRO is
# Handler(GetRoutes, PostRoutes, BaseHTTPRequestHandler); only do_GET/do_POST
# override BaseHTTPRequestHandler. Handler itself keeps just the response
# helpers, which the mixins call via self.* (resolved through the MRO).
# ---------------------------------------------------------------------------


class Handler(GetRoutes, PostRoutes, BaseHTTPRequestHandler):
    server_version = "doc-review/2.0"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("[doc-review] %s\n" % (fmt % args))

    # -- helpers -----------------------------------------------------------

    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json({"error": message}, status=status)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None


# ---------------------------------------------------------------------------
# Lifecycle watcher (parent death + idle timeout)
# ---------------------------------------------------------------------------


def _watcher(server: ThreadingHTTPServer, parent_pid: Optional[int], idle_timeout: float) -> None:
    while True:
        time.sleep(2.0)
        if parent_pid is not None:
            try:
                os.kill(parent_pid, 0)
            except OSError:
                sys.stderr.write("[doc-review] parent process gone; shutting down\n")
                server.shutdown()
                return
        if idle_timeout > 0 and (time.time() - dr_config.last_activity()) > idle_timeout:
            sys.stderr.write("[doc-review] idle timeout; shutting down\n")
            server.shutdown()
            return


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def run_server(args: argparse.Namespace) -> int:
    target_path = os.path.realpath(args.target)
    if not os.path.isfile(target_path):
        sys.stderr.write("error: target not found: %s\n" % target_path)
        return 2
    target_name = os.path.basename(target_path)
    target_dir = os.path.dirname(target_path)
    target_ext = target_name.rsplit(".", 1)[-1].lower() if "." in target_name else ""
    if target_ext not in ("md", "markdown", "html", "htm"):
        sys.stderr.write("error: unsupported file type '.%s' (md/html only)\n" % target_ext)
        return 2

    lib_dir = os.path.realpath(os.path.join(args.skill_dir, "lib"))
    if not os.path.isdir(lib_dir):
        sys.stderr.write("error: lib dir not found: %s\n" % lib_dir)
        return 2

    work = args.work_dir if args.work_dir else default_work_dir(target_path)
    work_dir = os.path.realpath(os.path.expanduser(work))
    os.makedirs(work_dir, exist_ok=True)
    inbox_path = os.path.join(work_dir, "inbox.jsonl")

    # Publish runtime config so the route mixins (dr_routes_get/post) can read
    # it via dr_config.* without importing serve.py (which would be circular).
    dr_config.configure(
        TARGET_PATH=target_path,
        TARGET_NAME=target_name,
        TARGET_DIR=target_dir,
        TARGET_EXT=target_ext,
        LIB_DIR=lib_dir,
        WORK_DIR=work_dir,
        INBOX_PATH=inbox_path,
    )
    dr_store.configure(os.path.join(work_dir, "threads.json"))
    dr_store.load()  # restore past threads if this file was reviewed before

    # Bind 127.0.0.1 ONLY. Never 0.0.0.0.
    server = None
    chosen_port = None
    last_exc = None
    for port in range(args.port, args.port + 50):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            chosen_port = port
            break
        except OSError as exc:
            last_exc = exc
            continue
    if server is None:
        sys.stderr.write("error: no free port near %d: %s\n" % (args.port, last_exc))
        return 1

    parent_pid = args.parent_pid if args.parent_pid and args.parent_pid > 0 else None
    watcher = threading.Thread(
        target=_watcher, args=(server, parent_pid, float(args.idle_timeout)), daemon=True
    )
    watcher.start()

    url = "http://127.0.0.1:%d/" % chosen_port
    try:
        with open(os.path.join(work_dir, "server.url"), "w", encoding="utf-8") as fh:
            fh.write(url)
        with open(os.path.join(work_dir, "server.pid"), "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        pass
    sys.stdout.write("SERVE_URL=%s\n" % url)
    sys.stdout.write("WORK_DIR=%s\n" % work_dir)
    sys.stdout.write("INBOX=%s\n" % inbox_path)
    sys.stdout.flush()

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def _read_server_url(work_dir: str) -> Optional[str]:
    p = os.path.join(work_dir, "server.url")
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return None


def reply_cmd(args: argparse.Namespace) -> int:
    # Resolve the server URL: explicit --url, else --work-dir, else default from --target.
    if args.url:
        base = args.url
    else:
        if args.work_dir:
            work = os.path.realpath(os.path.expanduser(args.work_dir))
        elif args.target:
            work = default_work_dir(os.path.realpath(args.target))
        else:
            sys.stderr.write("error: one of --url / --work-dir / --target is required\n")
            return 2
        base = _read_server_url(work)
        if not base:
            sys.stderr.write("error: server.url not found (is the server running?) in %s\n" % work)
            return 2
    endpoint = base.rstrip("/") + "/threads/reply"
    payload = {"thread_id": args.thread_id, "text": args.text}
    # Optional anchor update: tell the browser where this comment now points
    # after the edit (moved/rewritten -> new content; deleted -> gone).
    anchor_update = {}
    if args.anchor_block_raw is not None:
        anchor_update["block_raw"] = args.anchor_block_raw
    if args.anchor_selected_text is not None:
        anchor_update["selected_text"] = args.anchor_selected_text
    if args.anchor_text is not None:
        anchor_update["text"] = args.anchor_text
    if args.anchor_gone:
        anchor_update["gone"] = True
    if anchor_update:
        payload["anchor_update"] = anchor_update
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - report any failure to caller
        sys.stderr.write("error: reply failed: %s\n" % exc)
        return 1
    if not out.get("ok"):
        sys.stderr.write("error: %s\n" % out.get("error", "unknown"))
        return 1
    sys.stdout.write("OK %s rev=%s\n" % (args.thread_id, out.get("rev")))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="doc-review local server")
    sub = parser.add_subparsers(dest="command")

    rp = sub.add_parser("reply", help="post a Claude reply to a thread (HTTP to the running server)")
    rp.add_argument("--thread-id", required=True)
    rp.add_argument("--text", required=True)
    rp.add_argument("--target", help="target file path (to derive the default work dir)")
    rp.add_argument("--work-dir", dest="work_dir", help="working dir holding server.url")
    rp.add_argument("--url", help="explicit server base URL (e.g. http://127.0.0.1:5050/)")
    # Optional anchor update (re-point a comment after the edit). All optional;
    # omit them entirely when the commented region didn't move.
    rp.add_argument("--anchor-block-raw", dest="anchor_block_raw",
                    help="moved/rewritten: the FULL raw markdown of the block this comment now points to")
    rp.add_argument("--anchor-selected-text", dest="anchor_selected_text",
                    help="range comments: the new selected phrase after the edit")
    rp.add_argument("--anchor-text", dest="anchor_text",
                    help="optional updated display snippet for the anchor")
    rp.add_argument("--anchor-gone", dest="anchor_gone", action="store_true",
                    help="the commented region was deleted: show no marker (sidebar notes it)")
    rp.set_defaults(func=reply_cmd)

    # default (serve) options on the top-level parser
    parser.add_argument("--target", help="absolute path of the md/html file to review")
    parser.add_argument("--skill-dir", help="absolute path of this skill directory")
    parser.add_argument("--work-dir", dest="work_dir",
                        help="working dir (default: ~/.claude/doc-review/<target-hash>)")
    parser.add_argument("--port", type=int, default=5050)
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--idle-timeout", type=float, default=1800.0)
    return parser


def main(argv) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "command", None) == "reply":
        return args.func(args)
    # serve mode (work-dir is optional now)
    missing = [n for n in ("target", "skill_dir") if not getattr(args, n, None)]
    if missing:
        parser.error("missing required options for serve mode: %s" % ", ".join(missing))
    return run_server(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
