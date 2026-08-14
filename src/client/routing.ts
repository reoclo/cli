export type KeyType = "tenant" | "automation" | "machine";

/**
 * Prefixes that classify a token as an automation key: `rca_` (the one a
 * person sets by hand), `rss_` (minted by the API), and legacy `rk_a_`.
 * Single source of truth for the automation shape — `detectKeyType` below
 * and `assertEnvCredentialShape` (bootstrap.ts) both derive from this list,
 * so the two classifiers cannot silently drift apart.
 */
export const AUTOMATION_KEY_PREFIXES = ["rk_a_", "rca_", "rss_"] as const;

/**
 * Prefix that classifies a token as a machine-user credential. Single source
 * of truth for the machine shape, same rationale as
 * {@link AUTOMATION_KEY_PREFIXES}.
 */
export const MACHINE_TOKEN_PREFIX = "rk_m_";

/** True when `token` matches one of {@link AUTOMATION_KEY_PREFIXES}. */
export function isAutomationKeyShaped(token: string): boolean {
  return AUTOMATION_KEY_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/** True when `token` matches {@link MACHINE_TOKEN_PREFIX}. */
export function isMachineTokenShaped(token: string): boolean {
  return token.startsWith(MACHINE_TOKEN_PREFIX);
}

/**
 * Classifies a presented token for HTTP routing.
 *   - rca_* / rss_* / legacy rk_a_* → automation (/api/automation/v1, restricted commands)
 *   - rk_m_* → machine (a machine user: full /mcp surface, org-bound, no expiry)
 *   - everything else → tenant (OAuth session, /mcp)
 */
export function detectKeyType(token: string): KeyType {
  if (isAutomationKeyShaped(token)) return "automation";
  if (isMachineTokenShaped(token)) return "machine";
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
