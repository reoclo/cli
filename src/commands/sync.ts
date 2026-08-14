// src/commands/sync.ts
//
// `reoclo sync` refreshes the active profile's cached capability list from the
// server, WITHOUT a `logout`/`login` round-trip. The CLI gates its command
// surface on a per-profile capability cache (see src/client/command-meta.ts);
// that cache is only written on login and on a 403 self-heal, so a role change
// (or a cache that was written while the account was mis-provisioned) leaves the
// CLI denying commands the user now holds. This command re-fetches and rewrites
// it on demand. See REO-167.
//
// Under a machine token (an env credential; automation keys are gated out of
// `sync` by the command allowlist) there is no profile to write, and gating is
// skipped for it (server enforces), so `sync` prints the server-verified
// capabilities instead of persisting anything.
import type { Command } from "commander";
import { bootstrap, isEnvCredential } from "../client/bootstrap";
import type { HttpClient } from "../client/http";
import { fetchCapabilities } from "../client/capabilities";
import { updateProfileCapabilities } from "../config/store";

/** Human-readable result line. Pure so it can be asserted without a client. */
export function formatSyncLine(profile: string, count: number): string {
  const noun = count === 1 ? "capability" : "capabilities";
  return `Synced ${count} ${noun} for profile '${profile}'.`;
}

/** Pure formatter for the env-credential capability report. Server-enforced,
 *  never cached locally — so the wording must not imply a local write. */
export function formatEnvCapabilitiesReport(caps: string[]): string {
  if (caps.length === 0) {
    return "This machine credential has no capabilities (enforced server-side; not cached locally).";
  }
  const noun = caps.length === 1 ? "capability" : "capabilities";
  const header =
    `${caps.length} ${noun} for this machine credential ` +
    "(enforced server-side; not cached locally):";
  const list = [...caps].sort().map((v) => `  ${v}`).join("\n");
  return `${header}\n${list}`;
}

/** Fetch + format the env-credential capability report. No persistence — env
 *  credentials own no profile. `deps.fetch` is injectable for testing. */
export async function reportEnvCapabilities(
  client: HttpClient,
  deps: { fetch?: (c: HttpClient) => Promise<string[]> } = {},
): Promise<string> {
  const fetchFn = deps.fetch ?? fetchCapabilities;
  const caps = await fetchFn(client);
  return formatEnvCapabilitiesReport(caps);
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
      if (isEnvCredential()) {
        // Reached only by a machine token (`rk_m_`): an automation key is gated
        // out of `sync` by the command allowlist. Machine tokens own no profile
        // and are enforced server-side; show the caps, never persist (a profile
        // write here would either no-op or corrupt a human profile in the slot).
        console.log(await reportEnvCapabilities(ctx.client));
        return;
      }
      const count = await syncProfileCapabilities(ctx.client, ctx.profileName);
      console.log(formatSyncLine(ctx.profileName, count));
    });
}
