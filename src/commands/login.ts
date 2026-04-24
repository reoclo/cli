// src/commands/login.ts
import type { Command } from "commander";
import { saveProfile } from "../config/store";
import { resolveStore } from "../config/token-store";
import { HttpClient } from "../client/http";
import { detectKeyType } from "../client/routing";
import type { Me } from "../client/types";

// TODO(future): replace plain readline with hidden-input prompt (termios raw mode).
// Echoing is acceptable today since the primary auth path is `--token` from env.
async function promptToken(msg: string): Promise<string> {
  process.stdout.write(msg);
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("authenticate and store an API key")
    .option("--token <key>", "API key (otherwise prompt)")
    .option("--profile <name>", "profile name", "default")
    .option("--api <url>", "API base URL", "https://api.reoclo.com")
    .option("--keyring", "require OS keyring storage")
    .option("--no-keyring", "force file storage")
    .action(async (opts: { token?: string; profile: string; api: string; keyring?: boolean }) => {
      try {
        const token = opts.token ?? (await promptToken("Paste API key: "));

        // Validate by hitting /auth/me — throws AuthError on 401, NetworkError on connect failure.
        const probe = new HttpClient({ baseUrl: opts.api, token });
        const me = await probe.get<Me>("/auth/me");

        const profile = {
          api_url: opts.api,
          token_type: detectKeyType(token),
          tenant_id: me.tenant_id,
          tenant_slug: me.tenant_slug,
          user_email: me.email,
          saved_at: new Date().toISOString(),
        };
        await saveProfile(opts.profile, profile);

        const store = await resolveStore({
          requireKeyring: opts.keyring === true,
          forbidKeyring: opts.keyring === false,
        });
        await store.set(opts.profile, token);

        // If we used the keyring, stamp `token_ref` on the profile so reads can find it.
        if (store.kind === "keyring") {
          await saveProfile(opts.profile, { ...profile, token_ref: `keyring:reoclo-${opts.profile}` });
        }

        console.log(`✓ saved to ${store.kind} — authenticated as ${me.email} (tenant: ${me.tenant_slug})`);
      } catch (e) {
        const err = e as { message?: string; hint?: string; exitCode?: number };
        process.stderr.write(`Error: ${err.message ?? String(e)}\n`);
        if (err.hint) process.stderr.write(`  ${err.hint}\n`);
        process.exit(err.exitCode ?? 1);
      }
    });
}
