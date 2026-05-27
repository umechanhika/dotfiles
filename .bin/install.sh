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

# agent-manager (iTerm2上のClaude Codeセッション状態モニタ)
# hookはsettings.jsonに登録済み。初回ビルドしておく（以降はSessionStart時に自動起動）。
chmod +x ~/dotfiles/agent-manager/hooks/*.sh
swift build --package-path ~/dotfiles/agent-manager -c release
