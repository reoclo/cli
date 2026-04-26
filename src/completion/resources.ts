// src/completion/resources.ts
//
// Cache-only readers for shell-completion candidates. These functions MUST
// NEVER make network calls — TAB completion has a hard <50ms budget. The
// cache is populated as a side effect of normal command runs (e.g.
// `reoclo apps ls`); first-time completion silently returns nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "../config/paths";

interface CacheEntry {
  id: string;
  ts: number;
}

interface CacheFile {
  version?: number;
  servers?: Record<string, CacheEntry>;
  apps?: Record<string, CacheEntry>;
  deployments?: Record<string, CacheEntry>;
  domains?: Record<string, CacheEntry>;
}

function readCache(): CacheFile {
  try {
    const p = join(cacheDir(), "slug-cache.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

function namesOf(map: Record<string, CacheEntry> | undefined): string[] {
  if (!map) return [];
  return Object.keys(map);
}

export function getCachedApps(): string[] {
  return namesOf(readCache().apps);
}

export function getCachedServers(): string[] {
  return namesOf(readCache().servers);
}

export function getCachedDeployments(): string[] {
  return namesOf(readCache().deployments);
}

export function getCachedDomains(): string[] {
  return namesOf(readCache().domains);
}

// Env keys aren't currently cached anywhere on disk; first-class env-key
// completion would need a separate cache file populated on `env ls`. For now
// we silently return [] so TAB on `env rm <KEY>` simply yields no
// suggestions rather than blocking on a network call.
export function getCachedEnvKeys(_appId: string): string[] {
  return [];
}
