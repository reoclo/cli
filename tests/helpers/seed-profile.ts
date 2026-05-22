// tests/helpers/seed-profile.ts
//
// Integration-test shim that replaces the v0.32.x `reoclo login --token …`
// bootstrap. Tenant integration keys (`rk_t_*`) and the API-key paste flow
// have been retired; production logins now go through OAuth device flow.
// Tests still need a populated profile pointing at the in-process fake
// gateway, so we write `~/.reoclo/config.json` directly. The on-disk
// shape mirrors what the old `login --token` action used to produce; the
// `rk_t_*` token is treated as a generic bearer by the HttpClient and is
// only meaningful to the fake-gateway authorization check.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SeedOptions {
  configDir: string;
  apiUrl: string;
  token: string;
  tenantId?: string;
  tenantSlug?: string;
  userEmail?: string;
  profileName?: string;
}

/**
 * Write a CLI profile + file-store token under {@link SeedOptions.configDir}
 * so `bootstrap()` picks them up. Mirrors the legacy `reoclo login --token`
 * effect for tests that exercise downstream commands against the fake
 * gateway.
 */
export function seedTenantProfile(opts: SeedOptions): void {
  const {
    configDir,
    apiUrl,
    token,
    tenantId = "00000000-0000-0000-0000-00000000aaaa",
    tenantSlug = "acme",
    userEmail = "test@example.com",
    profileName = "default",
  } = opts;

  mkdirSync(configDir, { recursive: true });

  // FileStore keeps the token inside config.json under the profile entry
  // (src/config/keyring/file.ts). Mirror that on-disk shape directly.
  const now = new Date().toISOString();
  const cfg = {
    active_profile: profileName,
    profiles: {
      [profileName]: {
        api_url: apiUrl,
        token,
        token_type: "tenant",
        tenant_id: tenantId,
        tenant_slug: tenantSlug,
        user_email: userEmail,
        saved_at: now,
        capabilities: [],
        capabilities_fetched_at: now,
      },
    },
  };
  writeFileSync(join(configDir, "config.json"), JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}
