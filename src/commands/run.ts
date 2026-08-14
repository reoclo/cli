import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import { EXIT } from "../client/exit-codes";
import type { KeyType } from "../client/routing";
import { accessibleProjects, mergeEnv, openSession, resolve } from "../client/secrets";
import { assertInputExists, buildEnv, collectRefs, parseTemplate } from "../secrets/template";
import { machineResolver } from "../secrets/resolvers";

/**
 * `--env-file` resolves projects implicitly from each `op://` reference's
 * vault segment, so pairing it with `--project` would leave one of the two
 * scoping mechanisms silently ignored. Reject the combination outright
 * rather than guess which one wins.
 */
export function assertEnvFileProjectExclusive(
  envFile: string | undefined,
  project: string[],
): void {
  if (envFile && project.length > 0) {
    const err = new Error(
      "--env-file already scopes projects via each op:// vault; drop --project",
    ) as Error & { exitCode: number };
    err.exitCode = EXIT.MISUSE;
    throw err;
  }
}

/** Refuse interactive sessions: run hands secrets to a process, a machine act. */
export function assertMachineCredential(tokenType: KeyType): void {
  if (tokenType !== "tenant") return;
  const err = new Error(
    "reoclo run requires a machine credential; set REOCLO_AUTOMATION_KEY (rca_) " +
      "or REOCLO_MACHINE_TOKEN (rk_m_)",
  ) as Error & { exitCode: number };
  err.exitCode = EXIT.DENIED;
  throw err;
}

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
    const err = new Error(
      "this credential is granted no secret projects. An operation or a role " +
        "does not grant a project: grant each project to this automation key " +
        "or machine user on the project's Access tab. A project that is " +
        "restricted to specific servers is never available to a machine user.",
    ) as Error & {
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
    .option(
      "--env-file <path>",
      "render an op:// template (op inject/run drop-in) instead of dumping all granted secrets",
    )
    .argument("[command...]", "command to run (after --)")
    .addHelpText(
      "after",
      `
Examples:
  REOCLO_AUTOMATION_KEY=rca_... reoclo run -- node deploy.js
  REOCLO_MACHINE_TOKEN=rk_m_... reoclo run -- node deploy.js
  REOCLO_MACHINE_TOKEN=rk_m_... reoclo run -p prod -- ./migrate.sh
  REOCLO_AUTOMATION_KEY=rca_... reoclo run --env-file .env.tpl -- ./migrate.sh`,
    )
    .action(
      async (command: string[], opts: { project: string[]; commit?: string; envFile?: string }) => {
        const { cmd, args } = splitRunArgs(command);
        assertEnvFileProjectExclusive(opts.envFile, opts.project);

        const ctx = await bootstrap();

        // Precheck: this command requires a machine credential (an automation
        // key or a machine user's token). If bootstrap resolved an interactive
        // tenant/OAuth session, fail fast before hitting the automation surface.
        assertMachineCredential(ctx.tokenType);

        let values: Record<string, string>;
        if (opts.envFile) {
          assertInputExists(await Bun.file(opts.envFile).exists(), opts.envFile);
          const lines = parseTemplate(await Bun.file(opts.envFile).text());
          const { refs } = collectRefs(lines);
          const resolved =
            refs.length === 0
              ? new Map<string, Record<string, string>>()
              : await machineResolver(ctx.client, collectCiMeta(process.env, opts.commit))(refs);
          values = buildEnv(lines, resolved);
        } else {
          const ids = selectProjectIds(await accessibleProjects(ctx.client), opts.project);

          const session = await openSession(
            ctx.client,
            ids,
            collectCiMeta(process.env, opts.commit),
          );

          // Re-resolve using the short-lived rss_ session token so the API can
          // record which secrets were consumed and by which session.
          const sessionClient = ctx.client.withToken(session.session_token);
          ({ values } = await resolve(sessionClient, ids));
        }

        const child = Bun.spawn([cmd, ...args], {
          env: mergeEnv(process.env, values),
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });

        const code = await child.exited;
        process.exit(code);
      },
    );
}
