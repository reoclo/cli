// src/client/status-pages.ts
//
// Status page fetch + identifier resolution, shared by the `status-pages` and
// `status-pages components` command modules. It lives here rather than in
// either command module so the two do not have to import each other.

import type { HttpClient } from "./http";
import { cacheList } from "../completion/populate";

export interface StatusPage {
  id: string;
  title: string;
  slug: string;
  is_published: boolean;
  domain_id: string | null;
  custom_hostname: string | null;
}

/** Collection routes take a trailing slash, item routes do not. This returns the stem. */
export function statusPagesPath(tenantId: string): string {
  return `/tenants/${tenantId}/status-pages`;
}

export async function listStatusPages(
  client: HttpClient,
  tenantId: string,
): Promise<StatusPage[]> {
  const list = await client.get<StatusPage[]>(`${statusPagesPath(tenantId)}/`);
  cacheList("status-pages", list);
  return list;
}

/**
 * Resolve a status page by id, slug, or exact title (case-insensitive). Titles
 * are not unique, so an ambiguous title is an error rather than a coin flip.
 * Exits 5 when nothing matches, 2 when the title is ambiguous.
 */
export async function resolveStatusPage(
  client: HttpClient,
  tenantId: string,
  idOrSlugOrTitle: string,
): Promise<StatusPage> {
  const list = await listStatusPages(client, tenantId);
  const needle = idOrSlugOrTitle.trim().toLowerCase();

  const exact = list.find((p) => p.id === idOrSlugOrTitle) ?? list.find((p) => p.slug === needle);
  if (exact) return exact;

  const byTitle = list.filter((p) => p.title.trim().toLowerCase() === needle);
  if (byTitle.length === 1) return byTitle[0] as StatusPage;
  if (byTitle.length > 1) {
    const e = new Error(
      `'${idOrSlugOrTitle}' matches ${byTitle.length} status pages. Use the id or slug instead ` +
        `(${byTitle.map((p) => p.slug).join(", ")})`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }

  let message = `status page '${idOrSlugOrTitle}' not found`;
  if (list.length > 0) {
    const shown = list.slice(0, 10).map((p) => p.slug);
    message += `. available: ${shown.join(", ")}`;
    if (list.length > shown.length) message += ` (+${list.length - shown.length} more)`;
  }
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = 5;
  throw e;
}
