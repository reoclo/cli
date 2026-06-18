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
  type SecretProjectRead,
} from "../client/secrets";
import { globalOutput, printList, resolveFormat } from "../ui/output";

export function resolveProjectId(projects: SecretProjectRead[], nameOrId: string): string {
  const byId = projects.find((p) => p.id === nameOrId);
  if (byId) return byId.id;
  const byName = projects.filter((p) => p.name === nameOrId);
  if (byName.length === 1 && byName[0]) return byName[0].id;
  throw new Error(`secret project not found: ${nameOrId}`);
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
}
