import type { Command } from "commander";

const TOP_LEVEL_COMMANDS = [
  "login",
  "logout",
  "whoami",
  "version",
  "upgrade",
  "servers",
  "apps",
  "deployments",
  "logs",
  "exec",
  "env",
  "domains",
  "profile",
  "keyring",
  "mcp",
  "completion",
  "help",
];

const BASH = `# reoclo bash completion
_reoclo() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local cmds="${TOP_LEVEL_COMMANDS.join(" ")}"

  if [[ "\${COMP_CWORD}" == "1" ]]; then
    COMPREPLY=( $(compgen -W "\${cmds}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    servers)     COMPREPLY=( $(compgen -W "ls get metrics" -- "\${cur}") );;
    apps)        COMPREPLY=( $(compgen -W "ls get deploy logs restart" -- "\${cur}") );;
    deployments) COMPREPLY=( $(compgen -W "ls get logs" -- "\${cur}") );;
    logs)        COMPREPLY=( $(compgen -W "tail" -- "\${cur}") );;
    env)         COMPREPLY=( $(compgen -W "ls set rm get" -- "\${cur}") );;
    domains)     COMPREPLY=( $(compgen -W "ls add verify" -- "\${cur}") );;
    profile)     COMPREPLY=( $(compgen -W "ls use rm" -- "\${cur}") );;
    keyring)     COMPREPLY=( $(compgen -W "status migrate export" -- "\${cur}") );;
    *)           COMPREPLY=();;
  esac
}
complete -F _reoclo reoclo
`;

const ZSH = `#compdef reoclo
# reoclo zsh completion
_reoclo() {
  local -a top
  top=(${TOP_LEVEL_COMMANDS.map((c) => `"${c}"`).join(" ")})

  local -a servers_subs apps_subs deployments_subs logs_subs env_subs domains_subs profile_subs keyring_subs
  servers_subs=("ls" "get" "metrics")
  apps_subs=("ls" "get" "deploy" "logs" "restart")
  deployments_subs=("ls" "get" "logs")
  logs_subs=("tail")
  env_subs=("ls" "set" "rm" "get")
  domains_subs=("ls" "add" "verify")
  profile_subs=("ls" "use" "rm")
  keyring_subs=("status" "migrate" "export")

  if (( CURRENT == 2 )); then
    _describe 'command' top
    return
  fi

  case "\${words[2]}" in
    servers)     _describe 'subcommand' servers_subs;;
    apps)        _describe 'subcommand' apps_subs;;
    deployments) _describe 'subcommand' deployments_subs;;
    logs)        _describe 'subcommand' logs_subs;;
    env)         _describe 'subcommand' env_subs;;
    domains)     _describe 'subcommand' domains_subs;;
    profile)     _describe 'subcommand' profile_subs;;
    keyring)     _describe 'subcommand' keyring_subs;;
  esac
}
compdef _reoclo reoclo
`;

const FISH = `# reoclo fish completion
complete -c reoclo -n "__fish_use_subcommand" -a "${TOP_LEVEL_COMMANDS.join(" ")}"

complete -c reoclo -n "__fish_seen_subcommand_from servers"     -a "ls get metrics"
complete -c reoclo -n "__fish_seen_subcommand_from apps"        -a "ls get deploy logs restart"
complete -c reoclo -n "__fish_seen_subcommand_from deployments" -a "ls get logs"
complete -c reoclo -n "__fish_seen_subcommand_from logs"        -a "tail"
complete -c reoclo -n "__fish_seen_subcommand_from env"         -a "ls set rm get"
complete -c reoclo -n "__fish_seen_subcommand_from domains"     -a "ls add verify"
complete -c reoclo -n "__fish_seen_subcommand_from profile"     -a "ls use rm"
complete -c reoclo -n "__fish_seen_subcommand_from keyring"     -a "status migrate export"
`;

export function registerCompletion(program: Command): void {
  program
    .command("completion <shell>")
    .description("emit a shell completion script (bash | zsh | fish)")
    .action((shell: string) => {
      const normalized = shell.toLowerCase();
      switch (normalized) {
        case "bash":
          process.stdout.write(BASH);
          return;
        case "zsh":
          process.stdout.write(ZSH);
          return;
        case "fish":
          process.stdout.write(FISH);
          return;
        default: {
          process.stderr.write(
            `unsupported shell: ${shell}\nuse one of: bash, zsh, fish\n`,
          );
          const err = new Error(`unsupported shell: ${shell}`) as Error & {
            exitCode: number;
          };
          err.exitCode = 2;
          throw err;
        }
      }
    });
}
