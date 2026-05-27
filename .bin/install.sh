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

# Claude Code global skills
ln -sf ~/dotfiles/.config/.claude/skills ~/.claude/skills
ln -sf ~/dotfiles/.config/.claude/settings.json ~/.claude/settings.json
ln -sf ~/dotfiles/.config/.claude/statusline-command.sh ~/.claude/statusline-command.sh

# agent-manager (iTerm2上のClaude Codeセッション状態モニタ)
# hookはsettings.jsonに登録済み。署名証明書を作成し、署名済み .app をビルドしておく
# （以降はSessionStart時に自動起動）。証明書作成はloginキーチェーンのパスワードを一度だけ尋ねる。
chmod +x ~/dotfiles/agent-manager/hooks/*.sh ~/dotfiles/agent-manager/scripts/*.sh
bash ~/dotfiles/agent-manager/scripts/create-signing-cert.sh
bash ~/dotfiles/agent-manager/scripts/build-app.sh
