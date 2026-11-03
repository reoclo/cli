// src/commands/dns.ts
//
// `reoclo dns records`: list, add and remove TXT, CNAME and MX records on a
// Cloudflare zone Reoclo already covers for the organization. The zone is
// never sent: the server resolves it from the record name (or from the zone
// name given with --zone), so a name outside every covered zone is refused
// there. Records Reoclo publishes for application domains come back flagged
// `managed` and cannot be added over or removed.

import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { confirmOrExit } from "../ui/prompt";
import { badUsage, parseIntFlag } from "../util/parse-flag";

export const RECORD_TYPES = ["TXT", "CNAME", "MX"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

const AUTO_TTL = 1;
const MIN_TTL = 60;
const MAX_TTL = 86400;
const MAX_PRIORITY = 65535;

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority: number | null;
  managed: boolean;
}

export interface DnsRecordList {
  zone_name: string;
  records: DnsRecord[];
}

export interface DnsRecordCreated extends DnsRecord {
  zone_name: string;
}

export interface AddOptions {
  type: string;
  content: string;
  ttl?: string;
  priority?: string;
  zone?: string;
}

export interface AddBody {
  type: RecordType;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  zone?: string;
}

export function parseRecordType(raw: string, flag = "--type"): RecordType {
  const value = raw.trim().toUpperCase();
  if ((RECORD_TYPES as readonly string[]).includes(value)) return value as RecordType;
  throw badUsage(`invalid ${flag}: '${raw}' (expected one of: ${RECORD_TYPES.join(", ")})`);
}

/** `auto` or a number of seconds; the server applies the same limits. */
export function parseTtl(raw: string): number {
  if (raw.trim().toLowerCase() === "auto") return AUTO_TTL;
  return parseIntFlag(raw, "--ttl", MIN_TTL, MAX_TTL);
}

export function parsePriority(raw: string): number {
  return parseIntFlag(raw, "--priority", 0, MAX_PRIORITY);
}

/** Turn the `add` arguments into the request body, rejecting a bad combination before any call. */
export function buildAddBody(name: string, opts: AddOptions): AddBody {
  const type = parseRecordType(opts.type);
  const content = opts.content.trim();
  if (content === "") throw badUsage("--content cannot be empty");
  if (name.trim() === "") throw badUsage("the record name cannot be empty");
  const body: AddBody = { type, name: name.trim(), content };
  if (opts.ttl !== undefined) body.ttl = parseTtl(opts.ttl);
  if (opts.zone !== undefined) body.zone = opts.zone.trim();
  if (type === "MX") {
    if (opts.priority === undefined) throw badUsage("MX records need --priority (0 to 65535)");
    body.priority = parsePriority(opts.priority);
  } else if (opts.priority !== undefined) {
    throw badUsage("--priority applies to MX records only");
  }
  return body;
}

export function listPath(tid: string, name: string, type?: RecordType): string {
  const query = [`name=${encodeURIComponent(name.trim())}`];
  if (type !== undefined) query.push(`type=${type}`);
  return `/tenants/${tid}/dns/records?${query.join("&")}`;
}

export function removePath(tid: string, recordId: string, zone: string): string {
  return `/tenants/${tid}/dns/records/${encodeURIComponent(recordId.trim())}?zone=${encodeURIComponent(zone.trim())}`;
}

export function recordRows(records: DnsRecord[]): Array<Record<string, string>> {
  return records.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl === AUTO_TTL ? "auto" : String(r.ttl),
    priority: r.priority === null || r.priority === undefined ? "-" : String(r.priority),
    managed: r.managed ? "reoclo" : "-",
  }));
}

export function registerDns(program: Command): void {
  const g = program.command("dns").description("manage DNS records on your Cloudflare zones");
  const records = g
    .command("records")
    .description("list, add and remove TXT, CNAME and MX records");

  withCompletion(
    records
      .command("ls <zoneOrName>")
      .description("list TXT, CNAME and MX records for a zone or a record name")
      .option("--type <type>", "only this record type: TXT, CNAME or MX")
      .action(async (zoneOrName: string, opts: { type?: string }) => {
        const type = opts.type !== undefined ? parseRecordType(opts.type) : undefined;
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const result = await ctx.client.get<DnsRecordList>(listPath(tid, zoneOrName, type));
        if (fmt === "json" || fmt === "yaml") {
          printObject(result as unknown as Record<string, unknown>, fmt);
          return;
        }
        if (result.records.length === 0) {
          process.stdout.write(`No TXT, CNAME or MX records found in ${result.zone_name}.\n`);
          return;
        }
        printList(
          recordRows(result.records),
          [
            { key: "id", label: "ID" },
            { key: "type", label: "TYPE" },
            { key: "name", label: "NAME" },
            { key: "content", label: "CONTENT" },
            { key: "ttl", label: "TTL" },
            { key: "priority", label: "PRIORITY" },
            { key: "managed", label: "MANAGED" },
          ],
          fmt,
        );
      }),
    { flags: { type: { enum: [...RECORD_TYPES] } } },
  );

  withCompletion(
    records
      .command("add <name>")
      .description("add a TXT, CNAME or MX record (a relative name needs --zone)")
      .requiredOption("--type <type>", "record type: TXT, CNAME or MX")
      .requiredOption("--content <value>", "record value: text, target hostname or mail host")
      .option("--ttl <seconds>", "time to live in seconds (60 to 86400) or auto; default auto")
      .option("--priority <n>", "MX priority, 0 to 65535 (MX records only)")
      .option("--zone <zone>", "zone the name belongs to, such as example.com")
      .action(async (name: string, opts: AddOptions) => {
        const body = buildAddBody(name, opts);
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const created = await ctx.client.post<DnsRecordCreated>(
          `/tenants/${tid}/dns/records`,
          body,
        );
        printMutation(
          program,
          created as unknown as Record<string, unknown>,
          `✓ added ${created.type} ${created.name} in ${created.zone_name} (id: ${created.id})`,
        );
      }),
    { flags: { type: { enum: [...RECORD_TYPES] } } },
  );

  records
    .command("rm <recordId>")
    .description("remove a TXT, CNAME or MX record by id (see `dns records ls`)")
    .requiredOption("--zone <zone>", "zone the record belongs to, such as example.com")
    .option("--yes", "skip confirmation prompt")
    .action(async (recordId: string, opts: { zone: string; yes?: boolean }) => {
      await confirmOrExit(`remove record ${recordId} from ${opts.zone}? [y/N]: `, opts.yes);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      await ctx.client.del<void>(removePath(tid, recordId, opts.zone));
      printMutation(
        program,
        { id: recordId, zone: opts.zone, removed: true },
        `✓ record removed: ${recordId} from ${opts.zone}`,
      );
    });
}
