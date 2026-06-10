# alias
alias gfp='git fetch -p'
alias gc='git checkout'
alias gcb='git checkout -b'
alias gbd='git branch -D'
alias gbvv='git branch -vv'
alias gs='git status'
alias gp='git pull'
alias gwa='git worktree add'
alias gwl='git worktree list'
alias gwr='git worktree remove'

# editor
export EDITOR=vim
export VISUAL=vim

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
export PATH="/opt/homebrew/opt/python@3.14/libexec/bin:$PATH"

# git completion using zsh built-in
autoload -Uz compinit && compinit

# gwc は補完(compdef)を効かせるため alias ではなく関数にする。
# alias のままだと、既定の NO_COMPLETE_ALIASES 下では補完時に alias が先に展開され、
# source(.) の引数（ファイル名）補完になって compdef _gwc が無視される。
# 関数なら compdef がそのまま効き、かつ他の git alias(gc 等)の展開補完にも影響しない。
# source する点は alias と同じ（cd を現在のシェルに反映させるため必須）。
gwc() { . "$HOME/dotfiles/.bin/gwc.sh" "$@" }
# gwd も補完(compdef)を効かせるため関数にする。source する点は alias と同じ。
gwd() { . "$HOME/dotfiles/.bin/gwd.sh" "$@" }

# gwc のブランチ名補完（git checkout 相当の DWIM 体験）
# gwc は `git ...` を実行する関数ではないため git 標準補完が効かない。これを補う。
# 以下を補完候補に出す:
# - ローカルブランチ（refs/heads）
# - origin のリモートブランチ（lstrip=3 で refs/remotes/origin/ を除去し origin/ 前置なしの名前に）
# origin/HEAD は HEAD になるので除外、ローカル/リモート同名は重複除去。
# git 管理外では for-each-ref が空を返すため候補ゼロになる（=自然に無効化）。
_gwc() {
  local expl
  local -a branches
  # git を直接呼ぶ。補完ユーティリティ _call_program は引数を eval するため
  # --format=%(...) の括弧が glob 展開されて失敗する（候補が空になる）ので使わない。
  branches=(
    ${(f)"$(git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)"}
    ${(f)"$(git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin 2>/dev/null)"}
  )
  branches=(${(u)branches:#HEAD})
  _wanted branches expl 'branch' compadd -a branches
}
compdef _gwc gwc

# gwd の worktree パス補完
# git worktree list --porcelain からパスを取得して候補にする。
_gwd() {
  local expl
  local -a wt_paths
  wt_paths=(${(f)"$(git worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2 }')"})
  _wanted directories expl 'worktree' compadd -a wt_paths
}
compdef _gwd gwd
