export type KeyType = "tenant" | "automation";

export function detectKeyType(token: string): KeyType {
  if (token.startsWith("rk_a_")) return "automation";
  return "tenant";
}

export function apiPrefix(t: KeyType): string {
  return t === "automation" ? "/api/automation/v1" : "/api/v1";
}

const AUTOMATION_ALLOWED = new Set(["deploy", "restart", "exec"]);

export function commandSupportedBy(command: string, t: KeyType): boolean {
  if (t === "tenant") return true;
  return AUTOMATION_ALLOWED.has(command);
}
