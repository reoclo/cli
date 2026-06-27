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

import type { ImportedSecret } from "../types";

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
