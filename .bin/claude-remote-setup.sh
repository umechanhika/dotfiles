#!/usr/bin/env bash
# Claude Code のリモート環境（Claude Code on the web のコンテナ）向けセットアップ。
# 環境設定の setup script から呼び出す。何度実行しても結果は同じ（冪等）。
# ローカル Mac 向けのリンクは install.sh 側にある。
set -euo pipefail

dotfiles_dir="${DOTFILES_DIR:-$HOME/.dotfiles}"
claude_dir="$HOME/.claude"
src_dir="$dotfiles_dir/.config/.claude"

for required in "$src_dir/CLAUDE.md" "$src_dir/skills" "$src_dir/output-styles" "$src_dir/settings.json"; do
  if [ ! -e "$required" ]; then
    echo "claude-remote-setup: 見つかりません: $required" >&2
    exit 1
  fi
done

mkdir -p "$claude_dir"
ln -sfn "$src_dir/CLAUDE.md" "$claude_dir/CLAUDE.md"
ln -sfn "$src_dir/skills" "$claude_dir/skills"
ln -sfn "$src_dir/output-styles" "$claude_dir/output-styles"

# settings.json は macOS 専用の hook・statusLine を含むため丸ごとは持ち込まない。
# リモートでも意味を持つ outputStyle だけを既存の設定にマージする。
python3 - "$src_dir/settings.json" "$claude_dir/settings.json" <<'PY'
import json
import os
import sys

src_path, dest_path = sys.argv[1], sys.argv[2]

with open(src_path, encoding="utf-8") as f:
    src = json.load(f)

if "outputStyle" not in src:
    sys.exit(f"claude-remote-setup: outputStyle が {src_path} にありません")

dest = {}
if os.path.exists(dest_path):
    with open(dest_path, encoding="utf-8") as f:
        dest = json.load(f)

dest["outputStyle"] = src["outputStyle"]

with open(dest_path, "w", encoding="utf-8") as f:
    json.dump(dest, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"claude-remote-setup: outputStyle = {src['outputStyle']}")
PY
