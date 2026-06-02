// src/completion/cache.ts
//
// Read/write the local completion cache (`completion-cache.json`, version 4).
// The cache is PARTITIONED BY tenant_id so completions only ever reflect the
// currently-authorised account: switching profiles / orgs (or a prior login to
// another account) can never leak one account's resources into another's
// completions. Every read is defensive: a missing, corrupt, or wrong-version
// file is treated as empty. Writes are atomic (temp file + rename) so concurrent
// writers (background refresh, list commands, `warm`) never tear the file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { cacheDir } from "../config/paths";
import { loadConfigSync } from "../config/store";
import { resolveProfileName } from "../config/profile-resolve";
import { INDEX_KINDS, type Entry, type IndexKind } from "./types";

const CACHE_VERSION = 4;

// Bucket key for credentials with no resolvable tenant (e.g. an automation key,
// or before the first login). Keeps reads/writes total even with no tenant.
const NO_TENANT = "_";

interface ResourceSlice {
  ts: number;
  entries: Entry[];
}
interface EnvKeySlice {
  ts: number;
  keys: string[];
}
interface TenantCache {
  resources: Record<IndexKind, ResourceSlice>;
  envKeys: Record<string, EnvKeySlice>;
}
interface CompletionCache {
  version: number;
  tenants: Record<string, TenantCache>;
}

// ---------------------------------------------------------------------------
// Current-tenant resolution
// ---------------------------------------------------------------------------

let _activeTenantId: string | undefined;

/**
 * Stamp the tenant the completion cache should read/write for this process.
 * Called by bootstrap() (command processes, after --profile / --org resolution)
 * and by the completion engine (the __complete process, from a typed
 * --profile). Pass undefined to fall back to the active profile's tenant.
 */
export function setActiveTenantId(tenantId: string | undefined): void {
  _activeTenantId = tenantId;
}

/** The active profile's tenant_id from config (offline; never throws). */
function configTenantId(): string | undefined {
  try {
    const cfg = loadConfigSync();
    const name = resolveProfileName({
      flagProfile: undefined,
      envProfile: process.env.REOCLO_PROFILE,
      activeProfile: cfg.active_profile,
    });
    return cfg.profiles[name]?.tenant_id;
  } catch {
    return undefined;
  }
}

/** The bucket key for the current invocation — always a string so it can key
 *  the cache; NO_TENANT when no tenant is resolvable. */
function currentTenantKey(): string {
  return _activeTenantId ?? configTenantId() ?? NO_TENANT;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function emptyTenant(): TenantCache {
  const resources = {} as Record<IndexKind, ResourceSlice>;
  for (const k of INDEX_KINDS) resources[k] = { ts: 0, entries: [] };
  return { resources, envKeys: {} };
}

function emptyCache(): CompletionCache {
  return { version: CACHE_VERSION, tenants: {} };
}

/** Read one tenant's cache, backfilling any missing resource slice so callers
 *  never hit `undefined`. Returns a fresh empty tenant when absent. */
function tenantOf(c: CompletionCache, key: string): TenantCache {
  const raw = c.tenants[key];
  const base = emptyTenant();
  if (!raw || typeof raw !== "object") return base;
  const rawResources = raw.resources && typeof raw.resources === "object" ? raw.resources : {};
  return {
    resources: { ...base.resources, ...rawResources },
    envKeys: raw.envKeys && typeof raw.envKeys === "object" ? raw.envKeys : {},
  };
}

function cachePath(): string {
  return join(cacheDir(), "completion-cache.json");
}

function readCache(): CompletionCache {
  try {
    const p = cachePath();
    if (!existsSync(p)) return emptyCache();
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CompletionCache;
    // A different version (incl. the pre-partition v3 shape) is discarded.
    if (parsed.version !== CACHE_VERSION) return emptyCache();
    return {
      version: CACHE_VERSION,
      tenants: parsed.tenants && typeof parsed.tenants === "object" ? parsed.tenants : {},
    };
  } catch {
    return emptyCache();
  }
}

function writeCache(c: CompletionCache): void {
  const dest = cachePath();
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `completion-cache.json.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(c), "utf8"); // compact — internal artifact, not user-facing
  renameSync(tmp, dest);
}

/** Read-modify-write the current tenant's cache slice atomically. */
function updateCurrentTenant(mutate: (t: TenantCache) => void): void {
  const key = currentTenantKey();
  const c = readCache();
  const t = tenantOf(c, key);
  mutate(t);
  c.tenants[key] = t;
  writeCache(c);
}

// ---------------------------------------------------------------------------
// Public API (tenant-scoped to the current invocation)
// ---------------------------------------------------------------------------

/** Replace one resource slice and stamp it with the current time. */
export function writeSlice(kind: IndexKind, entries: Entry[]): void {
  updateCurrentTenant((t) => {
    t.resources[kind] = { ts: Date.now(), entries };
  });
}

/** Replace several resource slices at once (used by warm / background refresh). */
export function writeAllSlices(slices: Partial<Record<IndexKind, Entry[]>>): void {
  const now = Date.now();
  updateCurrentTenant((t) => {
    for (const k of INDEX_KINDS) {
      const entries = slices[k];
      if (entries !== undefined) t.resources[k] = { ts: now, entries };
    }
  });
}

/** Replace one app's env-key slice. */
export function writeEnvKeys(appId: string, keys: string[]): void {
  updateCurrentTenant((t) => {
    t.envKeys[appId] = { ts: Date.now(), keys };
  });
}

/** Candidate entries for a resource kind (offline, never throws). */
export function getSlice(kind: IndexKind): Entry[] {
  return tenantOf(readCache(), currentTenantKey()).resources[kind]?.entries ?? [];
}

/** Cached env-var keys for an app ([] if never listed). */
export function getEnvKeys(appId: string): string[] {
  return tenantOf(readCache(), currentTenantKey()).envKeys[appId]?.keys ?? [];
}

/** Age in ms of a resource slice; Infinity if never populated. */
export function sliceAge(kind: IndexKind): number {
  const ts = tenantOf(readCache(), currentTenantKey()).resources[kind]?.ts ?? 0;
  return ts === 0 ? Infinity : Date.now() - ts;
}

/** Drop a tenant's entire cache slice (used on identity change — login /
 *  org use — so the next completion re-warms fresh data for that account).
 *  No-op when the tenant has no cached data. */
export function clearTenant(tenantId: string): void {
  const c = readCache();
  if (c.tenants[tenantId]) {
    delete c.tenants[tenantId];
    writeCache(c);
  }
}
