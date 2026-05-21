# alias
alias gfp='git fetch -p'
alias gc='git checkout'
alias gcb='git checkout -b'
alias gbd='git branch -D'
alias gbvv='git branch -vv'
alias gs='git status'
alias gp='git pull'

# dotfiles
export PATH=$PATH:~/dotfiles/.bin

# sdk
export JAVA_HOME=/Applications/"Android Studio.app"/Contents/jbr/Contents/Home
export PATH=$PATH:/Applications/"Android Studio.app"/Contents/jbr/Contents/Home/bin
export PATH=$PATH:/Applications/"Android Studio.app"/Contents/MacOS

export PATH=$PATH:~/Library/Android/sdk/platform-tools
export PATH=$PATH:~/flutter/bin
export PATH=$PATH:~/flutter/bin/cache/dart-sdk/bin
export PATH=$PATH:~/.local/bin

# prompt with git info using zsh built-in vcs_info
autoload -Uz vcs_info
precmd() { vcs_info }
zstyle ':vcs_info:git:*' formats '(%b)'
setopt PROMPT_SUBST
PROMPT='%1~ %F{green}${vcs_info_msg_0_}%f $ '

# homebrew
eval "$(/opt/homebrew/bin/brew shellenv)"

# git completion using zsh built-in
autoload -Uz compinit && compinit

alias gwc='. ~/dotfiles/.bin/gwc.sh'
