#!/usr/bin/env bash
# impact-scan.sh — 修正予定シンボルの参照箇所をリポジトリ全体から決定論で全列挙する。
# bugfix スキルの STEP2（全パターンと影響範囲の把握）の補助入力。
#
# 設計方針（pre-commit-leak-check/scripts/scan-staged.sh に倣う）:
# - 生ファイルは出さない。シンボルごとの参照を path:line<TAB>snippet で列挙し summary を付す。
# - git grep（作業ツリー対象・言語非依存・git があれば常に使える）で textual に一致検索する。
#   これは「補助」かつ「下限」。動的ディスパッチ/DI/リフレクション/文字列キー/別言語境界は
#   textual には拾えないため、LLM が出力を起点に判断する前提（silent cap を作らない）。
# - 定義行と参照行は textual に区別しない（区別すると定義を誤って落とすため全件出す）。
#
# 使い方:
#   impact-scan.sh <symbol> [<symbol>...] [--path <dir>]...
#   例: impact-scan.sh fetchUser UserRepository --path src
#
# 異常系（フォールバック禁止：黙って継続せず即エラー終了）:
#   2: シンボルが1つも指定されていない / 不明な引数
#   4: git リポジトリでない
#   5: git grep が想定外エラー（exit >1）
set -euo pipefail

paths=()
symbols=()
while [ $# -gt 0 ]; do
  case "$1" in
    --path) paths+=("${2:-}"); shift 2 ;;
    --) shift; while [ $# -gt 0 ]; do symbols+=("$1"); shift; done ;;
    -*) echo "ERROR: 不明な引数: $1" >&2; exit 2 ;;
    *) symbols+=("$1"); shift ;;
  esac
done

if [ "${#symbols[@]}" -eq 0 ]; then
  echo "ERROR: シンボルを1つ以上指定してください。例: impact-scan.sh fetchUser UserRepository" >&2
  exit 2
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: git リポジトリではありません。" >&2
  exit 4
fi

branch="$(git branch --show-current 2>/dev/null || true)"
[ -z "$branch" ] && branch="(detached/unborn)"

allpaths="$(mktemp)"
trap 'rm -f "$allpaths"' EXIT

echo "# impact-scan @ ${branch}"

total=0
summary=""
for sym in "${symbols[@]}"; do
  set +e
  if [ "${#paths[@]}" -gt 0 ]; then
    raw="$(git grep -F -w -n --no-color --untracked -e "$sym" -- "${paths[@]}")"
  else
    raw="$(git grep -F -w -n --no-color --untracked -e "$sym")"
  fi
  rc=$?
  set -e
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: git grep が失敗しました (exit $rc) symbol=$sym" >&2
    exit 5
  fi

  echo "## references (symbol=${sym})"
  echo "# path:line<TAB>snippet"
  if [ -z "$raw" ]; then
    echo "(none)"
    cnt=0
  else
    # git grep -n の出力 'path:line:content' を path:line<TAB>snippet に整形（80字トリム）。
    printf '%s\n' "$raw" | awk '
    {
      i = index($0, ":"); rest = substr($0, i+1)
      j = index(rest, ":")
      path = substr($0, 1, i-1)
      ln   = substr(rest, 1, j-1)
      text = substr(rest, j+1)
      sub(/^[ \t]+/, "", text)
      if (length(text) > 80) text = substr(text, 1, 80) "…"
      printf "%s:%s\t%s\n", path, ln, text
    }'
    cnt="$(printf '%s\n' "$raw" | grep -c '' || true)"
    printf '%s\n' "$raw" | awk '{ i=index($0,":"); print substr($0,1,i-1) }' >> "$allpaths"
  fi
  total=$(( total + cnt ))
  summary="${summary}${sym}	${cnt}
"
done

files="$(sort -u "$allpaths" | grep -c '' || true)"

echo "## summary"
echo "# symbol<TAB>hits"
printf '%s' "$summary"
printf 'total_hits\t%s\n' "$total"
printf 'files\t%s\n' "$files"

echo "## note"
echo "textual 一致のみ（git grep）。動的ディスパッチ/DI/リフレクション/文字列キー/別言語境界は拾えない。これは下限であって上限ではない。"
