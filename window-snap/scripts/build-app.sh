#!/bin/bash
# build-app.sh
# WindowSnap を release ビルドし、最小の .app バンドルに包む。
# .app 化で安定したバンドルID/署名要件を持たせ、アクセシビリティ(TCC)許可が
# リビルド間で維持されるようにする。LSUIElement=true で Dock 非表示（メニューバー常駐）。
#
# 署名は安定した名前付き自己署名コード署名IDで行う。
# ad-hoc 署名(--sign -)は cdhash ベースの署名要件になるため、リビルドのたびに
# macOS が「別アプリ」とみなし、付与済みのアクセシビリティ権限が無効化される。
# 名前付き ID なら署名要件が安定し、権限が維持される。
# 署名IDが無ければ ad-hoc にフォールバックせず明確に失敗させ（問題を握り潰さない）、
# ~/.local/state/window-snap/build.log にエラーを残す。
# 証明書の作り方は README の「コード署名証明書の作成」を参照。
#
# ビルド＆署名は staging ディレクトリで行い、成功したときだけ本番 .app を差し替える。
# これにより、ビルド/署名に失敗しても既存の動作中バイナリが壊れない
# （ランチャー windowsnap-launch.sh が KeepAlive 下で再起動ループに陥らないための安全策）。
#
# 成果物: <project>/.build/WindowSnap.app（.build配下なので gitignore 済み）

set -euo pipefail

PROJECT_DIR="${HOME}/dotfiles/window-snap"
SWIFT="/usr/bin/swift"
BIN="${PROJECT_DIR}/.build/release/WindowSnap"
APP="${PROJECT_DIR}/.build/WindowSnap.app"
STAGE="${PROJECT_DIR}/.build/WindowSnap.app.staging"
BUNDLE_ID="com.umechanhika.windowsnap"

# 1. release ビルド
"$SWIFT" build --package-path "$PROJECT_DIR" -c release

# 2. staging にバンドル構造を作成（本番 $APP はまだ触らない）
rm -rf "$STAGE"
mkdir -p "$STAGE/Contents/MacOS"

# 3. Info.plist（バンドルID・LSUIElement で Dock 非表示）
#    NSAppleEventsUsageDescription は不要（AppleEvents を使わない）。
cat > "$STAGE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>WindowSnap</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>WindowSnap</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

# 4. バイナリを配置
cp "$BIN" "$STAGE/Contents/MacOS/WindowSnap"

# 5. 署名（安定した名前付きIDで署名する。TCC 付与をリビルド間で維持するため）
#    アドホック署名へのフォールバックはしない: 黙って ad-hoc に落ちると
#    「リビルドで権限が消える」問題に気付けないため、署名IDが無ければ明確に失敗させる。
SIGN_ID="WindowSnap Code Signing"
BUILD_LOG="${HOME}/.local/state/window-snap/build.log"
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
  rm -rf "$STAGE"   # 既存の本番 $APP は壊さない（staging だけ後始末）。
  exit 1
fi
if ! /usr/bin/codesign --force --sign "$SIGN_HASH" "$STAGE" 2>>"$BUILD_LOG"; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') ERROR: codesign に失敗しました（詳細は上記）。" \
    | tee -a "$BUILD_LOG" >&2
  rm -rf "$STAGE"   # 既存の本番 $APP は壊さない（staging だけ後始末）。
  exit 1
fi

# 6. 成功時のみ本番 .app を差し替える（ここで初めて $APP に触れる）。
rm -rf "$APP"
mv "$STAGE" "$APP"

echo "built: $APP"
