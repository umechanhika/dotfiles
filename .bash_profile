export PATH=$PATH:~/Library/Android/sdk/platform-tools
export PATH=$PATH:~/flutter/bin
export PATH=$PATH:~/flutter/bin/cache/dart-sdk/bin

# git
source ~/dotfiles/.git-prompt.sh
source ~/dotfiles/.git-completion.bash
export PS1='\W \[\e[1;32m $(__git_ps1 "(%s)") \[\e[0m\] \$ '
