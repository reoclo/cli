// src/commands/providers.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { resolveProvider } from "../client/resolve";
import type { GitProvider, SyncStatusResponse } from "../client/types";
import { getActiveProfile } from "../config/store";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import { openBrowser } from "../ui/open-browser";

function deriveDashboardOrigin(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    if (url.hostname.startsWith("api.")) {
      return `${url.protocol}//app.${url.hostname.slice(4)}`;
    }
    return url.origin;
  } catch {
    return "https://app.reoclo.com";
  }
}

function deriveGatewayOrigin(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    if (url.hostname.startsWith("api.")) {
      return `${url.protocol}//gateway.${url.hostname.slice(4)}`;
    }
    return url.origin;
  } catch {
    return "https://gateway.reoclo.com";
  }
}

export function registerProviders(program: Command): void {
  const g = program.command("providers").description("manage git providers (GitHub, Gitea)");

  g.command("ls")
    .description("list git providers")
    .option("--scope <scope>", "filter by scope: tenant|platform|all", "all")
    .action(async (opts: { scope?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const all = await ctx.client.get<GitProvider[]>(`/tenants/${tid}/git-providers`);
      const scope = opts.scope ?? "all";
      const filtered = scope === "all" ? all : all.filter((p) => p.scope === scope);
      cacheList("providers", filtered);
      printList(
        filtered as unknown as Array<Record<string, unknown>>,
        [
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "provider_type", label: "TYPE" },
          { key: "scope", label: "SCOPE" },
          { key: "is_connected", label: "CONNECTED" },
          { key: "sync_status", label: "SYNC" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("get <provider>")
      .description("show one provider (slug, name or id)")
      .action(async (ref: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        const p = await ctx.client.get<GitProvider>(`/tenants/${tid}/git-providers/${id}`);
        printObject(p as unknown as Record<string, unknown>, fmt);
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  g.command("create")
    .description("create a tenant-scoped Gitea provider")
    .requiredOption("--name <name>", "display name")
    .requiredOption("--instance-url <url>", "Gitea instance URL")
    .option("--slug <slug>", "slug (defaults to slugified name)")
    .option("--client-id <id>", "OAuth client id")
    .option("--client-secret <secret>", "OAuth client secret")
    .action(async (opts: {
      name: string;
      instanceUrl: string;
      slug?: string;
      clientId?: string;
      clientSecret?: string;
    }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const slug =
        opts.slug ?? opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const body = {
        provider_type: "gitea",
        scope: "tenant",
        name: opts.name,
        slug,
        instance_url: opts.instanceUrl,
        oauth_client_id: opts.clientId ?? null,
        oauth_client_secret: opts.clientSecret ?? null,
      };
      const created = await ctx.client.post<GitProvider>(
        `/tenants/${tid}/git-providers`,
        body,
      );
      printObject(created as unknown as Record<string, unknown>, fmt);
    });

  withCompletion(
    g
      .command("connect <provider>")
      .description("start OAuth flow (opens browser)")
      .action(async (ref: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const profile = await getActiveProfile();
        const slug = profile?.tenant_slug ?? "";
        if (!slug) {
          const err = new Error(
            "tenant_slug not found in active profile — run 'reoclo login' to refresh your profile",
          ) as Error & { exitCode: number };
          err.exitCode = 3;
          throw err;
        }
        const id = await resolveProvider(ctx.client, tid, ref);
        const dashboardOrigin = deriveDashboardOrigin(ctx.api);
        const resp = await ctx.client.get<{ authorize_url: string; state: string }>(
          `/tenants/${tid}/git-providers/${id}/oauth/authorize-url?redirect_uri=${encodeURIComponent(`${dashboardOrigin}/org/${slug}/repositories/settings`)}`,
        );
        console.log(`Open this URL to authorize (also opened in browser):\n${resp.authorize_url}`);
        openBrowser(resp.authorize_url);
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  withCompletion(
    g.command("test <provider>")
      .description("test connection / refresh-token health")
      .action(async (ref: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        const res = await ctx.client.post<{ ok: boolean; error?: string; message?: string }>(
          `/tenants/${tid}/git-providers/${id}/test-connection`,
          {},
        );
        if (res.ok) {
          console.log(res.message ?? "Connection healthy");
        } else {
          console.error(`FAILED: ${res.error ?? "unknown"}`);
          process.exit(1);
        }
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  withCompletion(
    g.command("sync <provider>")
      .description("queue a repository sync")
      .option("--wait", "block until sync completes")
      .action(async (ref: string, opts: { wait?: boolean }) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        const start = await ctx.client.post<{ status: string }>(
          `/tenants/${tid}/git-providers/${id}/sync`,
          {},
        );
        if (start.status === "already_syncing") {
          console.log("A sync is already in progress.");
        } else {
          console.log("Sync queued.");
        }
        if (opts.wait) {
          while (true) {
            await new Promise((r) => setTimeout(r, 2000));
            const s = await ctx.client.get<SyncStatusResponse>(
              `/tenants/${tid}/git-providers/${id}/sync-status`,
            );
            process.stderr.write(`\r${s.status} ${s.completed_repos}/${s.total_repos}    `);
            if (s.status === "completed") {
              process.stderr.write("\n");
              break;
            }
            if (s.status === "failed") {
              process.stderr.write("\n");
              console.error(`Sync failed: ${s.error}`);
              process.exit(1);
            }
          }
        }
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  withCompletion(
    g.command("status <provider>")
      .description("show sync status")
      .action(async (ref: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        const s = await ctx.client.get<SyncStatusResponse>(
          `/tenants/${tid}/git-providers/${id}/sync-status`,
        );
        printObject(s as unknown as Record<string, unknown>, fmt);
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  withCompletion(
    g.command("orgs <provider>")
      .description("list orgs available to the connected OAuth user")
      .action(async (ref: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        const orgs = await ctx.client.get<Array<{ name: string; description: string }>>(
          `/tenants/${tid}/git-providers/${id}/organizations`,
        );
        printList(
          orgs as unknown as Array<Record<string, unknown>>,
          [{ key: "name", label: "NAME" }, { key: "description", label: "DESCRIPTION" }],
          fmt,
        );
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  withCompletion(
    g.command("webhook-url <provider>")
      .description("print the webhook URL")
      .action(async (ref: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        const provider = await ctx.client.get<GitProvider>(`/tenants/${tid}/git-providers/${id}`);
        if (provider.provider_type === "github") {
          const err = new Error(
            "GitHub providers use the App-level webhook (`/webhooks/github`). Per-provider webhook URLs only apply to Gitea providers.",
          ) as Error & { exitCode: number };
          err.exitCode = 4;
          throw err;
        }
        const gateway = deriveGatewayOrigin(ctx.api);
        console.log(`${gateway}/webhooks/gitea/${id}`);
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  withCompletion(
    g.command("update <provider>")
      .description("update provider settings")
      .option("--name <name>")
      .option("--instance-url <url>")
      .option("--api-url <url>")
      .option("--allowed-orgs <orgs>", "comma-separated orgs, or '' to clear")
      .option("--client-id <id>")
      .option("--client-secret <secret>")
      .action(async (ref: string, opts: {
        name?: string;
        instanceUrl?: string;
        apiUrl?: string;
        allowedOrgs?: string;
        clientId?: string;
        clientSecret?: string;
      }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        const body: Record<string, unknown> = {};
        if (opts.name !== undefined) body["name"] = opts.name;
        if (opts.instanceUrl !== undefined) body["instance_url"] = opts.instanceUrl;
        if (opts.apiUrl !== undefined) body["api_url"] = opts.apiUrl || null;
        if (opts.clientId !== undefined) body["oauth_client_id"] = opts.clientId || null;
        if (opts.clientSecret !== undefined) body["oauth_client_secret"] = opts.clientSecret;
        if (opts.allowedOrgs !== undefined) {
          const list = opts.allowedOrgs.split(",").map((s: string) => s.trim()).filter(Boolean);
          body["allowed_organizations"] = list.length > 0 ? list : null;
        }
        const updated = await ctx.client.patch<GitProvider>(
          `/tenants/${tid}/git-providers/${id}`,
          body,
        );
        printObject(updated as unknown as Record<string, unknown>, fmt);
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );

  withCompletion(
    g.command("rm <provider>")
      .description("delete a tenant-scoped provider")
      .action(async (ref: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveProvider(ctx.client, tid, ref);
        await ctx.client.del(`/tenants/${tid}/git-providers/${id}`);
        console.log("Provider deleted.");
      }),
    { args: [{ slot: 0, resource: "providers" }] },
  );
}
