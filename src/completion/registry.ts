// src/completion/registry.ts
//
// One ResourceDef per index-backed resource kind. The single source of truth
// for: which /completion-index field feeds the kind, and how a raw API object
// becomes an Entry. Reused by the engine, `completion warm`, and the
// opportunistic slice writes in list commands.

import type { Entry, IndexKind } from "./types";

export interface ResourceDef {
  kind: IndexKind;
  /** Key under `resources` in the /completion-index response. */
  indexField: string;
  /** Map a raw API list object to an Entry. */
  toEntry: (raw: Record<string, unknown>) => Entry;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export const RESOURCE_REGISTRY: Record<IndexKind, ResourceDef> = {
  servers: {
    kind: "servers",
    indexField: "servers",
    toEntry: (r) => {
      const id = str(r.id);
      const value = str(r.slug, id);
      const name = str(r.name, value);
      return { id, value, name, desc: `${name} — ${str(r.status)}` };
    },
  },
  apps: {
    kind: "apps",
    indexField: "apps",
    toEntry: (r) => {
      const id = str(r.id);
      const value = str(r.slug, id);
      const name = str(r.name, value);
      return { id, value, name, desc: name };
    },
  },
  deployments: {
    kind: "deployments",
    indexField: "deployments",
    toEntry: (r) => {
      const id = str(r.id);
      return { id, value: id, name: id, desc: str(r.status) };
    },
  },
  domains: {
    kind: "domains",
    indexField: "domains",
    toEntry: (r) => {
      const id = str(r.id);
      const value = str(r.fqdn, id);
      return { id, value, name: value, desc: `${value} — ${str(r.status)}` };
    },
  },
  tunnels: {
    kind: "tunnels",
    indexField: "tunnels",
    toEntry: (r) => {
      const id = str(r.id);
      return { id, value: id, name: id, desc: str(r.mode) };
    },
  },
};
