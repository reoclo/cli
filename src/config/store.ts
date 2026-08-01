// src/config/store.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths";

export interface ProfileRecord {
  api_url: string;
  streams_url?: string;              // Cloudflare-bypass host for terminal WS / large uploads;
                                     // defaults derive from api_url in bootstrap.
  token?: string;
  token_ref?: string;
  // New CLI profiles must write "automation". "tenant" retained for backward
  // read-compat with v0.31.x / v0.32.x profiles minted before the OAuth-only
  // cut-over; new code paths must not write it. OAuth-issued profiles also
  // set `auth_kind: "oauth"` below.
  token_type: "tenant" | "automation";
  tenant_id: string;
  tenant_slug: string;
  user_email: string;
  saved_at: string;
  capabilities?: string[];
  capabilities_fetched_at?: string; // ISO timestamp
  // OAuth device-flow fields (absent for API-key profiles)
  auth_kind?: "api-key" | "oauth";
  refresh_token_ref?: string;        // keyring entry name for the refresh token
  access_token_expires_at?: string;  // ISO timestamp
  oauth_client_id?: string;          // "reoclo-cli"
  oauth_auth_url?: string;           // "https://auth.reoclo.com"
}

export interface ConfigFile {
  active_profile: string;
  profiles: Record<string, ProfileRecord>;
  version?: number;
}

export const GLOBAL_CONFIG_VERSION = 1;

const EMPTY: ConfigFile = { active_profile: "default", profiles: {} };

/**
 * Forward-migrate a loaded global config to the current schema. v1 rule: a
 * missing version becomes GLOBAL_CONFIG_VERSION (a structural no-op → changed).
 * The seam lets a future breaking schema set needsReauth for a version the CLI
 * cannot silently migrate; v1 never sets it.
 */
export function migrateGlobalConfig(raw: ConfigFile): { cfg: ConfigFile; changed: boolean; needsReauth: boolean } {
  const current = raw.version ?? 0;
  if (current >= GLOBAL_CONFIG_VERSION) return { cfg: raw, changed: false, needsReauth: false };
  return { cfg: { ...raw, version: GLOBAL_CONFIG_VERSION }, changed: true, needsReauth: false };
}

export function loadConfig(): Promise<ConfigFile> {
  const path = configFile();
  if (!existsSync(path)) return Promise.resolve(structuredClone(EMPTY));
  const raw = readFileSync(path, "utf8");
  try {
    const merged = { ...EMPTY, ...(JSON.parse(raw) as ConfigFile) };
    return Promise.resolve(migrateGlobalConfig(merged).cfg);
  } catch {
    return Promise.reject(new Error(`corrupt config at ${path} — delete the file and re-run 'reoclo login'`));
  }
}

/** Synchronous variant used by the completion engine (must remain offline/total).
 *  Returns the same defaulted shape as loadConfig; never throws — on any
 *  read or parse error returns the EMPTY defaults. */
export function loadConfigSync(): ConfigFile {
  try {
    const path = configFile();
    if (!existsSync(path)) return structuredClone(EMPTY);
    const raw = readFileSync(path, "utf8");
    const merged = { ...EMPTY, ...(JSON.parse(raw) as ConfigFile) };
    return migrateGlobalConfig(merged).cfg;
  } catch {
    return structuredClone(EMPTY);
  }
}

function writeConfig(cfg: ConfigFile): Promise<void> {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  const stamped: ConfigFile = { ...cfg, version: GLOBAL_CONFIG_VERSION };
  writeFileSync(path, JSON.stringify(stamped, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return Promise.resolve();
}

// Pure profile write. Setting which profile is *active* is an explicit decision
// owned by `reoclo login` (and `reoclo profile use`) — NOT a side effect of any
// write. Token persistence (FileStore.set) and refresh (bootstrap onExpiry) also
// route through here; they must never change the active profile.
export async function saveProfile(name: string, profile: ProfileRecord): Promise<void> {
  const cfg = await loadConfig();
  cfg.profiles[name] = profile;
  await writeConfig(cfg);
}

export async function deleteProfile(name: string): Promise<void> {
  const cfg = await loadConfig();
  delete cfg.profiles[name];
  if (cfg.active_profile === name) cfg.active_profile = Object.keys(cfg.profiles)[0] ?? "default";
  if (Object.keys(cfg.profiles).length === 0) {
    const path = configFile();
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  await writeConfig(cfg);
}

export async function getActiveProfile(): Promise<ProfileRecord | null> {
  const cfg = await loadConfig();
  return cfg.profiles[cfg.active_profile] ?? null;
}

export async function setActiveProfile(name: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.profiles[name]) throw new Error(`profile '${name}' does not exist`);
  cfg.active_profile = name;
  await writeConfig(cfg);
}

export async function updateProfileCapabilities(profileName: string, caps: string[]): Promise<void> {
  try {
    const cfg = await loadConfig();
    if (!cfg.profiles[profileName]) return;
    cfg.profiles[profileName].capabilities = caps;
    cfg.profiles[profileName].capabilities_fetched_at = new Date().toISOString();
    await writeConfig(cfg);
  } catch {
    // best-effort: swallow I/O failures silently
  }
}
