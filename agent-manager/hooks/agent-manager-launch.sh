#!/bin/bash
# agent-manager-launch.sh
# Claude Code の SessionStart hook から呼ばれ、AgentManager(小窓アプリ)が
# 起動していなければ起動する。未ビルドなら .app バンドルを作ってから起動する。
#
# .app 経由で `open` 起動することで、バンドルIDに紐づく安定した Automation(TCC)
# 許可が得られ、クリック時の iTerm2 フォーカスが確実に効く。
#
# セッション開始を遅延させないため、重い処理（ビルド・起動）はバックグラウンドに
# 逃がして即座に return する。既に起動中なら pgrep だけで終わる（ほぼ無コスト）。

set -euo pipefail

PROJECT_DIR="${HOME}/dotfiles/agent-manager"
APP="${PROJECT_DIR}/.build/AgentManager.app"
APP_BIN="${APP}/Contents/MacOS/AgentManager"

# 既に起動中なら何もしない（最頻ケース、即 return）。
if pgrep -f "$APP_BIN" >/dev/null 2>&1; then
  exit 0
fi

# ビルド（未ビルド時のみ）と起動はバックグラウンドで実行し、hook をブロックしない。
{
  if [ ! -x "$APP_BIN" ]; then
    "${PROJECT_DIR}/scripts/build-app.sh" >/dev/null 2>&1 || exit 0
  fi
  # 二重起動防止のため再チェックしてから launch。
  # `open -g` でフォーカスを奪わずに起動（小窓は最前面フローティングなので見える）。
  if ! pgrep -f "$APP_BIN" >/dev/null 2>&1; then
    /usr/bin/open -g "$APP" >/dev/null 2>&1 || /usr/bin/open "$APP" >/dev/null 2>&1
  fi
} >/dev/null 2>&1 &

exit 0
