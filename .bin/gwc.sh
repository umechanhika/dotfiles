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

# Add worktrees/ to .git/info/exclude (local only, never committed)
exclude="$main_repo/.git/info/exclude"
if ! grep -qx 'worktrees/' "$exclude" 2>/dev/null; then
  echo 'worktrees/' >> "$exclude"
fi

dir_name=$(echo "$branch" | tr '/' '-')
wt_path="$main_repo/worktrees/$dir_name"

if [ -d "$wt_path" ]; then
  echo "Worktree already exists. Pulling latest..."
  cd "$wt_path" || return 1
  git pull
else
  if ! git -C "$main_repo" worktree add "$wt_path" "$branch" 2>/dev/null; then
    git -C "$main_repo" worktree add -b "$branch" "$wt_path" "origin/$branch" || {
      echo "Error: Branch '$branch' not found locally or in origin" >&2
      return 1
    }
    git -C "$wt_path" branch --set-upstream-to="origin/$branch" "$branch"
  fi
  cd "$wt_path" || return 1
  git pull
fi

studio .
