#!/bin/bash
# build-app.sh
# AgentManager を release ビルドし、最小の .app バンドルに包む。
# .app 化により安定したバンドルIDを持たせ、iTerm2/Android Studio を制御する
# TCC（Automation / アクセシビリティ）許可が確実に記憶されるようにする。
#
# 署名は安定した名前付き ID（自己署名のコード署名証明書）で行う。
# アドホック署名(--sign -)は cdhash ベースの署名要件になるため、リビルドの
# たびに macOS が「別アプリ」とみなし、付与済みのアクセシビリティ権限が
# 無効化される。名前付き ID なら署名要件が安定し、権限が維持される。
# 署名IDが無ければ ad-hoc にフォールバックせず明確に失敗させ（問題を握り潰さない）、
# ~/.claude/agent-manager/build.log にエラーを残す。
# 証明書の作り方は README の「コード署名証明書の作成」を参照。
#
# 成果物: <project>/.build/AgentManager.app（.build配下なので gitignore 済み）

set -euo pipefail

PROJECT_DIR="${HOME}/dotfiles/agent-manager"
SWIFT="/usr/bin/swift"
BIN="${PROJECT_DIR}/.build/release/AgentManager"
APP="${PROJECT_DIR}/.build/AgentManager.app"
BUNDLE_ID="com.umechanhika.agentmanager"
ICNS="${PROJECT_DIR}/.build/AppIcon.icns"

# 1. release ビルド
"$SWIFT" build --package-path "$PROJECT_DIR" -c release

# 1b. アプリアイコンを生成（make-icon.swift より新しい .icns が無ければ作る）
if [ ! -f "$ICNS" ] || [ "${PROJECT_DIR}/scripts/make-icon.swift" -nt "$ICNS" ]; then
  ICONSET="${PROJECT_DIR}/.build/AppIcon.iconset"
  rm -rf "$ICONSET"
  "$SWIFT" "${PROJECT_DIR}/scripts/make-icon.swift" "$ICONSET" >/dev/null
  /usr/bin/iconutil -c icns "$ICONSET" -o "$ICNS"
fi

# 2. バンドル構造を作成
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

# 3. Info.plist（バンドルID・アクセサリ・AppleEvents用途説明）
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>AgentManager</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>AgentManager</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>クリックしたセッションに対応する iTerm2 のペインを前面化するために使用します。</string>
</dict>
</plist>
PLIST

# 4. バイナリを配置
cp "$BIN" "$APP/Contents/MacOS/AgentManager"

# 5. 署名（安定した名前付きIDで署名する。TCC 付与をリビルド間で維持するため）
#    アドホック署名へのフォールバックはしない: 黙って ad-hoc に落ちると
#    「リビルドで権限が消える」問題に気付けないため、署名IDが無ければ明確に失敗させる。
#    失敗はランチャー(launch.sh)が出力を /dev/null に捨てても気付けるよう、
#    専用ログ build.log にも残す。
SIGN_ID="AgentManager Code Signing"
BUILD_LOG="${HOME}/.claude/agent-manager/build.log"
mkdir -p "$(dirname "$BUILD_LOG")"
# 有効な codesigning ID の SHA-1 ハッシュで署名する。名前で署名すると
# 同名の未信頼証明書が残っているとき "ambiguous" になるため、-v に出る
# 有効な 1 件のハッシュを使って一意に指定する。
SIGN_HASH="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
  | awk -v id="$SIGN_ID" 'index($0, id) {print $2; exit}')"
if [ -z "$SIGN_HASH" ]; then
  msg="$(date '+%Y-%m-%dT%H:%M:%S%z') ERROR: 有効な署名ID '$SIGN_ID' が見つかりません。"
  msg="$msg 'bash scripts/create-signing-cert.sh' を実行して証明書を作成してください。"
  echo "$msg" | tee -a "$BUILD_LOG" >&2
  rm -rf "$APP"   # 未署名バンドルを起動させないため後始末する。
  exit 1
fi
if ! /usr/bin/codesign --force --sign "$SIGN_HASH" "$APP" 2>>"$BUILD_LOG"; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') ERROR: codesign に失敗しました（詳細は上記）。" \
    | tee -a "$BUILD_LOG" >&2
  rm -rf "$APP"   # 署名できていないバンドルを起動させないため後始末する。
  exit 1
fi

echo "built: $APP"
