#!/usr/bin/env bash
# publish.sh — commit 済みの変更を push し、必要なら PR を作成する。
# pre-commit-leak-check スキルの STEP 6-2〜6-5（remote 決定・upstream 判定・push・
# GitHub 解決判定・base 検出・既存 PR 確認・gh アカウント切替・PR 作成）を 1 呼び出しに集約する。
#
# commit 自体（STEP 6-1）はスキル本体（LLM）が行う。本スクリプトは push 以降のみを担う。
#
# 使い方:
#   publish.sh --mode push [--remote <r>]
#   publish.sh --mode pr   --title <t> --body-file <path> [--base <b>] [--remote <r>]
#     ※ --body-file の中身には PR 規約フッター（🤖 Generated with ...）を含めておくこと。
#
# 設計方針（CLAUDE.md「フォールバック禁止」に従う）:
# - 想定外は黙って継続せず、原因を出して非ゼロ終了する。push の --force 系は実装しない。
# - gh auth switch はマシン全体のグローバル有効アカウントを変える。本スクリプトは単一シェル
#   実行なので「切替→確認→作成→復帰」は構造的にアトミック。さらに復帰は EXIT trap で無条件保証する。
#
# 終了コード: 2=引数不正 / 4=push 前提不備(remote/branch) / 5=PR 前提不備(GitHub/base/同一branch)
#             6=write 権限なし(PR 断念) / 7=push 失敗 / 8=PR 作成失敗
set -euo pipefail

MODE="" ; TITLE="" ; BODY_FILE="" ; BASE="" ; REMOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)      MODE="${2:-}"; shift 2 ;;
    --title)     TITLE="${2:-}"; shift 2 ;;
    --body-file) BODY_FILE="${2:-}"; shift 2 ;;
    --base)      BASE="${2:-}"; shift 2 ;;
    --remote)    REMOTE="${2:-}"; shift 2 ;;
    *) echo "ERROR: 不明な引数: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  push|pr) ;;
  *) echo "ERROR: --mode は push か pr を指定してください。" >&2; exit 2 ;;
esac

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: git リポジトリではありません。" >&2; exit 4
fi

# ---- remote 決定 ----
if [ -z "$REMOTE" ]; then
  remotes="$(git remote)"
  n="$(printf '%s\n' "$remotes" | grep -c '^.' || true)"
  if [ "$n" -eq 0 ]; then
    echo "ERROR: push 先 remote が設定されていません。git remote add origin <URL> で追加してください。" >&2
    exit 4
  elif [ "$n" -eq 1 ]; then
    REMOTE="$remotes"
  elif printf '%s\n' "$remotes" | grep -qx 'origin'; then
    REMOTE="origin"
  else
    echo "ERROR: 複数 remote があり origin がありません。--remote <name> を指定してください。" >&2
    echo "候補: $(printf '%s ' $remotes)" >&2
    exit 4
  fi
fi
git remote get-url "$REMOTE" >/dev/null 2>&1 || { echo "ERROR: remote '$REMOTE' は存在しません。" >&2; exit 4; }

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "HEAD" ]; then
  echo "ERROR: detached HEAD です。push できません。" >&2; exit 4
fi

# ---- upstream 判定して push ----
if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
  if ! push_out="$(git push 2>&1)"; then
    echo "ERROR: push に失敗しました（--force は行いません。git pull --rebase 等の方針を判断してください）:" >&2
    printf '%s\n' "$push_out" >&2; exit 7
  fi
else
  if ! push_out="$(git push -u "$REMOTE" "$branch" 2>&1)"; then
    echo "ERROR: push に失敗しました（--force は行いません）:" >&2
    printf '%s\n' "$push_out" >&2; exit 7
  fi
fi
printf '%s\n' "$push_out"
echo "PUSHED: $REMOTE/$branch"

[ "$MODE" = "push" ] && exit 0

# ===== ここから PR (mode=pr) =====
[ -n "$TITLE" ]     || { echo "ERROR: --mode pr には --title が必要です。" >&2; exit 2; }
[ -n "$BODY_FILE" ] || { echo "ERROR: --mode pr には --body-file が必要です。" >&2; exit 2; }
[ -f "$BODY_FILE" ] || { echo "ERROR: body-file が見つかりません: $BODY_FILE" >&2; exit 2; }

# GitHub として解決でき、かつ gh 認証済みか（URL 文字列一致では判定しない）
if ! gh repo view --json nameWithOwner >/dev/null 2>&1; then
  echo "ERROR: この remote は GitHub として解決できないか gh が未認証です。PR は作成しません。" >&2
  echo "push までは完了しています（上記 push 出力の Create PR URL から Web で作成してください）。" >&2
  exit 5
fi

# base 決定（自動検出）
if [ -z "$BASE" ]; then
  BASE="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
  if [ -z "$BASE" ]; then
    BASE="$(git symbolic-ref "refs/remotes/$REMOTE/HEAD" 2>/dev/null | sed "s#^refs/remotes/$REMOTE/##" || true)"
  fi
  [ -n "$BASE" ] || { echo "ERROR: base ブランチを自動検出できません。--base <name> を指定してください。" >&2; exit 5; }
fi

if [ "$branch" = "$BASE" ]; then
  echo "ERROR: 現在のブランチ($branch)が base と同一です。PR を作成できません。" >&2; exit 5
fi

# 既存 open PR があれば新規作成しない
existing="$(gh pr list --head "$branch" --state open --json url -q '.[0].url' 2>/dev/null || true)"
if [ -n "$existing" ]; then
  echo "EXISTING_PR: $existing"
  open "$existing" 2>/dev/null || true
  exit 0
fi

# ---- 権限確認（不足なら write 権限のあるアカウントへ一時切替。EXIT trap で無条件復帰）----
ORIG="$(gh auth status --active 2>/dev/null | grep -i 'logged in' | grep -oE 'account [^ ]+' | awk '{print $2}' | head -1 || true)"
SWITCHED=0
restore_account() { [ "$SWITCHED" = "1" ] && [ -n "$ORIG" ] && gh auth switch --user "$ORIG" >/dev/null 2>&1 || true; }
trap restore_account EXIT

has_write() { case "$1" in WRITE|ADMIN|MAINTAIN) return 0 ;; *) return 1 ;; esac; }

create_pr() {  # 標準出力に PR URL を返す
  gh pr create --base "$BASE" --head "$branch" --title "$TITLE" --body-file "$BODY_FILE"
}

perm="$(gh repo view --json viewerPermission -q .viewerPermission 2>/dev/null || true)"

if has_write "$perm"; then
  if ! PR_URL="$(create_pr)"; then
    echo "ERROR: PR 作成に失敗しました（リトライ・回避はしません）。" >&2; exit 8
  fi
  echo "PR_CREATED: $PR_URL"
  open "$PR_URL" 2>/dev/null || true
  exit 0
fi

# 権限不足 → owner を優先しつつ、ログイン済みの他アカウントを試す
owner="$(gh repo view --json owner -q .owner.login 2>/dev/null || true)"
all_accts="$(gh auth status 2>/dev/null | grep -i 'logged in' | grep -oE 'account [^ ]+' | awk '{print $2}' || true)"
# owner を先頭に並べ、ORIG を除外して候補リスト化
candidates=""
[ -n "$owner" ] && candidates="$owner"
for a in $all_accts; do
  [ "$a" = "$ORIG" ] && continue
  [ "$a" = "$owner" ] && continue
  candidates="$candidates $a"
done

for acct in $candidates; do
  [ -z "$acct" ] && continue
  gh auth switch --user "$acct" >/dev/null 2>&1 || continue
  SWITCHED=1
  p="$(gh repo view --json viewerPermission -q .viewerPermission 2>/dev/null || true)"
  if has_write "$p"; then
    if ! PR_URL="$(create_pr)"; then
      echo "ERROR: PR 作成に失敗しました（account=$acct）。" >&2; exit 8
    fi
    restore_account; SWITCHED=0   # 成功時点で即復帰（trap の二重復帰を避ける）
    echo "PR_CREATED: $PR_URL"
    echo "PR_ACCOUNT: created=$acct restored=$ORIG"
    open "$PR_URL" 2>/dev/null || true
    exit 0
  fi
done

# どのアカウントにも write 権限なし → 復帰は trap が行う。push までで停止。
echo "ERROR: ログイン済みのどのアカウントにも '$owner/...' への write 権限がありません。" >&2
echo "PR は作成できません。上記 push 出力の Create PR URL から Web で作成してください。" >&2
exit 6
