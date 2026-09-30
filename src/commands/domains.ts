// src/commands/domains.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";
import type { Domain, RedirectCode } from "../client/types";
import type { HttpClient } from "../client/http";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { resolveApp, resolveServer } from "../client/resolve";
import { EXIT } from "../client/exit-codes";
import { parseEnum, parseIntFlag } from "../util/parse-flag";

interface VerifyResponse {
  txt_name: string;
  txt_value: string;
  expires_at: string;
}

export interface PlanOp {
  op: "keep" | "create" | "update" | "delete" | "conflict";
  record_type: string;
  name: string;
  current_content: string | null;
  current_proxied: boolean | null;
  desired_content: string | null;
  desired_proxied: boolean | null;
  reason: string | null;
}

export interface DnsPlan {
  credential_label: string;
  zone_name: string;
  server_name: string;
  ops: PlanOp[];
  plan_hash: string;
  blocked_reason: string | null;
}

export interface PublishState {
  status: string;
  applied: string[];
  last_error: string | null;
}

export function planRows(plan: DnsPlan): Array<{ action: string; type: string; name: string; current: string; new: string }> {
  return plan.ops
    .filter((op) => op.op !== "keep")
    .map((op) => ({
      action: op.op,
      type: op.record_type,
      name: op.name,
      current: op.current_content ?? "-",
      new: op.op === "delete" ? "-" : (op.desired_content ?? "-"),
    }));
}

/** Poll until dns.publish leaves "pending"; null when it does not within `attempts`. */
export async function pollPublish(
  fetch: () => Promise<{ dns: { publish?: PublishState } }>,
  opts: { attempts: number; sleepMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<PublishState | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < opts.attempts; i++) {
    const domain = await fetch();
    const publish = domain.dns.publish;
    if (publish && publish.status !== "pending") return publish;
    await sleep(opts.sleepMs);
  }
  return null;
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

function exitError(message: string, code: number): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = code;
  return e;
}

const REDIRECT_CODE_TEXT = ["301", "302", "307", "308"] as const;
const REDIRECT_CODE: Record<(typeof REDIRECT_CODE_TEXT)[number], RedirectCode> = {
  "301": 301,
  "302": 302,
  "307": 307,
  "308": 308,
};

/** The API's redirect body (DomainRedirect). */
export interface RedirectBody {
  target_domain_id?: string;
  target_url?: string;
  target_path?: string | null;
  status_code: RedirectCode;
  keep_path: boolean;
}

export function parseRedirectCode(raw: string | undefined): RedirectCode {
  if (raw === undefined) return 301;
  return REDIRECT_CODE[parseEnum(raw, REDIRECT_CODE_TEXT, "--code")];
}

/**
 * Turn a --redirect-to / --to value into the API's redirect body. A value that
 * starts with http:// or https:// is a URL target; anything else is
 * `<fqdn>[/<path>]`, looked up among the organization's domains.
 */
export function buildRedirect(
  target: string,
  domains: ReadonlyArray<Pick<Domain, "id" | "fqdn">>,
  opts: { code?: string | undefined; keepPath: boolean },
): RedirectBody {
  const status_code = parseRedirectCode(opts.code);
  const keep_path = opts.keepPath;
  if (/^https?:\/\//i.test(target)) return { target_url: target, status_code, keep_path };
  const slash = target.indexOf("/");
  const host = (slash === -1 ? target : target.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? null : target.slice(slash);
  const found = domains.find((d) => d.fqdn === host);
  if (!found) {
    throw exitError(
      `domain '${host}' not found. Use a full https:// URL for a target outside your domains.`,
      EXIT.NOT_FOUND,
    );
  }
  return { target_domain_id: found.id, target_path: path, status_code, keep_path };
}

/** "301 → example.com/blog", "308 → https://x.example.org", or "-". */
export function redirectLabel(
  domain: Pick<Domain, "redirect">,
  domains: ReadonlyArray<Pick<Domain, "id" | "fqdn">>,
): string {
  const r = domain.redirect;
  if (!r) return "-";
  const host = domains.find((d) => d.id === r.target_domain_id)?.fqdn ?? r.target_domain_id ?? "?";
  const target = r.target_url ?? `${host}${r.target_path ?? ""}`;
  return `${r.status_code} → ${target}`;
}

export interface AddOptions {
  app?: string;
  server?: string;
  port?: string;
  redirectTo?: string;
  code?: string;
  /** commander sets this from --no-keep-path; true unless the flag is given. */
  keepPath: boolean;
}

export async function buildAddBody(
  client: HttpClient,
  tid: string,
  fqdn: string,
  opts: AddOptions,
): Promise<Record<string, unknown>> {
  if (opts.redirectTo === undefined && (opts.code !== undefined || !opts.keepPath)) {
    throw exitError("--code and --no-keep-path need --redirect-to", EXIT.MISUSE);
  }
  if (opts.redirectTo !== undefined && opts.app === undefined) {
    throw exitError("--redirect-to needs --app: a redirect belongs to an application", EXIT.MISUSE);
  }
  if (opts.redirectTo !== undefined && opts.port !== undefined) {
    throw exitError("--port does not apply to a redirect", EXIT.MISUSE);
  }
  const body: Record<string, unknown> = { fqdn };
  if (opts.app !== undefined) body["application_id"] = await resolveApp(client, tid, opts.app);
  if (opts.server !== undefined) body["bound_server_id"] = await resolveServer(client, tid, opts.server);
  if (opts.port !== undefined) body["target_port"] = parseIntFlag(opts.port, "--port", 1, 65535);
  if (opts.redirectTo !== undefined) {
    const domains = await client.get<Domain[]>(`/tenants/${tid}/domains/`);
    body["redirect"] = buildRedirect(opts.redirectTo, domains, { code: opts.code, keepPath: opts.keepPath });
  }
  return body;
}

export function registerDomains(program: Command): void {
  const g = program.command("domains").description("manage domains");

  g.command("ls")
    .description("list domains in the organization")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
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
        const tid = await requireTenantId(ctx);
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
    .description("register a domain, optionally linked to an app or as a redirect")
    .option("--app <nameOrId>", "link the domain to this application")
    .option("--server <nameOrId>", "server that serves the domain")
    .option("--port <n>", "container port to route to")
    .option("--redirect-to <target>", "redirect to a domain (example.com[/path]) or a URL (https://...)")
    .option("--code <code>", "redirect status code: 301 (default), 302, 307 or 308")
    .option("--no-keep-path", "do not append the request path and query to the redirect target")
    .action(async (fqdn: string, opts: AddOptions) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const body = await buildAddBody(ctx.client, tid, fqdn, opts);
      const d = await ctx.client.post<Domain>(`/tenants/${tid}/domains/`, body);
      console.log(`✓ added ${d.fqdn} (id: ${d.id}, status: ${d.status})`);
      if (d.redirect && opts.redirectTo !== undefined) {
        console.log(`  redirects to ${opts.redirectTo} (${d.redirect.status_code})`);
      } else {
        console.log(
          "Run 'reoclo domains verify <fqdn>' to fetch the TXT record needed for verification.",
        );
      }
      // For -o json, also dump the full record
      if (fmt === "json") printObject(d as unknown as Record<string, unknown>, fmt);
    });

  withCompletion(
    g
      .command("verify <fqdnOrId>")
      .description("fetch the TXT record needed to verify a domain")
      .action(async (fqdnOrId: string) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
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
      .option("--fix", "preview the records Reoclo expects and write them to Cloudflare after confirmation")
      .option("--proxied", "proxy new records through Cloudflare (orange cloud)")
      .option("--yes", "skip the confirmation prompt")
      .action(async (fqdnOrId: string, opts: { fix?: boolean; proxied?: boolean; yes?: boolean }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const { id } = await resolveDomain(ctx.client, tid, fqdnOrId);

        if (opts.fix) {
          const plan = await ctx.client.post<DnsPlan>(`/tenants/${tid}/dns/plan/${id}`, { proxied: Boolean(opts.proxied) });
          if (fmt === "json" || fmt === "yaml") printObject(plan as unknown as Record<string, unknown>, fmt);
          if (plan.blocked_reason) {
            process.stderr.write(`cannot apply: ${plan.blocked_reason}\n`);
            process.exit(1);
          }
          const rows = planRows(plan);
          if (rows.length === 0) {
            console.log("Every expected record is already correct.");
            return;
          }
          if (fmt === "text") {
            printList(
              rows as unknown as Array<Record<string, unknown>>,
              [
                { key: "action", label: "ACTION" }, { key: "type", label: "TYPE" }, { key: "name", label: "NAME" },
                { key: "current", label: "CURRENT" }, { key: "new", label: "NEW" },
              ],
              "text",
            );
          }
          if (!opts.yes) {
            const ok = await promptYesNo("Apply these changes on Cloudflare? [y/N]: ");
            if (!ok) {
              process.stderr.write("aborted (pass --yes to confirm non-interactively)\n");
              process.exit(1);
            }
          }
          await ctx.client.post(`/tenants/${tid}/dns/publish/${id}`, { plan_hash: plan.plan_hash, proxied: Boolean(opts.proxied) });
          const outcome = await pollPublish(
            () => ctx.client.get<{ dns: { publish?: PublishState } }>(`/tenants/${tid}/domains/${id}`),
            { attempts: 30, sleepMs: 2000 },
          );
          if (outcome === null) {
            process.stderr.write("still publishing; check `reoclo domains dns` in a moment\n");
            process.exit(1);
          }
          if (outcome.status !== "succeeded") {
            process.stderr.write(`publish failed: ${outcome.last_error ?? "unknown error"}\n`);
            for (const line of outcome.applied) process.stderr.write(`  applied before failure: ${line}\n`);
            process.exit(1);
          }
          for (const line of outcome.applied) console.log(`✓ published: ${line}`);
          return;
        }

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
        const tid = await requireTenantId(ctx);
        const { id } = await resolveDomain(ctx.client, tid, fqdnOrId);
        const d = await ctx.client.get<Record<string, unknown>>(`/tenants/${tid}/domains/${id}`);
        printObject(
          {
            fqdn: d["fqdn"],
            verification: d["verification"],
            dns: d["dns"],
            ssl: d["ssl"],
            registration: d["registration"],
          },
          fmt,
        );
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
        const tid = await requireTenantId(ctx);
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
