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
}

const EMPTY: ConfigFile = { active_profile: "default", profiles: {} };

export function loadConfig(): Promise<ConfigFile> {
  const path = configFile();
  if (!existsSync(path)) return Promise.resolve(structuredClone(EMPTY));
  const raw = readFileSync(path, "utf8");
  try {
    return Promise.resolve({ ...EMPTY, ...(JSON.parse(raw) as ConfigFile) });
  } catch {
    return Promise.reject(new Error(`corrupt config at ${path} — delete the file and re-run 'reoclo login'`));
  }
}

function writeConfig(cfg: ConfigFile): Promise<void> {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return Promise.resolve();
}

export async function saveProfile(name: string, profile: ProfileRecord): Promise<void> {
  const cfg = await loadConfig();
  cfg.profiles[name] = profile;
  if (!cfg.active_profile || cfg.active_profile === "default") cfg.active_profile = name;
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
