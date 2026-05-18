// src/completion/index-client.ts
//
// Fetches GET /tenants/{tid}/completion-index and converts it to cache slices.
// The endpoint already returns Entry-shaped objects, so parseIndexResponse
// just validates and passes them through. `parseIndexResponse` is pure and
// exported for testing.

import type { HttpClient } from "../client/http";
import { RESOURCE_REGISTRY } from "./registry";
import { INDEX_KINDS, type Entry, type IndexKind } from "./types";

interface RawIndex {
  resources?: Record<string, unknown>;
}

/** True if `o` is an Entry — every required field a string. */
function isEntry(o: unknown): o is Entry {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.value === "string" &&
    typeof r.name === "string" &&
    typeof r.desc === "string"
  );
}

/** Convert a raw /completion-index payload to Entry slices keyed by kind.
 *  The endpoint returns Entry-shaped objects already; invalid entries are
 *  dropped rather than rejected. Never throws. */
export function parseIndexResponse(payload: unknown): Partial<Record<IndexKind, Entry[]>> {
  const out: Partial<Record<IndexKind, Entry[]>> = {};
  const raw = (payload as RawIndex | null)?.resources;
  if (!raw || typeof raw !== "object") return out;
  for (const kind of INDEX_KINDS) {
    const list = raw[RESOURCE_REGISTRY[kind].indexField];
    if (!Array.isArray(list)) continue;
    out[kind] = list.filter(isEntry);
  }
  return out;
}

/** Fetch the completion index. Throws on HTTP error (caller decides handling). */
export async function fetchCompletionIndex(
  client: HttpClient,
  tenantId: string,
): Promise<Partial<Record<IndexKind, Entry[]>>> {
  const payload = await client.get<unknown>(`/tenants/${tenantId}/completion-index`);
  return parseIndexResponse(payload);
}
