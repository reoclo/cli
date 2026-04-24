// src/config/paths.ts
import { homedir, platform } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  if (process.env.REOCLO_CONFIG_DIR) return process.env.REOCLO_CONFIG_DIR;
  if (platform() === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "reoclo");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "reoclo") : join(homedir(), ".reoclo");
}

export function cacheDir(): string {
  if (process.env.REOCLO_CACHE_DIR) return process.env.REOCLO_CACHE_DIR;
  if (platform() === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "reoclo", "cache");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg ? join(xdg, "reoclo") : join(homedir(), ".cache", "reoclo");
}

export function configFile(): string {
  return join(configDir(), "config.json");
}
