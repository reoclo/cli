// src/client/resolve.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheDir } from "../config/paths";
import type { HttpClient } from "./http";
import type { Application, PaginatedResponse, Server } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 10 * 60 * 1000;
const CACHE_VERSION = 2;

interface CacheEntry {
  id: string;
  slug: string;
  name: string | null;
  ts: number;
}
interface CacheFile {
  version: number;
  servers: Record<string, CacheEntry>;     // keyed by SLUG
  apps: Record<string, CacheEntry>;        // keyed by SLUG
}

function cachePath(): string {
  return join(cacheDir(), "slug-cache.json");
}

function read(): CacheFile {
  const p = cachePath();
  if (!existsSync(p)) return { version: CACHE_VERSION, servers: {}, apps: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CacheFile;
    if (parsed.version !== CACHE_VERSION) {
      // Old shape — discard, will refresh on next list call.
      return { version: CACHE_VERSION, servers: {}, apps: {} };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, servers: {}, apps: {} };
  }
}

function write(c: CacheFile): void {
  mkdirSync(dirname(cachePath()), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(c));
}

function findInCache(
  bucket: Record<string, CacheEntry>,
  identifier: string,
): CacheEntry | undefined {
  // Direct hit on slug key.
  const direct = bucket[identifier];
  if (direct && Date.now() - direct.ts < TTL_MS) return direct;
  // Name fallback (case-insensitive exact match against entry.name).
  for (const entry of Object.values(bucket)) {
    if (entry.name === identifier && Date.now() - entry.ts < TTL_MS) {
      return entry;
    }
  }
  return undefined;
}

export async function resolveServer(
  c: HttpClient,
  tenantId: string,
  identifier: string,
): Promise<string> {
  if (UUID.test(identifier)) return identifier;

  const cache = read();
  const cached = findInCache(cache.servers, identifier);
  if (cached) return cached.id;

  // Fresh fetch.
  const list = await c.get<Server[]>(`/tenants/${tenantId}/servers/`);
  cache.servers = {};
  for (const s of list) {
    cache.servers[s.slug] = {
      id: s.id,
      slug: s.slug,
      name: s.name,
      ts: Date.now(),
    };
  }
  write(cache);

  const found = findInCache(cache.servers, identifier);
  if (!found) {
    const e = new Error(`server '${identifier}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found.id;
}

export async function resolveApp(
  c: HttpClient,
  tenantId: string,
  identifier: string,
): Promise<string> {
  if (UUID.test(identifier)) return identifier;

  const cache = read();
  const cached = findInCache(cache.apps, identifier);
  if (cached) return cached.id;

  const res = await c.get<PaginatedResponse<Application>>(
    `/tenants/${tenantId}/applications/?limit=200`,
  );
  cache.apps = {};
  for (const a of res.items) {
    cache.apps[a.slug] = {
      id: a.id,
      slug: a.slug,
      name: a.name,
      ts: Date.now(),
    };
  }
  write(cache);

  const found = findInCache(cache.apps, identifier);
  if (!found) {
    const e = new Error(`application '${identifier}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found.id;
}
