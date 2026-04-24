// src/commands/domains.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { printList, printObject, resolveFormat } from "../ui/output";
import type { Domain } from "../client/types";
import type { HttpClient } from "../client/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

interface VerifyResponse {
  txt_name: string;
  txt_value: string;
  expires_at: string;
}

async function resolveDomainId(
  client: HttpClient,
  tid: string,
  fqdnOrId: string,
): Promise<string> {
  if (UUID.test(fqdnOrId)) return fqdnOrId;
  const list = await client.get<Domain[]>(`/tenants/${tid}/domains/`);
  const found = list.find((d) => d.fqdn === fqdnOrId);
  if (!found) {
    const e = new Error(`domain '${fqdnOrId}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found.id;
}

export function registerDomains(program: Command): void {
  const g = program.command("domains").description("manage domains");

  g.command("ls")
    .description("list domains in the tenant")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<Domain[]>(`/tenants/${tid}/domains/`);
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

  g.command("add <fqdn>")
    .description("register a new domain")
    .action(async (fqdn: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const d = await ctx.client.post<Domain>(`/tenants/${tid}/domains/`, { fqdn });
      console.log(`✓ added ${d.fqdn} (id: ${d.id}, status: ${d.status})`);
      console.log("Run 'reoclo domains verify <fqdn>' to fetch the TXT record needed for verification.");
      // For -o json, also dump the full record
      if (fmt === "json") printObject(d as unknown as Record<string, unknown>, fmt);
    });

  g.command("verify <fqdnOrId>")
    .description("fetch the TXT record needed to verify a domain")
    .action(async (fqdnOrId: string) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const id = await resolveDomainId(ctx.client, tid, fqdnOrId);
      const r = await ctx.client.post<VerifyResponse>(`/tenants/${tid}/domains/${id}/verify`);
      console.log("Add this DNS TXT record to verify the domain:");
      console.log(`  Name:    ${r.txt_name}`);
      console.log(`  Value:   ${r.txt_value}`);
      console.log(`  Expires: ${r.expires_at}`);
      console.log("\nThe verification job runs every few minutes; once the TXT is observed,");
      console.log("the domain status will update from 'pending' to 'verified'.");
    });
}
