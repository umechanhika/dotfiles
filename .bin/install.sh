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
ln -sf ~/dotfiles/.config/.claude/output-styles ~/.claude/output-styles
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
