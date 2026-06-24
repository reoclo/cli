// src/commands/secrets.ts
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability } from "../client/command-meta";
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
import { runCommand } from "../secrets/sources/exec";
import {
  runImport,
  importReportJson,
  importReportText,
} from "../secrets/import";
import type { SecretSource } from "../secrets/types";

export function resolveProjectId(projects: SecretProjectRead[], nameOrId: string): string {
  const byId = projects.find((p) => p.id === nameOrId);
  if (byId) return byId.id;
  const byName = projects.filter((p) => p.name === nameOrId);
  if (byName.length === 1 && byName[0]) return byName[0].id;
  throw new Error(`secret project not found: ${nameOrId}`);
}

export interface ImportFlags {
  from: string;
  project: string;
  bwsProject?: string;
  skipExisting?: boolean;
  dryRun?: boolean;
}

/** Dispatch --from to a configured source adapter. Thin by design — adding a
 *  source is a new case here plus its adapter, not a plugin registry. */
export function buildSource(flags: ImportFlags, deps: BitwardenDeps): SecretSource {
  if (flags.from === "bitwarden") {
    return bitwardenSource({ bwsProject: flags.bwsProject }, deps);
  }
  throw new Error(`unknown import source: ${flags.from} (supported: bitwarden)`);
}

export async function readSecretValue(
  opts: { value?: string; fromFile?: string },
  stdin: string | null,
): Promise<string> {
  if (opts.value !== undefined) return opts.value;
  if (opts.fromFile) return (await readFile(opts.fromFile, "utf8")).replace(/\n$/, "");
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
        const tid = requireTenantId(ctx);
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
        const tid = requireTenantId(ctx);
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
      .description("reveal a secret value")
      .requiredOption("--project <name>", "project name or id")
      .action(async (key: string, opts: { project: string }) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
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
      .action(
        async (key: string, opts: { project: string; value?: string; fromFile?: string }) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const pid = resolveProjectId(await listProjects(ctx.client, tid), opts.project);
          const stdin = process.stdin.isTTY ? null : await Bun.stdin.text();
          const value = await readSecretValue(opts, stdin);
          const existing = (await listSecrets(ctx.client, tid, pid)).find((s) => s.key === key);
          if (existing) {
            await patchSecret(ctx.client, tid, existing.id, value);
          } else {
            await setSecret(ctx.client, tid, pid, key, value);
          }
          process.stderr.write(`✓ set ${key}\n`);
        },
      ),
    "secret:write",
  );

  requireCapability(
    g
      .command("rm <key>")
      .description("delete a secret")
      .requiredOption("--project <name>", "project name or id")
      .action(async (key: string, opts: { project: string }) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
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
      .requiredOption("--from <source>", "source to import from (bitwarden)")
      .requiredOption("--project <name>", "target project name or id")
      .option("--bws-project <id|name>", "limit to a Bitwarden Secrets Manager project")
      .option("--skip-existing", "skip keys that already exist instead of failing")
      .option("--dry-run", "print the import plan without writing")
      .action(async (opts: ImportFlags) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
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
}
