// src/secrets/types.ts
//
// Provider-agnostic types for the one-shot import framework. A source adapter
// (Bitwarden today, others later) implements SecretSource; the orchestrator
// consumes it without knowing which provider it is.

/** A secret as read from an external source, before mapping to the API DTO. */
export interface ImportedSecret {
  key: string;
  value: string;
  note?: string | null;
}

/** A configured, ready-to-read import source. `read()` takes no arguments —
 *  any source-specific options are bound when the source is constructed. */
export interface SecretSource {
  /** Short label used in reports/messages, e.g. "bitwarden". */
  readonly name: string;
  read(): Promise<ImportedSecret[]>;
}

/** The outcome of an import (or a dry-run plan). Keys only — never values. */
export interface ImportReport {
  source: string;
  /** The target project as the user referred to it (name or id). */
  project: string;
  dryRun: boolean;
  /** Keys created (real run) or that would be created (dry-run). */
  imported: string[];
  /** Keys skipped because they already exist in the target project. */
  skippedExisting: string[];
  /** Keys skipped because their source value was empty. */
  skippedEmpty: string[];
}
