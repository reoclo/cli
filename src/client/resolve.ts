// src/client/resolve.ts
import type { HttpClient } from "./http";
import type { Application, PaginatedResponse, Server } from "./types";
import { getSlice, writeSlice } from "../completion/cache";
import { RESOURCE_REGISTRY } from "../completion/registry";
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
  fetchRaw: () => Promise<Record<string, unknown>[]>,
  label: string,
): Promise<string> {
  if (UUID.test(identifier)) return identifier;

  const cached = lookup(getSlice(kind), identifier);
  if (cached) return cached;

  const raw = await fetchRaw();
  const entries = raw.map((o) => RESOURCE_REGISTRY[kind].toEntry(o));
  writeSlice(kind, entries);

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
    async () => {
      const list = await c.get<Server[]>(`/tenants/${tenantId}/servers/`);
      return list as unknown as Record<string, unknown>[];
    },
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
      return res.items as unknown as Record<string, unknown>[];
    },
    "application",
  );
}
