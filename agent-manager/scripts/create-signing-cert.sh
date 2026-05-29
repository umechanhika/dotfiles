#!/bin/bash
# create-signing-cert.sh
# AgentManager の .app 署名に使う自己署名コード署名証明書を作成し、
# login キーチェーンに取り込んでコード署名用に信頼する（冪等：既にあれば何もしない）。
#
# なぜ必要か:
#   ad-hoc 署名は cdhash ベースの署名要件になり、.app をリビルドするたびに
#   macOS が「別アプリ」とみなして付与済みのアクセシビリティ/Automation 権限を
#   無効化する。安定した名前付き ID で署名すれば署名要件が固定され権限が維持される。
#
# 実行は通常のターミナル（Terminal.app / iTerm2 など）で行うこと。
#   - 信頼設定の追加で macOS の認証ダイアログ（Touch ID / ログインパスワード）が出る。
#   - 鍵アクセス許可(set-key-partition-list)のため login キーチェーンのパスワードを尋ねる
#     （空 Enter でスキップ可。その場合は初回 codesign 時に GUI で「常に許可」を押す）。
#   ※ Claude セッションの `!` 実行はターミナルの対話入力ができないため不可。

set -euo pipefail

SIGN_ID="AgentManager Code Signing"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

# 同名証明書を SHA-1 ハッシュ指定で削除する。名前(-c)指定は同名が複数あると
# ambiguous で失敗し1件も消えないため（重複が増え続ける原因だった）、必ずハッシュで消す。
# 鍵も一緒に消すため delete-identity を優先し、非対応/失敗時は delete-certificate に退避。
delete_cert_by_hash() {
  /usr/bin/security delete-identity -Z "$1" "$KEYCHAIN" >/dev/null 2>&1 \
    || /usr/bin/security delete-certificate -Z "$1" "$KEYCHAIN" >/dev/null 2>&1 \
    || true
}

# 同名証明書の全 SHA-1 ハッシュ。0件でも set -e で落ちないよう取り回す。
ALL_HASHES="$(/usr/bin/security find-certificate -a -c "$SIGN_ID" -Z "$KEYCHAIN" 2>/dev/null \
  | awk '/SHA-1 hash:/ {print $3}')"
CERT_COUNT="$(printf '%s\n' "$ALL_HASHES" | grep -c . || true)"
# build-app.sh と同じ選び方（先頭の有効 codesigning ID）で「温存する有効ID」を1件決める。
KEEP_HASH="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
  | awk -v id="$SIGN_ID" 'index($0, id) {print $2; exit}')"

# 既に「1件だけ・有効」なら何もしない（冪等）。
if [ "$CERT_COUNT" = "1" ] && [ -n "$KEEP_HASH" ]; then
  echo "ok: 署名ID '$SIGN_ID' は既に有効です（証明書1件）。"
  exit 0
fi

# 有効IDが既にあるなら、それを温存して余分な同名証明書だけ削除する。
# 新規作成すると署名IDが変わり TCC（アクセシビリティ/Automation）権限の再付与が必要に
# なるため、既存の有効IDを使い回して単一化する（=付与済み権限を維持できる）。
if [ -n "$KEEP_HASH" ]; then
  echo "info: 有効な署名ID($KEEP_HASH)を温存し、余分な同名証明書を削除します。"
  for h in $ALL_HASHES; do
    [ "$h" = "$KEEP_HASH" ] && continue
    delete_cert_by_hash "$h"
  done
  if /usr/bin/security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_ID"; then
    echo "done: 署名ID '$SIGN_ID' を1件に単一化しました（権限の再付与は不要）。"
    exit 0
  fi
  echo "ERROR: 単一化後に有効な署名IDが見つかりません。" >&2
  exit 1
fi

# 有効IDが1件も無い場合のみ、残っている同名証明書を全て掃除してから作り直す。
if [ -n "$ALL_HASHES" ]; then
  echo "info: 有効な署名IDが無いため、既存の同名証明書を全て掃除して作り直します。"
  for h in $ALL_HASHES; do
    delete_cert_by_hash "$h"
  done
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) 鍵と自己署名証明書（コード署名 EKU 付き）を生成。
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=${SIGN_ID}" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

# 2) PKCS#12 にまとめる。空パスワードの p12 は macOS の security import が
#    MAC 検証に失敗するため、一時的なランダムパスワードを付ける。
P12PW="$(/usr/bin/openssl rand -hex 16)"
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$SIGN_ID" -out "$TMP/cert.p12" -passout "pass:${P12PW}" >/dev/null 2>&1

# 3) login キーチェーンへ取り込む。codesign / security から鍵を使えるよう許可。
/usr/bin/security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "$P12PW" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null

# 4) コード署名用に信頼する。これをしないと自己署名証明書は
#    CSSMERR_TP_NOT_TRUSTED となり find-identity -v -p codesigning に出ない。
#    （macOS の認証ダイアログが一度出る）
echo "info: コード署名用の信頼設定を追加します（認証ダイアログに従ってください）。"
/usr/bin/security add-trusted-cert -r trustRoot -p codeSign \
  -k "$KEYCHAIN" "$TMP/cert.pem"

# 5) 初回 codesign 時の鍵アクセス確認ダイアログを避けるため partition list を設定。
#    login キーチェーンのパスワードが要る。KEYCHAIN_PASSWORD で渡すか、対話入力する。
#    空ならスキップし、初回 codesign 時に GUI で「常に許可」を押す運用にフォールバック。
KCPW="${KEYCHAIN_PASSWORD:-}"
if [ -z "$KCPW" ] && [ -t 0 ]; then
  printf 'login キーチェーンのパスワード（空Enterで GUI 許可にフォールバック）: '
  read -rs KCPW
  echo
fi
if [ -n "$KCPW" ]; then
  /usr/bin/security set-key-partition-list -S apple-tool:,apple: -s \
    -k "$KCPW" "$KEYCHAIN" >/dev/null 2>&1 \
    && echo "ok: partition list を設定しました（codesign は無確認で署名できます）。" \
    || echo "warn: partition list 設定に失敗。初回 codesign 時に GUI 許可が出ます。"
else
  echo "note: パスワード未入力。初回 codesign 時に GUI で『常に許可』を選んでください。"
fi

# 6) 確認。
if /usr/bin/security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_ID"; then
  echo "done: 署名ID '$SIGN_ID' を作成しました。"
  echo "次に: bash scripts/build-app.sh で再ビルドし、アクセシビリティ権限を再付与してください。"
else
  echo "ERROR: 署名IDの作成に失敗しました。" >&2
  exit 1
fi
