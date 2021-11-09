# dotfiles
export PATH=$PATH:~/dotfiles/.bin

# sdk
export PATH=$PATH:~/Library/Android/sdk/platform-tools
export PATH=$PATH:~/flutter/bin
export PATH=$PATH:~/flutter/bin/cache/dart-sdk/bin

# prompt
export PS1='\W \[\e[1;32m $(__git_ps1 "(%s)") \[\e[0m\] \$ '

# homebrew
eval "$(/opt/homebrew/bin/brew shellenv)"

# git
source ~/dotfiles/.bash/.git-prompt.sh
source ~/dotfiles/.bash/.git-completion.bash
