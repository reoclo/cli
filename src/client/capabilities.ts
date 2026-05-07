import type { HttpClient } from "./http";

export interface CapabilityGrant {
  verb: string;
  scope_kind: string;
  scope_id: string | null;
}

export interface CapabilitiesResponse {
  grants: CapabilityGrant[];
}

/** Fetch the current user's effective capabilities (verbs only — scopes ignored client-side). */
export async function fetchCapabilities(client: HttpClient): Promise<string[]> {
  const res = await client.get<CapabilitiesResponse>("/auth/me/capabilities");
  return res.grants.map((g) => g.verb);
}

/** Check whether the cached capability list contains the given verb. */
export function hasCapability(capabilities: string[] | undefined, verb: string): boolean {
  if (!capabilities) return false;
  return capabilities.includes(verb);
}
