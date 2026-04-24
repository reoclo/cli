// src/commands/login.ts
import type { Command } from "commander";
import { saveProfile } from "../config/store";
import { resolveStore } from "../config/token-store";

function detectType(token: string): "tenant" | "automation" {
  if (token.startsWith("rk_a_")) return "automation";
  return "tenant";
}

// TODO(Task 3.7): Replace plain readline with hidden-input prompt (termios raw mode)
// once login starts validating the token via GET /auth/me. Echoing is acceptable
// for the Phase 2 stub because v1 doesn't require an interactive secure prompt
// — the primary auth path is `--token` from env.
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
      const token = opts.token ?? (await promptToken("Paste API key: "));

      // TODO(Task 3.7): Validate `token` via GET /auth/me and fill tenant_id/slug/email from the response.
      const profile = {
        api_url: opts.api,
        token_type: detectType(token),
        tenant_id: "pending-phase3",
        tenant_slug: "pending-phase3",
        user_email: "pending-phase3",
        saved_at: new Date().toISOString(),
      };
      await saveProfile(opts.profile, profile);

      const store = await resolveStore({
        requireKeyring: opts.keyring === true,
        forbidKeyring: opts.keyring === false,
      });
      await store.set(opts.profile, token);
      console.log(`✓ saved to ${store.kind} — profile '${opts.profile}'`);
    });
}
