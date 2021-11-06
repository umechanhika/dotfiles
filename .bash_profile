export PATH=$PATH:~/Library/Android/sdk/platform-tools
export PATH=$PATH:~/flutter/bin
export PATH=$PATH:~/flutter/bin/cache/dart-sdk/bin

# git
source /Library/Developer/CommandLineTools/usr/share/git-core/git-prompt.sh
source /Library/Developer/CommandLineTools/usr/share/git-core/git-completion.bash
export PS1='\W \[\e[1;32m $(__git_ps1 "(%s)") \[\e[0m\] \$ '

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/Users/hikaru-umetsu/google-cloud-sdk/path.bash.inc' ]; then . '/Users/hikaru-umetsu/google-cloud-sdk/path.bash.inc'; fi

# The next line enables shell command completion for gcloud.
if [ -f '/Users/hikaru-umetsu/google-cloud-sdk/completion.bash.inc' ]; then . '/Users/hikaru-umetsu/google-cloud-sdk/completion.bash.inc'; fi
