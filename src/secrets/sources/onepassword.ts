// src/secrets/sources/onepassword.ts
//
// Import source adapter #2: 1Password. Shells out to the user's official `op`
// CLI (which decrypts values locally) and normalizes items into flat secrets.
// reoclo never reads or stores the user's 1Password credential — it only
// inherits the ambient env (OP_SERVICE_ACCOUNT_TOKEN or an interactive `op`
// session) into the child process.
//
// op JSON contract (verified against 1Password CLI v2):
//   op item list --format json  -> [{ id, title, vault: { id, name }, ... }]
//   op item get <id> --format json -> { title, vault: { id }, fields: [
//     { id, type, purpose, label, value } ] }  (value absent for empty fields)

import type { CommandResult, CommandRunner } from "./exec";
import type { ImportedSecret, SecretSource } from "../types";

/** A 1Password field — only the keys this adapter reads. */
export interface OpField {
  type?: string;
  purpose?: string;
  label?: string;
  value?: string;
}

/** A 1Password item (from `op item get`) — only the keys this adapter reads. */
export interface OpItem {
  title?: string;
  vault?: { id?: string };
  fields?: OpField[];
}

/** Derive a Reoclo secret key (UPPER_SNAKE) from raw label parts.
 *  Mirrors api/secretsmgr/sync_core.derive_key. */
export function deriveKey(...parts: string[]): string {
  const raw = parts.join("_").toUpperCase();
  const cleaned = raw.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "SECRET";
}

/** Return `key`, appending _2/_3/... if already present in `used`. Records the
 *  chosen key in `used`. Mirrors api/secretsmgr/sync_core.unique_key. */
export function uniqueKey(key: string, used: Set<string>): string {
  let final = key;
  let suffix = 2;
  while (used.has(final)) {
    final = `${key}_${suffix}`;
    suffix += 1;
  }
  used.add(final);
  return final;
}

/** Filter (D4) + derive + dedup one item's fields into ImportedSecret[].
 *  Drops empty/non-string values, OTP-type fields, and the NOTES blob.
 *  Mutates `used` so keys stay unique across items. */
export function mapItemFields(item: OpItem, used: Set<string>): ImportedSecret[] {
  const out: ImportedSecret[] = [];
  const title = item.title ?? "";
  for (const f of item.fields ?? []) {
    if (typeof f.value !== "string" || f.value.length === 0) continue;
    if ((f.type ?? "").toUpperCase() === "OTP") continue;
    if ((f.purpose ?? "").toUpperCase() === "NOTES") continue;
    const key = uniqueKey(deriveKey(title, f.label ?? ""), used);
    out.push({ key, value: f.value, note: null });
  }
  return out;
}

export interface OnePasswordOptions {
  /** Optional 1Password vault scope — a name or id, resolved by `op` itself. */
  opVault?: string;
}

export interface OnePasswordDeps {
  run: CommandRunner;
  env: Record<string, string | undefined>;
}

/** A 1Password item summary (from `op item list`) — only the keys we read. */
interface OpItemSummary {
  id: string;
  vault?: { id?: string };
}

export function onepasswordSource(
  opts: OnePasswordOptions,
  deps: OnePasswordDeps,
): SecretSource {
  return {
    name: "onepassword",
    read: () => readOnePassword(opts, deps),
  };
}

async function readOnePassword(
  opts: OnePasswordOptions,
  deps: OnePasswordDeps,
): Promise<ImportedSecret[]> {
  const listArgs = ["item", "list"];
  if (opts.opVault) listArgs.push("--vault", opts.opVault);
  listArgs.push("--format", "json");

  const listRes = await runOp(listArgs, deps);
  const summaries = parseJson<OpItemSummary[]>(listRes.stdout, "op item list");

  const used = new Set<string>();
  const out: ImportedSecret[] = [];
  for (const s of summaries) {
    const getArgs = ["item", "get", s.id];
    if (s.vault?.id) getArgs.push("--vault", s.vault.id);
    getArgs.push("--format", "json");
    const getRes = await runOp(getArgs, deps);
    const item = parseJson<OpItem>(getRes.stdout, "op item get");
    out.push(...mapItemFields(item, used));
  }
  return out;
}

async function runOp(args: string[], deps: OnePasswordDeps): Promise<CommandResult> {
  let res: CommandResult;
  try {
    res = await deps.run(["op", ...args], { env: deps.env });
  } catch (e) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "ENOENT") {
      throw new Error(
        'the "op" CLI was not found — install the 1Password CLI: https://developer.1password.com/docs/cli/get-started/',
      );
    }
    throw e;
  }
  if (res.code !== 0) {
    const detail = res.stderr.trim() || `exited with status ${res.code}`;
    throw new Error(`op ${args[0]} ${args[1]} failed: ${detail}`);
  }
  return res;
}

function parseJson<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`could not parse ${what} output as JSON`);
  }
}
