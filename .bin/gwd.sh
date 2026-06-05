#!/bin/sh
# git worktree cleanup: 指定した worktree とそのブランチを削除する。
# gwc.sh（worktree 作成）と対になる片付けコマンド。
# NOTE: Must be sourced (`. gwd.sh`) — 現在いる worktree を削除すると cwd が消えるため、
# 先にメイン worktree へ cd する必要がある。alias: gwd='. ~/dotfiles/.bin/gwd.sh'

# -f / --force: worktree に未コミット変更があっても強制削除する明示オプトイン
force=0
dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--force) force=1; shift ;;
    -*) echo "Usage: gwd [-f] <dir>" >&2; return 1 ;;
    *) dir="$1"; shift ;;
  esac
done

if [ -z "$dir" ]; then
  echo "Usage: gwd [-f] <dir>" >&2
  return 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: Not inside a git repository" >&2
  return 1
fi

# <dir> を絶対パスに正規化（サブシェルで実行するのでcwdは変わらない）
target_wt=$(cd "$dir" 2>/dev/null && pwd)
if [ -z "$target_wt" ]; then
  echo "Error: '$dir' is not a valid directory" >&2
  return 1
fi

main_repo=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2; exit }')
cur_wt=$(git rev-parse --show-toplevel 2>/dev/null)

# default ブランチ取得。symbolic-ref は "origin/main" を返すため origin/ を剥がす。
# 剥がさないと後続の default ブランチ削除ガードが素通りし、main を消しに行く事故になる。
default_raw=$(git -C "$main_repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
if [ -z "$default_raw" ]; then
  git -C "$main_repo" remote set-head origin -a >/dev/null 2>&1
  default_raw=$(git -C "$main_repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
fi
if [ -z "$default_raw" ]; then
  echo "Error: Could not determine origin default branch" >&2
  return 1
fi
default_branch=${default_raw#origin/}

# target_wt に対応するブランチを worktree list から取得
target_branch=$(git worktree list --porcelain 2>/dev/null | awk -v wt="$target_wt" '
  /^worktree / { cur=$2; next }
  /^branch / && cur == wt { sub("refs/heads/", "", $2); print $2; exit }
')
if [ -z "$target_branch" ]; then
  echo "Error: '$target_wt' is not a known worktree (or is in detached HEAD state)" >&2
  return 1
fi

# ガード: 想定外はフォールバックせず明示エラーで中断する
if [ "$target_wt" = "$main_repo" ]; then
  echo "Error: Refusing to clean the main worktree ($main_repo)" >&2
  return 1
fi
if [ "$target_branch" = "$default_branch" ]; then
  echo "Error: Refusing to delete the default branch '$default_branch'" >&2
  return 1
fi

# dirty 判定。未コミット変更の消失はブランチ削除(-D, reflog で復旧可)とは別の不可逆リスク
# なので、明示的に -f されない限り中断する。
dirty=0
[ -n "$(git -C "$target_wt" status --porcelain 2>/dev/null)" ] && dirty=1
if [ "$dirty" -eq 1 ] && [ "$force" -eq 0 ]; then
  echo "Error: Worktree has uncommitted changes. Commit/stash them, or re-run: gwd -f $dir" >&2
  return 1
fi

# 確認プロンプト（1回・デフォルト No）
echo "Worktree : $target_wt"
echo "Branch   : $target_branch  (git branch -D)"
[ "$dirty" -eq 1 ] && echo "WARNING  : uncommitted changes will be lost (--force)"
printf "Proceed? [y/N] "
read -r ans
case "$ans" in
  y|Y) ;;
  *) echo "Aborted." >&2; return 1 ;;
esac

# 自 worktree を削除する場合のみ退避（cwd が消えるため削除前にメイン worktree へ移動）
if [ "$target_wt" = "$cur_wt" ]; then
  cd "$main_repo" || { echo "Error: cannot cd to main repo $main_repo" >&2; return 1; }
fi

# worktree 削除 → ブランチ削除（順序必須: checkout 中ブランチの -D は git が拒否する）
if [ "$force" -eq 1 ]; then
  git -C "$main_repo" worktree remove --force "$target_wt" || { echo "Error: failed to remove worktree" >&2; return 1; }
else
  git -C "$main_repo" worktree remove "$target_wt" || { echo "Error: failed to remove worktree" >&2; return 1; }
fi
git -C "$main_repo" branch -D "$target_branch" || { echo "Error: failed to delete branch '$target_branch'" >&2; return 1; }

echo "Done."
