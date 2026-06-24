// src/secrets/import.ts
//
// Provider-agnostic import orchestrator. Pure planning functions (this block)
// are I/O-free and unit-tested directly; runImport (below) wires them to an
// injected source + client. Secret VALUES live only inside `creates` on their
// way to the API — they are never returned in reports or error messages.

import type { SecretCreate } from "../client/secrets";
import type { ImportedSecret } from "./types";

/** The endpoint accepts at most 500 secrets per bulk call. */
export const BULK_CHUNK_SIZE = 500;

export interface MappedSecrets {
  creates: SecretCreate[];
  /** Keys dropped because their source value was empty (length 0). */
  emptyKeys: string[];
  /** Keys that appeared more than once in the source batch. */
  duplicateKeys: string[];
}

/**
 * Map imported secrets to API create DTOs, dropping empty-value secrets and
 * detecting in-batch duplicate keys. The first occurrence of a key wins; later
 * occurrences are recorded in `duplicateKeys`. Empty notes are omitted.
 */
export function mapAndValidate(imported: ImportedSecret[]): MappedSecrets {
  const creates: SecretCreate[] = [];
  const emptyKeys: string[] = [];
  const duplicateKeys: string[] = [];
  const seen = new Set<string>();

  for (const s of imported) {
    if (s.value.length === 0) {
      emptyKeys.push(s.key);
      continue;
    }
    if (seen.has(s.key)) {
      duplicateKeys.push(s.key);
      continue;
    }
    seen.add(s.key);
    const create: SecretCreate = { key: s.key, value: s.value };
    if (s.note != null && s.note.length > 0) create.note = s.note;
    creates.push(create);
  }

  return { creates, emptyKeys, duplicateKeys };
}

/** Split creates into those whose key is free vs already present in `existing`. */
export function partitionExisting(
  creates: SecretCreate[],
  existing: Set<string>,
): { fresh: SecretCreate[]; conflicting: string[] } {
  const fresh: SecretCreate[] = [];
  const conflicting: string[] = [];
  for (const c of creates) {
    if (existing.has(c.key)) conflicting.push(c.key);
    else fresh.push(c);
  }
  return { fresh, conflicting };
}

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
