# Bash completion for ohmobile
#
# Add to your shell profile (~/.bashrc or ~/.zshrc):
#   source "$(dirname "$(which ohmobile)")/ohmobile-completion.bash"
#
# Or for zsh:
#   autoload -Uz bashcompinit && bashcompinit
#   source "$(dirname "$(which ohmobile)")/ohmobile-completion.bash"

_ohmobile_completions() {
  local cur prev commands
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  commands="run auth creds stop scenes simulate record generate-scene clean help"

  # Complete subcommands
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "$commands" -- "$cur"))
    return
  fi

  # Complete scene names for simulate/record
  case "$prev" in
    simulate|record|generate-scene)
      local scenes_dir=""
      local project_dir="${PROJECT_DIR:-$(pwd)}"
      local scene_names=""
      for candidate in \
        "$project_dir/src/simulation/scenes" \
        "$project_dir/simulation/scenes" \
        "$project_dir/scenes"; do
        if [ -d "$candidate" ]; then
          scenes_dir="$candidate"
          break
        fi
      done

      if [ -n "$scenes_dir" ]; then
        for f in "$scenes_dir"/*.js; do
          [ -f "$f" ] || continue
          local name
          name="$(basename "$f" .js)"
          [ "$name" = "index" ] && continue
          scene_names="$scene_names $name"
        done
        for f in "$scenes_dir"/*.sh; do
          [ -f "$f" ] || continue
          local name
          name="$(basename "$f" .sh)"
          scene_names="$scene_names $name"
        done
      fi

      COMPREPLY=($(compgen -W "$scene_names" -- "$cur"))
      return
      ;;
    run)
      COMPREPLY=($(compgen -W "--skip-build --skip-auth" -- "$cur"))
      return
      ;;
    stop)
      COMPREPLY=($(compgen -W "--sim" -- "$cur"))
      return
      ;;
    creds)
      COMPREPLY=($(compgen -W "--verify --delete" -- "$cur"))
      return
      ;;
  esac
}

complete -F _ohmobile_completions ohmobile
