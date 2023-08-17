# .bash_profile
ln -s ~/dotfiles/.bash/.bash_profile ~
source ~/.bash_profile

# brew
ln -s ~/dotfiles/.Brewfile ~
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
brew bundle --global

# vim
ln -s ~/dotfiles/.vim ~
ln -s ~/dotfiles/.vim/.vimrc ~
