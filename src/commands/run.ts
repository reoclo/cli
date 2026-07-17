import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import { EXIT } from "../client/exit-codes";
import { detectKeyType } from "../client/routing";
import { accessibleProjects, mergeEnv, openSession, resolve } from "../client/secrets";

export function splitRunArgs(rest: string[]): { cmd: string; args: string[] } {
  if (rest.length === 0) {
    throw new Error("nothing to run: reoclo run [--project p] -- <cmd> [args...]");
  }
  return { cmd: rest[0]!, args: rest.slice(1) };
}

/**
 * Pick the project ids to resolve, or throw with RESOLUTION_FAILED.
 *
 * Exit code matters more here than anywhere else in the CLI: `run` passes the
 * child's exit code straight through, so reusing GENERIC (1) — as this did —
 * made "your key has no grant" indistinguishable from "your migration script
 * exited 1". Pipelines are told to branch on the exit code, and that is exactly
 * the branch they most need.
 *
 * A project that exists but is not granted and a project that does not exist
 * are deliberately reported the same way, so a key cannot enumerate projects it
 * cannot read.
 */
export function selectProjectIds(
  accessible: { id: string; name: string }[],
  wanted: string[],
): string[] {
  if (accessible.length === 0) {
    const err = new Error("this token has no accessible secret projects") as Error & {
      exitCode: number;
    };
    err.exitCode = EXIT.RESOLUTION_FAILED;
    throw err;
  }

  if (wanted.length === 0) return accessible.map((p) => p.id);

  const want = new Set(wanted);
  const ids = accessible.filter((p) => want.has(p.name) || want.has(p.id)).map((p) => p.id);
  if (ids.length === 0) {
    const err = new Error(`no accessible project matched: ${wanted.join(", ")}`) as Error & {
      exitCode: number;
    };
    err.exitCode = EXIT.RESOLUTION_FAILED;
    throw err;
  }
  return ids;
}

export function collectCiMeta(
  env: Record<string, string | undefined>,
  commitFlag: string | undefined,
): { commit_sha?: string; workflow_run_id?: string } {
  const meta: { commit_sha?: string; workflow_run_id?: string } = {};
  const sha = commitFlag ?? env.GITHUB_SHA;
  if (sha) meta.commit_sha = sha;
  if (env.GITHUB_RUN_ID) meta.workflow_run_id = env.GITHUB_RUN_ID;
  return meta;
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("resolve granted secrets and run a command with them injected as env vars")
    .option(
      "-p, --project <name>",
      "limit to project (repeatable)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("--commit <sha>", "commit sha for the audit trail")
    .argument("[command...]", "command to run (after --)")
    .addHelpText(
      "after",
      `
Examples:
  REOCLO_AUTOMATION_KEY=rca_... reoclo run -- node deploy.js
  REOCLO_AUTOMATION_KEY=rca_... reoclo run -p prod -- ./migrate.sh
  REOCLO_AUTOMATION_KEY=rca_... reoclo run --commit abc123 -- ./release.sh`,
    )
    .action(async (command: string[], opts: { project: string[]; commit?: string }) => {
      const { cmd, args } = splitRunArgs(command);

      const ctx = await bootstrap();

      // Precheck: this command requires an automation key (rca_ or rss_).
      // If bootstrap resolved a tenant/OAuth token, fail fast before hitting
      // the automation surface.
      if (detectKeyType(ctx.token) === "tenant") {
        const err = new Error(
          "reoclo run requires an automation key; set REOCLO_AUTOMATION_KEY",
        ) as Error & { exitCode: number };
        err.exitCode = EXIT.DENIED;
        throw err;
      }

      const ids = selectProjectIds(await accessibleProjects(ctx.client), opts.project);

      const session = await openSession(
        ctx.client,
        ids,
        collectCiMeta(process.env, opts.commit),
      );

      // Re-resolve using the short-lived rss_ session token so the API can
      // record which secrets were consumed and by which session.
      const sessionClient = ctx.client.withToken(session.session_token);
      const { values } = await resolve(sessionClient, ids);

      const child = Bun.spawn([cmd, ...args], {
        env: mergeEnv(process.env, values),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });

      const code = await child.exited;
      process.exit(code);
    });
}
