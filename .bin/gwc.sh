#!/bin/sh
# git worktree create & Android Studio launcher
# NOTE: Must be sourced (`. gwc.sh`) for `cd` to take effect — use the alias: gwc='. ~/dotfiles/.bin/gwc.sh'

main_repo=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2; exit }')

if [ -z "$main_repo" ]; then
  echo "Error: Not inside a git repository" >&2
  return 1
fi

echo "Fetching..."
git -C "$main_repo" fetch -p

branch="$1"
if [ -z "$branch" ]; then
  if ! command -v fzf >/dev/null 2>&1; then
    echo "Error: fzf is required for interactive branch selection. Run: brew install fzf" >&2
    return 1
  fi
  branches=$(git -C "$main_repo" branch -r | grep -v 'HEAD' | sed 's|^ *origin/||' | sort)
  branch=$(echo "$branches" | fzf --prompt="Branch: " --height=40%)
fi

[ -z "$branch" ] && return 0

# worktrees を main_repo の兄弟ディレクトリに配置する
# 例: ~/path/to/<repo> → ~/path/to/<repo>-worktrees/<dir_name>
# プロジェクト外に置くことで Android Studio が VCS ルートとして自動検出するのを防ぐ
parent_dir=$(dirname "$main_repo")
repo_name=$(basename "$main_repo")
wt_root="$parent_dir/${repo_name}-worktrees"
mkdir -p "$wt_root"

dir_name=$(echo "$branch" | tr '/' '-')
wt_path="$wt_root/$dir_name"

if [ -d "$wt_path" ]; then
  echo "Worktree already exists. Pulling latest..."
  cd "$wt_path" || return 1
  git pull
else
  new_local_branch=0
  if git -C "$main_repo" worktree add "$wt_path" "$branch" 2>/dev/null; then
    : # ローカル既存、または origin/<branch> から DWIM で追跡ブランチ作成
  elif git -C "$main_repo" worktree add -b "$branch" "$wt_path" "origin/$branch" 2>/dev/null; then
    git -C "$wt_path" branch --set-upstream-to="origin/$branch" "$branch"
  else
    # ローカルにも origin にも無い → origin のデフォルトブランチを起点に新規作成（push しない）
    default_branch=$(git -C "$main_repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
    if [ -z "$default_branch" ]; then
      git -C "$main_repo" remote set-head origin -a >/dev/null 2>&1
      default_branch=$(git -C "$main_repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
    fi
    if [ -z "$default_branch" ]; then
      echo "Error: Could not determine origin default branch" >&2
      return 1
    fi
    echo "Branch '$branch' not found locally or in origin. Creating new local branch from $default_branch (not pushed)..."
    git -C "$main_repo" worktree add -b "$branch" "$wt_path" "$default_branch" || {
      echo "Error: Failed to create local branch '$branch'" >&2
      return 1
    }
    new_local_branch=1
  fi
  cd "$wt_path" || return 1
  [ "$new_local_branch" -eq 0 ] && git pull
fi

studio .
