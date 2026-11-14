// src/commands/env.ts
import type { Command } from "commander";
import { appUrl } from "../lib/urls";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { confirmOrExit } from "../ui/prompt";
import { resolveApp } from "../client/resolve";
import { globalOutput, printList, resolveFormat } from "../ui/output";
import { requireCapability, withCompletion } from "../client/command-meta";
import { cacheEnvKeys } from "../completion/populate";
import { EXIT } from "../client/exit-codes";
import { listProjects } from "../client/secrets";
import { resolveProjectId } from "./secrets";

export interface EnvVarRead {
  key: string;
  build_public?: boolean;
  build_secret?: boolean;
  source?: "literal" | "reference";
  secret_ref?: { project_id: string; secret_key: string } | null;
  project_name?: string | null;
  resolvable?: boolean;
  updated_at: string;
}

export interface EnvVarEntry {
  key: string;
  value?: string;
  source?: "reference";
  secret_ref?: { project_id: string; secret_key: string };
  build_public?: boolean;
  build_secret?: boolean;
}

/** `--public-build` / `--build-secret` and their `--no-` forms. Undefined means the
 *  flag was not given, and the API keeps the variable's current setting. */
export interface BuildOptionFlags {
  publicBuild?: boolean;
  buildSecret?: boolean;
}

function misuse(message: string): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = EXIT.MISUSE;
  return e;
}

export function buildOptionFields(
  flags: BuildOptionFlags,
): Pick<EnvVarEntry, "build_public" | "build_secret"> {
  if (flags.publicBuild === true && flags.buildSecret === true) {
    throw misuse("a variable cannot be both a public build value and a build secret");
  }
  return {
    ...(flags.publicBuild !== undefined ? { build_public: flags.publicBuild } : {}),
    ...(flags.buildSecret !== undefined ? { build_secret: flags.buildSecret } : {}),
  };
}

/** Turn `env set` arguments into entries. With a secret project id each argument is
 *  KEY or KEY=SECRET_KEY (the project's key, defaulting to KEY); otherwise KEY=VALUE. */
export function parseAssignments(
  assignments: string[],
  flags: BuildOptionFlags,
  projectId?: string,
): EnvVarEntry[] {
  const options = buildOptionFields(flags);
  return assignments.map((a) => {
    const eq = a.indexOf("=");
    if (projectId !== undefined) {
      const key = eq === -1 ? a : a.slice(0, eq);
      const secretKey = eq === -1 ? a : a.slice(eq + 1);
      if (!key || !secretKey) throw misuse(`expected KEY or KEY=SECRET_KEY, got '${a}'`);
      return {
        key,
        source: "reference",
        secret_ref: { project_id: projectId, secret_key: secretKey },
        ...options,
      };
    }
    if (eq < 1) throw misuse(`expected KEY=VALUE, got '${a}'`);
    return { key: a.slice(0, eq), value: a.slice(eq + 1), ...options };
  });
}

export function buildOptionLabel(row: EnvVarRead): string {
  if (row.build_public) return "public";
  if (row.build_secret) return "secret";
  return "-";
}

export function sourceLabel(row: EnvVarRead): string {
  if (row.source !== "reference" || !row.secret_ref) return "value";
  const from = `${row.project_name ?? row.secret_ref.project_id}/${row.secret_ref.secret_key}`;
  return row.resolvable === false ? `${from} (unresolvable)` : from;
}

export function setSummary(entry: EnvVarEntry, projectName?: string): string {
  const ref = entry.secret_ref;
  const notes = [
    ref ? `from ${projectName ?? ref.project_id}/${ref.secret_key}` : "",
    entry.build_public === true ? "public build value" : "",
    entry.build_secret === true ? "build secret" : "",
    entry.build_public === false ? "not a public build value" : "",
    entry.build_secret === false ? "not a build secret" : "",
  ].filter((note) => note !== "");
  return notes.length > 0 ? `✓ set ${entry.key} (${notes.join(", ")})` : `✓ set ${entry.key}`;
}

export function registerEnv(program: Command): void {
  const g = program.command("env").description("application environment variables");

  withCompletion(
    g
      .command("ls")
      .description(
        "list env var keys with their source and build option (values are write-only and not returned by the API)",
      )
      .requiredOption("--app <idOrSlug>", "application id or slug")
      .action(async (opts: { app: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const appId = await resolveApp(ctx.client, tid, opts.app);
        const list = await ctx.client.get<EnvVarRead[]>(
          `/tenants/${tid}/applications/${appId}/env/`,
        );
        cacheEnvKeys(appId, list.map((e) => e.key));
        const rows =
          fmt === "text"
            ? list.map((e) => ({ ...e, source: sourceLabel(e), build: buildOptionLabel(e) }))
            : list;
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "key", label: "KEY" },
            { key: "source", label: "SOURCE" },
            { key: "build", label: "BUILD" },
            { key: "updated_at", label: "UPDATED" },
          ],
          fmt,
        );
      }),
    { flags: { "--app": "apps" } },
  );

  const setCmd = withCompletion(g.command("set"), { flags: { "--app": "apps" } });
  requireCapability(setCmd, "app:env:write");
  setCmd
    .description(
      "set or update env vars (KEY=VAL one or more). A build option you leave out keeps its current setting",
    )
    .requiredOption("--app <idOrSlug>", "application id or slug")
    .option("--public-build", "mark as a public build value: pool build args may read it, and it may ship in the image")
    .option("--no-public-build", "stop treating it as a public build value")
    .option("--build-secret", "mark as a build secret: builds read it, the running container never gets it")
    .option("--no-build-secret", "stop treating it as a build secret")
    .option(
      "--ref <project>",
      "read the values from a secret project (name or id) instead of storing them; arguments are KEY or KEY=SECRET_KEY",
    )
    .argument("<assignments...>", "KEY=VALUE pairs, or KEY / KEY=SECRET_KEY with --ref")
    .action(
      async (
        assignments: string[],
        opts: { app: string; publicBuild?: boolean; buildSecret?: boolean; ref?: string },
      ) => {
        const flags = { publicBuild: opts.publicBuild, buildSecret: opts.buildSecret };
        buildOptionFields(flags);
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const appId = await resolveApp(ctx.client, tid, opts.app);
        let projectId: string | undefined;
        let projectName: string | undefined;
        if (opts.ref !== undefined) {
          const projects = await listProjects(ctx.client, tid);
          projectId = resolveProjectId(projects, opts.ref);
          projectName = projects.find((p) => p.id === projectId)?.name;
        }
        const vars = parseAssignments(assignments, flags, projectId);

        await ctx.client.patch<EnvVarRead[]>(`/tenants/${tid}/applications/${appId}/env/`, {
          vars,
        });
        for (const v of vars) console.log(setSummary(v, projectName));
        console.log("Applies on the next deploy.");
      },
    );

  withCompletion(
    g
      .command("rm")
      .description("remove an env var")
      .requiredOption("--app <idOrSlug>", "application id or slug")
      .argument("<key>", "the env var key to remove")
      .option("--yes", "skip confirmation prompt")
      .action(async (key: string, opts: { app: string; yes?: boolean }) => {
        await confirmOrExit(`remove env var ${key} from ${opts.app}? [y/N]: `, opts.yes);
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const appId = await resolveApp(ctx.client, tid, opts.app);
        await ctx.client.del(
          `/tenants/${tid}/applications/${appId}/env/${encodeURIComponent(key)}`,
        );
        console.log(`✓ removed ${key}`);
      }),
    { args: [{ slot: 0, resource: "envKeys" }], flags: { "--app": "apps" } },
  );

  // env get is intentionally NOT implemented: the API never returns values.
  withCompletion(
    g
      .command("get")
      .description("(unsupported: values are write-only via the API, view them in the dashboard)")
      .requiredOption("--app <idOrSlug>", "application id or slug")
      .argument("<key>", "the env var key")
      .action(() => {
        process.stderr.write(
          "Error: env values are write-only via the Reoclo API and cannot be read back.\n",
        );
        process.stderr.write(`View the value in the dashboard at ${appUrl()}\n`);
        process.exit(1);
      }),
    { args: [{ slot: 0, resource: "envKeys" }], flags: { "--app": "apps" } },
  );
}
