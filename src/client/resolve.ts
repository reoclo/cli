// src/client/resolve.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheDir } from "../config/paths";
import type { HttpClient } from "./http";
import type { Application, PaginatedResponse, Server } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  id: string;
  ts: number;
}
interface CacheFile {
  version: 1;
  servers: Record<string, CacheEntry>;
  apps: Record<string, CacheEntry>;
}

function cachePath(): string {
  return join(cacheDir(), "slug-cache.json");
}

function read(): CacheFile {
  const p = cachePath();
  if (!existsSync(p)) return { version: 1, servers: {}, apps: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CacheFile;
  } catch {
    return { version: 1, servers: {}, apps: {} };
  }
}

function write(c: CacheFile): void {
  mkdirSync(dirname(cachePath()), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(c));
}

export async function resolveServer(c: HttpClient, tenantId: string, idOrName: string): Promise<string> {
  if (UUID.test(idOrName)) return idOrName;
  const cache = read();
  const hit = cache.servers[idOrName];
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.id;
  const list = await c.get<Server[]>(`/tenants/${tenantId}/servers/`);
  cache.servers = {};
  for (const s of list) cache.servers[s.name] = { id: s.id, ts: Date.now() };
  write(cache);
  const found = cache.servers[idOrName];
  if (!found) {
    const e = new Error(`server '${idOrName}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found.id;
}

export async function resolveApp(c: HttpClient, tenantId: string, idOrSlug: string): Promise<string> {
  if (UUID.test(idOrSlug)) return idOrSlug;
  const cache = read();
  const hit = cache.apps[idOrSlug];
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.id;
  // Apps list is paginated. limit=200 is the API's max per page; for v1 we
  // assume a tenant has fewer than 200 apps. If that ever stops being true
  // we'll page through here.
  const res = await c.get<PaginatedResponse<Application>>(
    `/tenants/${tenantId}/applications/?limit=200`,
  );
  cache.apps = {};
  for (const a of res.items) cache.apps[a.slug] = { id: a.id, ts: Date.now() };
  write(cache);
  const found = cache.apps[idOrSlug];
  if (!found) {
    const e = new Error(`application '${idOrSlug}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found.id;
}
