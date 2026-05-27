#!/bin/bash
# build-app.sh
# AgentManager を release ビルドし、最小の .app バンドルに包む。
# .app 化により安定したバンドルID/コード署名を持たせ、iTerm2 を制御する
# Automation(TCC) 許可ダイアログが確実に出る・記憶されるようにする。
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

# 5. ad-hoc 署名（TCC がバンドルを識別できるように）
/usr/bin/codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "built: $APP"
