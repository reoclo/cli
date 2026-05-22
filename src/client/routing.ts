export type KeyType = "tenant" | "automation";

/**
 * Classifies a presented token for HTTP routing.
 *
 *   - `rca_*` and the legacy `rk_a_*` prefix → automation (hits
 *     `/api/automation/v1/*`, restricted command surface).
 *   - everything else → "tenant" routing (`/mcp/*`), which is the surface
 *     OAuth-issued access tokens use. The legacy `rk_t_*` tenant integration
 *     key prefix has been retired but still resolves here for read-compat
 *     with any in-flight requests during rollout.
 */
export function detectKeyType(token: string): KeyType {
  if (token.startsWith("rk_a_") || token.startsWith("rca_")) return "automation";
  return "tenant";
}

export function apiPrefix(t: KeyType): string {
  // Tenant keys hit Caddy's /mcp/* path which strips the prefix and forwards
  // to the internal API. Automation keys hit the dedicated /api/automation/v1/*
  // route (no prefix strip). Both terminate at the internal API but with
  // different scopes, ACL rules, and rate limits.
  return t === "automation" ? "/api/automation/v1" : "/mcp";
}

const AUTOMATION_ALLOWED = new Set(["apps deploy", "apps restart", "exec", "shell"]);

/** Return true if a token of the given type can invoke this command path.
 *  Tenant keys can invoke anything; automation keys are restricted to a
 *  fixed set of full command paths (so e.g. `containers restart` is rejected
 *  even though its leaf is `restart`).
 */
export function commandSupportedBy(commandPath: string, t: KeyType): boolean {
  if (t === "tenant") return true;
  return AUTOMATION_ALLOWED.has(commandPath);
}
