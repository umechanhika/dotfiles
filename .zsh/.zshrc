# alias
alias gfp='git fetch -p'
alias gc='git checkout'
alias gcb='git checkout -b'
alias gbd='git branch -D'
alias gbvv='git branch -vv'
alias gs='git status'
alias gp='git pull'

# dotfiles
export PATH="$PATH:$HOME/dotfiles/.bin"

# Java (Android Studio bundled JBR)
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$PATH:$JAVA_HOME/bin"

# Detach Android Studio from the terminal so closing the terminal doesn't kill it
function studio() {
  nohup /Applications/Android\ Studio.app/Contents/MacOS/studio "$@" > /dev/null 2>&1 &
  disown
}

# sdk
export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"
export PATH="$PATH:$HOME/flutter/bin"
export PATH="$PATH:$HOME/flutter/bin/cache/dart-sdk/bin"
export PATH="$HOME/.local/bin:$PATH"

# ruby
export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
export PATH="/opt/homebrew/lib/ruby/gems/3.4.0/bin:$PATH"

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

alias gwc='. $HOME/dotfiles/.bin/gwc.sh'
