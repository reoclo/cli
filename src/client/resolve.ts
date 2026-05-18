// src/client/resolve.ts
import type { HttpClient } from "./http";
import type { Application, PaginatedResponse, Server } from "./types";
import { getSlice } from "../completion/cache";
import { cacheList } from "../completion/populate";
import type { Entry, IndexKind } from "../completion/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lookup(entries: Entry[], identifier: string): string | undefined {
  const bySlug = entries.find((e) => e.value === identifier);
  if (bySlug) return bySlug.id;
  const byName = entries.find((e) => e.name === identifier);
  return byName?.id;
}

async function resolve(
  kind: IndexKind,
  identifier: string,
  fetchRaw: () => Promise<readonly unknown[]>,
  label: string,
): Promise<string> {
  if (UUID.test(identifier)) return identifier;

  const cached = lookup(getSlice(kind), identifier);
  if (cached) return cached;

  const raw = await fetchRaw();
  const entries = cacheList(kind, raw);

  const found = lookup(entries, identifier);
  if (!found) {
    const e = new Error(`${label} '${identifier}' not found`) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found;
}

export async function resolveServer(
  c: HttpClient,
  tenantId: string,
  identifier: string,
): Promise<string> {
  return resolve(
    "servers",
    identifier,
    () => c.get<Server[]>(`/tenants/${tenantId}/servers/`),
    "server",
  );
}

export async function resolveApp(
  c: HttpClient,
  tenantId: string,
  identifier: string,
): Promise<string> {
  return resolve(
    "apps",
    identifier,
    async () => {
      const res = await c.get<PaginatedResponse<Application>>(
        `/tenants/${tenantId}/applications/?limit=200`,
      );
      return res.items;
    },
    "application",
  );
}
