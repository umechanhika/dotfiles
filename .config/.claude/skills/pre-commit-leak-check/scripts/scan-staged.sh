#!/usr/bin/env bash
# scan-staged.sh — ステージ済み差分から「コミット対象一覧」と「機械的な漏えいシグナル」を
# 1 呼び出しで構造化出力する。pre-commit-leak-check スキルの補助入力。
#
# 設計方針（token-reducer/scripts/token-audit.py に倣う）:
# - 生 diff は出さない。コミット対象の要約（増減/バイナリ/サイズ）と、正規表現ヒットの
#   シグナル（カテゴリ・実ファイル行番号・トリミング/マスク済みスニペット）のみを出す。
# - これは「補助」。意味的な A〜D レビューはスキル本体（LLM）が `git diff --staged` を
#   別途読んで行う前提。本スクリプトは見落とし防止のシグナル収集に徹する。
# - 行番号は「新（ステージ）側の実ファイル行」。追加行(+)のみを対象にする（削除行は
#   コミット結果に残らないため誤検知になる）。
#
# 異常系（フォールバック禁止の方針に従い、黙って継続せず即エラー終了）:
#   2: git リポジトリでない / git diff 失敗
#   3: ステージ済み差分が空
set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: git リポジトリではありません。" >&2
  exit 2
fi

numstat="$(git diff --staged --numstat)"
if [ -z "$numstat" ]; then
  echo "ERROR: ステージ済み差分がありません。git add で対象を指定してください。" >&2
  exit 3
fi

branch="$(git branch --show-current 2>/dev/null || true)"
[ -z "$branch" ] && branch="(detached/unborn)"
file_count="$(printf '%s\n' "$numstat" | grep -c '' || true)"

echo "# scan-staged @ ${branch}"
echo "## staged files (${file_count})"
echo "# path<TAB>change<TAB>note   （change は +追加 -削除 / バイナリは bin）"

# コミット対象一覧（増減 / バイナリ / バイナリはステージ blob サイズ）
printf '%s\n' "$numstat" | while IFS=$'\t' read -r add del path; do
  [ -z "${path:-}" ] && continue
  if [ "$add" = "-" ] && [ "$del" = "-" ]; then
    sz="$(git cat-file -s ":$path" 2>/dev/null || true)"
    if [ -n "$sz" ]; then
      kb=$(( (sz + 1023) / 1024 ))
      printf '%s\tbin\t%dKB\n' "$path" "$kb"
    else
      printf '%s\tbin\t-\n' "$path"
    fi
  else
    printf '%s\t+%s -%s\t\n' "$path" "$add" "$del"
  fi
done

echo "## mechanical hits"
echo "# [cat] path:line<TAB>snippet   （cat: D-secret 秘密鍵/トークン署名 / D-secret-word 弱シグナル / D-path 端末パス / B-email メール / D-ip IP）"

# 追加行のみを対象に、新側の実ファイル行番号を hunk ヘッダから復元して正規表現照合。
# awk の区間量指定 {n} は BSD awk 非対応のため使わない。秘密鍵/トークンはマスクする。
hits="$(git diff --staged --unified=0 | awk '
function emit(cat, file, ln, text,   t) {
  t = text
  gsub(/AKIA[0-9A-Z]+/, "AKIA****************", t)
  gsub(/ghp_[A-Za-z0-9]+/, "ghp_****************", t)
  gsub(/gho_[A-Za-z0-9]+/, "gho_****************", t)
  gsub(/xox[baprs]-[A-Za-z0-9-]+/, "xox*-****************", t)
  sub(/^[ \t]+/, "", t)
  if (length(t) > 80) t = substr(t, 1, 80) "…"
  printf "[%s] %s:%d\t%s\n", cat, file, ln, t
}
/^diff --git/ { curfile=""; next }
/^\+\+\+ / {
  p = $0; sub(/^\+\+\+ /, "", p)
  if (p == "/dev/null") { curfile="" } else { sub(/^b\//, "", p); curfile=p }
  next
}
/^@@/ {
  if (match($0, /\+[0-9]+/)) newline = substr($0, RSTART+1, RLENGTH-1) + 0
  next
}
/^---/ { next }
/^-/   { next }                 # 削除行は新側に残らないので対象外
/^\+/ {
  text = substr($0, 2)
  lt = tolower(text)
  if (text ~ /-----BEGIN[A-Z ]*PRIVATE KEY-----/) {
    emit("D-secret", curfile, newline, "PRIVATE KEY block (masked)")
  } else {
    if (text ~ /AKIA[0-9A-Z]+/ || text ~ /ghp_[A-Za-z0-9]+/ || text ~ /gho_[A-Za-z0-9]+/ || text ~ /xox[baprs]-[A-Za-z0-9-]+/)
      emit("D-secret", curfile, newline, text)
    if (lt ~ /api[_-]?key|secret|token|password|passwd|bearer|authorization/)
      emit("D-secret-word", curfile, newline, text)
    if (text ~ /\/Users\/[^ \t]+|\/home\/[^ \t]+/)
      emit("D-path", curfile, newline, text)
    if (text ~ /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z][A-Za-z]+/)
      emit("B-email", curfile, newline, text)
    if (text ~ /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)
      emit("D-ip", curfile, newline, text)
  }
  newline++
  next
}
')"

if [ -z "$hits" ]; then
  echo "(none)"
else
  printf '%s\n' "$hits"
fi
