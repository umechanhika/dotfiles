#!/bin/sh
# git worktree cleanup: 今いる worktree とそのブランチを削除し、メイン worktree で
# デフォルトブランチを最新化する。gwc.sh（worktree 作成）と対になる片付けコマンド。
# NOTE: Must be sourced (`. gwclean.sh`) — 自 worktree を削除すると cwd が消えるため、
# 先にメイン worktree へ cd する必要がある。alias: gwclean='. ~/dotfiles/.bin/gwclean.sh'

# -f / --force: worktree に未コミット変更があっても強制削除する明示オプトイン
force=0
case "$1" in
  -f|--force) force=1 ;;
  "") ;;
  *) echo "Usage: gwclean [-f]" >&2; return 1 ;;
esac

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: Not inside a git repository" >&2
  return 1
fi

main_repo=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2; exit }')
cur_wt=$(git rev-parse --show-toplevel 2>/dev/null)
cur_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

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

# ガード: 想定外はフォールバックせず明示エラーで中断する
if [ "$cur_wt" = "$main_repo" ]; then
  echo "Error: Refusing to clean the main worktree ($main_repo)" >&2
  return 1
fi
if [ "$cur_branch" = "$default_branch" ]; then
  echo "Error: Refusing to delete the default branch '$default_branch'" >&2
  return 1
fi
if [ "$cur_branch" = "HEAD" ]; then
  echo "Error: Detached HEAD; nothing to clean" >&2
  return 1
fi

# dirty 判定。未コミット変更の消失はブランチ削除(-D, reflog で復旧可)とは別の不可逆リスク
# なので、明示的に -f されない限り中断する。
dirty=0
[ -n "$(git -C "$cur_wt" status --porcelain 2>/dev/null)" ] && dirty=1
if [ "$dirty" -eq 1 ] && [ "$force" -eq 0 ]; then
  echo "Error: Worktree has uncommitted changes. Commit/stash them, or re-run: gwclean -f" >&2
  return 1
fi

# 確認プロンプト（1回・デフォルト No）
echo "Worktree : $cur_wt"
echo "Branch   : $cur_branch  (git branch -D)"
[ "$dirty" -eq 1 ] && echo "WARNING  : uncommitted changes will be lost (--force)"
echo "Then     : update '$default_branch' in $main_repo"
printf "Proceed? [y/N] "
read -r ans
case "$ans" in
  y|Y) ;;
  *) echo "Aborted." >&2; return 1 ;;
esac

# cwd 退避（自 worktree を内部から削除すると cwd が消えるため、先にメイン worktree へ移動）
cd "$main_repo" || { echo "Error: cannot cd to main repo $main_repo" >&2; return 1; }

# worktree 削除 → ブランチ削除（順序必須: checkout 中ブランチの -D は git が拒否する）
if [ "$force" -eq 1 ]; then
  git -C "$main_repo" worktree remove --force "$cur_wt" || { echo "Error: failed to remove worktree" >&2; return 1; }
else
  git -C "$main_repo" worktree remove "$cur_wt" || { echo "Error: failed to remove worktree" >&2; return 1; }
fi
git -C "$main_repo" branch -D "$cur_branch" || { echo "Error: failed to delete branch '$cur_branch'" >&2; return 1; }

# default ブランチを最新化（メイン worktree の checkout は奪わない）
git -C "$main_repo" fetch -p
main_cur=$(git -C "$main_repo" symbolic-ref --short HEAD 2>/dev/null)
if [ "$main_cur" = "$default_branch" ]; then
  git -C "$main_repo" pull --ff-only || echo "Warning: '$default_branch' was not fast-forward; resolve manually." >&2
else
  git -C "$main_repo" fetch origin "$default_branch:$default_branch" \
    || echo "Warning: could not fast-forward '$default_branch' ref." >&2
  echo "Note: main worktree is on '$main_cur'; updated '$default_branch' ref via fetch (not checked out)."
fi

echo "Done. Now in $main_repo on '$main_cur'."
