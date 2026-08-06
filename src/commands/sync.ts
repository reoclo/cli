// src/commands/sync.ts
//
// `reoclo sync` refreshes the active profile's cached capability list from the
// server, WITHOUT a `logout`/`login` round-trip. The CLI gates its command
// surface on a per-profile capability cache (see src/client/command-meta.ts);
// that cache is only written on login and on a 403 self-heal, so a role change
// (or a cache that was written while the account was mis-provisioned) leaves the
// CLI denying commands the user now holds. This command re-fetches and rewrites
// it on demand. See REO-167.
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import type { HttpClient } from "../client/http";
import { fetchCapabilities } from "../client/capabilities";
import { updateProfileCapabilities } from "../config/store";

/** Human-readable result line. Pure so it can be asserted without a client. */
export function formatSyncLine(profile: string, count: number): string {
  const noun = count === 1 ? "capability" : "capabilities";
  return `Synced ${count} ${noun} for profile '${profile}'.`;
}

/** Fetch the caller's effective capabilities and rewrite the profile cache,
 *  returning the refreshed verb count. `deps` is injectable so the flow is
 *  unit-testable without a live client or disk I/O. */
export async function syncProfileCapabilities(
  client: HttpClient,
  profileName: string,
  deps: {
    fetch?: (c: HttpClient) => Promise<string[]>;
    persist?: (profile: string, caps: string[]) => Promise<void>;
  } = {},
): Promise<number> {
  const fetchFn = deps.fetch ?? fetchCapabilities;
  const persistFn = deps.persist ?? updateProfileCapabilities;
  const caps = await fetchFn(client);
  await persistFn(profileName, caps);
  return caps.length;
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("refresh this profile's cached capabilities from the server (no re-login)")
    .action(async () => {
      // orgRequired:false — this is an account-level refresh, like `whoami`; it
      // must run even when the cached capabilities are empty or malformed (that
      // is the very state it exists to repair), so it carries no capability gate.
      const ctx = await bootstrap({ orgRequired: false });
      const count = await syncProfileCapabilities(ctx.client, ctx.profileName);
      console.log(formatSyncLine(ctx.profileName, count));
    });
}
