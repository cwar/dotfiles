# History
HISTFILE=~/.histfile
HISTSIZE=10000
SAVEHIST=10000
setopt autocd extendedglob nomatch notify
setopt hist_ignore_dups hist_ignore_space share_history

# Vi mode
bindkey -v

# Completion
zstyle :compinstall filename '/home/cwar/.zshrc'
autoload -Uz compinit
compinit

# Spaceship prompt
source ~/.zsh/spaceship/spaceship.zsh
export PATH="$HOME/.npm-global/bin:$PATH"

# Try - dated experiment folders
eval "$(ruby ~/.local/bin/try.rb init ~/tries)"
