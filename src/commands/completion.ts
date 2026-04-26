// src/commands/completion.ts
//
// Tab completion for the Reoclo CLI. Two surfaces:
//
//   1. `reoclo completion <shell>` — emit the shell shim (a tiny script that
//      defers all completion logic back to `reoclo __complete`).
//   2. `reoclo completion install` — write the shim to disk and wire it into
//      the user's rc file.
//
// The actual candidate computation lives in src/completion/engine.ts. The
// hidden `__complete` command (registered here) is what the shim invokes.

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getCompletionCandidates } from "../completion/engine";

type Shell = "bash" | "zsh" | "fish";

const BASH_SHIM = `# reoclo bash completion
_reoclo() {
  local cur cwords candidates
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if (( COMP_CWORD > 0 )); then
    cwords=("\${COMP_WORDS[@]:1:COMP_CWORD-1}")
  else
    cwords=()
  fi
  if ! candidates=$(reoclo __complete "\${cwords[@]}" -- "\${cur}" 2>/dev/null); then
    return
  fi
  COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
}
complete -F _reoclo reoclo
`;

const ZSH_SHIM = `#compdef reoclo
# reoclo zsh completion
_reoclo() {
  local cur cwords candidates
  cur="\${words[CURRENT]}"
  cwords=("\${(@)words[2,CURRENT-1]}")
  candidates=("\${(@f)$(reoclo __complete "\${cwords[@]}" -- "\${cur}" 2>/dev/null)}")
  compadd -- "\${candidates[@]}"
}
compdef _reoclo reoclo
`;

const FISH_SHIM = `# reoclo fish completion
function __reoclo_complete
  set -l tokens (commandline -opc)
  set -l current (commandline -ct)
  # Drop the program name (first token) so we pass only typed args.
  set -e tokens[1]
  reoclo __complete $tokens -- "$current" 2>/dev/null
end
complete -c reoclo -f -a "(__reoclo_complete)"
`;

export function getShimScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return BASH_SHIM;
    case "zsh":
      return ZSH_SHIM;
    case "fish":
      return FISH_SHIM;
  }
}

interface InstallTarget {
  shell: Shell;
  scriptPath: string; // where the completion script lives
  rcPath?: string; // rc file we may need to edit (none for fish)
  rcLine?: string; // line to append if rcPath set and not already present
}

export function getInstallTarget(shell: Shell, home: string): InstallTarget {
  switch (shell) {
    case "bash":
      return {
        shell,
        scriptPath: join(home, ".reoclo-completion.bash"),
        rcPath: join(home, ".bashrc"),
        rcLine: `[ -f "$HOME/.reoclo-completion.bash" ] && source "$HOME/.reoclo-completion.bash"`,
      };
    case "zsh":
      return {
        shell,
        scriptPath: join(home, ".zfunc", "_reoclo"),
        rcPath: join(home, ".zshrc"),
        rcLine: `fpath=("$HOME/.zfunc" $fpath)\nautoload -U compinit && compinit`,
      };
    case "fish":
      return {
        shell,
        scriptPath: join(home, ".config", "fish", "completions", "reoclo.fish"),
      };
  }
}

function detectShell(): Shell {
  const sh = process.env.SHELL ?? "";
  if (sh.includes("zsh")) return "zsh";
  if (sh.includes("fish")) return "fish";
  return "bash";
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

interface InstallOpts {
  shell?: string;
  force?: boolean;
  print?: boolean;
}

async function runInstall(opts: InstallOpts): Promise<void> {
  const raw = (opts.shell ?? detectShell()).toLowerCase();
  if (raw !== "bash" && raw !== "zsh" && raw !== "fish") {
    process.stderr.write(`unsupported shell: ${raw}\nuse one of: bash, zsh, fish\n`);
    const err = new Error(`unsupported shell: ${raw}`) as Error & { exitCode: number };
    err.exitCode = 2;
    throw err;
  }
  const shell: Shell = raw;
  const home = process.env.HOME ?? homedir();
  const target = getInstallTarget(shell, home);
  const script = getShimScript(shell);

  if (opts.print) {
    process.stdout.write(`# would write to: ${target.scriptPath}\n`);
    process.stdout.write(script);
    if (target.rcPath && target.rcLine) {
      process.stdout.write(`\n# would append to ${target.rcPath} (if not already present):\n`);
      process.stdout.write(target.rcLine + "\n");
    }
    return;
  }

  // Write the script. Prompt before overwriting an existing different file.
  if (existsSync(target.scriptPath) && !opts.force) {
    const existing = readFileSync(target.scriptPath, "utf8");
    if (existing !== script) {
      const ok = await promptYesNo(
        `${target.scriptPath} already exists with different content. Overwrite? [y/N] `,
      );
      if (!ok) {
        process.stderr.write("aborted — re-run with --force to overwrite without prompting\n");
        const err = new Error("install aborted") as Error & { exitCode: number };
        err.exitCode = 1;
        throw err;
      }
    }
  }
  mkdirSync(dirname(target.scriptPath), { recursive: true });
  writeFileSync(target.scriptPath, script, "utf8");
  process.stdout.write(`✓ installed ${shell} completion to ${target.scriptPath}\n`);

  // For shells that need an rc edit, append the source line if missing.
  if (target.rcPath && target.rcLine) {
    let rc = "";
    if (existsSync(target.rcPath)) rc = readFileSync(target.rcPath, "utf8");
    if (!rc.includes(target.rcLine)) {
      const sep = rc.length > 0 && !rc.endsWith("\n") ? "\n" : "";
      writeFileSync(target.rcPath, rc + sep + target.rcLine + "\n", "utf8");
      process.stdout.write(`✓ appended source line to ${target.rcPath}\n`);
    } else {
      process.stdout.write(`(source line already present in ${target.rcPath})\n`);
    }
    process.stdout.write(`→ restart your shell or run: source ${target.rcPath}\n`);
  } else {
    process.stdout.write(`→ restart your shell to enable completion\n`);
  }
}

function parseCompleteArgs(args: string[]): { words: string[]; current: string } {
  // Convention: everything after `--` is the current partial word; words
  // before `--` are the typed args. If `--` is missing, treat the last token
  // as the current and the rest as typed words.
  const sepIdx = args.indexOf("--");
  if (sepIdx >= 0) {
    return {
      words: args.slice(0, sepIdx),
      current: args.slice(sepIdx + 1).join(" "),
    };
  }
  if (args.length === 0) return { words: [], current: "" };
  return { words: args.slice(0, -1), current: args[args.length - 1] ?? "" };
}

export function registerCompletion(program: Command): void {
  // Hidden `__complete` command. Must NEVER throw — completion failures must
  // be invisible to the user.
  //
  // Commander strips `--` from arguments and treats anything after as
  // positional, so we deliberately bypass argument parsing here and read
  // process.argv directly. The contract: every token after `__complete` is
  // the engine's input, with `--` separating typed words from the current
  // partial.
  program
    .command("__complete", { hidden: true })
    .description("internal: emit completion candidates (used by shell shims)")
    .allowUnknownOption(true)
    .helpOption(false)
    .argument("[args...]", "words typed so far, then `--`, then the partial")
    .action(() => {
      try {
        // Slice out everything after `__complete` from the raw argv. This
        // avoids Commander's `--` munging.
        const argv = process.argv;
        const idx = argv.indexOf("__complete");
        const raw = idx >= 0 ? argv.slice(idx + 1) : [];
        const { words, current } = parseCompleteArgs(raw);
        const candidates = getCompletionCandidates(program, words, current);
        for (const c of candidates) process.stdout.write(c + "\n");
      } catch {
        // Silent failure — completion must never surface errors.
      }
    });

  // `completion <shell|install>` keeps the v0.9.1 positional shape so
  // existing `reoclo completion bash > foo` invocations still work. The
  // single positional accepts a shell name (emit shim) or the literal
  // "install" (write + wire into rc).
  program
    .command("completion <shellOrInstall> [installArgs...]")
    .description(
      "emit a shell completion shim (bash | zsh | fish), or `install` to write + wire it",
    )
    .option("--shell <bash|zsh|fish>", "(install only) override shell detection")
    .option("--force", "(install only) overwrite an existing completion file without prompting")
    .option("--print", "(install only) print what would happen; don't write anything")
    .action(
      async (
        shellOrInstall: string,
        _installArgs: string[],
        opts: InstallOpts,
      ) => {
        const arg = shellOrInstall.toLowerCase();
        if (arg === "install") {
          await runInstall(opts);
          return;
        }
        if (arg === "bash" || arg === "zsh" || arg === "fish") {
          process.stdout.write(getShimScript(arg));
          return;
        }
        process.stderr.write(
          `unsupported shell: ${shellOrInstall}\nuse one of: bash, zsh, fish\n`,
        );
        const err = new Error(`unsupported shell: ${shellOrInstall}`) as Error & {
          exitCode: number;
        };
        err.exitCode = 2;
        throw err;
      },
    );
}
