# dotfiles
export PATH=$PATH:~/dotfiles/.bin

# sdk
export PATH=$PATH:~/Library/Android/sdk/platform-tools
export PATH=$PATH:~/flutter/bin
export PATH=$PATH:~/flutter/bin/cache/dart-sdk/bin

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

# mise
eval "$(mise activate zsh)"