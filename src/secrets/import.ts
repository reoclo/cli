// src/secrets/import.ts
//
// Provider-agnostic import orchestrator. Pure planning functions (this block)
// are I/O-free and unit-tested directly; runImport (below) wires them to an
// injected source + client. Secret VALUES live only inside `creates` on their
// way to the API — they are never returned in reports or error messages.

import type { SecretCreate } from "../client/secrets";
import type { ImportedSecret, ImportReport, SecretSource } from "./types";

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

export interface ImportOptions {
  /** Drop already-existing keys instead of aborting on conflict. */
  skipExisting: boolean;
  /** Plan only — perform no writes. */
  dryRun: boolean;
}

export interface ImportDeps {
  source: SecretSource;
  /** The target project as the user named it — for display only. */
  projectLabel: string;
  /** Existing keys in the target project (for the conflict pre-check). */
  listExistingKeys: () => Promise<string[]>;
  /** Write one chunk (≤500) of creates to the target project. */
  bulkCreate: (secrets: SecretCreate[]) => Promise<void>;
}

/**
 * Read from the source, validate, apply policy against the existing keys, then
 * chunk-write. Throws (before any write) on in-batch duplicates or, under the
 * default policy, on conflicts. On a mid-run chunk failure, throws an error
 * stating how many secrets landed and that `--skip-existing` resumes
 * idempotently. Never includes secret values in any message.
 */
export async function runImport(
  deps: ImportDeps,
  opts: ImportOptions,
): Promise<ImportReport> {
  const imported = await deps.source.read();
  const { creates, emptyKeys, duplicateKeys } = mapAndValidate(imported);

  if (duplicateKeys.length > 0) {
    throw new Error(
      `source has duplicate keys (cannot import into one project): ${duplicateKeys.join(", ")}`,
    );
  }

  const existing = new Set(await deps.listExistingKeys());
  const { fresh, conflicting } = partitionExisting(creates, existing);

  if (conflicting.length > 0 && !opts.skipExisting) {
    throw new Error(
      `${conflicting.length} secret(s) already exist in ${deps.projectLabel} — ` +
        `re-run with --skip-existing to skip them: ${conflicting.join(", ")}`,
    );
  }

  const toCreate = fresh;
  const skippedExisting = opts.skipExisting ? conflicting : [];
  const plannedKeys = toCreate.map((c) => c.key);

  const report: ImportReport = {
    source: deps.source.name,
    project: deps.projectLabel,
    dryRun: opts.dryRun,
    imported: plannedKeys,
    skippedExisting,
    skippedEmpty: emptyKeys,
  };

  if (opts.dryRun) return report;

  let landed = 0;
  for (const batch of chunk(toCreate, BULK_CHUNK_SIZE)) {
    try {
      await deps.bulkCreate(batch);
      landed += batch.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `imported ${landed} of ${toCreate.length} secret(s) before failing: ${msg}. ` +
          `Re-run with --skip-existing to resume.`,
      );
    }
  }

  return report;
}

export function importReportJson(r: ImportReport): {
  source: string;
  project: string;
  imported: string[];
  skipped_existing: string[];
  skipped_empty: string[];
  dry_run: boolean;
} {
  return {
    source: r.source,
    project: r.project,
    imported: r.imported,
    skipped_existing: r.skippedExisting,
    skipped_empty: r.skippedEmpty,
    dry_run: r.dryRun,
  };
}

export function importReportText(r: ImportReport): string {
  const n = r.imported.length;
  const m = r.skippedExisting.length;
  const k = r.skippedEmpty.length;
  if (r.dryRun) {
    return (
      `Dry run: would import ${n} secret(s) into ${r.project} ` +
      `(${m} existing would be skipped, ${k} empty skipped). ` +
      `Actual import is subject to your secret quota.`
    );
  }
  return `Imported ${n} secret(s) into ${r.project} (skipped ${m} existing, ${k} empty).`;
}
