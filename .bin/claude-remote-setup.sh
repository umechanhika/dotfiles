#!/usr/bin/env bash
# Claude Code のリモート環境（Claude Code on the web のコンテナ）向けセットアップ。
# 環境設定の setup script から呼び出す。何度実行しても結果は同じ（冪等）。
# ローカル Mac 向けのリンクは install.sh 側にある。
#
# 使い方:
#   bash claude-remote-setup.sh            クローンが無ければ取得し、設定を適用する
#   bash claude-remote-setup.sh --update   既存のクローンを最新にしてから適用する
#
# 全体を main() で包んでいるのは、--update が自分自身を書き換えても
# 実行中の内容が壊れないようにするため（bash はスクリプトを逐次読みするため）。
set -euo pipefail

# リンク先にコピーが残っていると、そのディレクトリの中にリンクが作られてしまう。
# 以前のセットアップが置いたコピーは配布物の複製なので、作り直して構わない。
link_config() {
  local src="$1" dest="$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    rm -rf "$dest"
  fi
  ln -sfn "$src" "$dest"
}

main() {
  local update=0
  case "${1:-}" in
    --update) update=1 ;;
    "") ;;
    *)
      echo "claude-remote-setup: 不明な引数: $1" >&2
      exit 1
      ;;
  esac

  local repo_url="${DOTFILES_REPO:-https://github.com/umechanhika/dotfiles}"
  local dotfiles_dir="${DOTFILES_DIR:-$HOME/.dotfiles}"
  local claude_dir="$HOME/.claude"
  local src_dir="$dotfiles_dir/.config/.claude"

  if [ -d "$dotfiles_dir/.git" ]; then
    if [ "$update" -eq 1 ]; then
      # 配布用のクローンなので、ローカルの変更は持たない前提で最新へ合わせる。
      git -C "$dotfiles_dir" fetch --depth=1 origin HEAD
      git -C "$dotfiles_dir" reset --hard FETCH_HEAD
    fi
  elif [ -e "$dotfiles_dir" ]; then
    echo "claude-remote-setup: $dotfiles_dir が git リポジトリではありません" >&2
    exit 1
  else
    git clone --depth=1 "$repo_url" "$dotfiles_dir"
  fi

  local required
  for required in "$src_dir/CLAUDE.md" "$src_dir/skills" "$src_dir/output-styles" "$src_dir/settings.json"; do
    if [ ! -e "$required" ]; then
      echo "claude-remote-setup: 見つかりません: $required" >&2
      exit 1
    fi
  done

  mkdir -p "$claude_dir"
  # コピーではなくリンクにして、クローンを更新すれば内容も追従するようにする。
  link_config "$src_dir/CLAUDE.md" "$claude_dir/CLAUDE.md"
  link_config "$src_dir/skills" "$claude_dir/skills"
  link_config "$src_dir/output-styles" "$claude_dir/output-styles"

  # settings.json は macOS 専用の hook・statusLine を含むため丸ごとは持ち込まない。
  # リモートでも意味を持つ outputStyle だけを既存の設定にマージし、
  # あわせてセッション開始時にクローンを最新化する hook を登録する。
  python3 - "$src_dir/settings.json" "$claude_dir/settings.json" "$dotfiles_dir" <<'PY'
import json
import os
import sys

src_path, dest_path, dotfiles_dir = sys.argv[1], sys.argv[2], sys.argv[3]

with open(src_path, encoding="utf-8") as f:
    src = json.load(f)

if "outputStyle" not in src:
    sys.exit(f"claude-remote-setup: outputStyle が {src_path} にありません")

dest = {}
if os.path.exists(dest_path):
    with open(dest_path, encoding="utf-8") as f:
        dest = json.load(f)

dest["outputStyle"] = src["outputStyle"]

command = f"bash {dotfiles_dir}/.bin/claude-remote-setup.sh --update"
hooks = dest.setdefault("hooks", {})
session_start = hooks.setdefault("SessionStart", [])
registered = any(
    hook.get("command") == command
    for matcher in session_start
    for hook in matcher.get("hooks", [])
)
if not registered:
    session_start.append({"hooks": [{"type": "command", "command": command}]})

with open(dest_path, "w", encoding="utf-8") as f:
    json.dump(dest, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"claude-remote-setup: outputStyle = {src['outputStyle']}")
PY
}

main "$@"
