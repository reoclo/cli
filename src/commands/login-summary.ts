// src/commands/login-summary.ts
//
// Pure, network-free helpers for `reoclo login`'s post-auth behavior:
//  - shouldSetActiveProfile: whether to point the GLOBAL active profile at the
//    profile we just authenticated (Option A — scoped logins don't mutate it).
//  - formatLoginSummary: the multi-line success block printed after login.
// Kept out of login.ts so they unit-test without the OAuth device flow, the
// keyring, or the network.
import type { ProfileSource } from "../config/profile-resolve";
import { formatRole } from "../ui/format-role";

/**
 * Option A: `login` sets the just-authenticated profile as the GLOBAL active
 * profile only when (a) it is the first profile on the machine, or (b) the
 * login was not scoped by --profile/$REOCLO_PROFILE (a bare `reoclo login`,
 * which always targets "default"). A scoped login with profiles already
 * present leaves the global active profile untouched.
 */
export function shouldSetActiveProfile(opts: {
  hadNoProfiles: boolean;
  source: ProfileSource;
}): boolean {
  return opts.hadNoProfiles || opts.source === "default";
}

export interface LoginSummaryInput {
  email: string;
  org: string; // me.tenant_slug
  roles: string[]; // me.roles
  profile: string; // resolved profile name
  source: ProfileSource;
  storeKind: "keyring" | "file" | "memory";
  setActive: boolean; // result of shouldSetActiveProfile()
}

/** Compose the multi-line `reoclo login` success block. */
export function formatLoginSummary(i: LoginSummaryInput): string {
  const lines: string[] = [];
  lines.push(`✓ authenticated as ${i.email}`);
  lines.push(`  organization: ${i.org}`);
  if (i.roles.length > 0) {
    lines.push(`  role:         ${i.roles.map(formatRole).join(", ")}`);
  }
  const sourceTag =
    i.source === "env"
      ? "  (from $REOCLO_PROFILE)"
      : i.source === "flag"
        ? "  (from --profile)"
        : "";
  lines.push(`  profile:      ${i.profile}${sourceTag}`);
  lines.push(`  credentials:  ${i.storeKind}`);
  if (!i.setActive) {
    const why =
      i.source === "env"
        ? "it's used automatically while $REOCLO_PROFILE is set"
        : "it was selected with --profile for this login only";
    lines.push(`  note: '${i.profile}' isn't your active profile — ${why};`);
    lines.push(`        run 'reoclo profile use ${i.profile}' to make it the default.`);
  }
  return lines.join("\n");
}
