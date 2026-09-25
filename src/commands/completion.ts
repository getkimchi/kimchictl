import { parseFlags, UsageError } from "./flags.js"

/**
 * Shell completions — deliberately minimal: complete top-level command names
 * plus workspace subverbs; expand on demand rather than building a full spec.
 */

const TOP_LEVEL = ["login", "logout", "whoami", "workspace", "ws", "ssh", "update", "completion", "version", "help"]
const WORKSPACE_VERBS = ["create", "list", "get", "delete", "--output", "--desc", "--force", "--no-wait", "--help"]

const BASH = `# kimchictl bash completion — source this file or place it in /etc/bash_completion.d/
_kimchictl() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${TOP_LEVEL.join(" ")}" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
    workspace|ws)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "${WORKSPACE_VERBS.join(" ")}" -- "$cur") ) ;;
    completion)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;
  esac
  return 0
}
complete -F _kimchictl kimchictl
`

const ZSH_COMMANDS = TOP_LEVEL.map((c) => `"${c}"`).join(" ")

const ZSH = `#compdef kimchictl
# kimchictl zsh completion — place in a directory on $fpath as _kimchictl
_kimchictl() {
  local -a commands=${ZSH_COMMANDS}
  if (( CURRENT == 2 )); then
    _arguments "1:command:(\${commands})"
    return
  fi
  case "$words[2]" in
    workspace|ws)
      (( CURRENT == 3 )) && _arguments "2:verb:(${WORKSPACE_VERBS.join(" ")})" ;;
    completion)
      (( CURRENT == 3 )) && _arguments "2:shell:(bash zsh fish)" ;;
  esac
}
_kimchictl "$@"
`

const FISH = `# kimchictl fish completion — place in ~/.config/fish/completions/kimchictl.fish
complete -c kimchictl -f
complete -c kimchictl -n '__fish_use_subcommand' -a '${TOP_LEVEL.join(" ")}'
complete -c kimchictl -n '__fish_seen_subcommand_from workspace ws' -a '${WORKSPACE_VERBS.join(" ")}'
complete -c kimchictl -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
`

export async function runCompletion(args: string[]): Promise<number> {
	const { positionals } = parseFlags("completion", args, {})
	const shell = positionals[0]
	if (positionals.length > 1) {
		throw new UsageError("kimchictl completion: expected one shell (bash|zsh|fish)")
	}
	switch (shell) {
		case "bash":
			console.log(BASH)
			return 0
		case "zsh":
			console.log(ZSH)
			return 0
		case "fish":
			console.log(FISH)
			return 0
		default:
			throw new UsageError(`kimchictl completion: unsupported shell '${shell ?? ""}' — one of: bash, zsh, fish`)
	}
}
