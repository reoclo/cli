// src/commands/registry.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { RegistryTypeSchema } from "../client/enums";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";
import { readSecret } from "../util/secret";

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

  g.command("create")
    .description("create a registry credential")
    .requiredOption("--name <name>", "human-readable name")
    .requiredOption("--type <type>", "registry type (docker|ecr|private)")
    .requiredOption("--url <url>", "registry URL")
    .option("--username <u>", "registry username")
    .option("--description <d>", "description")
    .option("--password-stdin", "read password from stdin")
    .action(
      async (opts: {
        name: string;
        type: string;
        url: string;
        username?: string;
        description?: string;
        passwordStdin?: boolean;
      }) => {
        const registryType = RegistryTypeSchema.parse(opts.type);
        const password = await readSecret({
          fromStdin: Boolean(opts.passwordStdin),
          promptLabel: "registry password",
        });
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const body: Record<string, unknown> = {
          name: opts.name,
          registry_type: registryType,
          registry_url: opts.url,
          encrypted_credential: password,
        };
        if (opts.username !== undefined) body["username"] = opts.username;
        if (opts.description !== undefined) body["description"] = opts.description;
        const r = await ctx.client.post<Record<string, unknown> & { id: string }>(
          `/tenants/${tid}/registry-credentials`,
          body,
        );
        printMutation(program, r, `✓ registry created: ${r.id}`);
      },
    );

  g.command("update <id>")
    .description("update a registry credential")
    .option("--name <name>", "new name")
    .option("--url <url>", "new registry URL")
    .option("--username <u>", "new username")
    .option("--description <d>", "new description")
    .option("--password-stdin", "rotate password (read from stdin)")
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          url?: string;
          username?: string;
          description?: string;
          passwordStdin?: boolean;
        },
      ) => {
        const body: Record<string, unknown> = {};
        if (opts.name !== undefined) body["name"] = opts.name;
        if (opts.url !== undefined) body["registry_url"] = opts.url;
        if (opts.username !== undefined) body["username"] = opts.username;
        if (opts.description !== undefined) body["description"] = opts.description;
        if (opts.passwordStdin) {
          body["encrypted_credential"] = await readSecret({
            fromStdin: true,
            promptLabel: "registry password",
          });
        }
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const r = await ctx.client.patch<Record<string, unknown> & { id: string }>(
          `/tenants/${tid}/registry-credentials/${id}`,
          body,
        );
        printMutation(program, r, `✓ registry updated: ${r.id}`);
      },
    );

  g.command("test")
    .description("test a registry connection (ad-hoc)")
    .requiredOption("--type <type>", "registry type (docker|ecr|private)")
    .requiredOption("--url <url>", "registry URL")
    .option("--username <u>", "registry username")
    .option("--password-stdin", "read password from stdin")
    .action(
      async (opts: {
        type: string;
        url: string;
        username?: string;
        passwordStdin?: boolean;
      }) => {
        const registryType = RegistryTypeSchema.parse(opts.type);
        const fmt = resolveFormat(globalOutput(program));
        const password = await readSecret({
          fromStdin: Boolean(opts.passwordStdin),
          promptLabel: "registry password",
        });
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const body: Record<string, unknown> = {
          registry_type: registryType,
          registry_url: opts.url,
          encrypted_credential: password,
        };
        if (opts.username !== undefined) body["username"] = opts.username;
        const r = await ctx.client.post<
          Record<string, unknown> & { success: boolean; message: string; latency_ms: number }
        >(`/tenants/${tid}/registry-credentials/test-connection`, body);
        if (fmt === "json" || fmt === "yaml") {
          printObject(r, fmt);
          process.exit(r.success ? 0 : 1);
        }
        if (r.success) {
          process.stdout.write(`✓ ok (latency: ${r.latency_ms}ms)\n`);
        } else {
          process.stderr.write(`✗ ${r.message}\n`);
          process.exit(1);
        }
      },
    );
}
