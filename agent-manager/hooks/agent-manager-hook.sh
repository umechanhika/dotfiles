#!/bin/bash
# agent-manager-hook.sh
# Claude Code の各 hook イベントから呼ばれ、セッションの状態を
# ~/.claude/agent-manager/sessions/<session_id>.json に upsert する。
# 全 hook イベントでこの 1 スクリプトを使い回す（分岐は hook_event_name で行う）。
#
# 依存: python3 のみ（jq 不要）。stdin から hook の JSON を受け取る。
# iterm_session_id は環境変数 ITERM_SESSION_ID（形式 wNtMpK:GUID）の : 以降。

set -euo pipefail

STORE_DIR="${HOME}/.claude/agent-manager/sessions"
mkdir -p "$STORE_DIR"

# ITERM_SESSION_ID="w0t2p0:GUID" → GUID 部分のみ
ITERM_GUID="${ITERM_SESSION_ID##*:}"

# stdin（hook の JSON）を変数に取り込む。
# ※ python をヒアドキュメントで渡すと python の stdin がヒアドキュメントに
#   なり hook の JSON を読めないため、env 経由で渡す。
HOOK_INPUT="$(cat)"

STORE_DIR="$STORE_DIR" ITERM_GUID="$ITERM_GUID" HOOK_INPUT="$HOOK_INPUT" /usr/bin/python3 - <<'PY'
import os, sys, json, datetime

store_dir = os.environ["STORE_DIR"]
iterm_guid = os.environ.get("ITERM_GUID", "")

try:
    payload = json.loads(os.environ.get("HOOK_INPUT") or "{}")
except Exception:
    payload = {}

session_id = payload.get("session_id") or "unknown"
cwd = payload.get("cwd") or os.getcwd()
event = payload.get("hook_event_name") or ""

# hook イベント → state マッピング（唯一の調整ポイント）
STATE_BY_EVENT = {
    "SessionStart":     "idle",
    "UserPromptSubmit": "processing",
    "PreToolUse":       "processing",
    "PostToolUse":      "processing",
    "Notification":     "waiting",
    "Stop":             "idle",
}

path = os.path.join(store_dir, f"{session_id}.json")

# SessionEnd はファイル削除
if event == "SessionEnd":
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    sys.exit(0)

state = STATE_BY_EVENT.get(event, "processing")
now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")

# 既存ファイルがあれば iterm_session_id を引き継ぐ（後続 hook で env が空でも保持）
existing = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            existing = json.load(f)
    except Exception:
        existing = {}

record = {
    "session_id": session_id,
    "cwd": cwd,
    "label": os.path.basename(cwd.rstrip("/")) or cwd,
    "state": state,
    "iterm_session_id": iterm_guid or existing.get("iterm_session_id", ""),
    "updated_at": now,
}

tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(record, f, ensure_ascii=False)
os.replace(tmp, path)
PY
