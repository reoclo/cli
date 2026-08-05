// src/secrets/resolvers.ts
//
// Machine (automation-key) resolver for op:// refs. Turns a batch of parsed
// refs into a ResolvedSecrets map by talking to the automation endpoints
// under `../client/secrets`.

import type { HttpClient } from "../client/http";
import { accessibleProjects, openSession, resolve } from "../client/secrets";
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
