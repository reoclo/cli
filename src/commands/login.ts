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
  if (!process.stdin.isTTY) {
    const e = new Error(
      "no API key provided and stdin is not a TTY — pass --token or set REOCLO_API_KEY",
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
  // Pass the prompt string into rl.question directly. Splitting it across
  // process.stdout.write + rl.question("") doesn't render reliably in
  // bun-compiled binaries — the buffered write gets swallowed when readline
  // takes over the TTY.
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(msg, (answer) => {
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
      const token = opts.token ?? (await promptToken("Paste API key: "));

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

      if (store.kind === "keyring") {
        await saveProfile(opts.profile, { ...profile, token_ref: `keyring:reoclo-${opts.profile}` });
      }

      console.log(`✓ saved to ${store.kind} — authenticated as ${me.email} (tenant: ${me.tenant_slug})`);
    });
}
