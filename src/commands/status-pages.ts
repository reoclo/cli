// src/commands/status-pages.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import type { HttpClient } from "../client/http";
import {
  listStatusPages,
  resolveStatusPage,
  statusPagesPath as pagesPath,
  type StatusPage,
} from "../client/status-pages";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { parseBool } from "../util/parse-flag";
import {
  listVerifiedDomains,
  matchVerifiedDomainForHostname,
  resolveVerifiedDomain,
  type VerifiedDomain,
} from "./verified-domains";
import { registerStatusComponents } from "./status-components";

/**
 * Work out which verified root domain a custom hostname belongs to. With
 * `--verified-domain` the caller names it; otherwise it is inferred from the
 * hostname. Both paths reject a root that is not verified yet, because the API
 * would refuse the link anyway and the error is clearer from here.
 */
async function verifiedDomainForLink(
  client: HttpClient,
  tid: string,
  hostname: string,
  explicit: string | undefined,
): Promise<VerifiedDomain> {
  let vd: VerifiedDomain | null;
  if (explicit) {
    vd = await resolveVerifiedDomain(client, tid, explicit);
    const root = vd.root_domain.toLowerCase();
    const host = hostname.trim().toLowerCase();
    if (host !== root && !host.endsWith(`.${root}`)) {
      const e = new Error(
        `'${hostname}' is not under the verified root domain '${vd.root_domain}'`,
      ) as Error & { exitCode: number };
      e.exitCode = 2;
      throw e;
    }
  } else {
    vd = matchVerifiedDomainForHostname(await listVerifiedDomains(client, tid), hostname);
    if (!vd) {
      const e = new Error(
        `no verified root domain covers '${hostname}'`,
      ) as Error & { exitCode: number; hint: string };
      e.exitCode = 5;
      e.hint = `Claim the root first: reoclo verified-domains add <root-domain>`;
      throw e;
    }
  }

  if (vd.status !== "verified") {
    const e = new Error(
      `root domain '${vd.root_domain}' is not verified yet (status: ${vd.status})`,
    ) as Error & { exitCode: number; hint: string };
    e.exitCode = 2;
    e.hint = `Get the TXT record with: reoclo verified-domains verify ${vd.root_domain}`;
    throw e;
  }
  return vd;
}

export function registerStatusPages(program: Command): Command {
  const g = program.command("status-pages").description("manage status pages");

  g.command("ls")
    .description("list status pages")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const list = await listStatusPages(ctx.client, tid);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "id", label: "ID" },
          { key: "title", label: "TITLE" },
          { key: "slug", label: "SLUG" },
          { key: "custom_hostname", label: "HOSTNAME" },
          { key: "is_published", label: "PUBLISHED" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("get <page>")
      .description("show one status page")
      .action(async (page: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sp = await resolveStatusPage(ctx.client, tid, page);
        const full = await ctx.client.get<Record<string, unknown>>(`${pagesPath(tid)}/${sp.id}`);
        printObject(full, fmt);
      }),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  g.command("create")
    .description("create a status page")
    .option("--title <title>", "page title")
    .option("--label <label>", "short label")
    .option("--description <text>", "page description")
    .option("--hostname <fqdn>", "serve the page on this custom hostname")
    .option(
      "--verified-domain <rootOrId>",
      "verified root domain for --hostname (inferred when omitted)",
    )
    .action(
      async (opts: {
        title?: string;
        label?: string;
        description?: string;
        hostname?: string;
        verifiedDomain?: string;
      }) => {
        if (opts.verifiedDomain && !opts.hostname) {
          const e = new Error("--verified-domain requires --hostname") as Error & {
            exitCode: number;
          };
          e.exitCode = 2;
          throw e;
        }
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const body: Record<string, unknown> = {};
        if (opts.title !== undefined) body.title = opts.title;
        if (opts.label !== undefined) body.label = opts.label;
        if (opts.description !== undefined) body.description = opts.description;
        if (opts.hostname !== undefined) {
          const vd = await verifiedDomainForLink(
            ctx.client,
            tid,
            opts.hostname,
            opts.verifiedDomain,
          );
          body.domain_id = vd.id;
          body.custom_hostname = opts.hostname.trim().toLowerCase();
        }
        const sp = await ctx.client.post<StatusPage>(`${pagesPath(tid)}/`, body);
        printMutation(
          program,
          sp as unknown as Record<string, unknown>,
          `✓ status page created: ${sp.id} (slug: ${sp.slug})`,
        );
      },
    );

  withCompletion(
    g
      .command("update <page>")
      .description("update a status page")
      .option("--title <title>", "page title")
      .option("--label <label>", "short label")
      .option("--description <text>", "page description")
      .option("--published <bool>", "publish state (true|false)")
      .action(
        async (
          page: string,
          opts: { title?: string; label?: string; description?: string; published?: string },
        ) => {
          const ctx = await bootstrap();
          const tid = await requireTenantId(ctx);
          const sp = await resolveStatusPage(ctx.client, tid, page);
          const body: Record<string, unknown> = {};
          if (opts.title !== undefined) body.title = opts.title;
          if (opts.label !== undefined) body.label = opts.label;
          if (opts.description !== undefined) body.description = opts.description;
          if (opts.published !== undefined) {
            body.is_published = parseBool(opts.published, "--published");
          }
          if (Object.keys(body).length === 0) {
            const e = new Error("nothing to update. Pass at least one option.") as Error & {
              exitCode: number;
            };
            e.exitCode = 2;
            throw e;
          }
          const updated = await ctx.client.patch<StatusPage>(`${pagesPath(tid)}/${sp.id}`, body);
          printMutation(
            program,
            updated as unknown as Record<string, unknown>,
            `✓ status page updated: ${updated.id}`,
          );
        },
      ),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  for (const [name, published, verb] of [
    ["publish", true, "published"],
    ["unpublish", false, "unpublished"],
  ] as const) {
    withCompletion(
      g
        .command(`${name} <page>`)
        .description(`${name} a status page`)
        .action(async (page: string) => {
          const ctx = await bootstrap();
          const tid = await requireTenantId(ctx);
          const sp = await resolveStatusPage(ctx.client, tid, page);
          const updated = await ctx.client.patch<StatusPage>(`${pagesPath(tid)}/${sp.id}`, {
            is_published: published,
          });
          printMutation(
            program,
            updated as unknown as Record<string, unknown>,
            `✓ status page ${verb}: ${updated.title}`,
          );
        }),
      { args: [{ slot: 0, resource: "status-pages" }] },
    );
  }

  withCompletion(
    g
      .command("link <page>")
      .description("serve a status page on a custom hostname")
      .requiredOption("--hostname <fqdn>", "hostname under a verified root domain")
      .option(
        "--verified-domain <rootOrId>",
        "verified root domain to use (inferred from the hostname when omitted)",
      )
      .action(async (page: string, opts: { hostname: string; verifiedDomain?: string }) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sp = await resolveStatusPage(ctx.client, tid, page);
        const vd = await verifiedDomainForLink(
          ctx.client,
          tid,
          opts.hostname,
          opts.verifiedDomain,
        );
        const hostname = opts.hostname.trim().toLowerCase();
        const updated = await ctx.client.patch<StatusPage>(`${pagesPath(tid)}/${sp.id}`, {
          domain_id: vd.id,
          custom_hostname: hostname,
        });
        printMutation(
          program,
          updated as unknown as Record<string, unknown>,
          `✓ ${updated.title} is now served on ${hostname} (root: ${vd.root_domain})\n` +
            `Point ${hostname} at Reoclo with the CNAME shown on the status page's Domain tab, ` +
            `then publish with: reoclo status-pages publish ${updated.slug}`,
        );
      }),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  withCompletion(
    g
      .command("unlink <page>")
      .description("stop serving a status page on its custom hostname")
      .action(async (page: string) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sp = await resolveStatusPage(ctx.client, tid, page);
        const updated = await ctx.client.patch<StatusPage>(`${pagesPath(tid)}/${sp.id}`, {
          domain_id: null,
          custom_hostname: null,
        });
        printMutation(
          program,
          updated as unknown as Record<string, unknown>,
          `✓ custom hostname removed from ${updated.title}`,
        );
      }),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  withCompletion(
    g
      .command("regenerate-slug <page>")
      .description("issue a new random slug for the page's default URL")
      .action(async (page: string) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sp = await resolveStatusPage(ctx.client, tid, page);
        const updated = await ctx.client.post<StatusPage>(
          `${pagesPath(tid)}/${sp.id}/regenerate-slug`,
        );
        printMutation(
          program,
          updated as unknown as Record<string, unknown>,
          `✓ new slug for ${updated.title}: ${updated.slug}`,
        );
      }),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  withCompletion(
    g
      .command("rm <page>")
      .description("delete a status page and everything on it")
      .action(async (page: string) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sp = await resolveStatusPage(ctx.client, tid, page);
        await ctx.client.del<void>(`${pagesPath(tid)}/${sp.id}`);
        printMutation(
          program,
          { id: sp.id, title: sp.title },
          `✓ status page removed: ${sp.title}`,
        );
      }),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  registerStatusComponents(program, g);

  return g;
}
