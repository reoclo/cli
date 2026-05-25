// src/auth/omega-mcp-store.ts
//
// Token store for the platform-admin omega-mcp surface. Lives alongside
// `~/.reoclo/config.json` but in its own file so the Docker container can
// mount it read-write without exposing the full CLI config.
//
// File schema (v1):
//   {
//     "access_token":  "<jwt>",
//     "refresh_token": "<opaque>",
//     "expires_at":    "<ISO-8601 UTC>",
//     "api_url":       "<https://api.reoclo.com>",
//     "auth_url":      "<https://auth.reoclo.com>",
//     "client_id":     "reoclo-omega-mcp",
//     "scope":         "mcp:omega"
//   }
//
// Permissions: 0600. The refresh token MUST NOT be world-readable.
// Refresh strategy: omega-mcp's HTTP client refreshes on 401 and writes the
// new tuple back to this file (rw mount). The host CLI only re-mints this
// when the user re-runs `reoclo connect-omega-mcp`.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config/paths";

export interface OmegaMcpTokenFile {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  api_url: string;
  auth_url: string;
  client_id: string;
  scope: string;
}

export function omegaMcpTokenPath(): string {
  return join(configDir(), "omega-mcp.json");
}

export function readOmegaMcpTokens(): Promise<OmegaMcpTokenFile | null> {
  const path = omegaMcpTokenPath();
  if (!existsSync(path)) return Promise.resolve(null);
  const raw = readFileSync(path, "utf8");
  try {
    return Promise.resolve(JSON.parse(raw) as OmegaMcpTokenFile);
  } catch {
    return Promise.reject(
      new Error(`corrupt omega-mcp token file at ${path} — delete and re-run 'reoclo connect-omega-mcp'`),
    );
  }
}

export function writeOmegaMcpTokens(tokens: OmegaMcpTokenFile): Promise<void> {
  const path = omegaMcpTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return Promise.resolve();
}
