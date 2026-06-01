#!/bin/bash
# windowsnap-launch.sh
# LaunchAgent の起動コマンドとして launchd から呼ばれるランチャー。
#
# ソース（Sources / Package.swift / scripts）がビルド済みバイナリより新しければ再ビルドし、
# 最後に exec で本体プロセスに置き換える（launchd が本体を直接監視＝KeepAlive が効く）。
# これにより agent-manager と同様、git pull 後は「再ログイン or `launchctl kickstart`」
# だけで最新コードが自動反映される（ファイル保存の瞬間ではなく、次回起動時に反映）。
#
# ビルドに失敗しても既存バイナリで起動を続行する（build-app.sh は成功時のみ差し替えるため、
# 失敗時も直前の動作バイナリが残る）。これで KeepAlive による再起動ループを避ける。
#
# 標準出力/標準エラーは launchd により StandardErrorPath（stderr.log）へ流れる。

PROJECT_DIR="${HOME}/dotfiles/window-snap"
APP="${PROJECT_DIR}/.build/WindowSnap.app"
BIN="${APP}/Contents/MacOS/WindowSnap"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') windowsnap-launch: $*" >&2; }

# ソースがバイナリより新しい、またはバイナリが無ければ再ビルドが必要。
needs_build() {
  [ ! -x "$BIN" ] && return 0
  [ -n "$(find "$PROJECT_DIR/Sources" "$PROJECT_DIR/Package.swift" "$PROJECT_DIR/scripts" \
            -newer "$BIN" 2>/dev/null | head -n 1)" ]
}

if needs_build; then
  log "ソースが新しいため再ビルドします。"
  if bash "$PROJECT_DIR/scripts/build-app.sh" >&2; then
    log "再ビルド成功。"
  else
    log "再ビルド失敗。既存バイナリで起動を続行します（詳細は build.log）。"
  fi
fi

if [ ! -x "$BIN" ]; then
  log "起動可能なバイナリがありません。create-signing-cert.sh と build-app.sh を確認してください。"
  exit 1
fi

# 本体に置き換える。これ以降のプロセスを launchd が監視する。
exec "$BIN"
