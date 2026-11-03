// src/client/submodules.ts
//
// Writing the `submodules` mode (REO-576). Apps and stacks take it through
// their plain update endpoint (PATCH /applications/{id}, PATCH
// /application-groups/{id}), separate from the build/deploy config slice.

import type { ApiClient } from "./api-client";
import { EXIT } from "./exit-codes";
import { exitError } from "./repo-deploy";
import type { SubmoduleMode } from "../util/submodules";

export function applicationPath(tid: string, appId: string): string {
  return `/tenants/${tid}/applications/${appId}`;
}

export function groupPath(tid: string, groupId: string): string {
  return `/tenants/${tid}/application-groups/${groupId}`;
}

export function setSubmodules(
  client: ApiClient,
  path: string,
  mode: SubmoduleMode,
): Promise<Record<string, unknown>> {
  return client.patch<Record<string, unknown>>(path, { submodules: mode });
}

/** The create flows set the mode right after the create call. A new app or stack
 *  starts at `off`, so that mode needs no request. When the PATCH fails the
 *  resource still exists; say so and how to finish the job. */
export async function setSubmodulesAfterCreate(
  client: ApiClient,
  path: string,
  mode: SubmoduleMode,
  created: string,
  retry: string,
): Promise<void> {
  if (mode === "off") return;
  try {
    await setSubmodules(client, path, mode);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw exitError(
      `${created} was created, but --submodules ${mode} was not applied: ${reason}. Retry with: ${retry}`,
      EXIT.GENERIC,
    );
  }
}
