// src/commands/test-pools.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { EXIT } from "../client/exit-codes";
import type { HttpClient } from "../client/http";
import { exitError } from "../client/repo-deploy";
import { resolveTestPool, type TestMachine, type TestPool, type TestVariable } from "../client/testing";
import type { PaginatedResponse } from "../client/types";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { confirmOrExit } from "../ui/prompt";
import { formatMinor, parseMoney } from "../util/ephemeral-pool";
import { badUsage, parseEnum, parseIntFlag } from "../util/parse-flag";
import { parseLimit, parseOffset } from "../util/parse-limit";
import { parseUnsetKeys, parseVariables } from "../util/test-vars";

const HARD_LIMIT = 100;
const PROVIDERS = ["hetzner", "aws"] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOCATION = /^[a-z0-9-]{1,50}$/;
const SERVER_TYPE = /^[a-z][a-z0-9.-]{1,49}$/;
const STOCK_IMAGE = /^[a-z0-9.-]{1,80}$/;
const CURRENCY = /^[A-Z]{3}$/;

interface PoolFlags {
  name?: string;
  credential?: string;
  location?: string;
  serverType?: string;
  fallbackType: string[];
  arch?: string;
  image?: string;
  stockImage?: string;
  volume?: string;
  maxMachines?: string;
  jobTimeLimit?: string;
  budget?: string;
  budgetCurrency?: string;
  var: string[];
  secret: string[];
}

interface CloudCredential { id: string; label: string; provider: string }

const collect = (val: string, prev: string[]): string[] => [...prev, val];

function addPoolOptions(cmd: Command): Command {
  return cmd
    .option("--credential <idOrLabel>", "cloud credential (AWS or Hetzner) that machines are created with")
    .option("--location <loc>", "Hetzner location such as fsn1, or an AWS region such as us-east-1")
    .option("--server-type <type>", "machine type, such as cx33 on Hetzner or m7i.large on AWS")
    .option("--fallback-type <type>", "fallback machine type, tried in order (repeatable, up to 10)", collect, [] as string[])
    .option("--arch <arch>", "amd64 (default) or arm64")
    .option("--image <id>", "Hetzner snapshot id or AWS AMI id (edit: 'none' goes back to the stock image)")
    .option("--stock-image <name>", "stock image when no --image is set (default ubuntu-24.04)")
    .option("--volume <gb>", "root volume in GB, 20-500 (default 50)")
    .option("--max-machines <n>", "machines the pool runs at once, 1-50 (default 2)")
    .option("--job-time-limit <minutes>", "longest a job may run, 5-7200 (default 360)")
    .option("--budget <amount>", "monthly net budget, e.g. 25 or 25.50")
    .option("--budget-currency <code>", "budget currency (default EUR on Hetzner, USD on AWS)")
    .option("--var <KEY=VALUE>", "plain variable passed to every job (repeatable)", collect, [] as string[])
    .option("--secret <KEY=VALUE>", "write-only secret variable, never shown again (repeatable)", collect, [] as string[]);
}

function matching(raw: string, pattern: RegExp, flag: string): string {
  if (!pattern.test(raw)) throw badUsage(`invalid ${flag}: '${raw}'`);
  return raw;
}

function poolFields(f: PoolFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (f.name !== undefined) body["name"] = f.name;
  if (f.location !== undefined) body["location"] = matching(f.location, LOCATION, "--location");
  if (f.serverType !== undefined) body["server_type"] = matching(f.serverType, SERVER_TYPE, "--server-type");
  if (f.fallbackType.length > 0) {
    if (f.fallbackType.length > 10) throw badUsage("at most 10 --fallback-type values");
    body["fallback_server_types"] = f.fallbackType.map((t) => matching(t, SERVER_TYPE, "--fallback-type"));
  }
  if (f.arch !== undefined) body["arch"] = parseEnum(f.arch, ["amd64", "arm64"] as const, "--arch");
  if (f.image !== undefined) body["image"] = f.image === "none" ? null : f.image;
  if (f.stockImage !== undefined) body["stock_image"] = matching(f.stockImage, STOCK_IMAGE, "--stock-image");
  if (f.volume !== undefined) body["volume_gb"] = parseIntFlag(f.volume, "--volume", 20, 500);
  if (f.maxMachines !== undefined) body["max_machines"] = parseIntFlag(f.maxMachines, "--max-machines", 1, 50);
  if (f.jobTimeLimit !== undefined) body["job_time_limit_minutes"] = parseIntFlag(f.jobTimeLimit, "--job-time-limit", 5, 7200);
  if (f.budget !== undefined) body["monthly_budget_cents"] = parseMoney(f.budget, "--budget");
  if (f.budgetCurrency !== undefined) body["budget_currency"] = matching(f.budgetCurrency.toUpperCase(), CURRENCY, "--budget-currency");
  return body;
}

async function resolveCredential(client: HttpClient, tid: string, ref: string, provider: string | undefined): Promise<CloudCredential> {
  const all = await client.get<CloudCredential[]>(`/tenants/${tid}/cloud-credentials`);
  const matches = all.filter(
    (c) => (c.id === ref || c.label === ref) && (provider === undefined || c.provider === provider) && c.provider !== "cloudflare",
  );
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length > 1) throw badUsage(`credential '${ref}' matches several providers; pass --provider hetzner or aws`);
  throw exitError(`${provider ?? "cloud"} credential '${ref}' not found`, EXIT.NOT_FOUND);
}

function describeVariables(vars: TestVariable[]): string {
  return vars.map((v) => (v.secret ? `${v.key} (secret)` : `${v.key}=${v.value ?? ""}`)).join(", ");
}

function poolRow(p: TestPool): Record<string, unknown> {
  return {
    ...p,
    type: `${p.server_type} ${p.location}`,
    machines: `${p.live_machines}/${p.max_machines}`,
    budget: formatMinor(p.monthly_budget_cents, p.budget_currency),
  };
}

export function registerTestPools(program: Command): void {
  const g = program.command("test-pools").description("manage test pools (machines that run your test files)");

  g.command("ls")
    .description("list test pools")
    .option("--skip <n>", "pagination skip", "0")
    .option("--limit <n>", "pagination limit", "20")
    .action(async (opts: { skip: string; limit: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const skip = parseOffset(opts.skip);
      const limit = parseLimit(opts.limit, HARD_LIMIT);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const res = await ctx.client.get<PaginatedResponse<TestPool>>(`/tenants/${tid}/test-pools?skip=${skip}&limit=${limit}`);
      printList(
        res.items.map(poolRow),
        [
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "provider", label: "PROVIDER" },
          { key: "type", label: "TYPE" },
          { key: "machines", label: "MACHINES" },
          { key: "budget", label: "BUDGET" },
          { key: "id", label: "ID" },
        ],
        fmt,
      );
    });

  g.command("get <pool>")
    .description("show one test pool (pool slug or id; secret values are never shown)")
    .action(async (ref: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveTestPool(ctx.client, tid, ref);
      const pool = await ctx.client.get<TestPool>(`/tenants/${tid}/test-pools/${id}`);
      printObject(fmt === "text" ? { ...pool, variables: describeVariables(pool.variables) } : { ...pool }, fmt);
    });

  addPoolOptions(
    g
      .command("create")
      .description("create a test pool")
      .requiredOption("--name <name>", "pool name")
      .option("--slug <slug>", "slug test files select the pool with (default: from the name; cannot change later)")
      .option("--provider <provider>", "hetzner or aws (default: the credential's provider)"),
  ).action(async (opts: PoolFlags & { name: string; slug?: string; provider?: string }) => {
    for (const [flag, value] of [["--credential", opts.credential], ["--location", opts.location], ["--server-type", opts.serverType]] as const) {
      if (value === undefined) throw badUsage(`${flag} is required`);
    }
    const provider = opts.provider === undefined ? undefined : parseEnum(opts.provider, PROVIDERS, "--provider");
    const slug = opts.slug === undefined ? undefined : matching(opts.slug, SLUG, "--slug");
    const fields = poolFields(opts);
    const variables = parseVariables(opts.var, opts.secret);
    const ctx = await bootstrap();
    const tid = await requireTenantId(ctx);
    const credential = await resolveCredential(ctx.client, tid, opts.credential ?? "", provider);
    const body = {
      ...fields,
      ...(slug === undefined ? {} : { slug }),
      provider: credential.provider,
      cloud_credential_id: credential.id,
      variables,
    };
    const pool = await ctx.client.post<TestPool>(`/tenants/${tid}/test-pools`, body);
    printMutation(program, { ...pool }, `✓ test pool created: ${pool.name} (slug: ${pool.slug}, id: ${pool.id})`);
  });

  addPoolOptions(
    g
      .command("edit <pool>")
      .description("update a test pool (the slug and provider cannot change)")
      .option("--name <name>", "new name")
      .option("--unset-var <KEY>", "delete a variable (repeatable)", collect, [] as string[]),
  ).action(async (ref: string, opts: PoolFlags & { unsetVar: string[] }) => {
    const fields = poolFields(opts);
    const set = parseVariables(opts.var, opts.secret);
    const unset = parseUnsetKeys(opts.unsetVar, set);
    if (Object.keys(fields).length === 0 && set.length === 0 && unset.length === 0 && opts.credential === undefined) {
      throw badUsage("no fields to update");
    }
    const ctx = await bootstrap();
    const tid = await requireTenantId(ctx);
    const id = await resolveTestPool(ctx.client, tid, ref);
    if (opts.credential !== undefined) {
      const current = await ctx.client.get<TestPool>(`/tenants/${tid}/test-pools/${id}`);
      fields["cloud_credential_id"] = (await resolveCredential(ctx.client, tid, opts.credential, current.provider)).id;
    }
    const variables: Record<string, { value: string; secret: boolean } | null> = {};
    for (const v of set) variables[v.key] = { value: v.value, secret: v.secret };
    for (const key of unset) variables[key] = null;
    const body = set.length + unset.length > 0 ? { ...fields, variables } : fields;
    const pool = await ctx.client.patch<TestPool>(`/tenants/${tid}/test-pools/${id}`, body);
    printMutation(program, { ...pool }, `✓ test pool updated: ${pool.name} (slug: ${pool.slug}, id: ${pool.id})`);
  });

  g.command("rm <pool>")
    .description("delete a test pool (it must have no live machines or active runs)")
    .option("--yes", "skip confirmation prompt")
    .action(async (ref: string, opts: { yes?: boolean }) => {
      await confirmOrExit(`delete test pool ${ref}? [y/N]: `, opts.yes);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveTestPool(ctx.client, tid, ref);
      await ctx.client.del<void>(`/tenants/${tid}/test-pools/${id}`);
      process.stdout.write(`✓ test pool removed: ${ref}\n`);
    });

  g.command("machines <pool>")
    .description("list the machines a test pool has created, newest first")
    .option("--skip <n>", "pagination skip", "0")
    .option("--limit <n>", "pagination limit", "20")
    .action(async (ref: string, opts: { skip: string; limit: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const skip = parseOffset(opts.skip);
      const limit = parseLimit(opts.limit, HARD_LIMIT);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveTestPool(ctx.client, tid, ref);
      const res = await ctx.client.get<PaginatedResponse<TestMachine>>(`/tenants/${tid}/test-pools/${id}/machines?skip=${skip}&limit=${limit}`);
      const rows = res.items.map((m) => ({
        ...m,
        cost: m.cost ? formatMinor(m.cost.net_minor_units, m.cost.currency) : "-",
        deleted_at: m.deleted_at ?? "",
        error_code: m.error_code ?? "",
      }));
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "id", label: "ID" },
          { key: "state", label: "STATE" },
          { key: "server_type", label: "TYPE" },
          { key: "location", label: "LOCATION" },
          { key: "created_at", label: "CREATED" },
          { key: "deleted_at", label: "DELETED" },
          { key: "cost", label: "COST" },
          { key: "error_code", label: "ERROR" },
        ],
        fmt,
      );
    });
}
