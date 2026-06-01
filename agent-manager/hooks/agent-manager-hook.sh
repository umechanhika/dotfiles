#!/bin/bash
# agent-manager-hook.sh
# Claude Code の各 hook イベントから呼ばれ、セッションの状態を
# ~/.claude/agent-manager/sessions/<session_id>.json に upsert する。
# 全 hook イベントでこの 1 スクリプトを使い回す（分岐は hook_event_name で行う）。
#
# 依存: python3 のみ（jq 不要）。stdin から hook の JSON を受け取る。
#
# ホスト判定: このターミナルを内包する GUIアプリの bundle id を特定する
#   （iTerm2=com.googlecode.iterm2 / Android Studio=com.google.android.studio 等）。
#   プロセスツリーを遡り、最も近い祖先 .app の Info.plist から bundle id を読む。
#   __CFBundleIdentifier や ITERM_SESSION_ID は当てにしない: Android Studio を
#   iTerm2 から `studio .` 等で起動すると、AS の統合ターミナル子プロセスが
#   iTerm2 の値を継承して誤判定するため（実測で確認済み）。
#   iterm_session_id は host が iTerm2 と確定したときだけ記録する。

set -euo pipefail

STORE_DIR="${HOME}/.claude/agent-manager/sessions"
mkdir -p "$STORE_DIR"

# プロセスツリーを遡り、ターミナルを内包する最も近い .app の bundle id を解決する。
# Frameworks 配下のヘルパーは無視し、メイン実行体（/Contents/MacOS/）のみ採用する。
resolve_host_bundle() {
  local pid="$1" cmd app
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    cmd="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *.app/Contents/MacOS/*)
        app="${cmd%%.app/Contents/MacOS/*}.app"
        /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
          "$app/Contents/Info.plist" 2>/dev/null && return
        ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  done
}

# セッションを内包する GUIアプリの bundle id。
HOST_BUNDLE="$(resolve_host_bundle "$$" || true)"

# このセッションを所有する claude 本体プロセスの PID を解決する。
# フック自身($$)は短命なので、$PPID から親を遡り comm が claude らしい最も
# 近い祖先を採用する。見つからなければ $PPID にフォールバックする。
# SessionStore 側はこの PID の生存で「孤児セッション」を掃除する。
resolve_owner_pid() {
  local pid="$1" cmd
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    cmd="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *claude*) echo "$pid"; return ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  done
}
OWNER_PID="$(resolve_owner_pid "$PPID" || true)"
if [ -z "$OWNER_PID" ]; then OWNER_PID="$PPID"; fi
# PID 再利用での誤判定を防ぐため起動時刻も記録（ps の lstart）。
# LC_ALL=C で固定: lstart はロケール依存（ja_JP は "月  6/ 1..."、C は "Mon Jun  1..."）。
# 記録側(このフック)と判定側(SessionStore)でロケールが食い違うと、同一プロセスでも
# 文字列が一致せず生きたセッションを孤児誤判定する。Android Studio を Finder/Dock 起動
# するとターミナルに LANG が伝播せず（LC_CTYPE=UTF-8 のみ）英語表記になり、ja_JP の
# アプリ側と食い違って Android Studio のセッションが消えていた。
OWNER_STARTED_AT="$(LC_ALL=C ps -o lstart= -p "$OWNER_PID" 2>/dev/null | sed 's/^ *//;s/ *$//' || true)"
# フォールバック1: 環境変数（プロセスツリー解決に失敗した場合のみ）。
if [ -z "$HOST_BUNDLE" ]; then HOST_BUNDLE="${__CFBundleIdentifier:-}"; fi
# フォールバック2: TERM_PROGRAM。
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

STORE_DIR="$STORE_DIR" ITERM_GUID="$ITERM_GUID" HOST_BUNDLE="$HOST_BUNDLE" \
OWNER_PID="$OWNER_PID" OWNER_STARTED_AT="$OWNER_STARTED_AT" \
HOOK_INPUT="$HOOK_INPUT" /usr/bin/python3 - <<'PY'
import os, sys, json, datetime

store_dir = os.environ["STORE_DIR"]
iterm_guid = os.environ.get("ITERM_GUID", "")
host_bundle = os.environ.get("HOST_BUNDLE", "")
try:
    owner_pid = int(os.environ.get("OWNER_PID", "") or 0) or None
except ValueError:
    owner_pid = None
owner_started_at = os.environ.get("OWNER_STARTED_AT", "")

try:
    payload = json.loads(os.environ.get("HOOK_INPUT") or "{}")
except Exception:
    payload = {}

session_id = payload.get("session_id") or "unknown"
cwd = payload.get("cwd") or os.getcwd()
event = payload.get("hook_event_name") or ""

# hook イベント → state マッピング（唯一の調整ポイント）
#   waiting    = 確認待ち。ユーザーの確認・操作が必要でClaudeがブロックされている
#                （ツール許可待ち / プラン承認待ち / 選択肢回答待ち 等を包括）
#   done       = 応答完了（Claudeのターンが終わり、次の指示待ち）
#   processing = 処理中
#   idle       = 開始直後でまだ何もしていない
#
# 注意: Notification はここに含めない。notification_type で
#   permission_prompt(=確認待ち) と idle_prompt(=完了後の放置) を区別し、
#   後段で個別に state を決める（idle_prompt を waiting に化けさせないため）。
#   なお ExitPlanMode は permission_prompt の Notification も来るが、
#   AskUserQuestion は Notification を発火しない（PreToolUse のみ）。両者とも
#   即ユーザー操作待ちなので、下の else 節の PreToolUse 分岐で waiting に倒す。
STATE_BY_EVENT = {
    "SessionStart":     "idle",
    "UserPromptSubmit": "processing",
    "PreToolUse":       "processing",
    "PostToolUse":      "processing",
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

# 既存ファイルがあれば値を引き継ぐ（後続 hook で env が空でも保持）。
# Notification の種別不明時のフォールバック判定にも使うため先に読む。
existing = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            existing = json.load(f)
    except Exception:
        existing = {}

# state を決定する。Notification だけは notification_type で分岐する。
if event == "Notification":
    notification_type = payload.get("notification_type") or ""
    if notification_type == "idle_prompt":
        # 完了後に放置されているだけ。応答完了(緑)を維持し確認待ちにしない。
        state = "done"
    elif notification_type in ("permission_prompt", "elicitation_dialog"):
        # 許可待ち / プラン承認待ち / 選択肢回答待ち / MCP入力待ち = 確認待ち。
        state = "waiting"
    else:
        # auth_success 等の情報通知や種別不明: 現在の状態をそのまま維持。
        state = existing.get("state") or "processing"
else:
    tool = payload.get("tool_name", "")
    # AskUserQuestion / ExitPlanMode は即ユーザー操作待ちでブロックする。
    # 特に AskUserQuestion は Notification を一切発火しない（PreToolUse のみ）ため、
    # ここで waiting に倒さないと直前の processing のまま固定されてしまう。
    # 回答/承認後は PostToolUse(processing) が来て自然に抜ける。
    if event == "PreToolUse" and tool in ("AskUserQuestion", "ExitPlanMode"):
        state = "waiting"
    else:
        state = STATE_BY_EVENT.get(event, "processing")

now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")

# state_since: 同じ state が続く間は開始時刻を引き継ぎ、state が変わったら今にする。
# 経過時間表示の基準。updated_at(=最終活動時刻)と違い、処理中に hook が連続発火しても
# リセットされず、done のまま idle_prompt が来てもリセットされない。
if existing.get("state") == state:
    state_since = existing.get("state_since") or existing.get("updated_at") or now
else:
    state_since = now

host = host_bundle or existing.get("host_bundle_id", "")
is_iterm = host == "com.googlecode.iterm2"
# iTerm2 のときだけ GUID を保持。他ホストでは継承された偽値を書かない。
iterm_id = (iterm_guid or existing.get("iterm_session_id", "")) if is_iterm else ""

# created_at は初回作成時刻を保持（表示順を起動順で固定するため）。
created = existing.get("created_at") or now

# 所有 PID / 起動時刻も初回値を保持（後続フックで env が空でも維持）。
owner_pid = owner_pid or existing.get("owner_pid")
owner_started_at = owner_started_at or existing.get("owner_started_at", "")

record = {
    "session_id": session_id,
    "cwd": cwd,
    "label": os.path.basename(cwd.rstrip("/")) or cwd,
    "state": state,
    "host_bundle_id": host,
    "iterm_session_id": iterm_id,
    "owner_pid": owner_pid,
    "owner_started_at": owner_started_at,
    "created_at": created,
    "updated_at": now,
    "state_since": state_since,
}

tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(record, f, ensure_ascii=False)
os.replace(tmp, path)
PY
