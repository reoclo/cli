export type KeyType = "tenant" | "automation";

export function detectKeyType(token: string): KeyType {
  if (token.startsWith("rk_a_")) return "automation";
  return "tenant";
}

export function apiPrefix(t: KeyType): string {
  // Tenant keys hit Caddy's /mcp/* path which strips the prefix and forwards
  // to the internal API. Automation keys hit the dedicated /api/automation/v1/*
  // route (no prefix strip). Both terminate at the internal API but with
  // different scopes, ACL rules, and rate limits.
  return t === "automation" ? "/api/automation/v1" : "/mcp";
}

const AUTOMATION_ALLOWED = new Set(["deploy", "restart", "exec", "shell"]);

export function commandSupportedBy(command: string, t: KeyType): boolean {
  if (t === "tenant") return true;
  return AUTOMATION_ALLOWED.has(command);
}
