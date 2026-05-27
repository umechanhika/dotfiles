#!/bin/bash
# agent-manager-hook.sh
# Claude Code の各 hook イベントから呼ばれ、セッションの状態を
# ~/.claude/agent-manager/sessions/<session_id>.json に upsert する。
# 全 hook イベントでこの 1 スクリプトを使い回す（分岐は hook_event_name で行う）。
#
# 依存: python3 のみ（jq 不要）。stdin から hook の JSON を受け取る。
#
# ホスト判定: __CFBundleIdentifier がセッションを起動した GUIアプリの bundle id を持つ
#   （iTerm2=com.googlecode.iterm2 / Android Studio=com.google.android.studio 等）。
#   これでフォーカス先アプリを特定する。iterm_session_id は iTerm2 のときだけ記録する
#   （Android Studio 等が iTerm2 から起動され ITERM_SESSION_ID を継承していても、
#    iTerm2 に存在しない偽 GUID を書かないため）。

set -euo pipefail

STORE_DIR="${HOME}/.claude/agent-manager/sessions"
mkdir -p "$STORE_DIR"

# セッションを起動したアプリの bundle id。
HOST_BUNDLE="${__CFBundleIdentifier:-}"
# フォールバック（__CFBundleIdentifier が無い環境向け）。
if [ -z "$HOST_BUNDLE" ]; then
  case "${TERM_PROGRAM:-}" in
    iTerm.app) HOST_BUNDLE="com.googlecode.iterm2" ;;
  esac
fi

# ITERM_SESSION_ID="w0t2p0:GUID" → GUID 部分のみ
ITERM_GUID="${ITERM_SESSION_ID##*:}"

# stdin（hook の JSON）を変数に取り込む。
# ※ python をヒアドキュメントで渡すと python の stdin がヒアドキュメントに
#   なり hook の JSON を読めないため、env 経由で渡す。
HOOK_INPUT="$(cat)"

STORE_DIR="$STORE_DIR" ITERM_GUID="$ITERM_GUID" HOST_BUNDLE="$HOST_BUNDLE" HOOK_INPUT="$HOOK_INPUT" /usr/bin/python3 - <<'PY'
import os, sys, json, datetime

store_dir = os.environ["STORE_DIR"]
iterm_guid = os.environ.get("ITERM_GUID", "")
host_bundle = os.environ.get("HOST_BUNDLE", "")

try:
    payload = json.loads(os.environ.get("HOOK_INPUT") or "{}")
except Exception:
    payload = {}

session_id = payload.get("session_id") or "unknown"
cwd = payload.get("cwd") or os.getcwd()
event = payload.get("hook_event_name") or ""

# hook イベント → state マッピング（唯一の調整ポイント）
#   waiting    = 明確なユーザーアクション待ち（権限プロンプト等、Claudeがブロックされている）
#   done       = 応答完了（Claudeのターンが終わり、次の指示待ち）
#   processing = 処理中
#   idle       = 開始直後でまだ何もしていない
STATE_BY_EVENT = {
    "SessionStart":     "idle",
    "UserPromptSubmit": "processing",
    "PreToolUse":       "processing",
    "PostToolUse":      "processing",
    "Notification":     "waiting",
    "Stop":             "done",
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

# 既存ファイルがあれば値を引き継ぐ（後続 hook で env が空でも保持）
existing = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            existing = json.load(f)
    except Exception:
        existing = {}

host = host_bundle or existing.get("host_bundle_id", "")
is_iterm = host == "com.googlecode.iterm2"
# iTerm2 のときだけ GUID を保持。他ホストでは継承された偽値を書かない。
iterm_id = (iterm_guid or existing.get("iterm_session_id", "")) if is_iterm else ""

# created_at は初回作成時刻を保持（表示順を起動順で固定するため）。
created = existing.get("created_at") or now

record = {
    "session_id": session_id,
    "cwd": cwd,
    "label": os.path.basename(cwd.rstrip("/")) or cwd,
    "state": state,
    "host_bundle_id": host,
    "iterm_session_id": iterm_id,
    "created_at": created,
    "updated_at": now,
}

tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(record, f, ensure_ascii=False)
os.replace(tmp, path)
PY
