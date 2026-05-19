// src/completion/types.ts
//
// Shared types for the declarative completion subsystem.

/** Resource kinds carried by the /completion-index endpoint. */
export const INDEX_KINDS = [
  "servers",
  "apps",
  "deployments",
  "domains",
  "tunnels",
  "monitors",
  "status-pages",
  "incidents",
  "schedule",
  "repos",
] as const;

/** Resource kinds carried by the /completion-index endpoint. */
export type IndexKind = (typeof INDEX_KINDS)[number];

/** All completable kinds: index-backed + two local-only kinds. */
export type ResourceKind = IndexKind | "envKeys" | "profiles";

/** One completable resource. `value` is inserted on TAB; `desc` annotates it. */
export interface Entry {
  id: string;
  value: string;
  name: string;
  desc: string;
}

/** A completion candidate emitted by the engine. */
export interface Candidate {
  value: string;
  desc?: string;
}
