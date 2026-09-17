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
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional, Tuple

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
    baseline_path = os.path.join(work_dir, "baseline.json")

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
        BASELINE_PATH=baseline_path,
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


def _resolve_work_dir(args: argparse.Namespace) -> Optional[str]:
    # Shared by every subcommand that needs the on-disk work dir, not just the
    # server's URL (e.g. `stop` also needs it to find server.pid). Returns
    # None when the caller only gave --url (nothing to derive a work dir from).
    if args.work_dir:
        return os.path.realpath(os.path.expanduser(args.work_dir))
    if args.target:
        return default_work_dir(os.path.realpath(args.target))
    return None


def _resolve_base_url(args: argparse.Namespace) -> Optional[str]:
    # Resolve the server URL: explicit --url, else --work-dir, else default from --target.
    # Shared by every subcommand that talks to a running server (reply,
    # reply-batch, stop) so they all fail the same way when it isn't running.
    if args.url:
        return args.url
    work = _resolve_work_dir(args)
    if not work:
        sys.stderr.write("error: one of --url / --work-dir / --target is required\n")
        return None
    base = _read_server_url(work)
    if not base:
        sys.stderr.write("error: server.url not found (is the server running?) in %s\n" % work)
        return None
    return base


def reply_cmd(args: argparse.Namespace) -> int:
    base = _resolve_base_url(args)
    if not base:
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
    if args.anchor_table_raw is not None:
        anchor_update["table_raw"] = args.anchor_table_raw
    if args.anchor_row is not None:
        anchor_update["row"] = args.anchor_row
    if args.anchor_col is not None:
        anchor_update["col"] = args.anchor_col
    if args.anchor_section is not None:
        anchor_update["section"] = args.anchor_section
    if args.anchor_header_text is not None:
        anchor_update["header_text"] = args.anchor_header_text
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


def reply_batch_cmd(args: argparse.Namespace) -> int:
    # Load-then-send, no partial-batch salvage on a bad file: a malformed
    # --file means the caller doesn't know what got sent, which is exactly
    # the ambiguity a batch command is supposed to remove.
    try:
        with open(args.file, "r", encoding="utf-8") as fh:
            replies = json.load(fh)
    except OSError as exc:
        sys.stderr.write("error: cannot read %s: %s\n" % (args.file, exc))
        return 2
    except ValueError as exc:
        sys.stderr.write("error: invalid JSON in %s: %s\n" % (args.file, exc))
        return 2
    if not isinstance(replies, list) or not replies:
        sys.stderr.write("error: %s must contain a non-empty JSON array\n" % args.file)
        return 2

    base = _resolve_base_url(args)
    if not base:
        return 2
    endpoint = base.rstrip("/") + "/threads/reply-batch"
    body = json.dumps({"replies": replies}).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - report any failure to caller
        sys.stderr.write("error: reply-batch failed: %s\n" % exc)
        return 1
    if not out.get("ok"):
        sys.stderr.write("error: %s\n" % out.get("error", "unknown"))
        return 1
    sys.stdout.write("OK %d replies rev=%s\n" % (len(out.get("applied") or []), out.get("rev")))
    return 0


# Bundle id -> AppleScript application name, for the browsers we know how to
# drive (both expose a tabs/windows scripting dictionary). Anything else is
# refused rather than guessed at, per the "no fallback implementations" rule:
# a silently-wrong browser automated is worse than a clear, actionable error.
_BROWSER_APPS = {
    "com.google.chrome": "Google Chrome",
    "com.apple.safari": "Safari",
}


def _default_browser_bundle_id() -> Optional[str]:
    plist = os.path.expanduser(
        "~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"
    )
    try:
        out = subprocess.run(
            ["plutil", "-extract", "LSHandlers", "json", "-o", "-", plist],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        handlers = json.loads(out.stdout)
    except ValueError:
        return None
    for h in handlers:
        if h.get("LSHandlerURLScheme") == "http":
            return h.get("LSHandlerRoleAll")
    return None


def _run_osascript(script: str) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)


def _close_browser_tabs(base_url: str) -> Tuple[str, object]:
    # Returns ("closed", (count, app_name)) | ("notice", message) | ("error", message).
    bundle_id = _default_browser_bundle_id()
    if bundle_id not in _BROWSER_APPS:
        return ("error", "unsupported default browser for tab close: %s" % bundle_id)
    app_name = _BROWSER_APPS[bundle_id]

    running = _run_osascript('application "%s" is running' % app_name)
    if running.returncode != 0:
        return ("error", running.stderr.strip() or ("failed to query " + app_name))
    if running.stdout.strip() != "true":
        # Nothing to close — not an error, the tab (if any) is already gone.
        return ("notice", "no matching tab for %s (already closed?)" % base_url)

    escaped_url = base_url.replace("\\", "\\\\").replace('"', '\\"')
    script = '''
    tell application "%s"
      set closedCount to 0
      repeat with w in windows
        set tabList to every tab of w
        repeat with t in tabList
          try
            if (URL of t) starts with "%s" then
              close t
              set closedCount to closedCount + 1
            end if
          end try
        end repeat
      end repeat
    end tell
    return closedCount as string
    ''' % (app_name, escaped_url)

    result = _run_osascript(script)
    if result.returncode != 0:
        # e.g. -1743: user declined the automation permission dialog.
        return ("error", result.stderr.strip() or "osascript failed")
    try:
        count = int(result.stdout.strip())
    except ValueError:
        return ("error", "unexpected osascript output: %r" % result.stdout)
    if count == 0:
        return ("notice", "no matching tab for %s (already closed?)" % base_url)
    return ("closed", (count, app_name))


def _stop_server_process(work_dir: str) -> Tuple[str, object]:
    # Returns ("stopped", pid) | ("notice", message).
    pid_path = os.path.join(work_dir, "server.pid")
    try:
        with open(pid_path, "r", encoding="utf-8") as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return ("notice", "server already stopped")
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return ("notice", "server already stopped")
    except OSError as exc:
        return ("notice", "server already stopped (%s)" % exc)
    return ("stopped", pid)


def stop_cmd(args: argparse.Namespace) -> int:
    base = _resolve_base_url(args)
    if not base:
        return 2

    # Tab close first: once the server is down, the tab shows a connection
    # error page instead of the review UI, which breaks URL-prefix matching.
    exit_code = 0
    if args.keep_tab:
        sys.stdout.write("notice: --keep-tab given, leaving the browser tab open\n")
    else:
        kind, payload = _close_browser_tabs(base)
        if kind == "closed":
            n, browser = payload
            sys.stdout.write("closed %d tab(s) in %s\n" % (n, browser))
        elif kind == "notice":
            sys.stdout.write("notice: %s\n" % payload)
        else:
            sys.stderr.write("error: %s\n" % payload)
            exit_code = 1

    # Server stop always runs, regardless of the tab-close outcome — leaving
    # the server alive is worse than leaving a stray tab open.
    work = _resolve_work_dir(args)
    if work:
        skind, spayload = _stop_server_process(work)
        if skind == "notice":
            sys.stdout.write("notice: %s\n" % spayload)
        else:
            sys.stdout.write("server stopped (pid %s)\n" % spayload)
    else:
        sys.stdout.write("notice: could not determine work dir (need --target or --work-dir); server left running\n")

    return exit_code


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
    # Table-cell anchors only (see references/anchoring.md). block_raw for a
    # cell is the row's raw source line; these pin down which cell on it.
    rp.add_argument("--anchor-table-raw", dest="anchor_table_raw",
                    help="cell comments: the FULL raw markdown of the table this comment's cell is in")
    rp.add_argument("--anchor-row", dest="anchor_row", type=int,
                    help="cell comments: 0-based data-row index after the edit (-1 for the header row)")
    rp.add_argument("--anchor-col", dest="anchor_col", type=int,
                    help="cell comments: 0-based column index after the edit")
    rp.add_argument("--anchor-section", dest="anchor_section", choices=["header", "body"],
                    help="cell comments: which part of the table the cell is in after the edit")
    rp.add_argument("--anchor-header-text", dest="anchor_header_text",
                    help="cell comments: the (possibly renamed) column header text")
    rp.add_argument("--anchor-gone", dest="anchor_gone", action="store_true",
                    help="the commented region was deleted: show no marker (sidebar notes it)")
    rp.set_defaults(func=reply_cmd)

    rb = sub.add_parser("reply-batch",
                         help="post multiple Claude replies in one request (HTTP to the running server)")
    rb.add_argument("--file", required=True,
                     help="JSON file: a top-level array of "
                          "{thread_id, text, anchor_update?} objects")
    rb.add_argument("--target", help="target file path (to derive the default work dir)")
    rb.add_argument("--work-dir", dest="work_dir", help="working dir holding server.url")
    rb.add_argument("--url", help="explicit server base URL (e.g. http://127.0.0.1:5050/)")
    rb.set_defaults(func=reply_batch_cmd)

    sp = sub.add_parser("stop", help="close the review's browser tab, then stop the server")
    sp.add_argument("--target", help="target file path (to derive the default work dir)")
    sp.add_argument("--work-dir", dest="work_dir", help="working dir holding server.url/server.pid")
    sp.add_argument("--url", help="explicit server base URL (e.g. http://127.0.0.1:5050/)")
    sp.add_argument("--keep-tab", dest="keep_tab", action="store_true",
                     help="stop the server without touching the browser tab")
    sp.set_defaults(func=stop_cmd)

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
    # Any subcommand (reply, reply-batch, ...) sets `func` via set_defaults();
    # plain serve mode has no subcommand and thus no `func` at all. Dispatch
    # on that instead of naming each subcommand here, so adding a new one
    # doesn't require remembering to extend this check too.
    if getattr(args, "func", None) is not None:
        return args.func(args)
    # serve mode (work-dir is optional now)
    missing = [n for n in ("target", "skill_dir") if not getattr(args, n, None)]
    if missing:
        parser.error("missing required options for serve mode: %s" % ", ".join(missing))
    return run_server(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
