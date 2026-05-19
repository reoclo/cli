// src/commands/registry.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";

interface RegistryCredential {
  id: string;
  name: string;
  registry_type: string;
  registry_url: string;
  username: string;
}

export function registerRegistry(program: Command): void {
  const g = program.command("registry").description("manage container registry credentials");

  g.command("ls")
    .description("list registry credentials")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const res = await ctx.client.get<{ items: RegistryCredential[] }>(
        `/tenants/${tid}/registry-credentials`,
      );
      printList(
        res.items as unknown as Array<Record<string, unknown>>,
        [
          { key: "id", label: "ID" },
          { key: "name", label: "NAME" },
          { key: "registry_type", label: "TYPE" },
          { key: "registry_url", label: "URL" },
          { key: "username", label: "USERNAME" },
        ],
        fmt,
      );
    });

  g.command("get <id>")
    .description("show one registry credential")
    .action(async (id: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const r = await ctx.client.get<Record<string, unknown>>(
        `/tenants/${tid}/registry-credentials/${id}`,
      );
      printObject(r, fmt);
    });

  g.command("rm <id>")
    .description("delete a registry credential")
    .option("--yes", "skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await promptYesNo(`delete registry credential ${id}? [y/N]: `);
        if (!ok) {
          process.stderr.write("aborted (pass --yes to confirm non-interactively)\n");
          process.exit(1);
        }
      }
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      await ctx.client.del<void>(`/tenants/${tid}/registry-credentials/${id}`);
      process.stdout.write(`✓ registry removed: ${id}\n`);
    });
}
