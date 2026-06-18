// src/commands/secrets.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability } from "../client/command-meta";
import { listProjects, listSecrets, type SecretProjectRead } from "../client/secrets";
import { globalOutput, printList, resolveFormat } from "../ui/output";

export function resolveProjectId(projects: SecretProjectRead[], nameOrId: string): string {
  const byId = projects.find((p) => p.id === nameOrId);
  if (byId) return byId.id;
  const byName = projects.filter((p) => p.name === nameOrId);
  if (byName.length === 1 && byName[0]) return byName[0].id;
  throw new Error(`secret project not found: ${nameOrId}`);
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
  // get/set/rm added in Task 5.
}
