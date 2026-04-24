// src/commands/env.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp } from "../client/resolve";
import { printList, resolveFormat } from "../ui/output";

interface EnvVarRead {
  key: string;
  updated_at: string;
}

interface EnvVarEntry {
  key: string;
  value: string;
}

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

export function registerEnv(program: Command): void {
  const g = program.command("env").description("application environment variables");

  g.command("ls")
    .description("list env var keys (values are write-only and not returned by the API)")
    .requiredOption("--app <idOrSlug>", "application id or slug")
    .action(async (opts: { app: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const appId = await resolveApp(ctx.client, tid, opts.app);
      const list = await ctx.client.get<EnvVarRead[]>(
        `/tenants/${tid}/applications/${appId}/env/`,
      );
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "key", label: "KEY" },
          { key: "updated_at", label: "UPDATED" },
        ],
        fmt,
      );
    });

  g.command("set")
    .description("set or update env vars (KEY=VAL one or more)")
    .requiredOption("--app <idOrSlug>", "application id or slug")
    .argument("<assignments...>", "KEY=VALUE pairs")
    .action(async (assignments: string[], opts: { app: string }) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const appId = await resolveApp(ctx.client, tid, opts.app);

      const vars: EnvVarEntry[] = [];
      for (const a of assignments) {
        const eq = a.indexOf("=");
        if (eq < 1) {
          process.stderr.write(`Error: expected KEY=VALUE, got '${a}'\n`);
          process.exit(2);
        }
        const key = a.slice(0, eq);
        const value = a.slice(eq + 1);
        vars.push({ key, value });
      }

      await ctx.client.patch<EnvVarRead[]>(
        `/tenants/${tid}/applications/${appId}/env/`,
        { vars },
      );
      for (const v of vars) console.log(`✓ set ${v.key}`);
    });

  g.command("rm")
    .description("remove an env var")
    .requiredOption("--app <idOrSlug>", "application id or slug")
    .argument("<key>", "the env var key to remove")
    .action(async (key: string, opts: { app: string }) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const appId = await resolveApp(ctx.client, tid, opts.app);
      await ctx.client.del(`/tenants/${tid}/applications/${appId}/env/${encodeURIComponent(key)}`);
      console.log(`✓ removed ${key}`);
    });

  // env get is intentionally NOT implemented: the API never returns values.
  g.command("get")
    .description("(unsupported — values are write-only via the API; view in the dashboard)")
    .requiredOption("--app <idOrSlug>", "application id or slug")
    .argument("<key>", "the env var key")
    .action(() => {
      process.stderr.write(
        "Error: env values are write-only via the Reoclo API and cannot be read back.\n",
      );
      process.stderr.write("View the value in the dashboard at https://app.reoclo.com\n");
      process.exit(1);
    });
}
