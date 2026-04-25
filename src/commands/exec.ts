// src/commands/exec.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { printObject, resolveFormat } from "../ui/output";

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function registerExec(program: Command): void {
  program
    .command("exec <serverIdOrName> [command...]")
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
      "--scope <scope>",
      "execution scope: host or rootless (default host)",
      "host",
    )
    .action(
      async (
        serverIdOrName: string,
        commandParts: string[],
        opts: {
          timeout?: string;
          cwd?: string;
          env?: Record<string, string>;
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
        const command = commandParts.join(" ");

        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const serverId = await resolveServer(ctx.client, tid, serverIdOrName);

        const body: Record<string, unknown> = { command };
        if (opts.timeout) body["timeout"] = Number.parseInt(opts.timeout, 10);
        if (opts.cwd) body["working_directory"] = opts.cwd;
        if (opts.env && Object.keys(opts.env).length > 0) body["env"] = opts.env;
        if (opts.scope && opts.scope !== "host") body["scope"] = opts.scope;

        const res = await ctx.client.post<ExecResponse>(
          `/tenants/${tid}/servers/${serverId}/exec`,
          body,
        );

        if (fmt === "json" || fmt === "yaml") {
          printObject(res as unknown as Record<string, unknown>, fmt);
        } else {
          if (res.stdout) process.stdout.write(res.stdout);
          if (res.stderr) process.stderr.write(res.stderr);
          if (res.truncated) {
            process.stderr.write("\n[output truncated]\n");
          }
        }

        if (res.exit_code !== 0) {
          const e = new Error(`command exited ${res.exit_code}`) as Error & {
            exitCode: number;
          };
          e.exitCode = res.exit_code;
          throw e;
        }
      },
    );
}
