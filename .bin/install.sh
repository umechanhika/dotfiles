# .zshrc
ln -s ~/dotfiles/.zsh/.zshrc ~
source ~/.zshrc

# brew
ln -s ~/dotfiles/.Brewfile ~
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
brew bundle --global

# vim
ln -s ~/dotfiles/.vim ~
ln -s ~/dotfiles/.vim/.vimrc ~

# Claude Code global config / skills
ln -sf ~/dotfiles/.config/.claude/CLAUDE.md ~/.claude/CLAUDE.md
ln -sf ~/dotfiles/.config/.claude/skills ~/.claude/skills
ln -sf ~/dotfiles/.config/.claude/settings.json ~/.claude/settings.json
ln -sf ~/dotfiles/.config/.claude/statusline-command.sh ~/.claude/statusline-command.sh

clone_or_update() {
  if [ -d "$2/.git" ]; then
    git -C "$2" pull --ff-only
  else
    git clone "$1" "$2"
  fi
}

# agent-manager (iTerm2上のClaude Codeセッション状態モニタ)
# hookはsettings.jsonに登録済み。リポジトリをcloneし、署名証明書を作成し、署名済み .app をビルドしておく
# （以降はSessionStart時に自動起動）。証明書作成はloginキーチェーンのパスワードを一度だけ尋ねる。
clone_or_update git@github.com:umechanhika/agent-manager.git "$HOME/agent-manager"
chmod +x "$HOME"/agent-manager/hooks/*.sh "$HOME"/agent-manager/scripts/*.sh
bash "$HOME/agent-manager/scripts/create-signing-cert.sh"
bash "$HOME/agent-manager/scripts/build-app.sh"

# window-snap (ウィンドウを画面端へドラッグしてスナップする常駐ユーティリティ)
# リポジトリをcloneし、署名証明書を作成し、署名済み .app をビルドして LaunchAgent でログイン常駐させる。
# 証明書作成はloginキーチェーンのパスワード（とコード署名信頼の認証）を一度だけ尋ねる。
# 起動後、システム設定→プライバシーとセキュリティ→アクセシビリティ で WindowSnap.app を有効化すること。
clone_or_update git@github.com:umechanhika/window-snap.git "$HOME/window-snap"
chmod +x "$HOME"/window-snap/scripts/*.sh
bash "$HOME/window-snap/scripts/create-signing-cert.sh"
bash "$HOME/window-snap/scripts/build-app.sh"
mkdir -p ~/Library/LaunchAgents ~/.local/state/window-snap
sed -e "s#__LAUNCHER__#$HOME/window-snap/scripts/windowsnap-launch.sh#" \
    -e "s#__LOG__#$HOME/.local/state/window-snap/stderr.log#" \
    "$HOME/window-snap/launchd/com.umechanhika.windowsnap.plist" \
    > ~/Library/LaunchAgents/com.umechanhika.windowsnap.plist
# 既存をアンロードしてから登録（冪等）
launchctl bootout gui/$(id -u)/com.umechanhika.windowsnap 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.umechanhika.windowsnap.plist
