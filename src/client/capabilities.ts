import type { HttpClient } from "./http";

export interface CapabilityGrant {
  verb: string;
  scope_kind: string;
  scope_id: string | null;
}

export interface CapabilitiesResponse {
  capabilities: CapabilityGrant[];
}

/** Fetch the current user's effective capabilities (verbs only — scopes ignored client-side).
 *
 *  The server (`GET /auth/me/capabilities` → `MeCapabilitiesResponse`) returns
 *  `{ capabilities: [{ verb, scope_kind, scope_id }] }`. This reads that field
 *  and flattens to the bare verb list the cache and the command-surface gate
 *  expect. Reading the wrong field here silently degraded every login to an
 *  empty capability cache (REO-167). */
export async function fetchCapabilities(client: HttpClient): Promise<string[]> {
  const res = await client.get<CapabilitiesResponse>("/auth/me/capabilities");
  return (res.capabilities ?? []).map((g) => g.verb);
}

/** Check whether the cached capability list contains the given verb. */
export function hasCapability(capabilities: string[] | undefined, verb: string): boolean {
  if (!capabilities) return false;
  return capabilities.includes(verb);
}
