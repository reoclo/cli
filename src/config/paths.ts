// src/config/paths.ts
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const _configDirStorage = new AsyncLocalStorage<string>();

/** Test-only: run callback with an isolated config directory override. */
export function withConfigDir<T>(dir: string, fn: () => T): T {
  return _configDirStorage.run(dir, fn);
}

export function configDir(): string {
  const override = _configDirStorage.getStore();
  if (override) return override;
  if (process.env.REOCLO_CONFIG_DIR) return process.env.REOCLO_CONFIG_DIR;
  return defaultConfigDir();
}

/** False when $REOCLO_CONFIG_DIR or a test points the CLI somewhere else. */
export function usingDefaultConfigDir(): boolean {
  return configDir() === defaultConfigDir();
}

export function defaultConfigDir(): string {
  if (platform() === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "reoclo");
  }
  return posixConfigDir(homedir(), process.env.XDG_CONFIG_HOME);
}

/** The config directory on macOS and Linux, given the home and XDG_CONFIG_HOME. */
export function posixConfigDir(home: string, xdgConfigHome: string | undefined): string {
  if (xdgConfigHome) return join(xdgConfigHome, "reoclo");
  // XDG_CONFIG_HOME is usually exported by an interactive shell's rc file only,
  // so launchd jobs, cron and agent subprocesses run without it and lost a login
  // saved under ~/.config/reoclo. Keep ~/.reoclo when it holds a config, else
  // follow an existing ~/.config/reoclo one.
  const legacy = join(home, ".reoclo");
  const xdgDefault = join(home, ".config", "reoclo");
  if (!existsSync(join(legacy, "config.json")) && existsSync(join(xdgDefault, "config.json"))) {
    return xdgDefault;
  }
  return legacy;
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
