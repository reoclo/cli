// src/commands/secrets.ts
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp } from "../client/resolve";
import { requireCapability } from "../client/command-meta";
import { EXIT } from "../client/exit-codes";
import type { KeyType } from "../client/routing";
import {
  listProjects,
  listSecrets,
  setSecret,
  patchSecret,
  revealSecret,
  deleteSecret,
  bulkCreateSecrets,
  type SecretProjectRead,
} from "../client/secrets";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import { bitwardenSource, type BitwardenDeps } from "../secrets/sources/bitwarden";
import { onepasswordSource } from "../secrets/sources/onepassword";
import { runCommand } from "../secrets/sources/exec";
import { runImport, importReportJson, importReportText } from "../secrets/import";
import type { SecretSource } from "../secrets/types";
import {
  assertInputExists,
  collectRefs,
  parseTemplate,
  renderInject,
  type ResolvedSecrets,
} from "../secrets/template";
import { machineResolver, humanResolver } from "../secrets/resolvers";
import { collectCiMeta } from "./run";

/** Only an interactive OAuth session takes the per-secret reveal path. */
export function usesMachineLane(tokenType: KeyType): boolean {
  return tokenType !== "tenant";
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface KeySelection {
  key: string;
  env_name: string | null;
}

/** Parse repeatable `--key KEY[=NEW_NAME]` specs (REO-349). Empty input
 *  selects every key in the project. */
export function parseKeySpecs(specs: string[]): KeySelection[] {
  const out: KeySelection[] = [];
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    const key = (eq === -1 ? spec : spec.slice(0, eq)).trim();
    const envName = eq === -1 ? null : spec.slice(eq + 1).trim();
    if (!key) throw new Error(`--key needs a secret key, got '${spec}'`);
    if (envName !== null && !ENV_NAME_RE.test(envName)) {
      throw new Error(`rename '${envName}' must match ^[A-Z_][A-Z0-9_]*$`);
    }
    out.push({ key, env_name: envName === "" ? null : envName });
  }
  return out;
}

/** Merge --add-key/--remove-key edits into a binding's key selection
 *  (REO-377). An empty selection means "every key in the project", so edits
 *  that would silently narrow or widen that meaning are refused. */
export function mergeBindingKeys(
  existing: KeySelection[],
  add: KeySelection[],
  removeKeys: string[],
): KeySelection[] {
  if (existing.length === 0) {
    if (add.length > 0) {
      throw new Error("binding already injects every key in the project; --add-key is not needed");
    }
    throw new Error(
      "binding injects every key in the project; re-bind with --key to pin an explicit list first",
    );
  }
  for (const key of removeKeys) {
    if (!existing.some((k) => k.key === key)) {
      throw new Error(`key '${key}' is not selected on this binding`);
    }
  }
  const out = existing.map((k) => ({ ...k }));
  for (const sel of add) {
    const current = out.find((k) => k.key === sel.key);
    if (!current) {
      out.push(sel);
    } else if (sel.env_name !== null) {
      // A bare --add-key on a selected key is an "ensure present" and must
      // not clear an existing rename; only an explicit =NEW_NAME updates it.
      current.env_name = sel.env_name;
    }
  }
  const remaining = out.filter((k) => !removeKeys.includes(k.key));
  if (remaining.length === 0) {
    throw new Error(
      "removing every key would switch the binding to inject all keys; unbind instead",
    );
  }
  return remaining;
}

export function resolveProjectId(projects: SecretProjectRead[], nameOrId: string): string {
  const byId = projects.find((p) => p.id === nameOrId);
  if (byId) return byId.id;
  const byName = projects.filter((p) => p.name === nameOrId);
  if (byName.length === 1 && byName[0]) return byName[0].id;
  throw new Error(`secret project not found: ${nameOrId}`);
}

/** Guard for `secrets inject -o`: refuse to clobber an existing file unless
 *  --force was passed. */
export function assertOutputWritable(exists: boolean, force: boolean, path: string): void {
  if (exists && !force) {
    const err = new Error(`refusing to overwrite ${path}; pass --force`) as Error & {
      exitCode: number;
    };
    err.exitCode = EXIT.MISUSE;
    throw err;
  }
}

export interface ImportFlags {
  from: string;
  project: string;
  bwsProject?: string;
  opVault?: string;
  skipExisting?: boolean;
  dryRun?: boolean;
}

/** Dispatch --from to a configured source adapter. Thin by design — adding a
 *  source is a new case here plus its adapter, not a plugin registry. */
export function buildSource(flags: ImportFlags, deps: BitwardenDeps): SecretSource {
  if (flags.from === "bitwarden") {
    return bitwardenSource({ bwsProject: flags.bwsProject }, deps);
  }
  if (flags.from === "onepassword") {
    return onepasswordSource({ opVault: flags.opVault }, deps);
  }
  throw new Error(`unknown import source: ${flags.from} (supported: bitwarden, onepassword)`);
}

export async function readSecretValue(
  opts: { value?: string; fromFile?: string },
  readStdin: () => Promise<string | null>,
): Promise<string> {
  if (opts.value !== undefined) return opts.value;
  if (opts.fromFile) return (await readFile(opts.fromFile, "utf8")).replace(/\n$/, "");
  // Read stdin lazily, and only as the last resort. Draining it before the
  // --from-file branch exhausts the pipe, so `--from-file /dev/stdin` would
  // then read empty and the API rejects it as string_too_short (REO-97 §4a).
  const stdin = await readStdin();
  if (stdin !== null) return stdin.replace(/\n$/, "");
  const msg = "no secret value: pass --value, --from-file, or pipe via stdin";
  throw new Error(msg);
}

export function registerSecrets(program: Command): void {
  const g = program.command("secrets").description("manage secrets");

  const projectsGroup = g.command("projects").description("secret projects");
  requireCapability(
    projectsGroup
      .command("ls")
      .description("list secret projects")
      .action(async () => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const rows = await listProjects(ctx.client, tid);
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "name", label: "NAME" },
          ],
          fmt,
        );
      }),
    "secret_project:read",
  );

  requireCapability(
    g
      .command("ls")
      .description("list secret keys in a project")
      .requiredOption("--project <name>", "project name or id")
      .action(async (opts: { project: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const pid = resolveProjectId(await listProjects(ctx.client, tid), opts.project);
        const rows = await listSecrets(ctx.client, tid, pid);
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "key", label: "KEY" },
            { key: "current_version", label: "VERSION" },
          ],
          fmt,
        );
      }),
    "secret_project:read",
  );

  requireCapability(
    g
      .command("get <key>")
      .description("reveal a secret value (prints the raw value, not JSON; ignores -o)")
      .requiredOption("--project <name>", "project name or id")
      .action(async (key: string, opts: { project: string }) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const pid = resolveProjectId(await listProjects(ctx.client, tid), opts.project);
        const secret = (await listSecrets(ctx.client, tid, pid)).find((s) => s.key === key);
        if (!secret) {
          const m = `secret not found: ${key}`;
          throw new Error(m);
        }
        const revealed = await revealSecret(ctx.client, tid, secret.id);
        process.stdout.write(revealed.value + "\n"); // value only — pipeable
      }),
    "secret:reveal",
  );

  requireCapability(
    g
      .command("set <key>")
      .description("create or update a secret")
      .requiredOption("--project <name>", "project name or id")
      .option("--value <value>", "secret value (else --from-file or stdin)")
      .option("--from-file <path>", "read value from a file")
      .action(async (key: string, opts: { project: string; value?: string; fromFile?: string }) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const pid = resolveProjectId(await listProjects(ctx.client, tid), opts.project);
        // Pass stdin as a lazy reader so it is consumed only when neither
        // --value nor --from-file was given; otherwise `--from-file /dev/stdin`
        // reads an already-exhausted pipe (REO-97 §4a).
        const value = await readSecretValue(opts, () =>
          process.stdin.isTTY ? Promise.resolve(null) : Bun.stdin.text(),
        );
        const existing = (await listSecrets(ctx.client, tid, pid)).find((s) => s.key === key);
        if (existing) {
          await patchSecret(ctx.client, tid, existing.id, value);
        } else {
          await setSecret(ctx.client, tid, pid, key, value);
        }
        process.stderr.write(`✓ set ${key}\n`);
      }),
    "secret:write",
  );

  requireCapability(
    g
      .command("rm <key>")
      .description("delete a secret")
      .requiredOption("--project <name>", "project name or id")
      .action(async (key: string, opts: { project: string }) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const pid = resolveProjectId(await listProjects(ctx.client, tid), opts.project);
        const secret = (await listSecrets(ctx.client, tid, pid)).find((s) => s.key === key);
        if (!secret) {
          const m = `secret not found: ${key}`;
          throw new Error(m);
        }
        await deleteSecret(ctx.client, tid, secret.id);
        process.stderr.write(`✓ deleted ${key}\n`);
      }),
    "secret:write",
  );

  requireCapability(
    g
      .command("import")
      .description("import secrets from an external source into a project")
      .requiredOption("--from <source>", "source to import from (bitwarden, onepassword)")
      .requiredOption("--project <name>", "target project name or id")
      .option("--bws-project <id|name>", "limit to a Bitwarden Secrets Manager project")
      .option("--op-vault <id|name>", "limit to a 1Password vault")
      .option("--skip-existing", "skip keys that already exist instead of failing")
      .option("--dry-run", "print the import plan without writing")
      .action(async (opts: ImportFlags) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const source = buildSource(opts, { run: runCommand, env: process.env });
        const pid = resolveProjectId(await listProjects(ctx.client, tid), opts.project);

        const report = await runImport(
          {
            source,
            projectLabel: opts.project,
            listExistingKeys: async () =>
              (await listSecrets(ctx.client, tid, pid)).map((s) => s.key),
            bulkCreate: async (secrets) => {
              await bulkCreateSecrets(ctx.client, tid, pid, secrets);
            },
          },
          { skipExisting: opts.skipExisting ?? false, dryRun: opts.dryRun ?? false },
        );

        const fmt = resolveFormat(globalOutput(program));
        if (fmt === "json" || fmt === "yaml") {
          printObject(importReportJson(report), fmt);
        } else {
          process.stdout.write(importReportText(report) + "\n");
        }
      }),
    "secret:write",
  );

  requireCapability(
    g
      .command("inject")
      .description("render an op:// template, resolving each ref from Reoclo (op inject drop-in)")
      .requiredOption("-i, --input <path>", "template file containing op:// references")
      .option("-o, --output <path>", "write the result to a file (default: stdout)")
      .option("-f, --force", "overwrite an existing --output file")
      .addHelpText(
        "after",
        `
Examples:
  reoclo secrets inject -i .env.tpl -o .env
  reoclo secrets inject -i .env.tpl >> /opt/reoclo/.env
  REOCLO_MACHINE_TOKEN=rk_m_... reoclo secrets inject -i .env.tpl -o .env`,
      )
      .action(async (opts: { input: string; output?: string; force?: boolean }) => {
        // All cheap, IO-only validation happens up front, before bootstrap()
        // or any network resolution: a user who forgot --force (or mistyped
        // --input) should never spend reveals + an audit entry finding out.
        assertInputExists(await Bun.file(opts.input).exists(), opts.input);
        const lines = parseTemplate(await Bun.file(opts.input).text());
        const { refs } = collectRefs(lines);

        if (opts.output) {
          assertOutputWritable(
            await Bun.file(opts.output).exists(),
            opts.force ?? false,
            opts.output,
          );
        }

        const ctx = await bootstrap();
        let resolved: ResolvedSecrets = new Map();
        if (refs.length > 0) {
          // A machine credential (automation key or machine user token) takes
          // the session-backed machine path; only an interactive tenant/OAuth
          // session falls back to the per-secret reveal path.
          const resolver = usesMachineLane(ctx.tokenType)
            ? machineResolver(ctx.client, collectCiMeta(process.env, undefined))
            : humanResolver(ctx.client, await requireTenantId(ctx));
          resolved = await resolver(refs);
        }

        const rendered = renderInject(lines, resolved);
        if (opts.output) {
          await Bun.write(opts.output, rendered);
          process.stderr.write(`✓ wrote ${opts.output}\n`);
        } else {
          process.stdout.write(rendered);
        }
      }),
    "secret:reveal",
  );

  interface BindingTarget {
    base: string;
    label: string;
  }

  async function bindingTarget(
    ctx: Awaited<ReturnType<typeof bootstrap>>,
    tid: string,
    opts: { app?: string; group?: string },
  ): Promise<BindingTarget> {
    if (opts.app && opts.group) {
      const e = new Error("pass --app or --group, not both") as Error & { exitCode: number };
      e.exitCode = EXIT.MISUSE;
      throw e;
    }
    if (opts.app) {
      const appId = await resolveApp(ctx.client, tid, opts.app);
      return {
        base: `/tenants/${tid}/applications/${appId}/secret-bindings`,
        label: opts.app,
      };
    }
    if (opts.group) {
      const groups = await ctx.client.get<Array<{ id: string; slug: string }>>(
        `/tenants/${tid}/application-groups/`,
      );
      const group = groups.find((g) => g.id === opts.group || g.slug === opts.group);
      if (!group) {
        const e = new Error(`group '${opts.group}' not found`) as Error & { exitCode: number };
        e.exitCode = 5;
        throw e;
      }
      return {
        base: `/tenants/${tid}/application-groups/${group.id}/secret-bindings`,
        label: group.slug,
      };
    }
    const e = new Error("pass --app <app> or --group <stack>") as Error & { exitCode: number };
    e.exitCode = EXIT.MISUSE;
    throw e;
  }

  interface BindingRead {
    binding_id: string;
    project_id: string;
    project_name?: string | null;
    prefix?: string | null;
    scope: string;
    keys?: KeySelection[];
    [k: string]: unknown;
  }

  const collect = (value: string, prev: string[]): string[] => [...prev, value];

  const bindCmd = g
    .command("bind <project>")
    .description("link a secret project to an app or stack (REO-349)")
    .option("--app <idOrSlug>", "bind to this application")
    .option("--group <idOrSlug>", "bind to this stack (every member receives it)")
    .option("--prefix <PREFIX_>", "env name prefix for injected keys")
    .option("--scope <scope>", "production | preview | both (default production)")
    .option(
      "--key <KEY[=NEW_NAME]>",
      "select a key (repeatable); omit to inject every key in the project",
      collect,
      [] as string[],
    )
    .option(
      "--add-key <KEY[=NEW_NAME]>",
      "add or rename a key on the existing binding (repeatable, REO-377)",
      collect,
      [] as string[],
    )
    .option(
      "--remove-key <KEY>",
      "remove a key from the existing binding (repeatable)",
      collect,
      [] as string[],
    )
    .action(
      async (
        projectRef: string,
        opts: {
          app?: string;
          group?: string;
          prefix?: string;
          scope?: string;
          key: string[];
          addKey: string[];
          removeKey: string[];
        },
      ) => {
        const fmt = resolveFormat(globalOutput(program));
        const editing = opts.addKey.length > 0 || opts.removeKey.length > 0;
        if (editing && opts.key.length > 0) {
          const e = new Error(
            "--key replaces the whole selection; use --add-key/--remove-key alone to edit it incrementally",
          ) as Error & { exitCode: number };
          e.exitCode = EXIT.MISUSE;
          throw e;
        }
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const target = await bindingTarget(ctx, tid, opts);
        const pid = resolveProjectId(await listProjects(ctx.client, tid), projectRef);

        const finish = (binding: BindingRead): void => {
          printObject(binding, fmt);
          if (fmt === "text") console.log("Applies on the next deploy.");
        };
        const create = async (keys: KeySelection[]): Promise<void> => {
          finish(
            await ctx.client.post<BindingRead>(`${target.base}/`, {
              project_id: pid,
              prefix: opts.prefix ?? null,
              scope: opts.scope ?? "production",
              keys,
            }),
          );
        };
        // Absent --prefix/--scope leave the stored values alone on an edit.
        const patchExtras: Record<string, unknown> = {};
        if (opts.prefix !== undefined) patchExtras.prefix = opts.prefix;
        if (opts.scope !== undefined) patchExtras.scope = opts.scope;

        const existing = (await ctx.client.get<BindingRead[]>(`${target.base}/`)).find(
          (b) => b.project_id === pid,
        );

        if (editing) {
          // Edit the existing binding in place — unbind+rebind briefly leaves
          // the target with no binding at all (REO-377).
          const addKeys = parseKeySpecs(opts.addKey);
          if (!existing) {
            if (opts.removeKey.length > 0) {
              const e = new Error(
                `project is not bound to ${target.label}; nothing to remove keys from`,
              ) as Error & { exitCode: number };
              e.exitCode = 5;
              throw e;
            }
            // No binding yet: --add-key degrades to a create with exactly
            // those keys, so scripts do not need a create/edit branch.
            await create(addKeys);
            return;
          }
          const keys = mergeBindingKeys(existing.keys ?? [], addKeys, opts.removeKey);
          finish(
            await ctx.client.patch<BindingRead>(`${target.base}/${existing.binding_id}`, {
              keys,
              ...patchExtras,
            }),
          );
          return;
        }
        if (existing && opts.key.length > 0) {
          // Re-binding with --key replaces the selection in place. This is
          // also the way off an all-keys binding, which has no selection for
          // --add-key/--remove-key to edit.
          finish(
            await ctx.client.patch<BindingRead>(`${target.base}/${existing.binding_id}`, {
              keys: parseKeySpecs(opts.key),
              ...patchExtras,
            }),
          );
          return;
        }
        await create(parseKeySpecs(opts.key));
      },
    );
  requireCapability(bindCmd, "app:env:write");

  g.command("bindings")
    .description("list secret-project bindings for an app or stack")
    .option("--app <idOrSlug>", "application")
    .option("--group <idOrSlug>", "stack")
    .action(async (opts: { app?: string; group?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const target = await bindingTarget(ctx, tid, opts);
      const rows = await ctx.client.get<BindingRead[]>(`${target.base}/`);
      printList(
        rows.map((b) => ({
          binding: b.binding_id.slice(0, 8),
          project: b.project_name ?? b.project_id,
          prefix: b.prefix ?? "",
          scope: b.scope,
          keys:
            (b.keys?.length ?? 0) > 0
              ? (b.keys ?? []).map((k) => (k.env_name ? `${k.key}=${k.env_name}` : k.key)).join(",")
              : "all",
        })),
        [
          { key: "binding", label: "BINDING" },
          { key: "project", label: "PROJECT" },
          { key: "prefix", label: "PREFIX" },
          { key: "scope", label: "SCOPE" },
          { key: "keys", label: "KEYS" },
        ],
        fmt,
      );
    });

  const unbindCmd = g
    .command("unbind <bindingId>")
    .description("remove a secret-project binding from an app or stack")
    .option("--app <idOrSlug>", "application")
    .option("--group <idOrSlug>", "stack")
    .action(async (bindingId: string, opts: { app?: string; group?: string }) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const target = await bindingTarget(ctx, tid, opts);
      const rows = await ctx.client.get<BindingRead[]>(`${target.base}/`);
      const match = rows.find(
        (b) => b.binding_id === bindingId || b.binding_id.startsWith(bindingId),
      );
      if (!match) {
        const e = new Error(`binding '${bindingId}' not found on ${target.label}`) as Error & {
          exitCode: number;
        };
        e.exitCode = 5;
        throw e;
      }
      await ctx.client.del(`${target.base}/${match.binding_id}`);
      console.log(`✓ unbound ${match.project_name ?? match.project_id}`);
    });
  requireCapability(unbindCmd, "app:env:write");
}
