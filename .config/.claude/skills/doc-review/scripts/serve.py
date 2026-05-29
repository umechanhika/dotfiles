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
import hashlib
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

# ---------------------------------------------------------------------------
# Shared state (populated in run_server)
# ---------------------------------------------------------------------------

TARGET_PATH = ""          # absolute path of the single file under review
TARGET_NAME = ""          # basename
TARGET_EXT = ""           # "md" | "markdown" | "html" | "htm"
LIB_DIR = ""              # absolute path of the bundled lib/ directory
WORK_DIR = ""             # absolute path of the working dir
INBOX_PATH = ""           # work-dir/inbox.jsonl  (Monitor trigger)
THREADS_PATH = ""         # work-dir/threads.json (source of truth)

# In-memory thread store; the server is the only writer. Guarded by _lock.
STORE = {"rev": 0, "next_id": 1, "threads": []}

_lock = threading.RLock()
_batch_seq = 0
_last_activity = time.time()


def _touch_activity() -> None:
    global _last_activity
    _last_activity = time.time()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _next_batch_id() -> str:
    global _batch_seq
    with _lock:
        _batch_seq += 1
        seq = _batch_seq
    return time.strftime("%Y%m%d-%H%M%S") + ("-%03d" % seq)


def _kind_for_ext(ext: str) -> str:
    return "html" if ext in ("html", "htm") else "markdown"


def default_work_dir(target_abs: str) -> str:
    """Per-target working dir OUTSIDE any repo, persistent across sessions."""
    name = os.path.basename(target_abs)
    safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in name)
    digest = hashlib.sha1(target_abs.encode("utf-8")).hexdigest()[:16]
    base = os.path.expanduser("~/.claude/doc-review")
    return os.path.join(base, "%s-%s" % (safe, digest))


# ---------------------------------------------------------------------------
# Thread store (server-owned)
# ---------------------------------------------------------------------------


def _load_store() -> None:
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


def _save_store() -> None:
    # Caller holds _lock. Atomic write via temp + replace.
    tmp = THREADS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(STORE, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, THREADS_PATH)


def _find_thread(thread_id: str):
    for t in STORE["threads"]:
        if t.get("id") == thread_id:
            return t
    return None


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
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

    # -- routing -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        _touch_activity()
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            return self._serve_lib_file("viewer.html")
        if path.startswith("/lib/"):
            return self._serve_lib_file(path[len("/lib/"):])
        if path == "/source":
            return self._serve_source()
        if path == "/threads":
            return self._serve_threads()
        if path == "/favicon.ico":
            return self._send_bytes(b"", "image/x-icon", status=204)
        return self._send_error_json(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        _touch_activity()
        path = self.path.split("?", 1)[0]
        if path == "/threads/submit":
            return self._submit()
        if path == "/threads/reply":
            return self._reply()
        if path == "/threads/resolve":
            return self._resolve()
        return self._send_error_json(404, "not found")

    # -- GET handlers ------------------------------------------------------

    def _serve_lib_file(self, rel: str) -> None:
        safe = os.path.normpath(rel).lstrip("/")
        full = os.path.realpath(os.path.join(LIB_DIR, safe))
        lib_root = os.path.realpath(LIB_DIR)
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

    def _serve_source(self) -> None:
        try:
            with open(TARGET_PATH, "r", encoding="utf-8") as fh:
                content = fh.read()
            mtime = os.path.getmtime(TARGET_PATH)
        except OSError as exc:
            return self._send_error_json(500, "cannot read source: %s" % exc)
        self._send_json(
            {
                "name": TARGET_NAME,
                "path": TARGET_PATH,
                "ext": TARGET_EXT,
                "kind": _kind_for_ext(TARGET_EXT),
                "mtime": mtime,
                "content": content,
            }
        )

    def _serve_threads(self) -> None:
        with _lock:
            self._send_json({"rev": STORE["rev"], "threads": STORE["threads"]})

    # -- POST handlers -----------------------------------------------------

    def _submit(self) -> None:
        payload = self._read_body()
        if payload is None:
            return self._send_error_json(400, "invalid JSON")
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            return self._send_error_json(400, "no items")

        inbox_items = []
        with _lock:
            for it in items:
                text = (it.get("text") or "").strip()
                if not text:
                    continue
                tid = it.get("thread_id")
                if tid:
                    thread = _find_thread(tid)
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
                    tid = "t%d" % STORE["next_id"]
                    STORE["next_id"] += 1
                    thread = {
                        "id": tid,
                        "anchor": anchor,
                        "status": "open",
                        "messages": [{"role": "user", "text": text, "ts": _now()}],
                    }
                    STORE["threads"].append(thread)
                    is_new = True
                inbox_items.append(
                    {"thread_id": tid, "anchor": anchor, "text": text, "is_new": is_new}
                )

            if not inbox_items:
                return self._send_error_json(400, "no valid items")

            STORE["rev"] += 1
            _save_store()
            rev = STORE["rev"]
            threads_copy = list(STORE["threads"])

        batch = {
            "batch_id": _next_batch_id(),
            "ts": _now(),
            "target": TARGET_PATH,
            "work_dir": WORK_DIR,
            "items": inbox_items,
        }
        try:
            _append_jsonl(INBOX_PATH, batch)
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
        with _lock:
            thread = _find_thread(tid)
            if thread is None:
                return self._send_error_json(404, "thread not found: %s" % tid)
            thread["messages"].append({"role": "claude", "text": text, "ts": _now()})
            if thread.get("status") != "resolved":
                thread["status"] = "answered"
            STORE["rev"] += 1
            _save_store()
            rev = STORE["rev"]
        self._send_json({"ok": True, "rev": rev})

    def _resolve(self) -> None:
        payload = self._read_body()
        if payload is None:
            return self._send_error_json(400, "invalid JSON")
        tid = payload.get("thread_id")
        if not tid:
            return self._send_error_json(400, "thread_id required")
        reopen = bool(payload.get("reopen"))
        with _lock:
            thread = _find_thread(tid)
            if thread is None:
                return self._send_error_json(404, "thread not found: %s" % tid)
            thread["status"] = "open" if reopen else "resolved"
            STORE["rev"] += 1
            _save_store()
            rev = STORE["rev"]
        self._send_json({"ok": True, "rev": rev})


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


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
    return "application/octet-stream"


def _append_jsonl(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _lock:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")


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
        if idle_timeout > 0 and (time.time() - _last_activity) > idle_timeout:
            sys.stderr.write("[doc-review] idle timeout; shutting down\n")
            server.shutdown()
            return


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def run_server(args: argparse.Namespace) -> int:
    global TARGET_PATH, TARGET_NAME, TARGET_EXT, LIB_DIR, WORK_DIR
    global INBOX_PATH, THREADS_PATH

    TARGET_PATH = os.path.realpath(args.target)
    if not os.path.isfile(TARGET_PATH):
        sys.stderr.write("error: target not found: %s\n" % TARGET_PATH)
        return 2
    TARGET_NAME = os.path.basename(TARGET_PATH)
    TARGET_EXT = TARGET_NAME.rsplit(".", 1)[-1].lower() if "." in TARGET_NAME else ""
    if TARGET_EXT not in ("md", "markdown", "html", "htm"):
        sys.stderr.write("error: unsupported file type '.%s' (md/html only)\n" % TARGET_EXT)
        return 2

    LIB_DIR = os.path.realpath(os.path.join(args.skill_dir, "lib"))
    if not os.path.isdir(LIB_DIR):
        sys.stderr.write("error: lib dir not found: %s\n" % LIB_DIR)
        return 2

    work = args.work_dir if args.work_dir else default_work_dir(TARGET_PATH)
    WORK_DIR = os.path.realpath(os.path.expanduser(work))
    os.makedirs(WORK_DIR, exist_ok=True)
    INBOX_PATH = os.path.join(WORK_DIR, "inbox.jsonl")
    THREADS_PATH = os.path.join(WORK_DIR, "threads.json")
    _load_store()  # restore past threads if this file was reviewed before

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
        with open(os.path.join(WORK_DIR, "server.url"), "w", encoding="utf-8") as fh:
            fh.write(url)
        with open(os.path.join(WORK_DIR, "server.pid"), "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        pass
    sys.stdout.write("SERVE_URL=%s\n" % url)
    sys.stdout.write("WORK_DIR=%s\n" % WORK_DIR)
    sys.stdout.write("INBOX=%s\n" % INBOX_PATH)
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
    body = json.dumps({"thread_id": args.thread_id, "text": args.text}).encode("utf-8")
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
