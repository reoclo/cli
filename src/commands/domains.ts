// src/commands/domains.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";
import type { Domain } from "../client/types";
import type { HttpClient } from "../client/http";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";

interface VerifyResponse {
  txt_name: string;
  txt_value: string;
  expires_at: string;
}

async function resolveDomain(
  client: HttpClient,
  tid: string,
  fqdnOrId: string,
): Promise<{ id: string; fqdn: string }> {
  const list = await client.get<Domain[]>(`/tenants/${tid}/domains/`);
  const found =
    list.find((d) => d.fqdn === fqdnOrId) ?? list.find((d) => d.id === fqdnOrId);
  if (!found) {
    const e = new Error(`domain '${fqdnOrId}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return { id: found.id, fqdn: found.fqdn };
}

export function registerDomains(program: Command): void {
  const g = program.command("domains").description("manage domains");

  g.command("ls")
    .description("list domains in the organization")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<Domain[]>(`/tenants/${tid}/domains/`);
      cacheList("domains", list);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "fqdn", label: "DOMAIN" },
          { key: "status", label: "STATUS" },
          { key: "application_id", label: "APP" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("get <fqdnOrId>")
      .description("show details for one domain")
      .action(async (fqdnOrId: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const list = await ctx.client.get<Domain[]>(`/tenants/${tid}/domains/`);
        const d =
          list.find((x) => x.fqdn === fqdnOrId) ?? list.find((x) => x.id === fqdnOrId);
        if (!d) {
          const e = new Error(`domain '${fqdnOrId}' not found`) as Error & {
            exitCode: number;
          };
          e.exitCode = 5;
          throw e;
        }
        printObject(d as unknown as Record<string, unknown>, fmt);
      }),
    { args: [{ slot: 0, resource: "domains" }] },
  );

  g.command("add <fqdn>")
    .description("register a new domain")
    .action(async (fqdn: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const d = await ctx.client.post<Domain>(`/tenants/${tid}/domains/`, { fqdn });
      console.log(`✓ added ${d.fqdn} (id: ${d.id}, status: ${d.status})`);
      console.log(
        "Run 'reoclo domains verify <fqdn>' to fetch the TXT record needed for verification.",
      );
      // For -o json, also dump the full record
      if (fmt === "json") printObject(d as unknown as Record<string, unknown>, fmt);
    });

  withCompletion(
    g
      .command("verify <fqdnOrId>")
      .description("fetch the TXT record needed to verify a domain")
      .action(async (fqdnOrId: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const { id } = await resolveDomain(ctx.client, tid, fqdnOrId);
        const r = await ctx.client.post<VerifyResponse>(`/tenants/${tid}/domains/${id}/verify`);
        console.log("Add this DNS TXT record to verify the domain:");
        console.log(`  Name:    ${r.txt_name}`);
        console.log(`  Value:   ${r.txt_value}`);
        console.log(`  Expires: ${r.expires_at}`);
        console.log("\nThe verification job runs every few minutes; once the TXT is observed,");
        console.log("the domain status will update from 'pending' to 'verified'.");
      }),
    { args: [{ slot: 0, resource: "domains" }] },
  );

  withCompletion(
    g
      .command("dns <fqdnOrId>")
      .description("show DNS records and verification status")
      .action(async (fqdnOrId: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const { id } = await resolveDomain(ctx.client, tid, fqdnOrId);

        // The DNS endpoint is tenant-wide (`/dns/overview`) and groups
        // domains by server. We fetch the whole overview and pick the one
        // matching the resolved id — server-side there's no per-domain
        // GET, but the overview already contains per-domain records.
        interface OverviewRecord {
          record_type: string;
          name: string;
          value: string;
          observed_values?: string[];
          status: string;
        }
        interface OverviewDomain {
          domain_id: string;
          fqdn: string;
          records: OverviewRecord[];
          dns_status: string;
        }
        interface OverviewServerGroup {
          domains: OverviewDomain[];
        }
        interface OverviewResponse {
          servers: OverviewServerGroup[];
          unbound_domains: OverviewDomain[];
        }
        const overview = await ctx.client.get<OverviewResponse>(
          `/tenants/${tid}/dns/overview`,
        );
        const all: OverviewDomain[] = [
          ...overview.servers.flatMap((s) => s.domains),
          ...overview.unbound_domains,
        ];
        const r = all.find((d) => d.domain_id === id);
        if (!r) {
          const e = new Error(`domain '${fqdnOrId}' has no DNS overview entry`) as Error & {
            exitCode: number;
          };
          e.exitCode = 5;
          throw e;
        }

        if (fmt === "json" || fmt === "yaml") {
          printObject(r as unknown as Record<string, unknown>, fmt);
          return;
        }

        // Flatten observed_values (string[]) into a comma-joined string so the
        // text table reads cleanly. JSON / YAML output above keeps the array.
        const rows = (r.records ?? []).map((rec) => ({
          type: rec.record_type,
          name: rec.name,
          expected: rec.value,
          observed: (rec.observed_values ?? []).join(", "),
          status: rec.status,
        }));
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "type", label: "TYPE" },
            { key: "name", label: "NAME" },
            { key: "expected", label: "EXPECTED" },
            { key: "observed", label: "OBSERVED" },
            { key: "status", label: "STATUS" },
          ],
          "text",
        );
        process.stdout.write(`\nStatus: ${r.dns_status}\n`);
      }),
    { args: [{ slot: 0, resource: "domains" }] },
  );

  withCompletion(
    g
      .command("health <fqdnOrId>")
      .description("show DNS + TLS + uptime health check result")
      .action(async (fqdnOrId: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const { id } = await resolveDomain(ctx.client, tid, fqdnOrId);
        const r = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/domains/${id}/health`,
        );
        printObject(r, fmt);
      }),
    { args: [{ slot: 0, resource: "domains" }] },
  );

  withCompletion(
    g
      .command("rm <fqdnOrId>")
      .description("remove (decommission) a domain")
      .option("--yes", "skip confirmation prompt")
      .action(async (fqdnOrId: string, opts: { yes?: boolean }) => {
        if (!opts.yes) {
          const ok = await promptYesNo(`remove domain ${fqdnOrId}? [y/N]: `);
          if (!ok) {
            process.stderr.write("aborted (pass --yes to confirm non-interactively)\n");
            process.exit(1);
          }
        }
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const { id, fqdn } = await resolveDomain(ctx.client, tid, fqdnOrId);
        await ctx.client.del<void>(`/tenants/${tid}/domains/${id}`);
        printMutation(
          program,
          { id, fqdn, status: "decommissioned" },
          `✓ domain removed: ${fqdn}`,
        );
      }),
    { args: [{ slot: 0, resource: "domains" }] },
  );
}
