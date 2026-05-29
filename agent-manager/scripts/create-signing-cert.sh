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

# 同名証明書が「ちょうど1件」かつ「有効な codesigning ID」のときだけ何もしない。
# 有効IDの有無だけで早期 return すると、重複証明書が残っていても掃除されず
# （build-app.sh が名前指定署名なら ambiguous を誘発する温床になる）、再ビルド時の
# 署名すげ替え→TCC権限無効化を招く。そのため件数も確認し、重複があれば作り直す。
# 0件のとき grep -c は exit 1 を返すため、set -e で落ちないよう || true でガードする。
CERT_COUNT="$(/usr/bin/security find-certificate -a -c "$SIGN_ID" "$KEYCHAIN" 2>/dev/null \
  | grep -c '"labl"' || true)"
if [ "$CERT_COUNT" = "1" ] \
  && /usr/bin/security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_ID"; then
  echo "ok: 署名ID '$SIGN_ID' は既に有効です（証明書1件）。"
  exit 0
fi
if [ "$CERT_COUNT" -gt 1 ] 2>/dev/null; then
  echo "info: 同名証明書が ${CERT_COUNT} 件あります（重複は ambiguous の原因）。掃除して作り直します。"
fi

# 過去の失敗で残った同名証明書（重複は codesign が ambiguous エラーになる）を
# 全て削除してから作り直す。delete-identity が鍵+証明書を消す。
echo "info: 既存の '$SIGN_ID' 証明書があれば掃除します（認証を求められることがあります）。"
while /usr/bin/security find-certificate -c "$SIGN_ID" "$KEYCHAIN" >/dev/null 2>&1; do
  /usr/bin/security delete-identity -c "$SIGN_ID" "$KEYCHAIN" >/dev/null 2>&1 \
    || /usr/bin/security delete-certificate -c "$SIGN_ID" "$KEYCHAIN" >/dev/null 2>&1 \
    || break
done

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
