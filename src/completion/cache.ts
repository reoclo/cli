// src/completion/cache.ts
//
// Read/write the local completion cache (`completion-cache.json`, version 5).
// The cache is PARTITIONED BY <profile>/<org slug> so completions only ever
// reflect the org an invocation explicitly targets (`--org`, $REOCLO_ORG, or a
// `.reoclo` binding). There is no fallback to a profile's login org: with no
// org stamped, reads and writes land in the no-org bucket, which never holds
// any real org's data. The profile is part of the key so the same slug on two
// backends (staging vs production) never shares entries. Every read is
// defensive: a missing, corrupt, or wrong-version file is treated as empty.
// Writes are atomic (temp file + rename) so concurrent writers (background
// refresh, list commands, `warm`) never tear the file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { cacheDir } from "../config/paths";
import { INDEX_KINDS, type Entry, type IndexKind } from "./types";

const CACHE_VERSION = 5;

// Bucket key for invocations with no org (unbound directory, or an env
// credential before /auth/me named its org). Keeps reads/writes total.
const NO_ORG = "_";

interface ResourceSlice {
  ts: number;
  entries: Entry[];
}
interface EnvKeySlice {
  ts: number;
  keys: string[];
}
interface OrgCache {
  resources: Record<IndexKind, ResourceSlice>;
  envKeys: Record<string, EnvKeySlice>;
}
interface CompletionCache {
  version: number;
  orgs: Record<string, OrgCache>;
}

// ---------------------------------------------------------------------------
// Current-org resolution
// ---------------------------------------------------------------------------

let _activeKey: string | undefined;

/** The bucket key for a profile + org slug pair; undefined when there is no
 *  org (the caller then lands in the no-org bucket). */
export function orgCacheKey(
  profileName: string | undefined,
  slug: string | undefined,
): string | undefined {
  if (!slug) return undefined;
  return `${profileName ?? NO_ORG}/${slug}`;
}

/**
 * Stamp the org the completion cache should read/write for this process.
 * Called by bootstrap() (command processes, from the resolved --org /
 * $REOCLO_ORG / .reoclo override), by the tenant-id resolver for env
 * credentials (from /auth/me), and by the completion engine (the __complete process,
 * from the typed line and the working directory). Pass an undefined slug to
 * select the no-org bucket.
 */
export function setActiveOrg(profileName: string | undefined, slug: string | undefined): void {
  _activeKey = orgCacheKey(profileName, slug);
}

function currentOrgKey(): string {
  return _activeKey ?? NO_ORG;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function emptyOrg(): OrgCache {
  const resources = {} as Record<IndexKind, ResourceSlice>;
  for (const k of INDEX_KINDS) resources[k] = { ts: 0, entries: [] };
  return { resources, envKeys: {} };
}

function emptyCache(): CompletionCache {
  return { version: CACHE_VERSION, orgs: {} };
}

/** Read one org's cache, backfilling any missing resource slice so callers
 *  never hit `undefined`. Returns a fresh empty org when absent. */
function orgOf(c: CompletionCache, key: string): OrgCache {
  const raw = c.orgs[key];
  const base = emptyOrg();
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
    // A different version (the pre-partition v3 shape, the tenant-id keyed
    // v4 shape) is discarded.
    if (parsed.version !== CACHE_VERSION) return emptyCache();
    return {
      version: CACHE_VERSION,
      orgs: parsed.orgs && typeof parsed.orgs === "object" ? parsed.orgs : {},
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

/** Read-modify-write the current org's cache slice atomically. */
function updateCurrentOrg(mutate: (t: OrgCache) => void): void {
  const key = currentOrgKey();
  const c = readCache();
  const t = orgOf(c, key);
  mutate(t);
  c.orgs[key] = t;
  writeCache(c);
}

// ---------------------------------------------------------------------------
// Public API (org-scoped to the current invocation)
// ---------------------------------------------------------------------------

/** Replace one resource slice and stamp it with the current time. */
export function writeSlice(kind: IndexKind, entries: Entry[]): void {
  updateCurrentOrg((t) => {
    t.resources[kind] = { ts: Date.now(), entries };
  });
}

/** Replace several resource slices at once (used by warm / background refresh). */
export function writeAllSlices(slices: Partial<Record<IndexKind, Entry[]>>): void {
  const now = Date.now();
  updateCurrentOrg((t) => {
    for (const k of INDEX_KINDS) {
      const entries = slices[k];
      if (entries !== undefined) t.resources[k] = { ts: now, entries };
    }
  });
}

/** Replace one app's env-key slice. */
export function writeEnvKeys(appId: string, keys: string[]): void {
  updateCurrentOrg((t) => {
    t.envKeys[appId] = { ts: Date.now(), keys };
  });
}

/** Candidate entries for a resource kind (offline, never throws). */
export function getSlice(kind: IndexKind): Entry[] {
  return orgOf(readCache(), currentOrgKey()).resources[kind]?.entries ?? [];
}

/** Cached env-var keys for an app ([] if never listed). */
export function getEnvKeys(appId: string): string[] {
  return orgOf(readCache(), currentOrgKey()).envKeys[appId]?.keys ?? [];
}

/** Age in ms of a resource slice; Infinity if never populated. */
export function sliceAge(kind: IndexKind): number {
  const ts = orgOf(readCache(), currentOrgKey()).resources[kind]?.ts ?? 0;
  return ts === 0 ? Infinity : Date.now() - ts;
}

/** Drop one org's entire cache slice for a profile. No-op when nothing is
 *  cached under it. */
export function clearOrg(profileName: string | undefined, slug: string): void {
  const key = orgCacheKey(profileName, slug);
  if (!key) return;
  const c = readCache();
  if (c.orgs[key]) {
    delete c.orgs[key];
    writeCache(c);
  }
}

/** Drop every org bucket that belongs to a profile (used on identity change,
 *  i.e. `reoclo login`, so the next completion re-warms fresh data for the
 *  account just signed in). No-op when the profile has no cached data. */
export function clearProfile(profileName: string): void {
  const c = readCache();
  const prefix = `${profileName}/`;
  const doomed = Object.keys(c.orgs).filter((k) => k.startsWith(prefix));
  if (doomed.length === 0) return;
  for (const k of doomed) delete c.orgs[k];
  writeCache(c);
}
