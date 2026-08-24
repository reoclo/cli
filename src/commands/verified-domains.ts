// src/commands/verified-domains.ts
//
// A verified domain is a root domain this organization has proven it owns, via
// a DNS TXT record. It is not the same resource as `reoclo domains`, which are
// per-application hostnames that route traffic. Ownership of the root is what
// gates putting a status page on a custom hostname, so this group is the first
// step of `reoclo status-pages link`.

import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";
import type { HttpClient } from "../client/http";

export interface VerifiedDomain {
  id: string;
  root_domain: string;
  status: string;
  verification?: {
    txt_name?: string | null;
    verified_at?: string | null;
    last_error?: string | null;
  };
  ssl_status?: string | null;
  ssl_expires_at?: string | null;
}

interface VerifyResponse {
  txt_name: string;
  txt_value: string;
  expires_at: string;
}

export async function listVerifiedDomains(
  client: HttpClient,
  tid: string,
): Promise<VerifiedDomain[]> {
  return client.get<VerifiedDomain[]>(`/tenants/${tid}/verified-domains/`);
}

/** Resolve a root domain name or id to the record. Exits 5 when unknown. */
export async function resolveVerifiedDomain(
  client: HttpClient,
  tid: string,
  rootOrId: string,
): Promise<VerifiedDomain> {
  const list = await listVerifiedDomains(client, tid);
  const needle = rootOrId.trim().toLowerCase();
  const found =
    list.find((d) => d.root_domain.toLowerCase() === needle) ?? list.find((d) => d.id === rootOrId);
  if (!found) {
    const e = new Error(`verified domain '${rootOrId}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found;
}

/**
 * Pick the verified domain that `hostname` sits under, taking the longest
 * matching root, so "status.eu.acme.com" prefers "eu.acme.com" over "acme.com" when both
 * are registered. Returns null when nothing matches.
 */
export function matchVerifiedDomainForHostname(
  list: readonly VerifiedDomain[],
  hostname: string,
): VerifiedDomain | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const matches = list.filter((d) => {
    const root = d.root_domain.trim().toLowerCase();
    return host === root || host.endsWith(`.${root}`);
  });
  if (matches.length === 0) return null;
  return matches.reduce((best, d) => (d.root_domain.length > best.root_domain.length ? d : best));
}

export function registerVerifiedDomains(program: Command): void {
  const g = program
    .command("verified-domains")
    .description("manage verified root domains (proof of ownership)");

  g.command("ls")
    .description("list verified root domains")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const list = await listVerifiedDomains(ctx.client, tid);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "root_domain", label: "ROOT DOMAIN" },
          { key: "status", label: "STATUS" },
          { key: "id", label: "ID" },
        ],
        fmt,
      );
    });

  g.command("get <rootOrId>")
    .description("show one verified root domain")
    .action(async (rootOrId: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const vd = await resolveVerifiedDomain(ctx.client, tid, rootOrId);
      printObject(vd as unknown as Record<string, unknown>, fmt);
    });

  g.command("resources <rootOrId>")
    .description("show the domains, applications, and status pages under a verified root")
    .action(async (rootOrId: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const vd = await resolveVerifiedDomain(ctx.client, tid, rootOrId);
      const detail = await ctx.client.get<Record<string, unknown>>(
        `/tenants/${tid}/verified-domains/${vd.id}/resources`,
      );
      printObject(detail, fmt);
    });

  g.command("add <rootDomain>")
    .description("claim a root domain and start ownership verification")
    .action(async (rootDomain: string) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const vd = await ctx.client.post<VerifiedDomain>(`/tenants/${tid}/verified-domains/`, {
        root_domain: rootDomain,
      });
      printMutation(
        program,
        vd as unknown as Record<string, unknown>,
        `✓ claimed ${vd.root_domain} (id: ${vd.id}, status: ${vd.status})\n` +
          `Run 'reoclo verified-domains verify ${vd.root_domain}' for the TXT record.`,
      );
    });

  g.command("verify <rootOrId>")
    .description("fetch the TXT record that proves ownership of a root domain")
    .action(async (rootOrId: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const vd = await resolveVerifiedDomain(ctx.client, tid, rootOrId);
      const r = await ctx.client.post<VerifyResponse>(
        `/tenants/${tid}/verified-domains/${vd.id}/verify`,
      );
      if (fmt === "json" || fmt === "yaml") {
        printObject(r as unknown as Record<string, unknown>, fmt);
        return;
      }
      process.stdout.write("Add this DNS TXT record to prove you own the domain:\n");
      process.stdout.write(`  Name:    ${r.txt_name}\n`);
      process.stdout.write(`  Value:   ${r.txt_value}\n`);
      process.stdout.write(`  Expires: ${r.expires_at}\n`);
      process.stdout.write(
        "\nThe check runs every few minutes. The status changes to 'verified' after the record is found.\n",
      );
    });

  withCompletion(
    g
      .command("rm <rootOrId>")
      .description("remove a verified root domain")
      .option("--yes", "skip confirmation prompt")
      .action(async (rootOrId: string, opts: { yes?: boolean }) => {
        if (!opts.yes) {
          const ok = await promptYesNo(`remove verified domain ${rootOrId}? [y/N]: `);
          if (!ok) {
            process.stderr.write("aborted (pass --yes to confirm non-interactively)\n");
            process.exit(1);
          }
        }
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const vd = await resolveVerifiedDomain(ctx.client, tid, rootOrId);
        await ctx.client.del<void>(`/tenants/${tid}/verified-domains/${vd.id}`);
        printMutation(
          program,
          { id: vd.id, root_domain: vd.root_domain },
          `✓ verified domain removed: ${vd.root_domain}`,
        );
      }),
    { args: [{ slot: 0, resource: "domains" }] },
  );
}
