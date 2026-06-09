// src/commands/exec.ts
import { type Command, Help } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { globalOutput, printObject, resolveFormat } from "../ui/output";
import { requireCapability, withCompletion } from "../client/command-meta";
import { detectCiContext } from "../ci/context";
import type { RunContext } from "../ci/context";
import {
  execOnServer,
  requireServerUuid,
  type AutomationExecRequest,
  type AutomationExecResult,
} from "../ci/automation-client";

export interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Automation path only — surfaced so the `run` GitHub Action can map them to outputs. */
  operation_id?: string;
  duration_ms?: number;
}

/** Shape the automation exec result into the JSON output object. Carries
 *  `operation_id` + `duration_ms` (which the `run` action exposes as outputs);
 *  the tenant path's response has neither and is passed through unchanged. */
export function buildAutomationExecOutput(r: AutomationExecResult): ExecResponse {
  return {
    exit_code: r.exit_code,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: false,
    operation_id: r.operation_id,
    duration_ms: r.duration_ms,
  };
}

export type SupportedShell = "bash" | "sh";

/**
 * Wrap argv into "<shell> -c '<joined>'" with POSIX-safe single-quote escaping.
 * @param shell - must be "bash" or "sh"; throws otherwise.
 * @param commandParts - non-empty argv; throws on empty.
 * @throws {Error} if shell is unsupported or commandParts is empty.
 */
export function buildShellWrappedCommand(
  shell: string,
  commandParts: string[],
): string {
  if (shell !== "bash" && shell !== "sh") {
    throw new Error(`unsupported shell: ${shell} (expected 'bash' or 'sh')`);
  }
  if (commandParts.length === 0) {
    throw new Error("commandParts must not be empty");
  }
  const joined = commandParts.join(" ");
  // POSIX-safe: every single quote in the body becomes '\'' (close-quote,
  // escaped-quote, reopen-quote). The body is then wrapped in single quotes.
  const escaped = joined.replace(/'/g, "'\\''");
  return `${shell} -c '${escaped}'`;
}

// Chars that never need quoting in a POSIX shell word. Anything else (spaces,
// glob/pipe/redirect metacharacters, braces, quotes, …) forces quoting.
const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote one argv element unless it is already shell-safe. */
function shQuoteArg(arg: string): string {
  if (arg.length > 0 && SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Join argv into one command string with **argv-exec** semantics: each element
 * is individually POSIX-quoted so the remote shell reconstructs the exact
 * arguments. A space inside a single arg — e.g. a Go-template `{{json .X}}` —
 * stays one token instead of being split by the remote shell. (Use `--shell`
 * when you actually want pipes/redirects/globs interpreted.)
 */
export function buildArgvCommand(commandParts: string[]): string {
  return commandParts.map(shQuoteArg).join(" ");
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a dotenv-style file body into a {KEY: VAL} dict.
 *
 * - Keys: leading/trailing whitespace ignored; key shape must match
 *   `^[A-Za-z_][A-Za-z0-9_]*$`.
 * - Values: split on the first `=` only (so URLs with embedded `=` work).
 *   Whitespace is preserved verbatim; wrap in quotes if you need unambiguous
 *   leading/trailing spaces.
 * - One matching outer layer of `'...'` or `"..."` is stripped. Mismatched or
 *   unclosed quotes are preserved literally — no error is raised for the
 *   ambiguous `'a'b'` case.
 * - No variable expansion. No escape sequences.
 *
 * `filename` is used only in error messages.
 */
export function parseEnvFile(body: string, filename: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) {
      throw new Error(`${filename}: line ${i + 1}: expected KEY=VAL, got: ${raw}`);
    }
    const key = raw.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      throw new Error(`${filename}: line ${i + 1}: invalid key: ${key}`);
    }
    let value = raw.slice(eq + 1);
    // Strip matching outer single or double quotes (exactly one layer).
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Mask threshold. Values shorter than this are not replaced — short common
 * strings like "PROD", "1", or short keywords would otherwise garble normal
 * output. Real secrets (JWTs, DB URLs, API keys) comfortably exceed 8 chars;
 * users with shorter secrets can pass `--no-mask-env`.
 */
export const MASK_MIN_LENGTH = 8;
const MASK_TOKEN = "***";

/** Replace every literal occurrence of each env value (length >= MASK_MIN_LENGTH)
 *  in `text` with "***". Longer values are masked first so shorter substrings
 *  don't pre-empt longer matches. Uses literal split/join, not regex. */
export function maskOutput(text: string, env: Record<string, string>): string {
  const values = Object.values(env)
    .filter((v) => typeof v === "string" && v.length >= MASK_MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) {
    out = out.split(v).join(MASK_TOKEN);
  }
  return out;
}

/** True if argv looks like 'sh -c <X> <Y> ...' (3+ args after -c), which is
 *  almost always a shell-quoting mistake by the caller. */
export function detectShCQuotingFootgun(commandParts: string[]): boolean {
  return (
    (commandParts[0] === "sh" || commandParts[0] === "bash") &&
    commandParts[1] === "-c" &&
    commandParts.length > 3
  );
}

export function buildAutomationExecBody(args: {
  serverId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  runId?: string;
  runContext?: RunContext;
}): AutomationExecRequest {
  const body: AutomationExecRequest = { server_id: args.serverId, command: args.command };
  if (args.cwd) body.working_directory = args.cwd;
  if (args.env && Object.keys(args.env).length > 0) body.env = args.env;
  if (args.timeoutSeconds !== undefined) body.timeout_seconds = args.timeoutSeconds;
  if (args.runId) body.run_id = args.runId;
  if (args.runContext) body.run_context = args.runContext;
  return body;
}

export function registerExec(program: Command): void {
  const execCmd = withCompletion(program.command("exec <serverIdOrName> [command...]"), {
    args: [{ slot: 0, resource: "servers" }],
    flags: { "--scope": { enum: ["host", "rootless"] } },
  });
  requireCapability(execCmd, "server:exec");
  execCmd
    .description(
      "run a command on a server via the runner (use -- to separate flags from the command)",
    )
    .option("--timeout <seconds>", "command timeout in seconds (default 600)")
    .option("--cwd <path>", "working directory on the server")
    .option(
      "--env <KEY=VAL...>",
      "set environment variables for the command (repeatable)",
      (value: string, accum: Record<string, string> = {}) => {
        const eq = value.indexOf("=");
        if (eq <= 0) {
          throw new Error(`--env expects KEY=VAL, got: ${value}`);
        }
        accum[value.slice(0, eq)] = value.slice(eq + 1);
        return accum;
      },
      {} as Record<string, string>,
    )
    .option(
      "--env-file <path>",
      "load env vars from a dotenv-style file (KEY=VAL per line). --env overrides on key collision.",
    )
    .option(
      "--shell <sh|bash>",
      "wrap the command in '<shell> -c ...' so pipes, redirects and globs work without manual quoting",
    )
    .option("--mask-env", "replace values from --env/--env-file with *** in output", true)
    .option("--no-mask-env", "disable masking of --env/--env-file values in output")
    .option("--scope <scope>", "execution scope: host or rootless (default host)", "host")
    // Commander v12 quirk: addHelpText() output is NOT included in helpInformation();
    // override formatHelp so our Examples block appears in both `--help` and programmatic
    // help (which tests assert on).
    .configureHelp({
      formatHelp: (cmd, helper) => {
        const base = Help.prototype.formatHelp.call(helper, cmd, helper);
        return (
          base +
          [
            "",
            "Examples:",
            "  reoclo exec my-server -- docker ps",
            "  reoclo exec --shell bash my-server -- 'docker exec backend env | wc -l'",
            "  reoclo exec --env DATABASE_URL=\"$DB\" my-server -- ./migrate.sh",
            "  reoclo exec --env-file .env.prod my-server -- ./script",
            "",
          ].join("\n")
        );
      },
    })
    .action(
      async (
        serverIdOrName: string,
        commandParts: string[],
        opts: {
          timeout?: string;
          cwd?: string;
          env?: Record<string, string>;
          envFile?: string;
          shell?: string;
          maskEnv?: boolean;
          scope?: string;
        },
      ) => {
        if (!commandParts || commandParts.length === 0) {
          const e = new Error(
            "no command given — use: reoclo exec <server> -- <command>",
          ) as Error & { exitCode: number };
          e.exitCode = 2;
          throw e;
        }

        // Validate --shell up front for a clear error before any I/O.
        if (opts.shell !== undefined && opts.shell !== "bash" && opts.shell !== "sh") {
          const e = new Error(
            `--shell expects 'bash' or 'sh', got: ${opts.shell}`,
          ) as Error & { exitCode: number };
          e.exitCode = 2;
          throw e;
        }

        // Merge --env-file then --env (CLI flags win on collision).
        let mergedEnv: Record<string, string> = {};
        if (opts.envFile) {
          const fs = await import("node:fs/promises");
          let body: string;
          try {
            body = await fs.readFile(opts.envFile, "utf8");
          } catch (cause) {
            const e = new Error(
              `failed to read --env-file: ${(cause as Error).message}`,
            ) as Error & { exitCode: number };
            e.exitCode = 2;
            throw e;
          }
          mergedEnv = parseEnvFile(body, opts.envFile);
        }
        if (opts.env) {
          mergedEnv = { ...mergedEnv, ...opts.env };
        }

        // Advisory footgun warning — non-blocking.
        if (detectShCQuotingFootgun(commandParts)) {
          process.stderr.write(
            "warning: 'sh -c' followed by multiple arguments is usually a quoting issue. " +
              "Try: reoclo exec --shell sh ... -- '<your script as a single arg>'\n",
          );
        }

        // Build the command string for the API.
        const command =
          opts.shell !== undefined
            ? buildShellWrappedCommand(opts.shell, commandParts)
            : buildArgvCommand(commandParts);

        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();

        let res: ExecResponse;
        if (ctx.tokenType === "automation") {
          if (opts.scope && opts.scope !== "host") {
            process.stderr.write(
              "warning: --scope is ignored for automation keys (not supported by the automation API)\n",
            );
          }
          // CI / automation-key path: flat /api/automation/v1/exec + run_context.
          const sid = requireServerUuid(serverIdOrName);
          const ci = detectCiContext();
          const r = await execOnServer(
            ctx.client,
            buildAutomationExecBody({
              serverId: sid,
              command,
              cwd: opts.cwd,
              env: mergedEnv,
              timeoutSeconds: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
              runId: ci.runId,
              runContext: ci.runContext,
            }),
          );
          res = buildAutomationExecOutput(r);
        } else {
          const tid = requireTenantId(ctx);
          const serverId = await resolveServer(ctx.client, tid, serverIdOrName);
          const body: Record<string, unknown> = { command };
          if (opts.timeout) body["timeout"] = Number.parseInt(opts.timeout, 10);
          if (opts.cwd) body["working_directory"] = opts.cwd;
          if (Object.keys(mergedEnv).length > 0) body["env"] = mergedEnv;
          if (opts.scope && opts.scope !== "host") body["scope"] = opts.scope;
          res = await ctx.client.post<ExecResponse>(
            `/tenants/${tid}/servers/${serverId}/exec`,
            body,
          );
        }

        // Apply masking before any output (default on; --no-mask-env opts out).
        const masked: ExecResponse =
          opts.maskEnv === false
            ? res
            : {
                ...res,
                stdout: maskOutput(res.stdout, mergedEnv),
                stderr: maskOutput(res.stderr, mergedEnv),
              };

        if (fmt === "json" || fmt === "yaml") {
          printObject(masked as unknown as Record<string, unknown>, fmt);
        } else {
          if (masked.stdout) process.stdout.write(masked.stdout);
          if (masked.stderr) process.stderr.write(masked.stderr);
          if (masked.truncated) {
            process.stderr.write("\n[output truncated]\n");
          }
        }

        if (masked.exit_code !== 0) {
          const e = new Error(`command exited ${masked.exit_code}`) as Error & {
            exitCode: number;
          };
          e.exitCode = masked.exit_code;
          throw e;
        }
      },
    );
}
