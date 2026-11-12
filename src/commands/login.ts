// src/commands/login.ts
//
// `reoclo login` is OAuth-only. Tenant integration keys (`rk_t_*`) and the
// generic `REOCLO_API_KEY` env are retired (see .omc/autopilot/spec.md);
// CI/CD continues to use `REOCLO_AUTOMATION_KEY` (`rca_*`) on the bootstrap
// path, which does not go through this command.
import type { Command } from "commander";
import { apiUrl, authUrl, deriveAuthFromApi } from "../lib/urls";
import { resolveCommandProfileWithSource } from "../config/profile-resolve";
import { formatLoginSummary } from "./login-summary";
import { buildProfileWithCapabilities, deviceLogin, type LoginFlowOptions } from "../auth/device-login";
import { openBrowser } from "../ui/open-browser";
import { verboseLogger } from "../client/verbose";
import {
  runAuthUpdateCheck,
  readUpdateCache,
  writeUpdateCache,
  updateCheckEnabledFor,
} from "../client/update-check";
import { detectInstallMethod, resolveLatestVersion } from "./upgrade";
import { VERSION } from "../index";

export { buildProfileWithCapabilities, type LoginFlowOptions };

async function runDeviceFlow(opts: LoginFlowOptions): Promise<void> {
  const { profile: profileName, browser } = opts;

  if (process.stdin.isTTY === false) {
    const e = new Error(
      "OAuth device flow requires an interactive terminal. Run `reoclo login` directly in your shell, or set `REOCLO_AUTOMATION_KEY` for CI.",
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }

  const isTTY = process.stdout.isTTY;
  let dotCount = 0;
  const { me, storeKind, setActive } = await deviceLogin(opts, {
    onCode(init, uri) {
      const expiresMins = Math.ceil((init.expires_in ?? 900) / 60);
      if (isTTY) {
        process.stdout.write("\nTo authorize, visit:\n");
        process.stdout.write(`    ${uri}\n\n`);
        process.stdout.write(
          `Or visit ${init.verification_uri} and enter code: ${init.user_code}\n\n`,
        );
      } else {
        process.stdout.write(`Visit ${uri} to authorize (code: ${init.user_code})\n`);
      }

      // Try to open the browser (default on; skip when --no-browser or
      // when running over SSH / without a display / in CI).
      let opened = false;
      if (browser !== false) {
        opened = openBrowser(uri);
      }
      if (isTTY) {
        if (opened) {
          process.stdout.write("✓ Opened browser. ");
        }
        process.stdout.write(`Waiting for approval... (expires in ${expiresMins} min)\n`);
      }
    },
    onTick() {
      if (isTTY) {
        process.stdout.write(".");
        dotCount++;
        if (dotCount % 60 === 0) process.stdout.write("\n");
      }
    },
    onApproved() {
      if (isTTY && dotCount > 0) process.stdout.write("\n");
    },
  });

  console.log(
    formatLoginSummary({
      email: me.email,
      profile: profileName,
      source: opts.source,
      storeKind,
      storeChosen: opts.keyring !== undefined,
      setActive,
      verbose: verboseLogger() !== undefined,
    }),
  );
}

export function registerLogin(
  program: Command,
  runFlow: (opts: LoginFlowOptions) => Promise<void> = runDeviceFlow,
): void {
  program
    .command("login")
    .description("sign in via OAuth device flow (browser-based)")
    // NOTE: no command-local `--profile` — it is a global (root-level) flag.
    // Re-declaring it here would shadow the global value (commander routes the
    // typed value to the global option), silently logging into `default`.
    .option("--api <url>", "API base URL", apiUrl())
    .option(
      "--auth <url>",
      "auth service base URL (derived from --api when omitted; falls back to auth.<root-domain>)",
    )
    .option(
      "--streams <url>",
      "Cloudflare-bypass host for terminal WS and large uploads (defaults to streams.reoclo.com for prod, otherwise to --api)",
    )
    .option("--keyring", "require OS keyring storage")
    .option("--no-keyring", "force file storage")
    .option("--no-browser", "do not auto-open the browser during device-flow login")
    .action(
      async (
        opts: {
          api: string;
          auth?: string;
          streams?: string;
          keyring?: boolean;
          browser?: boolean;
        },
        command: Command,
      ) => {
        // Resolve from the global --profile flag (then $REOCLO_PROFILE), with a
        // fresh login defaulting to the "default" profile when neither is set.
        // `source` records which of those produced the name so login can decide
        // whether to touch the global active profile and annotate its feedback.
        const { name: profile, source } = resolveCommandProfileWithSource(command, "default");
        await runFlow({
          profile,
          source,
          api: opts.api,
          auth: opts.auth ?? deriveAuthFromApi(opts.api) ?? authUrl(),
          streams: opts.streams,
          keyring: opts.keyring,
          browser: opts.browser,
        });

        // Best-effort: `login` is a passthrough command, so the normal on-run
        // notice (index.ts) never fires for it. Surface it here instead, right
        // after the login summary, using the same suppression predicate (the
        // ROOT `program`'s opts, not this leaf command's).
        await runAuthUpdateCheck({
          current: VERSION,
          enabled: updateCheckEnabledFor(
            program.opts(),
            process.env,
            Boolean(process.stderr.isTTY),
          ),
          now: Date.now(),
          fetchLatest: () => resolveLatestVersion("stable"),
          readCache: readUpdateCache,
          writeCache: writeUpdateCache,
          detectMethod: () => detectInstallMethod(process.execPath),
          emit: (line) => process.stderr.write(`${line}\n`),
        });
      },
    );
}
