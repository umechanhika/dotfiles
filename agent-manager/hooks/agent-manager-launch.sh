#!/bin/bash
# agent-manager-launch.sh
# Claude Code の SessionStart hook から呼ばれ、AgentManager(小窓アプリ)が
# 起動していなければ起動する。未ビルド、またはソースが成果物より新しければ
# .app バンドルを作り直してから起動する。
#
# .app 経由で `open` 起動することで、バンドルIDに紐づく安定した Automation(TCC)
# 許可が得られ、クリック時の iTerm2 フォーカスが確実に効く。
#
# セッション開始を遅延させないため、重い処理（ビルド・起動）はバックグラウンドに
# 逃がして即座に return する。既に起動中なら pgrep だけで終わる（ほぼ無コスト）。
#
# リビルド判定は「プロセス未起動の新規起動パス」でのみ走る（pgrep の早期 return
# より後）。起動中の古いプロセスには触らない＝AgentManager は全セッション終了で
# 自動 exit するので、次の新規起動時に新コードへ自然に切り替わる。

set -euo pipefail

PROJECT_DIR="${HOME}/dotfiles/agent-manager"
APP="${PROJECT_DIR}/.build/AgentManager.app"
APP_BIN="${APP}/Contents/MacOS/AgentManager"

# 成果物(.app内バイナリ)が無い、またはビルド入力の方が新しければ要リビルド。
# .build/ は gitignore のため git pull ではソースだけ更新され、成果物は古いまま
# 残る。pull は更新ファイルの mtime を現在時刻に更新するので、ソースの方が新しい
# ことを検知して自動でリビルドする（pull した新コードで起動するため）。
needs_build() {
  [ ! -x "$APP_BIN" ] && return 0
  # ビルド入力: Sources(全.swift) / Package.swift / scripts(build-app.sh・make-icon.swift)。
  # build-app.sh は最後に codesign --force で .app 内バイナリを再署名する(mtime更新)ため、
  # ビルド後は $APP_BIN が全入力より新しくなり、変更が無ければ false-positive は起きない。
  # -print -quit で最初の 1 件で打ち切るので軽い。
  if [ -n "$(/usr/bin/find \
        "${PROJECT_DIR}/Sources" \
        "${PROJECT_DIR}/Package.swift" \
        "${PROJECT_DIR}/scripts" \
        -newer "$APP_BIN" -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  return 1
}

# 既に起動中なら何もしない（最頻ケース、即 return）。
if pgrep -f "$APP_BIN" >/dev/null 2>&1; then
  exit 0
fi

# ビルド（必要時のみ）と起動はバックグラウンドで実行し、hook をブロックしない。
{
  if needs_build; then
    "${PROJECT_DIR}/scripts/build-app.sh" >/dev/null 2>&1 || exit 0
  fi
  # 二重起動防止のため再チェックしてから launch。
  # `open -g` でフォーカスを奪わずに起動（小窓は最前面フローティングなので見える）。
  if ! pgrep -f "$APP_BIN" >/dev/null 2>&1; then
    /usr/bin/open -g "$APP" >/dev/null 2>&1 || /usr/bin/open "$APP" >/dev/null 2>&1
  fi
} >/dev/null 2>&1 &

exit 0
