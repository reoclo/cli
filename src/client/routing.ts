export type KeyType = "tenant" | "automation" | "machine";

/**
 * Classifies a presented token for HTTP routing.
 *   - rca_* / rss_* / legacy rk_a_* → automation (/api/automation/v1, restricted commands)
 *   - rk_m_* → machine (a machine user: full /mcp surface, org-bound, no expiry)
 *   - everything else → tenant (OAuth session, /mcp)
 */
export function detectKeyType(token: string): KeyType {
  if (token.startsWith("rk_a_") || token.startsWith("rca_") || token.startsWith("rss_"))
    return "automation";
  if (token.startsWith("rk_m_")) return "machine";
  return "tenant";
}

export function apiPrefix(t: KeyType): string {
  // Machine tokens use the same tenant surface as OAuth sessions; only the
  // three secret-resolution calls cross to the automation prefix, via
  // machineLane() in client/secrets.ts.
  return t === "automation" ? "/api/automation/v1" : "/mcp";
}

const AUTOMATION_ALLOWED = new Set([
  "apps deploy",
  "apps restart",
  "exec",
  "shell",
  "checkout",
  "registry login",
  "registry logout",
  "deploy sync",
  "run",
  "secrets inject",
]);

/** Return true if a token of the given type can invoke this command path.
 *  Tenant and machine keys can invoke anything (the server enforces
 *  per-route); automation keys are restricted to a fixed set of full
 *  command paths (so e.g. `containers restart` is rejected even though its
 *  leaf is `restart`).
 */
export function commandSupportedBy(commandPath: string, t: KeyType): boolean {
  if (t !== "automation") return true;
  return AUTOMATION_ALLOWED.has(commandPath);
}

/** The command paths an automation key may invoke, in declaration order.
 *  Exported so the rejection message names the real set. Restating the list
 *  by hand let it drift: it lost `run`, one of the two commands that read
 *  secrets with an automation key (the other is `secrets inject`), and told
 *  operators the opposite of the truth.
 */
export function automationAllowedCommands(): string[] {
  return [...AUTOMATION_ALLOWED];
}
