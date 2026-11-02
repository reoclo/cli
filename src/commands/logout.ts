// src/commands/logout.ts
import type { Command } from "commander";
import { loadConfig, deleteProfile, type ProfileRecord } from "../config/store";
import { resolveCommandProfile } from "../config/profile-resolve";
import { keyringStore, refreshTokenKeyCandidates } from "../config/token-store";
import { bootstrap } from "../client/bootstrap";
import { ApiError } from "../client/errors";
import { jwtSid } from "../auth/renew";

export interface LogoutDeps {
  /** End the profile's session on the server. Resolves to null when it ended
   *  (or was already gone), else to the reason it could not be ended. */
  endSession: (profileName: string) => Promise<string | null>;
}

/**
 * End the profile's server session, so its refresh token stops working and the
 * session stops counting against the server's per-client session cap. Uses the
 * profile's own token, refreshed first when it has expired.
 */
export async function endServerSession(profileName: string): Promise<string | null> {
  try {
    const ctx = await bootstrap({ profile: profileName, orgRequired: false, ignoreProjectOrg: true });
    if (ctx.authKind !== "oauth") {
      return "an environment credential is set, so the profile's token was not used";
    }
    const sid = jwtSid(ctx.token);
    if (!sid) return "the stored token carries no session id";
    await ctx.client.del(`/auth/me/sessions/${encodeURIComponent(sid)}`);
    return null;
  } catch (e) {
    // 404: the session no longer exists. 409: it had already ended.
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) return null;
    return e instanceof Error ? e.message : String(e);
  }
}

const DEFAULT_DEPS: LogoutDeps = { endSession: endServerSession };

/**
 * Remove a profile's tokens from where its login put them. The OS keyring is
 * shared by every config directory on the machine, so it is touched only when
 * this profile recorded keyring storage: logging out of a config-file profile
 * that happens to share a name (a test run's temp config, for one) must never
 * delete the real keyring entry.
 */
async function removeStoredTokens(name: string, profile: ProfileRecord): Promise<void> {
  const accessInKeyring = Boolean(profile.token_ref?.startsWith("keyring:"));
  if (!accessInKeyring && !profile.refresh_token_ref) return;
  const store = await keyringStore();
  if (!store) return;
  if (accessInKeyring) await store.delete(name);
  if (profile.refresh_token_ref) {
    for (const key of refreshTokenKeyCandidates(name, profile.refresh_token_ref)) {
      await store.delete(key);
    }
  }
}

export function registerLogout(program: Command, deps: LogoutDeps = DEFAULT_DEPS): void {
  program
    .command("logout")
    // No command-local `--profile` — it is the global (root-level) flag.
    .description("end the session and remove stored credentials (defaults to the active profile)")
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      const cfg = await loadConfig();
      const name = resolveCommandProfile(command, cfg.active_profile);
      const profile = cfg.profiles[name];
      if (!profile) {
        console.log(`no profile '${name}' to log out of`);
        return;
      }
      if (profile.auth_kind === "oauth") {
        const reason = await deps.endSession(name);
        if (reason) {
          process.stderr.write(
            `warning: could not end the session on the server (${reason}); removing local credentials anyway\n`,
          );
        }
      }
      await removeStoredTokens(name, profile);
      await deleteProfile(name);
      console.log(`✓ logged out of '${name}'`);
    });
}
