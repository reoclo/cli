// src/util/health-check.ts
//
// Parse `apps config set --health-check <spec>` into the platform's
// deploy.health_check fields (type, http_path, command). The API enforces the
// same shapes; checking here names the flag to fix instead of surfacing a 422.

import { badUsage } from "./parse-flag";

export interface HealthCheckFields {
  type: "none" | "http" | "tcp" | "command";
  http_path?: string;
  command?: string;
}

const EXPECTED = "expected http:/path, tcp, command:<cmd> or none";

/** `http:/path`, `tcp`, `command:<cmd>` or `none`. */
export function parseHealthCheck(raw: string): HealthCheckFields {
  const spec = raw.trim();
  const lower = spec.toLowerCase();
  if (lower === "none") return { type: "none" };
  if (lower === "tcp") return { type: "tcp" };
  if (lower === "http" || lower === "command") {
    throw badUsage(`invalid --health-check: '${raw}' (${lower} needs a value: ${EXPECTED})`);
  }
  if (lower.startsWith("http:")) {
    const path = spec.slice("http:".length);
    if (!path.startsWith("/") || /\s/.test(path)) {
      throw badUsage(
        `invalid --health-check: '${raw}' (the http path must start with / and contain no spaces, for example http:/health)`,
      );
    }
    return { type: "http", http_path: path };
  }
  if (lower.startsWith("command:")) {
    const command = spec.slice("command:".length).trim();
    if (command === "") {
      throw badUsage(`invalid --health-check: '${raw}' (command: needs a command to run)`);
    }
    return { type: "command", command };
  }
  throw badUsage(`invalid --health-check: '${raw}' (${EXPECTED})`);
}
