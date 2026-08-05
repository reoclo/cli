// src/secrets/resolvers.ts
//
// Machine (automation-key) resolver for op:// refs. Turns a batch of parsed
// refs into a ResolvedSecrets map by talking to the automation endpoints
// under `../client/secrets`.

import type { HttpClient } from "../client/http";
import {
  accessibleProjects,
  listProjects,
  listSecrets,
  openSession,
  resolve,
  revealSecret,
} from "../client/secrets";
import { ResolutionError, type OpRef, type ResolvedSecrets } from "./template";

export type BatchResolver = (refs: OpRef[]) => Promise<ResolvedSecrets>;

/** Resolve op:// refs with an automation key: one audit session over exactly the
 *  referenced projects, then a per-project resolve so keys can't collide. */
export function machineResolver(
  client: HttpClient,
  meta: { commit_sha?: string; workflow_run_id?: string },
): BatchResolver {
  return async (refs) => {
    const map: ResolvedSecrets = new Map();
    const wanted = [...new Set(refs.map((r) => r.vault))];
    if (wanted.length === 0) return map;

    const accessible = await accessibleProjects(client);
    const ids = wanted.map((name) => {
      const id = accessible.find((p) => p.name === name || p.id === name)?.id;
      if (!id) {
        throw new ResolutionError(
          `project '${name}' is not accessible to this key or does not exist`,
        );
      }
      return id;
    });

    const session = await openSession(client, ids, meta);
    const sessionClient = client.withToken(session.session_token);
    for (let i = 0; i < wanted.length; i++) {
      const { values } = await resolve(sessionClient, [ids[i]!]);
      map.set(wanted[i]!, values);
    }
    return map;
  };
}

/** Resolve op:// refs with an OAuth token: list projects, then reveal exactly
 *  the referenced keys per project. */
export function humanResolver(client: HttpClient, tenantId: string): BatchResolver {
  return async (refs) => {
    const map: ResolvedSecrets = new Map();
    if (refs.length === 0) return map;

    const projects = await listProjects(client, tenantId);
    const neededByVault = new Map<string, Set<string>>();
    for (const r of refs) {
      const keys = neededByVault.get(r.vault) ?? new Set<string>();
      keys.add(r.field);
      neededByVault.set(r.vault, keys);
    }

    for (const [vault, keys] of neededByVault) {
      const matches = projects.filter((p) => p.id === vault || p.name === vault);
      const project = matches.length === 1 ? matches[0] : undefined;
      if (!project) {
        throw new ResolutionError(
          `project '${vault}' is not accessible to this account or does not exist`,
        );
      }
      const secrets = await listSecrets(client, tenantId, project.id);
      const values: Record<string, string> = {};
      for (const key of keys) {
        const secret = secrets.find((s) => s.key === key);
        if (!secret) continue; // absent -> lookup() throws ResolutionError naming the op path
        values[key] = (await revealSecret(client, tenantId, secret.id)).value;
      }
      map.set(vault, values);
    }
    return map;
  };
}
