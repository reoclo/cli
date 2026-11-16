// src/commands/storage-credentials.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveStorageCredential } from "../client/testing";
import type { PaginatedResponse } from "../client/types";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { confirmOrExit } from "../ui/prompt";
import { badUsage } from "../util/parse-flag";
import { parseLimit, parseOffset } from "../util/parse-limit";
import { readSecret } from "../util/secret";

const HARD_LIMIT = 100;
const SECRET_STDIN_FLAG = "--secret-key-stdin";

interface StorageCredential {
  id: string;
  name: string;
  endpoint: string | null;
  access_key_id: string;
  description: string | null;
  pools: Array<{ id: string; name: string; bucket: string }>;
}

interface EditFlags {
  name?: string;
  endpoint?: string;
  accessKeyId?: string;
  description?: string;
  secretKeyStdin?: boolean;
}

const poolNames = (c: StorageCredential): string => c.pools.map((p) => p.name).join(", ");

/** The PATCH body for the flags given, or null when none of them change anything. */
export function storageCredentialPatch(flags: EditFlags, secretKey: string | undefined): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (flags.name !== undefined) body["name"] = flags.name;
  if (flags.endpoint !== undefined) body["endpoint"] = flags.endpoint;
  if (flags.accessKeyId !== undefined) body["access_key_id"] = flags.accessKeyId;
  if (flags.description !== undefined) body["description"] = flags.description;
  if (secretKey !== undefined) body["secret_key"] = secretKey;
  return Object.keys(body).length > 0 ? body : null;
}

export function registerStorageCredentials(program: Command): void {
  const g = program
    .command("storage-credentials")
    .description("manage the storage credentials (S3-compatible keys) that test pools use for caches and artifacts");

  g.command("ls")
    .description("list storage credentials")
    .option("--skip <n>", "pagination skip", "0")
    .option("--limit <n>", "pagination limit", "20")
    .action(async (opts: { skip: string; limit: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const skip = parseOffset(opts.skip);
      const limit = parseLimit(opts.limit, HARD_LIMIT);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const res = await ctx.client.get<PaginatedResponse<StorageCredential>>(`/tenants/${tid}/storage-credentials?skip=${skip}&limit=${limit}`);
      printList(
        res.items.map((c) => ({ ...c, pool_names: poolNames(c) })),
        [
          { key: "name", label: "NAME" },
          { key: "endpoint", label: "ENDPOINT" },
          { key: "access_key_id", label: "ACCESS KEY ID" },
          { key: "pool_names", label: "POOLS" },
          { key: "id", label: "ID" },
        ],
        fmt,
      );
    });

  g.command("get <credential>")
    .description("show one storage credential (name or id; the secret key is never shown)")
    .action(async (ref: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveStorageCredential(ctx.client, tid, ref);
      const credential = await ctx.client.get<StorageCredential>(`/tenants/${tid}/storage-credentials/${id}`);
      printObject(fmt === "text" ? { ...credential, pools: poolNames(credential) } : { ...credential }, fmt);
    });

  g.command("create")
    .description("create a storage credential; the secret key is read from stdin or a masked prompt")
    .requiredOption("--name <name>", "credential name")
    .requiredOption("--access-key-id <id>", "access key id")
    .option("--endpoint <url>", "S3-compatible endpoint, such as a Cloudflare R2 URL (default: AWS S3)")
    .option("--description <text>", "description")
    .option(SECRET_STDIN_FLAG, "read the secret access key from stdin")
    .action(async (opts: { name: string; accessKeyId: string; endpoint?: string; description?: string; secretKeyStdin?: boolean }) => {
      const secretKey = await readSecret({ fromStdin: Boolean(opts.secretKeyStdin), promptLabel: "secret access key", stdinFlag: SECRET_STDIN_FLAG });
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const body: Record<string, unknown> = { name: opts.name, access_key_id: opts.accessKeyId, secret_key: secretKey };
      if (opts.endpoint !== undefined) body["endpoint"] = opts.endpoint;
      if (opts.description !== undefined) body["description"] = opts.description;
      const created = await ctx.client.post<StorageCredential>(`/tenants/${tid}/storage-credentials`, body);
      printMutation(program, { ...created }, `✓ storage credential created: ${created.name} (id: ${created.id})`);
    });

  g.command("edit <credential>")
    .description("update a storage credential (name or id); a new endpoint or access key id needs a new secret key")
    .option("--name <name>", "new name")
    .option("--endpoint <url>", "new endpoint (needs --secret-key-stdin)")
    .option("--access-key-id <id>", "new access key id (needs --secret-key-stdin)")
    .option("--description <text>", "new description")
    .option(SECRET_STDIN_FLAG, "rotate the secret access key (read from stdin)")
    .action(async (ref: string, opts: EditFlags) => {
      const changesCredentials = opts.endpoint !== undefined || opts.accessKeyId !== undefined;
      if (changesCredentials && !opts.secretKeyStdin) {
        throw badUsage(`a new --endpoint or --access-key-id needs the new secret key: pass ${SECRET_STDIN_FLAG}`);
      }
      const secretKey = opts.secretKeyStdin
        ? await readSecret({ fromStdin: true, promptLabel: "secret access key", stdinFlag: SECRET_STDIN_FLAG })
        : undefined;
      const body = storageCredentialPatch(opts, secretKey);
      if (body === null) throw badUsage("no fields to update");
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveStorageCredential(ctx.client, tid, ref);
      const updated = await ctx.client.patch<StorageCredential>(`/tenants/${tid}/storage-credentials/${id}`, body);
      printMutation(program, { ...updated }, `✓ storage credential updated: ${updated.name} (id: ${updated.id})`);
    });

  g.command("rm <credential>")
    .description("delete a storage credential (name or id)")
    .option("--yes", "skip confirmation prompt")
    .action(async (ref: string, opts: { yes?: boolean }) => {
      await confirmOrExit(`delete storage credential ${ref}? [y/N]: `, opts.yes);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveStorageCredential(ctx.client, tid, ref);
      await ctx.client.del<void>(`/tenants/${tid}/storage-credentials/${id}`);
      process.stdout.write(`✓ storage credential removed: ${ref}\n`);
    });
}
