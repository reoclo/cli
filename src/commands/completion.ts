// src/commands/completion.ts
//
// Tab completion for the Reoclo CLI. Four surfaces:
//
//   1. `reoclo completion <shell>` — emit the shell shim (a tiny script that
//      defers all completion logic back to `reoclo __complete`).
//   2. `reoclo completion install` — write the shim to disk and wire it into
//      the user's rc file.
//   3. `reoclo completion warm` — pre-populate the local completion cache from
//      the server index endpoint.
//   4. `reoclo __refresh-completion` (hidden) — silently refresh the cache in
//      the background; invoked automatically after commands that mutate
//      resources.
//
// The actual candidate computation lives in src/completion/engine.ts. The
// hidden `__complete` command (registered here) is what the shim invokes.

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getCompletionCandidates } from "../completion/engine";
import type { Candidate } from "../completion/types";
import { withCompletion } from "../client/command-meta";
import { globalProfileFlag } from "../config/profile-resolve";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { fetchCompletionIndex } from "../completion/index-client";
import { writeAllSlices } from "../completion/cache";
import { NotFoundError } from "../client/errors";
import { promptYesNo } from "../ui/prompt";

type Shell = "bash" | "zsh" | "fish";

const BASH_SHIM = `# reoclo bash completion (also registers for the 'rc' alias)
_reoclo() {
  local cur cwords raw val _desc
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if (( COMP_CWORD > 0 )); then
    cwords=("\${COMP_WORDS[@]:1:COMP_CWORD-1}")
  else
    cwords=()
  fi
  if ! raw=$(reoclo __complete --proto 2 "\${cwords[@]}" -- "\${cur}" 2>/dev/null); then
    return
  fi
  # Read value<TAB>desc lines; take only the value and backslash-escape spaces
  # so multi-word names ("Reoclo Production") survive bash's word-split on
  # insertion. The CLI already prefix-filters; no need for compgen.
  COMPREPLY=()
  while IFS=\$'\\t' read -r val _desc; do
    [ -z "\$val" ] && continue
    COMPREPLY+=("\${val// /\\\\ }")
  done <<< "\$raw"
}
complete -F _reoclo reoclo
complete -F _reoclo rc
`;

const ZSH_SHIM = `#compdef reoclo rc
# reoclo zsh completion (also registers for the 'rc' alias)
_reoclo() {
  local cur cwords
  cur="\${words[CURRENT]}"
  cwords=("\${(@)words[2,CURRENT-1]}")
  local -a lines vals descs
  lines=("\${(@f)\$(reoclo __complete --proto 2 "\${cwords[@]}" -- "\${cur}" 2>/dev/null)}")
  for l in "\${lines[@]}"; do
    [ -z "\$l" ] && continue
    vals+=("\${l%%\$'\\t'*}")
    descs+=("\${l/\$'\\t'/ -- }")
  done
  (( \${#vals} )) && compadd -d descs -- "\${vals[@]}"
}
compdef _reoclo reoclo rc
`;

const FISH_SHIM = `# reoclo fish completion (also registers for the 'rc' alias)
function __reoclo_complete
  set -l tokens (commandline -opc)
  set -l current (commandline -ct)
  # Drop the program name (first token) so we pass only typed args.
  set -e tokens[1]
  reoclo __complete --proto 2 $tokens -- "$current" 2>/dev/null
end
complete -c reoclo -f -a "(__reoclo_complete)"
complete -c rc     -f -a "(__reoclo_complete)"
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

/** Render candidates for the shell shim. proto>=2 → `value\tdesc`; else plain. */
export function formatCandidates(cands: Candidate[], proto: number): string {
  const lines = cands.map((c) =>
    proto >= 2 && c.desc ? `${c.value}\t${c.desc}` : c.value,
  );
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
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

  try {
    const warmed = await warmCache(undefined);
    if (warmed) process.stdout.write("✓ completion cache warmed\n");
  } catch {
    // not logged in / offline — warming is optional during install
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

/** Fetch the completion index and write every slice. Returns false (with a
 *  soft notice) if the API has no /completion-index endpoint yet. */
export async function warmCache(profile?: string): Promise<boolean> {
  const ctx = await bootstrap({ profile });
  const tid = requireTenantId(ctx);
  try {
    const slices = await fetchCompletionIndex(ctx.client, tid);
    writeAllSlices(slices);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) {
      process.stderr.write(
        "completion: this Reoclo API does not support `completion warm` yet — skipping\n",
      );
      return false;
    }
    throw err;
  }
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
        let raw = idx >= 0 ? argv.slice(idx + 1) : [];
        // Extract the optional `--proto N` marker (default proto 1 = old shim).
        let proto = 1;
        const pIdx = raw.indexOf("--proto");
        if (pIdx >= 0 && raw[pIdx + 1]) {
          const n = Number(raw[pIdx + 1]);
          proto = Number.isFinite(n) && n > 0 ? n : 1;
          raw = [...raw.slice(0, pIdx), ...raw.slice(pIdx + 2)];
        }
        const { words, current } = parseCompleteArgs(raw);
        const candidates = getCompletionCandidates(program, words, current);
        process.stdout.write(formatCandidates(candidates, proto));
      } catch {
        // Silent failure — completion must never surface errors.
      }
    });

  // `completion <shell|install>` keeps the v0.9.1 positional shape so
  // existing `reoclo completion bash > foo` invocations still work. The
  // single positional accepts a shell name (emit shim) or the literal
  // "install" (write + wire into rc).
  const completionCmd = withCompletion(
    program
      .command("completion <shellOrInstall> [installArgs...]")
      .description(
        "emit a shell completion shim (bash | zsh | fish), or `install` to write + wire it",
      )
      .option("--shell <bash|zsh|fish>", "(install only) override shell detection")
      .option("--force", "(install only) overwrite an existing completion file without prompting")
      .option("--print", "(install only) print what would happen without writing anything")
      .action(async (shellOrInstall: string, _installArgs: string[], opts: InstallOpts) => {
        const arg = shellOrInstall.toLowerCase();
        if (arg === "install") {
          await runInstall(opts);
          return;
        }
        if (arg === "bash" || arg === "zsh" || arg === "fish") {
          process.stdout.write(getShimScript(arg));
          return;
        }
        process.stderr.write(`unsupported shell: ${shellOrInstall}\nuse one of: bash, zsh, fish\n`);
        const err = new Error(`unsupported shell: ${shellOrInstall}`) as Error & {
          exitCode: number;
        };
        err.exitCode = 2;
        throw err;
      }),
    { flags: { "--shell": { enum: ["bash", "zsh", "fish"] } } },
  );

  completionCmd
    .command("warm")
    // No command-local `--profile` — bootstrap()/warmCache honor the global flag.
    .description("pre-populate the local completion cache from the server")
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      const ok = await warmCache(globalProfileFlag(command));
      if (ok) process.stdout.write("✓ completion cache warmed\n");
    });

  program
    .command("__refresh-completion", { hidden: true })
    .description("internal: silently refresh the completion cache")
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      try {
        await warmCache(globalProfileFlag(command));
      } catch {
        // silent — background refresh must never surface errors
      }
    });
}
