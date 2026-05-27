#!/bin/bash
# agent-manager-launch.sh
# Claude Code の SessionStart hook から呼ばれ、AgentManager(小窓アプリ)が
# 起動していなければ起動する。未ビルドなら release ビルドしてから起動する。
#
# セッション開始を遅延させないため、重い処理（ビルド・起動）はバックグラウンドに
# 逃がして即座に return する。既に起動中なら pgrep だけで終わる（ほぼ無コスト）。

set -euo pipefail

PROJECT_DIR="${HOME}/dotfiles/agent-manager"
BIN="${PROJECT_DIR}/.build/release/AgentManager"
SWIFT="/usr/bin/swift"

# 既に起動中なら何もしない（最頻ケース、即 return）。
if pgrep -f "$BIN" >/dev/null 2>&1; then
  exit 0
fi

# ビルド（未ビルド時のみ）と起動はバックグラウンドで実行し、hook をブロックしない。
{
  if [ ! -x "$BIN" ]; then
    "$SWIFT" build --package-path "$PROJECT_DIR" -c release >/dev/null 2>&1 || exit 0
  fi
  # 二重起動防止のため再チェックしてから launch。
  if ! pgrep -f "$BIN" >/dev/null 2>&1; then
    nohup "$BIN" >/dev/null 2>&1 &
  fi
} >/dev/null 2>&1 &

exit 0
