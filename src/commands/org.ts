// src/commands/org.ts
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import type { Me } from "../client/types";
import { getActiveProfile, loadConfig, saveProfile } from "../config/store";
import { resolveStore } from "../config/token-store";
import { globalOutput, printList, resolveFormat } from "../ui/output";

/**
 * `reoclo org` — manage the active organization within the OAuth-granted set.
 *
 * The CLI is single-org-per-token by design: every request carries a JWT
 * with one `tenant_id`. OAuth consent records WHICH orgs the user authorized
 * for this client in `granted_tenants`, but only one is "active" at a time.
 *
 * `org use <slug>` calls the `tenant_switch` OAuth grant to mint a fresh
 * access token bound to a different org. The server enforces the granted
 * set — switching to an org outside the OAuth consent returns 403
 * `tenant_not_granted`. We also do a friendly client-side check first by
 * looking up the target slug in `/auth/me`'s memberships (which since 1.40.0
 * are intersected by `granted_tenants` for OAuth tokens, so the list shown
 * IS the granted set).
 */
export function registerOrg(program: Command): void {
  const g = program
    .command("org")
    .description("switch the active organization within the OAuth-granted set");

  g.command("ls")
    .description("list organizations available to the current credential")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const me = await ctx.client.get<Me>("/auth/me");
      const memberships = me.memberships ?? [];
      const rows = memberships.map((m) => ({
        active: m.tenant_id === me.tenant_id ? "*" : "",
        slug: m.tenant_slug,
        name: m.tenant_name,
        role: m.role,
      }));
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "active", label: " " },
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "role", label: "ROLE" },
        ],
        fmt,
      );
    });

  g.command("current")
    .description("print the active organization slug")
    .action(async () => {
      const profile = await getActiveProfile();
      if (!profile) {
        process.stderr.write("not authenticated — run 'reoclo login'\n");
        process.exit(3);
      }
      process.stdout.write(`${profile.tenant_slug}\n`);
    });

  g.command("use <slug>")
    .description("switch the active organization (must be in the OAuth grant)")
    .action(async (slug: string) => {
      const ctx = await bootstrap();
      const profile = await getActiveProfile();
      if (!profile) {
        process.stderr.write("not authenticated — run 'reoclo login'\n");
        process.exit(3);
      }
      if (profile.auth_kind !== "oauth") {
        process.stderr.write(
          "'org use' requires an OAuth-issued credential — this profile uses an API key.\n" +
            "Run 'reoclo login' to switch to the OAuth device-flow.\n",
        );
        process.exit(4);
      }
      // Hit /auth/me through the bootstrapped client first so the
      // access token gets transparently refreshed if it's stale. The
      // refreshed token is written back to the store before we read it
      // for the tenant_switch call below.
      const me = await ctx.client.get<Me>("/auth/me");
      const memberships = me.memberships ?? [];
      const target = memberships.find((m) => m.tenant_slug === slug);
      if (!target) {
        const granted = memberships.map((m) => m.tenant_slug).join(", ") || "(none)";
        process.stderr.write(
          `'${slug}' is not in your granted organizations.\nGranted: ${granted}\n` +
            "Re-run 'reoclo login' to expand the consent.\n",
        );
        process.exit(5);
      }
      if (target.tenant_id === me.tenant_id) {
        process.stdout.write(`already on '${slug}'\n`);
        return;
      }

      const store = await resolveStore({});
      const cfg = await loadConfig();
      const currentToken = await store.get(cfg.active_profile);
      if (!currentToken) {
        process.stderr.write(
          "access token not found in keychain — re-run 'reoclo login'\n",
        );
        process.exit(3);
      }

      const authUrl = profile.oauth_auth_url ?? "https://auth.reoclo.com";
      const body = new URLSearchParams({
        grant_type: "tenant_switch",
        client_id: profile.oauth_client_id ?? "reoclo-cli",
        current_access_token: currentToken,
        tenant_id: target.tenant_id,
      });
      const res = await fetch(`${authUrl.replace(/\/$/, "")}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        let detail = text;
        try {
          const parsed = JSON.parse(text) as {
            detail?: { error?: string; error_description?: string };
          };
          detail = parsed.detail?.error_description ?? parsed.detail?.error ?? text;
        } catch {
          // non-JSON body — surface as-is
        }
        process.stderr.write(`tenant_switch failed: ${res.status} — ${detail}\n`);
        process.exit(1);
      }
      const data = (await res.json()) as { access_token: string };
      // Persist the new token + bumped tenant context. We don't rotate the
      // refresh token here (the tenant_switch grant doesn't issue one) — the
      // original refresh-token row in the keyring keeps working for the next
      // 401-driven refresh, which will mint a token bound to the new
      // tenant_id via _issue_tokens' granted_tenant_ids[0] path.
      await store.set(cfg.active_profile, data.access_token);
      const updated = {
        ...profile,
        tenant_id: target.tenant_id,
        tenant_slug: target.tenant_slug,
        saved_at: new Date().toISOString(),
      };
      await saveProfile(cfg.active_profile, updated);
      process.stdout.write(
        `✓ switched to ${slug} (${target.tenant_name})\n`,
      );
    });
}
